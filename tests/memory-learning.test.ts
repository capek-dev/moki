import { expect, test } from 'bun:test';
import { Store } from '@backend/store';
import { LearningCoordinator, LEARNING_DISPATCH_TIMEOUT_MS, LEARNING_IDLE_MS, LEARNING_MAX_AUTOMATIC_ATTEMPTS, LEARNING_MAX_PENDING_MS, LEARNING_REVIEW_TIMEOUT_MS, LEARNING_RUN_DETAIL_MAX_BYTES, reviewWithModel, type LearningProposal } from '@backend/memory-learning';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sourceProposal = (sourceMessageId: string, sourceRevision: number, text: string): LearningProposal => ({
  kind: 'memory', action: 'add', sourceMessageId, sourceRevision, sourceRole: 'user', text, memoryKind: 'fact',
});

function conversation(store: Store): string {
  return store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
}

function enable(store: Store) {
  expect(store.learningRepository.settings()).toMatchObject({ enabled: false, paused: false, revision: 1 });
  store.handle({ method: 'memorySetEnabled', enabled: true, expectedRevision: 1 });
  store.learningRepository.setEnabled(true, 1, 1000);
}

function fakeClock() {
  let now = 1000;
  let scheduled: { callback: () => void; delay: number } | undefined;
  const timer = {
    setTimeout: (callback: () => void, delay: number) => { scheduled = { callback, delay }; return 1 as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: () => { scheduled = undefined; },
  };
  return { clock: { now: () => now, timer }, advance: (amount: number) => { now += amount; }, get scheduled() { return scheduled; } };
}

test('learning is persisted off, activation is future-only, and a fake reviewer applies bounded proposals', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    const old = store.handle({ method: 'saveMessage', conversationId: id, text: 'Old message.' }).snapshot.messages.at(-1)!;
    expect(store.learningRepository.settings().enabled).toBe(false);
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'I use a standing desk.' }).snapshot.messages.at(-1)!;
    const fake = fakeClock();
    const due: string[] = [];
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: (run) => due.push(run.id) }, fake.clock);
    coordinator.onActivity();
    expect(fake.scheduled?.delay).toBe(LEARNING_IDLE_MS);
    let reviewed = 0;
    const result = await coordinator.run(async (sources) => {
      reviewed++;
      expect(sources.map((item) => item.id)).toEqual([source.id]);
      expect(sources.some((item) => item.id === old.id)).toBe(false);
      return [sourceProposal(source.id, source.revision!, 'The user uses a standing desk.')];
    });
    expect(reviewed).toBe(1);
    expect(result?.status).toBe('complete');
    expect(store.memoryRepository.list()).toHaveLength(1);
    expect(store.learningRepository.history()).toHaveLength(1);
    coordinator.close();
  } finally { store.close(); }
});

test('disabled learning performs no review and pause or disable cancels before commit', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    store.handle({ method: 'saveMessage', conversationId: id, text: 'Do not learn this while disabled.' });
    const fake = fakeClock();
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fake.clock);
    expect(await coordinator.run(async () => { throw new Error('reviewer must not run'); })).toBeNull();
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'New activity after activation.' }).snapshot.messages.at(-1)!;
    const result = await coordinator.run(async () => {
      store.learningRepository.setPaused(true, 2);
      return [sourceProposal(source.id, source.revision!, 'Should not be committed.')];
    });
    expect(result).toBeNull();
    expect(store.memoryRepository.list()).toHaveLength(0);
    expect(store.learningRepository.settings().paused).toBe(true);
    coordinator.close();
  } finally { store.close(); }
});

