import { expect, test } from 'bun:test';
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
    const recorded = store.recordMemoryRecall(conversationId, 'assistant-reply', { messageId: 'assistant-reply', mode: 'jev', outcome: 'jev_selected', selected: [{ memoryId: memory.id, revision: memory.revision }], candidateCount: 1, descriptorCount: 2, relationshipCount: 1, elapsedMs: 4 });
    expect(recorded.selected).toEqual([{ memoryId: memory.id, revision: 1 }]);
    expect(JSON.stringify(store.memoryRecallHistory().records)).not.toContain(memory.text);
    store.handle({ method: 'memoryForget', memoryId: memory.id, expectedRevision: 1 });
    expect(store.memoryRecallHistory().records[0]?.selected).toEqual([]);
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
