import { mkdirSync } from 'node:fs';
import { databasePath } from '@shared/data-paths';
import { createInterface } from 'node:readline';
import { Store } from '@backend/store';
import { Chat } from '@backend/chat';
import { Cua, mcpTransport, type Toolbag } from '@backend/cua';
import { Mcp } from '@backend/mcp';
import { generate } from '@backend/model-stream';
import { observeLearningReview } from '@backend/learning-review-stream';
import { smartToolbag } from './tool-scoring';
import { sessionSearchToolbag } from '@backend/session-search-tool';
import { composeBuiltInToolbags, memoryToolbag } from '@backend/memory-tool';
import { LearningCoordinator, reviewWithModel } from '@backend/memory-learning';
import type { Credentials } from '@backend/chat';
import type { Result } from '@shared/protocol';
// Import the published composition entry point in the compiled runtime proof.
import * as capek from '@capekai/core/composition';

const dataDir = process.env.MOKI_DATA_DIR;
if (!dataDir) throw new Error('MOKI_DATA_DIR is required.');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = new Store(databasePath(dataDir), dataDir);
store.onReviewInvalidated = () => console.log(JSON.stringify({ event: 'state', result: { snapshot: { assistants: [], conversations: [], messages: [], attachments: [] }, learningLiveCleared: true } }));
let revision = 0;
const stamp = (result: Result) => ({ ...result, revision: ++revision });
const learning = new LearningCoordinator(store.learningRepository, {
  learningDue: (run, settings) => console.log(JSON.stringify({ event: 'learning-due', runId: run.id, provider: settings.provider, model: settings.model })),
  stateChanged: () => console.log(JSON.stringify({ event: 'state', result: stamp({ snapshot: store.snapshot(), learning: store.learningRepository.settings(), learningExclusions: store.learningRepository.exclusions() }) })),
});
store.onMessageEvent((event) => {
  if (event.type === 'settings') learning.onSettingsChanged();
  else learning.onActivity();
});
const chat = new Chat(store, generate, (result) => console.log(JSON.stringify({ event: 'state', result: stamp(result) })), async (signal, evidence, config) => {
  // Each source degrades independently: one broken connection never removes
  // the other's tools from the turn.
  const bags: Toolbag[] = [];
  for (const load of [() => cua.toolbag(signal), () => mcp.toolbag(signal)]) {
    try { bags.push(await load()); }
    catch (error) { console.error(`[moki] tool source unavailable, continuing without it: ${error instanceof Error ? error.message : String(error)}`); }
  }
  try {
    signal.throwIfAborted();
    return await smartToolbag(bags, evidence, config ?? { enabled: false, maxDirect: 12 }, signal, { formulation: 'direct-name', descriptorMode: 'name-only' });
  } catch (error) { for (const bag of bags) bag.close(); throw error; }
}, (conversationId, signal, foregroundSource) => composeBuiltInToolbags([
  sessionSearchToolbag(store.sessionSearchRepository, conversationId, signal),
  memoryToolbag(store.memoryRepository, () => store.memoryConfig(), foregroundSource, signal),
]), () => store.memoryConfig());
const cua = new Cua(store, mcpTransport());
const mcp = new Mcp(dataDir, store);
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
async function runLearning(request: { method: 'learningRun'; runId?: unknown; credentials?: unknown; model?: unknown }) {
  if (typeof request.runId !== 'string' || !request.credentials || typeof request.credentials !== 'object' || typeof request.model !== 'string') throw new Error('Invalid learning runtime request.');
  const credentials = request.credentials as Credentials;
  if (credentials.provider !== 'deepseek' && credentials.provider !== 'codex') throw new Error('Invalid learning provider.');
  const configuration = store.learningRepository.runConfiguration(request.runId);
  if (configuration.provider !== credentials.provider || configuration.model !== request.model) throw new Error('Learning provider or model changed.');
  return learning.run((sources, signal, context) => {
    const runId = request.runId as string;
    const publishOutput = (text: string) => console.log(JSON.stringify({ event: 'state', result: { snapshot: { assistants: [], conversations: [], messages: [], attachments: [] }, learningLiveOutput: { runId, text } } }));
    const observedGenerate = observeLearningReview(generate, publishOutput);
    return reviewWithModel(observedGenerate, credentials.provider, request.model as string, credentials, runId, sources, signal, context);
  }, undefined, request.runId);
}
async function failLearning(request: { method: 'learningFail'; runId?: unknown; error?: unknown }) {
  if (typeof request.runId !== 'string' || typeof request.error !== 'string') throw new Error('Invalid learning failure report.');
  learning.fail(request.runId, request.error);
  return null;
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
    if (request?.method === 'learningRetry' || request?.method === 'learningCancel') {
      const runId = request.runId;
      if (request.method === 'learningRetry' && (typeof runId !== 'string' || runId.length > 100)) throw new Error('Invalid learning run id.');
      if (request.method === 'learningCancel' && runId !== undefined && (typeof runId !== 'string' || runId.length > 100)) throw new Error('Invalid learning run id.');
      const run = request.method === 'learningRetry' ? learning.retry(runId as string) : (learning.cancel(runId as string | undefined), undefined);
      const result = store.handle({ method: 'learningRuns', limit: 25, offset: 0 });
      console.log(JSON.stringify({ id, result: stamp({ ...result, ...(run ? { learningRun: run } : {}) }) }));
      return;
    }
    if (request?.method === 'learningRun' || request?.method === 'learningFail') {
      const task = (request.method === 'learningRun' ? runLearning(request) : failLearning(request)).then((result) => console.log(JSON.stringify({ id, result: stamp({ snapshot: store.snapshot(), learning: store.learningRepository.settings(), ...(result ? { learningRun: result } : {}) }) }))).catch((error) => console.log(JSON.stringify({ id, error: error instanceof Error ? error.message : 'Learning review failed.' })));
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
