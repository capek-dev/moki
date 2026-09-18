import { mkdirSync } from 'node:fs';
import { databasePath } from '@shared/data-paths';
import { createInterface } from 'node:readline';
import { Store } from '@backend/store';
import { Chat } from '@backend/chat';
import { Cua, mcpTransport, type Toolbag } from '@backend/cua';
import { Mcp, mergeToolbags } from '@backend/mcp';
import { generate } from '@backend/model-stream';
import type { Result } from '@shared/protocol';
// Import the published composition entry point in the compiled runtime proof.
import * as capek from '@capekai/core/composition';

const dataDir = process.env.MOKI_DATA_DIR;
if (!dataDir) throw new Error('MOKI_DATA_DIR is required.');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = new Store(databasePath(dataDir), dataDir);
let revision = 0;
const stamp = (result: Result) => ({ ...result, revision: ++revision });
const chat = new Chat(store, generate, (result) => console.log(JSON.stringify({ event: 'state', result: stamp(result) })), async (signal) => {
  // Each source degrades independently: one broken connection never removes
  // the other's tools from the turn.
  const bags: Toolbag[] = [];
  for (const load of [() => cua.toolbag(signal), () => mcp.toolbag(signal)]) {
    try { bags.push(await load()); }
    catch (error) { console.error(`[moki] tool source unavailable, continuing without it: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return mergeToolbags(bags);
});
const cua = new Cua(store, mcpTransport());
const mcp = new Mcp(dataDir);
// Catalog fetches spawn a short-lived MCP transport, so these complete async;
// responses carry their request id and the runtime matches them in any order.
async function handleCua(id: string, request: { method: 'cuaTools' } | { method: 'cuaSetTool'; tool: unknown; disabled: unknown } | { method: 'cuaSetEnabled'; enabled: unknown }) {
  const state = request.method === 'cuaTools' ? await cua.tools()
    : request.method === 'cuaSetTool' ? cua.setTool(request)
    : cua.setEnabled(request);
  console.log(JSON.stringify({ id, result: stamp({ snapshot: store.snapshot(), cua: state }) }));
}
// Same async shape for user-added MCP servers; config reads/writes and stdio
// catalog fetches never block the pipe.
async function handleMcp(id: string, request: { method: 'mcpTools' } | { method: 'mcpAddServer'; name: unknown; kind: unknown; command?: unknown; url?: unknown } | { method: 'mcpRemoveServer'; server: unknown } | { method: 'mcpSetServer'; server: unknown; enabled: unknown } | { method: 'mcpSetTool'; server: unknown; tool: unknown; disabled: unknown }) {
  // Adding fetches fresh state so the new connection's catalog shows up too.
  const state = request.method === 'mcpTools' ? await mcp.tools()
    : request.method === 'mcpAddServer' ? (mcp.addServer(request), await mcp.tools())
    : request.method === 'mcpRemoveServer' ? mcp.removeServer(request.server)
    : request.method === 'mcpSetServer' ? mcp.setServer(request.server, request.enabled)
    : mcp.setTool(request.server, request.tool, request.disabled);
  console.log(JSON.stringify({ id, result: stamp({ snapshot: store.snapshot(), mcp: state }) }));
}
const inFlightCua = new Set<Promise<void>>();
console.log(JSON.stringify({ event: 'ready', bun: Bun.version, capekExports: Object.keys(capek).length }));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let id: unknown;
  try {
    if (Buffer.byteLength(line) > 128 * 1024) throw new Error('Request too large.');
    const envelope = JSON.parse(line);
    id = envelope?.id;
    // Push events from Electron main (sign-in header overlays) carry no id.
    if (envelope?.event === 'mcp-auth') {
      if (typeof envelope.server === 'string' && envelope.server && (envelope.headers === null || (typeof envelope.headers === 'object' && !Array.isArray(envelope.headers)))) {
        mcp.setAuthHeaders(envelope.server, envelope.headers as Record<string, string> | null);
      }
      return;
    }
    if (typeof id !== 'string' || id.length > 100) throw new Error('Invalid request ID.');
    const request = envelope.request;
    if (request?.method === 'cuaTools' || request?.method === 'cuaSetTool' || request?.method === 'cuaSetEnabled') {
      const task = handleCua(id as string, request).catch((error) => {
        console.log(JSON.stringify({ id, error: error instanceof Error ? error.message : 'Request failed.' }));
      });
      inFlightCua.add(task);
      void task.then(() => inFlightCua.delete(task));
      return;
    }
    if (request?.method === 'mcpTools' || request?.method === 'mcpAddServer' || request?.method === 'mcpRemoveServer' || request?.method === 'mcpSetServer' || request?.method === 'mcpSetTool') {
      const task = handleMcp(id as string, request).catch((error) => {
        console.log(JSON.stringify({ id, error: error instanceof Error ? error.message : 'Request failed.' }));
      });
      inFlightCua.add(task);
      void task.then(() => inFlightCua.delete(task));
      return;
    }
    const result = request?.method === 'startChat' ? chat.start(request)
      : request?.method === 'cancelChat' ? chat.cancel(request.conversationId)
      : store.handle(request);
    console.log(JSON.stringify({ id, result: stamp(result) }));
  } catch (error) {
    console.log(JSON.stringify({ id: typeof id === 'string' ? id : null, error: error instanceof Error ? error.message : 'Request failed.' }));
  }
});
lines.on('close', () => {
  // Cua fetches touch the store after an async gap; let them settle first so
  // teardown never races an in-flight handler (e.g. quitting during a fetch).
  void Promise.all([...inFlightCua]).then(() => { chat.close(); store.close(); });
});
