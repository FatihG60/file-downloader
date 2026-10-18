import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createMD5 } from 'hash-wasm';
import { ResumableDownloader } from './resumableDownloader';

let mainWindow: BrowserWindow | null = null;
let activeAbortController: AbortController | null = null;
let isDownloading = false;

// Yerel Sentetik Test Sunucusu (128 MB deterministik veri, HTTP 206 Range + ETag destekli)
let testServerUrl = '';
let testServerMd5 = '';
const TEST_FILE_SIZE = 128 * 1024 * 1024; // 128 MB

async function startLocalTestServer(): Promise<{ url: string; expectedMd5: string; defaultTarget: string }> {
  if (testServerUrl) {
    return {
      url: testServerUrl,
      expectedMd5: testServerMd5,
      defaultTarget: path.join(os.homedir(), 'Downloads', 'synthetic-test-128mb.bin')
    };
  }

  // 1 MB'lık deterministik desen bloğu oluştur ve 128 kez tekrarlandığındaki MD5'ini hesapla
  const block1MB = Buffer.allocUnsafe(1024 * 1024);
  for (let i = 0; i < block1MB.length; i++) {
    block1MB[i] = (i * 31 + 17) & 0xff;
  }

  const hasher = await createMD5();
  hasher.init();
  for (let m = 0; m < 128; m++) {
    hasher.update(block1MB);
  }
  testServerMd5 = hasher.digest('hex');

  const server = http.createServer((req, res) => {
    const etag = `"synthetic-128mb-${testServerMd5.slice(0, 12)}"`;
    const rangeHeader = req.headers.range;

    let start = 0;
    let end = TEST_FILE_SIZE - 1;
    let statusCode = 200;

    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const parts = rangeHeader.replace('bytes=', '').split('-');
      start = parseInt(parts[0], 10);
      if (parts[1] && parts[1].length > 0) {
        end = Math.min(TEST_FILE_SIZE - 1, parseInt(parts[1], 10));
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
      headers['Content-Range'] = `bytes ${start}-${end}/${TEST_FILE_SIZE}`;
    }

    res.writeHead(statusCode, headers);

    // İlerlemeyi ve Duraklat/Devam Et özelliğini rahatça gözlemlemek için kontrollü akış (~24 MB/s toplam)
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
        outBuf[i] = ((currentOffset + i) * 31 + 17) & 0xff;
      }

      currentOffset += sendLen;
      res.write(outBuf);

      if (currentOffset > end) {
        clearInterval(timer);
        res.end();
      }
    }, 35);

    req.on('close', () => clearInterval(timer));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  testServerUrl = `http://127.0.0.1:${port}/synthetic-test-128mb.bin`;

  return {
    url: testServerUrl,
    expectedMd5: testServerMd5,
    defaultTarget: path.join(os.homedir(), 'Downloads', 'synthetic-test-128mb.bin')
  };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 920,
    minHeight: 660,
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
    // Win32 STARTUPINFO SW_HIDE ilk ShowWindow çağrısını ezdiği için ikinci kez çağrılır
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

// Hedef Dosya Seçici
ipcMain.handle('download:pick-target', async (_event, defaultUrl: string, currentPath: string) => {
  if (!mainWindow) return null;

  let suggestedName = 'large-download.bin';
  try {
    if (defaultUrl) {
      const parsed = new URL(defaultUrl);
      const base = path.basename(parsed.pathname);
      if (base && base !== '/') suggestedName = decodeURIComponent(base);
    }
  } catch {
    // URL geçersizse varsayılan isim
  }

  const defaultPath = currentPath || path.join(os.homedir(), 'Downloads', suggestedName);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'İndirilecek Hedef Dosyayı Seçin',
    defaultPath,
    buttonLabel: 'Hedef Olarak Seç'
  });

  return result.canceled ? null : result.filePath;
});

// Klasörde Göster
ipcMain.handle('download:open-folder', async (_event, targetPath: string) => {
  if (!targetPath) return;
  const resolved = path.resolve(targetPath);
  if (fs.existsSync(resolved)) {
    shell.showItemInFolder(resolved);
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

// İndirme + Meta Dosyalarını Sıfırla
ipcMain.handle('download:reset-files', async (_event, targetPath: string) => {
  if (isDownloading || !targetPath) return false;
  const resolved = path.resolve(targetPath);
  const metaPath = `${resolved}.meta.json`;
  if (fs.existsSync(metaPath)) await fsp.unlink(metaPath).catch(() => {});
  if (fs.existsSync(resolved)) await fsp.unlink(resolved).catch(() => {});
  return true;
});

// Yerel Sentetik Test Sunucusu Bilgisi
ipcMain.handle('download:get-test-endpoint', async () => {
  return startLocalTestServer();
});

// İndirmeyi Duraklat
ipcMain.handle('download:pause', async () => {
  if (activeAbortController) {
    activeAbortController.abort(new Error('Kullanıcı tarafından duraklatıldı.'));
    return true;
  }
  return false;
});

// İndirmeyi Başlat / Kaldığı Yerden Devam Et
ipcMain.handle(
  'download:start',
  async (
    _event,
    payload: {
      url: string;
      targetPath: string;
      expectedMd5?: string;
      concurrency: number;
      chunkSizeMB: number;
      saveIntervalMB: number;
    }
  ) => {
    if (isDownloading) {
      throw new Error('Halihazırda devam eden bir indirme işlemi var.');
    }

    isDownloading = true;
    activeAbortController = new AbortController();

    const startTime = Date.now();
    let speedWindowStartMs = startTime;
    let speedWindowStartBytes: number | null = null;
    let currentSpeedBps = 0;

    const downloader = new ResumableDownloader({
      url: payload.url,
      targetPath: payload.targetPath,
      expectedMd5: payload.expectedMd5,
      concurrency: payload.concurrency,
      chunkSizeBytes: payload.chunkSizeMB * 1024 * 1024,
      saveIntervalBytes: payload.saveIntervalMB * 1024 * 1024,
      signal: activeAbortController.signal,
      onLog: (msg) => {
        mainWindow?.webContents.send('download:log', msg);
      },
      onProgress: (prog) => {
        const now = Date.now();
        if (speedWindowStartBytes === null) {
          speedWindowStartBytes = prog.downloadedBytes;
          speedWindowStartMs = now;
        } else {
          const elapsedSec = (now - speedWindowStartMs) / 1000;
          if (elapsedSec >= 0.4) {
            const deltaBytes = Math.max(0, prog.downloadedBytes - speedWindowStartBytes);
            const instantSpeed = deltaBytes / elapsedSec;
            currentSpeedBps = currentSpeedBps === 0 ? instantSpeed : currentSpeedBps * 0.65 + instantSpeed * 0.35;
            speedWindowStartBytes = prog.downloadedBytes;
            speedWindowStartMs = now;
          }
        }

        const remainingBytes = Math.max(0, prog.totalBytes - prog.downloadedBytes);
        const etaSeconds = currentSpeedBps > 0 && prog.totalBytes > 0 ? Math.ceil(remainingBytes / currentSpeedBps) : null;

        mainWindow?.webContents.send('download:progress', {
          ...prog,
          speedBps: currentSpeedBps,
          etaSeconds
        });
      }
    });

    try {
      const result = await downloader.download();
      return {
        status: 'completed' as const,
        result
      };
    } catch (err) {
      const isPaused = activeAbortController.signal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: isPaused ? ('paused' as const) : ('error' as const),
        message
      };
    } finally {
      isDownloading = false;
      activeAbortController = null;
    }
  }
);
