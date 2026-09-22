import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requireCuaToolName } from '@shared/cua';
import { compactSchema, schemaWeight, type ToolWeightLabel } from '@shared/mcp';
import type { CuaState, CuaTool } from '@shared/protocol';
import type { Store } from '@backend/storage/store';

// Cua Driver speaks MCP over stdio. Catalog fetches use a short-lived
// connection (initialize -> tools/list -> close); tool execution during a chat
// turn uses one lazily spawned session so all calls in a turn share the
// transport's private lifecycle session. Closing kills the child, which ends it.
export interface CuaInternalTool extends CuaTool { inputSchema?: Record<string, unknown> }
export interface CuaCatalog { version: string; tools: CuaInternalTool[] }
export interface CuaTransport { listTools(): Promise<CuaCatalog> }

// A tool definition handed to the model: schema plus the record/execute wrapper.
export interface AgentToolDef { name: string; description: string; inputSchema: Record<string, unknown> }
// Per-turn execution bag: the filtered tool list plus name-based dispatch.
// `weights` attributes the prompt cost per source label so an over-budget
// merged bag can name its offenders (plan 18).
export type ModelToolOutput = { type: 'content'; value: Array<{ type: 'text'; text: string } | { type: 'image-data'; data: string; mediaType: string }> };
export interface ToolExecutionResult { text: string; isError: boolean; modelOutput?: ModelToolOutput }
export interface Toolbag {
  /** Stable provider-native declarations for this turn. */
  tools: AgentToolDef[];
  /** Request-selected definitions rendered into hidden turn context, never native provider tools. */
  selectedTools?: readonly AgentToolDef[];
  weights?: readonly ToolWeightLabel[];
  execute(name: string, args: unknown): Promise<ToolExecutionResult>;
  close(): void;
}

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'moki', version: '0.1.0' };
// Catalog requests must stay well under the 15s runtime request timeout.
const REQUEST_TIMEOUT_MS = 6000;
// Desktop actions (launching apps, waiting for windows) legitimately take
// longer than catalog reads, but still fit inside the 3-minute reply deadline.
const CALL_TIMEOUT_MS = 45000;
const DESCRIPTION_LIMIT = 1000;
const SCHEMA_LIMIT = 8192;
// What the model sees back from one tool call. Cua state dumps are large.
export const MODEL_RESULT_LIMIT = 12000;
export const TRUNCATION_MARKER = '\n…[truncated]';

export function driverBinary(): string {
  const installed = join(homedir(), '.local', 'bin', 'cua-driver');
  return existsSync(installed) ? installed : 'cua-driver';
}

