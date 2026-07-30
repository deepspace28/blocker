const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('focuslock', {
  getState: () => ipcRenderer.invoke('state:get'),
  onStateUpdate: (callback) => {
    const handler = (_e, state) => callback(state);
    ipcRenderer.on('state:update', handler);
    return () => ipcRenderer.removeListener('state:update', handler);
  },

  addBlocklistDomain: (domain) => ipcRenderer.invoke('blocklist:add', domain),
  removeBlocklistDomain: (domain) => ipcRenderer.invoke('blocklist:remove', domain),

  startSession: (opts) => ipcRenderer.invoke('session:start', opts),
  stopSession: () => ipcRenderer.invoke('session:stop'),

  addSchedule: (schedule) => ipcRenderer.invoke('schedule:add', schedule),
  updateSchedule: (id, patch) => ipcRenderer.invoke('schedule:update', { id, patch }),
  removeSchedule: (id) => ipcRenderer.invoke('schedule:remove', id),
});
