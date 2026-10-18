import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createMD5 } from 'hash-wasm';
import { ResumableDownloadQueue, type QueueItemInput } from './resumableDownloadQueue';

let mainWindow: BrowserWindow | null = null;
let downloadQueue: ResumableDownloadQueue | null = null;

interface SyntheticTestFile {
  name: string;
  sizeMB: number;
  seed: number;
  md5: string;
}

let testServerPort = 0;
const syntheticFiles: SyntheticTestFile[] = [
  { name: 'dataset-part-01.bin', sizeMB: 48, seed: 17, md5: '' },
  { name: 'dataset-part-02.bin', sizeMB: 64, seed: 53, md5: '' },
  { name: 'dataset-part-03.bin', sizeMB: 48, seed: 89, md5: '' }
];

async function ensureLocalTestServer(): Promise<{
  files: Array<{ url: string; fileName: string; expectedMd5: string; sizeMB: number }>;
  defaultFolder: string;
}> {
  const defaultFolder = path.join(os.homedir(), 'Downloads');

  if (testServerPort > 0) {
    return {
      files: syntheticFiles.map((f) => ({
        url: `http://127.0.0.1:${testServerPort}/${f.name}`,
        fileName: f.name,
        expectedMd5: f.md5,
        sizeMB: f.sizeMB
      })),
      defaultFolder
    };
  }

  // Her sentetik dosya için 1 MB'lık deterministik blok üzerinden gerçek MD5 özetini hesapla
  for (const fileSpec of syntheticFiles) {
    const block1MB = Buffer.allocUnsafe(1024 * 1024);
    for (let i = 0; i < block1MB.length; i++) {
      block1MB[i] = (i * 31 + fileSpec.seed) & 0xff;
    }

    const hasher = await createMD5();
    hasher.init();
    for (let m = 0; m < fileSpec.sizeMB; m++) {
      hasher.update(block1MB);
    }
    fileSpec.md5 = hasher.digest('hex');
  }

  const server = http.createServer((req, res) => {
    const reqPath = (req.url || '/').split('?')[0].replace(/^\//, '');
    const spec = syntheticFiles.find((f) => f.name === reqPath) || syntheticFiles[0];
    const totalSize = spec.sizeMB * 1024 * 1024;
    const etag = `"synthetic-${spec.name}-${spec.md5.slice(0, 10)}"`;

    const rangeHeader = req.headers.range;
    let start = 0;
    let end = totalSize - 1;
    let statusCode = 200;

    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const parts = rangeHeader.replace('bytes=', '').split('-');
      start = parseInt(parts[0], 10);
      if (parts[1] && parts[1].length > 0) {
        end = Math.min(totalSize - 1, parseInt(parts[1], 10));
      }
      statusCode = 206;
    }

    const contentLength = end - start + 1;
    const headers: Record<string, string | number> = {
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
      'Content-Length': contentLength,
      ETag: etag
    };

    if (statusCode === 206) {
      headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
    }

    res.writeHead(statusCode, headers);

    let currentOffset = start;
    const chunkStep = 256 * 1024; // 256 KB dilimler

    const timer = setInterval(() => {
      if (res.destroyed || currentOffset > end) {
        clearInterval(timer);
        if (!res.destroyed) res.end();
        return;
      }

      const remaining = end - currentOffset + 1;
      const sendLen = Math.min(chunkStep, remaining);
      const outBuf = Buffer.allocUnsafe(sendLen);

      for (let i = 0; i < sendLen; i++) {
        outBuf[i] = ((currentOffset + i) * 31 + spec.seed) & 0xff;
      }

      currentOffset += sendLen;
      res.write(outBuf);

      if (currentOffset > end) {
        clearInterval(timer);
        res.end();
      }
    }, 28);

    req.on('close', () => clearInterval(timer));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  testServerPort = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    files: syntheticFiles.map((f) => ({
      url: `http://127.0.0.1:${testServerPort}/${f.name}`,
      fileName: f.name,
      expectedMd5: f.md5,
      sizeMB: f.sizeMB
    })),
    defaultFolder
  };
}

function initQueueManager(): ResumableDownloadQueue {
  if (downloadQueue) return downloadQueue;

  let speedWindowStartMs = Date.now();
  let speedWindowStartBytes: number | null = null;
  let lastTrackedItemId: string | null = null;
  let currentSpeedBps = 0;

  downloadQueue = new ResumableDownloadQueue({
    targetFolder: path.join(os.homedir(), 'Downloads'),
    concurrency: 4,
    chunkSizeBytes: 4 * 1024 * 1024,
    saveIntervalBytes: 16 * 1024 * 1024,
    onLog: (msg) => {
      mainWindow?.webContents.send('download:log', msg);
    },
    onQueueUpdated: (items, activeItemId) => {
      if (activeItemId !== lastTrackedItemId) {
        lastTrackedItemId = activeItemId;
        speedWindowStartBytes = null;
        currentSpeedBps = 0;
      }
      mainWindow?.webContents.send('queue:updated', {
        items,
        activeItemId,
        isRunning: downloadQueue?.isRunning() ?? false
      });
    },
    onActiveProgress: (item, prog) => {
      const now = Date.now();
      if (speedWindowStartBytes === null) {
        speedWindowStartBytes = prog.downloadedBytes;
        speedWindowStartMs = now;
      } else {
        const elapsedSec = (now - speedWindowStartMs) / 1000;
        if (elapsedSec >= 0.35) {
          const deltaBytes = Math.max(0, prog.downloadedBytes - speedWindowStartBytes);
          const instantSpeed = deltaBytes / elapsedSec;
          currentSpeedBps =
            currentSpeedBps === 0 ? instantSpeed : currentSpeedBps * 0.65 + instantSpeed * 0.35;
          speedWindowStartBytes = prog.downloadedBytes;
          speedWindowStartMs = now;
        }
      }

      const remainingBytes = Math.max(0, prog.totalBytes - prog.downloadedBytes);
      const etaSeconds =
        currentSpeedBps > 0 && prog.totalBytes > 0 ? Math.ceil(remainingBytes / currentSpeedBps) : null;

      mainWindow?.webContents.send('download:progress', {
        item,
        ...prog,
        speedBps: currentSpeedBps,
        etaSeconds
      });
    }
  });

  return downloadQueue;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    frame: false,
    show: true,
    backgroundColor: '#0A0B0E',
    title: 'Resumable MD5 Downloader',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    mainWindow.hide();
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => {
      mainWindow?.setAlwaysOnTop(false);
    }, 500);
    console.log('[Electron] Resumable MD5 Downloader penceresi açıldı.');
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
}

