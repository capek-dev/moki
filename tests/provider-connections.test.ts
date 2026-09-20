import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedVault, ProviderConnections, type Vault } from '@electron/provider-connections';

function fixture(fetcher: (url: string, options: RequestInit) => Promise<Response> = async () => Response.json({ data: [] })) {
  let saved: ReturnType<Vault['read']> = { version: 1 };
  let authorization = '';
  let now = 1000;
  const events: unknown[] = [];
  const service = new ProviderConnections({ read: () => saved, write: (value) => { saved = value; }, resetUnreadable: () => { saved = { version: 1 }; } }, async (url) => { authorization = url; }, (state) => events.push(state), fetcher as typeof fetch, () => now, async () => () => {});
  return { service, events, saved: () => saved, authorization: () => new URL(authorization), expire: () => { now += 300001; }, callback: () => `http://localhost:1455/auth/callback?state=${new URL(authorization).searchParams.get('state')}&code=secret-code` };
}
function tokens() {
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })).toString('base64url');
  return Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600, id_token: `header.${claims}.signature` });
}
test('DeepSeek verifies fixed endpoint and never exposes key in status/events', async () => {
  const f = fixture(async (url, init) => {
    expect(url).toBe('https://api.deepseek.com/models');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
    return Response.json({ data: [] });
  });
  expect((await f.service.handle({ action: 'saveDeepseek', key: 'test-key' })).deepseek.connected).toBe(true);
  expect(f.saved().deepseek).toBe('test-key');
  expect(JSON.stringify(f.events)).not.toContain('test-key');
  await f.service.handle({ action: 'disconnect', provider: 'deepseek' });
  expect(f.saved().deepseek).toBeUndefined();
});
test('Codex PKCE exchange is bound to state and tokens stay private', async () => {
  let verifier = '';
  const f = fixture(async (url, init) => {
    expect(url).toBe('https://auth.openai.com/oauth/token');
    const params = new URLSearchParams(String(init.body));
    verifier = params.get('code_verifier')!;
    expect(params.get('code')).toBe('secret-code');
    expect(params.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    return tokens();
  });
  await f.service.handle({ action: 'startCodex' });
  const auth = f.authorization();
  expect(auth.origin).toBe('https://auth.openai.com');
  await expect(f.service.handle({ action: 'completeCodex', url: f.callback().replace('state=', 'state=wrong') })).rejects.toThrow('does not match');
  await f.service.handle({ action: 'completeCodex', url: f.callback() });
  expect(auth.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
  expect(f.saved().codex?.accountId).toBe('account');
  expect(JSON.stringify(f.service.status())).not.toContain('secret');
  expect(JSON.stringify(f.events)).not.toContain('secret');
  await expect(f.service.handle({ action: 'completeCodex', url: f.callback() })).rejects.toThrow('expired or already used');
});
test('expiry, foreign redirect, malformed commands and unsupported providers fail closed', async () => {
  const f = fixture(async () => { throw new Error('Must not fetch'); });
  for (const input of [null, [], { action: 'disconnect', provider: 'openai' }, { action: 'other' }, { action: 'saveDeepseek', key: 'bad key' }]) await expect(f.service.handle(input)).rejects.toThrow();
  await f.service.handle({ action: 'startCodex' });
  await expect(f.service.handle({ action: 'completeCodex', url: f.callback().replace('localhost', 'evil.example') })).rejects.toThrow('does not match');
  f.expire();
  await expect(f.service.handle({ action: 'completeCodex', url: f.callback() })).rejects.toThrow('expired');
  expect(f.saved()).toEqual({ version: 1 });
});
test('disconnect cannot be undone by late key verification', async () => {
  let resolve!: (response: Response) => void;
  const f = fixture(() => new Promise((r) => { resolve = r; }));
  const pending = f.service.handle({ action: 'saveDeepseek', key: 'test-key' });
  await f.service.handle({ action: 'disconnect', provider: 'deepseek' });
  resolve(Response.json({ data: [] }));
  await expect(pending).rejects.toThrow('cancelled');
  expect(f.saved().deepseek).toBeUndefined();
});
test('cancel prevents an in-flight Codex exchange from resurrecting credentials', async () => {
  let resolve!: (response: Response) => void;
  const f = fixture(() => new Promise((r) => { resolve = r; }));
  await f.service.handle({ action: 'startCodex' });
  const pending = f.service.handle({ action: 'completeCodex', url: f.callback() });
  await f.service.handle({ action: 'cancelCodex' });
  resolve(tokens());
  await expect(pending).rejects.toThrow('could not be completed');
  expect(f.saved().codex).toBeUndefined();
});
test('failed replacement preserves previous subscription and sanitizes errors', async () => {
  let fail = false;
  const f = fixture(async () => fail ? new Response('secret-server-output', { status: 401 }) : tokens());
  await f.service.handle({ action: 'startCodex' });
  await f.service.handle({ action: 'completeCodex', url: f.callback() });
  fail = true;
  await f.service.handle({ action: 'startCodex' });
  await expect(f.service.handle({ action: 'completeCodex', url: f.callback() })).rejects.toThrow('previous connection was kept');
  expect(f.saved().codex?.access).toBe('secret-access');
});
test('vault delegates encryption, uses private permissions, and preserves corrupt bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-vault-'));
  const file = join(dir, 'vault');
  let plaintext = '';
  const encryption = { isEncryptionAvailable: () => true, encryptString: (value: string) => { plaintext = value; return Buffer.from('encrypted-test-fixture'); }, decryptString: (bytes: Buffer) => { if (bytes.toString() !== 'encrypted-test-fixture') throw new Error(); return plaintext; } };
  try {
    const vault = new EncryptedVault(file, encryption);
    vault.write({ version: 1, deepseek: 'secret-key' });
    expect(readFileSync(file, 'utf8')).not.toContain('secret-key');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(vault.read().deepseek).toBe('secret-key');
    writeFileSync(file, 'corrupt');
    expect(() => vault.read()).toThrow('not overwritten');
    expect(readFileSync(file, 'utf8')).toBe('corrupt');
    vault.resetUnreadable();
    expect(vault.read()).toEqual({ version: 1 });
    const backup = readdirSync(dir).find((name) => name.startsWith('vault.unreadable-'));
    expect(backup).toBeTruthy();
    expect(readFileSync(join(dir, backup!), 'utf8')).toBe('corrupt');
    expect(() => vault.resetUnreadable()).toThrow('readable');
    const unavailable = new EncryptedVault(file, { ...encryption, isEncryptionAvailable: () => false });
    expect(() => unavailable.write({ version: 1 })).toThrow('unavailable');
    expect(() => unavailable.resetUnreadable()).toThrow('unavailable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
