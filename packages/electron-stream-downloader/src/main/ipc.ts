import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron'
import { downloadManager } from './DownloadManager.js'
import { StartDownloadParams } from '../types.js'
import fs from 'node:fs'

import { inspectPath } from '../utils/diskInspector.js'

export interface RegisterIpcOptions {
  defaultDownloadPath?: string
}

export function registerLargeDownloaderIpc(
  mainWindow: BrowserWindow,
  options?: RegisterIpcOptions
) {
  downloadManager.setMainWindow(mainWindow)

  const defaultPath = options?.defaultDownloadPath || (app ? app.getPath('downloads') : process.cwd())

  ipcMain.handle('dialog:select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Download Folder',
      defaultPath
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]
  })

  ipcMain.handle('system:get-default-download-path', () => {
    return defaultPath
  })

  ipcMain.handle('system:inspect-path', async (_event, folderPath: string) => {
    return inspectPath(folderPath || defaultPath)
  })

  ipcMain.handle('download:start', (_event, params: StartDownloadParams) => {
    if (!params.url) {
      throw new Error('URL is required')
    }
    return downloadManager.startDownload({
      ...params,
      destinationFolder: params.destinationFolder || defaultPath
    })
  })

  ipcMain.handle('download:pause', (_event, id: string) => {
    return downloadManager.pauseDownload(id)
  })

  ipcMain.handle('download:resume', (_event, id: string) => {
    return downloadManager.resumeDownload(id)
  })

  ipcMain.handle('download:cancel', (_event, id: string) => {
    return downloadManager.cancelDownload(id)
  })

  ipcMain.handle('download:get-all', () => {
    return downloadManager.getAllDownloads()
  })

  ipcMain.handle('shell:show-item-in-folder', (_event, filePath: string) => {
    if (fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath)
      return true
    }
    return false
  })

  ipcMain.handle('shell:open-folder', (_event, folderPath: string) => {
    if (fs.existsSync(folderPath)) {
      shell.openPath(folderPath)
      return true
    }
    return false
  })
}
