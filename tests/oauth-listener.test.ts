import { expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { callbackHandler, type CallbackListener } from '../src/electron/oauth-listener';
import { ProviderConnections, type Vault } from '../src/electron/provider-connections';

function fixture(failListen = false) {
  let complete!: (url: string) => Promise<void>;
  let authorization = '';
  let closed = 0;
  let listening = false;
  let saved: ReturnType<Vault['read']> = { version: 1 };
  const listen: CallbackListener = async (handler) => {
    if (failListen) throw new Error('Port 1455 unavailable');
    listening = true; complete = handler;
    return () => { listening = false; closed++; };
  };
  const service = new ProviderConnections({ read: () => saved, write: (data) => { saved = data; } }, async (url) => {
    expect(listening).toBe(true); authorization = url;
  }, () => {}, (async () => Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, id_token: `a.${Buffer.from(JSON.stringify({ chatgpt_account_id: 'account' })).toString('base64url')}.b` })) as unknown as typeof fetch, Date.now, listen);
  return { service, closed: () => closed, authorization: () => authorization, complete: () => complete(`http://localhost:1455/auth/callback?code=code&state=${new URL(authorization).searchParams.get('state')}`) };
}

test('automatic callback saves subscription, broadcasts state and closes listener', async () => {
  const f = fixture();
  try {
    await f.service.handle({ action: 'startCodex' });
    await f.complete();
    expect(f.service.status().codex.connected).toBe(true);
    expect(f.service.status().signingIn).toBe(false);
    expect(f.closed()).toBe(1);
    await expect(f.complete()).rejects.toThrow('no longer active');
  } finally { f.service.close(); }
});
test('cancel and quit close listeners; port failure never opens browser', async () => {
  const f = fixture();
  await f.service.handle({ action: 'startCodex' });
  await f.service.handle({ action: 'cancelCodex' });
  expect(f.closed()).toBe(1);
  await expect(f.complete()).rejects.toThrow();
  await f.service.handle({ action: 'startCodex' });
  f.service.close();
  expect(f.closed()).toBe(2);
  const blocked = fixture(true);
  await expect(blocked.service.handle({ action: 'startCodex' })).rejects.toThrow('1455');
  expect(blocked.authorization()).toBe('');
  expect(blocked.service.status().signingIn).toBe(false);
});
test('HTTP handler restricts host/path/method and never echoes callback secrets', async () => {
  for (const [method, host, path, accepted] of [
    ['GET', 'localhost:1455', '/auth/callback?code=secret', true],
    ['POST', 'localhost:1455', '/auth/callback?code=secret', false],
    ['GET', 'evil.example', '/auth/callback?code=secret', false],
    ['GET', 'localhost:1455', '/other?code=secret', false],
  ] as const) {
    let calls = 0;
    let status = 200;
    const headers: Record<string, string> = {};
    let finish!: (body: string) => void;
    const result = new Promise<string>((resolve) => { finish = resolve; });
    callbackHandler(async () => { calls++; })({ method, headers: { host }, url: path } as IncomingMessage, {
      setHeader(name: string, value: string) { headers[name] = value; },
      writeHead(value: number) { status = value; }, end: finish,
    } as unknown as ServerResponse);
    expect(await result).not.toContain('secret');
    expect(calls).toBe(accepted ? 1 : 0);
    expect(status).toBe(accepted ? 200 : 400);
    expect(headers['Cache-Control']).toBe('no-store');
  }
});
