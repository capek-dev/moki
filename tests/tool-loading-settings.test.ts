import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolLoadingSettings } from '../src/electron/tool-loading';

const encryption = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text.split('').reverse().join('')), decryptString: (bytes: Buffer) => bytes.toString().split('').reverse().join('') };

test('smart-loading key and policy survive restart; public state excludes key; disconnect deletes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-tool-loading-'));
  try {
    const path = join(dir, 'settings.encrypted');
    const settings = new ToolLoadingSettings(path, encryption);
    expect(settings.handle({ action: 'status' })).toEqual({ enabled: false, maxDirect: 12, configured: false });
    expect(() => settings.handle({ action: 'save', enabled: true, maxDirect: 12 })).toThrow('API key');
    const state = settings.handle({ action: 'save', enabled: true, maxDirect: 7, key: 'private-key' });
    expect(state).toEqual({ enabled: true, maxDirect: 7, configured: true });
    expect(JSON.stringify(state)).not.toContain('private-key');
    expect(readFileSync(path, 'utf8')).not.toContain('private-key');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const reopened = new ToolLoadingSettings(path, encryption);
    expect(reopened.config()).toEqual({ enabled: true, maxDirect: 7, key: 'private-key' });
    reopened.handle({ action: 'save', enabled: false, maxDirect: 0 });
    expect(reopened.config().key).toBe('private-key');
    reopened.handle({ action: 'disconnect' });
    expect(reopened.config()).toEqual({ enabled: false, maxDirect: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid policy, unavailable encryption and corrupt ciphertext cannot overwrite saved bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moki-tool-loading-'));
  try {
    const path = join(dir, 'settings.encrypted');
    const settings = new ToolLoadingSettings(path, encryption);
    for (const maxDirect of [-1, 65, 1.5]) expect(() => settings.handle({ action: 'save', enabled: false, maxDirect })).toThrow();
    expect(() => settings.handle({ action: 'save', enabled: true, maxDirect: 12, key: 'bad\nkey' })).toThrow();
    expect(() => new ToolLoadingSettings(path, { ...encryption, isEncryptionAvailable: () => false }).handle({ action: 'save', enabled: true, maxDirect: 12, key: 'key' })).toThrow('Secure storage');
    writeFileSync(path, 'corrupt');
    expect(() => settings.handle({ action: 'save', enabled: false, maxDirect: 12 })).toThrow('not overwritten');
    expect(readFileSync(path, 'utf8')).toBe('corrupt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
