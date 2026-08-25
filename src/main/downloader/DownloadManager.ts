import { BrowserWindow } from 'electron'
import { DownloaderEngine } from './DownloaderEngine'
import { DownloadProgress, StartDownloadParams } from './types'

export class DownloadManager {
  private downloads: Map<string, DownloaderEngine> = new Map()
  private mainWindow: BrowserWindow | null = null

  public setMainWindow(win: BrowserWindow) {
    this.mainWindow = win
  }

  public startDownload(params: StartDownloadParams): DownloadProgress {
    const id = `dl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    const engine = new DownloaderEngine(
      id,
      params.url,
      params.destinationFolder,
      params.customFileName,
      params.connections || 8
    )

    this.downloads.set(id, engine)

    engine.on('progress', (progress: DownloadProgress) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('download:progress', progress)
      }
    })

    // Start download process
    engine.start()

    return engine.getProgress()
  }

  public pauseDownload(id: string): boolean {
    const engine = this.downloads.get(id)
    if (engine) {
      engine.pause()
      return true
    }
    return false
  }

  public resumeDownload(id: string): boolean {
    const engine = this.downloads.get(id)
    if (engine) {
      engine.resume()
      return true
    }
    return false
  }

  public cancelDownload(id: string): boolean {
    const engine = this.downloads.get(id)
    if (engine) {
      engine.cancel()
      this.downloads.delete(id)
      return true
    }
    return false
  }

  public getAllDownloads(): DownloadProgress[] {
    return Array.from(this.downloads.values()).map((engine) => engine.getProgress())
  }
}

export const downloadManager = new DownloadManager()
