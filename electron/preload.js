'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jam', {
  mode: 'electron',
  load: () => ipcRenderer.invoke('data:load'),
  save: (json) => ipcRenderer.invoke('data:save', json),
  openFolder: (target) => ipcRenderer.invoke('folder:open', target),
  backupNow: () => ipcRenderer.invoke('backup:create'),
  listBackups: () => ipcRenderer.invoke('backup:list'),
  restoreBackup: (name) => ipcRenderer.invoke('backup:restore', name),
  saveAttachment: (payload) => ipcRenderer.invoke('attachment:save', payload),
  readAttachment: (key) => ipcRenderer.invoke('attachment:read', key),
  deleteAttachments: (tabId) => ipcRenderer.invoke('attachment:delete', tabId),
  exportFile: (payload) => ipcRenderer.invoke('file:export', payload),
  openMarkdown: () => ipcRenderer.invoke('file:open'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  appInfo: () => ipcRenderer.invoke('app:info'),
  onBeforeQuit: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('app:before-quit', handler)
    return () => ipcRenderer.removeListener('app:before-quit', handler)
  },
  flushDone: () => ipcRenderer.send('app:flush-done'),
})
