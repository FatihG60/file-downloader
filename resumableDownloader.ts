import fs from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createMD5, type IHasher } from 'hash-wasm';

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  percentage: number | null;
  activeWorkers: number;
  bufferedChunksInRam: number;
}

export interface ResumableDownloaderOptions {
  /** İndirilecek dosyanın URL'i */
  url: string;
  /** Hedef dosya yolu (örn: USB disk yolu) */
  targetPath: string;
  /** Doğrulanacak MD5 hash'i (opsiyonel) */
  expectedMd5?: string;
  /** Kaç baytta bir durum diske (fsync + meta.json) kaydedilsin (Varsayılan: 64 MB) */
  saveIntervalBytes?: number;
  /**
   * Eşzamanlı HTTP bağlantı sayısı (Varsayılan: 4).
   * 1 verilirse veya sunucu Range desteklemiyorsa otomatik Single-Stream çalışır.
   */
  concurrency?: number;
  /**
   * Kayan pencere (Sliding Window) içindeki her bir parçanın boyutu (Varsayılan: 4 MB).
   */
  chunkSizeBytes?: number;
  /**
   * RAM'de aynı anda tutulabilecek maksimum parça sayısı (Varsayılan: concurrency * 2).
   * USB disk yavaşladığında RAM şişmesini (OOM) önleyen Ring-Buffer üst sınırıdır.
   */
  maxWindowChunks?: number;
  /** Parça başına maksimum yeniden deneme sayısı (Varsayılan: 3) */
  maxRetriesPerChunk?: number;
  /** İndirmeyi güvenli şekilde duraklatmak/iptal etmek için AbortSignal */
  signal?: AbortSignal;
  /** İlerleme durumu geri çağrısı */
  onProgress?: (progress: DownloadProgress) => void;
}

interface DownloadMetadata {
  downloadedBytes: number;
  totalBytes: number;
  md5StateBase64: string;
  etag?: string | null;
}

export interface DownloadResult {
  path: string;
  md5: string;
  bytes: number;
  mode: 'sliding-window-multi' | 'single-stream';
}

/**
 * Kayan Pencere (Sliding Window / Ring-Buffer) Multi-Stream + Sıralı USB/MD5 İndirici.
 * - Ağdan N paralel bağlantıyla ardışık küçük bloklar (örn. 4 MB) indirir.
 * - USB diske ve MD5 motoruna ise %100 SIRALI (Sequential Single-Stream) olarak yazar.
 * - Böylece ne USB diskte Random I/O şişmesi yaşanır ne de MD5 sırası bozulur.
 */
export class ResumableDownloader {
  private readonly url: string;
  private readonly targetPath: string;
  private readonly metaPath: string;
  private readonly expectedMd5: string | null;
  private readonly saveIntervalBytes: number;
  private readonly concurrency: number;
  private readonly chunkSizeBytes: number;
  private readonly maxWindowChunks: number;
  private readonly maxRetriesPerChunk: number;
  private readonly signal?: AbortSignal;
  private readonly onProgress?: (progress: DownloadProgress) => void;

  constructor(options: ResumableDownloaderOptions) {
    this.url = options.url;
    this.targetPath = path.resolve(options.targetPath);
    this.metaPath = `${this.targetPath}.meta.json`;
    this.expectedMd5 = options.expectedMd5?.toLowerCase().trim() ?? null;
    this.saveIntervalBytes = options.saveIntervalBytes ?? 64 * 1024 * 1024; // 64 MB
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.chunkSizeBytes = Math.max(64 * 1024, options.chunkSizeBytes ?? 4 * 1024 * 1024); // 4 MB
    this.maxWindowChunks = Math.max(this.concurrency, options.maxWindowChunks ?? this.concurrency * 2);
    this.maxRetriesPerChunk = options.maxRetriesPerChunk ?? 3;
    this.signal = options.signal;
    this.onProgress = options.onProgress;
  }

