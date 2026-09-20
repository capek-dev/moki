import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '@backend/store';
import { MEMORY_TOOL_NAME, memoryToolbag } from '@backend/memory-tool';
import { recallBasic } from '@backend/memory-recall';
import { acceptMemoryRevision, memoryRecallLabel, MEMORY_DISABLED_COPY, MEMORY_FORGET_SCOPE_COPY } from '@renderer/lib/memory-settings-state';

test('recall inspection explains fallback without implying a settings change', () => {
  expect(memoryRecallLabel('basic', 'no_descriptors')).toBe('Basic fallback: no topics/entities available for Jev routing');
  expect(memoryRecallLabel('jev', 'jev_selected')).toBe('Jev contextual routing');
  expect(memoryRecallLabel('basic', 'basic_mode')).toBe('Basic recall');
});

function conversation(store: Store): string {
  return store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
}

function withStore(run: (store: Store, path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'moki-memory-settings-'));
  const path = join(dir, 'memory.sqlite');
  const store = new Store(path);
  try { run(store, path); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

async function withStoreAsync(run: (store: Store) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'moki-memory-settings-'));
  const store = new Store(join(dir, 'memory.sqlite'));
  try { await run(store); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('memory policy is persisted, defaults off, and legacy env opt-in only seeds a new row', () => {
  const previous = process.env.MOKI_MEMORY_ENABLED;
  try {
    delete process.env.MOKI_MEMORY_ENABLED;
    withStore((store, path) => {
      expect(store.memorySettings()).toEqual({ enabled: false, recall: 'basic', jevConsent: false, jevModel: 'jev-latest', revision: 1 });
      const enabled = store.handle({ method: 'memorySetEnabled', enabled: true, expectedRevision: 1 });
      expect(enabled.memory).toEqual({ enabled: true, recall: 'basic', jevConsent: false, jevModel: 'jev-latest', revision: 2 });
      expect(() => store.handle({ method: 'memorySetEnabled', enabled: false, expectedRevision: 1 })).toThrow('revision conflict');
      const reopened = new Store(path);
      try { expect(reopened.memorySettings().enabled).toBe(true); } finally { reopened.close(); }
    });

    process.env.MOKI_MEMORY_ENABLED = '1';
    withStore((store) => expect(store.memorySettings().enabled).toBe(true));
  } finally {
    if (previous === undefined) delete process.env.MOKI_MEMORY_ENABLED;
    else process.env.MOKI_MEMORY_ENABLED = previous;
  }
});

test('Jev mode, consent, and model are persisted separately from memory and learning settings', () => withStore((store) => {
  const result = store.handle({ method: 'memorySetPolicy', recall: 'jev', jevConsent: true, jevModel: 'jev-latest', expectedRevision: 1 });
  expect(result.memory).toEqual({ enabled: false, recall: 'jev', jevConsent: true, jevModel: 'jev-latest', revision: 2 });
  expect(store.memoryConfig()).toMatchObject({ enabled: false, recall: 'jev', jevConsent: true, jevModel: 'jev-latest' });
}));

test('persisted false and true settings gate the next recall assembly', () => withStore((store) => {
  store.memoryRepository.create({ text: 'A pinned preference.', kind: 'preference', pinned: true });
  expect(recallBasic(store.memoryRepository, store.memoryConfig()).entries).toHaveLength(0);
  store.handle({ method: 'memorySetEnabled', enabled: true, expectedRevision: 2 });
  expect(recallBasic(store.memoryRepository, store.memoryConfig()).entries).toHaveLength(1);
  store.handle({ method: 'memorySetEnabled', enabled: false, expectedRevision: 3 });
  expect(recallBasic(store.memoryRepository, store.memoryConfig()).entries).toHaveLength(0);
}));

test('settings can inspect, paginate, edit, pin, and forget while recall is disabled', () => withStore((store) => {
  const conversationId = conversation(store);
  const source = store.handle({ method: 'saveMessage', conversationId, text: 'A retained source message.' }).snapshot.messages.at(-1)!;
  const memory = store.memoryRepository.create({ text: '😀'.repeat(4500), kind: 'note', recordedAt: 1 });
  const page = store.handle({ method: 'memoryList', limit: 1, offset: 0 });
  expect(page.memory?.enabled).toBe(false);
  expect(page.memoryPage?.memories).toHaveLength(1);
  expect(page.memoryPage?.memories[0].textTruncated).toBe(true);
  const detail = store.handle({ method: 'memoryRead', memoryId: memory.id, expectedRevision: 1, textLimit: 3 });
  expect(detail.memoryDetail).toMatchObject({ textLength: 4500, textNextOffset: 3, textPage: '😀😀😀', evidence: [] });
  const edited = store.handle({ method: 'memoryUpdate', memoryId: memory.id, expectedRevision: 1, pinned: true });
  expect(edited.memory?.revision).toBe(3);
  expect(edited.memoryAttribution).toEqual({ surface: 'settings', createsConversationEvidence: false });
  expect(store.memoryRepository.get(memory.id)?.pinned).toBe(true);
  expect(() => store.handle({ method: 'memoryUpdate', memoryId: memory.id, expectedRevision: 1, text: 'stale' })).toThrow('revision conflict');
  expect(() => store.handle({ method: 'memoryList', limit: 1, extra: true })).toThrow('Invalid request');
  store.handle({ method: 'memoryForget', memoryId: memory.id, expectedRevision: 2 });
  expect(store.memoryRepository.get(memory.id)).toBeNull();
  expect(store.messages(conversationId).some((item) => item.id === source.id)).toBe(true);
}));

test('disabling gates an existing memory tool bag before execution and memory mutations advance event revision', async () => withStoreAsync(async (store) => {
  const conversationId = conversation(store);
  const source = store.handle({ method: 'saveMessage', conversationId, text: 'Explicit source.' }).snapshot.messages.at(-1)!;
  const bag = memoryToolbag(store.memoryRepository, () => store.memoryConfig(), { sourceMessageId: source.id, sourceRevision: source.revision ?? 1 }, new AbortController().signal);
  try {
    expect(bag.tools).toHaveLength(0);
    store.handle({ method: 'memorySetEnabled', enabled: true, expectedRevision: 1 });
    const enabledBag = memoryToolbag(store.memoryRepository, () => store.memoryConfig(), { sourceMessageId: source.id, sourceRevision: source.revision ?? 1 }, new AbortController().signal);
    expect(enabledBag.tools).toHaveLength(1);
    store.handle({ method: 'memorySetEnabled', enabled: false, expectedRevision: 2 });
    await expect(enabledBag.execute(MEMORY_TOOL_NAME, { action: 'add', text: 'must not write', kind: 'note' })).rejects.toThrow('disabled');
    expect(store.memoryRepository.list()).toHaveLength(0);
    enabledBag.close();
  } finally { bag.close(); }
}));

test('renderer memory state rejects stale events and refreshes only newer revisions', async () => {
  expect(acceptMemoryRevision(0, 1)).toEqual({ accepted: true, refresh: true, revision: 1 });
  expect(acceptMemoryRevision(1, 1)).toEqual({ accepted: true, refresh: false, revision: 1 });
  expect(acceptMemoryRevision(3, 2)).toEqual({ accepted: false, refresh: false, revision: 3 });
  expect(acceptMemoryRevision(3, 4)).toEqual({ accepted: true, refresh: true, revision: 4 });
  expect(MEMORY_DISABLED_COPY).toContain('active prompt');
  expect(MEMORY_FORGET_SCOPE_COPY).toContain('Conversation history and migration backups are retained.');
  expect(MEMORY_FORGET_SCOPE_COPY).toContain('not full conversation or backup erasure');
  const settingsSource = await Bun.file('src/renderer/components/settings/memory/memories-browser.tsx').text();
  expect(settingsSource).toContain('aria-label="Memory forgetting scope"');
  expect(settingsSource).toContain('MEMORY_FORGET_SCOPE_COPY');
});
