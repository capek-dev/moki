import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@backend/store';
import { installMemorySchema } from '@backend/memory-repository';

const memoryId = '11111111-1111-4111-8111-111111111111';
const secondMemoryId = '22222222-2222-4222-8222-222222222222';
const evidenceId = '33333333-3333-4333-8333-333333333333';
const thirdMemoryId = '44444444-4444-4444-8444-444444444444';
const legacyEvidenceId = '55555555-5555-4555-8555-555555555555';

function conversation(store: Store) {
  return store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
}

test('memory records validate stable fields, validity intervals, and revisions', () => {
  const store = new Store(':memory:');
  try {
    const memories = store.memoryRepository;
    const created = memories.create({ id: memoryId, text: 'Alex needs step-free access.', kind: 'fact', pinned: true, validFrom: 100, validUntil: 200, recordedAt: 150 });
    expect(created).toMatchObject({ id: memoryId, kind: 'fact', pinned: true, validFrom: 100, validUntil: 200, revision: 1 });
    expect(memories.list()).toHaveLength(1);
    expect(() => memories.create({ id: 'not-an-id', text: 'bad', kind: 'fact' })).toThrow('Invalid memory id.');
    expect(() => memories.create({ id: secondMemoryId, text: 'bad interval', kind: 'fact', validFrom: 10, validUntil: 10 })).toThrow('Invalid validity interval.');
    const updated = memories.update(memoryId, 1, { text: 'Alex needs step-free access at hotels.', validUntil: null });
    expect(updated).toMatchObject({ revision: 2, validUntil: null });
    expect(() => memories.update(memoryId, 1, { text: 'stale edit' })).toThrow('Memory revision conflict.');
    expect(memories.get(memoryId)?.text).toBe('Alex needs step-free access at hotels.');
  } finally { store.close(); }
});

test('memory listing requires bounded limit and validated offset pagination', () => {
  const store = new Store(':memory:');
  try {
    const memories = store.memoryRepository;
    memories.create({ id: memoryId, text: 'first', kind: 'note', recordedAt: 100 });
    memories.create({ id: secondMemoryId, text: 'second', kind: 'note', recordedAt: 200 });
    memories.create({ id: thirdMemoryId, text: 'third', kind: 'note', recordedAt: 300 });
    expect(memories.list({ limit: 1, offset: 1 }).map((memory) => memory.id)).toEqual([secondMemoryId]);
    expect(() => memories.list({ limit: 0 })).toThrow('Invalid memory list limit.');
    expect(() => memories.list({ limit: 101 })).toThrow('Invalid memory list limit.');
    expect(() => memories.list({ offset: -1 })).toThrow('Invalid memory list offset.');
  } finally { store.close(); }
});

test('memory and evidence use the same persistent SQLite source of truth after reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-memory-'));
  const path = join(dir, 'archive.sqlite');
  const first = new Store(path);
  try {
    const conversationId = conversation(first);
    first.handle({ method: 'saveMessage', conversationId, text: 'Persistent source.' });
    const source = first.messages(conversationId)[0];
    const memory = first.memoryRepository.create({ id: memoryId, text: 'Persistent memory.', kind: 'note' });
    first.memoryRepository.addEvidence({ id: evidenceId, memoryId: memory.id, expectedMemoryRevision: memory.revision, sourceMessageId: source.id, sourceRevision: 1, stance: 'supporting', provenance: 'persistence test' });
  } finally { first.close(); }
  const reopened = new Store(path);
  try { expect(reopened.memoryRepository.read(memoryId).validSupportingEvidence).toHaveLength(1); } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('evidence requires an existing non-streaming source and prevents duplicate confirmations', () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    store.handle({ method: 'saveMessage', conversationId: id, text: 'Alex uses a wheelchair.' });
    const source = store.messages(id)[0];
    const memory = store.memoryRepository.create({ id: memoryId, text: 'Alex uses a wheelchair.', kind: 'fact' });
    const evidence = store.memoryRepository.addEvidence({ id: evidenceId, memoryId: memory.id, expectedMemoryRevision: memory.revision, sourceMessageId: source.id, sourceRevision: source.revision!, stance: 'supporting', provenance: 'foreground note' });
    expect(evidence).toMatchObject({ id: evidenceId, memoryRevision: 1, sourceMessageId: source.id, sourceRevision: 1, sourceRole: 'user', stance: 'supporting', valid: true });
    expect(() => store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: source.id, sourceRevision: 1, stance: 'supporting', provenance: 'reprocessed note' })).toThrow('Duplicate source evidence.');
    expect(() => store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: source.id, sourceRevision: 1, stance: 'contradicting', provenance: 'different mention' })).not.toThrow();

    const { messageId: streamingSource } = store.begin(id, 'Another source', 'deepseek-flash');
    expect(() => store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: streamingSource, sourceRevision: 1, stance: 'supporting', provenance: 'streaming extraction' })).toThrow('Streaming source cannot support evidence.');
  } finally { store.close(); }
});

