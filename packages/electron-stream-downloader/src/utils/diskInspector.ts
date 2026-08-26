import fs from 'node:fs'
import path from 'node:path'

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
  inspectDurationMs: number
  warning?: string
}

let win32Native: {
  GetVolumeInformationW: any
  GetDiskFreeSpaceExW: any
  GetDriveTypeW: any
  CreateFileW: any
  DeviceIoControl: any
  CloseHandle: any
} | null = null

function initWin32Bindings() {
  if (process.platform !== 'win32') return null
  if (win32Native !== null) return win32Native

  try {
    const koffi = require('koffi')
    const k32 = koffi.load('kernel32.dll')

    const GetVolumeInformationW = k32.func(
      'bool __stdcall GetVolumeInformationW(' +
      'str16 lpRootPathName, ' +
      '_Out_ uint16 *lpVolumeNameBuffer, uint32 nVolumeNameSize, ' +
      '_Out_ uint32 *lpVolumeSerialNumber, ' +
      '_Out_ uint32 *lpMaximumComponentLength, ' +
      '_Out_ uint32 *lpFileSystemFlags, ' +
      '_Out_ uint16 *lpFileSystemNameBuffer, uint32 nFileSystemNameSize)'
    )

    const GetDiskFreeSpaceExW = k32.func(
      'bool __stdcall GetDiskFreeSpaceExW(' +
      'str16 lpDirectoryName, ' +
      '_Out_ uint64 *lpFreeBytesAvailableToCaller, ' +
      '_Out_ uint64 *lpTotalNumberOfBytes, ' +
      '_Out_ uint64 *lpTotalNumberOfFreeBytes)'
    )

    const GetDriveTypeW = k32.func('uint32 __stdcall GetDriveTypeW(str16 lpRootPathName)')

    const CreateFileW = k32.func(
      'intptr_t __stdcall CreateFileW(' +
      'str16 lpFileName, uint32 dwDesiredAccess, uint32 dwShareMode, ' +
      'void *lpSecurityAttributes, uint32 dwCreationDisposition, ' +
      'uint32 dwFlagsAndAttributes, void *hTemplateFile)'
    )

    const DeviceIoControl = k32.func(
      'bool __stdcall DeviceIoControl(' +
      'intptr_t hDevice, uint32 dwIoControlCode, void *lpInBuffer, ' +
      'uint32 nInBufferSize, _Out_ void *lpOutBuffer, uint32 nOutBufferSize, ' +
      '_Out_ uint32 *lpBytesReturned, void *lpOverlapped)'
    )

    const CloseHandle = k32.func('bool __stdcall CloseHandle(intptr_t hObject)')

    win32Native = {
      GetVolumeInformationW,
      GetDiskFreeSpaceExW,
      GetDriveTypeW,
      CreateFileW,
      DeviceIoControl,
      CloseHandle
    }
    return win32Native
  } catch {
    return null
  }
}

