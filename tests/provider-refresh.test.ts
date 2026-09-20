import { expect, test } from 'bun:test';
import { ProviderConnections, type Vault } from '@electron/provider-connections';
function fixture() {
  let saved: ReturnType<Vault['read']> = { version: 1, codex: { access: 'expired', refresh: 'refresh', accountId: 'account', expires: 0 } };
  let resolve!: (response: Response) => void;
  let calls = 0;
  const service = new ProviderConnections({ read: () => saved, write: (value) => { saved = value; }, resetUnreadable: () => { saved = { version: 1 }; } }, async () => {}, () => {}, (async (_url: string, init: RequestInit) => {
    calls++;
    expect(new URLSearchParams(String(init.body)).get('grant_type')).toBe('refresh_token');
    return new Promise<Response>((r) => { resolve = r; });
  }) as unknown as typeof fetch);
  return { service, calls: () => calls, saved: () => saved, resolve: (value: unknown) => resolve(Response.json(value)) };
}
test('expired credentials refresh once for concurrent turns without leaking refresh tokens', async () => {
  const f = fixture();
  const first = f.service.credentials('codex');
  const second = f.service.credentials('codex');
  f.resolve({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 });
  expect(await first).toEqual({ provider: 'codex', access: 'fresh', accountId: 'account' });
  expect(await second).toEqual(await first);
  expect(f.calls()).toBe(1);
  expect(f.saved().codex?.refresh).toBe('rotated');
  expect(JSON.stringify(f.service.status())).not.toContain('fresh');
});
test('disconnect during refresh cannot restore removed credentials', async () => {
  const f = fixture();
  const pending = f.service.credentials('codex');
  await f.service.handle({ action: 'disconnect', provider: 'codex' });
  f.resolve({ access_token: 'late', refresh_token: 'rotated', expires_in: 3600 });
  await expect(pending).rejects.toThrow('refresh Codex');
  expect(f.saved().codex).toBeUndefined();
});
test('changed refresh identity and malformed responses preserve original credentials', async () => {
  for (const value of [{ access_token: 'fresh', expires_in: -1 }, { access_token: 'fresh', expires_in: 3600, id_token: `a.${Buffer.from(JSON.stringify({ chatgpt_account_id: 'other' })).toString('base64url')}.b` }]) {
    const f = fixture(); const pending = f.service.credentials('codex'); f.resolve(value);
    await expect(pending).rejects.toThrow('refresh Codex');
    expect(f.saved().codex?.access).toBe('expired');
  }
});
