import { contextBridge, ipcRenderer } from 'electron';

export interface StartDownloadPayload {
  url: string;
  targetPath: string;
  expectedMd5?: string;
  concurrency: number;
  chunkSizeMB: number;
  saveIntervalMB: number;
}

contextBridge.exposeInMainWorld('downloaderApi', {
  startDownload: (payload: StartDownloadPayload) => ipcRenderer.invoke('download:start', payload),
  pauseDownload: () => ipcRenderer.invoke('download:pause'),
  pickTargetFile: (defaultUrl: string, currentPath: string) =>
    ipcRenderer.invoke('download:pick-target', defaultUrl, currentPath),
  inspectMeta: (targetPath: string) => ipcRenderer.invoke('download:inspect-meta', targetPath),
  resetProgressFiles: (targetPath: string) => ipcRenderer.invoke('download:reset-files', targetPath),
  openInFolder: (targetPath: string) => ipcRenderer.invoke('download:open-folder', targetPath),
  getTestEndpoint: () => ipcRenderer.invoke('download:get-test-endpoint'),
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  onProgress: (callback: (data: unknown) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on('download:progress', listener);
    return () => ipcRenderer.removeListener('download:progress', listener);
  },
  onLog: (callback: (msg: string) => void) => {
    const listener = (_event: unknown, msg: string) => callback(msg);
    ipcRenderer.on('download:log', listener);
    return () => ipcRenderer.removeListener('download:log', listener);
  }
});
