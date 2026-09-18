import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';

// Sign-in for web (HTTP) MCP connections, following the MCP authorization
// flow: 401 discovery, protected-resource metadata, authorization-server
// metadata, dynamic client registration, PKCE with a loopback redirect, and
// the token exchange. Tokens live only in the encrypted vault (safeStorage
// under the hood via the injected Encryption); the mcp.json config file never
// stores credentials. Mirrors ProviderConnections: injected clock, fetch,
// browser opener, and listener so tests drive the whole dance offline.

interface StoredConnection { accessToken: string; refreshToken: string | null; expires: number | null; tokenType: string; tokenEndpoint: string; clientId: string; clientSecret: string | null }
interface Secrets { version: 1; servers: Record<string, StoredConnection> }
interface Encryption { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
export interface McpVault { read(): Secrets; write(value: Secrets): void }

export class EncryptedMcpVault implements McpVault {
  constructor(private path: string, private encryption: Encryption) {}
  private check() { if (!this.encryption.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable. Nothing was saved.'); }
  read(): Secrets {
    this.check();
    let bytes: Buffer;
    try { bytes = readFileSync(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, servers: {} }; throw new Error('Cannot read saved sign-ins.'); }
    try {
      const data = JSON.parse(this.encryption.decryptString(bytes));
      if (data?.version !== 1 || typeof data.servers !== 'object' || data.servers === null || Array.isArray(data.servers)) throw new Error();
      for (const entry of Object.values(data.servers as Record<string, unknown>)) {
        const value = entry as Partial<StoredConnection>;
        if (typeof value !== 'object' || value === null || !valid(value.accessToken) || !valid(value.tokenEndpoint) || !valid(value.clientId)
          || (value.refreshToken !== null && value.refreshToken !== undefined && !valid(value.refreshToken))
          || (value.clientSecret !== null && value.clientSecret !== undefined && !valid(value.clientSecret))
          || (value.expires !== null && value.expires !== undefined && !Number.isFinite(value.expires))) throw new Error();
      }
      return { version: 1, servers: data.servers };
    } catch { throw new Error('Saved sign-ins could not be decrypted or are invalid. They were not overwritten.'); }
  }
  write(value: Secrets) {
    this.check();
    const encrypted = this.encryption.encryptString(JSON.stringify(value));
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + '.' + randomBytes(8).toString('hex');
    try { writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path); }
    catch { try { unlinkSync(temporary); } catch {} throw new Error('Could not securely save the sign-in.'); }
  }
}
function valid(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 32000; }

export type McpCallbackListener = (complete: (url: string) => Promise<void>) => Promise<{ port: number; stop: () => void }>;

// Loopback catcher on an ephemeral port (1455 belongs to Codex sign-in). The
// port is picked first so the redirect URI and the dynamic registration can
// name it. Binds both loopback families and never a wildcard address.
export const listenForMcpOAuth: McpCallbackListener = async (complete) => {
  const servers: ReturnType<typeof createServer>[] = [];
  let port = 0;
  const close = () => {
    for (const server of servers) {
      server.close();
      const timer = setTimeout(() => server.closeAllConnections(), 1000);
      timer.unref();
    }
  };
  const serve = (handler: ReturnType<typeof createServer>) => new Promise<void>((resolve, reject) => {
    handler.once('error', reject);
    handler.listen({ host: '127.0.0.1', port, ipv6Only: false }, () => { handler.removeListener('error', reject); resolve(); });
  });
  try {
    let handler!: (url: string) => Promise<void>;
    const first = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Connection', 'close');
      if (request.method !== 'GET' || !request.url?.startsWith('/callback?') || request.url.length > 32000) {
        response.writeHead(400); response.end('Invalid sign-in callback.'); return;
      }
      void handler(`http://localhost:${port}${request.url}`).then(() => {
        response.end('Signed in to Moki. You can close this tab.');
      }, () => {
        response.writeHead(400); response.end('Sign-in could not be completed. Return to Moki and try again.');
      });
    });
    handler = (url) => complete(url);
    servers.push(first);
    await serve(first);
    port = (first.address() as { port: number }).port;
    const second = createServer((request, response) => {
      // Reuse the first server's handler semantics for the IPv6 family.
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      if (request.method !== 'GET' || !request.url?.startsWith('/callback?') || request.url.length > 32000) {
        response.writeHead(400); response.end('Invalid sign-in callback.'); return;
      }
      void handler(`http://localhost:${port}${request.url}`).then(() => {
        response.end('Signed in to Moki. You can close this tab.');
      }, () => {
        response.writeHead(400); response.end('Sign-in could not be completed. Return to Moki and try again.');
      });
    });
    second.headersTimeout = 5000;
    second.requestTimeout = 10000;
    servers.push(second);
    await new Promise<void>((resolve, reject) => {
      second.once('error', reject);
      second.listen({ host: '::1', port, ipv6Only: true }, () => { second.removeListener('error', reject); resolve(); });
    });
    first.headersTimeout = 5000;
    first.requestTimeout = 10000;
    return { port, stop: close };
  } catch { close(); throw new Error('Cannot open a local sign-in port. Close other sign-in attempts and try again.'); }
};

