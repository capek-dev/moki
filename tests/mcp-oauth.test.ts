import { expect, test } from 'bun:test';
import { McpConnections, type McpVault } from '@electron/mcp-connections';

// Drives the full MCP OAuth dance offline: a fake authorization server
// implements 401 discovery, protected-resource and authorization-server
// metadata, dynamic client registration, the token exchange, and refresh.
// The browser opener and loopback listener are injected fakes.

function fakeAuthorizationServer(edgeStatus: 401 | 405 | 400 = 401) {
  const seen = { verifier: '', refreshTokenGrant: '', registeredRedirects: [] as string[] };
  const server = Bun.serve({
    port: 0,
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url);
      const origin = url.origin;
      if (request.method === 'POST' && url.pathname === '/mcp') {
        if (request.headers.get('authorization') === 'Bearer at-1' || request.headers.get('authorization') === 'Bearer at-2') {
          return Response.json({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'web' } } });
        }
        // Edge servers like Pipedream reject anonymous traffic with 400/405
        // and no challenge header; only the standard gate carries one.
        return new Response('edge rejection', { status: edgeStatus, ...(edgeStatus === 401 ? { headers: { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } } : {}) });
      }
      if (url.pathname === '/.well-known/oauth-protected-resource') return Response.json({ authorization_servers: [origin], resource: origin });
      if (url.pathname === '/.well-known/oauth-authorization-server') return Response.json({
        authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
      });
      if (request.method === 'POST' && url.pathname === '/register') {
        const body = await request.json() as { redirect_uris?: string[] };
        seen.registeredRedirects = body.redirect_uris ?? [];
        return Response.json({ client_id: 'client-1' });
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        const form = new URLSearchParams(await request.text());
        if (form.get('grant_type') === 'authorization_code') {
          seen.verifier = form.get('code_verifier') ?? '';
          if (form.get('code') !== 'code-1') return Response.json({ error: 'invalid_grant' }, { status: 400 });
          return Response.json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' });
        }
        if (form.get('grant_type') === 'refresh_token') {
          seen.refreshTokenGrant = form.get('refresh_token') ?? '';
          if (form.get('refresh_token') !== 'rt-1') return Response.json({ error: 'invalid_grant' }, { status: 400 });
          return Response.json({ access_token: 'at-2', expires_in: 3600, token_type: 'Bearer' });
        }
      }
      return new Response('not found', { status: 404 });
    },
  });
  // Bun's server.url is a URL with a trailing slash; the metadata origin is
  // bare, so normalize once and use it for both the endpoint and the resource.
  const base = String(server.url).replace(/\/+$/, '');
  return { url: `${base}/mcp`, resource: base, seen, stop: () => server.stop(true) };
}

function fixture(now: () => number = Date.now, edgeStatus: 401 | 405 | 400 = 401) {
  const web = fakeAuthorizationServer(edgeStatus);
  let saved: Parameters<McpVault['write']>[0] = { version: 1, servers: {} };
  const vault: McpVault = { read: () => saved, write: (data) => { saved = data; } };
  const opened: string[] = [];
  let stopped = 0;
  let complete: ((url: string) => Promise<void>) | null = null;
  const service = new McpConnections(vault, async (url) => { opened.push(url); },
    fetch, now, async (handler) => { complete = handler; return { port: 45999, stop: () => { stopped++; } } });
  const authorizeUrl = () => new URL(opened.at(-1)!);
  const finishSignIn = (error = false) => {
    const url = authorizeUrl();
    return complete!(`http://localhost:45999/callback?${error ? 'error=access_denied' : 'code=code-1'}&state=${url.searchParams.get('state')}`);
  };
  return { service, web, opened, stopped: () => stopped, authorizeUrl, finishSignIn, complete: (url: string) => complete!(url), saved: () => saved };
}

