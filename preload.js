const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('morit', {
  getSavedData: () => ipcRenderer.invoke('get-saved-data'),
  saveAppData: (data) => ipcRenderer.invoke('save-app-data', data),
  clearPartition: (partitionName) => ipcRenderer.invoke('clear-partition', partitionName),
  preparePartition: (partitionName) => ipcRenderer.invoke('prepare-partition', partitionName),
  getUserAgent: () => ipcRenderer.invoke('get-user-agent'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getIsPackaged: () => ipcRenderer.invoke('get-is-packaged'),
  listMusic: () => ipcRenderer.invoke('list-music'),
  getMusicDir: () => ipcRenderer.invoke('get-music-dir'),
  saveAccountToken: (accountId, token) =>
    ipcRenderer.invoke('save-account-token', { accountId, token }),
  pushTokenSupabase: (payload) => ipcRenderer.invoke('push-token-supabase', payload),
  getSupabaseStatus: () => ipcRenderer.invoke('get-supabase-status'),
  setWebviewThrottle: (webContentsId, throttle) =>
    ipcRenderer.invoke('set-webview-throttle', { webContentsId, throttle }),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onOpenInAppTab: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('open-in-app-tab', listener);
    return () => ipcRenderer.removeListener('open-in-app-tab', listener);
  },
  onUpdateEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('update-event', listener);
    return () => ipcRenderer.removeListener('update-event', listener);
  }
});
