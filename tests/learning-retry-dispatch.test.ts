import { expect, test } from 'bun:test';
import { Store } from '@backend/storage/store';
import { LearningCoordinator, LEARNING_COOLDOWN_MS } from '@backend/learning/learning';

function fixture() {
  const store = new Store(':memory:');
  store.handle({ method: 'memorySetEnabled', enabled: true, expectedRevision: 1 });
  const repo = store.learningRepository;
  repo.setEnabled(true, 1, 1000);
  const conversationId = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
  const add = () => store.handle({ method: 'saveMessage', conversationId, text: 'I prefer quiet places.' });
  let now = 1000;
  let timer: { callback: () => void; delay: number } | undefined;
  const due: string[] = [];
  const coordinator = new LearningCoordinator(repo, { learningDue: run => due.push(run.id) }, {
    now: () => now,
    timer: { setTimeout: (callback, delay) => { timer = { callback, delay }; return 1 as any; }, clearTimeout: () => { timer = undefined; } },
  });
  return { store, repo, coordinator, due, add, tick() { const pending = timer!; now += pending.delay; timer = undefined; pending.callback(); }, get delay() { return timer?.delay; } };
}

test('explicit historical retry dispatches after reactivation moves cursor past all sources', async () => {
  const f = fixture();
  try {
    f.add();
    const old = f.repo.beginRun(1000)!;
    f.repo.failRun(old.run.id, new Error('failed'), false, 1000);
    f.add();
    f.repo.setEnabled(false, f.repo.settings().revision, 2000);
    f.repo.setEnabled(true, f.repo.settings().revision, 2001);
    expect(f.repo.schedulableBatch()).toBeNull();
    f.coordinator.retry(old.run.id);
    f.coordinator.retry(old.run.id);
    expect(f.due).toEqual([old.run.id]);
    const result = await f.coordinator.run(async () => [], undefined, old.run.id);
    expect(result?.status).toBe('complete');
    expect(f.repo.schedulableBatch()).toBeNull(); // Old run must not rewind cursor.
  } finally { f.coordinator.close(); f.store.close(); }
});

test('failed run dispatches a second attempt when cooldown timer actually fires', async () => {
  const f = fixture();
  try {
    f.add();
    await f.coordinator.run(async () => { throw new Error('temporary failure'); });
    expect(f.delay).toBe(LEARNING_COOLDOWN_MS);
    f.tick();
    expect(f.due).toHaveLength(1);
    expect(f.repo.getRun(f.due[0])?.attempt).toBe(2);
    expect(f.repo.getRun(f.due[0])?.status).toBe('pending');
  } finally { f.coordinator.close(); f.store.close(); }
});
