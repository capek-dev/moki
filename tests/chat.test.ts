import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/backend/store';
import { Chat, type Generate, type Turn } from '../src/backend/chat';
import { applyResult } from '../src/renderer/chat-state';
import type { Result } from '../src/shared/protocol';

const credentials = { provider: 'deepseek' as const, key: 'test-secret' };
function setup(generate: Generate) {
  const store = new Store(':memory:');
  const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const events: Result[] = [];
  const chat = new Chat(store, generate, (result) => { events.push(result); if (result.snapshot.messages.at(-1)?.status !== 'streaming') finish(); });
  return { store, id, chat, done, events, send: () => chat.start({ conversationId: id, text: 'Hello', model: 'deepseek-v4-pro', credentials }), close: () => { chat.close(); store.close(); } };
}
test('streamed replies persist, carry attribution, and reuse role-based history', async () => {
  const turns: Turn[] = [];
  const f = setup(async function* (turn) { turns.push(turn); yield 'Hello'; yield ' there'; });
  try {
    expect(f.send().snapshot.messages.at(-1)?.status).toBe('streaming');
    await f.done;
    expect(f.store.messages(f.id).at(-1)).toMatchObject({ role: 'assistant', text: 'Hello there', status: 'complete', model: 'deepseek-v4-pro', assistantName: 'Moki' });
    expect(turns[0].messages).toEqual([{ role: 'user', content: 'Hello' }]);
    f.send();
    await new Promise((r) => setTimeout(r, 5));
    expect(turns[1].messages).toEqual([{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hello there' }, { role: 'user', content: 'Hello' }]);
    expect(JSON.stringify(f.events)).not.toContain('test-secret');
  } finally { f.close(); }
});
test('duplicate send rejected; cancellation saves partial and ignores late provider output', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const f = setup(async function* () { yield 'partial'; await waiting; yield 'late'; });
  try {
    f.send();
    expect(() => f.send()).toThrow('already replying');
    await new Promise((r) => setTimeout(r, 5));
    f.chat.cancel(f.id);
    expect(f.store.messages(f.id).at(-1)).toMatchObject({ text: 'partial', status: 'interrupted' });
    release(); await new Promise((r) => setTimeout(r, 5));
    expect(f.store.messages(f.id)).toHaveLength(2);
    expect(f.store.messages(f.id).at(-1)?.text).toBe('partial');
  } finally { release(); f.close(); }
});
test('model/provider validation occurs before writes and settings changes do not redirect active turn', async () => {
  let turn: Turn | undefined;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const f = setup(async function* (value) { turn = value; await wait; yield 'ok'; });
  try {
    expect(() => f.chat.start({ conversationId: f.id, text: 'x', model: 'gpt-5.4', credentials })).toThrow('supported model');
    expect(f.store.messages(f.id)).toHaveLength(0);
    f.send();
    f.store.handle({ method: 'saveAssistant', assistant: { id: 'moki', name: 'Changed', provider: 'codex', instructions: 'Different' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(turn?.provider).toBe('deepseek');
    expect(turn?.instructions).toBe('Be helpful, clear, and kind.');
    release(); await f.done;
    expect(f.store.messages(f.id).at(-1)?.assistantName).toBe('Moki');
  } finally { release(); f.close(); }
});
test('provider errors retain partial text and never expose raw errors or retry', async () => {
  let calls = 0;
  const f = setup(async function* () { calls++; yield 'partial'; throw Object.assign(new Error('secret-access'), { statusCode: 401 }); });
  try {
    f.send(); await f.done;
    expect(calls).toBe(1);
    expect(f.store.messages(f.id).at(-1)).toMatchObject({ text: 'partial', status: 'failed', error: 'Provider rejected access. Reconnect it in Settings.' });
    expect(JSON.stringify(f.events)).not.toContain('secret-access');
  } finally { f.close(); }
});
test('additive migration preserves old notes; restart marks unfinished response interrupted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-chat-'));
  const path = join(dir, 'old.sqlite');
  const old = new Database(path);
  old.exec("CREATE TABLE assistants(id TEXT PRIMARY KEY,name TEXT,provider TEXT,instructions TEXT); CREATE TABLE conversations(id TEXT PRIMARY KEY,assistantId TEXT,title TEXT); CREATE TABLE messages(id TEXT PRIMARY KEY,conversationId TEXT,text TEXT); INSERT INTO assistants VALUES('povondra','Povondra','deepseek','Hi'); INSERT INTO conversations VALUES('c','povondra','Old note'); INSERT INTO messages VALUES('m','c','Saved before chat');");
  old.close();
  try {
    const store = new Store(path);
    expect(store.messages('c')[0]).toMatchObject({ text: 'Saved before chat', role: 'user', status: 'complete' });
    const { messageId } = store.begin('c', 'New', 'deepseek-v4-pro');
    store.updateReply(messageId, 'partial', 'streaming'); store.close();
    const reopened = new Store(path);
    try { expect(reopened.messages('c').at(-1)).toMatchObject({ text: 'partial', status: 'interrupted' }); } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('history reads are bounded and cross-window stale responses cannot replace live text', () => {
  const f = setup(async function* () { yield 'ok'; });
  try {
    for (let i = 0; i < 105; i++) f.store.handle({ method: 'saveMessage', conversationId: f.id, text: `Note ${i}` });
    expect(f.store.messages(f.id)).toHaveLength(100);
    const base = { snapshot: f.store.snapshot(f.id), conversationId: f.id, revision: 5 };
    let state = applyResult({ revision: 0, histories: {} }, base);
    state = applyResult(state, { ...base, revision: 4, snapshot: { ...base.snapshot, messages: [] } });
    expect(state.data?.messages).toHaveLength(100);
    state = applyResult(state, { revision: 6, snapshot: { ...base.snapshot, messages: [] } });
    expect(state.data?.messages).toHaveLength(100);
  } finally { f.close(); }
});
