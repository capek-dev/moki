import { expect, mock, test } from 'bun:test';
import {
  executeWebfetch,
  webfetchToolbag,
  WEBFETCH_INPUT_SCHEMA,
  WEBFETCH_TOOL_NAME,
  type WebfetchDependencies,
} from '@backend/webfetch-tool';

const publicAddress = async (_hostname: string) => ['93.184.216.34'];

function dependencies(fetcher: typeof fetch, resolveHost: NonNullable<WebfetchDependencies['resolveHost']> = publicAddress): WebfetchDependencies {
  return { fetcher, resolveHost };
}

function response(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
}

test('webfetch is an always-available built-in with a closed input schema', async () => {
  const fetcher = mock(async () => response('<title>Example</title><h1>Hello</h1>')) as unknown as typeof fetch;
  const bag = webfetchToolbag(new AbortController().signal, dependencies(fetcher));
  expect(bag.tools).toHaveLength(1);
  expect(bag.tools[0]).toMatchObject({ name: WEBFETCH_TOOL_NAME, inputSchema: WEBFETCH_INPUT_SCHEMA });
  expect((bag.tools[0].inputSchema as any).additionalProperties).toBe(false);

  const result = await bag.execute(WEBFETCH_TOOL_NAME, { url: 'http://example.com' });
  expect(result.isError).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
  bag.close();
  await expect(bag.execute(WEBFETCH_TOOL_NAME, { url: 'https://example.com' })).rejects.toThrow('closed');
});

test('webfetch converts HTML to markdown by default and supports text and html', async () => {
  const html = '<html><head><title>Readable page</title><style>x{}</style></head><body><h1>Heading</h1><p>Hello <strong>world</strong>.</p><script>bad()</script></body></html>';
  const fetcher = mock(async () => response(html)) as unknown as typeof fetch;
  const deps = dependencies(fetcher);
  const signal = new AbortController().signal;

  const markdown = await executeWebfetch({ url: 'https://example.com/page' }, signal, deps);
  expect(markdown).toMatchObject({ isError: false });
  expect(markdown.text).toContain('Title: Readable page');
  expect(markdown.text).toContain('# Heading');
  expect(markdown.text).toContain('**world**');

  const text = await executeWebfetch({ url: 'https://example.com/page', format: 'text' }, signal, deps);
  expect(text.text).toContain('Heading Hello world.');
  expect(text.text).not.toContain('<h1>');
  expect(text.text).not.toContain('bad()');

  const raw = await executeWebfetch({ url: 'https://example.com/page', format: 'html' }, signal, deps);
  expect(raw.text).toContain('<h1>Heading</h1>');
});

