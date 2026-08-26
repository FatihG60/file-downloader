# 📋 Gelecek Özellikler ve Geliştirme Yol Haritası (Roadmap)

Bu döküman, **File Downloader** projesine eklenen ve ilerleyen sürümlerde eklenmesi planlanan yüksek katma değerli özellikleri ve geliştirme maddelerini içerir.

---

## 1. 🚀 Disk & Performans İyileştirmeleri *(500GB+ İçin Kritik)*

- [x] **Akıllı Otomatik Disk Algılama (Smart Adaptive Storage Profile):**
  - Seçilen dizinin hangi sürücüde olduğunu (örn: `C:`, `D:`, `E:`), dosya sistemini (`NTFS`, `exFAT`, `FAT32`) ve sürücü türünü (`Fixed SSD/NVMe`, `Removable USB`) anında tespit eder.
  - Hedef ortama göre akış sayısını ve bellek tamponunu otomatik optimize eder.
- [x] **Boş Disk Alanı Ön Kontrolü (Disk Space Pre-check):**
  - İndirme başlamadan önce seçilen sürücüdeki boş alan kontrol edilir. Alan yetersizse kullanıcı anında uyarılır.
- [x] **FAT32 4GB Sınır Koruması:**
  - Seçilen sürücü FAT32 formatındaysa ve dosya 4GB'tan büyükse indirme başlamadan önce kullanıcıyı uyararak dosyanın bozulmasını önler.
- [x] **Disk Parçalanmasını Önleme (File Pre-allocation - `ftruncate`):**
  - 500GB gibi devasa dosyalarda Windows NTFS metadata kilitlemesini ve parçalanmayı önlemek için dosya boyutu baştan rezerve edilir.
- [x] **Gigabit Ağ Akış Kontrolü (Active Stream Backpressure):**
  - Gigabit ağ (125 MB/s) yavaş bir USB diske yazarken RAM'in şişmesini önlemek için TCP soketini otomatik duraklatıp (`pause`) devam ettirir (`resume`).
- [ ] **Bant Genişliği / Hız Sınırlayıcı (Speed Limiter):**
  - Kullanıcının ev/ofis internetini tamamen kilitlememesi için arayüzden maksimum indirme hızı sınırı (örn: `25 MB/s`, `50 MB/s`, `Sınırsız`) seçebilme imkânı.

---

## 2. 🛡️ Veri Bütünlüğü & S3 Kolaylığı

- [ ] **SHA-256 / MD5 Bütünlük Doğrulama (Checksum Verifier):**
  - 500GB'lık ISO veya arşiv dosyalarında tek 1 bitlik bozulma bile dosyayı kullanılamaz yapabilir. İndirme esnasında on-the-fly hash hesaplanarak bitiminde dosya bütünlüğü doğrulanabilir.
- [ ] **Süresi Dolan S3 Presigned URL'i Yenileme (Refresh Expired URL):**
  - 500GB dosya indirilirken S3 URL'inin süresi dolarsa (örn: 6 saat sonra), kart üzerinde **"Yeni URL Gir"** butonuyla indirmeyi sıfırlamadan aynı `.part` dosyasından yeni URL ile devam ettirebilme.

---

## 3. 🖥️ Masaüstü & İşletim Sistemi Entegrasyonu

- [ ] **Windows Uyku Modunu Engelleme (`powerSaveBlocker`):**
  - Gece boyunca 500GB dosya indirilirken Windows'un uykuya geçip indirmeyi kesmesini engelleyen Electron güç yönetimi.
- [ ] **Windows Görev Çubuğu İlerlemesi (`mainWindow.setProgressBar`):**
  - Uygulama simgesinin üzerinde yeşil dolan canlı yüzde çubuğu.
- [ ] **Sistem Tepsisi (System Tray) & Arka Planda İndirme:**
  - Pencere kapatılsa bile uygulamanın sağ alt köşede (Tray) sessizce indirmeye devam etmesi.
- [ ] **"İndirme Bitince Bilgisayarı Kapat / Uyut":**
  - Gece bırakılan büyük indirmeler bittiğinde sistemi otomatik kapatma seçeneği.

---

## 4. 📋 İndirme Kuyruğu & Yönetimi

- [ ] **Kuyruk Sıralama (Queue Management):**
  - Aynı anda en fazla 2 dosya insin, diğerleri sırada beklesin (Start Next on Finish).
- [ ] **Kalıcı İndirme Geçmişi (Persistent History):**
  - Uygulama kapatılıp açılsa bile geçmiş indirmelerin ve yarım kalanların listede saklanması (`electron-store` veya SQLite).
