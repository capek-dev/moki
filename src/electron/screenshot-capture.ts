import { nativeImage, shell, type BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentDirectories, requireAttachmentId, validatePng } from '@shared/attachments';
import type { CaptureEvent } from '@shared/protocol';

export class ScreenshotCapture {
  private child?: ChildProcess;
  private activePath?: string;
  private readonly drafts: string;
  constructor(private dataDir: string, private target: () => BrowserWindow | undefined) {
    this.drafts = attachmentDirectories(dataDir).drafts;
    mkdirSync(this.drafts, { recursive: true, mode: 0o700 });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of readdirSync(this.drafts)) {
      const path = join(this.drafts, name);
      try { if (name.endsWith('.png') && statSync(path).mtimeMs < cutoff) rmSync(path, { force: true }); } catch { /* Cleanup is best-effort. */ }
    }
  }
  private send(event: CaptureEvent) {
    const target = this.target();
    if (target && !target.isDestroyed()) target.webContents.send('moki:capture', event);
  }
  async start(): Promise<void> {
    if (this.child) { this.target()?.focus(); return; }
    if (process.platform !== 'darwin') throw new Error('Region capture currently requires macOS.');
    const target = this.target();
    const wasVisible = target?.isVisible() ?? false;
    const id = crypto.randomUUID();
    const path = join(this.drafts, `${id}.png`);
    this.activePath = path;
    target?.hide();
    this.send({ type: 'capture-started' });
    await new Promise<void>((resolve) => {
      const child = spawn('/usr/sbin/screencapture', ['-i', '-s', '-x', '-t', 'png', path], { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
      this.child = child;
      let diagnostic = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => { diagnostic = (diagnostic + chunk).slice(-4096); });
      let settled = false;
      const finish = (event: CaptureEvent, showWindow: boolean) => {
        if (settled) return;
        settled = true; this.child = undefined; this.activePath = undefined;
        if (showWindow) { target?.show(); target?.focus(); }
        this.send(event); resolve();
      };
      child.once('error', () => { rmSync(path, { force: true }); finish({ type: 'capture-failed', message: 'Moki could not start the macOS region selector.' }, true); });
      child.once('exit', (code) => {
        try {
          if (code !== 0) {
            rmSync(path, { force: true });
            const denied = /denied|permission|not authorized|could not create image/i.test(diagnostic);
            finish(denied
              ? { type: 'capture-failed', message: 'Screen capture failed. Allow Moki Dev in System Settings > Privacy & Security > Screen Recording, then restart Moki.' }
              : { type: 'capture-cancelled' }, denied || wasVisible);
            return;
          }
          const stat = statSync(path);
          const bytes = readFileSync(path);
          if (!stat.isFile()) throw new Error('Invalid screenshot.');
          const dimensions = validatePng(bytes);
          const image = nativeImage.createFromBuffer(bytes);
          if (image.isEmpty()) throw new Error('Invalid screenshot.');
          finish({ type: 'capture-ready', attachment: { id, mime: 'image/png', ...dimensions } }, true);
        } catch {
          rmSync(path, { force: true });
          finish({ type: 'capture-failed', message: 'The selected region could not be saved. Check Moki Dev in System Settings > Privacy & Security > Screen Recording, then restart Moki.' }, true);
        }
      });
    });
  }
  remove(id: unknown) { rmSync(join(this.drafts, `${requireAttachmentId(id)}.png`), { force: true }); }
  openPermissionSettings() { return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'); }
  close() {
    this.child?.kill('SIGTERM');
    if (this.activePath) rmSync(this.activePath, { force: true });
    this.activePath = undefined; this.child = undefined;
  }
}
