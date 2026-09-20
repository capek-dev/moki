import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';
import * as url from 'node:url';
import * as readline from 'node:readline';
import * as nodeCrypto from 'node:crypto';
import * as os from 'node:os';
import { Store } from '@backend/store';

test('preload strips Electron events and removes subscriptions', () => {
  const ipc = Object.assign(new EventEmitter(), { invoke: async (channel: string) => channel });
  let api: any;
  runInNewContext(readFileSync('dist/electron/preload.cjs', 'utf8'), {
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (name: string, value: unknown) => { expect(name).toBe('moki'); api = value; } } }),
  });
  const received: unknown[] = [];
  const unsubscribe = api.onState((...args: unknown[]) => received.push(args));
  const result = { revision: 3 };
  ipc.emit('moki:state', { privileged: true }, result);
  expect(received).toEqual([[result]]);
  unsubscribe();
  expect(ipc.listenerCount('moki:state')).toBe(0);
  const loading: unknown[] = [];
  const stop = api.onToolLoading((...args: unknown[]) => loading.push(args));
  ipc.emit('moki:tool-loading-state', { privileged: true }, { enabled: true, maxDirect: 12, configured: true });
  expect(loading).toEqual([[{ enabled: true, maxDirect: 12, configured: true }]]);
  stop(); expect(ipc.listenerCount('moki:tool-loading-state')).toBe(0);
});