test('full sign-in walks discovery, registration, PKCE, and stores tokens in the vault', async () => {
  const f = fixture();
  try {
    const pending = f.service.handle({ action: 'signIn', server: 'pipedream', url: f.web.url });
    await new Promise((resolve) => setTimeout(resolve, 10)); // let it open the browser
    expect(f.opened).toHaveLength(1);
    const url = f.authorizeUrl();
    // The resource indicator must be the metadata's canonical value, not the
    // connection URL with its path (Pipedream rejects path-bearing values).
    expect(f.web.resource).not.toBe(f.web.url);
    expect(url.searchParams.get('resource')).toBe(f.web.resource);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:45999/callback');
    expect(f.web.seen.registeredRedirects).toEqual(['http://localhost:45999/callback']);
    await f.finishSignIn();
    expect(await pending).toEqual({ signedIn: true });
    expect(f.service.signedIn('pipedream')).toBe(true);
    expect(f.service.headers('pipedream')).toEqual({ authorization: 'Bearer at-1' });
    expect(f.web.seen.verifier.length).toBeGreaterThan(40); // PKCE verifier sent
    expect(f.stopped()).toBe(1); // listener cleaned up after success
  } finally { f.web.stop(); f.service.close(); }
});

test('declined authorization and foreign states are rejected without saving', async () => {
  const f = fixture();
  try {
    const declined = f.service.handle({ action: 'signIn', server: 'pipedream', url: f.web.url });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(f.finishSignIn(true)).rejects.toThrow('declined');
    await expect(declined).rejects.toThrow('declined');
    expect(f.service.signedIn('pipedream')).toBe(false);
    const foreign = f.service.handle({ action: 'signIn', server: 'pipedream', url: f.web.url });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(f.complete(`http://localhost:45999/callback?code=code-1&state=tampered`)).rejects.toThrow('does not match');
    f.service.close();
    await expect(foreign).rejects.toThrow();
    expect(f.service.signedIn('pipedream')).toBe(false);
  } finally { f.web.stop(); f.service.close(); }
});

test('near-expiry tokens refresh silently without opening a browser', async () => {
  let time = 1_000_000;
  const f = fixture(() => time);
  try {
    const first = f.service.handle({ action: 'signIn', server: 'pipedream', url: f.web.url });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await f.finishSignIn();
    await first;
    time += 3600_000 - 30_000; // token expires in 30s
    expect(await f.service.handle({ action: 'signIn', server: 'pipedream', url: f.web.url })).toEqual({ signedIn: true });
    expect(f.opened).toHaveLength(1); // no second browser round-trip
    expect(f.service.headers('pipedream')).toEqual({ authorization: 'Bearer at-2' });
    expect(f.web.seen.refreshTokenGrant).toBe('rt-1');
  } finally { f.web.stop(); f.service.close(); }
});

test('sign out clears the vault entry and headers', async () => {
  const f = fixture();
  try {
    const pending = f.service.handle({ action: 'signIn', server: 'pipedream', url: f.web.url });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await f.finishSignIn();
    await pending;
    expect(await f.service.handle({ action: 'signOut', server: 'pipedream' })).toEqual({ signedIn: false });
    expect(f.service.headers('pipedream')).toBeNull();
    expect(f.saved().servers).toEqual({});
    await expect(f.service.handle({ action: 'signIn', server: 'x' })).rejects.toThrow('not a web connection');
    await expect(f.service.handle({ action: 'nope', server: 'x' })).rejects.toThrow('Unsupported');
  } finally { f.web.stop(); f.service.close(); }
});

test('servers that answer without auth report no sign-in needed', async () => {
  const open = Bun.serve({ port: 0, fetch: async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }) });
  const f = fixture();
  try {
    const result = await f.service.handle({ action: 'signIn', server: 'free', url: `${open.url}/mcp` });
    expect(result).toEqual({ signedIn: false, note: 'This connection does not need sign-in.' });
    expect(f.opened).toHaveLength(0);
  } finally { open.stop(true); f.web.stop(); f.service.close(); }
});

// Pipedream's shape: anonymous initialize gets a 400/405 (no challenge
// header), but well-known metadata exists, so sign-in must still walk it.
test.each([405, 400])('edge status %d still reaches sign-in via well-known metadata', async (edgeStatus) => {
  const f = fixture(Date.now, edgeStatus as 405 | 400);
  try {
    const pending = f.service.handle({ action: 'signIn', server: 'pipedream', url: f.web.url });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.opened).toHaveLength(1); // browser opened despite the edge status
    await f.finishSignIn();
    expect(await pending).toEqual({ signedIn: true });
    expect(f.service.headers('pipedream')).toEqual({ authorization: 'Bearer at-1' });
  } finally { f.web.stop(); f.service.close(); }
});
