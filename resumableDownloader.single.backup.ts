import fs from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createMD5, type IHasher } from 'hash-wasm';

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  percentage: number | null;
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
}

/**
 * YEDEK (BACKUP): Tek Akışlı (Single-Stream) Resumable MD5 Downloader
 */
export class ResumableSingleStreamDownloader {
  private readonly url: string;
  private readonly targetPath: string;
  private readonly metaPath: string;
  private readonly expectedMd5: string | null;
  private readonly saveIntervalBytes: number;
  private readonly signal?: AbortSignal;
  private readonly onProgress?: (progress: DownloadProgress) => void;

  constructor(options: ResumableDownloaderOptions) {
    this.url = options.url;
    this.targetPath = path.resolve(options.targetPath);
    this.metaPath = `${this.targetPath}.meta.json`;
    this.expectedMd5 = options.expectedMd5?.toLowerCase().trim() ?? null;
    this.saveIntervalBytes = options.saveIntervalBytes ?? 64 * 1024 * 1024; // 64 MB
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

  public async download(): Promise<DownloadResult> {
    const hasher: IHasher = await createMD5();
    let downloadedBytes = 0;
    let totalBytes = 0;
    let etag: string | null = null;

    const meta = await this.loadMeta();

    // Kaldığı yerden devam kontrolü
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

    const headers: Record<string, string> = {};
    if (downloadedBytes > 0) {
      headers['Range'] = `bytes=${downloadedBytes}-`;
      if (etag) {
        headers['If-Range'] = etag;
      }
    }

    const response = await fetch(this.url, {
      headers,
      signal: this.signal
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`Sunucu hatası: HTTP ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Sunucu yanıt gövdesi (ReadableStream) boş döndü.');
    }

    if (response.status === 200 && downloadedBytes > 0) {
      console.warn('[Uyarı] Sunucu 200 OK döndü (Range kabul edilmedi), baştan indiriliyor.');
      downloadedBytes = 0;
      hasher.init();
    }

    etag = response.headers.get('etag') ?? etag;

    if (response.status === 206) {
      const cr = response.headers.get('content-range');
      if (cr) {
        const totalPart = cr.split('/')[1];
        if (totalPart && totalPart !== '*') {
          totalBytes = parseInt(totalPart, 10);
        }
      }
    } else {
      const cl = response.headers.get('content-length');
      if (cl) totalBytes = parseInt(cl, 10);
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

        let bytesWrittenTotal = 0;
        while (bytesWrittenTotal < buffer.length) {
          const { bytesWritten } = await fileFd.write(
            buffer,
            bytesWrittenTotal,
            buffer.length - bytesWrittenTotal,
            downloadedBytes + bytesWrittenTotal
          );
          bytesWrittenTotal += bytesWritten;
        }

        hasher.update(value);
        downloadedBytes += buffer.length;
        bytesSinceLastSave += buffer.length;

        if (bytesSinceLastSave >= this.saveIntervalBytes) {
          await this.persistProgress(fileFd, hasher, downloadedBytes, totalBytes, etag);
          bytesSinceLastSave = 0;

          this.onProgress?.({
            downloadedBytes,
            totalBytes,
            percentage: totalBytes > 0 ? Number(((downloadedBytes / totalBytes) * 100).toFixed(2)) : null
          });
        }
      }

      await fileFd.sync();
      await fileFd.close();

      const calculatedMd5 = hasher.digest('hex');
      console.log(`[Tamamlandı] Hesaplanan MD5: ${calculatedMd5}`);

      if (this.expectedMd5 && calculatedMd5 !== this.expectedMd5) {
        throw new Error(`MD5 uyuşmazlığı! Beklenen: ${this.expectedMd5}, Hesaplanan: ${calculatedMd5}`);
      }

      if (fs.existsSync(this.metaPath)) {
        await fsp.unlink(this.metaPath);
      }

      return {
        path: this.targetPath,
        md5: calculatedMd5,
        bytes: downloadedBytes
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
