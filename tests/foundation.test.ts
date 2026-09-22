import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '@backend/storage/store';
import { Runtime, runtimeRequestTimeoutMs } from '@electron/runtime';

const binaryPath = resolve(process.env.MOKI_TEST_BINARY ?? 'dist/backend/moki-runtime');

test('learning reviews get a transport deadline beyond their execution deadline', () => {
  expect(runtimeRequestTimeoutMs({ method: 'learningRun' })).toBe(120_000);
  expect(runtimeRequestTimeoutMs({ method: 'snapshot' })).toBe(15_000);
  expect(runtimeRequestTimeoutMs(null)).toBe(15_000);
});

function withStore(run: (store: Store, path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'moki-test-'));
  const path = join(dir, 'test.sqlite');
  const store = new Store(path);
  try { run(store, path); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}
test('profiles, conversations, and saved messages survive reopening', () => withStore((store, path) => {
  store.handle({ method: 'saveAssistant', assistant: { id: 'second', name: 'Mochi', provider: 'codex', instructions: 'Be brief.' } });
  const { conversationId } = store.handle({ method: 'createConversation', assistantId: 'second' });
  store.handle({ method: 'saveMessage', conversationId, text: 'Remember this thought' });
  const reopened = new Store(path);
  try {
    const snapshot = reopened.snapshot();
    expect(snapshot.assistants).toHaveLength(2);
    expect(snapshot.conversations[0]).toMatchObject({ assistantId: 'second', title: 'Remember this thought' });
    expect(snapshot.messages[0].text).toBe('Remember this thought');
    expect(snapshot.conversations.filter((c) => c.assistantId === 'moki')).toHaveLength(0);
  } finally { reopened.close(); }
}));
test('unknown providers, malformed input and missing parents are rejected without writes', () => withStore((store) => {
  for (const input of [null, [], {}, { method: 'execute' }, { method: 'createConversation', assistantId: 'missing' }, { method: 'saveMessage', conversationId: 'missing', text: 'hello' }, { method: 'saveAssistant', assistant: { id: 'x', name: 'x', provider: 'openai', instructions: '' } }]) {
    expect(() => store.handle(input)).toThrow();
  }
  expect(store.snapshot().assistants).toHaveLength(1);
  expect(store.snapshot().messages).toHaveLength(0);
}));
test('empty and oversized messages cannot change a conversation', () => withStore((store) => {
  const { conversationId } = store.handle({ method: 'createConversation', assistantId: 'moki' });
  for (const text of ['', '   ', 'x'.repeat(16001)]) expect(() => store.handle({ method: 'saveMessage', conversationId, text })).toThrow();
  expect(store.snapshot().messages).toHaveLength(0);
}));
test('compiled Bun runtime works without PATH, imports Capek, persists SQLite and exits on EOF', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-binary-'));
  try {
    const child = Bun.spawn([binaryPath], {
      env: { PATH: '', MOKI_DATA_DIR: dir },
      stdin: new Blob(['not json\n', JSON.stringify({ id: '1', request: { method: 'createConversation', assistantId: 'moki' } }) + '\n']),
      stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill(), 10000);
    try {
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      const lines = output.trim().split('\n').map((line) => JSON.parse(line));
      expect(lines[0]).toMatchObject({ event: 'ready', bun: '1.4.0' });
      expect(lines[0].capekExports).toBeGreaterThan(0);
      expect(lines[1].error).toBeString();
      expect(lines[2].result.snapshot.conversations).toHaveLength(1);
    } finally { clearTimeout(timer); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15000);
test('Electron-side runtime bridge correlates requests and closes its child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-bridge-'));
  const runtime = new Runtime(binaryPath, dir);
  try {
    await runtime.ready;
    const results = await Promise.all([runtime.request({ method: 'snapshot' }), runtime.request({ method: 'createConversation', assistantId: 'moki' })]);
    expect(results[0].snapshot.assistants[0].name).toBe('Moki');
    expect(results[1].conversationId).toBeString();
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
}, 15000);
