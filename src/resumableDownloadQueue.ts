import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  ResumableDownloader,
  type DownloadProgress,
  type DownloadResult
} from './resumableDownloader';

export type QueueItemStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'error';

export interface QueueItemInput {
  url: string;
  targetPath?: string;
  fileName?: string;
  expectedMd5?: string;
}

export interface QueueItemState {
  id: string;
  url: string;
  fileName: string;
  targetPath: string;
  expectedMd5: string | null;
  status: QueueItemStatus;
  downloadedBytes: number;
  totalBytes: number;
  lastSyncedBytes: number;
  percentage: number | null;
  resumedFromBytes: number;
  calculatedMd5: string | null;
  errorMessage: string | null;
  mode: 'sliding-window-multi' | 'single-stream' | null;
}

export interface QueueOptions {
  targetFolder: string;
  concurrency?: number;
  chunkSizeBytes?: number;
  saveIntervalBytes?: number;
  onQueueUpdated?: (items: QueueItemState[], activeItemId: string | null) => void;
  onActiveProgress?: (item: QueueItemState, progress: DownloadProgress) => void;
  onLog?: (message: string) => void;
}

/**
 * Sıralı (Sequential) Çoklu Dosya İndirme Kuyruğu.
 * Disk şişmesini (USB Random I/O / FTL kilitlenmesi) önlemek için
 * kuyruktaki dosyaları kesinlikle TEK TEK (biri tamamen bitip fsync olmadan diğerine geçmeden) indirir.
 */
export class ResumableDownloadQueue {
  private items: QueueItemState[] = [];
  private targetFolder: string;
  private concurrency: number;
  private chunkSizeBytes: number;
  private saveIntervalBytes: number;
  private isProcessing = false;
  private pauseRequested = false;
  private activeAbortController: AbortController | null = null;
  private activeItemId: string | null = null;

  private readonly onQueueUpdated?: (items: QueueItemState[], activeItemId: string | null) => void;
  private readonly onActiveProgress?: (item: QueueItemState, progress: DownloadProgress) => void;
  private readonly onLog?: (message: string) => void;

  constructor(options: QueueOptions) {
    this.targetFolder = path.resolve(options.targetFolder);
    this.concurrency = options.concurrency ?? 4;
    this.chunkSizeBytes = options.chunkSizeBytes ?? 4 * 1024 * 1024;
    this.saveIntervalBytes = options.saveIntervalBytes ?? 16 * 1024 * 1024;
    this.onQueueUpdated = options.onQueueUpdated;
    this.onActiveProgress = options.onActiveProgress;
    this.onLog = options.onLog;
  }

  public updateSettings(settings: {
    targetFolder?: string;
    concurrency?: number;
    chunkSizeBytes?: number;
    saveIntervalBytes?: number;
  }): void {
    if (settings.targetFolder) this.targetFolder = path.resolve(settings.targetFolder);
    if (settings.concurrency) this.concurrency = settings.concurrency;
    if (settings.chunkSizeBytes) this.chunkSizeBytes = settings.chunkSizeBytes;
    if (settings.saveIntervalBytes) this.saveIntervalBytes = settings.saveIntervalBytes;
  }

  public getItems(): QueueItemState[] {
    return this.items.map((item) => ({ ...item }));
  }

  public isRunning(): boolean {
    return this.isProcessing;
  }

  private extractFileName(rawUrl: string, indexHint: number): string {
    try {
      const parsed = new URL(rawUrl);
      const base = path.basename(parsed.pathname);
      if (base && base !== '/' && base.length > 0) {
        return decodeURIComponent(base);
      }
    } catch {
      // fallback
    }
    return `download-file-${Date.now()}-${indexHint}.bin`;
  }

  private emitUpdate(): void {
    this.onQueueUpdated?.(this.getItems(), this.activeItemId);
  }

  private log(msg: string): void {
    this.onLog?.(msg);
  }

  /**
   * Kuyruğa yeni URL'ler ekler ve diskte varsa önceki .meta.json durumlarını okur.
   */
  public async enqueueMany(inputs: QueueItemInput[]): Promise<QueueItemState[]> {
    const added: QueueItemState[] = [];

    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      const cleanUrl = inp.url.trim();
      if (!cleanUrl) continue;

      const fileName = inp.fileName?.trim() || this.extractFileName(cleanUrl, this.items.length + i + 1);
      const targetPath = inp.targetPath ? path.resolve(inp.targetPath) : path.join(this.targetFolder, fileName);

      // Aynı hedef dosya zaten kuyrukta varsa tekrar ekleme (veya hata/duraklatılmışsa sıfırdan kuyruğa al)
      const existing = this.items.find((x) => x.targetPath === targetPath);
      if (existing) {
        if (existing.status === 'paused' || existing.status === 'error') {
          existing.status = 'queued';
          existing.errorMessage = null;
          if (inp.expectedMd5) existing.expectedMd5 = inp.expectedMd5.toLowerCase().trim();
        }
        continue;
      }

      // Diskte .meta.json varsa başlangıç ilerlemesini yükle
      let downloadedBytes = 0;
      let totalBytes = 0;
      const metaPath = `${targetPath}.meta.json`;
      if (fs.existsSync(metaPath) && fs.existsSync(targetPath)) {
        try {
          const stat = await fsp.stat(targetPath);
          const rawMeta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
          if (rawMeta.downloadedBytes > 0 && stat.size >= rawMeta.downloadedBytes) {
            downloadedBytes = rawMeta.downloadedBytes;
            totalBytes = rawMeta.totalBytes || 0;
          }
        } catch {
          // ignore
        }
      }

      const percentage =
        totalBytes > 0 && downloadedBytes > 0
          ? Number(((downloadedBytes / totalBytes) * 100).toFixed(2))
          : null;

      const item: QueueItemState = {
        id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        url: cleanUrl,
        fileName: path.basename(targetPath),
        targetPath,
        expectedMd5: inp.expectedMd5?.toLowerCase().trim() || null,
        status: 'queued',
        downloadedBytes,
        totalBytes,
        lastSyncedBytes: downloadedBytes,
        percentage,
        resumedFromBytes: downloadedBytes,
        calculatedMd5: null,
        errorMessage: null,
        mode: null
      };

      this.items.push(item);
      added.push(item);
    }

