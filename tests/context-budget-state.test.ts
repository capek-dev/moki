import { expect, test } from 'bun:test';
import { applyResult, type ChatState } from '@renderer/lib/chat-state';
import { estimateModelContext, type ContextUsage } from '@shared/context';
import type { Result, Snapshot } from '@shared/protocol';

const snapshot: Snapshot = {
  assistants: [],
  conversations: [],
  messages: [{ id: 'message-1', conversationId: 'conversation', text: 'Hello', role: 'user', status: 'complete', model: null, assistantName: null, error: null, thinking: null }],
  attachments: [],
};
function usage(turnId: string, messageId = 'message-1', inputTokens = 11): ContextUsage {
  return {
    turn: { conversationId: 'conversation', messageId, turnId },
    model: 'gpt-5.6-sol',
    contextWindowTokens: 372000,
    outputReserveTokens: 128000,
    requestNumber: 1,
    estimate: estimateModelContext([{ role: 'user', content: 'Hello' }], 'Instructions.'),
    estimateSource: 'heuristic',
    providerReported: { inputTokens, outputTokens: 2, totalTokens: inputTokens + 2, source: 'ai-sdk-provider-usage', billingExact: false },
  };
}
function result(revision: number, extra: Partial<Result> = {}): Result {
  return { snapshot, conversationId: 'conversation', revision, ...extra };
}

test('context usage follows the active turn and ignores stale session revisions', () => {
  let state: ChatState = { revision: 0, histories: {} };
  state = applyResult(state, result(1, { contextTurn: { conversationId: 'conversation', messageId: 'message-1', turnId: 'turn-1' } }));
  state = applyResult(state, result(2, { contextUsage: usage('turn-1') }));
  expect(state.contextUsage?.conversation?.turn.turnId).toBe('turn-1');
  expect(state.contextUsage?.conversation?.providerReported?.inputTokens).toBe(11);
  state = applyResult(state, result(3, { contextTurn: { conversationId: 'conversation', messageId: 'message-2', turnId: 'turn-2' } }));
  expect(state.contextUsage?.conversation).toBeUndefined();
  state = applyResult(state, result(4, { contextUsage: usage('old-turn', 'message-1', 999) }));
  expect(state.contextUsage?.conversation).toBeUndefined();
  state = applyResult(state, result(5, { contextUsage: usage('turn-1') }));
  expect(state.contextUsage?.conversation).toBeUndefined();
});
