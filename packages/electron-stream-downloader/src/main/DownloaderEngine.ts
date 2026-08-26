import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import EventEmitter from 'node:events'
import { DownloadProgress, DownloadStatus, ChunkState, DownloadMetaFile } from '../types.js'
import { inspectPath } from '../utils/diskInspector.js'

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 32, timeout: 60000 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 32, timeout: 60000 })

export class DownloaderEngine extends EventEmitter {
  public id: string
  public url: string
  public destinationFolder: string
  public fileName: string
  public filePath: string
  public partFilePath: string
  public metaFilePath: string
  
  public status: DownloadStatus = 'idle'
  public downloadedBytes: number = 0
  public totalBytes: number = -1
  public resumable: boolean = false
  public connections: number = 8
  public chunks: ChunkState[] = []
  public errorMessage?: string

  private activeRequests: http.ClientRequest[] = []
  private fileDescriptor: number | null = null
  private isAborted: boolean = false
  
  private lastReportTime: number = Date.now()
  private lastReportBytes: number = 0
  private speedBytesPerSec: number = 0
  private speedSamples: number[] = []
  private progressInterval: NodeJS.Timeout | null = null
  private metaSaveInterval: NodeJS.Timeout | null = null
  private startTime: number = 0

  constructor(
    id: string,
    url: string,
    destinationFolder: string,
    customFileName?: string,
    connections: number = 8
  ) {
    super()
    this.id = id
    this.url = url.trim()
    this.destinationFolder = destinationFolder
    this.connections = Math.max(1, Math.min(32, connections))
    this.fileName = customFileName || this.extractFileNameFromUrl(this.url)
    this.filePath = path.join(this.destinationFolder, this.fileName)
    this.partFilePath = `${this.filePath}.part`
    this.metaFilePath = `${this.filePath}.part.meta.json`
  }

  private extractFileNameFromUrl(rawUrl: string): string {
    try {
      const parsed = new URL(rawUrl)
      const pathname = parsed.pathname
      const basename = path.basename(pathname)
      if (basename && basename.length > 0 && !basename.endsWith('/')) {
        return decodeURIComponent(basename.split('?')[0])
      }
    } catch {
      // fallback
    }
    return `download-${Date.now()}.bin`
  }

  public getProgress(): DownloadProgress {
    let progressPercentage = 0
    if (this.totalBytes > 0) {
      progressPercentage = Math.min(100, Math.round((this.downloadedBytes / this.totalBytes) * 10000) / 100)
    }

    let estimatedTimeRemainingSec = 0
    if (this.totalBytes > 0 && this.speedBytesPerSec > 0) {
      const remainingBytes = Math.max(0, this.totalBytes - this.downloadedBytes)
      estimatedTimeRemainingSec = Math.round(remainingBytes / this.speedBytesPerSec)
    }

    return {
      id: this.id,
      url: this.url,
      filePath: this.filePath,
      fileName: this.fileName,
      status: this.status,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalBytes,
      progressPercentage,
      speedBytesPerSec: this.speedBytesPerSec,
      estimatedTimeRemainingSec,
      errorMessage: this.errorMessage,
      resumable: this.resumable,
      connections: this.connections,
      chunks: this.chunks.length > 0 ? this.chunks : undefined,
      startTime: this.startTime,
      updatedAt: Date.now()
    }
  }

