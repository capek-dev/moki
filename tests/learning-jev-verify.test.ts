import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '@backend/store';
import { LearningCoordinator, type LearningProposal, type LearningSource } from '@backend/memory-learning';
import { verifyLearningSupport, type VerifyFetcher } from '@backend/learning-verify';

function typesafeResponse(nouls: Record<string, unknown>) {
  return new Response(JSON.stringify({ model: 'jev-latest', answers: nouls, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function noulAnswer(noul: number) { return { type: 'noul', noul }; }

const source: LearningSource = { rowid: 1, id: '22222222-2222-4222-8222-222222222222', conversationId: 'c', role: 'user', text: 'My name is Morgan and I am a developer.', revision: 1, createdAt: 1 };

function memoryAdd(text: string): LearningProposal {
  return { kind: 'memory', action: 'add', sourceMessageId: source.id, sourceRevision: 1, sourceRole: 'user', text, memoryKind: 'fact', topics: ['software development'] };
}

test('verifier rejects unsupported claims and keeps supported ones', async () => {
  const fetcher: VerifyFetcher = async () => typesafeResponse({ p0: noulAnswer(0.92), p1: noulAnswer(0.11) });
  const result = await verifyLearningSupport('key', [memoryAdd('The user is a developer.'), memoryAdd('The user lives in Tokyo.')], [source], new AbortController().signal, fetcher);
  expect(result.checked).toBe(2);
  expect(result.rejections.has(0)).toBe(false);
  expect(result.rejections.get(1)).toContain('not supported by the cited user message');
  expect(result.rejections.get(1)).toContain('0.11');
});

test('verifier skips text-free proposals without a request and fails open on missing or invalid answers', async () => {
  let called = 0;
  const counting: VerifyFetcher = async () => { called++; return typesafeResponse({}); };
  const confirm: LearningProposal = { kind: 'memory', action: 'confirm', sourceMessageId: source.id, sourceRevision: 1, sourceRole: 'user', memoryId: '33333333-3333-4333-8333-333333333333', expectedMemoryRevision: 1 };
  const skipped = await verifyLearningSupport('key', [confirm], [source], new AbortController().signal, counting);
  expect(skipped.checked).toBe(0);
  expect(called).toBe(0);
  // A missing answer leaves the proposal pending rather than blocking the run.
  const missing = await verifyLearningSupport('key', [memoryAdd('A fact.')], [source], new AbortController().signal, async () => typesafeResponse({}));
  expect(missing.rejections.size).toBe(0);
  // A malformed answer shape throws; the host treats that as gate-unavailable.
  await expect(verifyLearningSupport('key', [memoryAdd('A fact.')], [source], new AbortController().signal, async () => typesafeResponse({ p0: { type: 'choice', choice: 'x' } }))).rejects.toThrow('Invalid Jev verification answer');
  await expect(verifyLearningSupport('key', [memoryAdd('A fact.')], [source], new AbortController().signal, async () => typesafeResponse(null as never))).rejects.toThrow('Invalid Jev verification answers');
});

test('verifier bounds the request and propagates cancellation', async () => {
  // Proposal texts are excerpted to 2,000 chars each; a full batch must still trip the total cap.
  const many = Array.from({ length: 30 }, () => memoryAdd('x'.repeat(2_000)));
  await expect(verifyLearningSupport('key', many, [source], new AbortController().signal, async () => typesafeResponse({}))).rejects.toThrow('too large');
  const aborted = new AbortController();
  aborted.abort();
  await expect(verifyLearningSupport('key', [memoryAdd('A fact.')], [source], aborted.signal, async () => typesafeResponse({}))).rejects.toThrow();
});

test('learning run persists Jev rejections as terminal and applies only supported proposals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-learning-verify-'));
  const store = new Store(join(dir, 'memory.sqlite'));
  try {
    store.handle({ method: 'memorySetEnabled', enabled: true, expectedRevision: 1 });
    store.handle({ method: 'learningSetEnabled', enabled: true, expectedRevision: 1 });
    const conversationId = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
    store.handle({ method: 'saveMessage', conversationId, text: 'My name is Morgan and I am a developer.' });
    const learning = new LearningCoordinator(store.learningRepository, { learningDue: () => {}, stateChanged: () => {} });
    const run = await learning.run(async (sources) => {
      const proposals: LearningProposal[] = [
        { kind: 'memory', action: 'add', sourceMessageId: sources[0].id, sourceRevision: sources[0].revision!, sourceRole: 'user', text: 'The user is a developer.', memoryKind: 'fact', topics: ['software development'] },
        { kind: 'memory', action: 'add', sourceMessageId: sources[0].id, sourceRevision: sources[0].revision!, sourceRole: 'user', text: 'The user lives in Tokyo.', memoryKind: 'fact', topics: ['personal identity'] },
      ];
      return { proposals, rejections: new Map([[1, 'Jev source check: claim not supported by the cited user message (confidence 0.11).']]) };
    });
    expect(run?.status).toBe('complete');
    expect(run?.appliedCount).toBe(1);
    expect(run?.rejectedCount).toBe(1);
    const detail = store.handle({ method: 'learningRunDetail', runId: run!.id, limit: 50 }).learningRunDetail!;
    expect(JSON.stringify(detail.proposals.find((item) => item.status === 'applied'))).toContain('The user is a developer.');
    expect(detail.proposals.find((item) => item.status === 'rejected')).toMatchObject({ rejection: 'Jev source check: claim not supported by the cited user message (confidence 0.11).' });
    const memories = store.handle({ method: 'memoryList', limit: 50, offset: 0 }).memoryPage!.memories.map((item) => item.text);
    expect(memories.some((text) => text.includes('developer'))).toBe(true);
    expect(memories.some((text) => text.includes('Tokyo'))).toBe(false);
    learning.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