  private async loadMeta(): Promise<DownloadMetadata | null> {
    try {
      const data = await fsp.readFile(this.metaPath, 'utf8');
      return JSON.parse(data) as DownloadMetadata;
    } catch {
      return null;
    }
  }

  private async persistProgress(
    fileFd: FileHandle,
    hasher: IHasher,
    downloadedBytes: number,
    totalBytes: number,
    etag: string | null
  ): Promise<void> {
    // 1. İşletim sistemindeki tüm dirty page'leri fiziksel olarak USB diske bas
    await fileFd.sync();

    // 2. MD5 motorunun iç durumunu (Uint8Array) Base64 olarak serileştir
    const stateBytes: Uint8Array = hasher.save();
    const meta: DownloadMetadata = {
      downloadedBytes,
      totalBytes,
      md5StateBase64: Buffer.from(stateBytes).toString('base64'),
      etag
    };

    // 3. Atomik olarak meta.json'u güncelle (.tmp -> rename)
    const tempMetaPath = `${this.metaPath}.tmp`;
    await fsp.writeFile(tempMetaPath, JSON.stringify(meta, null, 2), 'utf8');
    await fsp.rename(tempMetaPath, this.metaPath);
  }

  private async writeAllToDisk(fileFd: FileHandle, buffer: Buffer, position: number): Promise<void> {
    let bytesWrittenTotal = 0;
    while (bytesWrittenTotal < buffer.length) {
      const { bytesWritten } = await fileFd.write(
        buffer,
        bytesWrittenTotal,
        buffer.length - bytesWrittenTotal,
        position + bytesWrittenTotal
      );
      bytesWrittenTotal += bytesWritten;
    }
  }

  /**
   * Sunucunun Range desteğini ve toplam dosya boyutunu kontrol eder.
   */
  private async probeServer(
    resumeOffset: number,
    savedEtag: string | null
  ): Promise<{ supportsRange: boolean; totalBytes: number; etag: string | null }> {
    const probeOffset = resumeOffset > 0 ? resumeOffset : 0;
    const headers: Record<string, string> = {
      Range: `bytes=${probeOffset}-${probeOffset}`
    };
    if (resumeOffset > 0 && savedEtag) {
      headers['If-Range'] = savedEtag;
    }

    const res = await fetch(this.url, {
      method: 'GET',
      headers,
      signal: this.signal
    });

    // Probe akışını hemen iptal et (sadece başlıkları okuyoruz)
    await res.body?.cancel().catch(() => {});

    if (!res.ok && res.status !== 206) {
      throw new Error(`Sunucu probe hatası: HTTP ${res.status} ${res.statusText}`);
    }

    const etag = res.headers.get('etag') ?? savedEtag;

    if (res.status === 206) {
      const cr = res.headers.get('content-range');
      if (cr) {
        const totalPart = cr.split('/')[1];
        if (totalPart && totalPart !== '*') {
          const totalBytes = parseInt(totalPart, 10);
          if (Number.isFinite(totalBytes) && totalBytes > 0) {
            return { supportsRange: true, totalBytes, etag };
          }
        }
      }
    }

    const cl = res.headers.get('content-length');
    const totalBytes = cl ? parseInt(cl, 10) : 0;
    return { supportsRange: false, totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0, etag };
  }