test('source revisions, conversation exclusions, and forgotten evidence suppress proposals at commit', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'The source will be edited.' }).snapshot.messages.at(-1)!;
    const fake = fakeClock();
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fake.clock);
    const stale = await coordinator.run(async () => {
      store.updateReply(source.id, 'The source changed.', 'complete');
      return [sourceProposal(source.id, source.revision!, 'Stale fact.')];
    });
    expect(stale?.status).toBe('complete');
    expect(store.memoryRepository.list()).toHaveLength(0);

    const excludedSource = store.handle({ method: 'saveMessage', conversationId: id, text: 'This conversation is private.' }).snapshot.messages.at(-1)!;
    const excluded = await coordinator.run(async () => {
      store.learningRepository.setExcluded(id, true, 2000);
      return [sourceProposal(excludedSource.id, excludedSource.revision!, 'Excluded fact.')];
    });
    expect(excluded?.status).toBe('complete');
    expect(store.memoryRepository.list()).toHaveLength(0);
    store.learningRepository.setExcluded(id, false, 3000);

    const forgetSource = store.handle({ method: 'saveMessage', conversationId: id, text: 'Forget evidence before review commits.' }).snapshot.messages.at(-1)!;
    const memory = store.memoryRepository.createWithForegroundEvidence({ text: 'Existing fact.', kind: 'fact' }, { sourceMessageId: forgetSource.id, sourceRevision: forgetSource.revision! });
    const suppressed = await coordinator.run(async () => {
      store.memoryRepository.forget(memory.memory.id, memory.memory.revision, { sourceMessageId: forgetSource.id, sourceRevision: forgetSource.revision! });
      return [{ kind: 'memory', action: 'confirm', sourceMessageId: forgetSource.id, sourceRevision: forgetSource.revision!, sourceRole: 'user', memoryId: memory.memory.id, expectedMemoryRevision: memory.memory.revision }];
    });
    expect(suppressed?.status).toBe('complete');
    expect(store.memoryRepository.get(memory.memory.id)).toBeNull();
    expect(store.learningRepository.history()).toHaveLength(0);
    coordinator.close();
  } finally { store.close(); }
});

test('learning undo is revision-safe and does not erase later user edits', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'Undo this learned fact.' }).snapshot.messages.at(-1)!;
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fakeClock().clock);
    await coordinator.run(async () => [sourceProposal(source.id, source.revision!, 'Undoable fact.')]);
    const history = store.learningRepository.history()[0];
    const memory = store.memoryRepository.list()[0];
    expect(history.afterRevision).toBe(memory.revision);
    store.memoryRepository.update(memory.id, memory.revision, { text: 'User corrected this fact.' });
    expect(() => store.learningRepository.undoHistory(history.id, memory.revision)).toThrow('revision conflict');
    expect(store.memoryRepository.get(memory.id)?.text).toBe('User corrected this fact.');
    coordinator.close();
  } finally { store.close(); }
});

test('failed review retries after restart with the same future-only cursor and applies once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-learning-restart-'));
  const path = join(dir, 'archive.sqlite');
  let store = new Store(path);
  try {
    const id = conversation(store);
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'Retry this review.' }).snapshot.messages.at(-1)!;
    const first = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fakeClock().clock);
    expect(await first.run(async () => { throw new Error('temporary reviewer failure'); })).toBeNull();
    expect(store.learningRepository.history()).toHaveLength(0);
    first.close();
    store.close();
    store = new Store(path);
    const second = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fakeClock().clock);
    const result = await second.run(async () => [sourceProposal(source.id, source.revision!, 'Retried fact.')]);
    expect(result?.status).toBe('complete');
    expect(result?.attempt).toBe(2);
    expect(store.memoryRepository.list()).toHaveLength(1);
    expect(store.learningRepository.history()).toHaveLength(1);
    second.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('model reviewer uses fake credentials, emits constrained JSON, and exposes no tools', async () => {
  const source = { rowid: 1, id: 'source-1', conversationId: 'conversation-1', role: 'user' as const, text: 'I prefer tea.', revision: 1, createdAt: 1000 };
  let seen: { credentials: unknown; tools: unknown } | undefined;
  const fakeGenerate = async function* (turn: Parameters<typeof reviewWithModel>[0] extends never ? never : any) {
    seen = { credentials: turn.credentials, tools: turn.tools };
    yield JSON.stringify({ proposals: [{ kind: 'memory', action: 'add', sourceMessageId: source.id, sourceRevision: 1, sourceRole: 'user', text: 'The user prefers tea.', memoryKind: 'preference' }] });
  };
  const proposals = await reviewWithModel(fakeGenerate, 'deepseek', 'deepseek-flash', { provider: 'deepseek', key: 'fake-secret' }, '11111111-1111-4111-8111-111111111111', [source], new AbortController().signal);
  expect(proposals).toHaveLength(1);
  expect(seen).toEqual({ credentials: { provider: 'deepseek', key: 'fake-secret' }, tools: undefined });
});

test('scheduler uses one injected timer and emits no work while disabled', () => {
  const store = new Store(':memory:');
  try {
    const fake = fakeClock();
    let due = 0;
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => { due++; } }, fake.clock);
    coordinator.onActivity();
    expect(fake.scheduled).toBeUndefined();
    const id = conversation(store);
    enable(store);
    store.handle({ method: 'saveMessage', conversationId: id, text: 'Future activity.' });
    coordinator.onActivity();
    expect(fake.scheduled?.delay).toBe(LEARNING_IDLE_MS);
    expect(due).toBe(0);
    coordinator.close();
  } finally { store.close(); }
});

