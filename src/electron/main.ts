import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, protocol, Tray, safeStorage, shell } from 'electron';
import { requireCopyText, requireWebLink } from '@shared/answer-actions';
import { attachmentDirectories, requireAttachmentId } from '@shared/attachments';
import { ScreenshotCapture } from '@electron/screenshot-capture';
import { EncryptedVault, ProviderConnections } from '@electron/provider-connections';
import { SpeechSynth } from '@electron/speech';
import { ToolLoadingSettings } from '@electron/tool-loading';
import { DictationService } from '@electron/dictation-service';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { parseMcpConfig } from '@shared/mcp';
import { pathToFileURL } from 'node:url';
import { Runtime } from '@electron/runtime';
import { requireThinking } from '@shared/models';
import type { ChatRequest, Request, Result } from '@shared/protocol';
import { userDataPath } from '@shared/data-paths';

import { DEV_ORIGIN, isDevelopment } from '@shared/development';

protocol.registerSchemesAsPrivileged([{ scheme: 'moki-attachment', privileges: { secure: true, supportFetchAPI: true } }]);
const development = isDevelopment(app.isPackaged, process.env.MOKI_DEV);
app.setName(development ? 'Moki Dev' : 'Moki');
try {
  const dataDir = development ? join(app.getPath('appData'), 'Moki Dev') : userDataPath(app.getPath('appData'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  app.setPath('userData', dataDir);
}
catch (error) { dialog.showErrorBox('Moki could not start', String(error)); app.exit(1); throw error; }

let window: BrowserWindow | undefined;
let settings: BrowserWindow | undefined;
let history: BrowserWindow | undefined;
const registered = new Map<BrowserWindow, string>();
const pendingChats = new Map<string, object>();
function broadcast(result: Result) {
  for (const target of registered.keys()) if (!target.isDestroyed()) target.webContents.send('moki:state', result);
  return result;
}
let tray: Tray | undefined;
let runtime: Runtime | undefined;
let providers: ProviderConnections | undefined;
let mcpAuth: import('@electron/mcp-connections').McpConnections | undefined;
let capture: ScreenshotCapture | undefined;
let speech: SpeechSynth | undefined;
let dictation: DictationService | undefined;
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
  registered.set(target, (development ? DEV_ORIGIN + '/' : pathToFileURL(page).href) + hash);
  if (development) {
    target.webContents.on('context-menu', (_event, params) => {
      Menu.buildFromTemplate([{ label: 'Inspect Element', click: () => {
        target.webContents.openDevTools({ mode: 'detach' });
        target.webContents.inspectElement(params.x, params.y);
      } }]).popup({ window: target });
    });
  }
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
    title: 'Moki Settings',
    webPreferences: { preload: join(appRoot, 'dist/electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    ...glassWindow,
  });
  secureWindow(settings, '#settings');
  settings.on('close', (event) => { if (!quitting) { event.preventDefault(); settings?.hide(); } });
  settings.on('closed', () => { settings = undefined; });
  if (development) await settings.loadURL(DEV_ORIGIN + '/#settings');
  else await settings.loadFile(page, { hash: 'settings' });
}
async function openHistory() {
  if (quitting) return;
  if (history) { history.show(); history.focus(); return; }
  history = new BrowserWindow({
    width: 380, height: 520, minWidth: 300, minHeight: 360,
    title: 'Moki History',
    webPreferences: { preload: join(appRoot, 'dist/electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    ...glassWindow,
  });
  secureWindow(history, '#history');
  // History is transient: closing it closes it, no hide-and-keep.
  history.on('closed', () => { history = undefined; });
  if (development) await history.loadURL(DEV_ORIGIN + '/#history');
  else await history.loadFile(page, { hash: 'history' });
}
function showSettings() {
  void openSettings().catch((error) => dialog.showErrorBox('Could not open settings', String(error)));
}
// Resolve a web connection's URL from the user-owned config file; sign-in is
// meaningful only for HTTP transports.
function mcpServerUrl(name: string): string {
  let text: string;
  try { text = readFileSync(join(app.getPath('userData'), 'mcp.json'), 'utf8'); }
  catch { throw new Error('Connection not found.'); }
  let parsed;
  try { parsed = parseMcpConfig(JSON.parse(text)); } catch { throw new Error('The connections file is not valid JSON.'); }
  const server = parsed.servers.find((entry) => entry.key === name && entry.config.transport === 'http');
  if (!server) throw new Error('Only web connections use sign-in.');
  return server.config.url!;
}
function showHistory() {
  void openHistory().catch((error) => dialog.showErrorBox('Could not open history', String(error)));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.whenReady().then(async () => {
    const binary = app.isPackaged
      ? join(process.resourcesPath, 'backend/moki-runtime')
      : join(appRoot, 'dist/backend/moki-runtime');
    const dictationHelper = app.isPackaged
      ? join(process.resourcesPath, 'native/moki-dictate')
      : join(appRoot, 'dist/native/moki-dictate');
    runtime = new Runtime(binary, app.getPath('userData'), broadcast, (message) => {
      for (const target of registered.keys()) if (!target.isDestroyed()) target.webContents.send('moki:runtime-error', message);
    });
    await runtime.ready;
    // Sign-ins from previous sessions keep working: push their headers into
    // the backend before anything fetches a catalog.
    mcpAuth = new (await import('@electron/mcp-connections')).McpConnections(
      new (await import('@electron/mcp-connections')).EncryptedMcpVault(join(app.getPath('userData'), 'mcp.encrypted'), safeStorage),
      (url) => shell.openExternal(url),
    );
    try {
      for (const [server, headers] of Object.entries(mcpAuth.allHeaders())) await runtime.push({ event: 'mcp-auth', server, headers });
    } catch (error) { console.error('[moki] mcp sign-in restore failed:', error instanceof Error ? error.message : String(error)); }
    const attachmentDirs = attachmentDirectories(app.getPath('userData'));
    mkdirSync(attachmentDirs.drafts, { recursive: true, mode: 0o700 });
    mkdirSync(attachmentDirs.content, { recursive: true, mode: 0o700 });
    protocol.handle('moki-attachment', (request) => {
      try {
        const url = new URL(request.url);
        const id = requireAttachmentId(url.hostname);
        if (url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid attachment URL.');
        const draft = join(attachmentDirs.drafts, `${id}.png`);
        const content = join(attachmentDirs.content, `${id}.png`);
        const path = existsSync(draft) ? draft : existsSync(content) ? content : undefined;
        if (!path) return new Response('Not found', { status: 404 });
        return new Response(readFileSync(path), { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
      } catch { return new Response('Invalid attachment', { status: 400 }); }
    });
    window = new BrowserWindow({
      width: 440, height: 680, minWidth: 360, minHeight: 480,
      title: development ? 'Moki Dev' : 'Moki',
      webPreferences: { preload: join(appRoot, 'dist/electron/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
      ...glassWindow,
    });
    secureWindow(window);
    capture = new ScreenshotCapture(app.getPath('userData'), () => window);
    // Speaking state is pushed, never polled: the synth emits, main forwards.
    speech = new SpeechSynth();
    speech.onChange((speaking) => {
      for (const target of registered.keys()) if (!target.isDestroyed()) target.webContents.send('moki:speech', { speaking });
    });
    dictation = new DictationService();
    providers = new ProviderConnections(new EncryptedVault(join(app.getPath('userData'), 'providers.encrypted'), safeStorage), (url) => shell.openExternal(url), (state) => {
      for (const target of registered.keys()) if (!target.isDestroyed()) target.webContents.send('moki:providers-state', state);
    });
    const toolLoading = new ToolLoadingSettings(join(app.getPath('userData'), 'tool-loading.encrypted'), safeStorage);
    ipcMain.handle('moki:tool-loading', (event, command: unknown) => {
      assertTrusted(event);
      if (event.sender !== settings?.webContents) throw new Error('Smart-loading settings are only available in Settings.');
      const state = toolLoading.handle(command);
      for (const target of registered.keys()) if (!target.isDestroyed()) target.webContents.send('moki:tool-loading-state', state);
      return state;
    });
    ipcMain.handle('moki:providers', (event, command: unknown) => {
      assertTrusted(event);
      if (event.sender !== settings?.webContents) throw new Error('Provider settings are only available in Settings.');
      return providers!.handle(command);
    });
    ipcMain.handle('moki:auth', async (event, command: unknown) => {
      assertTrusted(event);
      if (event.sender !== settings?.webContents) throw new Error('Connection settings are only available in Settings.');
      if (!mcpAuth) throw new Error('Sign-in is not ready yet. Try again in a moment.');
      const input = command as { action?: unknown; server?: unknown };
      if (!input || typeof input !== 'object' || (input.action !== 'signIn' && input.action !== 'signOut') || typeof input.server !== 'string' || !input.server || input.server.length > 64) throw new Error('Invalid sign-in request.');
      const url = input.action === 'signIn' ? mcpServerUrl(input.server) : undefined;
      const result = await mcpAuth.handle(url ? { action: 'signIn', server: input.server, url } : { action: 'signOut', server: input.server });
      await runtime!.push({ event: 'mcp-auth', server: input.server, headers: mcpAuth.headers(input.server) });
      return result;
    });
    ipcMain.handle('moki:speak', (event, text: unknown) => {
      assertTrusted(event);
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Invalid speech text.');
      speech!.speakText(text);
    });
    ipcMain.handle('moki:stop-speaking', (event) => {
      assertTrusted(event);
      speech!.stop();
    });
    ipcMain.handle('moki:settings', (event) => { assertTrusted(event); return openSettings(); });
    ipcMain.handle('moki:history', (event) => { assertTrusted(event); return openHistory(); });
    ipcMain.handle('moki:copy-text', (event, text: unknown) => {
      assertTrusted(event);
      clipboard.writeText(requireCopyText(text));
    });
    ipcMain.handle('moki:open-web-link', (event, url: unknown) => {
      assertTrusted(event);
      return shell.openExternal(requireWebLink(url));
    });
    ipcMain.handle('moki:start-capture', (event) => { assertTrusted(event); return capture!.start(); });
    ipcMain.handle('moki:remove-capture', (event, id: unknown) => { assertTrusted(event); capture!.remove(id); });
    ipcMain.handle('moki:screen-recording-settings', (event) => { assertTrusted(event); return capture!.openPermissionSettings(); });
    ipcMain.handle('moki:microphone-settings', (event) => {
      assertTrusted(event);
      if (process.platform !== 'darwin') throw new Error('Microphone settings are managed in your system preferences.');
      return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    });
    ipcMain.handle('moki:speech-recognition-settings', (event) => {
      assertTrusted(event);
      if (process.platform !== 'darwin') throw new Error('Speech settings are managed in your system preferences.');
      return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition');
    });
    // The native helper owns the mic; events stream back to the window that
    // started the session (the single chat window).
    ipcMain.handle('moki:start-dictation', (event) => {
      assertTrusted(event);
      const sender = event.sender;
      dictation!.start(dictationHelper, (push) => { if (!sender.isDestroyed()) sender.send('moki:dictation', push); });
    });
    ipcMain.handle('moki:stop-dictation', (event) => {
      assertTrusted(event);
      dictation!.stop();
    });
    ipcMain.handle('moki:request', async (event, input: unknown) => {
      assertTrusted(event);
      // Explicit ingress allowlist blocks private credential-bearing pipe commands.
      if (!input || typeof input !== 'object' || !['snapshot', 'saveAssistant', 'createConversation', 'selectModel', 'cancelChat', 'revertMessage', 'cuaTools', 'cuaSetTool', 'cuaSetEnabled', 'mcpTools', 'mcpAddServer', 'mcpRemoveServer', 'mcpSetServer', 'mcpSetTool'].includes(String((input as Request).method))) throw new Error('Unsupported request.');
      const request = input as Request;
      if ((request.method === 'cuaTools' || request.method === 'cuaSetTool' || request.method === 'cuaSetEnabled' || request.method === 'mcpTools' || request.method === 'mcpAddServer' || request.method === 'mcpRemoveServer' || request.method === 'mcpSetServer' || request.method === 'mcpSetTool') && event.sender !== settings?.webContents) throw new Error('Connection settings are only available in Settings.');
      if (request.method === 'cancelChat') pendingChats.delete(request.conversationId);
      return broadcast(await runtime!.request(request));
    });
    ipcMain.handle('moki:chat', async (event, input: ChatRequest) => {
      assertTrusted(event);
      if (!input || typeof input.conversationId !== 'string' || input.conversationId.length > 100 || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000 || typeof input.model !== 'string' || (input.attachmentIds !== undefined && (!Array.isArray(input.attachmentIds) || input.attachmentIds.length > 1)) || (input.editOf !== undefined && (typeof input.editOf !== 'string' || input.editOf.length > 100))) throw new Error('Invalid chat request.');
      for (const attachmentId of input.attachmentIds ?? []) requireAttachmentId(attachmentId);
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
        return broadcast(await runtime!.startChat({ conversationId: id, text: input.text, model: input.model, thinking, attachmentIds: input.attachmentIds, editOf: input.editOf }, credentials, toolLoading.config()));
      } finally { if (pendingChats.get(id) === pending) pendingChats.delete(id); }
    });
    window.on('close', (event) => { if (!quitting) { event.preventDefault(); window?.hide(); } });
    // A text tray item works without shipping a placeholder binary image asset.
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle('●');
    tray.setToolTip('Moki');
    const startCapture = () => { void capture!.start().catch((error) => dialog.showErrorBox('Could not capture region', String(error))); };
    const shortcutRegistered = globalShortcut.register('CommandOrControl+Shift+8', startCapture);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Moki', click: show },
      { label: shortcutRegistered ? 'Capture region…' : 'Capture region… (shortcut unavailable)', click: startCapture },
      { label: 'History…', click: showHistory },
      { label: 'Settings…', click: showSettings },
      { label: 'Keep on top', type: 'checkbox', click: (item) => window?.setAlwaysOnTop(item.checked) },
      { type: 'separator' },
      { label: 'Quit Moki', click: () => app.quit() },
    ]));
    tray.on('click', show);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Moki', submenu: [{ label: 'Show Moki', click: show }, { label: 'Capture region…', accelerator: shortcutRegistered ? 'CmdOrCtrl+Shift+8' : undefined, click: startCapture }, { label: 'History…', accelerator: 'CmdOrCtrl+Y', click: showHistory }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: showSettings }, { role: 'quit' }] },
      { role: 'editMenu' },
      { role: 'windowMenu' },
      ...(development ? [{ label: 'Developer', submenu: [
        { role: 'toggleDevTools' as const, accelerator: 'Alt+CommandOrControl+I' },
        { role: 'reload' as const },
      ] }] : []),
    ]));
    if (development) {
      await window.loadURL(DEV_ORIGIN + '/');
      window.webContents.openDevTools({ mode: 'detach' });
    } else await window.loadFile(page);
  }).catch((error) => { dialog.showErrorBox('Moki could not start', error instanceof Error ? error.message : 'Unknown startup error.'); app.quit(); });
  if (development) {
    process.on('message', (message) => { if (message === 'moki:dev-quit') app.quit(); });
    process.on('disconnect', () => app.quit());
    process.on('SIGTERM', () => app.quit());
    process.on('SIGINT', () => app.quit());
  }
  app.on('activate', show);
  app.on('window-all-closed', () => { /* Tray owns application lifetime. */ });
  app.on('before-quit', (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    globalShortcut.unregisterAll();
    capture?.close();
    providers?.close();
    mcpAuth?.close();
    speech?.close();
    dictation?.close();
    void (runtime?.close() ?? Promise.resolve()).finally(() => { shutdownComplete = true; app.quit(); });
  });
}
