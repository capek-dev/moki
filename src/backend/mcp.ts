import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diagnosticConfig, parseMcpConfig, requireExposedToolName, sanitizeToolName, serverPrefix, TOOL_NAME_MAX, type McpServerConfig, type ParsedMcpConfig } from '@shared/mcp';
import type { McpServerState, McpState } from '@shared/protocol';
import { parseToolCallResult, type AgentToolDef, type Toolbag } from '@backend/cua';

// User-added MCP servers. Slice 1: config file ownership plus stdio catalogs
// (spawn -> initialize -> tools/list -> close, one short-lived connection per
// fetch, mirroring the Cua transport). Slice 2: per-turn toolbags that execute
// tools/call through lazily spawned per-server sessions. The config file is
// the source of truth and is re-read on every fetch, so hand edits while Moki
// runs are picked up. Toggles write the file back atomically and answer from
// the cached catalog without a new spawn.

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'moki', version: '0.1.0' };
const REQUEST_TIMEOUT_MS = 6000;
const DESCRIPTION_LIMIT = 1000;
const SCHEMA_LIMIT = 8192;
// App actions can be slower than catalog reads (searches, writes); still well
// inside the ten-minute tool-turn deadline. Matches the Cua call bound.
const CALL_TIMEOUT_MS = 45000;

// A tool as fetched from one server. `exposed` is the model-facing prefixed
// name; `original` is what the server expects in tools/call (slice 2).
export interface McpCatalogTool { exposed: string; original: string; description: string; inputSchema?: Record<string, unknown> }

// Minimal stdio JSON-RPC client, generalized from the Cua transport.
class StdioConnection {
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`"${this.label}" did not respond in time.`)); }, timeoutMs);
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
  private catalogs = new Map<string, { tools: McpCatalogTool[]; error: string | null }>();

  constructor(dataDir: string) {
    this.configPath = join(dataDir, 'mcp.json');
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
  private async fetchCatalog(key: string, config: McpServerConfig): Promise<{ tools: McpCatalogTool[]; error: string | null }> {
    const connection = new StdioConnection(key, config.command!, config.args);
    try {
      await connection.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, REQUEST_TIMEOUT_MS);
      connection.notify('notifications/initialized');
      const listed = await connection.request('tools/list', {}, REQUEST_TIMEOUT_MS) as { tools?: unknown[] } | undefined;
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
      if (!config.enabled) return { name: key, transport: config.transport, enabled: false, connected: false, tools: [], disabledTools: config.disabledTools, error: null } satisfies McpServerState;
      if (config.transport === 'http') return { name: key, transport: config.transport, enabled: true, connected: false, tools: [], disabledTools: config.disabledTools, error: 'Remote (web) connections arrive in the next update.' } satisfies McpServerState;
      const catalog = this.catalogs.get(key);
      if (!catalog || catalog.error) return { name: key, transport: config.transport, enabled: true, connected: false, tools: [], disabledTools: config.disabledTools, error: catalog?.error ?? null } satisfies McpServerState;
      return { name: key, transport: config.transport, enabled: true, connected: true, tools: (assigned.get(key) ?? []).map(({ exposed, description }) => ({ name: exposed, description })), disabledTools: config.disabledTools, error: null } satisfies McpServerState;
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
      const catalog = config.enabled && config.transport === 'stdio' ? this.catalogs.get(key) : undefined;
      assigned.set(key, catalog && !catalog.error ? catalog.tools.map((tool) => ({ ...tool, exposed: unique(tool.exposed) })) : []);
    }
    return assigned;
  }

  async tools(): Promise<McpState> {
    const parsed = this.read();
    const active = parsed.servers.filter(({ config }) => config.enabled && config.transport === 'stdio');
    const fetched = await Promise.all(active.map(async ({ key, config }) => [key, await this.fetchCatalog(key, config)] as const));
    for (const [key, catalog] of fetched) this.catalogs.set(key, catalog);
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
    if (!enabled) this.catalogs.delete(key);
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

  // Everything the agent gets for one turn: catalogs minus disabled tools,
  // with per-server sessions spawned lazily on first use and all closed by
  // close() — the same lifecycle contract the Cua toolbag follows. A server
  // that cannot be fetched contributes zero tools instead of failing the turn.
  async toolbag(_signal?: AbortSignal): Promise<Toolbag> {
    const parsed = this.read();
    const active = parsed.servers.filter(({ config }) => config.enabled && config.transport === 'stdio');
    await Promise.all(active.map(async ({ key, config }) => {
      this.catalogs.set(key, await this.fetchCatalog(key, config));
    }));
    const assigned = this.assign(parsed);
    const byKey = new Map(parsed.servers.map((server) => [server.key, server]));
    const sessions = new Map<string, StdioConnection>();
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
        const connection = new StdioConnection(key, server.config.command!, server.config.args);
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
