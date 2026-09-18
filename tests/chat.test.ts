import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@backend/store';
import { Chat, history, type Generate, type Turn } from '@backend/chat';
import { ToolBudgetError } from '@shared/mcp';
import type { Toolbag } from '@backend/cua';
import { applyResult } from '@renderer/lib/chat-state';
import type { Attachment, Message, Result } from '@shared/protocol';

const credentials = { provider: 'deepseek' as const, key: 'test-secret' };
function setup(generate: Generate) {
  const store = new Store(':memory:');
  const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const events: Result[] = [];
  const chat = new Chat(store, generate, (result) => { events.push(result); if (result.snapshot.messages.at(-1)?.status !== 'streaming') finish(); });
  return { store, id, chat, done, events, send: () => chat.start({ conversationId: id, text: 'Hello', model: 'deepseek-flash', credentials }), close: () => { chat.close(); store.close(); } };
}
test('streamed replies persist, carry attribution, and reuse role-based history', async () => {
  const turns: Turn[] = [];
  const f = setup(async function* (turn) { turns.push(turn); yield 'Hello'; yield ' there'; });
  try {
    expect(f.send().snapshot.messages.at(-1)?.status).toBe('streaming');
    await f.done;
    expect(f.store.messages(f.id).at(-1)).toMatchObject({ role: 'assistant', text: 'Hello there', status: 'complete', model: 'deepseek-flash', assistantName: 'Moki' });
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
function setupWithTools(generate: Generate, toolbag: Toolbag) {
  const store = new Store(':memory:');
  const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const chat = new Chat(store, generate, (result) => { if (result.snapshot.messages.at(-1)?.status !== 'streaming') finish(); }, async () => toolbag);
  return { store, id, chat, done, send: () => chat.start({ conversationId: id, text: 'List apps', model: 'deepseek-flash', credentials }), close: () => { chat.close(); store.close(); } };
}
test('tool calls execute through the bag, persist on the reply, and close', async () => {
  let closed = 0;
  const executed: Array<{ name: string; args: unknown }> = [];
  const bag: Toolbag = {
    tools: [{ name: 'list_apps', description: 'List running apps.', inputSchema: { type: 'object' } }],
    execute: async (name, args) => { executed.push({ name, args }); return { text: 'Chrome\nSpotify', isError: false }; },
    close: () => { closed++; },
  };
  const f = setupWithTools(async function* (turn) {
    const seen = turn.tools ? await turn.tools[0].execute({}) : 'none';
    yield `Apps: ${seen}`;
  }, bag);
  try {
    f.send();
    await f.done;
    const reply = f.store.messages(f.id).at(-1)!;
    expect(reply).toMatchObject({ role: 'assistant', text: 'Apps: Chrome\nSpotify', status: 'complete' });
    expect(executed).toEqual([{ name: 'list_apps', args: {} }]);
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls![0]).toMatchObject({ name: 'list_apps', label: 'Listing apps', status: 'ok', summary: 'Chrome Spotify' });
    expect(closed).toBe(1);
  } finally { f.close(); }
});
test('an over-budget toolset fails the turn instead of silently going toolless', async () => {
  const store = new Store(':memory:');
  const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const events: Result[] = [];
  const chat = new Chat(store, async function* () { yield 'should never stream'; }, (result) => { events.push(result); if (result.snapshot.messages.at(-1)?.status !== 'streaming') finish(); },
    async () => { throw new ToolBudgetError(70_000, 60_000, [{ label: 'pipedream', weight: 70_000 }]); });
  try {
    chat.start({ conversationId: id, text: 'Hello', model: 'deepseek-flash', credentials });
    await done;
    const reply = store.messages(id).at(-1)!;
    expect(reply.status).toBe('failed');
    expect(reply.error).toContain('Too many tools');
    expect(reply.error).toContain('Settings > Connections');
    expect(reply.text).toBe(''); // the model was never called
  } finally { chat.close(); store.close(); }
});

test('tool failures return an error string to the model instead of failing the turn', async () => {
  const bag: Toolbag = {
    tools: [{ name: 'click', description: 'Click.', inputSchema: { type: 'object' } }],
    execute: async () => { throw new Error('no target'); },
    close: () => {},
  };
  const f = setupWithTools(async function* (turn) {
    yield turn.tools ? await turn.tools[0].execute({}) : '';
  }, bag);
  try {
    f.send();
    await f.done;
    const reply = f.store.messages(f.id).at(-1)!;
    expect(reply.status).toBe('complete');
    expect(reply.text).toContain('Tool failed: no target');
    expect(reply.toolCalls![0].status).toBe('failed');
  } finally { f.close(); }
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
    const { messageId } = store.begin('c', 'New', 'deepseek-flash');
    store.updateReply(messageId, 'partial', 'streaming'); store.close();
    const reopened = new Store(path);
    try { expect(reopened.messages('c').at(-1)).toMatchObject({ text: 'partial', status: 'interrupted' }); } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('screenshots move into durable message storage and replay as image content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-images-'));
  const store = new Store(join(dir, 'moki.sqlite'), dir);
  try {
    const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
    const attachmentId = crypto.randomUUID();
    const draft = join(dir, 'attachments', 'drafts', `${attachmentId}.png`);
    const png = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png); png.writeUInt32BE(320, 16); png.writeUInt32BE(180, 20);
    writeFileSync(draft, png);
    expect(() => store.begin(id, 'Read this', 'deepseek-v4-pro', null, [attachmentId])).toThrow('supported model');
    expect(existsSync(draft)).toBe(true);
    store.begin(id, 'Read this', 'deepseek-flash', null, [attachmentId]);
    const snapshot = store.snapshot(id);
    expect(snapshot.attachments).toEqual([{ id: attachmentId, messageId: snapshot.messages[0].id, mime: 'image/png', byteSize: 24, width: 320, height: 180 }]);
    expect(existsSync(draft)).toBe(false);
    expect(existsSync(join(dir, 'attachments', 'content', `${attachmentId}.png`))).toBe(true);
    const replay = history(snapshot.messages, snapshot.attachments, (value) => store.attachmentBytes(value));
    expect(replay[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Read this' }, { type: 'image', mediaType: 'image/png' }] });
    expect(JSON.stringify(snapshot)).not.toContain(dir);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('image history limits omit old images without dropping their message text', () => {
  const messages = Array.from({ length: 5 }, (_, index): Message => ({
    id: `message-${index}`,
    conversationId: 'conversation',
    text: `Text ${index}`,
    role: 'user',
    status: 'complete',
    model: null,
    assistantName: null,
    error: null,
    thinking: null,
  }));
  const attachments = messages.map((message, index): Attachment => ({
    id: `attachment-${index}`,
    messageId: message.id,
    mime: 'image/png',
    byteSize: 1,
    width: 1,
    height: 1,
  }));
  const read: string[] = [];
  const replay = history(messages, attachments, (attachmentId) => { read.push(attachmentId); return new Uint8Array([1]); });
  expect(replay).toHaveLength(5);
  expect(read).toEqual(['attachment-4', 'attachment-3', 'attachment-2', 'attachment-1']);
  expect(replay[0]).toEqual({ role: 'user', content: 'Text 0' });
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
