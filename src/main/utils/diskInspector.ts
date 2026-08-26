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
  busType: 'NVMe' | 'SATA' | 'SAS' | 'USB' | 'SCSI' | 'RAID' | 'Unknown'
  modelName: string
  isFat32: boolean
  isRemovable: boolean
  isUsb: boolean
  freeBytes: number
  totalBytes: number
  recommendedConnections: number
  recommendedFlushThreshold: number
  profileLabel: string
  warning?: string
}

// Memory cache per drive letter
const volumeCache: Map<string, { info: Partial<DiskInfo>; timestamp: number }> = new Map()

export async function inspectPath(folderPath: string): Promise<DiskInfo> {
  const resolved = path.resolve(folderPath)
  let freeBytes = 0
  let totalBytes = 0

  // 1. Fast native statfs for free / total space
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
  let busType: DiskInfo['busType'] = 'Unknown'
  let modelName = 'Depolama Sürücüsü'
  let isRemovable = false
  let isUsb = false
  let isFat32 = false

  if (isWindows) {
    const match = resolved.match(/^([a-zA-Z]):/i)
    driveLetter = match ? match[1].toUpperCase() : 'C'

    const cached = volumeCache.get(driveLetter)
    const now = Date.now()

    if (cached && now - cached.timestamp < 15000) {
      fileSystem = cached.info.fileSystem || fileSystem
      driveType = cached.info.driveType || driveType
      busType = cached.info.busType || busType
      modelName = cached.info.modelName || modelName
      isRemovable = cached.info.isRemovable || isRemovable
      isUsb = cached.info.isUsb || isUsb
      isFat32 = cached.info.isFat32 || isFat32
    } else {
      try {
        const cmd = `powershell -NoProfile -Command "Get-Partition -DriveLetter ${driveLetter} | Select-Object DriveLetter, @{N='BusType';E={(Get-Disk -Number $_.DiskNumber).BusType}}, @{N='Model';E={(Get-Disk -Number $_.DiskNumber).FriendlyName}}, @{N='FileSystem';E={(Get-Volume -DriveLetter $_.DriveLetter).FileSystem}}, @{N='DriveType';E={(Get-Volume -DriveLetter $_.DriveLetter).DriveType}} | ConvertTo-Json -Compress"`
        const { stdout } = await execAsync(cmd, { timeout: 3500 })
        if (stdout && stdout.trim().startsWith('{')) {
          const parsed = JSON.parse(stdout.trim())
          fileSystem = (parsed.FileSystem || 'NTFS').toUpperCase()
          driveType = parsed.DriveType || 'Fixed'
          const rawBus = (parsed.BusType || '').toUpperCase()
          modelName = parsed.Model || 'Depolama Sürücüsü'

          if (rawBus.includes('NVME')) busType = 'NVMe'
          else if (rawBus.includes('USB')) busType = 'USB'
          else if (rawBus.includes('SAS')) busType = 'SAS'
          else if (rawBus.includes('SATA')) busType = 'SATA'
          else if (rawBus.includes('SCSI') || rawBus.includes('RAID')) busType = 'RAID'
          else busType = 'Unknown'

          isUsb = busType === 'USB' || driveType === 'Removable'
          isRemovable = driveType === 'Removable' || isUsb
          const isExFat = fileSystem.includes('EXFAT')
          isFat32 = !isExFat && (fileSystem.includes('FAT32') || fileSystem.includes('FAT16') || fileSystem === 'FAT')

          volumeCache.set(driveLetter, {
            info: { fileSystem, driveType, busType, modelName, isRemovable, isUsb, isFat32 },
            timestamp: now
          })
        }
      } catch {
        // fallback to defaults if powershell times out
      }
    }
  } else {
    driveLetter = '/'
  }

  // Determine warnings and recommendations
  let warning: string | undefined
  if (isFat32) {
    warning = `DİKKAT: ${driveLetter}: sürücüsü FAT32 formatında. 4GB'tan büyük tek dosya indirilemez. exFAT veya NTFS kullanın.`
  }

  // Granular connection recommendation based on BusType & Hardware Media
  let recommendedConnections = 8
  let recommendedFlushThreshold = 1024 * 1024 * 4 // 4MB
  let profileLabel = 'SSD / Dahili Sürücü'

  if (isUsb || busType === 'USB') {
    // USB 2.0 / 3.0 Flash Drive
    recommendedConnections = 4
    recommendedFlushThreshold = 1024 * 1024 * 4
    profileLabel = `USB Sürücü (${modelName})`
  } else if (busType === 'NVMe') {
    // Ultra-Fast NVMe SSD (Samsung 990 Pro etc.)
    recommendedConnections = 16
    recommendedFlushThreshold = 1024 * 1024 * 4
    profileLabel = `NVMe SSD (${modelName})`
  } else if (busType === 'SAS' || busType === 'RAID') {
    // Enterprise SAS / RAID Array
    recommendedConnections = 8
    recommendedFlushThreshold = 1024 * 1024 * 4
    profileLabel = `Kurumsal SAS/RAID (${modelName})`
  } else {
    // Standard SATA SSD / Fixed Drive
    recommendedConnections = 8
    recommendedFlushThreshold = 1024 * 1024 * 4
    profileLabel = `${busType !== 'Unknown' ? busType : 'Sabit'} Disk (${modelName})`
  }

  const freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(2)
  const totalGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2)

  console.log(`💾 [DiskInspector] Path: "${resolved}" | Sürücü: ${driveLetter}: (${modelName}) | Veriyolu (Bus): ${busType} | Dosya Sistemi: ${fileSystem} | Tip: ${driveType} | Boş Alan: ${freeGB} GB / ${totalGB} GB | Önerilen Akış: ${recommendedConnections}x (${profileLabel})`)
  if (warning) {
    console.warn(`⚠️ [DiskInspector Uyarısı] ${warning}`)
  }

  return {
    driveLetter,
    folderPath: resolved,
    fileSystem,
    driveType,
    busType,
    modelName,
    isFat32,
    isRemovable,
    isUsb,
    freeBytes,
    totalBytes,
    recommendedConnections,
    recommendedFlushThreshold,
    profileLabel,
    warning
  }
}