test('exact idle deadline fires one due run and provider/model selection is validated and persisted', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'Deadline source.' }).snapshot.messages.at(-1)!;
    const fake = fakeClock();
    const due: string[] = [];
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: (run) => due.push(run.id) }, fake.clock);
    coordinator.onActivity();
    expect(fake.scheduled?.delay).toBe(LEARNING_IDLE_MS);
    fake.advance(LEARNING_IDLE_MS);
    fake.scheduled!.callback();
    await Promise.resolve();
    expect(due).toHaveLength(1);
    const run = store.learningRepository.getRun(due[0]);
    expect(run?.status).toBe('pending');
    await coordinator.run(async (sources) => [sourceProposal(sources[0].id, sources[0].revision, 'Deadline fact.')], undefined, due[0]);
    expect(store.memoryRepository.list()).toHaveLength(1);
    const selected = store.handle({ method: 'learningSetProviderModel', provider: 'codex', model: 'gpt-5.6-sol', expectedRevision: 2 });
    expect(selected.learning).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol', revision: 3 });
    expect(() => store.handle({ method: 'learningSetProviderModel', provider: 'deepseek', model: 'gpt-5.6-sol', expectedRevision: 3 })).toThrow('supported model');
    coordinator.close();
  } finally { store.close(); }
});

test('conversation exclusions persist, reload, and invalidate existing background evidence', () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'Background evidence to exclude.' }).snapshot.messages.at(-1)!;
    const memory = store.memoryRepository.create({ text: 'Derived fact.', kind: 'fact' });
    store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: 1, sourceMessageId: source.id, sourceRevision: source.revision!, stance: 'supporting', provenance: 'background learning' });
    expect(store.memoryRepository.read(memory.id).validSupportingEvidence).toHaveLength(1);
    store.handle({ method: 'learningExcludeConversation', conversationId: id, excluded: true });
    const reloaded = store.handle({ method: 'learningSettings' });
    expect(reloaded.learningExclusions).toEqual([id]);
    expect(store.memoryRepository.read(memory.id).validSupportingEvidence).toHaveLength(0);
    expect(store.memoryRepository.read(memory.id).evidence[0].invalidReason).toBe('conversation_excluded');
    store.handle({ method: 'learningExcludeConversation', conversationId: id, excluded: false });
    expect(store.memoryRepository.read(memory.id).validSupportingEvidence).toHaveLength(1);
  } finally { store.close(); }
});

test('contradictory proposals create a contested relationship without overwriting either memory', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const firstSource = store.handle({ method: 'saveMessage', conversationId: id, text: 'I prefer tea.' }).snapshot.messages.at(-1)!;
    const first = store.memoryRepository.createWithForegroundEvidence({ text: 'The user prefers tea.', kind: 'preference' }, { sourceMessageId: firstSource.id, sourceRevision: firstSource.revision! });
    const secondSource = store.handle({ method: 'saveMessage', conversationId: id, text: 'I prefer coffee now.' }).snapshot.messages.at(-1)!;
    const second = store.memoryRepository.createWithForegroundEvidence({ text: 'The user prefers coffee.', kind: 'preference' }, { sourceMessageId: secondSource.id, sourceRevision: secondSource.revision! });
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fakeClock().clock);
    const result = await coordinator.run(async () => [{ kind: 'relationship', action: 'create', sourceMessageId: secondSource.id, sourceRevision: secondSource.revision!, sourceRole: 'user', relationshipKind: 'contradicts', subjectId: first.memory.id, objectId: second.memory.id, expectedSubjectRevision: first.memory.revision, expectedObjectRevision: second.memory.revision, provenance: 'background learning' }]);
    expect(result?.appliedCount).toBe(1);
    expect(store.memoryRepository.get(first.memory.id)?.text).toBe('The user prefers tea.');
    expect(store.memoryRepository.get(second.memory.id)?.text).toBe('The user prefers coffee.');
    expect(store.memoryGraphRepository.listRelationships({ kind: 'contradicts' })).toHaveLength(1);
    coordinator.close();
  } finally { store.close(); }
});

