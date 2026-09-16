import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared/protocol';
const api: DesktopAPI = {
  chat: (request) => ipcRenderer.invoke('povondra:chat', request),
  onRuntimeError: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
    ipcRenderer.on('povondra:runtime-error', handler);
    return () => ipcRenderer.removeListener('povondra:runtime-error', handler);
  },
  providers: (command) => ipcRenderer.invoke('povondra:providers', command),
  onProviders: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on('povondra:providers-state', handler);
    return () => ipcRenderer.removeListener('povondra:providers-state', handler);
  },
  request: (request) => ipcRenderer.invoke('povondra:request', request),
  openSettings: () => ipcRenderer.invoke('povondra:settings'),
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, result: Parameters<typeof listener>[0]) => listener(result);
    ipcRenderer.on('povondra:state', handler);
    return () => ipcRenderer.removeListener('povondra:state', handler);
  },
};
contextBridge.exposeInMainWorld('povondra', api);
