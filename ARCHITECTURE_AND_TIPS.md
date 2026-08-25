# 🧠 500GB+ Büyük Dosya İndirme: Mimari Püf Noktaları ve En İyi Pratikler (Best Practices)

Bu döküman; Electron, Node.js ve React mimarisinde **500 GB ve üzeri devasa boyutlu dosyaları**, **AWS S3 Pre-signed URL'lerini** ve **Harici Sürücüleri (USB / SSD)** sıfır bellek sızıntısıyla, maksimum bant genişliğinde ve kesintisiz indirmek için uygulanan kritik mühendislik püf noktalarını içerir.

---

## 📌 İçindekiler
1. [Sıfır Bellek Sızıntısı: Stream vs Buffer Tuzağı](#1-sıfır-bellek-sızıntısı-stream-vs-buffer-tuzağı)
2. [IPC Kanalları Neden Electron'u Kilitlemez? (Throttling & Decoupling)](#2-ipc-kanalları-neden-electronu-kilitlemez-throttling--decoupling)
3. [Turbo Multi-Stream ve Parçalı HTTP Range Mimarisi](#3-turbo-multi-stream-ve-parçalı-http-range-mimarisi)
4. [Rate-Limit (HTTP 429) & DDoS Koruması (Pacing & Backoff)](#4-rate-limit-http-429--ddos-koruması-pacing--backoff)
5. [AWS S3 Pre-signed URL Dinamikleri & Expired URL Çözümü](#5-aws-s3-pre-signed-url-dinamikleri--expired-url-çözümü)
6. [Depolama Medyası: USB Flash Bellek vs Harici SSD](#6-depolama-medyası-usb-flash-bellek-vs-harici-ssd)
7. [Dosya Sistemi Sınırları (FAT32 4GB Tuzağı)](#7-dosya-sistemi-sınırları-fat32-4gb-tuzağı)

---

## 1. Sıfır Bellek Sızıntısı: Stream vs Buffer Tuzağı

### ❌ Acemi Yaklaşım (Memory Leak / Crash)
```typescript
// YANLIŞ: Gelen veriyi Buffer olarak hafızada toplamak
const chunks = []
res.on('data', (chunk) => chunks.push(chunk))
res.on('end', () => fs.writeFileSync(path, Buffer.concat(chunks)))
// 💥 2-4 GB sonra Node.js "JavaScript heap out of memory" ile çöker!
```

### ✅ Bizim Mimarimiz (Direct Stream Writing)
* Veriler RAM'de **kesinlikle biriktirilmez**.
* Gelen chunk doğrudan açık dosya tanıtıcısına (`fd`) veya `fs.createWriteStream` ile diske akıtılır (`highWaterMark: 4MB-8MB`).
* 500 GB dosya indirilirken bile RAM tüketimi **50 - 90 MB** bandında sabit kalır.

---

## 2. IPC Kanalları Neden Electron'u Kilitlemez? (Throttling & Decoupling)

### ❌ Acemi Yaklaşım (UI Freeze / %100 CPU)
* 100 MB/s indirme hızında saniyede **10.000 ile 50.000 arasında veri paketi (chunk)** gelir.
* Eğer her `data` olayında `mainWindow.webContents.send('progress', ...)` çağrılsaydı, saniyede 50.000 IPC serileştirme işlemi Electron arayüzünü ve React'i tamamen kilitlerdi.

### ✅ Bizim Mimarimiz (Decoupled Stream + 250ms Timer)
1. **Ayrık Veri Akışı (Decoupled):** Veri akış döngüsü içinde IPC çağrısı **asla yapılmaz**. Sadece bellekteki basit bir sayaç artırılır (`downloadedBytes += chunk.length`).
2. **Sabit 4 Mesaj/sn (250ms Throttling):** Bağımsız çalışan bir zamanlayıcı (`setInterval`), saniyede yalnızca 4 kez son durumu okur ve React'e tek bir hafif JSON iletir.
3. **Sıfır Binary Payload:** IPC üzerinden binary veri taşınmaz; yalnızca yüzdelik, hız ve kalan süre gibi birkaç kilobaytlık veriler iletilir.
4. **Sonuç:** Arayüz **60/120 FPS akıcı** kalır, CPU kullanımı **%0.1 - %0.5** seviyesini geçmez.

---

## 3. Turbo Multi-Stream ve Parçalı HTTP Range Mimarisi

Tek bir TCP bağlantısı, paket kaybı (packet loss) ve gidiş-dönüş gecikmesi (RTT) nedeniyle bant genişliğinin tamamını kullanamaz.

```text
500GB Dosya
├── Segment 1 (0 - 62.5 GB)    ─── [TCP Soket 1] ───► fs.writeSync(fd, buf, 0, len, pos1)
├── Segment 2 (62.5 - 125 GB)  ─── [TCP Soket 2] ───► fs.writeSync(fd, buf, 0, len, pos2)
├── Segment 3 (125 - 187.5 GB) ─── [TCP Soket 3] ───► fs.writeSync(fd, buf, 0, len, pos3)
└── ...
```

* **Offset Tabanlı Doğrudan Yazım:** Her paralel soket, dosyanın kendi başlangıç byte ofsetine (`fs.writeSync`) bağımsız yazar.
* **Segment Metadata (`.part.meta.json`):** Her parçanın kaç byte indirdiği diske kaydedilir. Elektrik kesilse dahi her segment kaldığı noktadan devam eder.
* **Hız Artışı:** 8x veya 16x bağlantı ile hız **3x ile 8x katına** çıkar.

---

## 4. Rate-Limit (HTTP 429) & DDoS Koruması (Pacing & Backoff)

Bazı sunucular aynı IP'den aynı anda gelen çoklu bağlantıları DDoS veya bot sanıp `HTTP 429 Too Many Requests` dönebilir.

### Alınan Önlemler:
1. **Kademeli Başlatma (Connection Pacing):** Paralel soketler aynı milisaniyede değil, aralarında **100ms gecikmeyle** (staggered) açılır.
2. **Üstel Geri Çekilme (Exponential Backoff):** 429 yanıtı alındığında istek anında tekrarlanmaz; `Retry-After` başlığına bakılır veya `1.5s, 3s, 6s` beklenerek tekrar denenir.
3. **Otomatik Tek Akışa Geçiş (Auto-Fallback):** Sunucu çoklu bağlantıyı kesinlikle reddederse, motor inen kısımları kaybetmeden **otomatik olarak Tek Akış (1x) moduna geçer**.

---

## 5. AWS S3 Pre-signed URL Dinamikleri & Expired URL Çözümü

* **S3 Range Uyumluluğu:** S3 `GetObject` presigned URL'leri HTTP Range başlığını tam olarak destekler (`206 Partial Content`).
* **URL Süresi Dolması (Expiration / TTL):** 500GB dosyanın inmesi 12 saat sürebilir ve presigned URL'in süresi (örn. 6 saat) dolabilir.
* **Çözüm:** Motorumuz `.part` dosyasının boyutunu diskten okuduğu için, URL süresi dolduğunda backend'den **yeni bir presigned URL alınarak** indirme kaldığı byte'tan sıfırlanmadan devam ettirilebilir.

---

## 6. Depolama Medyası: USB Flash Bellek vs Harici SSD

| Kriter | Standart USB Flash Bellek | Harici NVMe / SATA SSD |
|---|---|---|
| **Rastgele Yazma (IOPS)** | Düşük (Paralel 16 akışta kilitlenebilir) | Devasa (16x Ultra Turbo'yu sonuna kadar kaldırır) |
| **Sıralı Yazma Hızı** | 15 – 40 MB/s | 500 – 2000 MB/s |
| **Önerilen Paralel Akış** | 4x veya 8x | 8x veya 16x |
| **Uzun Süreli Isınma** | Aşırı ısınabilir ve hız düşebilir | Termal kontrolü ile stabil kalır |
| **Port Gereksinimi** | USB 2.0 / 3.0 | Mutlaka USB 3.0+ (Mavi) veya Type-C |

---

## 7. Dosya Sistemi Sınırları (FAT32 4GB Tuzağı)

* **FAT32:** Tek bir dosya **maksimum 4 GB** olabilir. 500GB dosya 4GB sınırına ulaştığı anda işletim sistemi hata verir.
* **exFAT / NTFS:** Dosya boyutu sınırı pratikte yoktur (16 TB+).
* **Kural:** 500GB indirilecek sürücünün (dahili disk, harici SSD veya USB) mutlaka **NTFS** veya **exFAT** formatında olması şarttır.