  public async download(): Promise<DownloadResult> {
    const hasher: IHasher = await createMD5();
    let downloadedBytes = 0;
    let totalBytes = 0;
    let etag: string | null = null;

    const meta = await this.loadMeta();

    if (meta && fs.existsSync(this.targetPath)) {
      const stat = await fsp.stat(this.targetPath);
      if (stat.size >= meta.downloadedBytes && meta.downloadedBytes > 0) {
        downloadedBytes = meta.downloadedBytes;
        totalBytes = meta.totalBytes || 0;
        etag = meta.etag ?? null;

        const stateBuffer = Buffer.from(meta.md5StateBase64, 'base64');
        hasher.load(new Uint8Array(stateBuffer));
        console.log(`[Devam Ediyor] Kaldığı bayt: ${downloadedBytes}`);
      } else {
        console.warn('[Uyarı] Diskteki dosya meta verisinden küçük, sıfırdan başlanıyor.');
        hasher.init();
      }
    } else {
      hasher.init();
      console.log('[Başlatılıyor] Sıfırdan indirme başlatılıyor.');
    }

    // 1. Sunucunun Range desteğini ve dosya boyutunu öğren
    const probe = await this.probeServer(downloadedBytes, etag);
    if (!probe.supportsRange && downloadedBytes > 0) {
      console.warn('[Uyarı] Sunucu Range kabul etmedi veya dosya değişti, sıfırdan başlanıyor.');
      downloadedBytes = 0;
      hasher.init();
    }
    totalBytes = probe.totalBytes;
    etag = probe.etag;

    // Eğer concurrency === 1 ise veya sunucu Range/boyut vermiyorsa Single-Stream modunda çalıştır
    if (this.concurrency === 1 || !probe.supportsRange || totalBytes <= 0) {
      return this.downloadSingleStream(hasher, downloadedBytes, totalBytes, etag);
    }

    return this.downloadSlidingWindowMultiStream(hasher, downloadedBytes, totalBytes, etag);
  }