test('topic, entity, and relationship history undo is transactional and dependency-safe', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'Organize this evidence.' }).snapshot.messages.at(-1)!;
    const memory = store.memoryRepository.create({ text: 'Organized fact.', kind: 'fact' });
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fakeClock().clock);
    await coordinator.run(async () => [{ kind: 'topic', action: 'create', sourceMessageId: source.id, sourceRevision: source.revision!, sourceRole: 'user', label: 'Organization', memoryId: memory.id, expectedMemoryRevision: memory.revision }]);
    const topicHistory = store.learningRepository.history().find((item) => item.resourceType === 'topic')!;
    expect(() => store.learningRepository.undoHistory(topicHistory.id, topicHistory.afterRevision)).not.toThrow();
    expect(store.memoryGraphRepository.listTopics()).toHaveLength(0);

    const entitySource = store.handle({ method: 'saveMessage', conversationId: id, text: 'Connect this person.' }).snapshot.messages.at(-1)!;
    await coordinator.run(async () => [{ kind: 'entity', action: 'create', sourceMessageId: entitySource.id, sourceRevision: entitySource.revision!, sourceRole: 'user', entityKind: 'person', label: 'Alex', memoryId: memory.id, expectedMemoryRevision: memory.revision }]);
    const entityHistory = store.learningRepository.history().find((item) => item.resourceType === 'entity')!;
    const relationHistory = store.learningRepository.history().find((item) => item.resourceType === 'relationship')!;
    expect(() => store.learningRepository.undoHistory(entityHistory.id, entityHistory.afterRevision)).toThrow('revision conflict');
    expect(() => store.learningRepository.undoHistory(relationHistory.id, relationHistory.afterRevision)).not.toThrow();
    expect(() => store.learningRepository.undoHistory(entityHistory.id, entityHistory.afterRevision)).not.toThrow();
    expect(store.memoryGraphRepository.listEntities()).toHaveLength(0);
    coordinator.close();
  } finally { store.close(); }
});

test('forget erases learning history payloads and cannot resurrect forgotten memory', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'Forget this learned content.' }).snapshot.messages.at(-1)!;
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fakeClock().clock);
    await coordinator.run(async () => [sourceProposal(source.id, source.revision!, 'Sensitive learned content.')]);
    const history = store.learningRepository.history()[0];
    const memory = store.memoryRepository.list()[0];
    expect(JSON.stringify(history.after)).toContain('Sensitive learned content.');
    store.memoryRepository.forget(memory.id, memory.revision, { sourceMessageId: source.id, sourceRevision: source.revision! });
    expect(store.learningRepository.history()).toHaveLength(0);
    expect(store.learningRepository.runDetail(history.runId).proposals).toHaveLength(0);
    expect(() => store.learningRepository.undoHistory(history.id, memory.revision)).toThrow('history entry not found');
    expect(store.memoryRepository.get(memory.id)).toBeNull();
    coordinator.close();
  } finally { store.close(); }
});

test('disabling memory during review cancels the reviewer result and denies commit', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'Disable during review.' }).snapshot.messages.at(-1)!;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fakeClock().clock);
    const review = coordinator.run(async () => { await waiting; return [sourceProposal(source.id, source.revision!, 'Must not commit.')]; });
    await Promise.resolve();
    store.handle({ method: 'memorySetEnabled', enabled: false, expectedRevision: 2 });
    release();
    expect(await review).toBeNull();
    expect(store.memoryRepository.list()).toHaveLength(0);
    coordinator.close();
  } finally { store.close(); }
});

test('learning cursor waits at streaming rows and later terminal writes are not skipped', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const first = store.handle({ method: 'saveMessage', conversationId: id, text: 'First source.' }).snapshot.messages.at(-1)!;
    const pending = store.begin(id, 'Pending user source.', 'deepseek-flash');
    const later = store.handle({ method: 'saveMessage', conversationId: id, text: 'Later source.' }).snapshot.messages.at(-1)!;
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fakeClock().clock);
    const firstRun = await coordinator.run(async (sources) => {
      expect(sources.map((source) => source.id)).toEqual([first.id, store.messages(id)[1].id]);
      return [];
    });
    expect(firstRun?.status).toBe('complete');
    expect(store.learningRepository.sourceBatch(firstRun!.cursorEnd).map((source) => source.id)).toEqual([]);
    store.updateReply(pending.messageId, 'Published assistant source.', 'complete');
    const next = store.learningRepository.beginRun(2000);
    expect(next?.sources.map((source) => source.id)).toEqual([pending.messageId, later.id]);
    coordinator.close();
  } finally { store.close(); }
});

