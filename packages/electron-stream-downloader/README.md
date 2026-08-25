# electron-stream-downloader

Electron uygulamaları için **500GB+ devasa dosya ve S3 Presigned URL indirme modülü**.

- 🚀 **500GB+ Sıfır RAM Şişmesi**: Doğrudan diske akış (Stream Piping & `fs.writeSync` offset yazımı).
- ⚡ **Turbo Multi-Stream**: 4x, 8x, 16x paralel HTTP Range bağlantısı ile maksimum hız.
- 🛡️ **Kaldığı Yerden Devam Etme (Resumable)**: Elektrik/ağ kesintilerinde `.part.meta.json` ile kaldığı byte'tan devam.
- ⏳ **Rate-Limit (HTTP 429) Koruması**: Kademeli bağlantı (100ms pacing), üstel geri çekilme ve otomatik tek akışa geçiş (Auto-Fallback).
- ⚛️ **React Desteği**: `useLargeDownloader()` hazır hook'u ve formatlayıcılar.

---

## 📦 Kurulum (Başka Bir Projeye Ekleme)

### Yöntem A: Yerel `.tgz` Dosyası ile Kurulum (En Kolayı)
Paketi diğer Electron projenizin klasörüne kopyalayıp kurabilirsiniz:

```bash
npm install ./electron-stream-downloader-1.0.0.tgz
```

veya yerel dizini göstererek:

```bash
npm install "C:/Users/Dragos/.gemini/antigravity/scratch/electron-large-downloader/packages/electron-stream-downloader"
```

---

## 🚀 3 Adımda Kullanım Kılavuzu

### 1. Adım: Electron Main Process (`main/index.ts`)
Ana pencereyi oluşturduktan hemen sonra IPC dinleyicisini kaydedin:

```typescript
import { app, BrowserWindow } from 'electron'
import { registerLargeDownloaderIpc } from 'electron-stream-downloader/main'

function createWindow() {
  const mainWindow = new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // ⭐️ Tek Satırda İndirme Motorunu Bağlayın:
  registerLargeDownloaderIpc(mainWindow)
}
```

---

### 2. Adım: Preload Script (`preload/index.ts`)
Renderer sürecine API'yi güvenle açın:

```typescript
import { exposeLargeDownloaderApi } from 'electron-stream-downloader/preload'

// ⭐️ window.electronAPI üzerinden tüm indirme fonksiyonlarını renderer'a açar:
exposeLargeDownloaderApi('electronAPI')
```

---

### 3. Adım: React / Renderer Arayüzü (`App.tsx`)
Hazır React hook'unu kullanarak indirmeleri yönetin:

```tsx
import React, { useState } from 'react'
import { useLargeDownloader } from 'electron-stream-downloader/react'
import { formatBytes, formatSpeed, formatDuration } from 'electron-stream-downloader/utils'

export function DownloaderComponent() {
  const [url, setUrl] = useState('')
  const {
    downloads,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    selectDirectory,
    showItemInFolder
  } = useLargeDownloader()

  const handleStart = async () => {
    await startDownload({
      url: url,
      connections: 8 // 8x Turbo Paralel Akış
    })
  }

  return (
    <div>
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="URL girin..." />
      <button onClick={handleStart}>8x Turbo İndir</button>

      <div>
        {downloads.map((item) => (
          <div key={item.id}>
            <h4>{item.fileName}</h4>
            <p>
              {formatBytes(item.downloadedBytes)} / {formatBytes(item.totalBytes)} - {formatSpeed(item.speedBytesPerSec)}
            </p>
            <progress value={item.progressPercentage} max="100" />
            <button onClick={() => pauseDownload(item.id)}>Duraklat</button>
            <button onClick={() => resumeDownload(item.id)}>Devam Et</button>
            <button onClick={() => showItemInFolder(item.filePath)}>Klasörde Göster</button>
          </div>
        ))}
      </div>
    </div>
  )
}
```

---

## 📚 TypeScript Tipleri

```typescript
import type { 
  DownloadProgress, 
  StartDownloadParams, 
  ChunkState, 
  DownloadStatus 
} from 'electron-stream-downloader'
```