// Minimal MCP client: newline-delimited JSON-RPC over the child's stdio.
class McpConnection {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private closed = false;
  private spawnError: Error | null = null;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  constructor(binary: string) {
    this.child = spawn(binary, ['mcp'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume(); // Drain; never surfaced to the renderer.
    this.child.on('error', (error) => {
      console.error(`[moki] cua process error: ${error instanceof Error ? error.message : String(error)}`);
      this.spawnError = new Error('Cua Driver could not be started. Install it from cua.ai and try again.');
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
          if (message.error) waiter.reject(new Error(typeof message.error?.message === 'string' && message.error.message ? message.error.message : 'Cua Driver request failed.'));
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
      if (this.closed) { reject(new Error('Cua Driver connection closed.')); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Cua Driver did not respond in time. Check that CuaDriver is running.')); }, timeoutMs);
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
    this.failPending(new Error('Cua Driver connection closed.'));
    this.child.kill();
  }
}

export function parseToolCallResult(result: unknown): { text: string; isError: boolean } {
  const source = (result && typeof result === 'object' ? result : {}) as { content?: unknown; isError?: unknown };
  const parts: string[] = [];
  for (const entry of Array.isArray(source.content) ? source.content : []) {
    if (entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'text' && typeof (entry as { text?: unknown }).text === 'string') parts.push((entry as { text: string }).text);
  }
  let text = parts.join('\n');
  if (text.length > MODEL_RESULT_LIMIT) text = text.slice(0, MODEL_RESULT_LIMIT) + TRUNCATION_MARKER;
  return { text, isError: source.isError === true };
}

export function mcpTransport(binary: string = driverBinary()): CuaTransport {
  return {
    async listTools(): Promise<CuaCatalog> {
      const connection = new McpConnection(binary);
      try {
        const initialized = await connection.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, REQUEST_TIMEOUT_MS) as { serverInfo?: { version?: unknown } } | undefined;
        connection.notify('notifications/initialized');
        const listed = await connection.request('tools/list', {}, REQUEST_TIMEOUT_MS) as { tools?: unknown[] } | undefined;
        const tools: CuaInternalTool[] = [];
        for (const entry of Array.isArray(listed?.tools) ? listed!.tools : []) {
          if (!entry || typeof entry !== 'object') continue;
          const candidate = entry as { name?: unknown; description?: unknown; inputSchema?: unknown };
          if (typeof candidate.name !== 'string') continue;
          try {
            const inputSchema = candidate.inputSchema && typeof candidate.inputSchema === 'object' && JSON.stringify(candidate.inputSchema).length <= SCHEMA_LIMIT
              ? candidate.inputSchema as Record<string, unknown>
              : undefined;
            tools.push({ name: requireCuaToolName(candidate.name), description: typeof candidate.description === 'string' ? candidate.description.slice(0, DESCRIPTION_LIMIT) : '', inputSchema });
          } catch { /* Skip entries whose names fall outside the contract. */ }
        }
        return { version: typeof initialized?.serverInfo?.version === 'string' ? initialized.serverInfo.version : '', tools };
      } finally {
        connection.close();
      }
    },
  };
}

// One chat turn's execution channel. The child process is spawned lazily on
// the first tool call, so turns that only produce text never touch the driver.
export class CuaSession {
  private connection?: McpConnection;
  private ready?: Promise<void>;
  constructor(private binary: string = driverBinary()) {}
  private ensure(): Promise<void> {
    this.connection ??= new McpConnection(this.binary);
    this.ready ??= (async () => {
      await this.connection!.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, REQUEST_TIMEOUT_MS);
      this.connection!.notify('notifications/initialized');
    })().catch((error) => { this.ready = undefined; throw error; });
    return this.ready;
  }
  async call(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    await this.ensure();
    const started = Date.now();
    try {
      const result = parseToolCallResult(await this.connection!.request('tools/call', { name, arguments: args ?? {} }, CALL_TIMEOUT_MS));
      console.error(`[moki] cua ${result.isError ? 'tool-error' : 'ok'} ${name} ${Date.now() - started}ms${result.isError ? `: ${result.text.slice(0, 160)}` : ''}`);
      return result;
    } catch (error) {
      console.error(`[moki] cua failed ${name} ${Date.now() - started}ms: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  close() { this.connection?.close(); }
}

// The catalog is dynamic: it depends on the installed driver version, platform,
// and permission mode. `tools()` always refetches it; the last successful fetch
// is cached in memory so `setTool` responses stay complete without a new spawn.
// A persisted master switch disconnects the integration: while off, no
// transport is spawned at all and the state reports enabled=false, not an error.
// What the model receives for one Cua tool: the compacted schema (prose
// dropped, shape kept — see compactSchema) with its description. Weights count
// this shipped shape, so Settings and the prompt agree on cost.
const shippedCua = (tool: CuaInternalTool): AgentToolDef => ({ name: tool.name, description: tool.description, inputSchema: compactSchema(tool.inputSchema) ?? { type: 'object' } });

export class Cua {
  private cache?: { version: string; tools: CuaInternalTool[] };
  constructor(private store: Store, private transport: CuaTransport = mcpTransport()) {}
  private view(disabled: string[], error: string | null): CuaState {
    const enabled = this.store.cuaIntegrationEnabled();
    if (!this.cache || !enabled) return { enabled, connected: false, version: null, tools: [], disabled, error, weight: 0 };
    const active = this.cache.tools.filter((tool) => !disabled.includes(tool.name));
    return { enabled: true, connected: true, version: this.cache.version, tools: this.cache.tools.map(({ name, description }) => ({ name, description })), disabled, error, weight: schemaWeight(active.map(shippedCua)) };
  }
  async tools(): Promise<CuaState> {
    const disabled = this.store.cuaDisabledTools();
    if (!this.store.cuaIntegrationEnabled()) return this.view(disabled, null);
    try {
      const catalog = await this.transport.listTools();
      this.cache = { version: catalog.version, tools: catalog.tools };
      this.store.pruneCuaDisabledTools(catalog.tools.map((tool) => tool.name));
      return this.view(this.store.cuaDisabledTools(), null);
    } catch (error) {
      this.cache = undefined;
      return this.view(this.store.cuaDisabledTools(), error instanceof Error ? error.message : 'Cua Driver is unavailable.');
    }
  }
  setTool(input: { tool: unknown; disabled: unknown }): CuaState {
    const tool = requireCuaToolName(input.tool);
    if (typeof input.disabled !== 'boolean') throw new Error('Invalid toggle value.');
    this.store.setCuaToolDisabled(tool, input.disabled);
    return this.view(this.store.cuaDisabledTools(), null);
  }
  setEnabled(input: { enabled: unknown }): CuaState {
    if (typeof input.enabled !== 'boolean') throw new Error('Invalid toggle value.');
    this.store.setCuaIntegrationEnabled(input.enabled);
    return this.view(this.store.cuaDisabledTools(), null);
  }
  // Everything the agent gets: catalog minus disabled, empty while the master
  // switch is off. A cold cache triggers one background-style fetch; if the
  // driver is unavailable the turn simply proceeds without tools.
  async toolbag(_signal?: AbortSignal): Promise<Toolbag> {
    const enabled = this.store.cuaIntegrationEnabled();
    if (enabled && !this.cache) await this.tools();
    const available = enabled ? this.cache?.tools ?? [] : [];
    const disabled = new Set(this.store.cuaDisabledTools());
    const active = available.filter((tool) => !disabled.has(tool.name));
    const session = new CuaSession();
    return {
      tools: active.map(shippedCua),
      weights: [{ label: 'Cua Driver', weight: schemaWeight(active.map(shippedCua)) }],
      execute: (name, args) => session.call(name, args),
      close: () => session.close(),
    };
  }
}