test('an oversized source is truncated within the batch budget instead of pinning the cursor', () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const large = store.handle({ method: 'saveMessage', conversationId: id, text: 'x'.repeat(16_000) }).snapshot.messages.at(-1)!;
    const later = store.handle({ method: 'saveMessage', conversationId: id, text: 'Later source.' }).snapshot.messages.at(-1)!;
    const batch = store.learningRepository.sourceBatch(0, 10, 12_000);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ id: large.id, text: 'x'.repeat(12_000) });
    expect(store.learningRepository.sourceBatch(batch[0].rowid).map((source) => source.id)).toEqual([later.id]);
  } finally { store.close(); }
});

test('a rejected graph proposal rolls back partial topic writes', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'Graph proposal.' }).snapshot.messages.at(-1)!;
    const memory = store.memoryRepository.create({ text: 'Existing fact.', kind: 'fact' });
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fakeClock().clock);
    const result = await coordinator.run(async () => [{ kind: 'topic', action: 'create', sourceMessageId: source.id, sourceRevision: source.revision!, sourceRole: 'user', label: 'Invalid membership', memoryId: memory.id, expectedMemoryRevision: 99 }]);
    expect(result?.status).toBe('complete');
    expect(result?.rejectedCount).toBe(1);
    expect(store.memoryGraphRepository.listTopics()).toHaveLength(0);
    expect(store.learningRepository.history()).toHaveLength(0);
    coordinator.close();
  } finally { store.close(); }
});

test('learning undo refuses to overwrite evidence added after a correction', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'Correct this fact.' }).snapshot.messages.at(-1)!;
    const memory = store.memoryRepository.create({ text: 'Original fact.', kind: 'fact' });
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fakeClock().clock);
    await coordinator.run(async () => [{ kind: 'memory', action: 'correct', sourceMessageId: source.id, sourceRevision: source.revision!, sourceRole: 'user', memoryId: memory.id, expectedMemoryRevision: 1, text: 'Learned correction.', memoryKind: 'fact' }]);
    const history = store.learningRepository.history()[0];
    const corrected = store.memoryRepository.get(memory.id)!;
    const laterSource = store.handle({ method: 'saveMessage', conversationId: id, text: 'Independent later support.' }).snapshot.messages.at(-1)!;
    store.memoryRepository.addEvidence({ memoryId: memory.id, expectedMemoryRevision: corrected.revision, sourceMessageId: laterSource.id, sourceRevision: laterSource.revision!, stance: 'supporting', provenance: 'foreground support' });
    expect(() => store.learningRepository.undoHistory(history.id, corrected.revision)).toThrow('revision conflict');
    expect(store.memoryRepository.get(memory.id)?.text).toBe('Learned correction.');
    coordinator.close();
  } finally { store.close(); }
});

test('cooldown remains the hard floor after the maximum pending deadline', () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    store.handle({ method: 'saveMessage', conversationId: id, text: 'Cooldown floor.' });
    const fake = fakeClock();
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fake.clock);
    const db = (store.learningRepository as unknown as { db: { query: Function } }).db;
    db.query('UPDATE learning_settings SET pendingSince = ?, idleUntil = ?, cooldownUntil = ? WHERE id = 0').run(1000, 1000 + LEARNING_MAX_PENDING_MS + 1, 1000 + LEARNING_MAX_PENDING_MS * 2);
    coordinator.onSettingsChanged();
    expect(fake.scheduled?.delay).toBe(LEARNING_MAX_PENDING_MS * 2);
    coordinator.close();
  } finally { store.close(); }
});

test('reviewer timeout aborts a never-settling reviewer and late output cannot commit', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'Timeout source.' }).snapshot.messages.at(-1)!;
    const fake = fakeClock();
    let release!: (value: readonly LearningProposal[]) => void;
    const late = new Promise<readonly LearningProposal[]>((resolve) => { release = resolve; });
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fake.clock);
    const review = coordinator.run(async (_sources, signal) => { signal.addEventListener('abort', () => {}); return late; });
    await Promise.resolve();
    expect(fake.scheduled?.delay).toBe(LEARNING_REVIEW_TIMEOUT_MS);
    fake.scheduled!.callback();
    const result = await review;
    expect(result).toBeNull();
    expect(store.learningRepository.listRuns().runs[0]).toMatchObject({ status: 'failed', error: 'Learning reviewer timed out.' });
    release([sourceProposal(source.id, source.revision!, 'Late fact.')]);
    await Promise.resolve();
    expect(store.memoryRepository.list()).toHaveLength(0);
    coordinator.close();
  } finally { store.close(); }
});

