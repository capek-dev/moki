import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applicableAt, isApplicableAt, relationshipApplicableAt } from '@backend/memory-graph-repository';
import { Store } from '@backend/store';

const memoryId = '11111111-1111-4111-8111-111111111111';
const secondMemoryId = '22222222-2222-4222-8222-222222222222';
const thirdMemoryId = '33333333-3333-4333-8333-333333333333';
const tripId = '44444444-4444-4444-8444-444444444444';
const alexId = '55555555-5555-4555-8555-555555555555';
const topicId = '66666666-6666-4666-8666-666666666666';
const relationshipId = '77777777-7777-4777-8777-777777777777';
const legacyRelationshipId = '88888888-8888-4888-8888-888888888888';
const partialRelationshipId = '99999999-9999-4999-8999-999999999999';

function conversation(store: Store) {
  return store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
}
function memory(store: Store, id: string, text = id) {
  return store.memoryRepository.create({ id, text, kind: 'fact', recordedAt: 100 });
}
function source(store: Store, conversationId: string, text = 'Relationship source.') {
  return store.handle({ method: 'saveMessage', conversationId, text }).snapshot.messages.at(-1)!;
}

test('stores the Lisbon trip, Alex, and accessibility connection without inventing a trip fact', () => {
  const store = new Store(':memory:');
  try {
    const graph = store.memoryGraphRepository;
    const trip = graph.createEntity({ id: tripId, kind: 'trip', label: 'Lisbon trip' });
    const alex = graph.createEntity({ id: alexId, kind: 'person', label: 'Alex' });
    const access = memory(store, memoryId, 'Alex needs step-free access at hotels.');
    const conversationId = conversation(store);
    const relationshipSource = source(store, conversationId, 'Alex and the Lisbon trip are connected.');
    expect(() => graph.createRelationship({ kind: 'about', subjectId: access.id, objectId: alex.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'source-less deferred path', explicit: true })).toThrow('Relationship source is required.');
    const legacyMemory = memory(store, crypto.randomUUID(), 'Legacy source-less relationship.');
    const db = (store as unknown as { db: Database }).db;
    db.query('INSERT INTO memory_relationships (id, kind, subjectId, objectId, subjectRevision, objectRevision, provenance, explicit, recordedAt, validFrom, validUntil, sourceMessageId, sourceRevision, sourceRole, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(legacyRelationshipId, 'about', legacyMemory.id, alex.id, 1, 1, 'legacy', 1, 100, null, null, null, null, null, 1);
    expect(graph.getRelationship(legacyRelationshipId)).toMatchObject({ valid: false, invalidReason: 'source_missing' });
    expect(() => db.query('INSERT INTO memory_relationships (id, kind, subjectId, objectId, subjectRevision, objectRevision, provenance, explicit, recordedAt, validFrom, validUntil, sourceMessageId, sourceRevision, sourceRole, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(partialRelationshipId, 'about', legacyMemory.id, alex.id, 1, 1, 'partial', 1, 100, null, null, null, 1, 'user', 1)).toThrow();
    const involves = graph.createRelationship({ kind: 'involves', subjectId: trip.id, objectId: alex.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'explicit trip plan', explicit: true, sourceMessageId: relationshipSource.id, sourceRevision: relationshipSource.revision });
    const about = graph.createRelationship({ kind: 'about', subjectId: access.id, objectId: alex.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'explicit accessibility preference', explicit: true, sourceMessageId: relationshipSource.id, sourceRevision: relationshipSource.revision });

    expect(involves.valid).toBe(true);
    expect(about.valid).toBe(true);
    expect(graph.listRelationships({ endpointId: alex.id, limit: 10 }).map((item) => item.kind).sort()).toEqual(['about', 'about', 'involves']);
    expect(graph.listRelationships({ kind: 'involves', endpointId: trip.id })).toHaveLength(1);

    const partner = graph.createEntity({ kind: 'other', label: 'Alex partner' });
    expect(graph.listRelationships({ endpointId: partner.id })).toHaveLength(0);
    expect(graph.updateEntity(alex.id, 1, { label: 'Alex (updated)' }).revision).toBe(2);
    expect(graph.getRelationship(about.id)).toMatchObject({ valid: false, invalidReason: 'endpoint_revised' });
    expect(graph.listRelationships({ kind: 'involves', endpointId: alex.id })).toHaveLength(1);
  } finally { store.close(); }
});

test('prevents duplicate and self links, canonicalizes symmetric links, and rejects supersession cycles', () => {
  const store = new Store(':memory:');
  try {
    const graph = store.memoryGraphRepository;
    const first = memory(store, memoryId);
    const second = memory(store, secondMemoryId);
    const third = memory(store, thirdMemoryId);
    const conversationId = conversation(store);
    const relationshipSource = source(store, conversationId, 'These memories are related.');
    const relation = graph.createRelationship({ id: relationshipId, kind: 'related_to', subjectId: second.id, objectId: first.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'inferred association', explicit: false, validFrom: 10, validUntil: 20, sourceMessageId: relationshipSource.id, sourceRevision: relationshipSource.revision });
    expect(relation).toMatchObject({ id: relationshipId, subjectId: first.id, objectId: second.id, explicit: false, valid: true, validFrom: 10, validUntil: 20 });
    expect(applicableAt(20)).toBe(20);
    expect(isApplicableAt(10, 20, 10)).toBe(true);
    expect(isApplicableAt(10, 20, 20)).toBe(false);
    expect(relationshipApplicableAt(relation, 10)).toBe(true);
    expect(relationshipApplicableAt(relation, 20)).toBe(false);
    expect(() => graph.createRelationship({ kind: 'related_to', subjectId: first.id, objectId: second.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'duplicate', explicit: false, sourceMessageId: relationshipSource.id, sourceRevision: relationshipSource.revision })).toThrow('Duplicate relationship.');
    expect(() => graph.createRelationship({ kind: 'related_to', subjectId: first.id, objectId: first.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'self', explicit: true, sourceMessageId: relationshipSource.id, sourceRevision: relationshipSource.revision })).toThrow('Relationship cannot link an endpoint to itself.');

    graph.createRelationship({ kind: 'supersedes', subjectId: first.id, objectId: second.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'newer fact', explicit: true, sourceMessageId: relationshipSource.id, sourceRevision: relationshipSource.revision });
    graph.createRelationship({ kind: 'supersedes', subjectId: second.id, objectId: third.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'newer fact', explicit: true, sourceMessageId: relationshipSource.id, sourceRevision: relationshipSource.revision });
    expect(() => graph.createRelationship({ kind: 'supersedes', subjectId: third.id, objectId: first.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'cycle', explicit: true, sourceMessageId: relationshipSource.id, sourceRevision: relationshipSource.revision })).toThrow('Supersession cycle.');
  } finally { store.close(); }
});

test('effective state derives directional, date-applicable relationship outcomes without mutating memories', () => {
  const store = new Store(':memory:');
  try {
    const graph = store.memoryGraphRepository;
    const conversationId = conversation(store);
    const relationshipSource = source(store, conversationId, 'Current relationship evidence.');
    const oldMemory = memory(store, crypto.randomUUID(), 'Old fact.');
    const newerMemory = memory(store, crypto.randomUUID(), 'New fact.');
    graph.createRelationship({ kind: 'supersedes', subjectId: newerMemory.id, objectId: oldMemory.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'explicit correction', explicit: true, sourceMessageId: relationshipSource.id, sourceRevision: relationshipSource.revision });

    expect(graph.getEffectiveMemory(oldMemory.id, 1000)).toMatchObject({ durableState: 'active', derivedState: 'superseded', effectiveState: 'superseded', applicableAt: 1000 });
    expect(graph.getEffectiveMemory(newerMemory.id, 1000)).toMatchObject({ durableState: 'active', derivedState: null, effectiveState: 'active' });

    const contradictedMemory = memory(store, crypto.randomUUID(), 'Contested fact.');
    graph.createRelationship({ kind: 'contradicts', subjectId: oldMemory.id, objectId: contradictedMemory.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'conflicting mention', explicit: false, sourceMessageId: relationshipSource.id, sourceRevision: relationshipSource.revision });
    expect(graph.getEffectiveMemory(contradictedMemory.id, 1000)).toMatchObject({ derivedState: 'contested', effectiveState: 'contested' });

    const inferredOld = memory(store, crypto.randomUUID(), 'Inferred old fact.');
    const inferredNew = memory(store, crypto.randomUUID(), 'Inferred new fact.');
    graph.createRelationship({ kind: 'supersedes', subjectId: inferredNew.id, objectId: inferredOld.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'inferred ordering', explicit: false, sourceMessageId: relationshipSource.id, sourceRevision: relationshipSource.revision });
    expect(graph.getEffectiveMemory(inferredOld.id, 1000)).toMatchObject({ derivedState: null, effectiveState: 'active' });

    const futureOld = memory(store, crypto.randomUUID(), 'Future old fact.');
    const futureNew = memory(store, crypto.randomUUID(), 'Future new fact.');
    graph.createRelationship({ kind: 'supersedes', subjectId: futureNew.id, objectId: futureOld.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'future correction', explicit: true, validFrom: 200, sourceMessageId: relationshipSource.id, sourceRevision: relationshipSource.revision });
    expect(graph.getEffectiveMemory(futureOld.id, 100)).toMatchObject({ derivedState: null, effectiveState: 'active' });
    expect(graph.getEffectiveMemory(futureOld.id, 200)).toMatchObject({ derivedState: 'superseded', effectiveState: 'superseded' });

    const expiredOld = memory(store, crypto.randomUUID(), 'Expired old fact.');
    const expiredNew = memory(store, crypto.randomUUID(), 'Expired new fact.');
    graph.createRelationship({ kind: 'supersedes', subjectId: expiredNew.id, objectId: expiredOld.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'expired correction', explicit: true, validFrom: 10, validUntil: 20, sourceMessageId: relationshipSource.id, sourceRevision: relationshipSource.revision });
    expect(graph.getEffectiveMemory(expiredOld.id, 20)).toMatchObject({ derivedState: null, effectiveState: 'active' });
    expect(graph.getEffectiveMemory(expiredOld.id, 15)).toMatchObject({ derivedState: 'superseded', effectiveState: 'superseded' });

    const staleOld = memory(store, crypto.randomUUID(), 'Stale-source old fact.');
    const staleNew = memory(store, crypto.randomUUID(), 'Stale-source new fact.');
    const staleSource = source(store, conversationId, 'This source will change.');
    graph.createRelationship({ kind: 'supersedes', subjectId: staleNew.id, objectId: staleOld.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'stale correction', explicit: true, sourceMessageId: staleSource.id, sourceRevision: staleSource.revision });
    store.updateReply(staleSource.id, 'Changed source.', 'complete');
    expect(graph.getEffectiveMemory(staleOld.id, 1000)).toMatchObject({ derivedState: null, effectiveState: 'active' });

    const deletedOld = memory(store, crypto.randomUUID(), 'Deleted-source old fact.');
    const deletedNew = memory(store, crypto.randomUUID(), 'Deleted-source new fact.');
    const deletedSource = source(store, conversationId, 'This source will be deleted.');
    graph.createRelationship({ kind: 'supersedes', subjectId: deletedNew.id, objectId: deletedOld.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'deleted correction', explicit: true, sourceMessageId: deletedSource.id, sourceRevision: deletedSource.revision });
    store.handle({ method: 'revertMessage', conversationId, messageId: deletedSource.id });
    expect(graph.getEffectiveMemory(deletedOld.id, 1000)).toMatchObject({ derivedState: null, effectiveState: 'active' });
    expect(graph.listEffectiveMemories({ limit: 3, applicableAt: 1000 })).toHaveLength(3);
  } finally { store.close(); }
});

test('relationship support checks source and endpoint revisions independently without changing memory evidence', () => {
  const store = new Store(':memory:');
  try {
    const graph = store.memoryGraphRepository;
    const conversationId = conversation(store);
    const source = store.handle({ method: 'saveMessage', conversationId, text: 'Alex needs step-free access.' }).snapshot.messages.at(-1)!;
    const access = memory(store, memoryId, 'Alex needs step-free access.');
    const alex = graph.createEntity({ id: alexId, kind: 'person', label: 'Alex' });
    const hotel = graph.createEntity({ kind: 'place', label: 'Accessible hotel' });
    const hotelTwo = graph.createEntity({ kind: 'place', label: 'Second accessible hotel' });
    const evidence = store.memoryRepository.addEvidence({ memoryId: access.id, expectedMemoryRevision: 1, sourceMessageId: source.id, sourceRevision: source.revision!, stance: 'supporting', provenance: 'source-backed memory' });
    const relationship = graph.createRelationship({ kind: 'about', subjectId: access.id, objectId: alex.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, sourceMessageId: source.id, sourceRevision: source.revision!, provenance: 'source-backed connection', explicit: true });
    expect(store.memoryRepository.getEvidence(evidence.id)?.valid).toBe(true);
    expect(graph.getRelationship(relationship.id)?.valid).toBe(true);

    store.updateReply(source.id, 'Alex does not need step-free access.', 'complete');
    expect(graph.getRelationship(relationship.id)).toMatchObject({ valid: false, invalidReason: 'source_revised' });
    expect(store.memoryRepository.getEvidence(evidence.id)).toMatchObject({ valid: false, invalidReason: 'source_revised' });

    const sourceTwo = store.handle({ method: 'saveMessage', conversationId, text: 'Alex uses accessible hotels.' }).snapshot.messages.at(-1)!;
    const relationTwo = graph.createRelationship({ kind: 'about', subjectId: access.id, objectId: hotel.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, sourceMessageId: sourceTwo.id, sourceRevision: sourceTwo.revision!, provenance: 'second source', explicit: true });
    store.memoryRepository.update(access.id, 1, { text: 'Alex needs confirmed step-free access.' });
    expect(graph.getRelationship(relationTwo.id)).toMatchObject({ valid: false, invalidReason: 'endpoint_revised' });
    expect(store.memoryRepository.getEvidence(evidence.id)?.invalidReason).toBe('memory_revised');

    const sourceThree = store.handle({ method: 'saveMessage', conversationId, text: 'Delete this source.' }).snapshot.messages.at(-1)!;
    const relationThree = graph.createRelationship({ kind: 'about', subjectId: access.id, objectId: hotelTwo.id, expectedSubjectRevision: 2, expectedObjectRevision: 1, sourceMessageId: sourceThree.id, sourceRevision: sourceThree.revision!, provenance: 'deletion source', explicit: true });
    store.handle({ method: 'revertMessage', conversationId, messageId: sourceThree.id });
    expect(graph.getRelationship(relationThree.id)).toMatchObject({ valid: false, invalidReason: 'source_deleted' });
  } finally { store.close(); }
});

test('uses revision-aware topics and memberships, bounded reads, and survives reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-memory-graph-'));
  const path = join(dir, 'archive.sqlite');
  const first = new Store(path);
  try {
    const graph = first.memoryGraphRepository;
    const topic = graph.createTopic({ id: topicId, label: 'Accessibility', aliases: ['step-free'] });
    const access = memory(first, memoryId, 'Alex needs step-free access.');
    graph.addMemoryTopic({ memoryId: access.id, topicId: topic.id, expectedMemoryRevision: 1, expectedTopicRevision: 1 });
    expect(graph.topicsForMemory(access.id, { limit: 1 })).toHaveLength(1);
    expect(() => graph.listTopics({ limit: 101 })).toThrow('Invalid graph list limit.');
    expect(() => graph.updateTopic(topic.id, 1, { label: 'Mobility access' })).not.toThrow();
    expect(() => graph.updateTopic(topic.id, 1, { label: 'stale' })).toThrow('Topic revision conflict.');
    expect(() => graph.addMemoryTopic({ memoryId: access.id, topicId: topic.id, expectedMemoryRevision: 1, expectedTopicRevision: 2 })).toThrow('Duplicate memory topic membership.');
  } finally { first.close(); }
  try {
    const reopened = new Store(path);
    try {
      expect(reopened.memoryGraphRepository.getTopic(topicId)).toMatchObject({ label: 'Mobility access', revision: 2 });
      expect(reopened.memoryGraphRepository.memoriesForTopic(topicId)).toEqual([memoryId]);
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('forget suppresses graph-only source revisions, while a later source can create a new edge', () => {
  const store = new Store(':memory:');
  try {
    const graph = store.memoryGraphRepository;
    const conversationId = conversation(store);
    const graphSource = source(store, conversationId, 'Connect these facts.');
    const forgetSource = source(store, conversationId, 'Forget the first fact.');
    const first = memory(store, memoryId, 'First fact.');
    const second = memory(store, secondMemoryId, 'Second fact.');
    graph.createRelationship({ kind: 'related_to', subjectId: first.id, objectId: second.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'graph-only source', explicit: true, sourceMessageId: graphSource.id, sourceRevision: graphSource.revision! });

    store.memoryRepository.forget(first.id, 1, { sourceMessageId: forgetSource.id, sourceRevision: forgetSource.revision! });
    const replacement = memory(store, thirdMemoryId, 'Replacement fact.');
    expect(() => graph.createRelationship({ kind: 'related_to', subjectId: replacement.id, objectId: second.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'same forgotten graph source', explicit: true, sourceMessageId: graphSource.id, sourceRevision: graphSource.revision! })).toThrow('Memory source evidence was forgotten.');

    const newSource = source(store, conversationId, 'Connect the replacement fact explicitly.');
    expect(() => graph.createRelationship({ kind: 'related_to', subjectId: replacement.id, objectId: second.id, expectedSubjectRevision: 1, expectedObjectRevision: 1, provenance: 'new explicit source', explicit: true, sourceMessageId: newSource.id, sourceRevision: newSource.revision! })).not.toThrow();
  } finally { store.close(); }
});
