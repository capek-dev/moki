import { expect, test } from 'bun:test';
import { createGenerate } from '@backend/model-stream';
import type { Turn } from '@backend/chat';
import { estimateContextUsage } from '@shared/context';

const sse = (events: unknown[]) => events.map((data) => `data: ${JSON.stringify(data)}\n\n`).join('');
const response = (events: unknown[]) => new Response(sse(events), { headers: { 'Content-Type': 'text/event-stream' } });
const fixedTurn: Turn = {
  conversationId: 'clock-test',
  model: 'gpt-5.6-sol',
  provider: 'codex',
  instructions: 'Never change this saved instruction.',
  messages: [{ role: 'user', content: 'What time is it?' }],
  credentials: { provider: 'codex', access: 'test-access', accountId: 'test-account' },
};

function clockSequence() {
  let now = new Date('2025-01-02T03:04:05.000Z');
  return {
    clock: { now: () => now, timeZone: () => 'America/Los_Angeles' },
    advance() { now = new Date('2025-01-02T04:05:06.000Z'); },
  };
}

const codexTextEvents = (model = 'gpt-5.6-sol') => [
  { type: 'response.created', response: { id: 'resp_1', created_at: 1, model } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
  { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Done' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Done', annotations: [] }] } },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed', incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
];

test('request-boundary clock context is fresh for Codex with external tools disabled', async () => {
  const { clock } = clockSequence();
  let body: any;
  const generate = createGenerate((async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return response(codexTextEvents());
  }) as unknown as typeof fetch, clock);
  for await (const _ of generate(fixedTurn, new AbortController().signal)) {}
  expect(body.tools).toBeUndefined();
  expect(body.instructions).toContain('Never change this saved instruction.');
  expect(body.instructions).toContain('Current date/time: 2025-01-01T19:04:05; timezone: America/Los_Angeles; UTC: 2025-01-02T03:04:05.000Z.');
  expect(fixedTurn.instructions).toBe('Never change this saved instruction.');
});

test('clock context refreshes after a tool step before the next provider request', async () => {
  const { clock, advance } = clockSequence();
  const instructions: string[] = [];
  let calls = 0;
  const turn: Turn = {
    ...fixedTurn,
    tools: [{ name: 'probe', description: 'Probe the clock.', inputSchema: { type: 'object' }, execute: async () => { advance(); return 'probe complete'; } }],
  };
  const generate = createGenerate((async (_url: string, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    instructions.push(body.instructions);
    if (calls === 1) return response([
      { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: turn.model } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{}' } },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: '{}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'probe', arguments: '{}', status: 'completed' } },
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]);
    return response(codexTextEvents());
  }) as unknown as typeof fetch, clock);
  let output = '';
  for await (const delta of generate(turn, new AbortController().signal)) output += delta;
  expect(output).toBe('Done');
  expect(calls).toBe(2);
  expect(instructions[0]).toContain('UTC: 2025-01-02T03:04:05.000Z.');
  expect(instructions[1]).toContain('UTC: 2025-01-02T04:05:06.000Z.');
  expect(instructions[1]).not.toContain('UTC: 2025-01-02T03:04:05.000Z.');
  expect(turn.instructions).toBe('Never change this saved instruction.');
});

test('context estimate counts injected clock text with system instructions', () => {
  const base = estimateContextUsage([], [], 'Saved instructions');
  const withClock = estimateContextUsage([], [], 'Saved instructions', 'Current date/time: 2025-01-02T03:04:05; timezone: UTC; UTC: 2025-01-02T03:04:05.000Z.');
  expect(withClock.systemTokens).toBeGreaterThan(base.systemTokens);
});
