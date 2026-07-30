const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('morit', {
  getSavedData: () => ipcRenderer.invoke('get-saved-data'),
  saveAppData: (data) => ipcRenderer.invoke('save-app-data', data),
  clearPartition: (partitionName) => ipcRenderer.invoke('clear-partition', partitionName),
  preparePartition: (partitionName) => ipcRenderer.invoke('prepare-partition', partitionName),
  getUserAgent: () => ipcRenderer.invoke('get-user-agent'),
  listMusic: () => ipcRenderer.invoke('list-music'),
  getMusicDir: () => ipcRenderer.invoke('get-music-dir'),
  onOpenInAppTab: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('open-in-app-tab', listener);
    return () => ipcRenderer.removeListener('open-in-app-tab', listener);
  }
});
