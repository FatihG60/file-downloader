import React, { useState } from 'react'
import { FolderOpen, DownloadCloud, Sparkles, Link2, Zap } from 'lucide-react'

interface DownloadFormProps {
  onStartDownload: (
    url: string,
    destinationFolder: string,
    customFileName?: string,
    connections?: number
  ) => void
  defaultDestination: string
}

const SAMPLE_URLS = [
  { label: 'Cloudflare 1GB (Rate Limitsiz)', url: 'https://speed.cloudflare.com/__down?bytes=1073741824' },
  { label: 'Ubuntu 24.04 ISO (6 GB)', url: 'https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso' },
  { label: 'Debian 12 DVD (3.7 GB)', url: 'https://cdimage.debian.org/debian-cd/current/amd64/iso-dvd/debian-12.8.0-amd64-DVD-1.iso' },
]

const CONNECTION_OPTIONS = [
  { value: 1, label: '1x (Tek Akış - Normal)' },
  { value: 4, label: '4x (Hızlı Paralel)' },
  { value: 8, label: '8x (Turbo Paralel - Önerilen)' },
  { value: 16, label: '16x (Ultra Turbo Maksimum Hız)' }
]

export const DownloadForm: React.FC<DownloadFormProps> = ({
  onStartDownload,
  defaultDestination,
}) => {
  const [url, setUrl] = useState('')
  const [destinationFolder, setDestinationFolder] = useState(defaultDestination)
  const [customFileName, setCustomFileName] = useState('')
  const [connections, setConnections] = useState<number>(8)
  const [isSubmitting, setIsSubmitting] = useState(false)

  React.useEffect(() => {
    if (!destinationFolder && defaultDestination) {
      setDestinationFolder(defaultDestination)
    }
  }, [defaultDestination, destinationFolder])

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
          <h2>Yeni İndirme Başlat</h2>
          <p className="subtitle">500GB+ boyuttaki dosyalar 8x/16x paralel akışlarla doğrudan diske yazılır.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="download-form">
        <div className="form-group">
          <label htmlFor="download-url">
            <Link2 size={16} /> İndirme Bağlantısı (URL / S3 Presigned URL)
          </label>
          <input
            id="download-url"
            type="url"
            placeholder="https://bucket.s3.amazonaws.com/huge-500gb.zip?X-Amz-Signature=..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            className="input-field"
          />
        </div>

        <div className="form-row">
          <div className="form-group flex-1">
            <label htmlFor="dest-folder">
              <FolderOpen size={16} /> Kaydedilecek Dizin
            </label>
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
                <FolderOpen size={16} />
                <span>Gözat</span>
              </button>
            </div>
          </div>

          <div className="form-group flex-1">
            <label htmlFor="custom-filename">Özel Dosya Adı (İsteğe Bağlı)</label>
            <input
              id="custom-filename"
              type="text"
              placeholder="Otomatik algılanır veya örn: 500gb-dataset.tar"
              value={customFileName}
              onChange={(e) => setCustomFileName(e.target.value)}
              className="input-field"
            />
          </div>

          <div className="form-group flex-none" style={{ minWidth: '220px' }}>
            <label htmlFor="connections-select">
              <Zap size={16} style={{ color: 'var(--accent-yellow)' }} /> Paralel Akış Hızı
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

        <div className="form-footer">
          <div className="preset-links">
            <span className="preset-label"><Sparkles size={14} /> Hızlı Test URL'leri:</span>
            {SAMPLE_URLS.map((sample, idx) => (
              <button
                key={idx}
                type="button"
                className="preset-tag"
                onClick={() => setUrl(sample.url)}
              >
                {sample.label}
              </button>
            ))}
          </div>

          <button
            type="submit"
            disabled={!url.trim() || isSubmitting}
            className="btn btn-primary start-btn"
          >
            <Zap size={18} />
            <span>{connections > 1 ? `${connections}x Turbo Paralel İndir` : 'Tek Akış İndir'}</span>
          </button>
        </div>
      </form>
    </div>
  )
}
