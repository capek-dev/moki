import { expect, test } from 'bun:test';
import { smartToolbag, fitsScoringRequest, type ScoringOptions } from '../src/backend/tool-scoring';
import type { Toolbag } from '../src/backend/cua';
import { Chat } from '../src/backend/chat';
import { Store } from '../src/backend/store';

const config = { enabled: true, maxDirect: 12, key: 'private-test-key' };
function source(count = 1): Toolbag {
  return { tools: Array.from({ length: count }, (_, i) => ({ name: `app__email_${i}`, description: 'Email '.repeat(100), inputSchema: { schemaSecretMarker: 'x'.repeat(1000) } })),
    execute: async name => ({ text: name, isError: false }), close() {} };
}
const validFetch: NonNullable<ScoringOptions['fetch']> = async (_url, init) => {
  const body = JSON.parse(init.body as string);
  return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'score', score: 1.7, probabilities: { 0: 0, 1: 0.3, 2: 0.7, 3: 0 } }])) });
};

test('all 320 tools are scored exactly once in bounded requests; pick cap and search work', async () => {
  const seen: string[] = [];
  let requests = 0; let concurrent = 0; let peak = 0; let diagnostic: any;
  const bag = await smartToolbag([source(320)], { request: 'find email', recent: '' }, config, new AbortController().signal, {
    diagnostic: data => { diagnostic = data; }, fetch: async (url, init) => {
      requests++; concurrent++; peak = Math.max(peak, concurrent);
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer private-test-key');
      const serialized = init.body as string;
      expect(fitsScoringRequest(serialized)).toBe(true);
      expect(serialized).not.toContain('schemaSecretMarker');
      const body = JSON.parse(serialized);
      seen.push(...body.state.candidates.map((candidate: { name: string }) => candidate.name));
      expect(body.state.candidates.length).toBeGreaterThan(16);

      for (const candidate of body.state.candidates) { expect(Object.keys(candidate)).toEqual(['name', 'description']); expect(candidate.description.length).toBeLessThanOrEqual(240); }
      await new Promise(resolve => setTimeout(resolve, 1)); concurrent--;
      return validFetch(url, init);
    },
  });
  expect(requests).toBe(1); expect(peak).toBeLessThanOrEqual(2);
  expect(seen).toHaveLength(320);
  expect(new Set(seen)).toEqual(new Set(source(320).tools.map(tool => tool.name)));
  expect(diagnostic.catalog).toBe(320); expect(diagnostic.candidates).toBe(320);
  expect(diagnostic.outcome).toBe('selected'); expect(diagnostic.picked).toHaveLength(12);
  expect(bag.tools).toHaveLength(14); expect(diagnostic.searchable).toBe(308);
  expect(JSON.stringify(diagnostic)).not.toContain('private-test-key');
  expect(JSON.parse((await bag.execute('search_tools', { query: '319' })).text).tools[0].name).toBe('app__email_319');
  expect((await bag.execute('call_tool', { name: 'app__email_319' })).text).toBe('app__email_319');
});

test('Jev can preload a non-keyword match beyond the old 64-tool cutoff', async () => {
  const catalog = source(70);
  catalog.tools[69] = { name: 'zzz__retrieve', description: 'Retrieve correspondence', inputSchema: { type: 'object' } };
  let diagnostic: any;
  const bag = await smartToolbag([catalog], { request: 'find email', recent: '' }, config, new AbortController().signal, {
    diagnostic: data => { diagnostic = data; },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body as string);
      return Response.json({ answers: Object.fromEntries(body.state.candidates.map((candidate: { name: string }, index: number) => {
        const selected = candidate.name === 'zzz__retrieve';
        return [`item_${index}`, { type: 'score', score: selected ? 3 : 0, probabilities: selected ? { 0: 0, 1: 0, 2: 0, 3: 1 } : { 0: 1, 1: 0, 2: 0, 3: 0 } }];
      })) });
    },
  });
  expect(diagnostic.catalog).toBe(70); expect(diagnostic.candidates).toBe(70);
  expect(diagnostic.outcome).toBe('selected');
  expect(diagnostic.picked).toEqual(['zzz__retrieve']);
  expect(bag.tools[0].name).toBe('zzz__retrieve');
});

test('malformed responses discard Jev scores and use local fallback', async () => {
  for (const answers of [{}, { item_0: { type: 'score', score: 3, probabilities: { 0: 0, 1: 0, 2: 2, 3: 0 } } }, { extra: {} }]) {
    let outcome = '';
    const bag = await smartToolbag([source()], { request: 'email', recent: '' }, config, new AbortController().signal, {
      fetch: async () => Response.json({ answers }), diagnostic: data => { outcome = (data as any).outcome; },
    });
    expect(outcome).toBe('failed_fallback'); expect(bag.tools[0].name).toBe('search_tools');
    expect(bag.tools[0].description).toContain('app__email_0');
  }
});

