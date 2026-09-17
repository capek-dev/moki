import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttachmentImage } from '@renderer/components/chat/attachment-image';
import { attachmentUrl, MAX_IMAGE_BYTES, requireAttachmentId, validatePng } from '@shared/attachments';
import { supportsImageInput } from '@shared/models';

const id = '123e4567-e89b-42d3-a456-426614174000';
function png(width = 640, height = 360) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

test('attachment identifiers, preview URLs and PNG metadata fail closed', () => {
  expect(requireAttachmentId(id)).toBe(id);
  expect(attachmentUrl(id)).toBe(`moki-attachment://${id}/`);
  for (const bad of ['', '../secret', '123', `${id}/../secret`, null]) expect(() => requireAttachmentId(bad)).toThrow('Invalid attachment');
  expect(validatePng(png())).toEqual({ byteSize: 24, width: 640, height: 360 });
  expect(() => validatePng(new Uint8Array(24))).toThrow('Invalid screenshot');
  expect(() => validatePng(png(8193, 1))).toThrow('dimensions');
  expect(() => validatePng(new Uint8Array(MAX_IMAGE_BYTES + 1))).toThrow('Invalid screenshot');
});

test('image capability is explicit per curated model', () => {
  expect(supportsImageInput('deepseek', 'deepseek-flash')).toBe(true);
  expect(() => supportsImageInput('deepseek', 'deepseek-v4-pro')).toThrow('supported model');
  for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra']) expect(supportsImageInput('codex', model)).toBe(true);
});

test('screenshot preview uses only the validated app protocol and has accessible controls', () => {
  const html = renderToStaticMarkup(<AttachmentImage attachment={{ id, mime: 'image/png', byteSize: 24, width: 640, height: 360 }} removable />);
  expect(html).toContain(`src="moki-attachment://${id}/"`);
  expect(html).toContain('alt="Captured screen region"');
  expect(html).toContain('aria-label="Remove screenshot"');
  expect(html).not.toContain('file:');
});

test('native capture and preview boundaries do not accept renderer paths or shell commands', async () => {
  const [capture, main, preload, app, html, pkg] = await Promise.all([
    Bun.file('src/electron/screenshot-capture.ts').text(),
    Bun.file('src/electron/main.ts').text(),
    Bun.file('src/electron/preload.ts').text(),
    Bun.file('src/renderer/windows/chat-window.tsx').text(),
    Bun.file('src/renderer/index.html').text(),
    Bun.file('package.json').json(),
  ]);
  expect(capture).toContain("spawn('/usr/sbin/screencapture', ['-i', '-s', '-x', '-t', 'png', path], { shell: false");
  expect(capture).not.toContain("systemPreferences.getMediaAccessStatus('screen')");
  expect(capture).toContain("stdio: ['ignore', 'ignore', 'pipe']");
  expect(capture).toContain("type: 'capture-cancelled'");
  expect(main).toContain("globalShortcut.register('CommandOrControl+Shift+8'");
  expect(main).toContain("protocol.handle('moki-attachment'");
  expect(main).toContain('requireAttachmentId(url.hostname)');
  expect(preload).toContain("ipcRenderer.invoke('moki:start-capture')");
  expect(preload).not.toContain('path');
  expect(app).toContain('if (picked.id !== conversationRef.current) discardAttachment()');
  expect(app).toContain('if (result) { discardAttachment(); setConversationId(result.conversationId); }');
  expect(capture).toContain('if (this.activePath) rmSync(this.activePath, { force: true })');
  expect(html).toContain("img-src 'self' data: moki-attachment:");
  expect(pkg.build.mac.extendInfo.NSScreenCaptureUsageDescription).toContain('screen region');
});
