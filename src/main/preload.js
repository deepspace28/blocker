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

  addAllowlistDomain: (domain) => ipcRenderer.invoke('allowlist:add', domain),
  removeAllowlistDomain: (domain) => ipcRenderer.invoke('allowlist:remove', domain),

  addBlockedApp: (appName) => ipcRenderer.invoke('appBlocklist:add', appName),
  removeBlockedApp: (appName) => ipcRenderer.invoke('appBlocklist:remove', appName),

  getPresets: () => ipcRenderer.invoke('presets:list'),
  applyPreset: (categoryName) => ipcRenderer.invoke('presets:apply', categoryName),

  startSession: (opts) => ipcRenderer.invoke('session:start', opts),
  stopSession: () => ipcRenderer.invoke('session:stop'),

  getSetupInfo: () => ipcRenderer.invoke('setup:info'),
  runSetup: () => ipcRenderer.invoke('setup:install'),
  undoSetup: () => ipcRenderer.invoke('setup:uninstall'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('setup:setLaunchAtLogin', enabled),

  addSchedule: (schedule) => ipcRenderer.invoke('schedule:add', schedule),
  updateSchedule: (id, patch) => ipcRenderer.invoke('schedule:update', { id, patch }),
  removeSchedule: (id) => ipcRenderer.invoke('schedule:remove', id),
});
