# 📋 Gelecek Özellikler ve Geliştirme Yol Haritası (Roadmap)

Bu döküman, **File Downloader** projesine ilerleyen sürümlerde eklenmesi planlanan yüksek katma değerli özellikleri ve geliştirme maddelerini içerir.

---

## 1. 🚀 Disk & Performans İyileştirmeleri *(500GB+ İçin Kritik)*

- [ ] **Boş Disk Alanı Kontrolü (Disk Space Pre-check):**
  - 500GB indirme başlamadan önce seçilen sürücüde (örn: `D:\`) yeterli boş alan olup olmadığı Node.js `fs.statfs` ile kontrol edilir. Alan yetersizse kullanıcı anında uyarılır.
- [ ] **Disk Parçalanmasını Önleme (File Pre-allocation):**
  - 500GB gibi devasa dosyalarda 8-16 parçalı yazım yaparken diskin parçalanmasını (fragmentation) ve I/O darboğazını önlemek için dosya boyutu baştan rezerve edilebilir.
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
