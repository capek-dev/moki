// Dedicated process: this fetch replacement cannot affect other tests.
import assert from 'node:assert/strict';
let calls = 0;
let thinking: 'high' | 'max' | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls++;
  assert.equal(String(input), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer offline-test');
  const body = JSON.parse(String(init?.body));
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.stream, true);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'Be kind.');
  assert.equal(body.messages[2].reasoning_content, '');
  assert.equal(body.tools, undefined);
  if (thinking) {
    assert.equal(body.reasoning_effort, thinking);
    assert.deepEqual(body.thinking, { type: 'adaptive' });
  } else {
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.thinking, undefined);
  }
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] });
  return new Response([chunk({ role: 'assistant', content: 'Hello' }), chunk({}, 'stop')].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}) as typeof fetch;
const { generate } = await import('../../src/backend/model-stream');
for (const level of [null, 'high', 'max'] as const) {
thinking = level;
let output = '';
for await (const delta of generate({ thinking, conversationId: 'c', model: 'deepseek-flash', provider: 'deepseek', instructions: 'Be kind.', credentials: { provider: 'deepseek', key: 'offline-test' }, messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Again' }] }, new AbortController().signal)) output += delta;
assert.equal(output, 'Hello');
}
assert.equal(calls, 3);
console.log('deepseek stream verified');