test('last error stays visible while an explicit retry is running', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    store.handle({ method: 'saveMessage', conversationId: id, text: 'Retry source.' });
    const fake = fakeClock();
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fake.clock);
    await coordinator.run(async () => { throw new Error('temporary reviewer failure'); });
    const failed = store.learningRepository.listRuns().runs[0];
    expect(failed).toMatchObject({ status: 'failed', error: 'temporary reviewer failure' });
    store.learningRepository.retryRun(failed.id, 2000);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const running = coordinator.run(async () => { await waiting; return []; }, undefined, failed.id);
    await Promise.resolve();
    expect(store.learningRepository.getRun(failed.id)).toMatchObject({ status: 'running', error: 'temporary reviewer failure' });
    release();
    expect((await running)?.outcome).toBe('no_changes');
    coordinator.close();
  } finally { store.close(); }
});

test('model prompt supplies parser-aligned schema and bounded current records', async () => {
  const source = { rowid: 1, id: 'source-1', conversationId: 'conversation-1', role: 'user' as const, text: 'I prefer tea.', revision: 1, createdAt: 1000 };
  let prompt = '';
  const fakeGenerate = async function* (turn: any) {
    prompt = `${turn.instructions}\n${String(turn.messages[0].content)}`;
    yield JSON.stringify({ proposals: [{ kind: 'memory', action: 'add', sourceMessageId: source.id, sourceRevision: 1, sourceRole: 'user', text: 'The user prefers tea.', memoryKind: 'preference' }] });
  };
  const proposals = await reviewWithModel(fakeGenerate, 'deepseek', 'deepseek-flash', { provider: 'deepseek', key: 'fake-secret' }, '11111111-1111-4111-8111-111111111111', [source], new AbortController().signal, { memories: [{ id: '22222222-2222-4222-8222-222222222222', revision: 3, kind: 'preference', text: 'The user prefers coffee.' }], topics: [], entities: [] });
  expect(proposals[0]).toMatchObject({ sourceMessageId: source.id, sourceRevision: 1 });
  expect(prompt).toContain('currentRecords');
  expect(prompt).toContain('22222222-2222-4222-8222-222222222222');
  expect(prompt).toContain('expectedMemoryRevision');
});

test('run inspector reports changed and deleted sources without calling them historical snapshots', () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'Inspectable source.' }).snapshot.messages.at(-1)!;
    const started = store.learningRepository.beginRun(1000)!;
    store.updateReply(source.id, 'Changed source.', 'complete');
    const changed = store.handle({ method: 'learningRunDetail', runId: started.run.id });
    expect(changed.learningRunDetail?.sources[0]).toMatchObject({ state: 'changed', currentText: 'Changed source.', currentTextIsHistoricalSnapshot: false });
    store.handle({ method: 'revertMessage', conversationId: id, messageId: source.id });
    const deleted = store.handle({ method: 'learningRunDetail', runId: started.run.id });
    expect(deleted.learningRunDetail?.sources[0]).toMatchObject({ state: 'deleted', currentText: null, currentTextIsHistoricalSnapshot: false });
  } finally { store.close(); }
});

test('automatic failures stop at a bounded attempt count until explicit retry', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    store.handle({ method: 'saveMessage', conversationId: id, text: 'Bounded failures.' });
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fakeClock().clock);
    await coordinator.run(async () => { throw new Error('failure one'); });
    for (let attempt = 2; attempt <= LEARNING_MAX_AUTOMATIC_ATTEMPTS; attempt++) {
      const next = store.learningRepository.beginRun(attempt * 1000)!;
      expect(next.run.attempt).toBe(attempt);
      store.learningRepository.failRun(next.run.id, new Error(`failure ${attempt}`), false, attempt * 1000);
    }
    expect(store.learningRepository.beginRun(10_000)).toBeNull();
    expect(store.learningRepository.listRuns().runs[0]).toMatchObject({ status: 'failed', attempt: LEARNING_MAX_AUTOMATIC_ATTEMPTS, error: `failure ${LEARNING_MAX_AUTOMATIC_ATTEMPTS}` });
    coordinator.close();
  } finally { store.close(); }
});

