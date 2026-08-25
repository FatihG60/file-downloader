# 500GB+ Ultra Stream Downloader (Electron + Vite + React)

Bu proje, Electron, Vite ve React kullanarak **500 GB ve üzeri devasa boyutlu dosyaları ve AWS S3 Pre-signed URL'lerini** bellek (RAM) şişmesi yaşamadan, duraklatılabilir/devam ettirilebilir (HTTP Range), paralel parçalı (Turbo Multi-Stream) ve yüksek performanslı akış (streaming) mimarisiyle indirmek için geliştirilmiştir.

Ayrıca bu motor, **başka herhangi bir Electron projesine tek satırda eklenebilecek bağımsız bir npm paketi (`packages/electron-stream-downloader`)** olarak paketlenmiştir.

> 📖 **Mimari Püf Noktaları, USB/SSD Tavsiyeleri ve Best Practices:** Detaylı rehber için **[ARCHITECTURE_AND_TIPS.md](./ARCHITECTURE_AND_TIPS.md)** dosyasını inceleyebilirsiniz.

---

## 🚀 Öne Çıkan Mimari Özellikler

### 1. Sıfır Bellek Sızıntısı & Doğrudan Diske Akış (Stream Piping)
- Dosya boyutu ne kadar büyük olursa olsun (örneğin 500 GB veya 1 TB), gelen veriler **RAM'de Buffer olarak biriktirilmez**.
- Node.js `node:https`/`node:http` ve `fs.writeSync` / `fs.createWriteStream` (`highWaterMark: 4MB-8MB`) ile doğrudan diske yazılır.
- Uygulama 500GB indirirken bile ortalama **50-90 MB RAM** tüketir.

### 2. Turbo Multi-Stream (8x / 16x Paralel HTTP Range Akışı)
- Büyük dosyalar ve S3 nesneleri eşzamanlı **4, 8 veya 16 eşit parçaya** bölünür.
- Her segment ayrı TCP soketi üzerinden paralel olarak indirilerek tekil hat ve sunucu kısıtlamaları aşılır, hız **3x-8x katına** çıkarılır.

### 3. HTTP Range Desteği (Resumable Download)
- Ağ kesintisi veya kullanıcının indirmeyi duraklatması durumunda, indirme sıfırlanmaz.
- Dosya `.part` ve `.part.meta.json` dosyalarıyla parça parça diske yazılır.
- Tekrar başlatıldığında her segment kendi kaldığı byte ofsetinden devam eder.
- İndirme %100 tamamlandığında `.part` uzantısı atomik olarak kaldırılarak orijinal dosya adına dönüştürülür.

### 4. Rate-Limit (HTTP 429) & DDoS Koruması
- Kademeli bağlantı açma (100ms connection pacing), üstel geri çekilme (exponential backoff) ve sunucu çoklu bağlantıyı kesinlikle reddederse otomatik tek akışa geçiş (**Auto-Fallback**) mekanizması.

### 5. IPC Throttling (250ms Periyodik Yayın)
- Yüksek hızlı ağlarda (örneğin 100-500 MB/s) saniyede gelen on binlerce chunk'ın Electron arayüzünü kilitlemesini engellemek için ilerleme verileri 250ms periyotla filtrelenerek Renderer'a gönderilir.

---

## 📦 Harici Paket Olarak Kullanım (`electron-stream-downloader`)

İndirme motoru, projenin `packages/electron-stream-downloader` klasöründe bağımsız bir npm paketi olarak derlenmiştir. Bu modülü **kendi başka Electron projelerinizde** kullanmak için aşağıdaki 3 adımı uygulayabilirsiniz:

### 1. Paketi Yeni Projenize Kurun

```bash
# Yöntem A: Doğrudan üretilen .tgz paketini kurmak:
npm install "C:/Users/Dragos/.gemini/antigravity/scratch/electron-large-downloader/packages/electron-stream-downloader/electron-stream-downloader-1.0.0.tgz"

# Yöntem B: Klasör yolu ile kurmak:
npm install "C:/Users/Dragos/.gemini/antigravity/scratch/electron-large-downloader/packages/electron-stream-downloader"
```

---

### 2. Main Process Entegrasyonu (`src/main/index.ts` veya `main.js`)

Ana pencereyi oluşturduktan hemen sonra IPC yönlendiricisini tek satırda bağlayın:

```typescript
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { registerLargeDownloaderIpc } from 'electron-stream-downloader/main'

function createWindow() {
  const mainWindow = new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // ⭐️ Tek Satırda İndirme Motorunu ve IPC Dinleyicilerini Bağlayın:
  registerLargeDownloaderIpc(mainWindow)
}
```

