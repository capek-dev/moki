import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@backend/storage/store';
import { Chat, history, type Generate, type Turn } from '@backend/core/chat';
import { ToolBudgetError } from '@shared/mcp';
import type { Toolbag } from '@backend/integrations/cua';
import { applyResult } from '@renderer/lib/chat-state';
import type { Attachment, Message, Result } from '@shared/protocol';

const credentials = { provider: 'deepseek' as const, key: 'test-secret' };
const fixedClock = { now: () => new Date('2025-01-02T03:04:05.000Z'), timeZone: () => 'UTC' };
function setup(generate: Generate) {
  const store = new Store(':memory:');
  const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const events: Result[] = [];
  let now = new Date('2025-01-02T03:04:05.000Z');
  const clock = { now: () => now, timeZone: () => 'UTC' };
  const chat = new Chat(store, generate, (result) => { events.push(result); if (result.snapshot.messages.at(-1)?.status !== 'streaming') finish(); }, undefined, undefined, undefined, clock);
  return { store, id, chat, done, events, send: () => chat.start({ conversationId: id, text: 'Hello', model: 'deepseek-flash', credentials }), advanceClock: () => { now = new Date('2025-01-02T04:05:06.000Z'); }, close: () => { chat.close(); store.close(); } };
}
test('streamed replies persist, carry attribution, and reuse role-based history', async () => {
  const turns: Turn[] = [];
  const f = setup(async function* (turn) { turns.push(turn); yield 'Hello'; yield ' there'; });
  try {
    expect(f.send().snapshot.messages.at(-1)?.status).toBe('streaming');
    await f.done;
    expect(f.store.messages(f.id).at(-1)).toMatchObject({ role: 'assistant', text: 'Hello there', status: 'complete', model: 'deepseek-flash', assistantName: 'Moki' });
    expect(turns[0].messages).toHaveLength(1);
    const firstUserContent = turns[0].messages[0].content;
    expect(firstUserContent).toContain('UTC: 2025-01-02T03:04:05.000Z.');
    expect(firstUserContent).toContain('<moki_user_message>\nHello\n</moki_user_message>');
    f.advanceClock();
    f.send();
    await new Promise((r) => setTimeout(r, 5));
    expect(turns[1].messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(turns[1].messages[0].content).toBe(firstUserContent);
    expect(turns[1].messages[2].content).toContain('UTC: 2025-01-02T04:05:06.000Z.');
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
test('tool definitions are sorted by stable model-facing name', async () => {
  const names: string[][] = [];
  const bag: Toolbag = {
    tools: [
      { name: 'z_tool', description: 'Last tool.', inputSchema: { type: 'object' } },
      { name: 'a_tool', description: 'First tool.', inputSchema: { type: 'object' } },
    ],
    execute: async () => ({ text: 'unused', isError: false }),
    close: () => {},
  };
  const f = setupWithTools(async function* (turn) { names.push(turn.tools!.map((tool) => tool.name)); yield 'ok'; }, bag);
  try {
    f.send();
    await f.done;
    expect(names).toEqual([['a_tool', 'z_tool']]);
  } finally { f.close(); }
});

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
test('hidden model context survives reopen without entering the visible snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-model-context-'));
  const path = join(dir, 'moki.sqlite');
  try {
    const store = new Store(path);
    const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
    const { userMessageId } = store.begin(id, 'Visible text', 'deepseek-flash');
    store.setMessageModelContext(userMessageId, '<moki_turn_context>hidden</moki_turn_context>');
    store.setMessageModelContext(userMessageId, '<moki_turn_context>hidden</moki_turn_context>');
    expect(() => store.setMessageModelContext(userMessageId, '<moki_turn_context>changed</moki_turn_context>')).toThrow('already fixed');
    expect(JSON.stringify(store.snapshot(id))).not.toContain('hidden');
    store.close();
    const reopened = new Store(path);
    try {
      const messages = reopened.messages(id);
      expect(reopened.modelContextsFor(messages).get(userMessageId)).toBe('<moki_turn_context>hidden</moki_turn_context>');
      expect(history(messages, [], undefined, (messageId) => reopened.modelContextsFor(messages).get(messageId))[0].content).toContain('hidden');
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('intermediate model-context schemas add missing columns and invalidate legacy links after reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-model-context-migration-'));
  const path = join(dir, 'moki.sqlite');
  let conversationId = '';
  let messageId = '';
  let memoryId = '';
  try {
    const initial = new Store(path);
    conversationId = initial.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
    messageId = initial.handle({ method: 'saveMessage', conversationId, text: 'Legacy context turn' }).snapshot.messages.at(-1)!.id;
    memoryId = initial.memoryRepository.create({ text: 'Legacy linked memory', kind: 'note' }).id;
    initial.close();

    const intermediate = new Database(path);
    intermediate.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE message_model_context_memory;
      DROP TABLE message_model_context;
      CREATE TABLE message_model_context (
        messageId TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        context TEXT NOT NULL
      );
      CREATE TABLE message_model_context_memory (
        messageId TEXT NOT NULL REFERENCES message_model_context(messageId) ON DELETE CASCADE,
        memoryId TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        PRIMARY KEY (messageId, memoryId)
      );
    `);
    intermediate.query('INSERT INTO message_model_context (messageId, context) VALUES (?, ?)').run(messageId, '<moki_turn_context>legacy</moki_turn_context>');
    intermediate.query('INSERT INTO message_model_context_memory (messageId, memoryId) VALUES (?, ?)').run(messageId, memoryId);
    intermediate.close();

    const reopened = new Store(path);
    try {
      const db = (reopened as unknown as { db: Database }).db;
      expect(db.query<{ name: string }, []>('PRAGMA table_info(message_model_context)').all().map((column) => column.name)).toContain('memoryIdsJson');
      expect(db.query<{ name: string }, []>('PRAGMA table_info(message_model_context_memory)').all().map((column) => column.name)).toContain('memoryRevision');
      expect(reopened.modelContextsFor(reopened.messages(conversationId)).get(messageId)).toContain('legacy');
      reopened.memoryRepository.update(memoryId, 1, { text: 'Revised linked memory' });
      expect(reopened.modelContextsFor(reopened.messages(conversationId)).has(messageId)).toBe(false);
    } finally { reopened.close(); }

    const reopenedAgain = new Store(path);
    try {
      const db = (reopenedAgain as unknown as { db: Database }).db;
      expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'message_model_context_memory_forgotten'").get()?.count).toBe(1);
    } finally { reopenedAgain.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('both memory revision paths remove stale hidden replay context only after successful CAS', () => {
  const store = new Store(':memory:');
  try {
    const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
    const memory = store.memoryRepository.create({ text: 'Old preference', kind: 'preference', core: true });
    const firstTurn = store.handle({ method: 'saveMessage', conversationId: id, text: 'Use my old preference' }).snapshot.messages.at(-1)!;
    store.setMessageModelContext(firstTurn.id, '<moki_turn_context>Old preference</moki_turn_context>', [{ memoryId: memory.id, revision: memory.revision }]);
    store.memoryRepository.update(memory.id, memory.revision, { text: 'New preference' });
    expect(store.modelContextsFor([firstTurn]).has(firstTurn.id)).toBe(false);

    const secondTurn = store.handle({ method: 'saveMessage', conversationId: id, text: 'Use my new preference' }).snapshot.messages.at(-1)!;
    store.setMessageModelContext(secondTurn.id, '<moki_turn_context>New preference</moki_turn_context>', [{ memoryId: memory.id, revision: 2 }]);
    store.memoryRepository.replaceWithForegroundEvidence(memory.id, 2, { text: 'Newest preference' }, { sourceMessageId: secondTurn.id, sourceRevision: secondTurn.revision! });
    expect(store.modelContextsFor([secondTurn]).has(secondTurn.id)).toBe(false);

    const thirdTurn = store.handle({ method: 'saveMessage', conversationId: id, text: 'Keep this snapshot on conflict' }).snapshot.messages.at(-1)!;
    store.setMessageModelContext(thirdTurn.id, '<moki_turn_context>Newest preference</moki_turn_context>', [{ memoryId: memory.id, revision: 3 }]);
    expect(() => store.memoryRepository.update(memory.id, 2, { text: 'Stale edit' })).toThrow('Memory revision conflict.');
    expect(store.modelContextsFor([thirdTurn]).has(thirdTurn.id)).toBe(true);
  } finally { store.close(); }
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
test('UI history stays bounded while model requests keep the complete append-only conversation', async () => {
  let received: Turn | undefined;
  const f = setup(async function* (turn) { received = turn; yield 'ok'; });
  try {
    for (let i = 0; i < 105; i++) f.store.handle({ method: 'saveMessage', conversationId: f.id, text: `Note ${i}` });
    expect(f.store.messages(f.id)).toHaveLength(100);
    expect(f.store.modelMessages(f.id)).toHaveLength(105);
    expect(f.store.modelMessages(f.id)[0].text).toBe('Note 0');
    const base = { snapshot: f.store.snapshot(f.id), conversationId: f.id, revision: 5 };
    let state = applyResult({ revision: 0, histories: {} }, base);
    state = applyResult(state, { ...base, revision: 4, snapshot: { ...base.snapshot, messages: [] } });
    expect(state.data?.messages).toHaveLength(100);
    state = applyResult(state, { revision: 6, snapshot: { ...base.snapshot, messages: [] } });
    expect(state.data?.messages).toHaveLength(100);
    f.send();
    await f.done;
    expect(received?.messages).toHaveLength(106);
    expect(received?.messages[0].content).toBe('Note 0');
  } finally { f.close(); }
});

test('model history does not silently drop text after 60,000 characters', () => {
  const messages: Message[] = [
    { id: 'old', conversationId: 'conversation', text: 'a'.repeat(40_000), role: 'user', status: 'complete', model: null, assistantName: null, error: null, thinking: null },
    { id: 'new', conversationId: 'conversation', text: 'b'.repeat(40_000), role: 'user', status: 'complete', model: null, assistantName: null, error: null, thinking: null },
  ];
  const replay = history(messages);
  expect(replay).toHaveLength(2);
  expect(replay[0].content).toBe(messages[0].text);
  expect(replay[1].content).toBe(messages[1].text);
});

test('enabled basic recall is assembled per turn and never saved into assistant instructions', async () => {
  const store = new Store(':memory:');
  const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
  const turns: Turn[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const memory = store.memoryRepository.create({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'I prefer quiet trains.', kind: 'preference', core: true });
  const chat = new Chat(store, async function* (turn) { turns.push(turn); yield 'ok'; }, (result) => { if (result.snapshot.messages.at(-1)?.status !== 'streaming') finish(); }, undefined, undefined, { enabled: true, maxEntries: 4, maxCandidates: 4, maxTextChars: 1000 }, fixedClock);
  try {
    chat.start({ conversationId: id, text: 'Book a train.', model: 'deepseek-flash', credentials });
    await done;
    expect(turns[0].instructions).not.toContain('<basic_memory_context>');
    expect(turns[0].messages[0].content).toContain('<basic_memory_context>');
    expect(turns[0].messages[0].content).toContain('I prefer quiet trains.');
    expect(JSON.stringify(store.snapshot(id))).not.toContain('I prefer quiet trains.');
    expect(store.assistantFor(id).instructions).toBe('Be helpful, clear, and kind.');
    const userMessage = store.messages(id).find((message) => message.role === 'user')!;
    expect(store.modelContextsFor([userMessage]).get(userMessage.id)).toContain('I prefer quiet trains.');
    store.memoryRepository.forget(memory.id, memory.revision, { sourceMessageId: userMessage.id, sourceRevision: userMessage.revision! });
    expect(store.modelContextsFor([userMessage]).has(userMessage.id)).toBe(false);
  } finally { chat.close(); store.close(); }
});

test('Jev recall aborts on runtime memory disable without retrying or injecting recalled data', async () => {
  const store = new Store(':memory:');
  const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
  store.handle({ method: 'memorySetEnabled', enabled: true, expectedRevision: 1 });
  store.handle({ method: 'memorySetPolicy', recall: 'jev', jevConsent: true, jevModel: 'jev-latest', expectedRevision: 2 });
  store.memoryGraphRepository.createTopic({ label: 'Travel' });
  let fetchCalls = 0;
  let signal!: AbortSignal;
  let markFetch!: () => void;
  const fetchStarted = new Promise<void>((resolve) => { markFetch = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    fetchCalls++;
    signal = init?.signal as AbortSignal;
    markFetch();
    return await new Promise<Response>(() => {});
  }) as typeof fetch;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const turns: Turn[] = [];
  const chat = new Chat(store, async function* (turn) { turns.push(turn); yield 'ok'; }, (result) => { if (result.snapshot.messages.at(-1)?.status !== 'streaming') finish(); }, undefined, undefined, () => store.memoryConfig());
  try {
    chat.start({ conversationId: id, text: 'Plan a trip.', model: 'deepseek-flash', credentials, memoryJevKey: 'test-jev-key' });
    await fetchStarted;
    expect(signal.aborted).toBe(false);
    store.handle({ method: 'memorySetEnabled', enabled: false, expectedRevision: 3 });
    await done;
    expect(signal.aborted).toBe(true);
    expect(fetchCalls).toBe(1);
    expect(turns[0].instructions).not.toContain('<basic_memory_context>');
    expect(store.messages(id).at(-1)).toMatchObject({ text: 'ok', status: 'complete' });
  } finally {
    globalThis.fetch = originalFetch;
    chat.close();
    store.close();
  }
});