    this.emitUpdate();
    return added;
  }

  /**
   * Kuyruktaki bekleyen veya duraklatılmış dosyaları sırayla (1'er 1'er) indirir.
   */
  public async startQueue(): Promise<void> {
    if (this.isProcessing) return;

    // Duraklatılmış veya hatalı öğeleri tekrar 'queued' durumuna çek
    for (const item of this.items) {
      if (item.status === 'paused' || item.status === 'error') {
        item.status = 'queued';
        item.errorMessage = null;
      }
    }
    this.emitUpdate();

    this.isProcessing = true;
    this.pauseRequested = false;

    try {
      while (!this.pauseRequested) {
        const nextItem = this.items.find((x) => x.status === 'queued');
        if (!nextItem) break;

        this.activeItemId = nextItem.id;
        nextItem.status = 'downloading';
        nextItem.errorMessage = null;
        this.emitUpdate();

        const queueIndex = this.items.findIndex((x) => x.id === nextItem.id) + 1;
        this.log(
          `[Kuyruk ${queueIndex}/${this.items.length}] Başlatılıyor: ${nextItem.fileName} (${nextItem.url})`
        );

        this.activeAbortController = new AbortController();

        const downloader = new ResumableDownloader({
          url: nextItem.url,
          targetPath: nextItem.targetPath,
          expectedMd5: nextItem.expectedMd5 ?? undefined,
          concurrency: this.concurrency,
          chunkSizeBytes: this.chunkSizeBytes,
          saveIntervalBytes: this.saveIntervalBytes,
          signal: this.activeAbortController.signal,
          onLog: (msg) => this.log(`[${nextItem.fileName}] ${msg}`),
          onProgress: (prog) => {
            nextItem.downloadedBytes = prog.downloadedBytes;
            nextItem.totalBytes = prog.totalBytes;
            nextItem.lastSyncedBytes = prog.lastSyncedBytes;
            nextItem.percentage = prog.percentage;
            nextItem.mode = prog.mode;
            this.onActiveProgress?.({ ...nextItem }, prog);
          }
        });

        try {
          const result: DownloadResult = await downloader.download();
          nextItem.status = 'completed';
          nextItem.downloadedBytes = result.bytes;
          nextItem.totalBytes = result.bytes;
          nextItem.lastSyncedBytes = result.bytes;
          nextItem.percentage = 100;
          nextItem.resumedFromBytes = result.resumedFromBytes;
          nextItem.calculatedMd5 = result.md5;
          nextItem.mode = result.mode;

          this.log(
            `[Kuyruk ${queueIndex}/${this.items.length}] Tamamlandı: ${nextItem.fileName} | MD5: ${result.md5}`
          );
          this.emitUpdate();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (this.pauseRequested || this.activeAbortController.signal.aborted) {
            nextItem.status = 'paused';
            nextItem.errorMessage = 'Duraklatıldı (fsync checkpoint kaydedildi)';
            this.log(`[Kuyruk Duraklatıldı] ${nextItem.fileName} güvenli şekilde duraklatıldı.`);
            this.emitUpdate();
            break;
          } else {
            nextItem.status = 'error';
            nextItem.errorMessage = message;
            this.log(`[Kuyruk Hatası] ${nextItem.fileName}: ${message} (Sıradaki dosyaya geçiliyor...)`);
            this.emitUpdate();
          }
        } finally {
          this.activeAbortController = null;
        }
      }
    } finally {
      this.activeItemId = null;
      this.isProcessing = false;
      this.emitUpdate();
    }
  }

  public async pauseQueue(): Promise<void> {
    this.pauseRequested = true;
    if (this.activeAbortController) {
      this.activeAbortController.abort(new Error('Kullanıcı tarafından duraklatıldı.'));
    }
  }

  public async removeItem(id: string, deleteFilesOnDisk = false): Promise<void> {
    const idx = this.items.findIndex((x) => x.id === id);
    if (idx === -1) return;

    const item = this.items[idx];
    if (item.status === 'downloading') return; // Aktif inen dosya silinemez, önce duraklatılmalı

    if (deleteFilesOnDisk) {
      const metaPath = `${item.targetPath}.meta.json`;
      if (fs.existsSync(metaPath)) await fsp.unlink(metaPath).catch(() => {});
      if (fs.existsSync(item.targetPath)) await fsp.unlink(item.targetPath).catch(() => {});
    }

    this.items.splice(idx, 1);
    this.emitUpdate();
  }

  public async clearCompleted(): Promise<void> {
    this.items = this.items.filter((x) => x.status !== 'completed');
    this.emitUpdate();
  }

  public async resetAll(deleteFilesOnDisk = false): Promise<void> {
    if (this.isProcessing) {
      await this.pauseQueue();
    }
    if (deleteFilesOnDisk) {
      for (const item of this.items) {
        const metaPath = `${item.targetPath}.meta.json`;
        if (fs.existsSync(metaPath)) await fsp.unlink(metaPath).catch(() => {});
        if (fs.existsSync(item.targetPath)) await fsp.unlink(item.targetPath).catch(() => {});
      }
    }
    this.items = [];
    this.emitUpdate();
  }
}
