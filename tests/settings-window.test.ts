import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';
import * as url from 'node:url';
import * as readline from 'node:readline';
import * as nodeCrypto from 'node:crypto';

test('preload strips Electron events and removes subscriptions', () => {
  const ipc = Object.assign(new EventEmitter(), { invoke: async (channel: string) => channel });
  let api: any;
  runInNewContext(readFileSync('dist/electron/preload.cjs', 'utf8'), {
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name: string, value: unknown) => { api = value; } } }),
  });
  const received: unknown[] = [];
  const unsubscribe = api.onState((...args: unknown[]) => received.push(args));
  const result = { revision: 3 };
  ipc.emit('povondra:state', { privileged: true }, result);
  expect(received).toEqual([[result]]);
  unsubscribe();
  expect(ipc.listenerCount('povondra:state')).toBe(0);
});

// Execute the actual bundle with a private Electron/process harness. No global
// module mocks, native windows, backend processes, or servers are started.
test('settings is singleton, registered IPC broadcasts updates, and closing preserves windows', async () => {
  const windows: FakeWindow[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  let menu: any[] = [];
  class FakeWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' }, sent: [] as any[],
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
    whenReady: () => Promise.resolve(), getPath: () => '/unused', quit() {}, isPackaged: false,
  });
  class Tray extends EventEmitter { setTitle() {} setToolTip() {} setContextMenu() {} }
  const modules: Record<string, unknown> = {
    electron: { app, BrowserWindow: FakeWindow, Tray, nativeImage: { createEmpty() {} },
      ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) },
      Menu: { buildFromTemplate: (value: any[]) => value, setApplicationMenu: (value: any[]) => { menu = value; } },
      dialog: { showErrorBox: (_title: string, message: string) => { throw new Error(message); } },
    },
    'node:path': path, 'node:url': url, 'node:readline': readline,
    'node:crypto': nodeCrypto, 'node:fs': {}, 'node:http': {},
    'node:child_process': { spawn: () => child },
  };
  runInNewContext(readFileSync('dist/electron/main.cjs', 'utf8'), {
    require: (name: string) => { if (!(name in modules)) throw new Error(name); return modules[name]; },
    process: { env: {}, resourcesPath: '/unused' }, crypto, Buffer, setTimeout, clearTimeout,
    fetch: () => { throw new Error('Unexpected network'); },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  child.stdout.write(JSON.stringify({ event: 'ready', bun: '1.4.0', capekExports: 1 }) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const event = (w: FakeWindow) => ({ sender: w.webContents, senderFrame: w.webContents.mainFrame });
  const open = handlers.get('povondra:settings')!;
  const request = handlers.get('povondra:request')!;
  try {
    expect(windows).toHaveLength(1);
    expect(() => handlers.get('povondra:providers')!(event(windows[0]), { action: 'status' })).toThrow('only available in Settings');
    await open(event(windows[0]));
    expect(windows).toHaveLength(2);
    await open(event(windows[0]));
    expect(windows).toHaveLength(2);
    expect(windows[1].focused).toBe(1);
    expect(windows[1].webContents.mainFrame.url).toEndWith('#settings');
    expect(windows[1].options.webPreferences.sandbox).toBe(true);
    const result = await request(event(windows[1]), { method: 'snapshot' });
    expect(result.revision).toBe(1);
    await expect(request(event(windows[0]), { method: 'startChat', credentials: { key: 'injected' } })).rejects.toThrow('Unsupported request');
    await expect(handlers.get('povondra:chat')!({ sender: {}, senderFrame: {} }, {})).rejects.toThrow('Untrusted request');
    await expect(handlers.get('povondra:chat')!(event(windows[0]), { conversationId: 'x', text: '', model: 'gpt-5.4' })).rejects.toThrow('Invalid chat request');
    for (const w of windows) expect(w.webContents.sent.at(-1)).toEqual({ channel: 'povondra:state', result });
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
    child.emit('exit');
    expect(windows[0].webContents.sent.at(-1).channel).toBe('povondra:runtime-error');
    child.stdout.write(JSON.stringify({ event: 'state', result }) + '\n');
    expect(windows[0].webContents.sent.at(-1).channel).toBe('povondra:runtime-error');
  } finally {
    child.emit('exit'); child.stdout.end(); child.stderr.end(); child.stdin.end();
  }
});