test('source rewrites and deletions remain visible as invalid evidence on reads', () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    const { messageId } = store.begin(id, 'Alex is joining the Lisbon trip.', 'deepseek-flash');
    store.updateReply(messageId, 'Alex is joining the Lisbon trip.', 'complete');
    const memory = store.memoryRepository.create({ id: memoryId, text: 'Alex is joining the Lisbon trip.', kind: 'fact' });
    const evidence = store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: messageId, sourceRevision: 1, stance: 'supporting', provenance: 'assistant transcript review' });
    expect(evidence).toMatchObject({ memoryRevision: 1, sourceRole: 'assistant', valid: true });

    store.updateReply(messageId, 'Alex is not joining the Lisbon trip.', 'complete');
    expect(store.memoryRepository.getEvidence(evidence.id)).toMatchObject({ valid: false, invalidReason: 'source_revised', sourceRole: 'assistant' });
    expect(store.memoryRepository.read(memory.id).validSupportingEvidence).toHaveLength(0);

    const teaMemory = store.memoryRepository.create({ id: secondMemoryId, text: 'I like tea.', kind: 'preference' });
    const teaSource = store.handle({ method: 'saveMessage', conversationId: id, text: 'I like tea.' }).snapshot.messages.at(-1)!;
    const teaEvidence = store.memoryRepository.addEvidence({ memoryId: teaMemory.id, expectedMemoryRevision: 1, sourceMessageId: teaSource.id, sourceRevision: 1, stance: 'supporting', provenance: 'preference extraction' });
    const coffeeMemory = store.memoryRepository.update(teaMemory.id, 1, { text: 'I like coffee.' });
    expect(store.memoryRepository.getEvidence(teaEvidence.id)).toMatchObject({ valid: false, invalidReason: 'memory_revised', memoryRevision: 1 });
    expect(store.memoryRepository.read(teaMemory.id).validSupportingEvidence).toHaveLength(0);
    expect(() => store.memoryRepository.addEvidence({ memoryId: teaMemory.id, expectedMemoryRevision: 1, sourceMessageId: teaSource.id, sourceRevision: 1, stance: 'supporting', provenance: 'stale tea attachment' })).toThrow('Memory revision conflict.');
    expect(coffeeMemory.revision).toBe(2);

    const deletionId = store.handle({ method: 'saveMessage', conversationId: id, text: 'This source will be deleted.' }).snapshot.messages.at(-1)!.id;
    const deletionEvidence = store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: deletionId, sourceRevision: 1, stance: 'supporting', provenance: 'user note' });
    store.handle({ method: 'revertMessage', conversationId: id, messageId: deletionId });
    expect(store.memoryRepository.getEvidence(deletionEvidence.id)).toMatchObject({ valid: false, invalidReason: 'source_deleted', sourceRole: 'user' });
    expect(store.memoryRepository.read(memory.id).evidence.filter((item) => item.valid)).toHaveLength(0);
  } finally { store.close(); }
});

