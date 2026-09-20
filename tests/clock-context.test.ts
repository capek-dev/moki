import { expect, test } from 'bun:test';
import { createGenerate } from '@backend/model-stream';
import type { Turn } from '@backend/chat';
import { estimateModelContext } from '@shared/context';

const sse = (events: unknown[]) => events.map((data) => `data: ${JSON.stringify(data)}\n\n`).join('');
const response = (events: unknown[]) => new Response(sse(events), { headers: { 'Content-Type': 'text/event-stream' } });
const frozenClockContext = 'Current date/time: 2025-01-01T19:04:05; timezone: America/Los_Angeles; UTC: 2025-01-02T03:04:05.000Z.';
const enrichedUserText = `<moki_turn_context>\n${frozenClockContext}\n</moki_turn_context>\n\n<moki_user_message>\nWhat time is it?\n</moki_user_message>`;
const fixedTurn: Turn = {
  conversationId: 'clock-test',
  model: 'gpt-5.6-sol',
  provider: 'codex',
  instructions: 'Never change this saved instruction.',
  messages: [{ role: 'user', content: enrichedUserText }],
  credentials: { provider: 'codex', access: 'test-access', accountId: 'test-account' },
};

const codexTextEvents = (model = 'gpt-5.6-sol') => [
  { type: 'response.created', response: { id: 'resp_1', created_at: 1, model } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
  { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Done' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Done', annotations: [] }] } },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed', incomplete_details: null, usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, total_tokens: 2 } } },
];

test('clock context is carried by the latest user message while provider instructions stay stable', async () => {
  let body: any;
  const generate = createGenerate((async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return response(codexTextEvents());
  }) as unknown as typeof fetch);
  for await (const _ of generate(fixedTurn, new AbortController().signal)) {}
  expect(body.tools).toBeUndefined();
  expect(body.instructions).toBe('Never change this saved instruction.');
  expect(body.input[0].content[0].text).toContain(frozenClockContext);
  expect(fixedTurn.instructions).toBe('Never change this saved instruction.');
});

test('clock context and instructions remain byte-stable after a tool step', async () => {
  const requestBodies: any[] = [];
  let calls = 0;
  const turn: Turn = {
    ...fixedTurn,
    tools: [{ name: 'probe', description: 'Probe the clock.', inputSchema: { type: 'object' }, execute: async () => 'probe complete' }],
  };
  const generate = createGenerate((async (_url: string, init: RequestInit) => {
    calls++;
    requestBodies.push(JSON.parse(String(init?.body)));
    if (calls === 1) return response([
      { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: turn.model } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{}' } },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: '{}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{}', status: 'completed' } },
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]);
    return response(codexTextEvents());
  }) as unknown as typeof fetch);
  let output = '';
  for await (const delta of generate(turn, new AbortController().signal)) output += delta;
  expect(output).toBe('Done');
  expect(calls).toBe(2);
  expect(requestBodies[0].instructions).toBe(requestBodies[1].instructions);
  expect(requestBodies[0].input[0]).toEqual(requestBodies[1].input[0]);
  expect(requestBodies[1].input[0].content[0].text).toContain(frozenClockContext);
});

test('context estimate counts clock text in the model-facing user message', () => {
  const base = estimateModelContext([{ role: 'user', content: 'What time is it?' }], 'Saved instructions');
  const withClock = estimateModelContext([{ role: 'user', content: enrichedUserText }], 'Saved instructions');
  expect(withClock.systemTokens).toBe(base.systemTokens);
  expect(withClock.textTokens).toBeGreaterThan(base.textTokens);
});
