import { mkdirSync } from 'node:fs';
import { databasePath } from '@shared/data-paths';
import { createInterface } from 'node:readline';
import { Store } from '@backend/store';
import { Chat } from '@backend/chat';
import { Cua, mcpTransport } from '@backend/cua';
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
const chat = new Chat(store, generate, (result) => console.log(JSON.stringify({ event: 'state', result: stamp(result) })), (signal) => cua.toolbag(signal));
const cua = new Cua(store, mcpTransport());
// Catalog fetches spawn a short-lived MCP transport, so these complete async;
// responses carry their request id and the runtime matches them in any order.
async function handleCua(id: string, request: { method: 'cuaTools' } | { method: 'cuaSetTool'; tool: unknown; disabled: unknown } | { method: 'cuaSetEnabled'; enabled: unknown }) {
  const state = request.method === 'cuaTools' ? await cua.tools()
    : request.method === 'cuaSetTool' ? cua.setTool(request)
    : cua.setEnabled(request);
  console.log(JSON.stringify({ id, result: stamp({ snapshot: store.snapshot(), cua: state }) }));
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
