import React from 'react'
import {
  Pause,
  Play,
  XCircle,
  Folder,
  FileCode,
  AlertCircle,
  CheckCircle2,
  Clock,
  Gauge,
  HardDrive,
  RefreshCw,
  Zap
} from 'lucide-react'
import { DownloadProgress } from '../../../main/downloader/types'
import { formatBytes, formatSpeed, formatDuration } from '../utils/formatters'

interface DownloadItemCardProps {
  item: DownloadProgress
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
  onOpenFolder: (filePath: string) => void
}

export const DownloadItemCard: React.FC<DownloadItemCardProps> = ({
  item,
  onPause,
  onResume,
  onCancel,
  onOpenFolder,
}) => {
  const getStatusBadge = () => {
    switch (item.status) {
      case 'downloading':
        return (
          <span className="badge badge-active">
            <span className="pulsing-dot"></span> İndiriliyor
          </span>
        )
      case 'paused':
        return (
          <span className="badge badge-warning">
            <Pause size={12} /> Duraklatıldı
          </span>
        )
      case 'completed':
        return (
          <span className="badge badge-success">
            <CheckCircle2 size={12} /> Tamamlandı
          </span>
        )
      case 'error':
        return (
          <span className="badge badge-danger">
            <AlertCircle size={12} /> Hata Oluştu
          </span>
        )
      case 'cancelled':
        return (
          <span className="badge badge-muted">
            <XCircle size={12} /> İptal Edildi
          </span>
        )
      case 'initializing':
        return (
          <span className="badge badge-info">
            <RefreshCw size={12} className="spin" /> Bağlanıyor...
          </span>
        )
      default:
        return <span className="badge badge-muted">{item.status}</span>
    }
  }

  const isDownloading = item.status === 'downloading' || item.status === 'initializing'
  const isPaused = item.status === 'paused'
  const isCompleted = item.status === 'completed'
  const isError = item.status === 'error'

  return (
    <div className={`card download-item-card status-${item.status}`}>
      <div className="item-header">
        <div className="item-title-section">
          <div className="file-icon-box">
            <FileCode size={22} className="file-icon" />
          </div>
          <div className="item-names">
            <h3 className="file-name" title={item.fileName}>
              {item.fileName}
            </h3>
            <p className="file-path" title={item.filePath}>
              {item.filePath}
            </p>
          </div>
        </div>

        <div className="item-badges">
          {item.connections > 1 && (
            <span className="badge badge-turbo" title={`${item.connections} paralel HTTP Range akışı ile eşzamanlı indiriliyor`}>
              <Zap size={12} /> {item.connections}x Turbo Akış
            </span>
          )}
          {item.resumable && (
            <span className="badge badge-pill badge-outline" title="Sunucu HTTP Range başlığını destekliyor. Bağlantı kopsa bile kaldığı yerden devam edebilir.">
              HTTP Range
            </span>
          )}
          {getStatusBadge()}
        </div>
      </div>

      {/* Main Overall Progress Bar */}
      <div className="progress-section">
        <div className="progress-bar-bg">
          <div
            className={`progress-bar-fill ${item.status}`}
            style={{ width: `${item.progressPercentage}%` }}
          />
        </div>
      </div>

      {/* Segmented Multi-Stream Progress Visualizer */}
      {item.chunks && item.chunks.length > 1 && (
        <div className="chunks-visualizer-container">
          <div className="chunks-label">
            <span>Paralel Segment Akışları ({item.chunks.length} Akış):</span>
          </div>
          <div className="chunks-grid">
            {item.chunks.map((chunk) => {
              const chunkPercent =
                chunk.total > 0
                  ? Math.min(100, Math.round((chunk.downloaded / chunk.total) * 100))
                  : 0
              return (
                <div key={chunk.id} className="chunk-bar-wrapper" title={`Segment ${chunk.id + 1}: ${formatBytes(chunk.downloaded)} / ${formatBytes(chunk.total)} (%${chunkPercent})`}>
                  <div className="chunk-bar-bg">
                    <div
                      className={`chunk-bar-fill chunk-status-${chunk.status}`}
                      style={{ width: `${chunkPercent}%` }}
                    />
                  </div>
                  <span className="chunk-text">S{chunk.id + 1}: %{chunkPercent}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="stats-grid">
        <div className="stat-item">
          <HardDrive size={15} className="stat-icon" />
          <div className="stat-content">
            <span className="stat-label">İndirilen / Toplam</span>
            <span className="stat-value">
              {formatBytes(item.downloadedBytes)}
              {item.totalBytes > 0 ? ` / ${formatBytes(item.totalBytes)}` : ' / Bilinmiyor'}
              {item.totalBytes > 0 && ` (${item.progressPercentage}%)`}
            </span>
          </div>
        </div>

        <div className="stat-item">
          <Gauge size={15} className="stat-icon" />
          <div className="stat-content">
            <span className="stat-label">Anlık Birleşik Hız</span>
            <span className="stat-value highlight-speed">
              {isDownloading ? formatSpeed(item.speedBytesPerSec) : '0 B/s'}
            </span>
          </div>
        </div>

        <div className="stat-item">
          <Clock size={15} className="stat-icon" />
          <div className="stat-content">
            <span className="stat-label">Kalan Süre (ETA)</span>
            <span className="stat-value">
              {isDownloading
                ? item.estimatedTimeRemainingSec > 0
                  ? formatDuration(item.estimatedTimeRemainingSec)
                  : 'Hesaplanıyor...'
                : isCompleted
                ? '0s'
                : '--:--'}
            </span>
          </div>
        </div>
      </div>

      {/* Error Message if any */}
      {isError && item.errorMessage && (
        <div className="error-banner">
          <AlertCircle size={16} />
          <span>{item.errorMessage}</span>
        </div>
      )}

      {/* Action Buttons */}
      <div className="item-actions">
        <div className="action-buttons-group">
          {isDownloading && (
            <button
              onClick={() => onPause(item.id)}
              className="btn btn-secondary btn-sm"
              title="Tüm Akışları Duraklat"
            >
              <Pause size={14} />
              <span>Duraklat</span>
            </button>
          )}

          {(isPaused || isError) && (
            <button
              onClick={() => onResume(item.id)}
              className="btn btn-primary btn-sm"
              title="Kaldığı Yerden Devam Et"
            >
              <Play size={14} />
              <span>Devam Et</span>
            </button>
          )}

          {!isCompleted && item.status !== 'cancelled' && (
            <button
              onClick={() => onCancel(item.id)}
              className="btn btn-danger btn-sm"
              title="İptal Et ve Geçici Dosyaları Sil"
            >
              <XCircle size={14} />
              <span>İptal</span>
            </button>
          )}

          <button
            onClick={() => onOpenFolder(item.filePath)}
            className="btn btn-secondary btn-sm"
            title="Dosyayı Dosya Gezgininde Göster"
          >
            <Folder size={14} />
            <span>Klasörde Göster</span>
          </button>
        </div>

        <div className="url-preview" title={item.url}>
          {item.url}
        </div>
      </div>
    </div>
  )
}
