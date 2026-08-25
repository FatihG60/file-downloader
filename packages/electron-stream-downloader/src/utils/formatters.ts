export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === -1) return 'Unknown size'
  if (bytes === 0) return '0 B'

  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

  const i = Math.floor(Math.log(bytes) / Math.log(k))

  if (i < 0) return '0 B'
  if (i >= sizes.length) return `${(bytes / Math.pow(k, sizes.length - 1)).toFixed(dm)} ${sizes[sizes.length - 1]}`

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
}

export function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 B/s'
  return `${formatBytes(bytesPerSec, 1)}/s`
}

export function formatDuration(totalSeconds: number): string {
  if (!totalSeconds || totalSeconds <= 0 || !isFinite(totalSeconds)) {
    return '--:--'
  }

  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)

  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`
  }
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}
