import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diagnosticConfig, parseMcpConfig, requireExposedToolName, sanitizeToolName, serverPrefix, TOOL_NAME_MAX, type McpServerConfig, type ParsedMcpConfig } from '@shared/mcp';
import type { McpServerState, McpState } from '@shared/protocol';
import { parseToolCallResult, type AgentToolDef, type Toolbag } from '@backend/cua';
import type { Store } from '@backend/store';

// User-added MCP servers. Slice 1: config file ownership plus stdio catalogs
// (spawn -> initialize -> tools/list -> close, one short-lived connection per
// fetch, mirroring the Cua transport). Slice 2: per-turn toolbags that execute
// tools/call through lazily spawned per-server sessions. Slice 3: Streamable
// HTTP connections (web servers such as Pipedream) plus add/remove from the
// UI. Plan 18 slice 2: catalogs are cached durably (SQLite) with a TTL, chat
// turns skip the round trip while warm, and failing servers degrade to their
// last known catalog instead of emptying the toolset. The config file is the
// source of truth and is re-read on every fetch, so hand edits while Moki
// runs are picked up.

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'moki', version: '0.1.0' };
const REQUEST_TIMEOUT_MS = 9000;
// The whole catalog fetch (initialize + tools/list) must fit the runtime pipe's
// request window; bridge servers like mcp-remote warm-start in 3-5s, so one
// slow step should leave the rest whatever remains of this budget.
const FETCH_DEADLINE_MS = 14000;
const DESCRIPTION_LIMIT = 1000;
const SCHEMA_LIMIT = 8192;
// App actions can be slower than catalog reads (searches, writes); still well
// inside the ten-minute tool-turn deadline. Matches the Cua call bound.
const CALL_TIMEOUT_MS = 45000;
// How long a fetched catalog stays warm for chat turns (plan 18). There is no
// timer-based background refresh on purpose: the next Settings open or the
// first post-TTL toolbag refreshes, which keeps the runtime idle-free.
const CATALOG_FRESH_MS = 5 * 60_000;

// A tool as fetched from one server. `exposed` is the model-facing prefixed
// name; `original` is what the server expects in tools/call (slice 2).
export interface McpCatalogTool { exposed: string; original: string; description: string; inputSchema?: Record<string, unknown> }

// Thrown by HTTP connections on 401/403 so catalog fetches can surface a
// "sign in required" state instead of a generic error.
export class AuthRequiredError extends Error {}

// One server's fetched catalog plus cache metadata. `stale` marks a degraded
// entry: the live fetch failed and the last known tools are being served.
interface CatalogEntry { tools: McpCatalogTool[]; error: string | null; needsAuth?: boolean; stale?: boolean; fetchedAt: number }

// The transport contract both connection kinds satisfy: one JSON-RPC request
// at a time with a timeout, plus fire-and-forget notifications and teardown.
interface Connection {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notify(method: string): void;
  close(): void;
}

// Minimal stdio JSON-RPC client, generalized from the Cua transport.
class StdioConnection implements Connection {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private closed = false;
  private spawnError: Error | null = null;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  constructor(private label: string, command: string, args: string[]) {
    // detached: the child leads its own process group, so close() can take
    // down wrapper processes (npx) together with the actual server child.
    this.child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.child.stderr.resume(); // Drain; never surfaced to the renderer.
    this.child.on('error', (error) => {
      console.error(`[moki] mcp "${this.label}" process error: ${error instanceof Error ? error.message : String(error)}`);
      this.spawnError = new Error(`"${this.label}" could not be started. Check its settings and try again.`);
      this.failPending(this.spawnError);
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          const waiter = this.pending.get(message.id);
          if (!waiter) continue;
          this.pending.delete(message.id);
          if (message.error) waiter.reject(new Error(typeof message.error?.message === 'string' && message.error.message ? message.error.message : `"${this.label}" returned an error.`));
          else waiter.resolve(message.result);
        } catch { /* Non-JSON diagnostics line on stdout; ignore. */ }
      }
    });
  }
  private failPending(error: Error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.spawnError) { reject(this.spawnError); return; }
      if (this.closed) { reject(new Error(`"${this.label}" connection closed.`)); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`"${this.label}" did not respond in time. If it was still starting up, wait a moment and retry.`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  notify(method: string) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new Error(`"${this.label}" connection closed.`));
    this.child.kill();
  }
}

