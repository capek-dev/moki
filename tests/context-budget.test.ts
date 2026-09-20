import { expect, test } from 'bun:test';
import { createGenerate } from '@backend/model-stream';
import type { Turn } from '@backend/chat';
import { createImageAccounting, estimateModelContext, ContextBudgetError } from '@shared/context';

const sse = (events: unknown[]) => events.map((data) => `data: ${JSON.stringify(data)}\n\n`).join('');
const response = (events: unknown[]) => new Response(sse(events), { headers: { 'Content-Type': 'text/event-stream' } });
const done = (model = 'gpt-5.6-sol') => response([
  { type: 'response.created', response: { id: 'resp_done', created_at: 1, model } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_done', role: 'assistant', content: [] } },
  { type: 'response.content_part.added', item_id: 'msg_done', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
  { type: 'response.output_text.delta', item_id: 'msg_done', output_index: 0, content_index: 0, delta: 'Done' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_done', role: 'assistant', content: [{ type: 'output_text', text: 'Done', annotations: [] }] } },
  { type: 'response.completed', response: { id: 'resp_done', status: 'completed', incomplete_details: null, usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 } } },
]);

function codexTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    conversationId: 'context-budget',
    model: 'gpt-5.6-sol',
    provider: 'codex',
    instructions: 'Base instructions.',
    messages: [{ role: 'user', content: 'Hello' }],
    credentials: { provider: 'codex', access: 'access', accountId: 'account' },
    ...overrides,
  };
}