test('startup recovery fails an orphaned legacy run, preserves its error, and stops scheduling', () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const source = store.handle({ method: 'saveMessage', conversationId: id, text: 'Orphan source.' }).snapshot.messages.at(-1)!;
    const db = (store.learningRepository as unknown as { db: { query: Function } }).db;
    const rowid = db.query('SELECT rowid FROM messages WHERE id = ?').get(source.id).rowid as number;
    const runId = crypto.randomUUID();
    db.query("INSERT INTO learning_runs (id, operationKey, status, cursorStart, cursorEnd, attempt, provider, model, createdAt, startedAt, error) VALUES (?, ?, 'running', 0, ?, 115, 'deepseek', 'deepseek-flash', 1000, 1000, 'previous failure')").run(runId, `0:${rowid}`, rowid);
    const fake = fakeClock();
    let due = 0;
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => { due++; } }, fake.clock);
    expect(store.learningRepository.getRun(runId)).toMatchObject({ status: 'failed', attempt: 115, error: 'previous failure' });
    expect(fake.scheduled).toBeUndefined();
    coordinator.onActivity();
    expect(fake.scheduled).toBeUndefined();
    expect(due).toBe(0);
    coordinator.close();
  } finally { store.close(); }
});

test('explicit retry of a legacy failed run reviews current sources anew in chronological order', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const first = store.handle({ method: 'saveMessage', conversationId: id, text: 'First legacy source.' }).snapshot.messages.at(-1)!;
    const second = store.handle({ method: 'saveMessage', conversationId: id, text: 'Second legacy source.' }).snapshot.messages.at(-1)!;
    const db = (store.learningRepository as unknown as { db: { query: Function } }).db;
    const firstRowid = db.query('SELECT rowid FROM messages WHERE id = ?').get(first.id).rowid as number;
    const secondRowid = db.query('SELECT rowid FROM messages WHERE id = ?').get(second.id).rowid as number;
    const runId = crypto.randomUUID();
    db.query("INSERT INTO learning_runs (id, operationKey, status, cursorStart, cursorEnd, attempt, provider, model, createdAt, completedAt, error) VALUES (?, ?, 'failed', 0, ?, 115, 'deepseek', 'deepseek-flash', 1000, 1000, 'interrupted')").run(runId, `0:${firstRowid}`, firstRowid);
    const fake = fakeClock();
    const due: string[] = [];
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: (run) => due.push(run.id) }, fake.clock);
    expect(fake.scheduled).toBeUndefined();
    const retried = coordinator.retry(runId);
    expect(retried).toMatchObject({ status: 'pending', attempt: 116, sourceManifest: 'recaptured' });
    expect(fake.scheduled?.delay).toBe(LEARNING_DISPATCH_TIMEOUT_MS);
    expect(due).toEqual([runId]);
    const seen: string[] = [];
    const result = await coordinator.run(async (sources) => { seen.push(...sources.map((source) => source.id)); return []; }, undefined, runId);
    expect(seen).toEqual([first.id, second.id]);
    expect(result?.status).toBe('complete');
    expect(store.learningRepository.getRun(runId)?.cursorEnd).toBe(secondRowid);
    coordinator.close();
  } finally { store.close(); }
});

test('exhausted automatic failures settle without a zero-delay retry loop', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    store.handle({ method: 'saveMessage', conversationId: id, text: 'Exhausted source.' });
    const fake = fakeClock();
    const due: string[] = [];
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: (run) => due.push(run.id) }, fake.clock);
    for (let count = 0; count < LEARNING_MAX_AUTOMATIC_ATTEMPTS; count++) {
      expect(await coordinator.run(async () => { throw new Error(`failure ${count + 1}`); })).toBeNull();
    }
    expect(store.learningRepository.listRuns().runs[0]).toMatchObject({ status: 'failed', attempt: LEARNING_MAX_AUTOMATIC_ATTEMPTS, error: `failure ${LEARNING_MAX_AUTOMATIC_ATTEMPTS}` });
    expect(fake.scheduled).toBeUndefined();
    coordinator.onActivity();
    expect(fake.scheduled).toBeUndefined();
    expect(due).toHaveLength(0);
    coordinator.close();
  } finally { store.close(); }
});

test('a pending dispatch without a runtime response fails and settles on the cooldown', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    store.handle({ method: 'saveMessage', conversationId: id, text: 'Unanswered dispatch.' });
    const fake = fakeClock();
    const due: string[] = [];
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: (run) => due.push(run.id) }, fake.clock);
    coordinator.onActivity();
    expect(fake.scheduled?.delay).toBe(LEARNING_IDLE_MS);
    fake.advance(LEARNING_IDLE_MS);
    fake.scheduled!.callback();
    await Promise.resolve();
    expect(due).toHaveLength(1);
    expect(fake.scheduled?.delay).toBe(LEARNING_DISPATCH_TIMEOUT_MS);
    fake.scheduled!.callback();
    await Promise.resolve();
    const run = store.learningRepository.getRun(due[0])!;
    expect(run.status).toBe('failed');
    expect(run.error).toContain('dispatch timed out');
    expect(fake.scheduled?.delay).toBeGreaterThan(0);
    expect(due).toHaveLength(1);
    coordinator.close();
  } finally { store.close(); }
});