// Streamable HTTP MCP client (the transport Pipedream and other web servers
// speak): every request is its own POST; replies come back either as plain
// JSON or inside a text/event-stream whose data frames carry the JSON-RPC
// message. A session id granted on initialize is echoed on later requests.
// Auth headers come from the config until the keychain flow lands (slice 3b).
class HttpConnection implements Connection {
  private sessionId: string | null = null;
  private nextId = 1;
  constructor(private label: string, private url: string, private headers: Record<string, string>) {}
  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(this.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...this.headers,
            ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: controller.signal,
        });
      } catch {
        throw new Error(`"${this.label}" could not be reached.`);
      }
      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
      if (response.status === 401 || response.status === 403) throw new AuthRequiredError(`"${this.label}" needs you to sign in before it can be used.`);
      if (!response.ok) {
        // JSON-RPC servers explain failures in the body (Pipedream: 400
        // "external user id is required"); static HTML edges do not.
        const body = await response.text().catch(() => '');
        let detail = '';
        if (body.length <= 600) {
          try {
            const parsed = JSON.parse(body) as { error?: { message?: unknown } };
            if (typeof parsed.error?.message === 'string' && parsed.error.message.trim()) detail = parsed.error.message.trim();
          } catch { /* Not JSON; keep the bare status. */ }
        }
        throw new Error(detail ? `"${this.label}" says: ${detail}` : `"${this.label}" responded with ${response.status}.`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        const message = await response.json() as { error?: { message?: unknown }; result?: unknown };
        if (message.error) throw new Error(typeof message.error.message === 'string' && message.error.message ? message.error.message : `"${this.label}" returned an error.`);
        return message.result;
      }
      // SSE: keep reading data frames until the one carrying our id arrives.
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) throw new Error(`"${this.label}" closed the connection before responding.`);
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue; // comments, event names, keep-alives
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let message: { id?: unknown; error?: { message?: unknown }; result?: unknown };
            try { message = JSON.parse(payload); } catch { continue; }
            if (message.id !== id) continue; // server notifications and other traffic
            if (message.error) throw new Error(typeof message.error?.message === 'string' && message.error.message ? message.error.message : `"${this.label}" returned an error.`);
            return message.result;
          }
        }
      } finally { void reader.cancel().catch(() => {}); }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw new Error(`"${this.label}" did not respond in time. If it was still starting up, wait a moment and retry.`);
      throw error;
    } finally { clearTimeout(timer); }
  }
  notify(method: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    void fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.headers, ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method }),
      signal: controller.signal,
    }).catch(() => {}).finally(() => clearTimeout(timer)); // fire and forget
  }
  close() {
    // Streamable HTTP ends a session with DELETE; nothing waits on it.
    if (!this.sessionId) return;
    const session = this.sessionId;
    this.sessionId = null;
    void fetch(this.url, { method: 'DELETE', headers: { ...this.headers, 'mcp-session-id': session } }).catch(() => {});
  }
}

// The connection factory both catalog fetches and per-turn sessions use.
function openConnection(key: string, config: McpServerConfig, authHeaders?: Record<string, string> | null): Connection {
  // The sign-in overlay wins over anything hand-written in the config file.
  const headers = { ...config.headers, ...(authHeaders ?? {}) };
  return config.transport === 'http'
    ? new HttpConnection(key, config.url!, headers)
    : new StdioConnection(key, config.command!, config.args);
}