test('actual context accounting includes composed instructions, selected builtin and external schemas, history, and image reserve', () => {
  const tools = [
    { name: 'session_search', description: 'Search local history.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'mcp__send', description: 'Send a message.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  ];
  const estimate = estimateModelContext(
    [{ role: 'user', content: [{ type: 'text', text: 'Current request' }, { type: 'image', image: new Uint8Array([1]), mediaType: 'image/png' }] }, { role: 'tool', content: [{ type: 'tool-result', toolName: 'mcp__send', toolCallId: 'call', output: 'large tool output' }] }] as any,
    'Base instructions.\n\nHistorical memory record.\n\nCurrent date/time: 2025-01-02T03:04:05; timezone: UTC; UTC: 2025-01-02T03:04:05.000Z.',
    tools,
    createImageAccounting(1, 3200, 4000),
  );
  expect(estimate.toolTokens).toBeGreaterThan(0);
  expect(estimate.systemTokens).toBeGreaterThan(20);
  expect(estimate.imageTokens).toBe(3200);
  expect(estimate.toolLoopTokens).toBeGreaterThan(0);
  expect(estimate.totalTokens).toBe(estimate.systemTokens + estimate.toolTokens + estimate.textTokens + estimate.imageTokens);
});

test('known images use their measured estimate and later unknown images use the conservative fallback', () => {
  const one = [{ role: 'user', content: [{ type: 'image', image: new Uint8Array([1]), mediaType: 'image/png' }] }] as any;
  const two = [{ role: 'user', content: [{ type: 'image', image: new Uint8Array([1]), mediaType: 'image/png' }, { type: 'image', image: new Uint8Array([2]), mediaType: 'image/png' }] }] as any;
  expect(estimateModelContext(one, '', [], createImageAccounting(1, 900, 4000)).imageTokens).toBe(900);
  expect(estimateModelContext(two, '', [], createImageAccounting(1, 900, 4000)).imageTokens).toBe(4900);
});

test('invalid image estimates and unsupported file content fail closed', () => {
  expect(() => createImageAccounting(1, Number.NaN)).toThrow('known image estimate');
  expect(() => createImageAccounting(1, 10, -1)).toThrow('fallback image estimate');
  const file = [{ role: 'user', content: [{ type: 'file', data: 'not measured', mediaType: 'application/pdf' }] }] as any;
  expect(() => estimateModelContext(file, '', [], createImageAccounting(0, 0))).toThrow('Unsupported file content');
});

test('over-budget initial request fails before provider invocation and exposes the verified reserve', async () => {
  let calls = 0;
  const generate = createGenerate((async () => { calls++; return done(); }) as unknown as typeof fetch);
  const turn = codexTurn({ instructions: 'x'.repeat(980_000) });
  await expect((async () => { for await (const _ of generate(turn, new AbortController().signal)) {} })()).rejects.toBeInstanceOf(ContextBudgetError);
  expect(calls).toBe(0);
});

test('unknown model fails closed before provider invocation', async () => {
  let calls = 0;
  const generate = createGenerate((async () => { calls++; return done(); }) as unknown as typeof fetch);
  await expect((async () => { for await (const _ of generate(codexTurn({ model: 'unverified-model' }), new AbortController().signal)) {} })()).rejects.toThrow('supported model');
  expect(calls).toBe(0);
});

test('cancellation is checked before the first provider request', async () => {
  let calls = 0;
  const generate = createGenerate((async () => { calls++; return done(); }) as unknown as typeof fetch);
  const controller = new AbortController();
  controller.abort();
  await expect((async () => { for await (const _ of generate(codexTurn(), controller.signal)) {} })()).rejects.toThrow();
  expect(calls).toBe(0);
});

test('unserializable tool schemas fail closed before provider invocation', async () => {
  let calls = 0;
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const generate = createGenerate((async () => { calls++; return done(); }) as unknown as typeof fetch);
  await expect((async () => {
    for await (const _ of generate(codexTurn({ tools: [{ name: 'broken', description: 'Broken schema.', inputSchema: circular, execute: async () => '' }] }), new AbortController().signal)) {}
  })()).rejects.toThrow();
  expect(calls).toBe(0);
});

test('second-step tool output is accounted at the AI SDK request boundary', async () => {
  let calls = 0;
  const updates: number[] = [];
  const tool = {
    name: 'probe',
    description: 'Return a large result.',
    inputSchema: { type: 'object' },
    execute: async () => 'x'.repeat(1_000_000),
  };
  const generate = createGenerate((async () => {
    calls++;
    if (calls > 1) throw new Error('second request must be blocked');
    return response([
      { type: 'response.created', response: { id: 'resp_tool', created_at: 1, model: 'gpt-5.6-sol' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_tool', call_id: 'call_tool', name: 'probe', arguments: '{}' } },
      { type: 'response.function_call_arguments.done', item_id: 'fc_tool', output_index: 0, arguments: '{}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_tool', call_id: 'call_tool', name: 'probe', arguments: '{}', status: 'completed' } },
      { type: 'response.completed', response: { id: 'resp_tool', status: 'completed', incomplete_details: null, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    ]);
  }) as unknown as typeof fetch);
  const turn = codexTurn({
    tools: [tool],
    context: {
      turn: { conversationId: 'context-budget', messageId: 'message', turnId: 'turn' },
      imageAccounting: createImageAccounting(0, 0),
      onUpdate: (update) => { if (update.type === 'estimate') updates.push(update.requestNumber); },
    },
  });
  await expect((async () => { for await (const _ of generate(turn, new AbortController().signal)) {} })()).rejects.toBeInstanceOf(ContextBudgetError);
  expect(calls).toBe(1);
  expect(updates).toEqual([1, 2]);
});

test('per-step provider usage is matched to each request instead of using cumulative finish usage', async () => {
  let calls = 0;
  const updates: Array<{ type: string; requestNumber?: number; input?: number }> = [];
  const tool = { name: 'probe', description: 'Probe.', inputSchema: { type: 'object' }, execute: async () => 'tool result' };
  const generate = createGenerate((async () => {
    calls++;
    return calls === 1
      ? response([
        { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: 'gpt-5.6-sol' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{}' } },
        { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: '{}' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{}', status: 'completed' } },
        { type: 'response.completed', response: { id: 'resp_1', status: 'completed', incomplete_details: null, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
      ])
      : response([
        { type: 'response.created', response: { id: 'resp_2', created_at: 2, model: 'gpt-5.6-sol' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_2', role: 'assistant', content: [] } },
        { type: 'response.content_part.added', item_id: 'msg_2', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: 'msg_2', output_index: 0, content_index: 0, delta: 'Done' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_2', role: 'assistant', content: [{ type: 'output_text', text: 'Done', annotations: [] }] } },
        { type: 'response.completed', response: { id: 'resp_2', status: 'completed', incomplete_details: null, usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } } },
      ]);
  }) as unknown as typeof fetch);
  const turn = codexTurn({
    tools: [tool],
    context: {
      turn: { conversationId: 'context-budget', messageId: 'message', turnId: 'turn' },
      imageAccounting: createImageAccounting(0, 0),
      onUpdate: (update) => updates.push(update.type === 'estimate' ? { type: update.type, requestNumber: update.requestNumber } : { type: update.type, requestNumber: update.requestNumber, input: update.inputTokens }),
    },
  });
  let output = '';
  for await (const delta of generate(turn, new AbortController().signal)) output += delta;
  expect(output).toBe('Done');
  expect(updates.filter((update) => update.type === 'estimate').map((update) => update.requestNumber)).toEqual([1, 2]);
  expect(updates.filter((update) => update.type === 'provider')).toEqual([{ type: 'provider', requestNumber: 1, input: 10 }, { type: 'provider', requestNumber: 2, input: 20 }]);
});

test('provider-reported usage is delivered separately from the heuristic request estimate', async () => {
  const updates: Array<{ type: string; requestNumber?: number; input?: number; total?: number }> = [];
  const generate = createGenerate((async () => done()) as unknown as typeof fetch);
  const turn = codexTurn({
    context: {
      turn: { conversationId: 'context-budget', messageId: 'message', turnId: 'turn' },
      imageAccounting: createImageAccounting(0, 0),
      onUpdate: (update) => updates.push(update.type === 'estimate' ? { type: update.type, requestNumber: update.requestNumber } : { type: update.type, requestNumber: update.requestNumber, input: update.inputTokens, total: update.totalTokens }),
    },
  });
  let output = '';
  for await (const delta of generate(turn, new AbortController().signal)) output += delta;
  expect(output).toBe('Done');
  expect(updates).toEqual([{ type: 'estimate', requestNumber: 1 }, { type: 'provider', requestNumber: 1, input: 11, total: 13 }]);
});