app.setPath('userData', path.join(os.tmpdir(), 'resumable-md5-downloader-data'));

app.whenReady().then(() => {
  initQueueManager();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Pencere Kontrolleri
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

// Hedef Klasör Seçici
ipcMain.handle('download:pick-folder', async (_event, currentFolder: string) => {
  if (!mainWindow) return null;
  const defaultPath = currentFolder || path.join(os.homedir(), 'Downloads');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'İndirilecek Hedef Klasörü Seçin (USB Disk veya Yerel Klasör)',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Klasörü Seç'
  });

  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

// Klasörde Göster
ipcMain.handle('download:open-folder', async (_event, targetPath: string) => {
  if (!targetPath) return;
  const resolved = path.resolve(targetPath);
  if (fs.existsSync(resolved)) {
    const stat = await fsp.stat(resolved).catch(() => null);
    if (stat?.isDirectory()) {
      await shell.openPath(resolved);
    } else {
      shell.showItemInFolder(resolved);
    }
  } else {
    const dir = path.dirname(resolved);
    if (fs.existsSync(dir)) {
      await shell.openPath(dir);
    }
  }
});

// meta.json ve Disk Durumunu İncele
ipcMain.handle('download:inspect-meta', async (_event, targetPath: string) => {
  if (!targetPath) return { exists: false };
  const resolved = path.resolve(targetPath);
  const metaPath = `${resolved}.meta.json`;

  let fileSizeOnDisk = 0;
  if (fs.existsSync(resolved)) {
    try {
      const st = await fsp.stat(resolved);
      fileSizeOnDisk = st.size;
    } catch {
      fileSizeOnDisk = 0;
    }
  }

  if (!fs.existsSync(metaPath)) {
    return {
      exists: false,
      fileExists: fs.existsSync(resolved),
      fileSizeOnDisk,
      metaPath
    };
  }

  try {
    const raw = await fsp.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      exists: true,
      fileExists: fs.existsSync(resolved),
      fileSizeOnDisk,
      metaPath,
      meta: parsed,
      rawJson: raw
    };
  } catch {
    return { exists: false, fileExists: fs.existsSync(resolved), fileSizeOnDisk, metaPath };
  }
});

// Yerel 3'lü Test Kuyruğu Bilgisi
ipcMain.handle('download:get-test-batch', async () => {
  return ensureLocalTestServer();
});

// Kuyruk Yönetimi IPC İşleyicileri
ipcMain.handle('queue:get-state', () => {
  const q = initQueueManager();
  return {
    items: q.getItems(),
    isRunning: q.isRunning()
  };
});

ipcMain.handle(
  'queue:enqueue',
  async (
    _event,
    payload: {
      items: QueueItemInput[];
      targetFolder: string;
      concurrency: number;
      chunkSizeMB: number;
      saveIntervalMB: number;
    }
  ) => {
    const q = initQueueManager();
    q.updateSettings({
      targetFolder: payload.targetFolder,
      concurrency: payload.concurrency,
      chunkSizeBytes: payload.chunkSizeMB * 1024 * 1024,
      saveIntervalBytes: payload.saveIntervalMB * 1024 * 1024
    });
    const added = await q.enqueueMany(payload.items);
    return {
      addedCount: added.length,
      items: q.getItems()
    };
  }
);

ipcMain.handle(
  'queue:start',
  async (
    _event,
    payload: {
      items: QueueItemInput[];
      targetFolder: string;
      concurrency: number;
      chunkSizeMB: number;
      saveIntervalMB: number;
    }
  ) => {
    const q = initQueueManager();
    q.updateSettings({
      targetFolder: payload.targetFolder,
      concurrency: payload.concurrency,
      chunkSizeBytes: payload.chunkSizeMB * 1024 * 1024,
      saveIntervalBytes: payload.saveIntervalMB * 1024 * 1024
    });

    if (payload.items && payload.items.length > 0) {
      await q.enqueueMany(payload.items);
    }

    // Kuyruğu arka planda sırayla çalıştır
    void q.startQueue();
    return {
      started: true,
      items: q.getItems()
    };
  }
);

ipcMain.handle('queue:pause', async () => {
  const q = initQueueManager();
  await q.pauseQueue();
  return true;
});

ipcMain.handle('queue:remove-item', async (_event, id: string, deleteFiles: boolean) => {
  const q = initQueueManager();
  await q.removeItem(id, deleteFiles);
  return q.getItems();
});

ipcMain.handle('queue:clear-completed', async () => {
  const q = initQueueManager();
  await q.clearCompleted();
  return q.getItems();
});

ipcMain.handle('queue:reset-all', async (_event, deleteFiles: boolean) => {
  const q = initQueueManager();
  await q.resetAll(deleteFiles);
  return q.getItems();
});
