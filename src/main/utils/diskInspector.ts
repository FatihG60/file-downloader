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
  usbVersion?: 'USB 2.0' | 'USB 3.0+' | 'USB'
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
  let usbVersion: DiskInfo['usbVersion'] = undefined
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
      usbVersion = cached.info.usbVersion
      modelName = cached.info.modelName || modelName
      isRemovable = cached.info.isRemovable || isRemovable
      isUsb = cached.info.isUsb || isUsb
      isFat32 = cached.info.isFat32 || isFat32
    } else {
      try {
        const cmd = `powershell -NoProfile -Command "& { $p = Get-Partition -DriveLetter ${driveLetter}; $d = Get-Disk -Number $p.DiskNumber; $v = Get-Volume -DriveLetter ${driveLetter}; $bus = $d.BusType; $usbVer = ''; if ($bus -eq 'USB') { $dev = Get-PnpDevice -Class DiskDrive | Where-Object { $_.InstanceId -match 'USBSTOR|UASPSTOR' -and $_.FriendlyName -match $d.FriendlyName } | Select-Object -First 1; if ($dev) { $parent = (Get-PnpDeviceProperty -InstanceId $dev.InstanceId -KeyName 'DEVPKEY_Device_Parent').Data; $speed = (Get-PnpDeviceProperty -InstanceId $parent -KeyName '{8DBC9C86-97A9-4BFF-9BC6-BFE95D3E6DAD} 15').Data; if ($speed -eq 2) { $usbVer = 'USB 2.0' } elseif ($speed -ge 3) { $usbVer = 'USB 3.0+' } } if (-not $usbVer) { $usbVer = 'USB' } }; [PSCustomObject]@{ DriveLetter='${driveLetter}'; FileSystem=$v.FileSystem; DriveType=$v.DriveType; BusType=$bus; UsbVersion=$usbVer; Model=$d.FriendlyName; FreeSpace=$v.SizeRemaining; Capacity=$v.Size } | ConvertTo-Json -Compress }"`
        const { stdout } = await execAsync(cmd, { timeout: 4000 })
        if (stdout && stdout.trim().startsWith('{')) {
          const parsed = JSON.parse(stdout.trim())
          fileSystem = (parsed.FileSystem || 'NTFS').toUpperCase()
          driveType = parsed.DriveType || 'Fixed'
          const rawBus = (parsed.BusType || '').toUpperCase()
          modelName = parsed.Model || 'Depolama Sürücüsü'
          const rawUsbVer = parsed.UsbVersion || ''

          if (rawBus.includes('NVME')) busType = 'NVMe'
          else if (rawBus.includes('USB')) busType = 'USB'
          else if (rawBus.includes('SAS')) busType = 'SAS'
          else if (rawBus.includes('SATA')) busType = 'SATA'
          else if (rawBus.includes('SCSI') || rawBus.includes('RAID')) busType = 'RAID'
          else busType = 'Unknown'

          if (rawUsbVer === 'USB 2.0') usbVersion = 'USB 2.0'
          else if (rawUsbVer === 'USB 3.0+') usbVersion = 'USB 3.0+'
          else if (busType === 'USB') usbVersion = 'USB'

          isUsb = busType === 'USB' || driveType === 'Removable'
          isRemovable = driveType === 'Removable' || isUsb
          const isExFat = fileSystem.includes('EXFAT')
          isFat32 = !isExFat && (fileSystem.includes('FAT32') || fileSystem.includes('FAT16') || fileSystem === 'FAT')

          if (parsed.FreeSpace) freeBytes = Number(parsed.FreeSpace)
          if (parsed.Capacity) totalBytes = Number(parsed.Capacity)

          volumeCache.set(driveLetter, {
            info: { fileSystem, driveType, busType, usbVersion, modelName, isRemovable, isUsb, isFat32 },
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

  // Determine warnings and granular speed profiles
  let warning: string | undefined
  if (isFat32) {
    warning = `DİKKAT: ${driveLetter}: sürücüsü FAT32 formatında. 4GB'tan büyük tek dosya indirilemez. exFAT veya NTFS kullanın.`
  }

  let recommendedConnections = 8
  let recommendedFlushThreshold = 1024 * 1024 * 4 // 4MB
  let profileLabel = 'SSD / Dahili Sürücü'

  if (usbVersion === 'USB 2.0') {
    // USB 2.0 (Cruzer Blade etc.): max 30-35 MB/s throughput
    recommendedConnections = 2
    recommendedFlushThreshold = 1024 * 1024 * 4
    profileLabel = `USB 2.0 (${modelName}) • Max ~30 MB/s`
    if (!warning) {
      warning = `Bilgi: Sürücü USB 2.0 portuna bağlı (${modelName}). Darboğazı ve donmayı önlemek için 2x akış önerilir.`
    }
  } else if (usbVersion === 'USB 3.0+' || isUsb) {
    // USB 3.0 / 3.1 / 3.2 SuperSpeed (100 - 500+ MB/s)
    recommendedConnections = 4
    recommendedFlushThreshold = 1024 * 1024 * 4
    profileLabel = `USB 3.0+ (${modelName})`
  } else if (busType === 'NVMe') {
    // Ultra-Fast NVMe SSD (Samsung 990 Pro etc.)
    recommendedConnections = 16
    recommendedFlushThreshold = 1024 * 1024 * 4
    profileLabel = `NVMe SSD (${modelName}) • Ultra Hızlı`
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
  const hardwareBadge = usbVersion || busType

  console.log(`💾 [DiskInspector] Path: "${resolved}" | Sürücü: ${driveLetter}: (${modelName}) | Arayüz: ${hardwareBadge} | Dosya Sistemi: ${fileSystem} | Tip: ${driveType} | Boş Alan: ${freeGB} GB / ${totalGB} GB | Önerilen Akış: ${recommendedConnections}x (${profileLabel})`)
  if (warning) {
    console.warn(`⚠️ [DiskInspector Uyarısı] ${warning}`)
  }

  return {
    driveLetter,
    folderPath: resolved,
    fileSystem,
    driveType,
    busType,
    usbVersion,
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