test('webfetch denies malformed inputs and non-HTTP URLs before fetching', async () => {
  const fetcher = mock(async () => response('unused')) as unknown as typeof fetch;
  const deps = dependencies(fetcher);
  const signal = new AbortController().signal;
  const cases = [
    null,
    {},
    { url: 'not a url' },
    { url: 'file:///etc/passwd' },
    { url: 'https://user:secret@example.com' },
    { url: 'https://example.com', format: 'pdf' },
    { url: 'https://example.com', timeout: 121 },
    { url: 'https://example.com', extra: true },
  ];
  for (const input of cases) expect((await executeWebfetch(input, signal, deps)).isError).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

test('webfetch blocks local, metadata, private DNS, and private redirect destinations', async () => {
  const fetcher = mock(async (url: string | URL | Request) => {
    if (String(url) === 'https://example.com/start') return new Response(null, { status: 302, headers: { location: 'http://private.example/secret' } });
    return response('unused');
  }) as unknown as typeof fetch;
  const resolver = async (hostname: string) => hostname === 'private.example' ? ['192.168.1.20'] : ['93.184.216.34'];
  const deps = dependencies(fetcher, resolver);
  const signal = new AbortController().signal;

  for (const url of [
    'http://localhost:3000',
    'http://127.0.0.1',
    'http://[::1]',
    'http://metadata.google.internal/latest',
    'https://private.example',
  ]) {
    const result = await executeWebfetch({ url }, signal, deps);
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain('Blocked non-public host');
  }

  const redirected = await executeWebfetch({ url: 'https://example.com/start' }, signal, deps);
  expect(redirected).toMatchObject({ isError: true });
  expect(redirected.text).toContain('Blocked non-public host');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('webfetch retries every vetted address and prefers IPv4 when IPv6 is unavailable', async () => {
  const attempted: string[] = [];
  const requestAddress: NonNullable<WebfetchDependencies['requestAddress']> = async (_url, address) => {
    attempted.push(address);
    if (address === '93.184.216.34') return response('<title>Reachable</title><p>Done</p>');
    throw Object.assign(new Error(`connect failed ${address}`), { code: 'ECONNREFUSED' });
  };
  const result = await executeWebfetch(
    { url: 'https://example.com' },
    new AbortController().signal,
    { resolveHost: async () => ['2606:2800:220:1:248:1893:25c8:1946', '93.184.216.34'], requestAddress },
  );
  expect(result.isError).toBe(false);
  expect(result.text).toContain('Reachable');
  expect(attempted).toEqual(['93.184.216.34']);
});

test('webfetch returns an actionable bounded network error after every address fails', async () => {
  const attempted: string[] = [];
  const requestAddress: NonNullable<WebfetchDependencies['requestAddress']> = async (_url, address) => {
    attempted.push(address);
    throw Object.assign(new Error(`connect failed ${address}`), { code: 'ECONNREFUSED' });
  };
  const result = await executeWebfetch(
    { url: 'https://example.com' },
    new AbortController().signal,
    { resolveHost: async () => ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'], requestAddress },
  );
  expect(result.isError).toBe(true);
  expect(result.text).toContain('Network request failed:');
  expect(result.text).toContain('ECONNREFUSED');
  expect(result.text.length).toBeLessThan(400);
  expect(attempted).toEqual(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
});

test('webfetch follows bounded public redirects and reports the final URL', async () => {
  const fetcher = mock(async (url: string | URL | Request) => String(url).endsWith('/start')
    ? new Response(null, { status: 301, headers: { location: '/final' } })
    : response('<title>Final</title><p>Done</p>')) as unknown as typeof fetch;
  const result = await executeWebfetch(
    { url: 'https://example.com/start' },
    new AbortController().signal,
    dependencies(fetcher),
  );
  expect(result.isError).toBe(false);
  expect(result.text).toContain('URL: https://example.com/final');
  expect(result.text).toContain('Done');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('webfetch stops after five redirects', async () => {
  const fetcher = mock(async (url: string | URL | Request) => {
    const current = new URL(String(url));
    const step = Number(current.searchParams.get('step') ?? '0');
    return new Response(null, { status: 302, headers: { location: `/?step=${step + 1}` } });
  }) as unknown as typeof fetch;
  const result = await executeWebfetch(
    { url: 'https://example.com/?step=0' },
    new AbortController().signal,
    dependencies(fetcher),
  );
  expect(result).toMatchObject({ isError: true, text: 'Too many redirects (maximum 5).' });
  expect(fetcher).toHaveBeenCalledTimes(6);
});

test('webfetch rejects errors and oversized responses, and propagates host cancellation', async () => {
  const signal = new AbortController().signal;
  const tooLarge = mock(async () => response('', { headers: { 'content-type': 'text/plain', 'content-length': String(5 * 1024 * 1024 + 1) } })) as unknown as typeof fetch;
  expect(await executeWebfetch({ url: 'https://example.com' }, signal, dependencies(tooLarge))).toMatchObject({ isError: true, text: 'Response exceeds the 5 MB limit.' });

  const missing = mock(async () => new Response('missing', { status: 404 })) as unknown as typeof fetch;
  expect(await executeWebfetch({ url: 'https://example.com/missing' }, signal, dependencies(missing))).toMatchObject({ isError: true, text: 'Request failed with status 404.' });

  const broken = mock(async () => { throw Object.assign(new Error('socket unavailable'), { code: 'ECONNREFUSED' }); }) as unknown as typeof fetch;
  expect(await executeWebfetch({ url: 'https://example.com' }, signal, dependencies(broken))).toMatchObject({ isError: true, text: 'Network request failed: ECONNREFUSED: socket unavailable' });

  const abort = new AbortController();
  abort.abort();
  await expect(executeWebfetch({ url: 'https://example.com' }, abort.signal, dependencies(missing))).rejects.toThrow();

  const midFlightAbort = new AbortController();
  const waitingResolver = () => new Promise<readonly string[]>(() => {});
  const pending = executeWebfetch({ url: 'https://example.com' }, midFlightAbort.signal, dependencies(missing, waitingResolver));
  midFlightAbort.abort();
  await expect(pending).rejects.toThrow();
});

test('webfetch bounds model-facing output', async () => {
  const fetcher = mock(async () => new Response('x'.repeat(40_000), { headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch;
  const result = await executeWebfetch(
    { url: 'https://example.com/large' },
    new AbortController().signal,
    dependencies(fetcher),
  );
  expect(result.isError).toBe(false);
  expect(result.text).toContain('…[truncated]');
  expect(result.text.length).toBeLessThan(31_000);
});
