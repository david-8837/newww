// electron/preload.cjs - Safe IPC Bridge for Windows Desktop App
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  getVersion: () => ipcRenderer.invoke('get-app-version'),
  getInstalledApplications: () => ipcRenderer.invoke('list-installed-applications'),
  getAppSettings: () => ipcRenderer.invoke('get-app-settings'),
  setAppSetting: (key, value) => ipcRenderer.invoke('set-app-setting', key, value),
  openExternal: (url) => ipcRenderer.invoke('open-external-url', url),
  setSimulationEnabled: (enabled) => ipcRenderer.invoke('set-simulation-enabled', enabled),
  flashFirmware: () => ipcRenderer.invoke('flash-uf2'),
  executeSmartAction: (payload) => ipcRenderer.invoke('execute-smart-action', payload),
  onHardwareSync: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('trigger-hardware-sync', listener);
    return () => ipcRenderer.removeListener('trigger-hardware-sync', listener);
  },
  onOpenHardwareModal: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('open-hardware-modal', listener);
    return () => ipcRenderer.removeListener('open-hardware-modal', listener);
  },
});
