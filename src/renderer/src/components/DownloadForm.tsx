import React, { useState, useEffect } from 'react'
import { FolderOpen, DownloadCloud, Link2, Zap, HardDrive, AlertTriangle } from 'lucide-react'
import { formatBytes } from '../utils/formatters'

interface DownloadFormProps {
  onStartDownload: (
    url: string,
    destinationFolder: string,
    customFileName?: string,
    connections?: number
  ) => void
  defaultDestination: string
}

const CONNECTION_OPTIONS = [
  { value: 0, label: '⚡ Otomatik (Akıllı Disk Algılama - Önerilen)' },
  { value: 1, label: '1x (Tek Akış)' },
  { value: 4, label: '4x (Hızlı Paralel / USB)' },
  { value: 8, label: '8x (Turbo - SSD/NVMe)' },
  { value: 16, label: '16x (Ultra Turbo - Gigabit/NVMe)' }
]

export const DownloadForm: React.FC<DownloadFormProps> = ({
  onStartDownload,
  defaultDestination,
}) => {
  const [url, setUrl] = useState('')
  const [destinationFolder, setDestinationFolder] = useState(defaultDestination)
  const [customFileName, setCustomFileName] = useState('')
  const [connections, setConnections] = useState<number>(0) // 0 = Auto Smart Profile
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [diskInfo, setDiskInfo] = useState<any>(null)

  useEffect(() => {
    if (!destinationFolder && defaultDestination) {
      setDestinationFolder(defaultDestination)
    }
  }, [defaultDestination, destinationFolder])

  useEffect(() => {
    if (destinationFolder && window.electronAPI?.inspectPath) {
      window.electronAPI.inspectPath(destinationFolder).then((info) => {
        if (info) {
          setDiskInfo(info)
          console.log('💾 [Renderer Disk Info]:', info)
        }
      }).catch((err) => {
        console.error('Failed to inspect path:', err)
      })
    }
  }, [destinationFolder])

  const handleBrowseFolder = async () => {
    try {
      const selected = await window.electronAPI.selectDirectory()
      if (selected) {
        setDestinationFolder(selected)
      }
    } catch (err) {
      console.error('Failed to select directory', err)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim()) return

    setIsSubmitting(true)
    onStartDownload(
      url.trim(),
      destinationFolder,
      customFileName.trim() || undefined,
      connections
    )
    setUrl('')
    setCustomFileName('')
    setIsSubmitting(false)
  }

  return (
    <div className="card form-card">
      <div className="card-header">
        <div className="header-icon-wrapper">
          <DownloadCloud className="header-icon" />
        </div>
        <div>
          <h2>Dosya İndir</h2>
          <p className="subtitle">İndirme bağlantısını ve hedef klasörü belirtin.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="download-form">
        <div className="form-group">
          <label htmlFor="download-url">
            <Link2 size={15} /> İndirme Bağlantısı (URL / S3 Presigned URL)
          </label>
          <input
            id="download-url"
            type="url"
            placeholder="https://..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            className="input-field"
          />
        </div>

        <div className="form-row">
          <div className="form-group flex-1">
            <div className="label-with-disk-info">
              <label htmlFor="dest-folder">
                <FolderOpen size={15} /> Kaydedilecek Dizin
              </label>
              {diskInfo && (
                <span className={`disk-badge ${diskInfo.isFat32 ? 'disk-badge-danger' : 'disk-badge-info'}`}>
                  <HardDrive size={12} />
                  <span>
                    {diskInfo.driveLetter}: ({diskInfo.fileSystem}) • {formatBytes(diskInfo.freeBytes)} Boş
                  </span>
                </span>
              )}
            </div>
            <div className="input-with-button">
              <input
                id="dest-folder"
                type="text"
                value={destinationFolder}
                onChange={(e) => setDestinationFolder(e.target.value)}
                placeholder="C:\Users\...\Downloads"
                className="input-field"
                required
              />
              <button
                type="button"
                onClick={handleBrowseFolder}
                className="btn btn-secondary browse-btn"
                title="Dizin Seç"
              >
                <FolderOpen size={15} />
                <span>Gözat</span>
              </button>
            </div>
          </div>

          <div className="form-group flex-1">
            <label htmlFor="custom-filename">Özel Dosya Adı (İsteğe Bağlı)</label>
            <input
              id="custom-filename"
              type="text"
              placeholder="Otomatik algılanır"
              value={customFileName}
              onChange={(e) => setCustomFileName(e.target.value)}
              className="input-field"
            />
          </div>

          <div className="form-group flex-none" style={{ minWidth: '240px' }}>
            <label htmlFor="connections-select">
              <Zap size={15} style={{ color: 'var(--accent-yellow)' }} /> Paralel Akış Modu
            </label>
            <select
              id="connections-select"
              value={connections}
              onChange={(e) => setConnections(Number(e.target.value))}
              className="input-field select-field"
            >
              {CONNECTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {diskInfo?.warning && (
          <div className="disk-warning-box">
            <AlertTriangle size={16} className="warning-icon" />
            <span>{diskInfo.warning}</span>
          </div>
        )}

        <div className="form-footer-clean">
          <button
            type="submit"
            disabled={!url.trim() || isSubmitting}
            className="btn btn-primary start-btn"
          >
            <DownloadCloud size={16} />
            <span>İndirmeyi Başlat</span>
          </button>
        </div>
      </form>
    </div>
  )
}