export interface McpAuthResult { signedIn: boolean; note?: string }

export class McpConnections {
  private secrets?: Secrets;
  private flows = new Map<string, { state: string; verifier: string; expires: number; stop: () => void; generation: number; finish: (error?: Error) => void }>();
  // Endpoints and registration for an in-flight sign-in. Kept in memory, not
  // the vault: the vault only ever stores complete, usable connections.
  private contexts = new Map<string, { tokenEndpoint: string; clientId: string; clientSecret: string | null }>();
  private generations = new Map<string, number>();
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private vault: McpVault, private open: (url: string) => Promise<void>, private fetcher: typeof fetch = fetch, private now = Date.now, private listen: McpCallbackListener = listenForMcpOAuth) {}
  private load() { return this.secrets ??= this.vault.read(); }
  private persist(next: Secrets) { this.vault.write(next); this.secrets = next; }
  private invalidate(server: string) {
    const flow = this.flows.get(server);
    this.contexts.delete(server);
    if (flow) {
      this.generations.set(server, (this.generations.get(server) ?? 0) + 1);
      flow.stop();
      clearTimeout(this.expiryTimers.get(server)); this.expiryTimers.delete(server);
      this.flows.delete(server);
      flow.finish(new Error('Sign-in was replaced or cancelled.'));
    }
  }
  signedIn(server: string): boolean { return !!this.load().servers[server]; }
  // The header overlay the backend should merge over any config headers.
  headers(server: string): Record<string, string> | null {
    const entry = this.load().servers[server];
    return entry ? { authorization: `${entry.tokenType || 'Bearer'} ${entry.accessToken}` } : null;
  }
  allHeaders(): Record<string, Record<string, string>> {
    const result: Record<string, Record<string, string>> = {};
    for (const server of Object.keys(this.load().servers)) result[server] = this.headers(server)!;
    return result;
  }
  async handle(input: unknown): Promise<McpAuthResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid sign-in request.');
    const command = input as { action?: unknown; server?: unknown; url?: unknown };
    if (typeof command.server !== 'string' || !command.server || command.server.length > 64) throw new Error('Invalid connection name.');
    switch (command.action) {
      case 'signOut': {
        this.invalidate(command.server);
        const next = { ...this.load() }; delete next.servers[command.server]; this.persist(next);
        return { signedIn: false };
      }
      case 'signIn': {
        if (typeof command.url !== 'string' || !/^https?:\/\//i.test(command.url)) throw new Error('This connection is not a web connection.');
        this.invalidate(command.server);
        return this.signIn(command.server, command.url);
      }
      default: throw new Error('Unsupported sign-in request.');
    }
  }
  // Refresh when the saved token is at or near expiry; otherwise a full
  // browser round-trip. Either way the caller ends with fresh headers.
  private async signIn(server: string, url: string): Promise<McpAuthResult> {
    const entry = this.load().servers[server];
    if (entry && entry.refreshToken && entry.expires !== null && entry.expires <= this.now() + 60000) {
      try { await this.refresh(server, entry); return { signedIn: true }; }
      catch { /* Fall through to a fresh sign-in below. */ }
    }
    if (entry && (!entry.expires || entry.expires > this.now() + 60000)) return { signedIn: true };
    const discovered = await this.discover(url);
    if (!discovered) return { signedIn: false, note: 'This connection does not need sign-in.' };
    const { authorizationEndpoint, tokenEndpoint, registrationEndpoint, resource } = discovered;
    const listener = await this.listen((callbackUrl) => this.complete(server, callbackUrl));
    const redirectUri = `http://localhost:${listener.port}/callback`;
    let clientId = entry?.clientId ?? '';
    let clientSecret = entry?.clientSecret ?? null;
    try {
      if (!clientId) {
        if (!registrationEndpoint) throw new Error('This app does not support automatic sign-in.');
        const registration = await this.post(registrationEndpoint, { client_name: 'Moki', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' });
        if (!valid(registration.client_id)) throw new Error('This app rejected the sign-in registration.');
        clientId = registration.client_id;
        clientSecret = valid(registration.client_secret) ? registration.client_secret : null;
      }
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      this.contexts.set(server, { tokenEndpoint, clientId, clientSecret });
      const generation = this.generations.get(server) ?? 0;
      const done = new Promise<void>((resolve, reject) => {
        const flow = { state, verifier, expires: this.now() + 300000, stop: listener.stop, generation, finish: (error?: Error) => error ? reject(error) : resolve() };
        this.flows.set(server, flow);
        const timer = setTimeout(() => {
          if (this.flows.get(server)?.state !== state) return;
          flow.finish(new Error('Sign-in expired. Start again.'));
          this.invalidate(server);
        }, 300000);
        timer.unref();
        this.expiryTimers.set(server, timer);
      });
      const authorize = new URL(authorizationEndpoint);
      authorize.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource }).toString();
      try {
        await this.open(authorize.href);
      } catch (error) {
        done.catch(() => {}); // invalidate below settles it; nobody awaits anymore
        throw error instanceof Error ? error : new Error('Could not open the sign-in page.');
      }
      await done;
      const saved = this.load().servers[server];
      if (!saved || saved.clientId !== clientId) throw new Error('Sign-in could not be completed. Start again.');
      return { signedIn: true };
    } finally {
      // Success and failure paths settle and stop the listener themselves; this
      // sweep guarantees no port stays bound after a thrown setup step.
      if (this.flows.has(server)) this.invalidate(server);
    }
  }
  private async complete(server: string, callbackUrl: string): Promise<void> {
    const flow = this.flows.get(server);
    if (!flow || flow.expires <= this.now()) throw new Error('Sign-in expired. Start again.');
    // Every failure after this point settles the waiting sign-in with the same
    // message the caller sees, then cleans the flow and its listener.
    const fail = (message: string): never => {
      flow.finish(new Error(message));
      this.invalidate(server);
      throw new Error(message);
    };
    const url = (() => { try { return new URL(callbackUrl); } catch { return fail('Invalid sign-in callback.'); } })();
    if (url.pathname !== '/callback' || url.username || url.password || url.hash || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== flow.state) fail('Callback does not match this sign-in.');
    if (url.searchParams.has('error')) fail('Sign-in was declined.');
    const code = url.searchParams.get('code');
    if (!valid(code) || url.searchParams.getAll('code').length !== 1) fail('Callback is missing its authorization code.');
    const entry = this.load().servers[server];
    const context = this.contexts.get(server) ?? (entry ? { tokenEndpoint: entry.tokenEndpoint, clientId: entry.clientId, clientSecret: entry.clientSecret } : undefined);
    const ctx = context ?? fail('Sign-in state was lost. Start again.');
    // The redirect at exchange time must match the authorize request; rebuild
    // it from the callback's own port (the listener chose it).
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: code!, redirect_uri: `http://localhost:${url.port}/callback`, client_id: ctx.clientId, code_verifier: flow.verifier });
    if (ctx.clientSecret) form.set('client_secret', ctx.clientSecret);
    const tokens = await this.post(ctx.tokenEndpoint, form).catch(() => null);
    const accessToken = tokens?.access_token;
    const refreshToken = tokens?.refresh_token;
    const expiresIn = tokens?.expires_in;
    const tokenType = tokens?.token_type;
    const token = valid(accessToken) ? accessToken : fail('Sign-in could not be completed. Start again.');
    this.persist({ ...this.load(), servers: { ...this.load().servers, [server]: {
      accessToken: token,
      refreshToken: valid(refreshToken) ? refreshToken : entry?.refreshToken ?? null,
      expires: typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? this.now() + expiresIn * 1000 : null,
      tokenType: valid(tokenType) ? tokenType : 'Bearer',
      tokenEndpoint: ctx.tokenEndpoint,
      clientId: ctx.clientId,
      clientSecret: ctx.clientSecret,
    } } });
    flow.finish();
    this.invalidate(server);
  }
  private async refresh(server: string, entry: StoredConnection) {
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: entry.refreshToken!, client_id: entry.clientId });
    if (entry.clientSecret) form.set('client_secret', entry.clientSecret);
    const tokens = await this.post(entry.tokenEndpoint, form);
    const granted = tokens.access_token;
    if (!valid(granted)) throw new Error('Invalid refresh response.');
    const rotated = tokens.refresh_token;
    this.persist({ ...this.load(), servers: { ...this.load().servers, [server]: {
      accessToken: granted,
      refreshToken: valid(rotated) ? rotated : entry.refreshToken,
      expires: typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 ? this.now() + tokens.expires_in * 1000 : entry.expires,
      tokenType: valid(tokens.token_type) ? tokens.token_type : entry.tokenType,
      tokenEndpoint: entry.tokenEndpoint,
      clientId: entry.clientId,
      clientSecret: entry.clientSecret,
    } } });
  }
  // Discovery per the MCP authorization spec: a 401/403 challenge names the
  // protected-resource metadata. Hosted edges are looser (Pipedream's server
  // answers anonymous traffic with a 400 JSON-RPC error, its dashboard site
  // with 405, unknown per-app paths 404), so those statuses also fall through
  // to the well-known lookup; anything else (200, 5xx) means sign-in is not
  // the fix for this connection.
  private async discover(serverUrl: string): Promise<{ authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string | null; resource: string } | null> {
    const probe = await this.fetcher(serverUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'moki', version: '0.1.0' } } }), redirect: 'error' }).catch(() => { throw new Error('This connection could not be reached.'); });
    const status = probe.status;
    await probe.body?.cancel().catch(() => {});
    if (status !== 401 && status !== 403 && status !== 400 && status !== 404 && status !== 405) return null;
    const challenge = probe.headers.get('www-authenticate') ?? '';
    const match = challenge.match(/resource_metadata=["']([^"']+)["']/i);
    let metadataUrl: string | null = match?.[1] ?? null;
    if (!metadataUrl) {
      const origin = new URL(serverUrl).origin;
      metadataUrl = `${origin}/.well-known/oauth-protected-resource`;
    }
    // On the standard auth gates, missing metadata is an error worth seeing.
    // On the edge statuses it just means the server offers no OAuth, and the
    // original connection error stays the truth the user reads.
    let resource: Record<string, unknown>;
    try { resource = await this.get(metadataUrl); }
    catch { if (status === 401 || status === 403) throw new Error('This app does not support automatic sign-in.'); return null; }
    // https origins always qualify; loopback http is allowed for local servers
    // and tests (RFC 8252 loopback exemption).
    const authorizationServers = Array.isArray(resource.authorization_servers) ? resource.authorization_servers.filter((value): value is string => typeof value === 'string' && (/^https:\/\//.test(value) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(value))) : [];
    if (!authorizationServers.length) {
      if (status === 401 || status === 403) throw new Error('This app does not support automatic sign-in.');
      return null;
    }
    const metadata = await this.get(`${authorizationServers[0].replace(/\/$/, '')}/.well-known/oauth-authorization-server`);
    if (!valid(metadata.authorization_endpoint) || !valid(metadata.token_endpoint)) throw new Error('This app does not support automatic sign-in.');
    // RFC 8707 resource indicator: servers reject path-bearing values that do
    // not match their canonical identifier (Pipedream: "Invalid or unauthorized
    // resource parameter" for /v2 URLs), so the metadata's declared resource
    // wins over the connection URL the user typed.
    const resourceIdentifier = valid(resource.resource) ? resource.resource : serverUrl;
    return { authorizationEndpoint: metadata.authorization_endpoint, tokenEndpoint: metadata.token_endpoint, registrationEndpoint: valid(metadata.registration_endpoint) ? metadata.registration_endpoint : null, resource: resourceIdentifier };
  }
  private async get(url: string): Promise<Record<string, unknown>> {
    const response = await this.network(url, { method: 'GET', headers: { accept: 'application/json' } });
    try { return await response.json() as Record<string, unknown>; } catch { throw new Error('This app returned an unreadable sign-in page.'); }
  }
  private async post(url: string, body: URLSearchParams | Record<string, unknown>): Promise<Record<string, unknown>> {
    const init: RequestInit = body instanceof URLSearchParams
      ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() }
      : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) };
    const response = await this.network(url, init);
    try { return await response.json() as Record<string, unknown>; } catch { throw new Error('This app returned an unreadable sign-in response.'); }
  }
  private async network(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await this.fetcher(url, { ...options, redirect: 'error', signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const body = await response.text();
      if (body.length > 1024 * 1024) throw new Error();
      return new Response(body, { status: response.status, headers: response.headers });
    } catch { throw new Error('Sign-in could not reach this app. Check the address and your connection, then try again.'); }
    finally { clearTimeout(timer); }
  }
  close() { for (const server of [...this.flows.keys()]) this.invalidate(server); }
}
