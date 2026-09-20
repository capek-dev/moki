import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@backend/store';
import { Chat, type Turn } from '@backend/chat';

const credentials = { provider: 'deepseek' as const, key: 'test-secret' };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function pngDraft(dir: string, id: string) {
  const draft = join(dir, 'attachments', 'drafts', `${id}.png`);
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(320, 16); png.writeUInt32BE(180, 20);
  writeFileSync(draft, png);
  return draft;
}

test('unsend removes a user message and later messages, keeps earlier ones, and cleans attachment files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-revert-'));
  const store = new Store(join(dir, 'moki.sqlite'), dir);
  try {
    const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
    const first = store.begin(id, 'First', 'deepseek-flash');
    store.updateReply(first.messageId, 'reply one', 'complete');
    const attachmentId = crypto.randomUUID();
    pngDraft(dir, attachmentId);
    const second = store.begin(id, 'Second', 'deepseek-flash', null, [attachmentId]);
    store.updateReply(second.messageId, 'reply two', 'complete');
    const content = join(dir, 'attachments', 'content', `${attachmentId}.png`);
    expect(existsSync(content)).toBe(true);
    const messages = store.messages(id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    store.revertMessages(id, messages[2].id);
    const remaining = store.messages(id);
    expect(remaining.map((m) => m.text)).toEqual(['First', 'reply one']);
    expect(existsSync(content)).toBe(false);
    // Unsending back to the first message empties the conversation and resets the title.
    store.revertMessages(id, remaining[0].id);
    expect(store.messages(id)).toHaveLength(0);
    expect(store.conversation(id).title).toBe('New conversation');
    // Assistant messages, unknown ids, and unknown conversations fail closed.
    const third = store.begin(id, 'Third', 'deepseek-flash');
    expect(() => store.revertMessages(id, third.messageId)).toThrow('Only your messages');
    expect(() => store.revertMessages(id, crypto.randomUUID())).toThrow('Message not found');
    expect(() => store.revertMessages(crypto.randomUUID(), third.messageId)).toThrow('Conversation not found');
    // The request route returns a snapshot of the surviving conversation.
    store.updateReply(third.messageId, 'reply three', 'complete');
    const routed = store.handle({ method: 'revertMessage', conversationId: id, messageId: store.messages(id)[0].id });
    expect(routed.snapshot.messages).toHaveLength(0);
    expect(routed.conversationId).toBe(id);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unsend and edit are rejected while a reply is streaming', () => {
  const store = new Store(':memory:');
  try {
    const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
    store.begin(id, 'Hi', 'deepseek-flash');
    const userId = store.messages(id)[0].id;
    expect(() => store.revertMessages(id, userId)).toThrow('Stop the reply');
    expect(() => store.begin(id, 'Again', 'deepseek-flash', null, [], userId)).toThrow('already replying');
    expect(store.messages(id)).toHaveLength(2);
  } finally { store.close(); }
});

test('edit-resend atomically replaces the tail and rebuilds provider history', async () => {
  const store = new Store(':memory:');
  const turns: Turn[] = [];
  const chat = new Chat(store, async function* (turn) { turns.push(turn); yield 'fresh reply'; }, () => {});
  try {
    const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
    chat.start({ conversationId: id, text: 'Hello', model: 'deepseek-flash', credentials });
    await wait(10);
    chat.start({ conversationId: id, text: 'Second', model: 'deepseek-flash', credentials });
    await wait(10);
    let messages = store.messages(id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const firstUserId = messages[0].id;
    chat.start({ conversationId: id, text: 'Hello edited', model: 'deepseek-flash', credentials, editOf: firstUserId });
    await wait(10);
    messages = store.messages(id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages.map((m) => m.text)).toEqual(['Hello edited', 'fresh reply']);
    expect(store.conversation(id).title).toBe('Hello edited');
    expect(turns.at(-1)!.messages).toHaveLength(1);
    expect(turns.at(-1)!.messages[0].content).toContain('<moki_user_message>\nHello edited\n</moki_user_message>');
    // Editing an assistant message or an unknown id fails without writing.
    expect(() => chat.start({ conversationId: id, text: 'x', model: 'deepseek-flash', credentials, editOf: messages[1].id })).toThrow('Only your messages');
    expect(() => chat.start({ conversationId: id, text: 'x', model: 'deepseek-flash', credentials, editOf: crypto.randomUUID() })).toThrow('Message not found');
    expect(store.messages(id)).toHaveLength(2);
  } finally { chat.close(); store.close(); }
});

test('renderer and main-process boundaries expose unsend and edit safely', async () => {
  const [main, runtime, app] = await Promise.all([
    Bun.file('src/electron/main.ts').text(),
    Bun.file('src/electron/runtime.ts').text(),
    Bun.file('src/renderer/windows/chat-window.tsx').text(),
  ]);
  expect(main).toContain("'cancelChat', 'revertMessage', 'cuaTools'");
  expect(main).toContain("'mcpTools', 'mcpAddServer', 'mcpRemoveServer', 'mcpSetServer', 'mcpSetTool']");
  expect(main).toContain('editOf: input.editOf');
  expect(main).toContain('input.editOf.length > 100');
  expect(runtime).toContain('editOf: request.editOf');
  expect(app).toContain("method: 'revertMessage'");
  expect(app).toContain('editOf: editingRef.current?.id');
  expect(app).toContain('nearBottom.current = true;\n    setEditing(undefined);');
});
