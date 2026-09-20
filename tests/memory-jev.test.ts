import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { Store } from '@backend/store';
import { recallJev } from '@backend/memory-jev';

function conversation(store: Store): string {
  return store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
}

function source(store: Store, conversationId: string, text: string) {
  return store.handle({ method: 'saveMessage', conversationId, text }).snapshot.messages.at(-1)!;
}

const tripId = '11111111-1111-4111-8111-111111111111';
const alexId = '22222222-2222-4222-8222-222222222222';
const memoryId = '33333333-3333-4333-8333-333333333333';

function routeResponse(init: RequestInit | undefined, selectedId: string) {
  const body = JSON.parse(init?.body as string) as { state: { task: { request: string; recent: string }; descriptors: Array<{ id: string; kind: string; label: string }> }; questions: Record<string, unknown> };
  expect(body.state.task.request.length).toBeLessThanOrEqual(8_000);
  expect(body.state.task.recent.length).toBeLessThanOrEqual(2_000);
  expect(body.state.descriptors.length).toBeLessThanOrEqual(80);
  expect(JSON.stringify(body.state)).not.toContain('step-free access');
  return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((key, index) => {
    const descriptor = body.state.descriptors[index];
    const selected = descriptor.id === selectedId;
    return [key, { type: 'score', score: selected ? 1.7 : 0, probabilities: selected ? { 0: 0, 1: 0.3, 2: 0.7, 3: 0 } : { 0: 1, 1: 0, 2: 0, 3: 0 } }];
  })) });
}

test('Jev routes bounded descriptors and retrieves Lisbon trip to Alex to accessibility in one hop', async () => {
  const store = new Store(':memory:');
  try {
    const conversationId = conversation(store);
    const user = source(store, conversationId, 'We are planning a Lisbon hotel and Alex is joining.');
    const trip = store.memoryGraphRepository.createEntity({ id: tripId, kind: 'trip', label: 'Lisbon trip' });
    const alex = store.memoryGraphRepository.createEntity({ id: alexId, kind: 'person', label: 'Alex' });
    const memory = store.memoryRepository.create({ id: memoryId, text: 'Alex requires step-free access.', kind: 'fact' });
    store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: user.id, sourceRevision: user.revision!, stance: 'supporting', provenance: 'user statement' });
    store.memoryGraphRepository.createRelationship({ kind: 'involves', subjectId: trip.id, objectId: alex.id, expectedSubjectRevision: trip.revision, expectedObjectRevision: alex.revision, provenance: 'trip participation', explicit: true, sourceMessageId: user.id, sourceRevision: user.revision! });
    store.memoryGraphRepository.createRelationship({ kind: 'about', subjectId: memory.id, objectId: alex.id, expectedSubjectRevision: memory.revision, expectedObjectRevision: alex.revision, provenance: 'accessibility fact', explicit: true, sourceMessageId: user.id, sourceRevision: user.revision! });
    let requests = 0;
    const result = await recallJev(store.memoryRepository, store.memoryGraphRepository, { request: 'Find a hotel in Lisbon.', recent: '' }, { enabled: true, recall: 'jev', jevConsent: true, jevModel: 'jev-latest', maxEntries: 4, maxCandidates: 20, maxTextChars: 8_000 }, new AbortController().signal, { key: 'typesafe-test-key' }, async (_url, init) => { requests++; return routeResponse(init, trip.id); });
    expect(requests).toBe(1);
    expect(result.entries.map((entry) => entry.memory.id)).toEqual([memory.id]);
    expect(result.context).toContain('Alex requires step-free access.');
    expect(result.inspection).toMatchObject({ mode: 'jev', outcome: 'jev_selected', descriptorCount: 2 });
    expect(result.inspection.selected).toEqual([{ memoryId: memory.id, revision: 1 }]);
  } finally { store.close(); }
});

