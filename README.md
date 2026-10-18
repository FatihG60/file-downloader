# Resumable MD5 Downloader (Sliding-Window Multi-Stream + Sequential USB/MD5)

500 GB+ büyüklüğündeki dosyaları USB disklere veya yerel depolamaya indirirken kesinti yaşandığında, **dosyayı diskten baştan okumadan akış (streaming) MD5 hesabına kaldığı yerden devam eden**, **Kayan Pencere (Sliding Window / Ring-Buffer) Multi-Stream** mimarisine sahip Electron + TypeScript uygulaması.

## Temel Mimari Özellikler

- **MD5 Dahili Durum Serileştirme (`hash-wasm`):** MD5 motorunun ~88 baytlık iç durumu (`A, B, C, D` 32-bit register'ları, 64-bit bayt sayacı ve 0-63 baytlık kalan tampon) `hasher.save()` ile Base64 olarak `.meta.json` dosyasında saklanır; kesinti sonrası `hasher.load()` ile diskten 1 bayt bile okumadan devam edilir.
- **Kayan Pencere (Sliding Window / Ring-Buffer) Multi-Stream:** Ağ katmanında N paralel HTTP işçisi (`Range: bytes=start-end`) komşu blokları (örn. `4 MB`) paralel indirirken, yazıcı döngü parçaları `0 -> 1 -> 2 -> 3` sırasıyla RAM'den çekip USB diske **%100 sıralı (Sequential Write)** olarak yazar ve anlık MD5 günceller.
- **RAM Ring-Buffer Backpressure (`maxWindowChunks`):** USB disk yazmada yavaşlarsa RAM'de en fazla belirlenen sayıda parça (örn. `8 x 4 MB = 32 MB`) tutulur; pencere dolduğunda HTTP işçileri diskin boşalmasını bekler.
- **Veri Kaybı ve Bozulma Koruması (`fsync` + `ftruncate`):** Periyodik checkpoint anlarında `fileFd.sync()` ile işletim sisteminin *Dirty Page Cache* verileri fiziksel olarak USB diske basılır ve `.meta.json` atomik olarak (`.tmp` -> `rename`) güncellenir. Devam edilirken `fileFd.truncate(downloadedBytes)` ile son onaylı checkpoint sonrası fazlalık baytlar kesilir.
- **Single-Stream Yedek (`resumableDownloader.single.backup.ts`):** Tek akışlı (Single-Stream) referans implementasyon yedeği kök dizinde korunmaktadır.

## Kurulum ve Çalıştırma

```bash
npm install
npm run build
npm start
```
