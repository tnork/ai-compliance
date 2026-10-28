import { contextBridge, ipcRenderer } from 'electron'

// Minimal, explicit bridge — the renderer gets no Node access, only these calls.
contextBridge.exposeInMainWorld('aic', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveConfig: (patch: unknown) => ipcRenderer.invoke('save-config', patch),
  connect: (code: string) => ipcRenderer.invoke('connect-code', code),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  syncNow: () => ipcRenderer.invoke('sync-now'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  onState: (cb: (state: unknown) => void) => ipcRenderer.on('state', (_e, s) => cb(s)),
})