test('old evidence bindings remain invalid after upgrade without invented memory proof', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-memory-legacy-'));
  const path = join(dir, 'legacy.sqlite');
  const legacy = new Database(path);
  try {
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE assistants (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, instructions TEXT NOT NULL);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, assistantId TEXT NOT NULL REFERENCES assistants(id), title TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), text TEXT NOT NULL);
      CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, pinned INTEGER NOT NULL, core INTEGER NOT NULL, recordedAt INTEGER NOT NULL, validFrom INTEGER, validUntil INTEGER, revision INTEGER NOT NULL);
      CREATE TABLE memory_evidence (id TEXT PRIMARY KEY, memoryId TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, sourceMessageId TEXT NOT NULL, sourceRevision INTEGER NOT NULL, sourceRole TEXT NOT NULL, stance TEXT NOT NULL, provenance TEXT NOT NULL, recordedAt INTEGER NOT NULL);
      INSERT INTO assistants VALUES ('moki', 'Moki', 'deepseek', 'Be helpful.');
      INSERT INTO conversations VALUES ('c1', 'moki', 'Legacy memory');
      INSERT INTO messages VALUES ('source-1', 'c1', 'I like tea.');
    `);
    legacy.query('INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(memoryId, 'I like tea.', 'preference', 'active', 0, 0, 100, null, null, 2);
    legacy.query('INSERT INTO memory_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(legacyEvidenceId, memoryId, 'source-1', 1, 'user', 'supporting', 'old extractor', 100);
  } finally { legacy.close(); }
  try {
    const store = new Store(path);
    try {
      expect(store.memoryRepository.getEvidence(legacyEvidenceId)).toMatchObject({ memoryRevision: null, valid: false, invalidReason: 'memory_revision_unknown' });
       expect(store.memoryRepository.read(memoryId).validSupportingEvidence).toHaveLength(0);
       expect(store.memoryRepository.forget(memoryId, 2, { sourceMessageId: 'source-1', sourceRevision: 1 })).toMatchObject({ memoryId, alreadyForgotten: false });
       const db = (store as unknown as { db: Database }).db;
       expect(db.query<{ sourceMessageId: string; sourceRevision: number }, []>('SELECT sourceMessageId, sourceRevision FROM memory_forget_sources').all()).toEqual([{ sourceMessageId: 'source-1', sourceRevision: 1 }]);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('upgrades the evidence uniqueness key without losing old rows or blocking a later memory revision', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
        pinned INTEGER NOT NULL, core INTEGER NOT NULL, recordedAt INTEGER NOT NULL,
        validFrom INTEGER, validUntil INTEGER, revision INTEGER NOT NULL
      );
      CREATE TABLE memory_evidence (
        id TEXT PRIMARY KEY,
        memoryId TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        memoryRevision INTEGER,
        sourceMessageId TEXT NOT NULL,
        sourceRevision INTEGER NOT NULL,
        sourceRole TEXT NOT NULL,
        stance TEXT NOT NULL,
        provenance TEXT NOT NULL,
        recordedAt INTEGER NOT NULL,
        UNIQUE (memoryId, sourceMessageId, sourceRevision, stance)
      );
      INSERT INTO memories VALUES ('${memoryId}', 'Legacy memory', 'note', 'active', 0, 0, 100, NULL, NULL, 2);
      INSERT INTO memory_evidence VALUES ('${legacyEvidenceId}', '${memoryId}', 1, 'source-1', 1, 'user', 'supporting', 'legacy evidence', 100);
    `);
    installMemorySchema(db);
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM memory_evidence').get()?.count).toBe(1);
    db.query('INSERT INTO memory_evidence (id, memoryId, memoryRevision, sourceMessageId, sourceRevision, sourceRole, stance, provenance, recordedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('66666666-6666-4666-8666-666666666666', memoryId, 2, 'source-1', 1, 'user', 'supporting', 'corrected revision', 200);
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM memory_evidence').get()?.count).toBe(2);
  } finally {
    db.close();
  }
});

test('evidence duplicate checks and foreground duplicate reads match the current memory revision', () => {
  const store = new Store(':memory:');
  try {
    const conversationId = conversation(store);
    const source = store.handle({ method: 'saveMessage', conversationId, text: 'The source supports this fact.' }).snapshot.messages.at(-1)!;
    const memory = store.memoryRepository.create({ id: memoryId, text: 'Original fact.', kind: 'fact' });
    const first = store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: source.id, sourceRevision: source.revision!, stance: 'supporting', provenance: 'original evidence' });
    store.memoryRepository.update(memory.id, 1, { text: 'Corrected fact.' });
    const current = store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 2, sourceMessageId: source.id, sourceRevision: source.revision!, stance: 'supporting', provenance: 'current evidence' });
    expect(store.memoryRepository.getEvidence(first.id)).toMatchObject({ valid: false, invalidReason: 'memory_revised' });
    expect(current).toMatchObject({ memoryRevision: 2, valid: true });
    expect(store.memoryRepository.read(memory.id).validSupportingEvidence).toEqual([current]);
    const duplicate = store.memoryRepository.createWithForegroundEvidence({ text: 'Corrected fact.', kind: 'fact' }, { sourceMessageId: source.id, sourceRevision: source.revision! });
    expect(duplicate).toMatchObject({ created: false, memory: { id: memory.id, revision: 2 }, evidence: { id: current.id, memoryRevision: 2 } });
  } finally { store.close(); }
});

