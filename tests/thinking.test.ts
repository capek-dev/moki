import { expect, test } from 'bun:test';
import { Store } from '@backend/store';
import { Chat, type Turn } from '@backend/chat';
import { requireThinking, thinkingLevels } from '@shared/models';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('thinking levels are model-specific; malformed and unsupported levels rejected', () => {
  expect(thinkingLevels('deepseek', 'deepseek-flash')).toEqual(['high', 'max']);
  for (const model of ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5']) expect(() => thinkingLevels('codex', model)).toThrow('supported model');
  expect(thinkingLevels('codex', 'gpt-6-astra')).toContain('max');
  expect(requireThinking('codex', 'gpt-5.6-sol', undefined)).toBeNull();
  for (const value of ['off', '', {}, 1]) expect(() => requireThinking('codex', 'gpt-5.6-sol', value)).toThrow();
});
test('thinking persists per conversation, defaults on model change and survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-thinking-'));
  const path = join(dir, 'test.sqlite');
  let store = new Store(path);
  try {
    const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
    expect(store.conversation(id).thinking).toBeNull();
    store.handle({ method: 'selectModel', conversationId: id, model: 'deepseek-flash', thinking: 'max' });
    store.close(); store = new Store(path);
    expect(store.conversation(id).thinking).toBe('max');
    expect(() => store.handle({ method: 'selectModel', conversationId: id, model: 'deepseek-flash', thinking: 'low' })).toThrow();
    expect(store.conversation(id)).toMatchObject({ model: 'deepseek-flash', thinking: 'max' });
    store.handle({ method: 'selectModel', conversationId: id, model: 'deepseek-flash' });
    expect(store.conversation(id).thinking).toBeNull();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('turn thinking is pinned and attributed despite subsequent setting changes', async () => {
  const store = new Store(':memory:');
  const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
  let turn: Turn | undefined;
  const chat = new Chat(store, async function* (value) { turn = value; yield 'ok'; }, () => {});
  try {
    const input = { conversationId: id, text: 'Hi', model: 'deepseek-flash', credentials: { provider: 'deepseek' as const, key: 'offline' } };
    expect(() => chat.start({ ...input, thinking: 'low' })).toThrow();
    expect(store.messages(id)).toHaveLength(0);
    chat.start({ ...input, thinking: 'max' });
    store.handle({ method: 'selectModel', conversationId: id, model: input.model, thinking: 'high' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(turn?.thinking).toBe('max');
    expect(store.messages(id).at(-1)?.thinking).toBe('max');
    expect(store.conversation(id).thinking).toBe('high');
  } finally { chat.close(); store.close(); }
});