test('Jev consent is separate from tool selection and disabled or unconsented recall sends no request', async () => {
  const store = new Store(':memory:');
  try {
    store.memoryGraphRepository.createEntity({ id: tripId, kind: 'trip', label: 'Lisbon trip' });
    expect(store.memoryGraphRepository.listRoutingDescriptorPage().descriptors).toEqual([]);
    let requests = 0;
    const noConsent = await recallJev(store.memoryRepository, store.memoryGraphRepository, { request: 'Lisbon', recent: '' }, { enabled: true, recall: 'jev', jevConsent: false, jevModel: 'jev-latest' }, new AbortController().signal, { key: 'tool-selection-key' }, async () => { requests++; return Response.json({}); });
    const disabled = await recallJev(store.memoryRepository, store.memoryGraphRepository, { request: 'Lisbon', recent: '' }, { enabled: false, recall: 'jev', jevConsent: true, jevModel: 'jev-latest' }, new AbortController().signal, { key: 'tool-selection-key' }, async () => { requests++; return Response.json({}); });
    expect(requests).toBe(0);
    expect(noConsent.inspection.outcome).toBe('jev_consent_required');
    expect(disabled.inspection.outcome).toBe('disabled');
  } finally { store.close(); }
});

test('recall inspection stores IDs and revisions only, then forgetting scrubs selected payloads', () => {
  const store = new Store(':memory:');
  try {
    const conversationId = conversation(store);
    const memory = store.memoryRepository.create({ id: memoryId, text: 'Private memory text must not enter recall history.', kind: 'note' });
    const recorded = store.recordMemoryRecall(conversationId, 'assistant-reply', { messageId: 'assistant-reply', mode: 'jev', outcome: 'jev_selected', selected: [{ memoryId: memory.id, revision: memory.revision }], candidateCount: 1, descriptorCount: 2, descriptorAvailableCount: 90, descriptorsTruncated: true, selectedDescriptorCount: 1, topicSeedCount: 1, entitySeedCount: 0, lexicalSeedCount: 1, expandedEntityCount: 0, expandedMemoryCount: 1, fallbackReason: 'test', relationshipCount: 1, elapsedMs: 4 });
    expect(recorded.selected).toEqual([{ memoryId: memory.id, revision: 1 }]);
    expect(store.memoryRecallHistory().records[0]).toMatchObject({ descriptorAvailableCount: 90, descriptorsTruncated: true, selectedDescriptorCount: 1, topicSeedCount: 1, lexicalSeedCount: 1, expandedMemoryCount: 1, fallbackReason: 'test' });
    expect(JSON.stringify(store.memoryRecallHistory().records)).not.toContain(memory.text);
    store.handle({ method: 'memoryForget', memoryId: memory.id, expectedRevision: 1 });
    expect(store.memoryRecallHistory().records[0]?.selected).toEqual([]);
  } finally { store.close(); }
});

