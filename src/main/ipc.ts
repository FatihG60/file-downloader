import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron'
import { downloadManager } from './downloader/DownloadManager'
import { StartDownloadParams } from './downloader/types'
import fs from 'node:fs'

import { inspectPath } from './utils/diskInspector'

export function registerIpcHandlers(mainWindow: BrowserWindow) {
  downloadManager.setMainWindow(mainWindow)

  // Select download destination directory
  ipcMain.handle('dialog:select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Download Folder',
      defaultPath: app.getPath('downloads')
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]
  })

  // Get default downloads directory
  ipcMain.handle('system:get-default-download-path', () => {
    return app.getPath('downloads')
  })

  // Inspect drive / storage path (FAT32, NTFS, free space, recommended profile)
  ipcMain.handle('system:inspect-path', async (_event, folderPath: string) => {
    return inspectPath(folderPath || app.getPath('downloads'))
  })

  // Start download
  ipcMain.handle('download:start', (_event, params: StartDownloadParams) => {
    if (!params.url) {
      throw new Error('URL is required')
    }
    const destination = params.destinationFolder || app.getPath('downloads')
    return downloadManager.startDownload({
      ...params,
      destinationFolder: destination
    })
  })

  // Pause download
  ipcMain.handle('download:pause', (_event, id: string) => {
    return downloadManager.pauseDownload(id)
  })

  // Resume download
  ipcMain.handle('download:resume', (_event, id: string) => {
    return downloadManager.resumeDownload(id)
  })

  // Cancel download
  ipcMain.handle('download:cancel', (_event, id: string) => {
    return downloadManager.cancelDownload(id)
  })

  // Get all downloads
  ipcMain.handle('download:get-all', () => {
    return downloadManager.getAllDownloads()
  })

  // Open file in explorer / finder
  ipcMain.handle('shell:show-item-in-folder', (_event, filePath: string) => {
    if (fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath)
      return true
    }
    return false
  })

  // Open folder directly
  ipcMain.handle('shell:open-folder', (_event, folderPath: string) => {
    if (fs.existsSync(folderPath)) {
      shell.openPath(folderPath)
      return true
    }
    return false
  })
}
