import { expect, test } from 'bun:test';
import { observeLearningReview } from '@backend/learning/review-stream';
import { LearningReviewCache } from '@electron/learning-review-cache';
import type { Turn } from '@backend/core/chat';
import { Store } from '@backend/storage/store';

test('memory forgetting invalidates ephemeral review output', () => {
  const store = new Store(':memory:');
  try {
    let invalidated = 0;
    store.onReviewInvalidated = () => { invalidated++; };
    const memory = store.memoryRepository.create({ text: 'temporary fact', kind: 'fact' });
    store.memoryRepository.forgetFromSettings(memory.id, memory.revision);
    expect(invalidated).toBe(1);
  } finally { store.close(); }
});

const turn = {} as Turn;
test('review stream preserves output, throttles events, and flushes bounded final text', async () => {
  const updates: string[] = [];
  const observe = observeLearningReview(async function* () { yield 'a'; yield 'b'; yield 'c'.repeat(65000); }, text => updates.push(text), () => 0);
  let result = '';
  for await (const chunk of observe(turn, new AbortController().signal)) result += chunk;
  expect(result.length).toBe(65002);
  expect(updates.map(text => text.length)).toEqual([0, 1, 64000]);
});
test('aborted stream cannot publish late output', async () => {
  const abort = new AbortController();
  const updates: string[] = [];
  const observe = observeLearningReview(async function* () { yield 'first'; abort.abort(); yield 'late'; }, text => updates.push(text));
  await expect((async () => { for await (const _ of observe(turn, abort.signal)) {} })()).rejects.toThrow();
  expect(updates).toEqual(['', 'first']);
});
test('ephemeral cache is bounded and forgetting blocks active stream refill', () => {
  const cache = new LearningReviewCache();
  for (let i = 0; i < 9; i++) cache.receive({ runId: String(i), text: 'x'.repeat(65000) });
  expect(cache.get('0')).toBeUndefined();
  expect(cache.get('8')?.text.length).toBe(64000);
  cache.forget(['8']);
  expect(cache.get('8')).toBeUndefined();
  expect(cache.receive({ runId: '8', text: 'late' })).toBeUndefined();
  cache.finish('8');
  expect(cache.receive({ runId: '8', text: 'new attempt' })?.text).toBe('new attempt');
});