test('descriptor paging keeps a request-relevant topic inside the 80 item request', async () => {
  const store = new Store(':memory:');
  try {
    const conversationId = conversation(store);
    const user = source(store, conversationId, 'Needle routing source.');
    const memory = store.memoryRepository.create({ id: memoryId, text: 'Needle result.', kind: 'fact' });
    store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: user.id, sourceRevision: user.revision!, stance: 'supporting', provenance: 'user statement' });
    let selectedTopicId = '';
    for (let index = 0; index < 81; index++) {
      const topic = store.memoryGraphRepository.createTopic({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`,
        label: index === 80 ? 'zzzz needle topic' : `topic ${index.toString().padStart(3, '0')}`,
      });
      store.memoryGraphRepository.addMemoryTopic({ memoryId: memory.id, topicId: topic.id, expectedMemoryRevision: 1, expectedTopicRevision: 1 });
      if (index === 80) selectedTopicId = topic.id;
    }
    const result = await recallJev(store.memoryRepository, store.memoryGraphRepository, { request: 'Find the needle topic.', recent: '' }, { enabled: true, recall: 'jev', jevConsent: true, jevModel: 'jev-latest' }, new AbortController().signal, { key: 'typesafe-test-key' }, async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { state: { descriptors: Array<{ id: string }> } };
      expect(body.state.descriptors).toHaveLength(80);
      expect(body.state.descriptors.some((descriptor) => descriptor.id === selectedTopicId)).toBe(true);
      return routeResponse(init, selectedTopicId);
    });
    expect(result.entries.map((entry) => entry.memory.id)).toEqual([memory.id]);
    expect(result.inspection).toMatchObject({ descriptorCount: 80, descriptorsTruncated: true, selectedDescriptorCount: 1 });
    expect(result.inspection.descriptorAvailableCount).toBeGreaterThanOrEqual(81);
  } finally { store.close(); }
});

test('ranked Jev seeds keep a lexical match beyond the old UUID-ordered cutoff', () => {
  const store = new Store(':memory:');
  try {
    const conversationId = conversation(store);
    const user = source(store, conversationId, 'Large topic source.');
    const topic = store.memoryGraphRepository.createTopic({ id: tripId, label: 'Large topic' });
    for (let index = 0; index < 80; index++) {
      const memory = store.memoryRepository.create({ id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, text: `Filler ${index}`, kind: 'fact' });
      store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: user.id, sourceRevision: user.revision!, stance: 'supporting', provenance: 'user statement' });
      store.memoryGraphRepository.addMemoryTopic({ memoryId: memory.id, topicId: topic.id, expectedMemoryRevision: 1, expectedTopicRevision: 1 });
    }
    const target = store.memoryRepository.create({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', text: 'The needle memory.', kind: 'fact' });
    store.memoryRepository.addEvidence({ memoryId: target.id, expectedMemoryRevision: 1, sourceMessageId: user.id, sourceRevision: user.revision!, stance: 'supporting', provenance: 'user statement' });
    store.memoryGraphRepository.addMemoryTopic({ memoryId: target.id, topicId: topic.id, expectedMemoryRevision: 1, expectedTopicRevision: 1 });
    const seeds = store.memoryRepository.listJevSeedMemories({ topicIds: [topic.id], lexicalTerms: ['needle'], limit: 80 });
    expect(seeds[0]).toMatchObject({ memoryId: target.id, explicitTopicMatches: 1, lexicalMatches: 1 });
    expect(seeds.map((seed) => seed.memoryId)).toContain(target.id);
  } finally { store.close(); }
});

test('failed Jev routing uses local relevance before priority and excludes unrelated supported memories', async () => {
  const store = new Store(':memory:');
  try {
    const conversationId = conversation(store);
    const user = source(store, conversationId, 'Orchid preference and unrelated note.');
    const relevant = store.memoryRepository.create({ text: 'The orchid pot belongs by the window.', kind: 'preference' });
    const unrelated = store.memoryRepository.create({ text: 'The bicycle needs a new chain.', kind: 'note' });
    for (const memory of [relevant, unrelated]) store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: user.id, sourceRevision: user.revision!, stance: 'supporting', provenance: 'user statement' });
    const result = await recallJev(store.memoryRepository, store.memoryGraphRepository, { request: 'Where does the orchid pot belong?', recent: '' }, { enabled: true, recall: 'jev', jevConsent: true, jevModel: 'jev-latest' }, new AbortController().signal, { key: 'typesafe-test-key' }, async () => Response.json({ answers: {} }));
    expect(result.inspection.outcome).toBe('failed_fallback');
    expect(result.entries.map((entry) => entry.memory.id)).toEqual([relevant.id]);
    expect(result.inspection.lexicalSeedCount).toBe(1);
  } finally { store.close(); }
});

test('no Jev labels uses lexical rescue and the 0.70 probability threshold is inclusive', async () => {
  const store = new Store(':memory:');
  try {
    const conversationId = conversation(store);
    const user = source(store, conversationId, 'Orchid note about Alex.');
    const alex = store.memoryGraphRepository.createEntity({ id: alexId, kind: 'person', label: 'Alex' });
    const memory = store.memoryRepository.create({ id: memoryId, text: 'Alex keeps the orchid by the window.', kind: 'fact' });
    store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: user.id, sourceRevision: user.revision!, stance: 'supporting', provenance: 'user statement' });
    store.memoryGraphRepository.createRelationship({ kind: 'about', subjectId: memory.id, objectId: alex.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'user statement', explicit: true, sourceMessageId: user.id, sourceRevision: user.revision! });
    const run = (acceptedProbability: number) => recallJev(store.memoryRepository, store.memoryGraphRepository, { request: 'Where is the orchid?', recent: '' }, { enabled: true, recall: 'jev', jevConsent: true, jevModel: 'jev-latest' }, new AbortController().signal, { key: 'typesafe-test-key' }, async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { questions: Record<string, unknown> };
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: 'score', score: 1.4, probabilities: { 0: 1 - acceptedProbability, 1: 0, 2: acceptedProbability, 3: 0 } }])) });
    });
    const below = await run(0.69);
    expect(below.inspection.outcome).toBe('jev_no_labels');
    expect(below.entries.map((entry) => entry.memory.id)).toEqual([memory.id]);
    expect(below.inspection.fallbackReason).toBe('no_selected_descriptors:lexical');
    expect((await run(0.70)).inspection.outcome).toBe('jev_selected');
  } finally { store.close(); }
});

test('Jev malformed transport falls back to bounded basic recall, while cancellation rejects without fallback', async () => {
  const store = new Store(':memory:');
  try {
    const fallbackMemory = store.memoryRepository.create({ id: memoryId, text: 'Pinned local fallback.', kind: 'note', pinned: true });
    store.memoryGraphRepository.createEntity({ id: tripId, kind: 'trip', label: 'Local trip' });
    const result = await recallJev(store.memoryRepository, store.memoryGraphRepository, { request: 'local', recent: '' }, { enabled: true, recall: 'jev', jevConsent: true, jevModel: 'jev-latest' }, new AbortController().signal, { key: 'typesafe-test-key' }, async () => Response.json({ answers: {} }));
    expect(result.inspection.outcome).toBe('failed_fallback');
    expect(result.entries[0].memory.id).toBe(fallbackMemory.id);
    const invalid = await recallJev(store.memoryRepository, store.memoryGraphRepository, { request: 'local', recent: '' }, { enabled: true, recall: 'jev', jevConsent: true, jevModel: 'jev-latest' }, new AbortController().signal, { key: 'typesafe-test-key' }, async () => Response.json({ answers: { item_9: { type: 'score', score: 3, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } } } }));
    expect(invalid.inspection.outcome).toBe('failed_fallback');
    const timedOut = await recallJev(store.memoryRepository, store.memoryGraphRepository, { request: 'local', recent: '' }, { enabled: true, recall: 'jev', jevConsent: true, jevModel: 'jev-latest' }, new AbortController().signal, { key: 'typesafe-test-key' }, async () => new Promise<Response>(() => {}), Date.now(), { timeoutMs: 10 });
    expect(timedOut.inspection.outcome).toBe('failed_fallback');

    const controller = new AbortController();
    const pending = recallJev(store.memoryRepository, store.memoryGraphRepository, { request: 'local', recent: '' }, { enabled: true, recall: 'jev', jevConsent: true, jevModel: 'jev-latest' }, controller.signal, { key: 'typesafe-test-key' }, async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    controller.abort();
    await expect(pending).rejects.toThrow();
  } finally { store.close(); }
});

test('seed truncation happens after complete recall eligibility', () => {
  const store = new Store(':memory:');
  try {
    const conversationId = conversation(store);
    const user = source(store, conversationId, 'A large corrected topic.');
    const topic = store.memoryGraphRepository.createTopic({ id: tripId, label: 'Corrected topic' });
    for (let index = 0; index < 80; index++) {
      const memory = store.memoryRepository.create({ id: `00000000-0000-4000-9000-${index.toString(16).padStart(12, '0')}`, text: `Invalid old fact ${index}`, kind: 'fact' });
      store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: user.id, sourceRevision: user.revision!, stance: 'supporting', provenance: 'user statement' });
      store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: user.id, sourceRevision: user.revision!, stance: 'contradicting', provenance: 'user correction' });
      store.memoryGraphRepository.addMemoryTopic({ memoryId: memory.id, topicId: topic.id, expectedMemoryRevision: 1, expectedTopicRevision: 1 });
    }
    const target = store.memoryRepository.create({ id: 'ffffffff-ffff-4fff-9fff-ffffffffffff', text: 'Eligible corrected fact.', kind: 'fact' });
    store.memoryRepository.addEvidence({ memoryId: target.id, expectedMemoryRevision: 1, sourceMessageId: user.id, sourceRevision: user.revision!, stance: 'supporting', provenance: 'user statement' });
    store.memoryGraphRepository.addMemoryTopic({ memoryId: target.id, topicId: topic.id, expectedMemoryRevision: 1, expectedTopicRevision: 1 });
    const seeds = store.memoryRepository.listJevSeedMemories({ topicIds: [topic.id], limit: 80 });
    expect(seeds.map((seed) => seed.memoryId)).toEqual([target.id]);
    expect(store.memoryGraphRepository.listRoutingDescriptorPage().descriptors.map((item) => item.id)).toEqual([topic.id]);
  } finally { store.close(); }
});

test('route fusion preserves an eligible related memory when direct seeds fill the candidate limit', async () => {
  const store = new Store(':memory:');
  try {
    const conversationId = conversation(store);
    const user = source(store, conversationId, 'Route and graph source.');
    const topic = store.memoryGraphRepository.createTopic({ id: tripId, label: 'Graph route' });
    const seeds = [];
    for (let index = 0; index < 4; index++) {
      const item = store.memoryRepository.create({ text: `Direct route fact ${index}.`, kind: 'fact' });
      store.memoryRepository.addEvidence({ memoryId: item.id, expectedMemoryRevision: 1, sourceMessageId: user.id, sourceRevision: user.revision!, stance: 'supporting', provenance: 'user statement' });
      store.memoryGraphRepository.addMemoryTopic({ memoryId: item.id, topicId: topic.id, expectedMemoryRevision: 1, expectedTopicRevision: 1 });
      seeds.push(item);
    }
    const related = store.memoryRepository.create({ text: 'Important one-hop result.', kind: 'fact' });
    store.memoryRepository.addEvidence({ memoryId: related.id, expectedMemoryRevision: 1, sourceMessageId: user.id, sourceRevision: user.revision!, stance: 'supporting', provenance: 'user statement' });
    store.memoryGraphRepository.createRelationship({ kind: 'related_to', subjectId: seeds[0].id, objectId: related.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'user association', explicit: true, sourceMessageId: user.id, sourceRevision: user.revision! });
    const result = await recallJev(store.memoryRepository, store.memoryGraphRepository, { request: 'Use the graph route.', recent: '' }, { enabled: true, recall: 'jev', jevConsent: true, maxCandidates: 4, maxEntries: 4 }, new AbortController().signal, { key: 'typesafe-test-key' }, async (_url, init) => routeResponse(init, topic.id));
    expect(result.entries.map((entry) => entry.memory.id)).toContain(related.id);
    expect(result.inspection.expandedMemoryCount).toBe(1);
  } finally { store.close(); }
});

test('unconsented fallback stays read-only and an explicit ISO date enables historical recall', async () => {
  const store = new Store(':memory:');
  try {
    const conversationId = conversation(store);
    const user = source(store, conversationId, 'Historical orchid note.');
    const historical = store.memoryRepository.create({ text: 'The orchid was in Lisbon.', kind: 'fact', validFrom: Date.parse('2020-01-01T00:00:00Z'), validUntil: Date.parse('2020-01-02T00:00:00Z') });
    store.memoryRepository.addEvidence({ memoryId: historical.id, expectedMemoryRevision: 1, sourceMessageId: user.id, sourceRevision: user.revision!, stance: 'supporting', provenance: 'user statement' });
    const result = await recallJev(store.memoryRepository, store.memoryGraphRepository, { request: 'Where was the orchid on 2020-01-01?', recent: '' }, { enabled: true, recall: 'jev', jevConsent: false }, new AbortController().signal);
    expect(result.entries.map((entry) => entry.memory.id)).toEqual([historical.id]);
    const db = (store as unknown as { db: Database }).db;
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM memory_routing_categories').get()?.count).toBe(0);
  } finally { store.close(); }
});
