import { contextBridge, ipcRenderer } from 'electron'
import { DownloadProgress, StartDownloadParams, DownloaderIpcApi } from '../types.js'

export const downloaderPreloadApi: DownloaderIpcApi = {
  selectDirectory: (): Promise<string | null> => {
    return ipcRenderer.invoke('dialog:select-directory')
  },
  getDefaultDownloadPath: (): Promise<string> => {
    return ipcRenderer.invoke('system:get-default-download-path')
  },
  startDownload: (params: StartDownloadParams): Promise<DownloadProgress> => {
    return ipcRenderer.invoke('download:start', params)
  },
  pauseDownload: (id: string): Promise<boolean> => {
    return ipcRenderer.invoke('download:pause', id)
  },
  resumeDownload: (id: string): Promise<boolean> => {
    return ipcRenderer.invoke('download:resume', id)
  },
  cancelDownload: (id: string): Promise<boolean> => {
    return ipcRenderer.invoke('download:cancel', id)
  },
  getAllDownloads: (): Promise<DownloadProgress[]> => {
    return ipcRenderer.invoke('download:get-all')
  },
  showItemInFolder: (filePath: string): Promise<boolean> => {
    return ipcRenderer.invoke('shell:show-item-in-folder', filePath)
  },
  openFolder: (folderPath: string): Promise<boolean> => {
    return ipcRenderer.invoke('shell:open-folder', folderPath)
  },
  onProgress: (callback: (progress: DownloadProgress) => void) => {
    const handler = (_event: any, progress: DownloadProgress) => callback(progress)
    ipcRenderer.on('download:progress', handler)
    return () => {
      ipcRenderer.removeListener('download:progress', handler)
    }
  }
}

export function exposeLargeDownloaderApi(apiKey: string = 'electronAPI') {
  contextBridge.exposeInMainWorld(apiKey, downloaderPreloadApi)
}
