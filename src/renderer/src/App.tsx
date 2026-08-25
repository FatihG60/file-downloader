import React, { useState, useEffect } from 'react'
import { DownloadForm } from './components/DownloadForm'
import { DownloadItemCard } from './components/DownloadItemCard'
import { DownloadProgress } from '../../main/downloader/types'
import {
  Layers,
  Cpu,
  RefreshCw,
  HardDriveDownload,
  ShieldCheck,
  Zap
} from 'lucide-react'
import './App.css'

export const App: React.FC = () => {
  const [downloads, setDownloads] = useState<Map<string, DownloadProgress>>(new Map())
  const [defaultDestination, setDefaultDestination] = useState<string>('')

  useEffect(() => {
    // 1. Get default download folder
    window.electronAPI.getDefaultDownloadPath().then((path) => {
      setDefaultDestination(path)
    })

    // 2. Fetch existing active downloads
    window.electronAPI.getAllDownloads().then((initialList) => {
      if (initialList && initialList.length > 0) {
        const map = new Map<string, DownloadProgress>()
        initialList.forEach((item) => map.set(item.id, item))
        setDownloads(map)
      }
    })

    // 3. Subscribe to real-time progress events from Electron Main Process
    const unsubscribe = window.electronAPI.onProgress((progress: DownloadProgress) => {
      setDownloads((prev) => {
        const next = new Map(prev)
        next.set(progress.id, progress)
        return next
      })
    })

    return () => {
      unsubscribe()
    }
  }, [])

  const handleStartDownload = async (
    url: string,
    destinationFolder: string,
    customFileName?: string,
    connections: number = 8
  ) => {
    try {
      const initialProgress = await window.electronAPI.startDownload({
        url,
        destinationFolder,
        customFileName,
        connections
      })

      setDownloads((prev) => {
        const next = new Map(prev)
        next.set(initialProgress.id, initialProgress)
        return next
      })
    } catch (err: any) {
      alert(`İndirme başlatılamadı: ${err.message || err}`)
    }
  }

  const handlePause = async (id: string) => {
    await window.electronAPI.pauseDownload(id)
  }

  const handleResume = async (id: string) => {
    await window.electronAPI.resumeDownload(id)
  }

  const handleCancel = async (id: string) => {
    await window.electronAPI.cancelDownload(id)
    setDownloads((prev) => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }

  const handleOpenFolder = async (filePath: string) => {
    await window.electronAPI.showItemInFolder(filePath)
  }

  const downloadList = Array.from(downloads.values()).reverse()

  return (
    <div className="app-container">
      {/* Top Navbar */}
      <header className="app-header">
        <div className="brand-section">
          <div className="logo-badge">
            <HardDriveDownload size={24} className="logo-icon" />
          </div>
          <div>
            <h1 className="brand-title">500GB+ Ultra Stream Downloader</h1>
            <p className="brand-subtitle">Electron & Vite & React Streaming Architecture</p>
          </div>
        </div>

        <div className="system-pill">
          <span className="dot-live"></span>
          <span>Main Process Stream Active</span>
        </div>
      </header>

      {/* Main Content */}
      <main className="main-content">
        {/* Architecture Badges Banner */}
        <section className="features-banner">
          <div className="feature-chip">
            <Cpu size={16} className="feature-icon" />
            <div>
              <strong>Düşük RAM Tüketimi</strong>
              <span>500GB doğrudan diske akıtılır (Buffer yok)</span>
            </div>
          </div>

          <div className="feature-chip">
            <RefreshCw size={16} className="feature-icon" />
            <div>
              <strong>HTTP Range (Resumable)</strong>
              <span>Bağlantı kopsa dahi kaldığı byte'tan devam eder</span>
            </div>
          </div>

          <div className="feature-chip">
            <Zap size={16} className="feature-icon" />
            <div>
              <strong>IPC Throttling (250ms)</strong>
              <span>Arayüz yüksek hızda donmaz ve kilitlenmez</span>
            </div>
          </div>

          <div className="feature-chip">
            <ShieldCheck size={16} className="feature-icon" />
            <div>
              <strong>Atomik Dosya (.part)</strong>
              <span>Tamamlandığında güvenle asıl ada dönüştürülür</span>
            </div>
          </div>
        </section>

        {/* Input Form */}
        <DownloadForm
          onStartDownload={handleStartDownload}
          defaultDestination={defaultDestination}
        />

        {/* Downloads List Section */}
        <section className="downloads-section">
          <div className="section-header">
            <div className="section-title">
              <Layers size={18} />
              <h2>Aktif ve Geçmiş İndirmeler</h2>
              <span className="counter-badge">{downloadList.length}</span>
            </div>
          </div>

          {downloadList.length === 0 ? (
            <div className="empty-state">
              <HardDriveDownload size={48} className="empty-icon" />
              <h3>Henüz indirme başlatılmadı</h3>
              <p>Yukarıdaki formdan bir URL girerek 500GB'a kadar olan yüksek boyutlu dosyaları güvenle indirmeye başlayabilirsiniz.</p>
            </div>
          ) : (
            <div className="downloads-list">
              {downloadList.map((item) => (
                <DownloadItemCard
                  key={item.id}
                  item={item}
                  onPause={handlePause}
                  onResume={handleResume}
                  onCancel={handleCancel}
                  onOpenFolder={handleOpenFolder}
                />
              ))}
            </div>
          )}
        </section>
      </main>

      {/* Footer */}
      <footer className="app-footer">
        <p>Electron Main Process Streaming Engine • Node.js Stream Pipeline • Zero Memory Leak</p>
      </footer>
    </div>
  )
}
export default App
