import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/backend/store';
import { INITIAL_APPEARANCE, validateAppearance } from '../src/shared/appearance';
import { applyResult } from '../src/renderer/chat-state';

const assistant = { id: 'work', name: 'Work', provider: 'codex', instructions: 'Be concise.' };
const appearance = { ...INITIAL_APPEARANCE, outfit: 'suit' as const, palette: 'sky' as const, accessory: 'glasses' as const };
test('avatars persist independently and omitted appearance preserves existing choices', () => {
  const dir = mkdtempSync(join(tmpdir(), 'povondra-avatar-'));
  const path = join(dir, 'test.sqlite');
  let store = new Store(path);
  try {
    store.handle({ method: 'saveAssistant', assistant: { ...assistant, appearance } });
    store.handle({ method: 'saveAssistant', assistant: { ...assistant, id: 'home', appearance: { ...INITIAL_APPEARANCE, outfit: 'sweater' } } });
    store.handle({ method: 'saveAssistant', assistant: { ...assistant, name: 'Renamed' } });
    store.close(); store = new Store(path);
    expect(store.snapshot().assistants.find((a) => a.id === 'work')).toMatchObject({ name: 'Renamed', appearance });
    expect(store.snapshot().assistants.find((a) => a.id === 'home')?.appearance?.outfit).toBe('sweater');
    const id = store.handle({ method: 'createConversation', assistantId: 'work' }).conversationId!;
    expect(store.assistantFor(id).appearance).toEqual(appearance);
    const before = applyResult({ revision: 0, histories: {} }, { snapshot: store.snapshot(), revision: 1 });
    const updated = store.handle({ method: 'saveAssistant', assistant: { ...assistant, appearance: { ...appearance, palette: 'mint' } } });
    expect(applyResult(before, { ...updated, revision: 2 }).data?.assistants.find((a) => a.id === 'work')?.appearance?.palette).toBe('mint');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('invalid appearance rejects the whole assistant edit without overwriting saved data', () => {
  const store = new Store(':memory:');
  try {
    store.handle({ method: 'saveAssistant', assistant: { ...assistant, appearance } });
    for (const invalid of [null, [], {}, 'svg', { ...appearance, palette: 'red' }, { ...appearance, svg: '<script>' }, { ...appearance, motion: 1 }]) {
      expect(() => store.handle({ method: 'saveAssistant', assistant: { ...assistant, name: 'Bad edit', appearance: invalid } })).toThrow();
      expect(store.snapshot().assistants.find((a) => a.id === 'work')).toMatchObject({ name: 'Work', appearance });
    }
    expect(validateAppearance(INITIAL_APPEARANCE)).toEqual(INITIAL_APPEARANCE);
  } finally { store.close(); }
});
test('legacy assistant migration supplies default avatar without losing existing fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'povondra-avatar-legacy-'));
  const path = join(dir, 'test.sqlite');
  const old = new Database(path);
  old.exec("CREATE TABLE assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, instructions TEXT NOT NULL); INSERT INTO assistants VALUES ('povondra', 'My assistant', 'codex', 'Keep this');");
  old.close();
  const store = new Store(path);
  try { expect(store.snapshot().assistants[0]).toEqual({ id: 'povondra', name: 'My assistant', provider: 'codex', instructions: 'Keep this', appearance: INITIAL_APPEARANCE }); }
  finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
