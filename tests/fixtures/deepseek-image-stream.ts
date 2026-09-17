// Dedicated process: this fetch replacement cannot affect other tests.
import assert from 'node:assert/strict';
let calls = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls++;
  assert.equal(String(input), 'https://api.deepseek.com/v1/chat/completions');
  const body = JSON.parse(String(init?.body));
  assert.equal(body.model, 'deepseek-flash');
  const user = body.messages.find((message: { role: string }) => message.role === 'user');
  assert.deepEqual(user.content.map((part: { type: string }) => part.type), ['text', 'image_url']);
  assert.equal(user.content[0].text, 'Read this');
  assert.match(user.content[1].image_url.url, /^data:image\/png;base64,/);
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] });
  return new Response([chunk({ role: 'assistant', content: 'Seen' }), chunk({}, 'stop')].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}) as typeof fetch;
const { generate } = await import('@backend/model-stream');
let output = '';
for await (const delta of generate({ conversationId: 'c', model: 'deepseek-flash', provider: 'deepseek', instructions: 'Be kind.', credentials: { provider: 'deepseek', key: 'offline-test' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'Read this' }, { type: 'image', image: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }] }] }, new AbortController().signal)) output += delta;
assert.equal(output, 'Seen');
assert.equal(calls, 1);
console.log('deepseek image verified');