// Newline-delimited JSON-RPC MCP server used by tests and runtime checks: a
// one-liner child that answers initialize and tools/list. Written as source so
// the config in tests exercises a real spawn end to end.
export const FAKE_SERVER_SOURCE = `
const { createInterface } = require('node:readline');
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') reply(message.id, { serverInfo: { name: 'fake', version: '1.0.0' } });
  else if (message.method === 'tools/list') reply(message.id, { tools: [
    { name: 'read_note', description: 'Read a note.', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } },
    { name: 'read note!', description: 'A tool with a messy name.' },
  ] });
  else if (message.method === 'tools/call') {
    const params = message.params || {};
    if ((params.arguments || {}).fail) reply(message.id, { content: [{ type: 'text', text: 'It broke.' }], isError: true });
    else reply(message.id, { content: [{ type: 'text', text: 'called:' + params.name + ':' + JSON.stringify(params.arguments || {}) }] });
  }
});
`;

export class Mcp {
  private configPath: string;
  // Last successfully parsed file contents, kept for write-back so unknown
  // fields hand-editors added survive UI-driven toggles.
  private rawCache: unknown;
  private catalogs = new Map<string, CatalogEntry>();
  // One shared in-flight fetch per server, so overlapping turns and Settings
  // requests never double-spawn or double-hit the same server.
  private fetching = new Map<string, Promise<CatalogEntry>>();
  // Bumped whenever a server's world changes (auth headers, disable, remove).
  // A fetch that started before the change must not repopulate the cache
  // after it: its result is stale the moment it lands.
  private generations = new Map<string, number>();
  // Bearer headers pushed from Electron main after a UI sign-in; never written
  // to the config file or disk.
  private authHeaders = new Map<string, Record<string, string>>();

  constructor(dataDir: string, private store?: Store) {
    this.configPath = join(dataDir, 'mcp.json');
  }

  setAuthHeaders(server: string, headers: Record<string, string> | null) {
    const current = this.authHeaders.get(server);
    const next = headers ?? undefined;
    if (current !== undefined && next !== undefined
      && JSON.stringify(Object.entries(current).sort()) === JSON.stringify(Object.entries(next).sort())) return; // identical push (e.g. app-start restore)
    if (next) this.authHeaders.set(server, next);
    else this.authHeaders.delete(server);
    // A changed or removed credential changes what the server will report;
    // drop every cached answer so the next fetch re-evaluates. The first push
    // at app start (no previous value) never wipes the durable cache.
    this.catalogs.delete(server);
    this.fetching.delete(server);
    this.bump(server);
    if (current !== undefined) this.storeDrop(server);
  }

  private bump(key: string) { this.generations.set(key, (this.generations.get(key) ?? 0) + 1); }

  // Best-effort durable-cache plumbing; a missing store (unit fixtures) or a
  // failed write must never break a fetch or a chat turn.
  private storeCatalog(key: string): string | null { try { return this.store?.mcpCatalog(key) ?? null; } catch { return null; } }
  private storeSave(key: string, entry: CatalogEntry) { try { this.store?.setMcpCatalog(key, JSON.stringify(entry)); } catch { /* best-effort */ } }
  private storeDrop(key: string) { try { this.store?.deleteMcpCatalog(key); } catch { /* best-effort */ } }
  private storePrune(known: string[]) { try { this.store?.pruneMcpCatalogs(known); } catch { /* best-effort */ } }

  // Memory first, then the durable store (hydrating memory so the next read
  // is free). Unknown shapes are treated as absent; the next fetch overwrites.
  private cached(key: string): CatalogEntry | null {
    const memory = this.catalogs.get(key);
    if (memory) return memory;
    const raw = this.storeCatalog(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<CatalogEntry>;
      if (!parsed || !Array.isArray(parsed.tools) || typeof parsed.fetchedAt !== 'number') return null;
      const entry: CatalogEntry = {
        tools: parsed.tools.filter((tool) => tool && typeof tool.exposed === 'string' && typeof tool.original === 'string'),
        error: typeof parsed.error === 'string' ? parsed.error : null,
        needsAuth: parsed.needsAuth === true,
        stale: false,
        fetchedAt: parsed.fetchedAt,
      };
      this.catalogs.set(key, entry);
      return entry;
    } catch { return null; }
  }