test('a pre-aborted review never invokes the reviewer', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    store.handle({ method: 'saveMessage', conversationId: id, text: 'Aborted source.' });
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fakeClock().clock);
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const result = await coordinator.run(async () => { called = true; return []; }, controller.signal);
    expect(called).toBe(false);
    expect(result).toBeNull();
    expect(store.learningRepository.listRuns().runs[0]).toMatchObject({ status: 'cancelled' });
    expect(store.memoryRepository.list()).toHaveLength(0);
    coordinator.close();
  } finally { store.close(); }
});

test('retry reads the captured manifest excerpts in chronological order within the total budget', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const first = store.handle({ method: 'saveMessage', conversationId: id, text: 'a'.repeat(8000) }).snapshot.messages.at(-1)!;
    const second = store.handle({ method: 'saveMessage', conversationId: id, text: 'b'.repeat(5000) }).snapshot.messages.at(-1)!;
    const started = store.learningRepository.beginRun(1000)!;
    store.learningRepository.failRun(started.run.id, new Error('temporary failure'), false, 2000);
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fakeClock().clock);
    const retried = store.learningRepository.retryRun(started.run.id, 3000);
    expect(retried).toMatchObject({ status: 'pending', sourceManifest: 'captured' });
    let seen: Array<{ id: string; length: number }> = [];
    await coordinator.run(async (sources) => { seen = sources.map((source) => ({ id: source.id, length: source.text.length })); return []; }, undefined, started.run.id);
    expect(seen).toEqual([{ id: first.id, length: 8000 }, { id: second.id, length: 4000 }]);
    expect(seen.reduce((total, item) => total + item.length, 0)).toBe(12000);
    coordinator.close();
  } finally { store.close(); }
});

test('later messages do not orphan an explicit retry of a failed run', async () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    const first = store.handle({ method: 'saveMessage', conversationId: id, text: 'Retry first.' }).snapshot.messages.at(-1)!;
    const second = store.handle({ method: 'saveMessage', conversationId: id, text: 'Retry second.' }).snapshot.messages.at(-1)!;
    const coordinator = new LearningCoordinator(store.learningRepository, { learningDue: () => {} }, fakeClock().clock);
    await coordinator.run(async () => { throw new Error('temporary failure'); });
    const failed = store.learningRepository.listRuns().runs[0];
    const later = store.handle({ method: 'saveMessage', conversationId: id, text: 'Later message.' }).snapshot.messages.at(-1)!;
    expect(store.learningRepository.retryRun(failed.id, 2000)).toMatchObject({ status: 'pending', sourceManifest: 'captured' });
    const seen: string[] = [];
    const result = await coordinator.run(async (sources) => { seen.push(...sources.map((source) => source.id)); return []; }, undefined, failed.id);
    expect(seen).toEqual([first.id, second.id]);
    expect(result?.status).toBe('complete');
    expect(store.learningRepository.sourceBatch(result!.cursorEnd).map((source) => source.id)).toEqual([later.id]);
    coordinator.close();
  } finally { store.close(); }
});

test('run detail stays inside the complete serialized inspector budget', () => {
  const store = new Store(':memory:');
  try {
    const id = conversation(store);
    enable(store);
    store.handle({ method: 'saveMessage', conversationId: id, text: 'Budget source.' });
    const started = store.learningRepository.beginRun(1000)!;
    const db = (store.learningRepository as unknown as { db: { query: Function } }).db;
    const after = JSON.stringify(Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`k${index}`, 'y'.repeat(4000)])));
    for (let index = 0; index < 60; index++) {
      db.query("INSERT INTO learning_history (id, runId, operationId, action, memoryId, resourceType, resourceId, beforeJson, afterJson, afterRevision, createdAt) VALUES (?, ?, ?, 'add', ?, 'memory', ?, NULL, ?, 1, ?)")
        .run(crypto.randomUUID(), started.run.id, `budget-${index}`, crypto.randomUUID(), crypto.randomUUID(), after, 1000 + index);
    }
    const detail = store.handle({ method: 'learningRunDetail', runId: started.run.id, limit: 50 }).learningRunDetail!;
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThanOrEqual(LEARNING_RUN_DETAIL_MAX_BYTES);
    expect(detail.truncated).toBe(true);
    expect(detail.changes.length).toBeLessThan(60);
  } finally { store.close(); }
});
