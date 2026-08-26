import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface DiskInfo {
  driveLetter: string
  folderPath: string
  fileSystem: string
  driveType: 'Fixed' | 'Removable' | 'Network' | 'CD-ROM' | 'Unknown'
  isFat32: boolean
  isRemovable: boolean
  freeBytes: number
  totalBytes: number
  recommendedConnections: number
  recommendedFlushThreshold: number
  warning?: string
}

const volumeCache: Map<string, { info: Partial<DiskInfo>; timestamp: number }> = new Map()

export async function inspectPath(folderPath: string): Promise<DiskInfo> {
  const resolved = path.resolve(folderPath)
  let freeBytes = 0
  let totalBytes = 0

  try {
    if (fs.existsSync(resolved)) {
      const stats = fs.statfsSync(resolved)
      freeBytes = Number(stats.bavail) * Number(stats.bsize)
      totalBytes = Number(stats.blocks) * Number(stats.bsize)
    }
  } catch {
    // fallback
  }

  const isWindows = process.platform === 'win32'
  let driveLetter = ''
  let fileSystem = 'NTFS'
  let driveType: DiskInfo['driveType'] = 'Fixed'
  let isRemovable = false
  let isFat32 = false

  if (isWindows) {
    const match = resolved.match(/^([a-zA-Z]):/i)
    driveLetter = match ? match[1].toUpperCase() : 'C'

    const cached = volumeCache.get(driveLetter)
    const now = Date.now()

    if (cached && now - cached.timestamp < 30000) {
      fileSystem = cached.info.fileSystem || fileSystem
      driveType = cached.info.driveType || driveType
      isRemovable = cached.info.isRemovable || isRemovable
      isFat32 = cached.info.isFat32 || isFat32
    } else {
      try {
        const cmd = `powershell -NoProfile -Command "Get-Volume -DriveLetter ${driveLetter} | Select-Object FileSystemType, FileSystem, DriveType, SizeRemaining, Size | ConvertTo-Json -Compress"`
        const { stdout } = await execAsync(cmd, { timeout: 3000 })
        if (stdout && stdout.trim().startsWith('{')) {
          const parsed = JSON.parse(stdout.trim())
          fileSystem = (parsed.FileSystem || parsed.FileSystemType || 'NTFS').toUpperCase()
          driveType = parsed.DriveType || 'Fixed'
          isRemovable = driveType === 'Removable'
          isFat32 = fileSystem.includes('FAT32') || fileSystem.includes('FAT')
          if (parsed.SizeRemaining) freeBytes = Number(parsed.SizeRemaining)
          if (parsed.Size) totalBytes = Number(parsed.Size)

          volumeCache.set(driveLetter, {
            info: { fileSystem, driveType, isRemovable, isFat32 },
            timestamp: now
          })
        }
      } catch {
        // fallback
      }
    }
  } else {
    driveLetter = '/'
  }

  let warning: string | undefined
  if (isFat32) {
    warning = `DİKKAT: ${driveLetter}: sürücüsü FAT32 formatında. 4GB'tan büyük tek dosya indirilemez. exFAT veya NTFS kullanın.`
  }

  let recommendedConnections = 8
  let recommendedFlushThreshold = 1024 * 1024 * 4

  if (isRemovable) {
    recommendedConnections = 4
    recommendedFlushThreshold = 1024 * 1024 * 4
  } else if (driveType === 'Fixed') {
    recommendedConnections = 8
    recommendedFlushThreshold = 1024 * 1024 * 4
  }

  const freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(2)
  const totalGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2)

  console.log(`💾 [DiskInspector] Path: "${resolved}" | Sürücü: ${driveLetter}: | Dosya Sistemi: ${fileSystem} | Tip: ${driveType} | Boş Alan: ${freeGB} GB / ${totalGB} GB | Önerilen Akış: ${recommendedConnections}x`)
  if (warning) {
    console.warn(`⚠️ [DiskInspector Uyarısı] ${warning}`)
  }

  return {
    driveLetter,
    folderPath: resolved,
    fileSystem,
    driveType,
    isFat32,
    isRemovable,
    freeBytes,
    totalBytes,
    recommendedConnections,
    recommendedFlushThreshold,
    warning
  }
}