  /**
   * Kayan Pencere (Sliding Window) Multi-Stream İndirme:
   * - Worker'lar [startByte .. endByte] aralığındaki 4 MB'lık parçaları paralel indirir.
   * - RAM'de en fazla `maxWindowChunks` (örn: 8 parça = 32 MB) tutulur (Backpressure).
   * - Sıralı Yazıcı (Sequential Writer) parçaları 0, 1, 2... sırasıyla USB diske yazar ve MD5'e besler.
   */
  private async downloadSlidingWindowMultiStream(
    hasher: IHasher,
    initialDownloadedBytes: number,
    totalBytes: number,
    etag: string | null
  ): Promise<DownloadResult> {
    let downloadedBytes = initialDownloadedBytes;

    const fileFd = await fsp.open(this.targetPath, downloadedBytes > 0 ? 'r+' : 'w+');
    if (downloadedBytes > 0) {
      await fileFd.truncate(downloadedBytes);
    }

    const remainingBytes = totalBytes - downloadedBytes;
    const totalChunks = Math.ceil(remainingBytes / this.chunkSizeBytes);

    let nextFetchIndex = 0;
    let nextWriteIndex = 0;
    let bytesSinceLastSave = 0;
    let activeWorkers = 0;
    let fatalError: unknown = null;

    // İndirilen ancak sırası henüz gelmemiş parçaların tutulduğu sınırlı RAM tamponu
    const completedChunks = new Map<number, Buffer>();
    const internalAbort = new AbortController();

    const onExternalAbort = () => internalAbort.abort(this.signal?.reason);
    this.signal?.addEventListener('abort', onExternalAbort, { once: true });

    // Pencere ve yazıcı senkronizasyonu için basit sinyal mekanizması
    let notifyStateChange: (() => void) | null = null;
    const triggerNotify = () => {
      if (notifyStateChange) {
        const fn = notifyStateChange;
        notifyStateChange = null;
        fn();
      }
    };
    const waitForStateChange = () =>
      new Promise<void>((resolve) => {
        notifyStateChange = resolve;
      });

    // Tek bir parçayı (chunk) retry desteğiyle indiren yardımcı fonksiyon
    const fetchChunkWithRetry = async (start: number, end: number): Promise<Buffer> => {
      let attempt = 0;
      while (true) {
        try {
          const headers: Record<string, string> = {
            Range: `bytes=${start}-${end}`
          };
          if (etag) {
            headers['If-Range'] = etag;
          }

          const res = await fetch(this.url, {
            headers,
            signal: internalAbort.signal
          });

          if (res.status !== 206) {
            throw new Error(`Beklenen 206 Partial Content, gelen: HTTP ${res.status}`);
          }

          const arrayBuf = await res.arrayBuffer();
          const expectedLen = end - start + 1;
          if (arrayBuf.byteLength !== expectedLen) {
            throw new Error(`Eksik parça boyutu: beklenen ${expectedLen}, gelen ${arrayBuf.byteLength}`);
          }

          return Buffer.from(arrayBuf);
        } catch (err) {
          attempt++;
          if (internalAbort.signal.aborted || attempt > this.maxRetriesPerChunk) {
            throw err;
          }
          // Exponential backoff (300ms, 600ms, 1200ms)
          await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt - 1)));
        }
      }
    };

    // Paralel İndirme İşçisi (Worker)
    const runWorker = async () => {
      activeWorkers++;
      try {
        while (!internalAbort.signal.aborted && !fatalError) {
          // Kayan Pencere (Ring-Buffer) sınırı doluysa USB yazıcısının yer açmasını bekle!
          if (nextFetchIndex >= nextWriteIndex + this.maxWindowChunks) {
            if (nextFetchIndex >= totalChunks) break;
            await waitForStateChange();
            continue;
          }

          if (nextFetchIndex >= totalChunks) break;

          const chunkIndex = nextFetchIndex++;
          const start = initialDownloadedBytes + chunkIndex * this.chunkSizeBytes;
          const end = Math.min(totalBytes - 1, start + this.chunkSizeBytes - 1);

          const chunkBuffer = await fetchChunkWithRetry(start, end);
          completedChunks.set(chunkIndex, chunkBuffer);
          triggerNotify();
        }
      } catch (err) {
        if (!fatalError) {
          fatalError = err;
          internalAbort.abort();
          triggerNotify();
        }
      } finally {
        activeWorkers--;
        triggerNotify();
      }
    };

    // Sıralı USB Disk Yazıcısı ve MD5 Güncelleyicisi (Sequential Consumer)
    const runSequentialWriter = async () => {
      while (nextWriteIndex < totalChunks) {
        const chunkBuffer = completedChunks.get(nextWriteIndex);

        if (!chunkBuffer) {
          if (fatalError || internalAbort.signal.aborted) {
            throw fatalError ?? new Error('İndirme iptal edildi.');
          }
          await waitForStateChange();
          continue;
        }

        // Parçayı RAM haritasından çıkar (GC için serbest bırak) ve bekleyen worker'ları uyandır
        completedChunks.delete(nextWriteIndex);
        nextWriteIndex++;
        triggerNotify();

        // 1. USB diske sıralı (sequential) olarak yaz
        await this.writeAllToDisk(fileFd, chunkBuffer, downloadedBytes);

        // 2. MD5 durumunu ve bayt sayacını sıralı olarak güncelle
        hasher.update(chunkBuffer);
        downloadedBytes += chunkBuffer.length;
        bytesSinceLastSave += chunkBuffer.length;

        // 3. Periyodik fsync + meta.json checkpoint kaydı
        if (bytesSinceLastSave >= this.saveIntervalBytes) {
          await this.persistProgress(fileFd, hasher, downloadedBytes, totalBytes, etag);
          bytesSinceLastSave = 0;
        }

        this.onProgress?.({
          downloadedBytes,
          totalBytes,
          percentage: Number(((downloadedBytes / totalBytes) * 100).toFixed(2)),
          activeWorkers,
          bufferedChunksInRam: completedChunks.size
        });
      }
    };

    try {
      const workerCount = Math.min(this.concurrency, Math.max(1, totalChunks));
      const workers = Array.from({ length: workerCount }, () => runWorker());

      await Promise.all([runSequentialWriter(), ...workers]);

      // İndirme tamamlandığında son dirty page'leri USB'ye bas
      await fileFd.sync();
      await fileFd.close();

      const calculatedMd5 = hasher.digest('hex');
      console.log(`[Tamamlandı - Multi-Stream] Hesaplanan MD5: ${calculatedMd5}`);

      if (this.expectedMd5 && calculatedMd5 !== this.expectedMd5) {
        throw new Error(`MD5 uyuşmazlığı! Beklenen: ${this.expectedMd5}, Hesaplanan: ${calculatedMd5}`);
      }

      if (fs.existsSync(this.metaPath)) {
        await fsp.unlink(this.metaPath);
      }

      return {
        path: this.targetPath,
        md5: calculatedMd5,
        bytes: downloadedBytes,
        mode: 'sliding-window-multi'
      };
    } catch (err) {
      // Hata veya duraklatma anında o ana kadar sıralı yazılmış olan son durumu kaydet
      try {
        await this.persistProgress(fileFd, hasher, downloadedBytes, totalBytes, etag);
      } catch {
        // Disk hatasıysa son başarılı checkpoint korunur
      } finally {
        await fileFd.close().catch(() => {});
      }
      throw err;
    } finally {
      this.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * Yedek / Fallback: Tek Akışlı (Single-Stream) İndirme
   */
  private async downloadSingleStream(
    hasher: IHasher,
    initialDownloadedBytes: number,
    totalBytes: number,
    etag: string | null
  ): Promise<DownloadResult> {
    let downloadedBytes = initialDownloadedBytes;

    const headers: Record<string, string> = {};
    if (downloadedBytes > 0) {
      headers['Range'] = `bytes=${downloadedBytes}-`;
      if (etag) headers['If-Range'] = etag;
    }

    const response = await fetch(this.url, { headers, signal: this.signal });
    if (!response.ok && response.status !== 206) {
      throw new Error(`Sunucu hatası: HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error('Sunucu yanıt gövdesi boş döndü.');
    }

    if (response.status === 200 && downloadedBytes > 0) {
      downloadedBytes = 0;
      hasher.init();
    }

    const fileFd = await fsp.open(this.targetPath, downloadedBytes > 0 ? 'r+' : 'w+');
    if (downloadedBytes > 0) {
      await fileFd.truncate(downloadedBytes);
    }

    let bytesSinceLastSave = 0;

    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        await this.writeAllToDisk(fileFd, buffer, downloadedBytes);

        hasher.update(value);
        downloadedBytes += buffer.length;
        bytesSinceLastSave += buffer.length;

        if (bytesSinceLastSave >= this.saveIntervalBytes) {
          await this.persistProgress(fileFd, hasher, downloadedBytes, totalBytes, etag);
          bytesSinceLastSave = 0;

          this.onProgress?.({
            downloadedBytes,
            totalBytes,
            percentage: totalBytes > 0 ? Number(((downloadedBytes / totalBytes) * 100).toFixed(2)) : null,
            activeWorkers: 1,
            bufferedChunksInRam: 0
          });
        }
      }

      await fileFd.sync();
      await fileFd.close();

      const calculatedMd5 = hasher.digest('hex');
      if (this.expectedMd5 && calculatedMd5 !== this.expectedMd5) {
        throw new Error(`MD5 uyuşmazlığı! Beklenen: ${this.expectedMd5}, Hesaplanan: ${calculatedMd5}`);
      }

      if (fs.existsSync(this.metaPath)) {
        await fsp.unlink(this.metaPath);
      }

      return {
        path: this.targetPath,
        md5: calculatedMd5,
        bytes: downloadedBytes,
        mode: 'single-stream'
      };
    } catch (err) {
      try {
        await this.persistProgress(fileFd, hasher, downloadedBytes, totalBytes, etag);
      } catch {
        // Disk hatasıysa son başarılı checkpoint korunur
      } finally {
        await fileFd.close().catch(() => {});
      }
      throw err;
    }
  }
}
