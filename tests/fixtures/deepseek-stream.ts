// Dedicated process: this fetch replacement cannot affect other tests.
import assert from 'node:assert/strict';
let calls = 0;
let thinking: 'high' | 'max' | null = null;
let loopCalls = 0;
const turnContext = '<moki_turn_context>\nCurrent date/time: 2025-01-02T03:04:05; timezone: UTC; UTC: 2025-01-02T03:04:05.000Z.\n</moki_turn_context>';
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls++;
  assert.equal(String(input), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer offline-test');
  const body = JSON.parse(String(init?.body));
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.stream, true);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'Be kind.');
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] });
  if (body.tools) {
    loopCalls++;
    if (loopCalls === 1) return new Response([
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'probe', arguments: '{}' } }] }),
      chunk({}, 'tool_calls'),
    ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    return new Response([chunk({ role: 'assistant', content: 'Loop done' }), chunk({}, 'stop')].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  }
  assert.equal(body.tools, undefined);
  if (thinking) {
    assert.equal(body.reasoning_effort, thinking);
    assert.deepEqual(body.thinking, { type: 'adaptive' });
  } else {
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.thinking, undefined);
  }
  return new Response([chunk({ role: 'assistant', content: 'Hello' }), chunk({}, 'stop')].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}) as typeof fetch;
const { createGenerate } = await import('@backend/model-stream');
const generate = createGenerate(fetch);
for (const level of [null, 'high', 'max'] as const) {
  thinking = level;
  let output = '';
  for await (const delta of generate({ thinking, conversationId: 'c', model: 'deepseek-flash', provider: 'deepseek', instructions: 'Be kind.', credentials: { provider: 'deepseek', key: 'offline-test' }, messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: `${turnContext}\n\nAgain` }] }, new AbortController().signal)) output += delta;
  assert.equal(output, 'Hello');
}
let loopOutput = '';
for await (const delta of generate({ conversationId: 'clock-loop', model: 'deepseek-flash', provider: 'deepseek', instructions: 'Be kind.', credentials: { provider: 'deepseek', key: 'offline-test' }, messages: [{ role: 'user', content: `${turnContext}\n\nCheck the clock after the tool.` }], tools: [{ name: 'probe', description: 'Probe the clock.', inputSchema: { type: 'object' }, execute: async () => 'complete' }] }, new AbortController().signal)) loopOutput += delta;
assert.equal(loopOutput, 'Loop done');
assert.equal(loopCalls, 2);
assert.equal(calls, 5);
console.log('deepseek stream verified');
