import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@backend/storage/store';
import { INITIAL_APPEARANCE, validateAppearance } from '@shared/appearance';
import { applyResult } from '@renderer/lib/chat-state';

const assistant = { id: 'work', name: 'Work', provider: 'codex', instructions: 'Be concise.' };
const appearance = { ...INITIAL_APPEARANCE, outfit: 'wizard' as const, palette: 'sky' as const, eyewear: 'glasses' as const, head: 'horns' as const, face: 'freckles' as const };
test('avatars persist independently and omitted appearance preserves existing choices', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-avatar-'));
  const path = join(dir, 'test.sqlite');
  let store = new Store(path);
  try {
    store.handle({ method: 'saveAssistant', assistant: { ...assistant, appearance } });
    store.handle({ method: 'saveAssistant', assistant: { ...assistant, id: 'home', appearance: { ...INITIAL_APPEARANCE, outfit: 'cozy' } } });
    store.handle({ method: 'saveAssistant', assistant: { ...assistant, name: 'Renamed' } });
    store.close(); store = new Store(path);
    expect(store.snapshot().assistants.find((a) => a.id === 'work')).toMatchObject({ name: 'Renamed', appearance });
    expect(store.snapshot().assistants.find((a) => a.id === 'home')?.appearance?.outfit).toBe('cozy');
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
    for (const invalid of [null, [], {}, 'svg', { ...appearance, palette: 'red' }, { ...appearance, outfit: 'shirt' }, { ...appearance, svg: '<script>' }, { ...appearance, motion: 1 }]) {
      expect(() => store.handle({ method: 'saveAssistant', assistant: { ...assistant, name: 'Bad edit', appearance: invalid } })).toThrow();
      expect(store.snapshot().assistants.find((a) => a.id === 'work')).toMatchObject({ name: 'Work', appearance });
    }
    expect(validateAppearance(INITIAL_APPEARANCE)).toEqual(INITIAL_APPEARANCE);
    expect(validateAppearance({ shape: 'puff', palette: 'peach', accessory: 'sprout', outfit: 'fitness', face: 'sleepy', motion: 'still' })).toEqual({
      ...INITIAL_APPEARANCE, shape: 'puff', palette: 'peach', head: 'sprout', eyes: 'sleepy', outfit: 'fitness', motion: 'still',
    });
    expect(validateAppearance({
      shape: 'mochi', palette: 'mint', head: 'none', eyewear: 'none', eyes: 'bright', eyeColor: 'dark', face: 'blush', mouth: 'smile',
      neckwear: 'bow', outfit: 'suit', motion: 'subtle',
    })).toEqual({ ...INITIAL_APPEARANCE, shape: 'mochi', palette: 'mint', outfit: 'formal' });
    expect(validateAppearance({
      shape: 'pebble', palette: 'sky', head: 'none', eyewear: 'none', eyes: 'bright', eyeColor: 'dark', face: 'blush', mouth: 'smile',
      top: 'lab-coat', outerwear: 'none', headwear: 'none', neckwear: 'none', clothingColor: 'white', clothingPattern: 'solid',
      clothingDetail: 'badge', heldItem: 'none', motion: 'subtle',
    })).toEqual({ ...INITIAL_APPEARANCE, palette: 'sky', outfit: 'work' });
  } finally { store.close(); }
});
test('legacy assistant migration supplies default avatar without losing existing fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-avatar-legacy-'));
  const path = join(dir, 'test.sqlite');
  const old = new Database(path);
  old.exec("CREATE TABLE assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, instructions TEXT NOT NULL); INSERT INTO assistants VALUES ('povondra', 'My assistant', 'codex', 'Keep this');");
  old.close();
  const store = new Store(path);
  try { expect(store.snapshot().assistants[0]).toEqual({ id: 'povondra', name: 'My assistant', provider: 'codex', instructions: 'Keep this', appearance: INITIAL_APPEARANCE }); }
  finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
