import React, { useState, useEffect } from 'react'
import { DownloadForm } from './components/DownloadForm'
import { DownloadItemCard } from './components/DownloadItemCard'
import { DownloadProgress } from '../../main/downloader/types'
import { Layers, HardDriveDownload, Download } from 'lucide-react'
import './App.css'

export const App: React.FC = () => {
  const [downloads, setDownloads] = useState<Map<string, DownloadProgress>>(new Map())
  const [defaultDestination, setDefaultDestination] = useState<string>('')

  useEffect(() => {
    window.electronAPI.getDefaultDownloadPath().then((path) => {
      if (path) setDefaultDestination(path)
    })

    window.electronAPI.getAllDownloads().then((initialList) => {
      if (initialList && initialList.length > 0) {
        const map = new Map<string, DownloadProgress>()
        initialList.forEach((item) => map.set(item.id, item))
        setDownloads(map)
      }
    })

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
            <HardDriveDownload size={22} className="logo-icon" />
          </div>
          <div>
            <h1 className="brand-title">File Downloader</h1>
            <p className="brand-subtitle">Stream & Multi-Connection Downloader</p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="main-content">
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
              <h2>İndirmeler</h2>
              <span className="counter-badge">{downloadList.length}</span>
            </div>
          </div>

          {downloadList.length === 0 ? (
            <div className="empty-state">
              <Download size={36} className="empty-icon" />
              <h3>Aktif indirme bulunmuyor</h3>
              <p>İndirmek istediğiniz dosya veya S3 Presigned URL bağlantısını yukarıya girin.</p>
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
    </div>
  )
}

export default App
