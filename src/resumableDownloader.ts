import fs from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createMD5, type IHasher } from 'hash-wasm';

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  lastSyncedBytes: number;
  percentage: number | null;
  activeWorkers: number;
  bufferedChunksInRam: number;
  mode: 'sliding-window-multi' | 'single-stream';
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
  /** Motor olay günlüğü geri çağrısı */
  onLog?: (message: string) => void;
}

export interface DownloadMetadata {
  downloadedBytes: number;
  totalBytes: number;
  md5StateBase64: string;
  etag?: string | null;
  updatedAt?: string;
}

export interface DownloadResult {
  path: string;
  md5: string;
  bytes: number;
  resumedFromBytes: number;
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
  private readonly onLog?: (message: string) => void;

  constructor(options: ResumableDownloaderOptions) {
    this.url = options.url;
    this.targetPath = path.resolve(options.targetPath);
    this.metaPath = `${this.targetPath}.meta.json`;
    this.expectedMd5 = options.expectedMd5?.toLowerCase().trim() || null;
    this.saveIntervalBytes = options.saveIntervalBytes ?? 64 * 1024 * 1024; // 64 MB
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.chunkSizeBytes = Math.max(64 * 1024, options.chunkSizeBytes ?? 4 * 1024 * 1024); // 4 MB
    this.maxWindowChunks = Math.max(this.concurrency, options.maxWindowChunks ?? this.concurrency * 2);
    this.maxRetriesPerChunk = options.maxRetriesPerChunk ?? 3;
    this.signal = options.signal;
    this.onProgress = options.onProgress;
    this.onLog = options.onLog;
  }

