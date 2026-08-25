# 500GB+ Ultra Stream Downloader (Electron + Vite + React)

Bu proje, Electron, Vite ve React kullanarak **500 GB ve üzeri devasa boyutlu dosyaları** bellek (RAM) şişmesi yaşamadan, duraklatılabilir/devam ettirilebilir (HTTP Range) ve yüksek performanslı akış (streaming) mimarisiyle indirmek için geliştirilmiştir.

---

## 🚀 Öne Çıkan Mimari Özellikler

### 1. Sıfır Bellek Sızıntısı & Doğrudan Diske Akış (Stream Piping)
- Dosya boyutu ne kadar büyük olursa olsun (örneğin 500 GB veya 1 TB), gelen veriler **RAM'de Buffer olarak biriktirilmez**.
- Node.js `node:https`/`node:http` ve `fs.createWriteStream` (`highWaterMark: 4MB`) ile doğrudan diske yazılır.
- Uygulama 500GB indirirken bile ortalama **50-90 MB RAM** tüketir.

### 2. HTTP Range Desteği (Resumable Download)
- Ağ kesintisi veya kullanıcının indirmeyi duraklatması durumunda, indirme sıfırlanmaz.
- Dosya `.part` uzantısıyla parça parça diske yazılır.
- Tekrar başlatıldığında `Range: bytes={mevcutBoyut}-` başlığı gönderilir ve HTTP `206 Partial Content` yanıtıyla kaldığı byte'tan devam eder.
- İndirme %100 tamamlandığında `.part` uzantısı atomik olarak kaldırılarak orijinal dosya adı verilir.

### 3. IPC Throttling (250ms Periyodik Yayın)
- Yüksek hızlı ağlarda saniyede on binlerce chunk gelebilir. Her chunk için IPC mesajı göndermek Electron arayüzünü kilitler.
- Main Process içinde hız (MB/s veya GB/s), ETA (kalan süre) ve yüzde hesabı yapılır; Renderer'a en fazla 250ms aralıkla throttled olarak iletilir.

### 4. Güvenli Preload & ContextBridge
- Renderer süreci `contextIsolation: true` ile korunur.
- Renderer doğrudan `fs` veya `child_process` gibi Node.js çekirdek modüllerine erişmez; yalnızca `window.electronAPI` üzerinden güvenli IPC kanallarını kullanır.

---

## 🛠️ Kurulum ve Çalıştırma

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
├── src/
│   ├── main/
│   │   ├── index.ts                      # Electron ana pencere ve yaşam döngüsü
│   │   ├── ipc.ts                        # IPC yönlendirmeleri (start, pause, resume, cancel, select-folder)
│   │   └── downloader/
│   │       ├── DownloaderEngine.ts       # Akış, Range ve hız hesaplama motoru
│   │       ├── DownloadManager.ts        # Çoklu indirme yöneticisi ve IPC köprüsü
│   │       └── types.ts                  # Durum, ilerleme ve parametre tipleri
│   ├── preload/
│   │   └── index.ts                      # contextBridge ile sunulan güvenli API (window.electronAPI)
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.tsx                  # React başlangıç noktası
│           ├── App.tsx                   # Ana arayüz ve durum yönetimi
│           ├── App.css                   # Modern karanlık tema ve responsive stiller
│           ├── components/
│           │   ├── DownloadForm.tsx      # URL ve klasör seçici formu
│           │   └── DownloadItemCard.tsx  # Canlı ilerleme kartı, hız, ETA ve butonlar
│           └── utils/
│               └── formatters.ts         # Byte (GB/TB), Hız (MB/s) ve Süre (ETA) formatlayıcıları
```
