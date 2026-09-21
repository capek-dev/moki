import { expect, test } from 'bun:test';
import { createGenerate, codexFetch } from '@backend/model-stream';
import { describeError, normalizeError } from '@backend/error-description';
import type { Turn } from '@backend/chat';
import { createImageAccounting, type ContextUpdate } from '@shared/context';

const turn: Turn = { conversationId: 'conversation', model: 'gpt-5.6-sol', provider: 'codex', instructions: 'Be kind.', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: '<moki_turn_context>\nCurrent date/time: 2025-01-02T03:04:05; timezone: UTC; UTC: 2025-01-02T03:04:05.000Z.\n</moki_turn_context>\n\n<moki_user_message>\nAgain\n</moki_user_message>' }], credentials: { provider: 'codex', access: 'secret-access', accountId: 'account' } };

test('unknown provider errors retain useful fields when normalized', () => {
  const normalized = normalizeError({ name: 'APIError', message: 'Rate limit exceeded', statusCode: 429, cause: 'upstream busy' });
  expect(normalized).toBeInstanceOf(Error);
  expect(normalized.message).toBe('APIError · Rate limit exceeded · status 429 · cause: upstream busy');
  expect(describeError('plain provider failure')).toBe('plain provider failure');
});
test('published DeepSeek adapter serializes history and streams in an isolated process', async () => {
  const child = Bun.spawn([process.execPath, 'run', 'tests/fixtures/deepseek-stream.ts'], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toContain('deepseek stream verified');
  } finally { clearTimeout(timer); }
}, 15000);
test('DeepSeek Flash serializes screenshot bytes as image input', async () => {
  const child = Bun.spawn([process.execPath, 'run', 'tests/fixtures/deepseek-image-stream.ts'], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toContain('deepseek image verified');
  } finally { clearTimeout(timer); }
}, 15000);

const sse = (events: unknown[]) => events.map((data) => `data: ${JSON.stringify(data)}\n\n`).join('');
for (const thinking of [null, 'low', 'medium', 'high', 'xhigh', 'max'] as const) test(`Codex payload and stream with thinking ${thinking ?? 'default'}`, async () => {
  const model = thinking === 'max' ? 'gpt-6-astra' : 'gpt-5.6-sol';
  let calls = 0;
  const generate = createGenerate((async (url: string, init: RequestInit) => {
    calls++;
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer secret-access');
    expect(headers.get('ChatGPT-Account-Id')).toBe('account');
    expect(init.redirect).toBe('error');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model, stream: true, store: false });
    expect(body.instructions).toBe('Be kind.');
    expect(body.input.at(-1).content[0].text).toContain('Current date/time: 2025-01-02T03:04:05; timezone: UTC; UTC: 2025-01-02T03:04:05.000Z.');
    if (thinking) expect(body.reasoning).toEqual({ effort: thinking });
    else expect(body.reasoning).toBeUndefined();
    expect(body.input.map((item: { role: string }) => item.role)).toEqual(['user', 'assistant', 'user']);
    for (const key of ['temperature', 'max_output_tokens', 'tools']) expect(body[key]).toBeUndefined();
    return new Response(sse([
      { type: 'response.created', response: { id: 'resp_1', created_at: 1, model } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hello again' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Hello again', annotations: [] }] } },
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', incomplete_details: null, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    ]), { headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof fetch);
  let output = '';
  for await (const text of generate({ ...turn, model, thinking }, new AbortController().signal)) output += text;
  expect(output).toBe('Hello again');
  expect(calls).toBe(1);
});
test('Codex Responses serializes screenshot bytes as input_image', async () => {
  let body: any;
  const generate = createGenerate((async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(sse([
      { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: 'gpt-5.6-sol' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
      { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Seen' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Seen', annotations: [] }] } },
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', incomplete_details: null, usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
    ]), { headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof fetch);
  const imageTurn: Turn = { ...turn, messages: [{ role: 'user', content: [{ type: 'text', text: 'Read this' }, { type: 'image', image: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }] }] };
  for await (const _ of generate(imageTurn, new AbortController().signal)) {}
  expect(body.input[0].content.map((part: { type: string }) => part.type)).toEqual(['input_text', 'input_image']);
  expect(body.input[0].content[1].image_url).toMatch(/^data:image\/png;base64,/);
});
test('provider cache token usage is exposed through context updates', async () => {
  const updates: ContextUpdate[] = [];
  const generate = createGenerate((async () => new Response(sse([
    { type: 'response.created', response: { id: 'resp_cache', created_at: 1, model: 'gpt-5.6-sol' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_cache', role: 'assistant', content: [] } },
    { type: 'response.content_part.added', item_id: 'msg_cache', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_cache', output_index: 0, content_index: 0, delta: 'Cached' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_cache', role: 'assistant', content: [{ type: 'output_text', text: 'Cached', annotations: [] }] } },
    { type: 'response.completed', response: { id: 'resp_cache', status: 'completed', incomplete_details: null, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 7 }, output_tokens: 1, total_tokens: 11 } } },
  ]), { headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch);
  const cachedTurn: Turn = {
    ...turn,
    context: {
      turn: { conversationId: 'conversation', messageId: 'message', turnId: 'turn' },
      imageAccounting: createImageAccounting(0, 0),
      onUpdate: (update) => updates.push(update),
    },
  };
  for await (const _ of generate(cachedTurn, new AbortController().signal)) {}
  const provider = updates.find((update) => update.type === 'provider');
  expect(provider).toMatchObject({ type: 'provider', inputTokens: 10, cacheReadInputTokens: 7, outputTokens: 1, totalTokens: 11 });
});

test('Codex endpoint guard prevents credentials reaching other origins and does not retry 401', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response('{"error":{"message":"unauthorized"}}', { status: 401, headers: { 'Content-Type': 'application/json' } }); }) as unknown as typeof fetch;
  await expect(codexFetch('token', 'account', fetcher)('https://evil.example/v1/responses')).rejects.toThrow('Unexpected');
  expect(calls).toBe(0);
  const generate = createGenerate(fetcher);
  await expect((async () => { for await (const _ of generate(turn, new AbortController().signal)) {} })()).rejects.toThrow();
  expect(calls).toBe(1);
});
