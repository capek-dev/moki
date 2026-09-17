import { mkdirSync } from 'node:fs';
import { databasePath } from '../shared/data-paths';
import { createInterface } from 'node:readline';
import { Store } from './store';
import { Chat } from './chat';
import { generate } from './model-stream';
import type { Result } from '../shared/protocol';
// Import the published composition entry point in the compiled runtime proof.
import * as capek from '@capekai/core/composition';

const dataDir = process.env.MOKI_DATA_DIR;
if (!dataDir) throw new Error('MOKI_DATA_DIR is required.');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = new Store(databasePath(dataDir));
let revision = 0;
const stamp = (result: Result) => ({ ...result, revision: ++revision });
const chat = new Chat(store, generate, (result) => console.log(JSON.stringify({ event: 'state', result: stamp(result) })));
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
    const result = request?.method === 'startChat' ? chat.start(request)
      : request?.method === 'cancelChat' ? chat.cancel(request.conversationId)
      : store.handle(request);
    console.log(JSON.stringify({ id, result: stamp(result) }));
  } catch (error) {
    console.log(JSON.stringify({ id: typeof id === 'string' ? id : null, error: error instanceof Error ? error.message : 'Request failed.' }));
  }
});
lines.on('close', () => { chat.close(); store.close(); });