  // The shared fetch: deduplicated per server, remembered in memory, and
  // persisted on success only (failures and sign-out results never overwrite
  // a good durable entry, so degrade keeps working across restarts).
  private loadCatalog(key: string, config: McpServerConfig): Promise<CatalogEntry> {
    const existing = this.fetching.get(key);
    if (existing) return existing;
    const generation = this.generations.get(key) ?? 0;
    const task = this.fetchCatalog(key, config).then((result) => {
      const entry: CatalogEntry = { ...result, stale: false, fetchedAt: Date.now() };
      // The server's world changed while this fetch was in the air (sign-in,
      // sign-out, disable, remove): hand the result to the awaiting caller but
      // never remember it, or a stale anonymous fetch would overwrite a fresh
      // signed-in catalog.
      if ((this.generations.get(key) ?? 0) !== generation) return entry;
      this.catalogs.set(key, entry);
      if (!entry.error) this.storeSave(key, entry);
      return entry;
    }).finally(() => { this.fetching.delete(key); });
    this.fetching.set(key, task);
    return task;
  }

  // The plan-18 degrade rule: always try the live server first; when it fails
  // and a previous catalog exists, serve the last known tools instead of
  // emptying the toolset, marked stale. Sign-out results are never degraded:
  // no credential means no tools.
  private async refreshOrDegrade(key: string, config: McpServerConfig): Promise<CatalogEntry> {
    const previous = this.cached(key);
    const fresh = await this.loadCatalog(key, config);
    if (!fresh.error || fresh.needsAuth) return fresh;
    if (previous && !previous.needsAuth && previous.tools.length) {
      const degraded: CatalogEntry = { tools: previous.tools, error: null, needsAuth: false, stale: true, fetchedAt: Date.now() };
      this.catalogs.set(key, degraded);
      return degraded;
    }
    return fresh;
  }