  public async start(): Promise<void> {
    if (this.status === 'downloading') return

    this.isAborted = false
    this.status = 'initializing'
    this.errorMessage = undefined
    if (this.startTime === 0) {
      this.startTime = Date.now()
    }
    this.emitProgress()

    try {
      if (!fs.existsSync(this.destinationFolder)) {
        fs.mkdirSync(this.destinationFolder, { recursive: true })
      }

      const probeResult = await this.probeUrl(this.url)
      this.resumable = probeResult.resumable
      if (probeResult.totalBytes > 0) {
        this.totalBytes = probeResult.totalBytes
      }
      if (probeResult.fileName && !this.fileName) {
        this.fileName = probeResult.fileName
        this.filePath = path.join(this.destinationFolder, this.fileName)
        this.partFilePath = `${this.filePath}.part`
        this.metaFilePath = `${this.filePath}.part.meta.json`
      }

      // Step 2: Smart Adaptive Disk Inspection & Pre-download Safety Checks
      const diskInfo = await inspectPath(this.destinationFolder)

      // FAT32 4GB Barrier Check
      if (diskInfo.isFat32 && this.totalBytes > 4 * 1024 * 1024 * 1024) {
        throw new Error(`FAT32 Sınırı: Seçilen ${diskInfo.driveLetter}: sürücüsü FAT32 formatında olduğu için 4GB'tan büyük dosya kabul etmez. Lütfen exFAT veya NTFS formatlı bir sürücü seçin.`)
      }

      // Insufficient Disk Space Check
      if (diskInfo.freeBytes > 0 && this.totalBytes > 0 && diskInfo.freeBytes < this.totalBytes) {
        const reqGB = (this.totalBytes / (1024 * 1024 * 1024)).toFixed(2)
        const freeGB = (diskInfo.freeBytes / (1024 * 1024 * 1024)).toFixed(2)
        throw new Error(`Yetersiz Disk Alanı: ${diskInfo.driveLetter}: sürücüsünde yeterli alan yok. Gerekli: ${reqGB} GB, Mevcut: ${freeGB} GB.`)
      }

      // Smart Adaptive Profile (Auto Concurrency)
      if (this.connections === 0) {
        this.connections = diskInfo.recommendedConnections
      }

      // Step 3: Choose Strategy (Multi-Stream Turbo vs Single Stream)
      if (this.resumable && this.totalBytes > 0 && this.connections > 1) {
        await this.startMultiStreamDownload(probeResult.finalUrl)
      } else {
        await this.startSingleStreamDownload(probeResult.finalUrl)
      }
    } catch (err: any) {
      if (!this.isAborted) {
        this.status = 'error'
        this.errorMessage = err.message || 'Download failed'
        this.cleanup()
        this.emitProgress()
      }
    }
  }