  private log(msg: string): void {
    console.log(msg);
    this.onLog?.(msg);
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
      etag,
      updatedAt: new Date().toISOString()
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
    await fsp.mkdir(path.dirname(this.targetPath), { recursive: true });

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
        this.log(`[Devam Ediyor] meta.json yüklendi. Kaldığı ofset: ${downloadedBytes.toLocaleString()} bayt`);
      } else {
        this.log('[Uyarı] Diskteki dosya meta verisinden küçük, sıfırdan başlanıyor.');
        hasher.init();
      }
    } else {
      hasher.init();
      this.log('[Başlatılıyor] Sıfırdan indirme başlatılıyor.');
    }

    const probe = await this.probeServer(downloadedBytes, etag);
    if (!probe.supportsRange && downloadedBytes > 0) {
      this.log('[Uyarı] Sunucu Range kabul etmedi veya ETag değişti, sıfırdan başlanıyor.');
      downloadedBytes = 0;
      hasher.init();
    }
    totalBytes = probe.totalBytes;
    etag = probe.etag;

    const resumedFromBytes = downloadedBytes;

    // Dosya zaten tamamen inmişse doğrudan doğrula
    if (totalBytes > 0 && downloadedBytes === totalBytes) {
      const calculatedMd5 = hasher.digest('hex');
      this.log(`[Tamamlandı] Dosya zaten tam boyutta. MD5: ${calculatedMd5}`);
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
        resumedFromBytes,
        mode: 'sliding-window-multi'
      };
    }

    if (this.concurrency === 1 || !probe.supportsRange || totalBytes <= 0) {
      this.log(`[Mod] Single-Stream aktif (Toplam: ${totalBytes > 0 ? totalBytes.toLocaleString() + ' bayt' : 'Bilinmiyor'})`);
      return this.downloadSingleStream(hasher, downloadedBytes, resumedFromBytes, totalBytes, etag);
    }

    this.log(
      `[Mod] Sliding-Window Multi-Stream aktif (${this.concurrency} İşçi, ${(this.chunkSizeBytes / (1024 * 1024)).toFixed(1)} MB Pencere Dilimi, Maks. ${this.maxWindowChunks} RAM Parçası)`
    );
    return this.downloadSlidingWindowMultiStream(hasher, downloadedBytes, resumedFromBytes, totalBytes, etag);
  }

  private async downloadSlidingWindowMultiStream(
    hasher: IHasher,
    initialDownloadedBytes: number,
    resumedFromBytes: number,
    totalBytes: number,
    etag: string | null
  ): Promise<DownloadResult> {
    let downloadedBytes = initialDownloadedBytes;
    let lastSyncedBytes = initialDownloadedBytes;

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

    const completedChunks = new Map<number, Buffer>();
    const internalAbort = new AbortController();

    const onExternalAbort = () => internalAbort.abort(this.signal?.reason);
    this.signal?.addEventListener('abort', onExternalAbort, { once: true });

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
          this.log(`[Yeniden Deneme ${attempt}/${this.maxRetriesPerChunk}] Aralık: ${start}-${end}`);
          await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt - 1)));
        }
      }
    };

    const runWorker = async () => {
      activeWorkers++;
      try {
        while (!internalAbort.signal.aborted && !fatalError) {
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

    const runSequentialWriter = async () => {
      while (nextWriteIndex < totalChunks) {
        const chunkBuffer = completedChunks.get(nextWriteIndex);

        if (!chunkBuffer) {
          if (fatalError || internalAbort.signal.aborted) {
            throw fatalError ?? new Error('İndirme kullanıcı tarafından duraklatıldı.');
          }
          await waitForStateChange();
          continue;
        }

        completedChunks.delete(nextWriteIndex);
        nextWriteIndex++;
        triggerNotify();

        await this.writeAllToDisk(fileFd, chunkBuffer, downloadedBytes);

        hasher.update(chunkBuffer);
        downloadedBytes += chunkBuffer.length;
        bytesSinceLastSave += chunkBuffer.length;

        if (bytesSinceLastSave >= this.saveIntervalBytes) {
          await this.persistProgress(fileFd, hasher, downloadedBytes, totalBytes, etag);
          lastSyncedBytes = downloadedBytes;
          bytesSinceLastSave = 0;
          this.log(`[fsync Checkpoint] ${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB diske ve meta.json'a eşitlendi.`);
        }

        this.onProgress?.({
          downloadedBytes,
          totalBytes,
          lastSyncedBytes,
          percentage: Number(((downloadedBytes / totalBytes) * 100).toFixed(2)),
          activeWorkers,
          bufferedChunksInRam: completedChunks.size,
          mode: 'sliding-window-multi'
        });
      }
    };

    try {
      const workerCount = Math.min(this.concurrency, Math.max(1, totalChunks));
      const workers = Array.from({ length: workerCount }, () => runWorker());

      await Promise.all([runSequentialWriter(), ...workers]);

      await fileFd.sync();
      lastSyncedBytes = downloadedBytes;
      await fileFd.close();

      this.onProgress?.({
        downloadedBytes,
        totalBytes,
        lastSyncedBytes,
        percentage: 100,
        activeWorkers: 0,
        bufferedChunksInRam: 0,
        mode: 'sliding-window-multi'
      });

      const calculatedMd5 = hasher.digest('hex');
      this.log(`[Tamamlandı - Multi-Stream] Hesaplanan MD5: ${calculatedMd5}`);

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
        resumedFromBytes,
        mode: 'sliding-window-multi'
      };
    } catch (err) {
      try {
        await this.persistProgress(fileFd, hasher, downloadedBytes, totalBytes, etag);
        lastSyncedBytes = downloadedBytes;
        this.log(`[Kurtarma Kaydı] Kesinti anındaki ${downloadedBytes.toLocaleString()} bayt ve MD5 durumu kaydedildi.`);
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

  private async downloadSingleStream(
    hasher: IHasher,
    initialDownloadedBytes: number,
    resumedFromBytes: number,
    totalBytes: number,
    etag: string | null
  ): Promise<DownloadResult> {
    let downloadedBytes = initialDownloadedBytes;
    let lastSyncedBytes = initialDownloadedBytes;

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
      lastSyncedBytes = 0;
      hasher.init();
    }

    const fileFd = await fsp.open(this.targetPath, downloadedBytes > 0 ? 'r+' : 'w+');
    if (downloadedBytes > 0) {
      await fileFd.truncate(downloadedBytes);
    }

    let bytesSinceLastSave = 0;
    let lastUiUpdateMs = 0;

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
          lastSyncedBytes = downloadedBytes;
          bytesSinceLastSave = 0;
          this.log(`[fsync Checkpoint] ${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB diske ve meta.json'a eşitlendi.`);
        }

        const now = Date.now();
        if (now - lastUiUpdateMs >= 100 || bytesSinceLastSave === 0) {
          lastUiUpdateMs = now;
          this.onProgress?.({
            downloadedBytes,
            totalBytes,
            lastSyncedBytes,
            percentage: totalBytes > 0 ? Number(((downloadedBytes / totalBytes) * 100).toFixed(2)) : null,
            activeWorkers: 1,
            bufferedChunksInRam: 0,
            mode: 'single-stream'
          });
        }
      }

      await fileFd.sync();
      lastSyncedBytes = downloadedBytes;
      await fileFd.close();

      this.onProgress?.({
        downloadedBytes,
        totalBytes,
        lastSyncedBytes,
        percentage: 100,
        activeWorkers: 0,
        bufferedChunksInRam: 0,
        mode: 'single-stream'
      });

      const calculatedMd5 = hasher.digest('hex');
      this.log(`[Tamamlandı - Single-Stream] Hesaplanan MD5: ${calculatedMd5}`);

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
        resumedFromBytes,
        mode: 'single-stream'
      };
    } catch (err) {
      try {
        await this.persistProgress(fileFd, hasher, downloadedBytes, totalBytes, etag);
        lastSyncedBytes = downloadedBytes;
        this.log(`[Kurtarma Kaydı] Kesinti anındaki ${downloadedBytes.toLocaleString()} bayt ve MD5 durumu kaydedildi.`);
      } catch {
        // Disk hatasıysa son başarılı checkpoint korunur
      } finally {
        await fileFd.close().catch(() => {});
      }
      throw err;
    }
  }
}
