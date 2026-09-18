import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '@shared/protocol';
const api: DesktopAPI = {
  toolLoading: (command) => ipcRenderer.invoke('moki:tool-loading', command),
  onToolLoading: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on('moki:tool-loading-state', handler);
    return () => ipcRenderer.removeListener('moki:tool-loading-state', handler);
  },
  chat: (request) => ipcRenderer.invoke('moki:chat', request),
  onRuntimeError: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
    ipcRenderer.on('moki:runtime-error', handler);
    return () => ipcRenderer.removeListener('moki:runtime-error', handler);
  },
  providers: (command) => ipcRenderer.invoke('moki:providers', command),
  mcpAuth: (command) => ipcRenderer.invoke('moki:auth', command),
  speak: (text) => ipcRenderer.invoke('moki:speak', text),
  stopSpeaking: () => ipcRenderer.invoke('moki:stop-speaking'),
  onSpeech: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on('moki:speech', handler);
    return () => ipcRenderer.removeListener('moki:speech', handler);
  },
  startDictation: () => ipcRenderer.invoke('moki:start-dictation'),
  stopDictation: () => ipcRenderer.invoke('moki:stop-dictation'),
  onDictation: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: Parameters<typeof listener>[0]) => listener(event);
    ipcRenderer.on('moki:dictation', handler);
    return () => ipcRenderer.removeListener('moki:dictation', handler);
  },
  openSpeechRecognitionSettings: () => ipcRenderer.invoke('moki:speech-recognition-settings'),
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
  startCapture: () => ipcRenderer.invoke('moki:start-capture'),
  removeCapture: (id) => ipcRenderer.invoke('moki:remove-capture', id),
  openScreenRecordingSettings: () => ipcRenderer.invoke('moki:screen-recording-settings'),
  openMicrophoneSettings: () => ipcRenderer.invoke('moki:microphone-settings'),
  onCapture: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('moki:capture', handler);
    return () => ipcRenderer.removeListener('moki:capture', handler);
  },
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, result: Parameters<typeof listener>[0]) => listener(result);
    ipcRenderer.on('moki:state', handler);
    return () => ipcRenderer.removeListener('moki:state', handler);
  },
};
contextBridge.exposeInMainWorld('moki', api);