// Execute the actual bundle with a private Electron/process harness. No global
// module mocks, native windows, backend processes, or servers are started.
test.each([{ development: false, packaged: false }, { development: true, packaged: false }, { development: false, packaged: true }])('window IPC and inspection controls: %j', async ({ development, packaged }) => {
  const appName = development ? 'Moki Dev' : 'Moki';
  const windows: FakeWindow[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  let menu: any[] = [];
  class FakeWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' }, sent: [] as any[], inspected: [] as number[], devTools: 0,
      openDevTools() { this.devTools++; },
      inspectElement(x: number, y: number) { this.inspected = [x, y]; },
      setWindowOpenHandler() {},
      session: { setPermissionRequestHandler() {} },
      send(channel: string, result: unknown) { this.sent.push({ channel, result }); },
    });
    shown = 0;
    hidden = 0;
    focused = 0;
    constructor(public options: any) { super(); windows.push(this); }
    static fromWebContents(contents: unknown) { return windows.find((w) => w.webContents === contents); }
    async loadFile(file: string, options?: { hash: string }) { this.webContents.mainFrame.url = url.pathToFileURL(file).href + (options ? '#' + options.hash : ''); }
    async loadURL(value: string) { this.webContents.mainFrame.url = value; }
    show() { this.shown++; }
    focus() { this.focused++; }
    hide() { this.hidden++; }
    isDestroyed() { return false; }
    setAlwaysOnTop() {}
  }
  const child = Object.assign(new EventEmitter(), {
    pid: 42, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, done) {
      const envelope = JSON.parse(chunk.toString());
      child.stdout.write(JSON.stringify({ id: envelope.id, result: { revision: 1, snapshot: { assistants: [], conversations: [], messages: [] } } }) + '\n');
      done();
    } }),
    kill() {},
  });
  const app = Object.assign(new EventEmitter(), {
    getAppPath: () => process.cwd(), requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), getPath: () => '/unused', quit() {}, isPackaged: packaged,
    setName(name: string) { expect(name).toBe(appName); },
    setPath(key: string, value: string) { expect(key).toBe('userData'); expect(value).toBe('/unused/' + appName); },
  });
  class Tray extends EventEmitter { setTitle() {} setToolTip() {} setContextMenu() {} }
  const modules: Record<string, unknown> = {
    electron: { app, BrowserWindow: FakeWindow, Tray, nativeImage: { createFromPath() { return { setTemplateImage() {} }; } },
      protocol: { registerSchemesAsPrivileged() {}, handle() {} },
      clipboard: { writeText() {} },
      globalShortcut: { register: () => true, unregisterAll() {} },
      safeStorage: {},
      ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) },
      Menu: { buildFromTemplate: (value: any[]) => Object.assign(value, { popup() { value[0].click(); } }), setApplicationMenu: (value: any[]) => { menu = value; } },
      dialog: { showErrorBox: (_title: string, message: string) => { throw new Error(message); } },
    },
    'node:path': path, 'node:url': url, 'node:readline': readline,
    'node:crypto': nodeCrypto, 'node:os': os, 'node:fs': {
      statSync() { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
      readFileSync() { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
      readdirSync: () => [] as string[],
      rmSync() {},
      mkdirSync(dir: string, options: unknown) { expect(options).toEqual({ recursive: true, mode: 0o700 }); expect(dir.startsWith('/unused/')).toBe(true); },
    }, 'node:http': {},
    'node:child_process': { spawn: () => child },
  };
  runInNewContext(readFileSync('dist/electron/main.cjs', 'utf8'), {
    require: (name: string) => { if (!(name in modules)) throw new Error(name); return modules[name]; },
    process: Object.assign(new EventEmitter(), { env: { MOKI_DEV: development || packaged ? '1' : undefined }, resourcesPath: '/unused' }), crypto, Buffer, setTimeout, clearTimeout,
    fetch: () => { throw new Error('Unexpected network'); },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  child.stdout.write(JSON.stringify({ event: 'ready', bun: '1.4.0', capekExports: 1 }) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const event = (w: FakeWindow) => ({ sender: w.webContents, senderFrame: w.webContents.mainFrame });
  const open = handlers.get('moki:settings')!;
  const request = handlers.get('moki:request')!;
  try {
    expect(windows).toHaveLength(1);
    expect(windows[0].options.title).toBe(appName);
    expect(menu.some((item) => item.label === 'Developer')).toBe(development);
    expect(windows[0].webContents.devTools).toBe(development ? 1 : 0);
    expect(() => handlers.get('moki:providers')!(event(windows[0]), { action: 'status' })).toThrow('only available in Settings');
    expect(() => handlers.get('moki:tool-loading')!(event(windows[0]), { action: 'status' })).toThrow('only available in Settings');
     await expect(request(event(windows[0]), { method: 'cuaTools' })).rejects.toThrow('only available in Settings');
     await expect(request(event(windows[0]), { method: 'learningRuns' })).rejects.toThrow('only available in Settings');
     await expect(request(event(windows[0]), { method: 'learningRetry', runId: 'run' })).rejects.toThrow('only available in Settings');
     await expect(handlers.get('moki:auth')!(event(windows[0]), { action: 'signIn', server: 'webby' })).rejects.toThrow('only available in Settings');
     await expect(request(event(windows[0]), { method: 'cuaSetTool', tool: 'click', disabled: true })).rejects.toThrow('only available in Settings');
     await expect(request(event(windows[0]), { method: 'cuaSetEnabled', enabled: false })).rejects.toThrow('only available in Settings');
    await open(event(windows[0]));
    expect(windows).toHaveLength(2);
    await open(event(windows[0]));
    expect(windows).toHaveLength(2);
    expect(windows[1].focused).toBe(1);
    expect(windows[1].webContents.mainFrame.url).toEndWith('#settings');
    expect(windows[1].options.webPreferences.sandbox).toBe(true);
    expect(handlers.get('moki:tool-loading')!(event(windows[1]), { action: 'status' })).toEqual({ enabled: false, maxDirect: 12, configured: false });
    expect(windows[0].webContents.sent.at(-1).channel).toBe('moki:tool-loading-state');
    await handlers.get('moki:history')!(event(windows[0]));
    expect(windows).toHaveLength(3);
    for (const w of windows) {
      expect(w.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
      expect(w.webContents.mainFrame.url.startsWith('http://127.0.0.1:5173/')).toBe(development);
      w.webContents.emit('context-menu', {}, { x: 12, y: 34 });
      expect(w.webContents.inspected).toEqual(development ? [12, 34] : []);
      const trusted = w.webContents.mainFrame.url;
      w.webContents.mainFrame.url = 'http://127.0.0.1:5173/untrusted';
      await expect(request(event(w), { method: 'snapshot' })).rejects.toThrow('Untrusted request');
      w.webContents.mainFrame.url = trusted;
    }
    const sentBeforeReads = windows.map(w => w.webContents.sent.length);
    for (const method of ['learningSettings', 'learningHistory', 'learningRuns', 'learningRunDetail', 'memorySettings', 'memoryList', 'memoryRead']) {
      await request(event(windows[1]), { method, runId: 'test', memoryId: 'test' });
    }
    expect(windows.map(w => w.webContents.sent.length)).toEqual(sentBeforeReads);
    const result = await request(event(windows[1]), { method: 'snapshot' });
    expect(result.revision).toBe(1);
    expect((await request(event(windows[1]), { method: 'cuaTools' })).revision).toBe(1);
    expect((await request(event(windows[1]), { method: 'cuaSetEnabled', enabled: false })).revision).toBe(1);
    await expect(request(event(windows[0]), { method: 'startChat', credentials: { key: 'injected' } })).rejects.toThrow('Unsupported request');
    await expect(handlers.get('moki:chat')!({ sender: {}, senderFrame: {} }, {})).rejects.toThrow('Untrusted request');
    await expect(handlers.get('moki:chat')!(event(windows[0]), { conversationId: 'x', text: '', model: 'gpt-5.4' })).rejects.toThrow('Invalid chat request');
    for (const w of windows) expect(w.webContents.sent.at(-1)).toEqual({ channel: 'moki:state', result });
    expect(() => open({ sender: {}, senderFrame: {} })).toThrow('Untrusted request');
    await expect(request({ sender: windows[1].webContents, senderFrame: { url: windows[1].webContents.mainFrame.url } }, {})).rejects.toThrow('Untrusted request');
    let prevented = false;
    windows[1].emit('close', { preventDefault() { prevented = true; } });
    expect(prevented).toBe(true);
    expect(windows[1].hidden).toBe(1);
    expect(windows[0].hidden).toBe(0);
    expect(menu[0].submenu.some((item: any) => item.accelerator === 'CmdOrCtrl+,')).toBe(true);
    child.stdout.write(JSON.stringify({ event: 'state', result: { ...result, revision: 2 } }) + '\n');
    expect(windows[0].webContents.sent.at(-1).result.revision).toBe(2);
    const runId = '00000000-0000-4000-8000-000000000001';
    const openReview = handlers.get('moki:open-learning-review')!;
    await expect(openReview(event(windows[0]), runId)).rejects.toThrow('Settings only');
    await openReview(event(windows[1]), runId);
    const review = windows.at(-1)!;
    expect(review.webContents.mainFrame.url).toEndWith('#learning-review');
    await openReview(event(windows[1]), runId);
    expect(windows).toHaveLength(4);
    await expect(request(event(review), { method: 'createConversation' })).rejects.toThrow('read-only');
    await expect(handlers.get('moki:chat')!(event(review), {})).rejects.toThrow('read-only');
    await expect(handlers.get('moki:read-learning-review')!(event(windows[0]))).rejects.toThrow('Not a learning review');
    const chatEvents = windows[0].webContents.sent.length;
    child.stdout.write(JSON.stringify({ event: 'state', result: { learningLiveOutput: { runId, text: 'partial review' } } }) + '\n');
    expect(windows[0].webContents.sent.length).toBe(chatEvents);
    expect(review.webContents.sent.at(-1)).toEqual({ channel: 'moki:learning-review', result: { output: { runId, text: 'partial review' } } });
    expect((await handlers.get('moki:read-learning-review')!(event(review))).output.text).toBe('partial review');
    child.stdout.write(JSON.stringify({ event: 'state', result: { learningLiveCleared: true } }) + '\n');
    expect((await handlers.get('moki:read-learning-review')!(event(review))).output).toBeUndefined();
    child.emit('exit');
    expect(windows[0].webContents.sent.at(-1).channel).toBe('moki:runtime-error');
    child.stdout.write(JSON.stringify({ event: 'state', result }) + '\n');
    expect(windows[0].webContents.sent.at(-1).channel).toBe('moki:runtime-error');
  } finally {
    child.emit('exit'); child.stdout.end(); child.stderr.end(); child.stdin.end();
  }
});

test('initial Moki instructions preserve the complete text through Settings save', async () => {
  const store = new Store(':memory:');
  try {
    const assistant = store.snapshot().assistants.find((item) => item.id === 'moki')!;
    const instructions = 'instruction '.repeat(1300).slice(0, 15_999);
    const result = store.handle({ method: 'saveAssistant', assistant: { ...assistant, instructions } });
    expect(result.snapshot.assistants.find((item) => item.id === 'moki')?.instructions).toBe(instructions);
    const source = await Bun.file('src/renderer/windows/settings-window.tsx').text();
    expect(source).toContain('value={draft.instructions}');
    expect(source).not.toContain('draft.instructions.slice');
  } finally { store.close(); }
});