  private read(): ParsedMcpConfig {
    let text: string;
    try {
      text = readFileSync(this.configPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parseMcpConfig(undefined);
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return diagnosticConfig('The connections file is not valid JSON. Fix it and try again.');
    }
    this.rawCache = json;
    return parseMcpConfig(json);
  }

  private write(mutate: (servers: Record<string, unknown>) => void) {
    const raw = this.rawCache && typeof this.rawCache === 'object' && !Array.isArray(this.rawCache)
      ? this.rawCache as Record<string, unknown>
      : {};
    const servers = raw.servers && typeof raw.servers === 'object' && !Array.isArray(raw.servers)
      ? raw.servers as Record<string, unknown>
      : {};
    raw.servers = servers;
    mutate(servers);
    const tmp = `${this.configPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
    renameSync(tmp, this.configPath);
    this.rawCache = raw;
  }

  // One fetch per server: a short-lived connection, closed either way.
  private async fetchCatalog(key: string, config: McpServerConfig): Promise<{ tools: McpCatalogTool[]; error: string | null; needsAuth?: boolean }> {
    const connection = openConnection(key, config, this.authHeaders.get(key));
    const started = Date.now();
    const budget = () => Math.max(1500, FETCH_DEADLINE_MS - (Date.now() - started));
    try {
      await connection.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, Math.min(REQUEST_TIMEOUT_MS, budget()));
      connection.notify('notifications/initialized');
      const listed = await connection.request('tools/list', {}, Math.min(REQUEST_TIMEOUT_MS, budget())) as { tools?: unknown[] } | undefined;
      const tools: McpCatalogTool[] = [];
      const prefix = serverPrefix(key);
      for (const entry of Array.isArray(listed?.tools) ? listed!.tools : []) {
        if (!entry || typeof entry !== 'object') continue;
        const candidate = entry as { name?: unknown; description?: unknown; inputSchema?: unknown };
        if (typeof candidate.name !== 'string' || !candidate.name) continue;
        const exposed = sanitizeToolName(`${prefix}__${candidate.name}`);
        if (!/^[A-Za-z]/.test(exposed)) continue;
        const inputSchema = candidate.inputSchema && typeof candidate.inputSchema === 'object' && JSON.stringify(candidate.inputSchema).length <= SCHEMA_LIMIT
          ? candidate.inputSchema as Record<string, unknown>
          : undefined;
        tools.push({ exposed, original: candidate.name, description: typeof candidate.description === 'string' ? candidate.description.slice(0, DESCRIPTION_LIMIT) : '', inputSchema });
      }
      return { tools, error: null };
    } catch (error) {
      if (error instanceof AuthRequiredError) return { tools: [], error: 'Sign in to use this connection.', needsAuth: true };
      return { tools: [], error: error instanceof Error ? error.message : `"${key}" is not responding.` };
    } finally {
      connection.close();
    }
  }

  // Merged state from parsed config + cached catalogs. Exposed names are
  // deduped across servers with numeric suffixes; the assignment is
  // deterministic because server order follows the config file.
  private buildState(parsed: ParsedMcpConfig): McpState {
    const assigned = this.assign(parsed);
    const servers = parsed.servers.map(({ key, config }) => {
      if (!config.enabled) return { name: key, transport: config.transport, enabled: false, connected: false, tools: [], disabledTools: config.disabledTools, error: null, needsAuth: false, signedIn: false, stale: false } satisfies McpServerState;
      const catalog = this.catalogs.get(key);
      if (!catalog || catalog.error) return { name: key, transport: config.transport, enabled: true, connected: false, tools: [], disabledTools: config.disabledTools, error: catalog?.error ?? null, needsAuth: catalog?.needsAuth === true, signedIn: config.transport === 'http' && this.authHeaders.has(key), stale: false } satisfies McpServerState;
      return { name: key, transport: config.transport, enabled: true, connected: true, tools: (assigned.get(key) ?? []).map(({ exposed, description }) => ({ name: exposed, description })), disabledTools: config.disabledTools, error: null, needsAuth: false, signedIn: config.transport === 'http' && this.authHeaders.has(key), stale: catalog.stale === true } satisfies McpServerState;
    });
    return { servers, diagnostics: parsed.diagnostics };
  }

  // Deterministic exposed-name assignment shared by state building and the
  // per-turn toolbag, so disabled lists recorded in the UI match execution.
  private assign(parsed: ParsedMcpConfig): Map<string, { exposed: string; original: string; description: string; inputSchema?: Record<string, unknown> }[]> {
    const taken = new Set<string>();
    const unique = (name: string): string => {
      if (!taken.has(name)) { taken.add(name); return name; }
      for (let n = 2; ; n++) {
        const candidate = `${name.slice(0, TOOL_NAME_MAX - String(n).length - 1)}_${n}`;
        if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
      }
    };
    const assigned = new Map<string, { exposed: string; original: string; description: string; inputSchema?: Record<string, unknown> }[]>();
    for (const { key, config } of parsed.servers) {
      const catalog = config.enabled ? this.catalogs.get(key) : undefined;
      assigned.set(key, catalog && !catalog.error ? catalog.tools.map((tool) => ({ ...tool, exposed: unique(tool.exposed) })) : []);
    }
    return assigned;
  }

  // Settings-style explicit fetch: every active server is contacted live
  // (write-through to the durable cache), with the degrade rule as the safety
  // net; orphaned cache rows for servers removed from the file are pruned.
  async tools(): Promise<McpState> {
    const parsed = this.read();
    this.storePrune(parsed.servers.map((server) => server.key));
    const active = parsed.servers.filter(({ config }) => config.enabled);
    await Promise.all(active.map(async ({ key, config }) => { await this.refreshOrDegrade(key, config); }));
    return this.buildState(parsed);
  }

  setServer(key: unknown, enabled: unknown): McpState {
    if (typeof key !== 'string' || !key) throw new Error('Invalid connection name.');
    if (typeof enabled !== 'boolean') throw new Error('Invalid toggle value.');
    const parsed = this.read();
    if (!parsed.servers.some((server) => server.key === key)) throw new Error('Connection not found.');
    this.write((servers) => {
      const entry = servers[key];
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) (entry as Record<string, unknown>).enabled = enabled;
      else servers[key] = { enabled };
    });
    if (!enabled) this.catalogs.delete(key); // buildState never reads catalogs for disabled servers; the delete is enough
    return this.buildState({ servers: parsed.servers.map((entry) => entry.key === key ? { key, config: { ...entry.config, enabled } } : entry), diagnostics: parsed.diagnostics });
  }

  setTool(key: unknown, tool: unknown, disabled: unknown): McpState {
    if (typeof key !== 'string' || !key) throw new Error('Invalid connection name.');
    const exposed = requireExposedToolName(tool);
    if (typeof disabled !== 'boolean') throw new Error('Invalid toggle value.');
    const parsed = this.read();
    const server = parsed.servers.find((entry) => entry.key === key);
    if (!server) throw new Error('Connection not found.');
    const next = disabled
      ? [...new Set([...server.config.disabledTools, exposed])].sort()
      : server.config.disabledTools.filter((name) => name !== exposed);
    this.write((servers) => {
      const entry = servers[key];
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) (entry as Record<string, unknown>).disabledTools = next;
      else servers[key] = { disabledTools: next };
    });
    return this.buildState({ servers: parsed.servers.map((entry) => entry.key === key ? { key, config: { ...entry.config, disabledTools: next } } : entry), diagnostics: parsed.diagnostics });
  }

  // UI-driven add/remove. Names are both the config key and the visible
  // connection name; duplicates are rejected so routing stays unambiguous.
  addServer(input: { name?: unknown; kind?: unknown; command?: unknown; url?: unknown }): McpState {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 64 || name.includes('/')) throw new Error('Enter a connection name (1-64 characters, no slashes).');
    const parsed = this.read();
    if (parsed.servers.some((server) => server.key === name)) throw new Error('A connection with that name already exists.');
    if (input.kind === 'stdio') {
      const command = typeof input.command === 'string' ? input.command.trim() : '';
      if (!command) throw new Error('Enter the command the app runs from.');
      const [binary, ...args] = command.split(/\s+/);
      this.write((servers) => { servers[name] = { transport: 'stdio', command: binary, args, enabled: true }; });
      return this.buildState({ servers: [...parsed.servers, { key: name, config: { transport: 'stdio', command: binary, args, url: null, headers: {}, enabled: true, disabledTools: [] } }], diagnostics: parsed.diagnostics });
    }
    if (input.kind === 'http') {
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      if (!/^https?:\/\//i.test(url)) throw new Error('Enter a web address starting with http(s).');
      this.write((servers) => { servers[name] = { transport: 'http', url, enabled: true }; });
      return this.buildState({ servers: [...parsed.servers, { key: name, config: { transport: 'http', command: null, args: [], url, headers: {}, enabled: true, disabledTools: [] } }], diagnostics: parsed.diagnostics });
    }
    throw new Error('Choose a connection type.');
  }
  removeServer(key: unknown): McpState {
    if (typeof key !== 'string' || !key) throw new Error('Invalid connection name.');
    const parsed = this.read();
    if (!parsed.servers.some((server) => server.key === key)) throw new Error('Connection not found.');
    this.write((servers) => { delete servers[key]; });
    this.catalogs.delete(key);
    this.bump(key);
    this.storeDrop(key);
    return this.buildState({ servers: parsed.servers.filter((server) => server.key !== key), diagnostics: parsed.diagnostics });
  }

  // Everything the agent gets for one turn: catalogs minus disabled tools,
  // with per-server sessions spawned lazily on first use and all closed by
  // close() — the same lifecycle contract the Cua toolbag follows. Catalogs
  // fetched within the TTL skip the round trip entirely (plan 18's cache), so
  // warm turns spawn nothing before the model starts replying. A failing
  // server contributes its last known tools, or zero when nothing is known.
  async toolbag(_signal?: AbortSignal): Promise<Toolbag> {
    const parsed = this.read();
    const active = parsed.servers.filter(({ config }) => config.enabled);
    await Promise.all(active.map(async ({ key, config }) => {
      const entry = this.cached(key);
      if (entry && !entry.error && Date.now() - entry.fetchedAt < CATALOG_FRESH_MS) return; // warm: no round trip
      await this.refreshOrDegrade(key, config);
    }));
    const assigned = this.assign(parsed);
    const byKey = new Map(parsed.servers.map((server) => [server.key, server]));
    const sessions = new Map<string, Connection>();
    const ready = new Map<string, Promise<void>>();
    const tools: AgentToolDef[] = [];
    const routing = new Map<string, { original: string; key: string }>();
    for (const [key, serverTools] of assigned) {
      const disabled = new Set(byKey.get(key)!.config.disabledTools);
      for (const tool of serverTools) {
        if (disabled.has(tool.exposed)) continue;
        tools.push({ name: tool.exposed, description: tool.description, inputSchema: tool.inputSchema ?? { type: 'object' } });
        routing.set(tool.exposed, { original: tool.original, key });
      }
    }
    // Initialize a server's long-lived connection on its first call this turn.
    const ensure = (key: string): Promise<void> => {
      if (!ready.has(key)) {
        const server = byKey.get(key)!;
        const connection = openConnection(key, server.config, this.authHeaders.get(key));
        sessions.set(key, connection);
        const init = (async () => {
          await connection.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, REQUEST_TIMEOUT_MS);
          connection.notify('notifications/initialized');
        })().catch((error) => {
          ready.delete(key);
          sessions.delete(key);
          connection.close();
          throw error;
        });
        ready.set(key, init);
      }
      return ready.get(key)!;
    };
    return {
      tools,
      execute: async (name, args) => {
        const route = routing.get(name);
        if (!route) throw new Error('Unknown tool.');
        await ensure(route.key);
        const session = sessions.get(route.key);
        if (!session) throw new Error(`"${route.key}" connection closed.`);
        const started = Date.now();
        try {
          const result = parseToolCallResult(await session.request('tools/call', { name: route.original, arguments: args ?? {} }, CALL_TIMEOUT_MS));
          console.error(`[moki] mcp ${result.isError ? 'tool-error' : 'ok'} ${name} ${Date.now() - started}ms${result.isError ? `: ${result.text.slice(0, 160)}` : ''}`);
          return result;
        } catch (error) {
          console.error(`[moki] mcp failed ${name} ${Date.now() - started}ms: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      },
      close: () => {
        for (const connection of sessions.values()) connection.close();
        sessions.clear(); // ready promises stay: a closed bag must not respawn
      },
    };
  }
}

// Combines toolbags from independent sources (Cua Driver, user connections)
// into one turn bag. Name collisions are dropped with a diagnostic — the
// naming rules make them practically impossible — and close() always reaches
// every source, even ones whose tools were all filtered out.
export function mergeToolbags(bags: readonly Toolbag[]): Toolbag {
  const routing = new Map<string, Toolbag>();
  const tools: AgentToolDef[] = [];
  for (const bag of bags) {
    for (const definition of bag.tools) {
      if (routing.has(definition.name)) {
        console.error(`[moki] merged toolbag dropped duplicate tool name ${definition.name}`);
        continue;
      }
      routing.set(definition.name, bag);
      tools.push(definition);
    }
  }
  return {
    tools,
    execute: async (name, args) => {
      const bag = routing.get(name);
      if (!bag) throw new Error('Unknown tool.');
      return bag.execute(name, args);
    },
    close: () => { for (const bag of bags) bag.close(); },
  };
}
