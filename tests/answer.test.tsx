import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { Answer } from '@renderer/components/chat/answer';
import { CopyButton } from '@renderer/components/chat/copy-button';
import { requireCopyText, requireWebLink, webLink } from '@shared/answer-actions';

const render = (text: string) => renderToStaticMarkup(<Answer text={text} />);

test('renders headings, lists, inline code, quotes, tables and fenced code', () => {
  const html = render('# Heading\n\n**Bold** and *italic* with `inline`\n\n- one\n- two\n\n> quote\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```');
  for (const expected of ['<h1>', '<strong>', '<em>', '<ul>', '<li>', '<blockquote>', '<table>', '<code', '<pre>', 'Copy code', 'Copy answer']) expect(html).toContain(expected);
  expect(html).toContain('class="answer-code"');
});

test('code blocks scroll inside their box instead of stretching the conversation', async () => {
  const css = await Bun.file('src/renderer/styles/tailwind.css').text();
  // The answer shell is a grid item; without min-width:0 the track widens to
  // the longest code line even though the pre itself scrolls.
  expect(css).toContain('.answer-shell { min-width: 0; max-width: 100%; }');
  expect(css).toContain('.answer-code { min-width: 0; max-width: 100%; overflow: hidden;');
  expect(css).toContain('.answer-code pre { margin: 0; padding: .75rem; max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain; white-space: pre; overflow-wrap: normal; }');
  // Wide tables get the same treatment.
  expect(css).toContain('.answer-table { max-width: 100%; overflow-x: auto; }');
});

test('raw HTML and remote images cannot create active content', () => {
  const html = render('<script>alert(1)</script>\n\n<iframe src="https://evil.test"></iframe>\n\n<img src="https://evil.test/pixel" onerror="alert(1)">\n\n![Diagram](https://evil.test/pixel)\n\n[safe](https://example.com) [bad](javascript:alert%281%29) [file](file:///etc/passwd)');
  for (const blocked of ['<script', '<iframe', '<img', 'onerror', 'javascript:', 'file:', 'evil.test']) expect(html).not.toContain(blocked);
  expect(html).toContain('[Image: Diagram]');
  expect(html).toContain('href="https://example.com/"');
});

test('unfinished streaming Markdown and code are safe to render', () => {
  expect(render('**partial')).toContain('**partial');
  expect(render('```html\n<script>')).toContain('&lt;script&gt;');
  expect(render('```html\n<script>')).toContain('Copy code');
});

test('external URLs and clipboard payloads fail closed', () => {
  for (const bad of [null, {}, 42, '', '/relative', '//host.test', 'file:///tmp/x', 'javascript:alert(1)', 'data:text/html,hi', 'mailto:a@b.test', 'https://user:pass@example.com', 'https://example.com\n', 'https://' + 'x'.repeat(8200)]) {
    expect(webLink(bad)).toBeUndefined();
    expect(() => requireWebLink(bad)).toThrow();
  }
  expect(requireWebLink('https://example.com/a?q=1#b')).toBe('https://example.com/a?q=1#b');
  expect(requireWebLink('http://example.com')).toBe('http://example.com/');
  expect(requireCopyText('  code\n\t\n')).toBe('  code\n\t\n');
  for (const bad of [null, {}, 42, 'x'.repeat(1_000_001)]) expect(() => requireCopyText(bad)).toThrow();
});

// All DOM globals are scoped and restored, with no process-wide module mocks.
let dom: Window;
let root: Root;
let container: HTMLElement;
let originals: Map<string, PropertyDescriptor | undefined>;
beforeEach(() => {
  dom = new Window();
  originals = new Map();
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await dom.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const mount = async (node: ReactNode) => { await act(async () => root.render(node)); };
const click = async (label: string) => {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => button!.click());
};

test('answer copy uses a hover action and preserves Markdown while code copy excludes fences', async () => {
  const copied: string[] = [];
  window.moki = { copyText: async (text: string) => { copied.push(text); } } as typeof window.moki;
  const text = '**Hello**\n\n```ts\n  const x = 1;\n\n```';
  await mount(<Answer text={text} />);
  const answerAction = container.querySelector('.answer-copy');
  expect(answerAction).not.toBeNull();
  expect(answerAction!.textContent).not.toContain('Copy answer');
  expect(answerAction!.querySelector('svg')).not.toBeNull();
  await click('Copy code');
  await click('Copy answer');
  expect(copied).toEqual(['  const x = 1;\n\n', text]);
  expect(container.textContent).toContain('Copied');
});

test('copy waits for completion, reports failure, and allows retry', async () => {
  let reject!: (reason: Error) => void;
  let attempts = 0;
  const write = () => ++attempts === 1 ? new Promise<void>((_, fail) => { reject = fail; }) : Promise.resolve();
  await mount(<CopyButton text="hello" label="Copy answer" write={write} />);
  await click('Copy answer');
  expect(container.textContent).not.toContain('Copied');
  expect(container.querySelector('button')!.disabled).toBe(true);
  await act(async () => reject(new Error('Denied')));
  expect(container.textContent).toContain('Copy failed. Try again.');
  await click('Copy answer');
  expect(attempts).toBe(2);
  expect(container.textContent).toContain('Copied');
});

test('text updates clear feedback and ignore obsolete clipboard completion', async () => {
  let resolve!: () => void;
  const write = () => new Promise<void>((done) => { resolve = done; });
  await mount(<CopyButton text="partial" label="Copy answer" write={write} />);
  await click('Copy answer');
  await mount(<CopyButton text="partial updated" label="Copy answer" write={write} />);
  await act(async () => resolve());
  expect(container.textContent).not.toContain('Copied');
  expect(container.querySelector('button')!.disabled).toBe(false);
});

test('web links open only on click through the bridge and expose failures', async () => {
  const opened: string[] = [];
  window.moki = { openWebLink: async (url: string): Promise<void> => { opened.push(url); throw new Error('Unavailable'); } } as typeof window.moki;
  await mount(<Answer text="[Example](https://example.com)" />);
  expect(opened).toEqual([]);
  await act(async () => container.querySelector('a')!.click());
  expect(opened).toEqual(['https://example.com/']);
  expect(container.textContent).toContain('Could not open link.');
});

test('IPC handlers retain sender checks and validate before privileged operations', async () => {
  const main = await Bun.file('src/electron/main.ts').text();
  expect(main).toContain("ipcMain.handle('moki:copy-text', (event, text: unknown) => {\n      assertTrusted(event);\n      clipboard.writeText(requireCopyText(text));");
  expect(main).toContain("ipcMain.handle('moki:open-web-link', (event, url: unknown) => {\n      assertTrusted(event);\n      return shell.openExternal(requireWebLink(url));");
  expect(main).toContain("setWindowOpenHandler(() => ({ action: 'deny' }))");
});