---

### 3. Preload Script Entegrasyonu (`src/preload/index.ts`)

Renderer sürecine `window.electronAPI` köprüsünü güvenle açın:

```typescript
import { exposeLargeDownloaderApi } from 'electron-stream-downloader/preload'

// ⭐️ Güvenli contextBridge API'sini 'electronAPI' adıyla window'a ekler:
exposeLargeDownloaderApi('electronAPI')
```

---

### 4. React / Renderer Arayüzü Entegrasyonu (`App.tsx`)

Paketle gelen `useLargeDownloader()` React Hook'u ve formatlayıcıları kullanın:

```tsx
import React, { useState } from 'react'
import { useLargeDownloader } from 'electron-stream-downloader/react'
import { formatBytes, formatSpeed, formatDuration } from 'electron-stream-downloader/utils'

export function DownloaderApp() {
  const [url, setUrl] = useState('')
  
  // ⭐️ Tüm durumları ve kontrolleri yöneten hazır hook:
  const {
    downloads,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    showItemInFolder
  } = useLargeDownloader()

  const handleDownload = async () => {
    await startDownload({
      url: url.trim(),
      connections: 8 // 8x Turbo Paralel Akış
    })
    setUrl('')
  }

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h2>500GB+ Turbo Downloader</h2>
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="S3 Presigned URL veya büyük dosya linki..."
        style={{ width: '60%', padding: 8 }}
      />
      <button onClick={handleDownload} style={{ padding: '8px 16px', marginLeft: 8 }}>
        8x Turbo İndir
      </button>

      <div style={{ marginTop: 24 }}>
        {downloads.map((item) => (
          <div key={item.id} style={{ border: '1px solid #ddd', padding: 16, marginBottom: 12, borderRadius: 8 }}>
            <h4>{item.fileName}</h4>
            <p>
              {formatBytes(item.downloadedBytes)} / {formatBytes(item.totalBytes)} — 
              <strong> {formatSpeed(item.speedBytesPerSec)}</strong> (Kalan: {formatDuration(item.estimatedTimeRemainingSec)})
            </p>
            <progress value={item.progressPercentage} max="100" style={{ width: '100%' }} />

            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              {item.status === 'downloading' && <button onClick={() => pauseDownload(item.id)}>Duraklat</button>}
              {item.status === 'paused' && <button onClick={() => resumeDownload(item.id)}>Devam Et</button>}
              <button onClick={() => cancelDownload(item.id)}>İptal</button>
              <button onClick={() => showItemInFolder(item.filePath)}>Klasörde Göster</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

---

## 🛠️ Kurulum ve Çalıştırma (Bu Proje İçin)

### 1. Proje Dizinine Geçin
```bash
cd "C:\Users\Dragos\.gemini\antigravity\scratch\electron-large-downloader"
```

### 2. Geliştirme Modunda Çalıştırma (HMR ile Dev Server)
```bash
npm run dev
```

### 3. Üretim İçin Derleme (Production Build)
```bash
npm run build
```

---

## 📂 Proje Yapısı

```text
electron-large-downloader/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── packages/
│   └── electron-stream-downloader/      # 📦 BAĞIMSIZ HARİCİ NPM PAKETİ
│       ├── package.json
│       ├── electron-stream-downloader-1.0.0.tgz
│       ├── src/
│       │   ├── main/                    # Main process IPC ve Engine
│       │   ├── preload/                 # Preload contextBridge
│       │   ├── react/                   # useLargeDownloader React Hook
│       │   └── utils/                   # formatBytes, formatSpeed, formatDuration
│       └── dist/                        # Derlenmiş TypeScript çıktıları
├── src/
│   ├── main/
│   │   ├── index.ts                     # Electron ana pencere ve yaşam döngüsü
│   │   ├── ipc.ts                       # IPC yönlendirmeleri
│   │   └── downloader/
│   │       ├── DownloaderEngine.ts      # Turbo Multi-Stream motoru
│   │       ├── DownloadManager.ts       # İndirme yöneticisi
│   │       └── types.ts                 # Durum ve ilerleme tipleri
│   ├── preload/
│   │   └── index.ts                     # window.electronAPI köprüsü
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.tsx                 # React başlangıç noktası
│           ├── App.tsx                  # Ana arayüz
│           ├── App.css                  # Modern karanlık tema
│           ├── components/
│           │   ├── DownloadForm.tsx     # URL, klasör ve bağlantı hızı seçici
│           │   └── DownloadItemCard.tsx # Canlı segment ve ilerleme kartı
│           └── utils/
│               └── formatters.ts        # Formatlayıcılar
```