test('stalled transport times out; parent cancellation rejects without fallback', async () => {
  let outcome = '';
  const options: ScoringOptions = { timeoutMs: 10, fetch: async () => new Promise(() => {}), diagnostic: data => { outcome = (data as any).outcome; } };
  await smartToolbag([source()], { request: 'email', recent: '' }, config, new AbortController().signal, options);
  expect(outcome).toBe('timeout_fallback');
  outcome = '';
  const controller = new AbortController();
  const pending = smartToolbag([source()], { request: 'email', recent: '' }, config, controller.signal, options);
  controller.abort();
  await expect(pending).rejects.toThrow(); expect(outcome).toBe('');
});

test('oversized and stalled bodies fall back within overall deadline', async () => {
  for (const fetch of [async () => new Response('x'.repeat(128001)), async () => new Response(new ReadableStream({ start() {} }))]) {
    let outcome = '';
    await smartToolbag([source()], { request: 'email', recent: '' }, config, new AbortController().signal, { timeoutMs: 20, fetch, diagnostic: data => { outcome = (data as any).outcome; } });
    expect(['failed_fallback', 'timeout_fallback']).toContain(outcome);
  }
});

test('HTTP failure is diagnosed by status only, without retries or upstream secrets', async () => {
  let calls = 0; let diagnostic: any;
  await smartToolbag([source()], { request: 'private-message', recent: '' }, config, new AbortController().signal, {
    fetch: async () => { calls++; return Response.json({ error: 'private-test-key private-message' }, { status: 401 }); },
    diagnostic: data => { diagnostic = data; },
  });
  expect(calls).toBe(1);
  expect(diagnostic.failureReason).toBe('http_401');
  expect(JSON.stringify(diagnostic)).not.toContain('private-message');
  expect(JSON.stringify(diagnostic)).not.toContain(config.key);
});

test('one failed batch discards all remote judgments; serialized request guard blocks oversized evidence', async () => {
  let calls = 0; let diagnostic: any;
  const bag = await smartToolbag([source(1000)], { request: 'no match', recent: '' }, config, new AbortController().signal, {
    fetch: async (url, init) => ++calls === 1 ? validFetch(url, init) : Response.json({ answers: {} }),
    diagnostic: data => { diagnostic = data; },
  });
  expect(diagnostic.outcome).toBe('failed_fallback');
  expect(bag.tools).toHaveLength(2);
  calls = 0;
  await smartToolbag([source(16)], { request: '\u0001'.repeat(8000), recent: '\u0001'.repeat(2000) }, config, new AbortController().signal, {
    fetch: async (url, init) => { calls++; return validFetch(url, init); }, diagnostic: data => { diagnostic = data; },
  });
  expect(calls).toBe(0); expect(diagnostic.failureReason).toBe('request_size_limit');
});

test('search-only sends no network request', async () => {
  const bag = await smartToolbag([source()], { request: 'email', recent: '' }, { ...config, maxDirect: 0 }, new AbortController().signal, {
    fetch: async () => { throw new Error('Must not call'); }, diagnostic() {},
  });
  expect(bag.tools.map(t => t.name)).toEqual(['search_tools', 'call_tool']);
});

test('chat cancellation closes a late bag and never starts generation', async () => {
  const store = new Store(':memory:');
  const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
  let release!: (bag: Toolbag) => void; let closed = 0; let generated = false;
  const waiting = new Promise<Toolbag>(resolve => { release = resolve; });
  const chat = new Chat(store, async function* () { generated = true; yield 'bad'; }, () => {}, async () => waiting);
  try {
    chat.start({ conversationId: id, text: 'email', model: 'deepseek-flash', credentials: { provider: 'deepseek', key: 'test' } });
    await Promise.resolve(); chat.cancel(id);
    release({ ...source(), close() { closed++; } });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(closed).toBe(1); expect(generated).toBe(false);
  } finally { chat.close(); store.close(); }
});

test('chat passes compact evidence and config, executes a selected tool without leaking key', async () => {
  const store = new Store(':memory:');
  const id = store.handle({ method: 'createConversation', assistantId: 'moki' }).conversationId!;
  let done!: () => void; const finished = new Promise<void>(resolve => { done = resolve; });
  const events: unknown[] = [];
  const chat = new Chat(store, async function* (turn) { yield await turn.tools![0].execute({}); }, result => {
    events.push(result); if (result.snapshot.messages.at(-1)?.status !== 'streaming') done();
  }, async (signal, evidence, policy) => {
    expect(evidence.request).toBe('email'); expect(evidence.recent).toBe('');
    return smartToolbag([source()], evidence, policy!, signal, { fetch: validFetch, diagnostic() {} });
  });
  try {
    chat.start({ conversationId: id, text: 'email', model: 'deepseek-flash', credentials: { provider: 'deepseek', key: 'provider-key' }, toolLoading: config });
    await finished;
    expect(store.messages(id).at(-1)?.text).toBe('app__email_0');
    expect(JSON.stringify(events)).not.toContain(config.key);
  } finally { chat.close(); store.close(); }
});
