import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Store } from '@backend/store';
import { canChatWithMoki, mokiAssistant } from '@renderer/lib/moki';
import { INITIAL_APPEARANCE } from '@shared/appearance';
import type { Assistant, Conversation } from '@shared/protocol';

const moki: Assistant = { id: 'moki', name: 'Custom name', provider: 'codex', instructions: 'Keep this.', appearance: { ...INITIAL_APPEARANCE } };
const other: Assistant = { ...moki, id: 'other', name: 'Other', provider: 'deepseek' };
const legacy: Assistant = { ...moki, id: 'povondra', name: 'Legacy name' };
const conversation = (assistantId: string): Conversation => ({ id: `chat:${assistantId}`, assistantId, title: 'Saved chat', model: null, thinking: null });

test('Moki selection preserves legacy identity and does not depend on custom records sorting first', () => {
  expect(mokiAssistant()).toBeUndefined();
  expect(mokiAssistant([])).toBeUndefined();
  expect(mokiAssistant([other, moki])).toBe(moki);
  expect(mokiAssistant([moki, other])).toBe(moki);
  expect(mokiAssistant([other, moki, legacy])).toBe(legacy);
  expect(mokiAssistant([legacy, other, moki])).toBe(legacy);
  expect(mokiAssistant([other])).toBe(other);
  expect(moki.name).toBe('Custom name');
});

test('only Moki conversations can be continued, with missing context failing closed', () => {
  expect(canChatWithMoki(moki, conversation('moki'))).toBe(true);
  expect(canChatWithMoki(moki, conversation('other'))).toBe(false);
  expect(canChatWithMoki(undefined, conversation('moki'))).toBe(false);
  expect(canChatWithMoki(moki, undefined)).toBe(false);
  expect(canChatWithMoki(legacy, conversation('povondra'))).toBe(true);
  expect(canChatWithMoki(legacy, conversation('moki'))).toBe(false);
});

test('editing Moki and creating a new chat preserve other records, messages, and ownership', () => {
  const store = new Store(':memory:');
  try {
    store.handle({ method: 'saveAssistant', assistant: moki });
    store.handle({ method: 'saveAssistant', assistant: other });
    const oldId = store.handle({ method: 'createConversation', assistantId: other.id }).conversationId!;
    store.handle({ method: 'saveMessage', conversationId: oldId, text: 'Do not lose this.' });
    const oldMessages = store.messages(oldId);
    const oldAssistant = store.assistantFor(oldId);
    const selected = mokiAssistant(store.snapshot().assistants)!;
    store.handle({ method: 'saveAssistant', assistant: { ...selected, instructions: 'Updated Moki instructions.' } });
    const newId = store.handle({ method: 'createConversation', assistantId: selected.id }).conversationId!;
    expect(store.conversation(newId).assistantId).toBe(moki.id);
    expect(store.assistantFor(newId).name).toBe(moki.name);
    expect(store.assistantFor(newId).instructions).toBe('Updated Moki instructions.');
    expect(store.assistantFor(newId).appearance).toEqual(moki.appearance);
    expect(store.assistantFor(oldId)).toEqual(oldAssistant);
    expect(store.messages(oldId)).toEqual(oldMessages);
    expect(store.conversation(oldId).assistantId).toBe(other.id);
    expect(store.snapshot().conversations.some((item) => item.id === oldId)).toBe(true);
    expect(store.snapshot().assistants).toHaveLength(2);
  } finally { store.close(); }
});

test('renderer wiring removes identity management and guards earlier history without losing Stop', () => {
  const app = readFileSync('src/renderer/windows/chat-window.tsx', 'utf8');
  const settings = readFileSync('src/renderer/windows/settings-window.tsx', 'utf8');
  const history = readFileSync('src/renderer/windows/history-window.tsx', 'utf8');
  for (const source of [app, settings, history]) expect(source).toContain('mokiAssistant(data?.assistants)');
  expect(app).not.toContain('setAssistantId');
  expect(app).not.toContain('<SelectTrigger');
  expect(app).toContain("method: 'createConversation', assistantId: assistant.id");
  expect(app).toContain('if (runtimeFailed || !writable');
  expect(app).toContain('conversationId && writable');
  expect(app).toContain("method: 'cancelChat', conversationId");
  expect(settings).toContain("['Moki', 'Appearance', 'Providers', 'Integrations']");
  expect(settings).toContain('const draft = editing ?? assistant');
  expect(settings).toContain('editing.id !== assistant?.id');
  expect(settings).not.toMatch(/assistants\.map|crypto\.randomUUID|assistant-name/);
  expect(history).toContain('data?.conversations ?? []');
  expect(history).toContain('Read-only');
});

test('built UI contains single-Moki settings and no companion creation or switching instructions', () => {
  const js = readFileSync('dist/renderer/app.js', 'utf8');
  expect(js).toContain('How should Moki help?');
  expect(js).toContain('Save changes');
  expect(js).toContain('Earlier conversation');
  expect(js).not.toMatch(/Add companion|Your companions|Choose who to chat with|enabled separately for each companion/);
});