test('forget atomically removes live memory data and records only ID-based suppression', () => {
  const store = new Store(':memory:');
  try {
    const conversationId = conversation(store);
    const firstSource = store.handle({ method: 'saveMessage', conversationId, text: 'The first evidence source.' }).snapshot.messages.at(-1)!;
    const forgetSource = store.handle({ method: 'saveMessage', conversationId, text: 'Please forget the stored memory.' }).snapshot.messages.at(-1)!;
    const memory = store.memoryRepository.create({ id: memoryId, text: 'Private memory text that must not survive.', kind: 'fact' });
    store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: firstSource.id, sourceRevision: firstSource.revision!, stance: 'supporting', provenance: 'first source' });
    const revised = store.memoryRepository.update(memory.id, 1, { text: 'Private memory revision.' });
    store.memoryRepository.addEvidence({ memoryId: revised.id, expectedMemoryRevision: 2, sourceMessageId: forgetSource.id, sourceRevision: forgetSource.revision!, stance: 'supporting', provenance: 'forget request context' });
    const other = store.memoryRepository.create({ id: secondMemoryId, text: 'Other memory.', kind: 'fact' });
    const topic = store.memoryGraphRepository.createTopic({ id: thirdMemoryId, label: 'Forget test' });
    store.memoryGraphRepository.addMemoryTopic({ memoryId: revised.id, topicId: topic.id, expectedMemoryRevision: 2, expectedTopicRevision: 1 });
    store.memoryGraphRepository.createRelationship({ kind: 'related_to', subjectId: revised.id, objectId: other.id, expectedSubjectRevision: 2, expectedObjectRevision: 1, provenance: 'outgoing link', explicit: true, sourceMessageId: forgetSource.id, sourceRevision: forgetSource.revision! });
    store.memoryGraphRepository.createRelationship({ kind: 'supersedes', subjectId: other.id, objectId: revised.id, expectedSubjectRevision: 1, expectedObjectRevision: 2, provenance: 'incoming link', explicit: true, sourceMessageId: forgetSource.id, sourceRevision: forgetSource.revision! });

    const result = store.memoryRepository.forget(revised.id, 2, { sourceMessageId: forgetSource.id, sourceRevision: forgetSource.revision! });
    expect(result).toEqual({ memoryId: revised.id, expectedRevision: 2, alreadyForgotten: false });
    expect(store.memoryRepository.get(revised.id)).toBeNull();
    expect(store.memoryRepository.list()).toEqual([other]);
    expect(store.memoryRepository.search('Private memory')).toHaveLength(0);
    expect(() => store.memoryRepository.read(revised.id)).toThrow('Memory not found.');
    expect(store.memoryGraphRepository.topicsForMemory(revised.id)).toHaveLength(0);
    expect(store.memoryGraphRepository.listRelationships({ endpointId: revised.id })).toHaveLength(0);
    expect(store.memoryGraphRepository.memoriesForTopic(topic.id)).toHaveLength(0);
    const db = (store as unknown as { db: Database }).db;
    expect(db.query<{ count: number }, [string]>('SELECT count(*) AS count FROM memory_evidence WHERE memoryId = ?').get(revised.id)?.count).toBe(0);
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM memory_forget_sources').get()?.count).toBe(2);
    expect(db.query<{ name: string }, []>('PRAGMA table_info(memory_forget_suppressions)').all().map((column) => column.name)).not.toContain('text');
    expect(store.messages(conversationId).some((message) => message.id === forgetSource.id)).toBe(true);
  } finally { store.close(); }
});