  private probeUrl(targetUrl: string, redirectCount: number = 0): Promise<{
    finalUrl: string
    resumable: boolean
    totalBytes: number
    fileName?: string
  }> {
    return new Promise((resolve, reject) => {
      if (redirectCount > 5) {
        return reject(new Error('Too many HTTP redirects'))
      }

      let parsedUrl: URL
      try {
        parsedUrl = new URL(targetUrl)
      } catch {
        return reject(new Error('Invalid URL format'))
      }

      const isHttps = parsedUrl.protocol === 'https:'
      const client = isHttps ? https : http

      const reqOptions: http.RequestOptions = {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Range': 'bytes=0-0'
        },
        agent: isHttps ? httpsAgent : httpAgent,
        timeout: 20000
      }

      const req = client.request(reqOptions, (res) => {
        if (
          res.statusCode &&
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location
        ) {
          const redirectUrl = new URL(res.headers.location, targetUrl).toString()
          res.resume()
          return resolve(this.probeUrl(redirectUrl, redirectCount + 1))
        }

        let extractedFileName: string | undefined
        const contentDisposition = res.headers['content-disposition']
        if (contentDisposition) {
          const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i)
          if (match && match[1]) {
            extractedFileName = decodeURIComponent(match[1].trim())
          }
        }

        let isResumable = false
        let totalBytes = -1

        if (res.statusCode === 206) {
          isResumable = true
          const contentRange = res.headers['content-range']
          if (contentRange) {
            const totalMatch = contentRange.match(/\/(\d+|\*)/)
            if (totalMatch && totalMatch[1] !== '*') {
              totalBytes = parseInt(totalMatch[1], 10)
            }
          }
        } else if (res.statusCode === 200) {
          isResumable = res.headers['accept-ranges'] === 'bytes'
          const contentLength = res.headers['content-length']
          if (contentLength) {
            totalBytes = parseInt(contentLength, 10)
          }
        }

        res.resume()
        resolve({
          finalUrl: targetUrl,
          resumable: isResumable,
          totalBytes,
          fileName: extractedFileName
        })
      })

      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Connection timed out while probing server'))
      })

      req.on('error', (err) => {
        reject(new Error(`Server Probe Error: ${err.message}`))
      })

      req.end()
    })
  }

  private async startMultiStreamDownload(finalUrl: string): Promise<void> {
    this.status = 'downloading'
    this.startProgressTimer()
    this.startMetaSaveTimer()

    this.initChunks()

    const fileFlags = fs.existsSync(this.partFilePath) ? 'r+' : 'w+'
    if (!fs.existsSync(this.partFilePath)) {
      fs.writeFileSync(this.partFilePath, Buffer.alloc(0))
    }
    this.fileDescriptor = fs.openSync(this.partFilePath, fileFlags)

    // Gigabit Optimization: Pre-allocate file size to prevent NTFS metadata fragmentation & MFT locking
    if (this.totalBytes > 0) {
      try {
        const currentSize = fs.statSync(this.partFilePath).size
        if (currentSize < this.totalBytes) {
          fs.ftruncateSync(this.fileDescriptor, this.totalBytes)
        }
      } catch (allocErr) {
        // Continue even if pre-allocation is not supported by file system
      }
    }

    this.downloadedBytes = this.chunks.reduce((acc, c) => acc + c.downloaded, 0)
    this.lastReportBytes = this.downloadedBytes
    this.lastReportTime = Date.now()

    const workerPromises = this.chunks.map((chunk, index) => {
      if (chunk.status === 'completed' || chunk.downloaded >= chunk.total) {
        chunk.status = 'completed'
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        setTimeout(resolve, index * 100)
      }).then(() => this.downloadChunkWorker(finalUrl, chunk, 6))
    })

    try {
      await Promise.all(workerPromises)
    } catch (workerErr: any) {
      if (this.isAborted) return
      console.warn('Multi-stream encountered rate limit or network jitter. Falling back to single stream:', workerErr.message)
      this.cleanup()
      return this.startSingleStreamDownload(finalUrl)
    }

    if (this.isAborted) return

    const allDone = this.chunks.every((c) => c.status === 'completed')
    if (allDone) {
      this.finalizeDownload()
    } else {
      this.cleanup()
      return this.startSingleStreamDownload(finalUrl)
    }
  }

  private initChunks(): void {
    if (fs.existsSync(this.metaFilePath)) {
      try {
        const raw = fs.readFileSync(this.metaFilePath, 'utf-8')
        const meta: DownloadMetaFile = JSON.parse(raw)
        if (meta.totalBytes === this.totalBytes && meta.chunks && meta.chunks.length > 0) {
          this.chunks = meta.chunks
          this.connections = meta.connections
          return
        }
      } catch {
        // re-split
      }
    }

    this.chunks = []
    const numChunks = this.connections
    const chunkSize = Math.floor(this.totalBytes / numChunks)

    for (let i = 0; i < numChunks; i++) {
      const start = i * chunkSize
      const end = i === numChunks - 1 ? this.totalBytes - 1 : (i + 1) * chunkSize - 1
      const total = end - start + 1

      this.chunks.push({
        id: i,
        start,
        end,
        downloaded: 0,
        total,
        status: 'pending'
      })
    }

    this.saveMetadata()
  }

  private downloadChunkWorker(finalUrl: string, chunk: ChunkState, retries: number = 6): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isAborted) return resolve()
      if (chunk.downloaded >= chunk.total) {
        chunk.status = 'completed'
        return resolve()
      }

      chunk.status = 'downloading'
      const parsedUrl = new URL(finalUrl)
      const isHttps = parsedUrl.protocol === 'https:'
      const client = isHttps ? https : http

      const currentStart = chunk.start + chunk.downloaded
      const reqOptions: http.RequestOptions = {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Range': `bytes=${currentStart}-${chunk.end}`
        },
        agent: isHttps ? httpsAgent : httpAgent,
        timeout: 30000
      }

      const req = client.request(reqOptions, (res) => {
        if (res.statusCode === 429 || res.statusCode === 503) {
          res.resume()
          if (retries > 0 && !this.isAborted) {
            let waitMs = Math.min(8000, Math.pow(2, 6 - retries) * 1200 + Math.random() * 500)
            const retryAfter = res.headers['retry-after']
            if (retryAfter) {
              const parsedSec = parseInt(retryAfter, 10)
              if (!isNaN(parsedSec) && parsedSec > 0) {
                waitMs = parsedSec * 1000
              }
            }
            return setTimeout(() => {
              resolve(this.downloadChunkWorker(finalUrl, chunk, retries - 1))
            }, waitMs)
          }
          chunk.status = 'error'
          return reject(new Error(`Server Rate Limit Exceeded (HTTP 429)`))
        }

        if (res.statusCode !== 206 && res.statusCode !== 200) {
          res.resume()
          if (retries > 0 && !this.isAborted) {
            return setTimeout(() => {
              resolve(this.downloadChunkWorker(finalUrl, chunk, retries - 1))
            }, 1000)
          }
          chunk.status = 'error'
          return reject(new Error(`Worker ${chunk.id} received HTTP ${res.statusCode}`))
        }

        let pendingBuffers: Buffer[] = []
        let pendingBytes = 0
        let isSocketPaused = false
        const FLUSH_THRESHOLD = 1024 * 1024 * 4 // 4MB high-throughput batch buffer for Gigabit networks (100MB/s+)

        const flushBuffer = () => {
          if (pendingBuffers.length === 0 || this.fileDescriptor === null || this.isAborted) return
          const writeOffset = chunk.start + chunk.downloaded
          const merged = pendingBuffers.length === 1 ? pendingBuffers[0] : Buffer.concat(pendingBuffers, pendingBytes)

          try {
            fs.writeSync(this.fileDescriptor, merged, 0, merged.length, writeOffset)
            chunk.downloaded += merged.length
            this.downloadedBytes += merged.length
            pendingBuffers = []
            pendingBytes = 0

            if (isSocketPaused) {
              isSocketPaused = false
              res.resume()
            }
          } catch (writeErr: any) {
            req.destroy()
            chunk.status = 'error'
            throw new Error(`Disk write failed on chunk ${chunk.id}: ${writeErr.message}`)
          }
        }

        res.on('data', (buf: Buffer) => {
          if (this.isAborted || this.fileDescriptor === null) return
          pendingBuffers.push(buf)
          pendingBytes += buf.length

          // Backpressure: Pause network socket if disk is slower than Gigabit stream
          if (pendingBytes >= FLUSH_THRESHOLD * 2 && !isSocketPaused) {
            isSocketPaused = true
            res.pause()
          }

          if (pendingBytes >= FLUSH_THRESHOLD) {
            try {
              flushBuffer()
            } catch (err: any) {
              reject(err)
            }
          }
        })

        res.on('end', () => {
          if (this.isAborted) return resolve()
          try {
            flushBuffer()
          } catch (err: any) {
            return reject(err)
          }

          if (chunk.downloaded >= chunk.total) {
            chunk.status = 'completed'
            resolve()
          } else {
            if (retries > 0 && !this.isAborted) {
              setTimeout(() => {
                resolve(this.downloadChunkWorker(finalUrl, chunk, retries - 1))
              }, 500)
            } else {
              chunk.status = 'error'
              reject(new Error(`Segment ${chunk.id} stream cut off unexpectedly`))
            }
          }
        })

        res.on('error', (err) => {
          if (this.isAborted) return resolve()
          if (retries > 0) {
            setTimeout(() => {
              resolve(this.downloadChunkWorker(finalUrl, chunk, retries - 1))
            }, 1000)
          } else {
            chunk.status = 'error'
            reject(err)
          }
        })
      })

      req.on('timeout', () => {
        req.destroy()
        if (retries > 0 && !this.isAborted) {
          setTimeout(() => {
            resolve(this.downloadChunkWorker(finalUrl, chunk, retries - 1))
          }, 1000)
        } else {
          chunk.status = 'error'
          reject(new Error(`Segment ${chunk.id} timed out`))
        }
      })

      req.on('error', (err) => {
        if (this.isAborted) return resolve()
        if (retries > 0) {
          setTimeout(() => {
            resolve(this.downloadChunkWorker(finalUrl, chunk, retries - 1))
          }, 1000)
        } else {
          chunk.status = 'error'
          reject(err)
        }
      })

      this.activeRequests.push(req)
      req.end()
    })
  }

  private startSingleStreamDownload(finalUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.status = 'downloading'
      this.connections = 1
      this.chunks = []
      this.startProgressTimer()

      let existingBytes = 0
      if (fs.existsSync(this.partFilePath)) {
        existingBytes = fs.statSync(this.partFilePath).size
      }

      this.downloadedBytes = existingBytes
      this.lastReportBytes = existingBytes
      this.lastReportTime = Date.now()

      const parsedUrl = new URL(finalUrl)
      const isHttps = parsedUrl.protocol === 'https:'
      const client = isHttps ? https : http

      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*'
      }
      if (existingBytes > 0) {
        headers['Range'] = `bytes=${existingBytes}-`
      }

      const reqOptions: http.RequestOptions = {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers,
        agent: isHttps ? httpsAgent : httpAgent,
        timeout: 30000
      }

      const req = client.request(reqOptions, (res) => {
        const statusCode = res.statusCode || 200
        const writeFlags = statusCode === 206 ? 'a' : 'w'
        if (statusCode === 200) {
          this.downloadedBytes = 0
          this.lastReportBytes = 0
        }

        const writeStream = fs.createWriteStream(this.partFilePath, {
          flags: writeFlags,
          highWaterMark: 1024 * 1024 * 8
        })

        res.on('data', (chunk: Buffer) => {
          this.downloadedBytes += chunk.length
        })

        writeStream.on('error', (err) => {
          req.destroy()
          reject(new Error(`Disk write error: ${err.message}`))
        })

        res.on('end', () => {
          writeStream.end(() => {
            if (this.isAborted) return resolve()
            this.finalizeDownload()
            resolve()
          })
        })

        res.pipe(writeStream)
      })

      req.on('error', (err) => {
        if (this.isAborted) return resolve()
        reject(err)
      })

      this.activeRequests.push(req)
      req.end()
    })
  }

  private saveMetadata(): void {
    if (this.chunks.length === 0 || this.status === 'completed') return
    try {
      const meta: DownloadMetaFile = {
        id: this.id,
        url: this.url,
        fileName: this.fileName,
        totalBytes: this.totalBytes,
        connections: this.connections,
        chunks: this.chunks,
        updatedAt: Date.now()
      }
      fs.writeFileSync(this.metaFilePath, JSON.stringify(meta, null, 2))
    } catch {
      // ignore
    }
  }

  private finalizeDownload(): void {
    this.status = 'completed'
    this.speedBytesPerSec = 0
    this.cleanup()

    try {
      if (fs.existsSync(this.metaFilePath)) {
        fs.unlinkSync(this.metaFilePath)
      }
      if (fs.existsSync(this.partFilePath)) {
        if (fs.existsSync(this.filePath)) {
          fs.unlinkSync(this.filePath)
        }
        fs.renameSync(this.partFilePath, this.filePath)
      }
    } catch (err: any) {
      this.status = 'error'
      this.errorMessage = `Failed to finalize file: ${err.message}`
    }

    this.emitProgress()
  }

  public pause(): void {
    if (this.status !== 'downloading' && this.status !== 'initializing') return

    this.isAborted = true
    this.status = 'paused'
    this.speedBytesPerSec = 0
    this.saveMetadata()
    this.cleanup()
    this.emitProgress()
  }

  public resume(): void {
    if (this.status === 'paused' || this.status === 'error') {
      this.start()
    }
  }

  public cancel(): void {
    this.isAborted = true
    this.status = 'cancelled'
    this.speedBytesPerSec = 0
    this.cleanup()

    try {
      if (fs.existsSync(this.metaFilePath)) {
        fs.unlinkSync(this.metaFilePath)
      }
      if (fs.existsSync(this.partFilePath)) {
        fs.unlinkSync(this.partFilePath)
      }
    } catch {
      // ignore
    }

    this.downloadedBytes = 0
    this.emitProgress()
  }

  private startProgressTimer(): void {
    this.stopProgressTimer()
    this.progressInterval = setInterval(() => {
      this.calculateSpeed()
      this.emitProgress()
    }, 250)
  }

  private startMetaSaveTimer(): void {
    this.stopMetaSaveTimer()
    this.metaSaveInterval = setInterval(() => {
      this.saveMetadata()
    }, 2000)
  }

  private stopProgressTimer(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval)
      this.progressInterval = null
    }
  }

  private stopMetaSaveTimer(): void {
    if (this.metaSaveInterval) {
      clearInterval(this.metaSaveInterval)
      this.metaSaveInterval = null
    }
  }

  private calculateSpeed(): void {
    const now = Date.now()
    const elapsedSec = (now - this.lastReportTime) / 1000
    
    if (elapsedSec >= 0.2) {
      const bytesDelta = this.downloadedBytes - this.lastReportBytes
      const currentSpeed = Math.max(0, bytesDelta / elapsedSec)

      this.speedSamples.push(currentSpeed)
      if (this.speedSamples.length > 5) {
        this.speedSamples.shift()
      }

      const sum = this.speedSamples.reduce((a, b) => a + b, 0)
      this.speedBytesPerSec = Math.round(sum / this.speedSamples.length)

      this.lastReportTime = now
      this.lastReportBytes = this.downloadedBytes
    }
  }

  private cleanup(): void {
    this.stopProgressTimer()
    this.stopMetaSaveTimer()

    for (const req of this.activeRequests) {
      try {
        req.destroy()
      } catch {
        // ignore
      }
    }
    this.activeRequests = []

    if (this.fileDescriptor !== null) {
      try {
        fs.closeSync(this.fileDescriptor)
      } catch {
        // ignore
      }
      this.fileDescriptor = null
    }
  }

  private emitProgress(): void {
    this.emit('progress', this.getProgress())
  }
}
