import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared/protocol';
const api: DesktopAPI = {
  chat: (request) => ipcRenderer.invoke('moki:chat', request),
  onRuntimeError: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
    ipcRenderer.on('moki:runtime-error', handler);
    return () => ipcRenderer.removeListener('moki:runtime-error', handler);
  },
  providers: (command) => ipcRenderer.invoke('moki:providers', command),
  onProviders: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on('moki:providers-state', handler);
    return () => ipcRenderer.removeListener('moki:providers-state', handler);
  },
  request: (request) => ipcRenderer.invoke('moki:request', request),
  openSettings: () => ipcRenderer.invoke('moki:settings'),
  openHistory: () => ipcRenderer.invoke('moki:history'),
  copyText: (text) => ipcRenderer.invoke('moki:copy-text', text),
  openWebLink: (url) => ipcRenderer.invoke('moki:open-web-link', url),
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, result: Parameters<typeof listener>[0]) => listener(result);
    ipcRenderer.on('moki:state', handler);
    return () => ipcRenderer.removeListener('moki:state', handler);
  },
};
contextBridge.exposeInMainWorld('moki', api);