test('forget uses CAS rollback, blocks the same source retry, and permits a different explicit source', () => {
  const store = new Store(':memory:');
  try {
    const conversationId = conversation(store);
    const source = store.handle({ method: 'saveMessage', conversationId, text: 'Remember then forget this.' }).snapshot.messages.at(-1)!;
    const otherSource = store.handle({ method: 'saveMessage', conversationId, text: 'A new explicit request.' }).snapshot.messages.at(-1)!;
    const memory = store.memoryRepository.create({ id: memoryId, text: 'Forgotten content.', kind: 'note' });
    const evidence = store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: source.id, sourceRevision: source.revision!, stance: 'supporting', provenance: 'source' });
    store.memoryRepository.update(memory.id, 1, { text: 'Changed content.' });
    expect(() => store.memoryRepository.forget(memory.id, 1, { sourceMessageId: otherSource.id, sourceRevision: otherSource.revision! })).toThrow('Memory revision conflict.');
    expect(store.memoryRepository.get(memory.id)).toMatchObject({ revision: 2, text: 'Changed content.' });
    expect(store.memoryRepository.getEvidence(evidence.id)).not.toBeNull();
    const db = (store as unknown as { db: Database }).db;
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM memory_forget_suppressions').get()?.count).toBe(0);

    const forgotten = store.memoryRepository.forget(memory.id, 2, { sourceMessageId: otherSource.id, sourceRevision: otherSource.revision! });
    expect(forgotten.alreadyForgotten).toBe(false);
    expect(() => store.memoryRepository.createWithForegroundEvidence({ id: memory.id, text: 'retry text', kind: 'note' }, { sourceMessageId: otherSource.id, sourceRevision: otherSource.revision! })).toThrow('Memory has been forgotten.');
    expect(() => store.memoryRepository.createWithForegroundEvidence({ text: 'same source retry', kind: 'note' }, { sourceMessageId: otherSource.id, sourceRevision: otherSource.revision! })).toThrow('Memory source evidence was forgotten.');
    expect(() => store.memoryRepository.assertSourceEvidenceAllowed(otherSource.id, otherSource.revision!)).toThrow('Memory source evidence was forgotten.');
    const newSource = store.handle({ method: 'saveMessage', conversationId, text: 'A genuinely new explicit source.' }).snapshot.messages.at(-1)!;
    const relearned = store.memoryRepository.createWithForegroundEvidence({ text: 'Explicitly relearned content.', kind: 'note' }, { sourceMessageId: newSource.id, sourceRevision: newSource.revision! });
    expect(relearned.created).toBe(true);
  } finally { store.close(); }
});

test('forget persists suppression and an exact retry is idempotent after reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-memory-forget-'));
  const path = join(dir, 'archive.sqlite');
  const first = new Store(path);
  let source!: { id: string; revision?: number };
  try {
    const conversationId = conversation(first);
    source = first.handle({ method: 'saveMessage', conversationId, text: 'Forget this persisted record.' }).snapshot.messages.at(-1)!;
    first.memoryRepository.create({ id: memoryId, text: 'Persisted forgotten content.', kind: 'fact' });
    expect(first.memoryRepository.forget(memoryId, 1, { sourceMessageId: source.id, sourceRevision: source.revision! }).alreadyForgotten).toBe(false);
  } finally { first.close(); }
  try {
    const reopened = new Store(path);
    try {
      expect(reopened.memoryRepository.list()).toHaveLength(0);
      expect(reopened.memoryRepository.forget(memoryId, 1, { sourceMessageId: source.id, sourceRevision: source.revision! })).toEqual({ memoryId, expectedRevision: 1, alreadyForgotten: true });
      expect(() => reopened.memoryRepository.create({ id: memoryId, text: 'must stay suppressed', kind: 'fact' })).toThrow('Memory has been forgotten.');
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('evidence modality persists and quotations or hypotheticals do not establish recall support', () => {
  const store = new Store(':memory:');
  try {
    const conversationId = conversation(store);
    const quotedSource = store.handle({ method: 'saveMessage', conversationId, text: 'Someone said they live in Rome.' }).snapshot.messages.at(-1)!;
    const quoted = store.memoryRepository.create({ text: 'The user lives in Rome.', kind: 'fact' });
    const evidence = store.memoryRepository.addEvidence({ memoryId: quoted.id, expectedMemoryRevision: 1, sourceMessageId: quotedSource.id, sourceRevision: quotedSource.revision!, stance: 'supporting', modality: 'quotation', provenance: 'quoted statement' });
    expect(evidence.modality).toBe('quotation');
    expect(store.memoryRepository.listBasicRecallCandidates({ ids: [quoted.id] })).toEqual([]);

    const directSource = store.handle({ method: 'saveMessage', conversationId, text: 'I intend to visit Rome.' }).snapshot.messages.at(-1)!;
    const intention = store.memoryRepository.create({ text: 'The user intends to visit Rome.', kind: 'fact' });
    store.memoryRepository.addEvidence({ memoryId: intention.id, expectedMemoryRevision: 1, sourceMessageId: directSource.id, sourceRevision: directSource.revision!, stance: 'supporting', modality: 'intention', provenance: 'direct intention' });
    expect(store.memoryRepository.listBasicRecallCandidates({ ids: [intention.id] })[0]).toMatchObject({ sourceModality: 'intention' });
  } finally { store.close(); }
});
