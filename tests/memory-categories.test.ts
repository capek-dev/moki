import { expect, test } from 'bun:test';
import { Store } from '@backend/storage/store';
import { LearningCoordinator, type LearningProposal } from '@backend/learning/learning';
import { normalizeMemoryTopics } from '@backend/memory/categories';
import { recallJev } from '@backend/memory/jev';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup(path = ':memory:') {
  const store = new Store(path);
  store.handle({ method: 'memorySetEnabled', enabled: true, expectedRevision: 1 });
  store.learningRepository.setEnabled(true, 1);
  const conversationId = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
  const source = store.handle({ method: 'saveMessage', conversationId, text: 'I work in software development.' }).snapshot.messages.at(-1)!;
  const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} });
  const proposal = (topics?: string[]): LearningProposal => ({ kind: 'memory', action: 'add', sourceMessageId: source.id, sourceRevision: 1, sourceRole: 'user', text: 'The user writes software.', memoryKind: 'fact', ...(topics ? { topics } : {}) });
  return { store, source, conversationId, coordinator, proposal, close: () => { coordinator.close(); store.close(); } };
}

test('reviewer labels normalize, link to seeds, and disappear with undo', async () => {
  const f = setup();
  try {
    expect((await f.coordinator.run(async () => [f.proposal([' Software Development ', 'software development'])]))?.appliedCount).toBe(1);
    const descriptors = f.store.memoryGraphRepository.listRoutingDescriptors();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].label).toBe('software development');
    expect(descriptors[0].description).not.toContain('local-rule');
    const memory = f.store.memoryRepository.list()[0];
    expect(f.store.memoryRepository.listJevSeedMemoryIds({ topicIds: [descriptors[0].id] })).toEqual([memory.id]);
    expect(f.store.learningRepository.reviewContext().routingLabels).toContain('software development');
    f.store.learningRepository.undoHistory(f.store.learningRepository.history()[0].id, 1);
    expect(f.store.memoryGraphRepository.listRoutingDescriptors()).toEqual([]);
    expect(f.store.memoryRepository.listJevSeedMemoryIds({ topicIds: [descriptors[0].id] })).toEqual([]);
  } finally { f.close(); }
});

test('legacy proposals use local labels; excluded or revised sources hide them', async () => {
  const f = setup();
  try {
    await f.coordinator.run(async () => [f.proposal()]);
    expect(f.store.memoryGraphRepository.listRoutingDescriptors()[0].description).toContain('local-rule');
    f.store.learningRepository.setExcluded(f.conversationId, true);
    expect(f.store.memoryGraphRepository.listRoutingDescriptors()).toEqual([]);
    f.store.learningRepository.setExcluded(f.conversationId, false);
    f.store.updateReply(f.source.id, 'Changed source.', 'complete');
    expect(f.store.memoryGraphRepository.listRoutingDescriptors()).toEqual([]);
    expect(f.store.memoryRepository.listBasicRecallCandidates()).toEqual([]);
  } finally { f.close(); }
});

test('invalid labels fail without committing memory or categories', async () => {
  for (const value of [[], [''], ['a', 'b', 'c', 'd', 'e'], ['bad\nlabel'], ['<private>'], ['x'.repeat(81)], [3]]) {
    expect(() => normalizeMemoryTopics(value)).toThrow();
  }
  const f = setup();
  try {
    const result = await f.coordinator.run(async () => [f.proposal(['bad\nlabel'])]);
    expect(result?.appliedCount ?? 0).toBe(0);
    expect(f.store.memoryRepository.list()).toEqual([]);
    expect(f.store.memoryGraphRepository.listRoutingDescriptors()).toEqual([]);
  } finally { f.close(); }
});