export async function inspectPath(folderPath: string): Promise<DiskInfo> {
  const startTime = performance.now()
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
  let busType: DiskInfo['busType'] = 'Unknown'
  let usbVersion: DiskInfo['usbVersion'] = undefined
  let modelName = 'Depolama Sürücüsü'
  let isRemovable = false
  let isUsb = false
  let isFat32 = false
  let maxTransferLength = 0

  if (isWindows) {
    const match = resolved.match(/^([a-zA-Z]):/i)
    driveLetter = match ? match[1].toUpperCase() : 'C'
    const rootDrive = `${driveLetter}:\\`

    const win32 = initWin32Bindings()

    if (win32) {
      try {
        const fsNameBuf = Buffer.alloc(512)
        const volNameBuf = Buffer.alloc(512)
        const serial = [0], maxComp = [0], flags = [0]
        const volOk = win32.GetVolumeInformationW(rootDrive, volNameBuf, 256, serial, maxComp, flags, fsNameBuf, 256)
        if (volOk) {
          const rawFs = fsNameBuf.toString('utf16le').replace(/\0.*$/g, '').trim().toUpperCase()
          if (rawFs) fileSystem = rawFs
        }
      } catch {
        // fallback
      }

      try {
        const freeCaller = [0n]
        const total = [0n]
        const totalFree = [0n]
        const spaceOk = win32.GetDiskFreeSpaceExW(rootDrive, freeCaller, total, totalFree)
        if (spaceOk) {
          if (Number(freeCaller[0]) > 0) freeBytes = Number(freeCaller[0])
          if (Number(total[0]) > 0) totalBytes = Number(total[0])
        }
      } catch {
        // fallback
      }

      try {
        const dType = win32.GetDriveTypeW(rootDrive)
        if (dType === 2) {
          driveType = 'Removable'
          isRemovable = true
          isUsb = true
        } else if (dType === 3) {
          driveType = 'Fixed'
        } else if (dType === 4) {
          driveType = 'Network'
        } else if (dType === 5) {
          driveType = 'CD-ROM'
        }
      } catch {
        // fallback
      }

      try {
        const hVolume = win32.CreateFileW(`\\\\.\\${driveLetter}:`, 0, 7, null, 3, 0, null)
        if (hVolume && hVolume !== -1 && hVolume !== 0) {
          const IOCTL_STORAGE_QUERY_PROPERTY = 0x002D1400

          const inBuf = Buffer.alloc(12)
          inBuf.writeUInt32LE(0, 0)
          inBuf.writeUInt32LE(0, 4)

          const outBuf = Buffer.alloc(2048)
          const bytesReturned = [0]
          const ioOk = win32.DeviceIoControl(hVolume, IOCTL_STORAGE_QUERY_PROPERTY, inBuf, 12, outBuf, 2048, bytesReturned, null)

          if (ioOk && bytesReturned[0] >= 32) {
            const rawBusType = outBuf.readInt32LE(28)
            const vendorOffset = outBuf.readUInt32LE(12)
            const prodOffset = outBuf.readUInt32LE(16)

            let vendor = ''
            let prod = ''
            if (vendorOffset > 0 && vendorOffset < bytesReturned[0]) {
              vendor = outBuf.toString('ascii', vendorOffset, outBuf.indexOf(0, vendorOffset)).trim()
            }
            if (prodOffset > 0 && prodOffset < bytesReturned[0]) {
              prod = outBuf.toString('ascii', prodOffset, outBuf.indexOf(0, prodOffset)).trim()
            }

            const fullName = [vendor, prod].filter(Boolean).join(' ').trim()
            if (fullName) modelName = fullName

            switch (rawBusType) {
              case 0x11:
                busType = 'NVMe'
                break
              case 0x07:
                busType = 'USB'
                isUsb = true
                isRemovable = true
                break
              case 0x0A:
                busType = 'SAS'
                break
              case 0x0B:
                busType = 'SATA'
                break
              case 0x08:
              case 0x01:
                busType = 'RAID'
                break
              default:
                if (isRemovable) busType = 'USB'
                break
            }
          }

          if (busType === 'USB' || isUsb) {
            const inBufAdapter = Buffer.alloc(12)
            inBufAdapter.writeUInt32LE(1, 0)
            inBufAdapter.writeUInt32LE(0, 4)

            const outBufAdapter = Buffer.alloc(1024)
            const ioAdapterOk = win32.DeviceIoControl(hVolume, IOCTL_STORAGE_QUERY_PROPERTY, inBufAdapter, 12, outBufAdapter, 1024, bytesReturned, null)

            if (ioAdapterOk && bytesReturned[0] >= 12) {
              maxTransferLength = outBufAdapter.readUInt32LE(8)
              if (maxTransferLength > 0 && maxTransferLength <= 131072) {
                usbVersion = 'USB 2.0'
              } else if (maxTransferLength > 131072) {
                usbVersion = 'USB 3.0+'
              } else {
                usbVersion = 'USB'
              }
            } else {
              usbVersion = 'USB'
            }
          }

          win32.CloseHandle(hVolume)
        }
      } catch {
        // fallback
      }

      const isExFat = fileSystem.includes('EXFAT')
      isFat32 = !isExFat && (fileSystem.includes('FAT32') || fileSystem.includes('FAT16') || fileSystem === 'FAT')
    }
  } else {
    driveLetter = '/'
  }

  let warning: string | undefined
  if (isFat32) {
    warning = `DİKKAT: ${driveLetter}: sürücüsü FAT32 formatında. 4GB'tan büyük tek dosya indirilemez. exFAT veya NTFS kullanın.`
  }

  let recommendedConnections = 8
  let recommendedFlushThreshold = 1024 * 1024 * 4 // 4MB
  let profileLabel = 'SSD / Dahili Sürücü'

  if (usbVersion === 'USB 2.0') {
    recommendedConnections = 2
    recommendedFlushThreshold = 1024 * 1024 * 4
    profileLabel = `USB 2.0 (${modelName}) • Max ~30 MB/s`
    if (!warning) {
      warning = `Bilgi: Sürücü USB 2.0 protokolü ile bağlı (${modelName}). Darboğazı ve donmayı önlemek için 2x akış önerilir.`
    }
  } else if (usbVersion === 'USB 3.0+' || isUsb) {
    recommendedConnections = 4
    recommendedFlushThreshold = 1024 * 1024 * 4
    profileLabel = `USB 3.0+ (${modelName})`
  } else if (busType === 'NVMe') {
    recommendedConnections = 16
    recommendedFlushThreshold = 1024 * 1024 * 4
    profileLabel = `NVMe SSD (${modelName}) • Ultra Hızlı`
  } else if (busType === 'SAS' || busType === 'RAID') {
    recommendedConnections = 8
    recommendedFlushThreshold = 1024 * 1024 * 4
    profileLabel = `Kurumsal SAS/RAID (${modelName})`
  } else {
    recommendedConnections = 8
    recommendedFlushThreshold = 1024 * 1024 * 4
    profileLabel = `${busType !== 'Unknown' ? busType : 'Sabit'} Disk (${modelName})`
  }

  const freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(2)
  const totalGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2)
  const inspectDurationMs = Number((performance.now() - startTime).toFixed(3))
  const hardwareBadge = usbVersion || busType

  console.log(`⚡ [Native Win32 DiskInspector (${inspectDurationMs}ms)] Path: "${resolved}" | Sürücü: ${driveLetter}: (${modelName}) | Arayüz: ${hardwareBadge} | Dosya Sistemi: ${fileSystem} | Tip: ${driveType} | Boş Alan: ${freeGB} GB / ${totalGB} GB | Önerilen Akış: ${recommendedConnections}x (${profileLabel})`)
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
    inspectDurationMs,
    warning
  }
}
