import { contextBridge, ipcRenderer } from 'electron';

export interface EnqueuePayload {
  items: Array<{ url: string; expectedMd5?: string }>;
  targetFolder: string;
  concurrency: number;
  chunkSizeMB: number;
  saveIntervalMB: number;
}

contextBridge.exposeInMainWorld('downloaderApi', {
  enqueueItems: (payload: EnqueuePayload) => ipcRenderer.invoke('queue:enqueue', payload),
  startQueue: (payload: EnqueuePayload) => ipcRenderer.invoke('queue:start', payload),
  pauseQueue: () => ipcRenderer.invoke('queue:pause'),
  removeQueueItem: (id: string, deleteFiles: boolean) =>
    ipcRenderer.invoke('queue:remove-item', id, deleteFiles),
  clearCompleted: () => ipcRenderer.invoke('queue:clear-completed'),
  resetQueue: (deleteFiles: boolean) => ipcRenderer.invoke('queue:reset-all', deleteFiles),
  getQueueState: () => ipcRenderer.invoke('queue:get-state'),
  pickTargetFolder: (currentFolder: string) =>
    ipcRenderer.invoke('download:pick-folder', currentFolder),
  inspectMeta: (targetPath: string) => ipcRenderer.invoke('download:inspect-meta', targetPath),
  openInFolder: (targetPath: string) => ipcRenderer.invoke('download:open-folder', targetPath),
  getTestBatch: () => ipcRenderer.invoke('download:get-test-batch'),
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  onQueueUpdated: (callback: (data: unknown) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on('queue:updated', listener);
    return () => ipcRenderer.removeListener('queue:updated', listener);
  },
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