test('existing uncategorized memory reaches mocked Jev without manual setup', async () => {
  const store = new Store(':memory:');
  try {
    const memory = store.memoryRepository.create({ text: 'Software developer.', kind: 'fact', pinned: true });
    expect(store.memoryGraphRepository.listRoutingDescriptors()).toEqual([]);
    let requests = 0;
    const result = await recallJev(store.memoryRepository, store.memoryGraphRepository, { request: 'What is my occupation?', recent: '' }, { enabled: true, recall: 'jev', jevConsent: true, jevModel: 'jev-latest' }, new AbortController().signal, { key: 'synthetic' }, async (_url, init) => {
      requests++;
      const body = JSON.parse(init!.body as string);
      expect(body.state.descriptors.map((item: { label: string }) => item.label)).toContain('software development');
      expect(JSON.stringify(body.state.descriptors)).not.toContain(memory.text);
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'score', score: 3, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } }])) });
    });
    expect(requests).toBe(1);
    expect(result.inspection.outcome).toBe('jev_selected');
    expect(result.entries.map(entry => entry.memory.id)).toEqual([memory.id]);
    const descriptors = store.memoryGraphRepository.listRoutingDescriptors();
    store.handle({ method: 'memoryForget', memoryId: memory.id, expectedRevision: 1 });
    expect(store.memoryGraphRepository.listRoutingDescriptors()).toEqual([]);
    expect(store.memoryRepository.listJevSeedMemoryIds({ topicIds: descriptors.map(item => item.id) })).toEqual([]);
  } finally { store.close(); }
});

test('metadata and text changes invalidate categories without breaking CAS', () => {
  const store = new Store(':memory:');
  try {
    const memory = store.memoryRepository.create({ text: 'Software developer.', kind: 'fact', pinned: true });
    expect(store.memoryGraphRepository.prepareRoutingCategories()).toBe(1);
    const old = store.memoryGraphRepository.listRoutingDescriptors();
    store.memoryRepository.update(memory.id, 1, { core: true });
    expect(store.memoryGraphRepository.listRoutingDescriptors()).toEqual([]);
    expect(store.memoryGraphRepository.prepareRoutingCategories()).toBe(1);
    store.memoryRepository.update(memory.id, 2, { text: 'Enjoys travel.' });
    store.memoryGraphRepository.prepareRoutingCategories();
    expect(store.memoryGraphRepository.listRoutingDescriptors().map(item => item.label)).toEqual(['travel']);
    expect(store.memoryRepository.listJevSeedMemoryIds({ topicIds: old.map(item => item.id) })).toEqual([]);
  } finally { store.close(); }
});

test('correction categories bind to new revision; undo never revives corrected labels', async () => {
  const f = setup();
  try {
    await f.coordinator.run(async () => [f.proposal(['software development'])]);
    const memory = f.store.memoryRepository.list()[0];
    const source = f.store.handle({ method: 'saveMessage', conversationId: f.conversationId, text: 'I now work in marketing.' }).snapshot.messages.at(-1)!;
    await f.coordinator.run(async () => [{ kind: 'memory', action: 'correct', memoryId: memory.id, expectedMemoryRevision: 1, text: 'The user works in marketing.', topics: ['marketing'], sourceMessageId: source.id, sourceRevision: 1, sourceRole: 'user' }]);
    expect(f.store.memoryRepository.read(memory.id).memory.revision).toBe(2);
    const history = f.store.learningRepository.history().find(item => item.action === 'correct')!;
    f.store.learningRepository.undoHistory(history.id, 2);
    expect(f.store.memoryGraphRepository.listRoutingDescriptors()).toEqual([]);
    // Existing undo deliberately does not rebind old evidence to the new revision.
    expect(f.store.memoryRepository.listBasicRecallCandidates()).toEqual([]);
  } finally { f.close(); }
});

test('category installation and bounded repair are idempotent across reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moki-category-'));
  const path = join(directory, 'store.sqlite');
  try {
    const store = new Store(path);
    try {
      for (let i = 0; i < 101; i++) store.memoryRepository.create({ text: `Software note ${i}`, kind: 'note', pinned: true });
      expect(store.memoryGraphRepository.prepareRoutingCategories()).toBe(100);
      const first = store.memoryGraphRepository.listRoutingDescriptors({ limit: 1 });
      expect(store.memoryGraphRepository.listRoutingDescriptors({ limit: 1 })).toEqual(first);
    } finally { store.close(); }
    const reopened = new Store(path);
    try {
      expect(reopened.memoryGraphRepository.prepareRoutingCategories()).toBe(1);
      expect(reopened.memoryGraphRepository.prepareRoutingCategories()).toBe(0);
      expect(reopened.memoryGraphRepository.listRoutingDescriptors()[0].label).toBe('software development');
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
