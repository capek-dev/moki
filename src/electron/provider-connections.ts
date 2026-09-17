import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { listenForOAuth, type CallbackListener } from './oauth-listener';
import type { ProviderCommand, ProviderState } from '../shared/protocol';

const CLIENT = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REDIRECT = 'http://localhost:1455/auth/callback';
interface Secrets { version: 1; deepseek?: string; codex?: { access: string; refresh: string; expires: number; accountId: string } }
interface Encryption { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
export interface Vault { read(): Secrets; write(value: Secrets): void }
export class EncryptedVault implements Vault {
  constructor(private path: string, private encryption: Encryption) {}
  private check() { if (!this.encryption.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable. Nothing was saved.'); }
  read(): Secrets {
    this.check();
    let bytes: Buffer;
    try { bytes = readFileSync(this.path); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 }; throw new Error('Cannot read saved credentials.'); }
    try {
      const data = JSON.parse(this.encryption.decryptString(bytes));
      if (data?.version !== 1 || (data.deepseek !== undefined && !validString(data.deepseek)) || (data.codex !== undefined && (!validString(data.codex.access) || !validString(data.codex.refresh) || !validString(data.codex.accountId) || !Number.isFinite(data.codex.expires)))) throw new Error();
      return data;
    } catch { throw new Error('Saved credentials could not be decrypted or are invalid. They were not overwritten.'); }
  }
  write(value: Secrets) {
    this.check();
    const encrypted = this.encryption.encryptString(JSON.stringify(value));
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + '.' + randomBytes(8).toString('hex');
    try { writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path); }
    catch { try { unlinkSync(temporary); } catch {} throw new Error('Could not securely save credentials.'); }
  }
}
function validString(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 32000; }

export class ProviderConnections {
  private secrets?: Secrets;
  private flow?: { state: string; verifier: string; expires: number; used: boolean };
  private generation = { deepseek: 0, codex: 0 };
  private operations = new Map<string, AbortController>();
  private revision = 0;
  private stopListener?: () => void;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private authError?: string;
  private cleanupListener() {
    this.stopListener?.(); this.stopListener = undefined;
    clearTimeout(this.expiryTimer); this.expiryTimer = undefined;
  }
  constructor(private vault: Vault, private open: (url: string) => Promise<void>, private changed: (state: ProviderState) => void, private fetcher: typeof fetch = fetch, private now = Date.now, private listen: CallbackListener = listenForOAuth) {}
  private load() { return this.secrets ??= this.vault.read(); }
  status(): ProviderState {
    const data = this.load();
    return { error: this.authError, revision: this.revision, deepseek: { connected: !!data.deepseek }, codex: { connected: !!data.codex }, signingIn: !!this.flow && this.flow.expires > this.now() };
  }
  private emit() { this.revision++; this.changed(this.status()); }
  private invalidate(provider: 'deepseek' | 'codex') {
    this.generation[provider]++;
    this.operations.get(provider)?.abort(); this.operations.delete(provider);
    if (provider === 'codex') { this.flow = undefined; this.cleanupListener(); this.authError = undefined; this.operations.get('codex-refresh')?.abort(); this.operations.delete('codex-refresh'); }
  }
  private persist(next: Secrets) { this.vault.write(next); this.secrets = next; this.emit(); }
  async handle(input: unknown): Promise<ProviderState> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid provider request.');
    const command = input as ProviderCommand;
    this.load();
    switch (command.action) {
      case 'status': return this.status();
      case 'disconnect': {
        if (command.provider !== 'deepseek' && command.provider !== 'codex') throw new Error('Unsupported provider.');
        this.invalidate(command.provider);
        const next = { ...this.load() }; delete next[command.provider]; this.persist(next); break;
      }
      case 'cancelCodex': this.invalidate('codex'); this.emit(); break;
      case 'startCodex': {
        this.invalidate('codex');
        const state = randomBytes(32).toString('base64url');
        const verifier = randomBytes(32).toString('base64url');
        const flow = this.flow = { state, verifier, expires: this.now() + 300000, used: false };
        const loginGeneration = this.generation.codex;
        const url = new URL('https://auth.openai.com/oauth/authorize');
        url.search = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, scope: 'openid profile email offline_access', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'moki' }).toString();
        try {
          const stop = await this.listen(async (callback) => {
            if (this.flow !== flow) throw new Error('Sign-in is no longer active.');
            try { await this.handle({ action: 'completeCodex', url: callback }); }
            catch (error) {
              if (loginGeneration === this.generation.codex) {
                this.authError = 'Sign-in could not be completed. Start again.'; this.emit();
              }
              throw error;
            }
          });
          if (this.flow !== flow) { stop(); throw new Error('Sign-in cancelled.'); }
          this.stopListener = stop;
          this.expiryTimer = setTimeout(() => {
            if (this.flow !== flow) return;
            this.invalidate('codex'); this.authError = 'Sign-in expired. Start again.'; this.emit();
          }, 300000);
          this.expiryTimer.unref();
          this.emit();
          await this.open(url.href);
        } catch (error) {
          if (this.flow === flow) { this.invalidate('codex'); this.emit(); }
          throw error instanceof Error ? error : new Error('Could not start sign-in.');
        }
        break;
      }
      case 'saveDeepseek': {
        if (!validString(command.key) || command.key.length > 1000 || /\s/.test(command.key)) throw new Error('Enter a valid DeepSeek key.');
        this.invalidate('deepseek');
        const generation = this.generation.deepseek;
        const response = await this.network('deepseek', 'https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${command.key}` } });
        let models: unknown;
        try { models = await response.json(); } catch { throw new Error('Invalid provider response. Key was not saved.'); }
        if (!models || typeof models !== 'object' || !Array.isArray((models as { data?: unknown }).data)) throw new Error('Invalid provider response. Key was not saved.');
        if (generation !== this.generation.deepseek) throw new Error('Connection cancelled.');
        this.persist({ ...this.load(), deepseek: command.key }); break;
      }
      case 'completeCodex': {
        const flow = this.flow;
        if (flow?.used) throw new Error('Sign-in expired or already used. Start again.');
        if (!flow || flow.expires <= this.now()) { this.invalidate('codex'); this.emit(); throw new Error('Sign-in expired or already used. Start again.'); }
        let url: URL;
        try { if (!validString(command.url)) throw new Error(); url = new URL(command.url); } catch { throw new Error('Paste the complete callback URL from your browser.'); }
        const redirect = new URL(REDIRECT);
        if (url.origin !== redirect.origin || url.pathname !== redirect.pathname || url.username || url.password || url.hash || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== flow.state) throw new Error('Callback does not match this sign-in.');
        if (url.searchParams.has('error')) { this.invalidate('codex'); this.emit(); throw new Error('Sign-in was declined.'); }
        const code = url.searchParams.get('code');
        if (!validString(code) || url.searchParams.getAll('code').length !== 1) throw new Error('Callback is missing its authorization code.');
        flow.used = true;
        const generation = this.generation.codex;
        try {
          const response = await this.network('codex', 'https://auth.openai.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: flow.verifier }).toString() });
          const tokens = await response.json() as Record<string, unknown>;
          if (!validString(tokens.access_token) || !validString(tokens.refresh_token) || !validString(tokens.id_token)) throw new Error('Invalid sign-in response.');
          // Metadata only, obtained directly from the fixed HTTPS token endpoint.
          const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1] ?? '', 'base64url').toString());
          const accountId = claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? claims?.chatgpt_account_id;
          if (!validString(accountId) || typeof tokens.expires_in !== 'number' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error('Invalid subscription identity.');
          if (generation !== this.generation.codex || this.flow !== flow) throw new Error('Sign-in cancelled.');
          this.flow = undefined;
          this.authError = undefined;
          this.persist({ ...this.load(), codex: { access: tokens.access_token, refresh: tokens.refresh_token, accountId, expires: this.now() + tokens.expires_in * 1000 } });
        } catch {
          throw new Error('Sign-in could not be completed. Start again. Any previous connection was kept.');
        } finally { if (generation === this.generation.codex) { this.flow = undefined; this.cleanupListener(); this.emit(); } }
        break;
      }
      default: throw new Error('Unsupported provider request.');
    }
    return this.status();
  }
  private async network(provider: string, url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController(); this.operations.set(provider, controller);
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await this.fetcher(url, { ...options, redirect: 'error', signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      // Read body within the timeout, not after releasing the abort controller.
      const body = await response.text();
      if (body.length > 1024 * 1024) throw new Error();
      return new Response(body, { status: response.status, headers: response.headers });
    } catch { throw new Error('Provider request failed. Check credentials and connection, then try again.'); }
    finally { clearTimeout(timer); if (this.operations.get(provider) === controller) this.operations.delete(provider); }
  }
  private refresh?: { generation: number; promise: Promise<void> };
  // Main-process-only access. Never return this value through renderer IPC.
  async credentials(provider: 'deepseek' | 'codex'): Promise<import('../backend/chat').Credentials> {
    if (provider === 'deepseek') {
      const key = this.load().deepseek;
      if (!key) throw new Error('Connect DeepSeek in Settings first.');
      return { provider, key };
    }
    if (provider !== 'codex') throw new Error('Unsupported provider.');
    const original = this.load().codex;
    if (!original) throw new Error('Sign in to Codex in Settings first.');
    const generation = this.generation.codex;
    if (original.expires <= this.now() + 60000) {
      if (!this.refresh || this.refresh.generation !== generation) {
        const promise = (async () => {
          const response = await this.network('codex-refresh', 'https://auth.openai.com/oauth/token', {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: original.refresh, client_id: CLIENT }).toString(),
          });
          const tokens = await response.json() as Record<string, unknown>;
          if (!validString(tokens.access_token) || (tokens.refresh_token !== undefined && !validString(tokens.refresh_token)) || typeof tokens.expires_in !== 'number' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error('Invalid refresh response.');
          if (tokens.id_token !== undefined) {
            if (!validString(tokens.id_token)) throw new Error('Invalid refresh identity.');
            const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1] ?? '', 'base64url').toString());
            const accountId = claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? claims?.chatgpt_account_id;
            if (accountId && accountId !== original.accountId) throw new Error('Refresh identity changed.');
          }
          if (generation !== this.generation.codex || this.load().codex !== original) throw new Error('Connection changed.');
          this.persist({ ...this.load(), codex: { ...original, access: tokens.access_token, refresh: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : original.refresh, expires: this.now() + tokens.expires_in * 1000 } });
        })();
        this.refresh = { generation, promise };
      }
      const current = this.refresh;
      try { await current.promise; }
      catch { throw new Error('Could not refresh Codex. Check your connection or sign in again in Settings.'); }
      finally { if (this.refresh === current) this.refresh = undefined; }
    }
    if (generation !== this.generation.codex || !this.load().codex) throw new Error('Connection changed. Send again.');
    const saved = this.load().codex!;
    return { provider: 'codex', access: saved.access, accountId: saved.accountId };
  }
  close() { this.invalidate('deepseek'); this.invalidate('codex'); }
}
