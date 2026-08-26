export type DownloadStatus = 
  | 'idle'
  | 'initializing'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled'

export interface ChunkState {
  id: number
  start: number
  end: number
  downloaded: number
  total: number
  status: 'pending' | 'downloading' | 'completed' | 'error'
}

export interface DownloadProgress {
  id: string
  url: string
  filePath: string
  fileName: string
  status: DownloadStatus
  downloadedBytes: number
  totalBytes: number // -1 if unknown
  progressPercentage: number // 0 to 100
  speedBytesPerSec: number
  estimatedTimeRemainingSec: number
  errorMessage?: string
  resumable: boolean
  connections: number
  chunks?: ChunkState[]
  startTime: number
  updatedAt: number
}

export interface StartDownloadParams {
  url: string
  destinationFolder?: string
  customFileName?: string
  connections?: number // Default: 8
}

export interface DownloadMetaFile {
  id: string
  url: string
  fileName: string
  totalBytes: number
  connections: number
  chunks: ChunkState[]
  updatedAt: number
}

export interface DownloaderIpcApi {
  selectDirectory: () => Promise<string | null>
  getDefaultDownloadPath: () => Promise<string>
  inspectPath: (folderPath: string) => Promise<any>
  startDownload: (params: StartDownloadParams) => Promise<DownloadProgress>
  pauseDownload: (id: string) => Promise<boolean>
  resumeDownload: (id: string) => Promise<boolean>
  cancelDownload: (id: string) => Promise<boolean>
  getAllDownloads: () => Promise<DownloadProgress[]>
  showItemInFolder: (filePath: string) => Promise<boolean>
  openFolder: (folderPath: string) => Promise<boolean>
  onProgress: (callback: (progress: DownloadProgress) => void) => () => void
}
