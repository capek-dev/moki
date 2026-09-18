import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { requireToolLoading, type ToolLoadingConfig, type ToolLoadingState } from '@shared/tool-loading';

interface Encryption { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
/** One encrypted record keeps the key and its opt-in policy atomic. Read lazily. */
export class ToolLoadingSettings {
  constructor(private path: string, private encryption: Encryption) {}
  config(): ToolLoadingConfig {
    let bytes: Buffer;
    try { bytes = readFileSync(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: false, maxDirect: 12 };
      throw new Error('Cannot read smart-loading settings.');
    }
    this.check();
    try {
      const data = JSON.parse(this.encryption.decryptString(bytes));
      if (data.version !== 1) throw new Error();
      return requireToolLoading(data);
    } catch { throw new Error('Saved smart-loading settings could not be decrypted or are invalid. They were not overwritten.'); }
  }
  private check() { if (!this.encryption.isEncryptionAvailable()) throw new Error('Secure storage is unavailable. Nothing was saved.'); }
  handle(command: unknown): ToolLoadingState {
    const input = command as { action?: unknown; enabled?: unknown; maxDirect?: unknown; key?: unknown };
    if (!input || !['status', 'save', 'disconnect'].includes(String(input.action))) throw new Error('Invalid smart-loading command.');
    let data = this.config();
    if (input.action !== 'status') {
      data = input.action === 'disconnect' ? { enabled: false, maxDirect: data.maxDirect }
        : requireToolLoading({ enabled: input.enabled, maxDirect: input.maxDirect, key: input.key === undefined ? data.key : input.key });
      if (data.enabled && !data.key) throw new Error('Add a TypeSafe API key before enabling smart loading.');
      this.check();
      const bytes = this.encryption.encryptString(JSON.stringify({ version: 1, ...data }));
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomBytes(8).toString('hex')}`;
      try { writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path); }
      catch { try { unlinkSync(temporary); } catch {} throw new Error('Could not securely save smart-loading settings.'); }
    }
    return { enabled: data.enabled, maxDirect: data.maxDirect, configured: Boolean(data.key) };
  }
}
