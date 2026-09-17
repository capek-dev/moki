import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray, safeStorage, shell } from 'electron';
import { EncryptedVault, ProviderConnections } from './provider-connections';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Runtime } from './runtime';
import { requireThinking } from '../shared/models';
import type { ChatRequest, Request, Result } from '../shared/protocol';

let window: BrowserWindow | undefined;
let settings: BrowserWindow | undefined;
let history: BrowserWindow | undefined;
const registered = new Map<BrowserWindow, string>();
const pendingChats = new Map<string, object>();
function broadcast(result: Result) {
  for (const target of registered.keys()) if (!target.isDestroyed()) target.webContents.send('povondra:state', result);
  return result;
}
let tray: Tray | undefined;
let runtime: Runtime | undefined;
let providers: ProviderConnections | undefined;
let quitting = false;
let shutdownComplete = false;
// macOS gets real window glass (vibrancy behind translucent panels); other
// platforms fall back to a solid neutral page.
const glassWindow = process.platform === 'darwin'
  ? { vibrancy: 'under-window' as const, titleBarStyle: 'hiddenInset' as const, backgroundColor: '#00000000' }
  : { backgroundColor: '#f4f4f6' };
// Electron resolves this at runtime, including inside packaged app.asar.
// Bun can inline __dirname as the original source directory during bundling.
const appRoot = app.getAppPath();
const page = join(appRoot, 'dist/renderer/index.html');
function show() { window?.show(); window?.focus(); }
function secureWindow(target: BrowserWindow, hash = '') {
  registered.set(target, pathToFileURL(page).href + hash);
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', (event) => event.preventDefault());
  target.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.on('closed', () => registered.delete(target));
}
function assertTrusted(event: Electron.IpcMainInvokeEvent) {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || !registered.has(target) || event.senderFrame !== target.webContents.mainFrame || event.senderFrame.url !== registered.get(target)) throw new Error('Untrusted request.');
}
async function openSettings() {
  if (quitting) return;
  if (settings) { settings.show(); settings.focus(); return; }
  settings = new BrowserWindow({
    width: 640, height: 720, minWidth: 400, minHeight: 500,
    title: 'Povondra Settings',
    webPreferences: { preload: join(appRoot, 'dist/electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    ...glassWindow,
  });
  secureWindow(settings, '#settings');
  settings.on('close', (event) => { if (!quitting) { event.preventDefault(); settings?.hide(); } });
  settings.on('closed', () => { settings = undefined; });
  await settings.loadFile(page, { hash: 'settings' });
}
async function openHistory() {
  if (quitting) return;
  if (history) { history.show(); history.focus(); return; }
  history = new BrowserWindow({
    width: 380, height: 520, minWidth: 300, minHeight: 360,
    title: 'Povondra History',
    webPreferences: { preload: join(appRoot, 'dist/electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    ...glassWindow,
  });
  secureWindow(history, '#history');
  // History is transient: closing it closes it, no hide-and-keep.
  history.on('closed', () => { history = undefined; });
  await history.loadFile(page, { hash: 'history' });
}
function showSettings() {
  void openSettings().catch((error) => dialog.showErrorBox('Could not open settings', String(error)));
}
function showHistory() {
  void openHistory().catch((error) => dialog.showErrorBox('Could not open history', String(error)));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.whenReady().then(async () => {
    const binary = app.isPackaged
      ? join(process.resourcesPath, 'backend/povondra-runtime')
      : join(appRoot, 'dist/backend/povondra-runtime');
    runtime = new Runtime(binary, app.getPath('userData'), broadcast, (message) => {
      for (const target of registered.keys()) if (!target.isDestroyed()) target.webContents.send('povondra:runtime-error', message);
    });
    await runtime.ready;
    window = new BrowserWindow({
      width: 440, height: 680, minWidth: 360, minHeight: 480,
      title: 'Povondra',
      webPreferences: { preload: join(appRoot, 'dist/electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
      ...glassWindow,
    });
    secureWindow(window);
    providers = new ProviderConnections(new EncryptedVault(join(app.getPath('userData'), 'providers.encrypted'), safeStorage), (url) => shell.openExternal(url), (state) => {
      for (const target of registered.keys()) if (!target.isDestroyed()) target.webContents.send('povondra:providers-state', state);
    });
    ipcMain.handle('povondra:providers', (event, command: unknown) => {
      assertTrusted(event);
      if (event.sender !== settings?.webContents) throw new Error('Provider settings are only available in Settings.');
      return providers!.handle(command);
    });
    ipcMain.handle('povondra:settings', (event) => { assertTrusted(event); return openSettings(); });
    ipcMain.handle('povondra:history', (event) => { assertTrusted(event); return openHistory(); });
    ipcMain.handle('povondra:request', async (event, input: unknown) => {
      assertTrusted(event);
      // Explicit ingress allowlist blocks private credential-bearing pipe commands.
      if (!input || typeof input !== 'object' || !['snapshot', 'saveAssistant', 'createConversation', 'selectModel', 'cancelChat'].includes(String((input as Request).method))) throw new Error('Unsupported request.');
      const request = input as Request;
      if (request.method === 'cancelChat') pendingChats.delete(request.conversationId);
      return broadcast(await runtime!.request(request));
    });
    ipcMain.handle('povondra:chat', async (event, input: ChatRequest) => {
      assertTrusted(event);
      if (!input || typeof input.conversationId !== 'string' || input.conversationId.length > 100 || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000 || typeof input.model !== 'string') throw new Error('Invalid chat request.');
      const id = input.conversationId;
      if (pendingChats.has(id)) throw new Error('A message is already starting.');
      const pending = {}; pendingChats.set(id, pending);
      try {
        const result = await runtime!.request({ method: 'snapshot', conversationId: id });
        const conversation = result.snapshot.conversations.find((c) => c.id === id);
        const assistant = result.snapshot.assistants.find((a) => a.id === conversation?.assistantId);
        if (!assistant) throw new Error('Conversation not found.');
        const thinking = requireThinking(assistant.provider, input.model, input.thinking);
        if (result.snapshot.messages.some((m) => m.conversationId === id && m.status === 'streaming')) throw new Error('This conversation is already replying.');
        const credentials = await providers!.credentials(assistant.provider);
        if (quitting || pendingChats.get(id) !== pending) throw new Error('Message cancelled.');
        return broadcast(await runtime!.startChat({ conversationId: id, text: input.text, model: input.model, thinking }, credentials));
      } finally { if (pendingChats.get(id) === pending) pendingChats.delete(id); }
    });
    window.on('close', (event) => { if (!quitting) { event.preventDefault(); window?.hide(); } });
    // A text tray item works without shipping a placeholder binary image asset.
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle('●');
    tray.setToolTip('Povondra');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Povondra', click: show },
      { label: 'History…', click: showHistory },
      { label: 'Settings…', click: showSettings },
      { label: 'Keep on top', type: 'checkbox', click: (item) => window?.setAlwaysOnTop(item.checked) },
      { type: 'separator' },
      { label: 'Quit Povondra', click: () => app.quit() },
    ]));
    tray.on('click', show);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Povondra', submenu: [{ label: 'Show Povondra', click: show }, { label: 'History…', accelerator: 'CmdOrCtrl+Y', click: showHistory }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: showSettings }, { role: 'quit' }] },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]));
    await window.loadFile(page);
  }).catch((error) => { dialog.showErrorBox('Povondra could not start', error instanceof Error ? error.message : 'Unknown startup error.'); app.quit(); });
  app.on('activate', show);
  app.on('window-all-closed', () => { /* Tray owns application lifetime. */ });
  app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    providers?.close();
    void (runtime?.close() ?? Promise.resolve()).finally(() => { shutdownComplete = true; app.quit(); });
  });
}
