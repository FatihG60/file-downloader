/* global downloaderApi */

const inputUrl = document.getElementById('inputUrl');
const inputTarget = document.getElementById('inputTarget');
const inputExpectedMd5 = document.getElementById('inputExpectedMd5');
const selectConcurrency = document.getElementById('selectConcurrency');
const selectChunkSize = document.getElementById('selectChunkSize');
const selectSaveInterval = document.getElementById('selectSaveInterval');

const btnLoadTestUrl = document.getElementById('btnLoadTestUrl');
const btnBrowse = document.getElementById('btnBrowse');
const btnResetFiles = document.getElementById('btnResetFiles');
const btnOpenFolder = document.getElementById('btnOpenFolder');
const btnPause = document.getElementById('btnPause');
const btnStart = document.getElementById('btnStart');
const btnStartLabel = document.getElementById('btnStartLabel');

const headerContextLabel = document.getElementById('headerContextLabel');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const resumeBadge = document.getElementById('resumeBadge');
const bytesProgressText = document.getElementById('bytesProgressText');
const percentText = document.getElementById('percentText');
const progressBarWritten = document.getElementById('progressBarWritten');
const progressBarSynced = document.getElementById('progressBarSynced');
const syncedBytesLabel = document.getElementById('syncedBytesLabel');

const metricSpeed = document.getElementById('metricSpeed');
const metricEta = document.getElementById('metricEta');
const metricMode = document.getElementById('metricMode');
const metricWorkers = document.getElementById('metricWorkers');
const metricRamChunks = document.getElementById('metricRamChunks');
const metricMd5Status = document.getElementById('metricMd5Status');

const logContainer = document.getElementById('logContainer');
const verifyFilePath = document.getElementById('verifyFilePath');
const verifyResumedFrom = document.getElementById('verifyResumedFrom');
const verifyTotalBytes = document.getElementById('verifyTotalBytes');
const verifyCalculatedMd5 = document.getElementById('verifyCalculatedMd5');
const verifyExpectedMd5 = document.getElementById('verifyExpectedMd5');
const verifyFinalResult = document.getElementById('verifyFinalResult');
const metaJsonViewer = document.getElementById('metaJsonViewer');

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, idx);
  return `${val.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

function formatEta(seconds) {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds === 0) return '0 sn';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h} sa ${m} dk ${s} sn`;
  if (m > 0) return `${m} dk ${s} sn`;
  return `${s} sn`;
}

function appendLog(message) {
  const row = document.createElement('div');
  row.className = 'log-entry';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  const now = new Date();
  timeSpan.textContent = now.toTimeString().split(' ')[0];

  const msgSpan = document.createElement('span');
  msgSpan.className = 'log-msg';
  msgSpan.textContent = message;

  row.appendChild(timeSpan);
  row.appendChild(msgSpan);
  logContainer.appendChild(row);
  logContainer.parentElement.scrollTop = logContainer.parentElement.scrollHeight;
}

function setStatusBadge(state, label) {
  statusDot.className = `status-dot status-${state}`;
  statusText.textContent = label;
}

async function refreshMetaState() {
  const targetPath = inputTarget.value.trim();
  if (!targetPath) {
    resumeBadge.classList.add('hidden');
    btnStartLabel.textContent = 'İndirmeyi Başlat';
    metaJsonViewer.textContent = 'Hedef dosya yolu seçilmedi.';
    return;
  }

  const info = await window.downloaderApi.inspectMeta(targetPath);
  if (info.exists && info.meta && info.fileSizeOnDisk >= info.meta.downloadedBytes && info.meta.downloadedBytes > 0) {
    resumeBadge.classList.remove('hidden');
    const pct = info.meta.totalBytes > 0
      ? ((info.meta.downloadedBytes / info.meta.totalBytes) * 100).toFixed(2)
      : '?';
    resumeBadge.textContent = `Kurtarma Hazır: ${formatBytes(info.meta.downloadedBytes)} (%${pct})`;
    btnStartLabel.textContent = 'Kaldığı Yerden Devam Et';
    metaJsonViewer.textContent = info.rawJson;

    bytesProgressText.textContent = `${formatBytes(info.meta.downloadedBytes)} / ${formatBytes(info.meta.totalBytes || 0)}`;
    percentText.textContent = info.meta.totalBytes > 0 ? `${pct}%` : '—';
    const pctNum = info.meta.totalBytes > 0 ? (info.meta.downloadedBytes / info.meta.totalBytes) * 100 : 0;
    progressBarWritten.style.width = `${pctNum}%`;
    progressBarSynced.style.width = `${pctNum}%`;
    syncedBytesLabel.textContent = formatBytes(info.meta.downloadedBytes);
  } else {
    resumeBadge.classList.add('hidden');
    btnStartLabel.textContent = 'İndirmeyi Başlat';
    metaJsonViewer.textContent = info.fileExists
      ? `Dosya mevcut (${formatBytes(info.fileSizeOnDisk)}), aktif .meta.json bulunmuyor (Tamamlanmış veya sıfırlanmış).`
      : 'Henüz aktif bir .meta.json dosyası bulunmuyor.';
  }
}

function setControlsLocked(locked) {
  inputUrl.disabled = locked;
  inputTarget.disabled = locked;
  inputExpectedMd5.disabled = locked;
  selectConcurrency.disabled = locked;
  selectChunkSize.disabled = locked;
  selectSaveInterval.disabled = locked;
  btnBrowse.disabled = locked;
  btnLoadTestUrl.disabled = locked;
  btnResetFiles.disabled = locked;
  btnStart.disabled = locked;
  btnPause.disabled = !locked;
}

// Pencere Butonları
document.getElementById('btnMinimize').addEventListener('click', () => window.downloaderApi.windowMinimize());
document.getElementById('btnMaximize').addEventListener('click', () => window.downloaderApi.windowMaximize());
document.getElementById('btnClose').addEventListener('click', () => window.downloaderApi.windowClose());

// Sekme Geçişleri
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));

    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    const targetId = btn.getAttribute('data-tab');
    document.getElementById(targetId).classList.add('active');
  });
});

// Yerel 128 MB Test Sunucusu Yükleme
btnLoadTestUrl.addEventListener('click', async () => {
  const endpoint = await window.downloaderApi.getTestEndpoint();
  inputUrl.value = endpoint.url;
  if (!inputTarget.value.trim()) {
    inputTarget.value = endpoint.defaultTarget;
  }
  inputExpectedMd5.value = endpoint.expectedMd5;
  headerContextLabel.textContent = 'synthetic-test-128mb.bin';
  appendLog(`[Test Sunucusu Hazır] URL: ${endpoint.url} | Beklenen MD5: ${endpoint.expectedMd5}`);
  await refreshMetaState();
});

// Gözat
btnBrowse.addEventListener('click', async () => {
  const chosen = await window.downloaderApi.pickTargetFile(inputUrl.value.trim(), inputTarget.value.trim());
  if (chosen) {
    inputTarget.value = chosen;
    headerContextLabel.textContent = chosen.split(/[\\/]/).pop() || 'Hazır';
    await refreshMetaState();
  }
});

inputTarget.addEventListener('change', () => refreshMetaState());
inputTarget.addEventListener('blur', () => refreshMetaState());

// Klasörde Göster
btnOpenFolder.addEventListener('click', () => {
  const target = inputTarget.value.trim();
  if (target) window.downloaderApi.openInFolder(target);
});

// Sıfırla
btnResetFiles.addEventListener('click', async () => {
  const target = inputTarget.value.trim();
  if (!target) return;
  await window.downloaderApi.resetProgressFiles(target);
  progressBarWritten.style.width = '0%';
  progressBarSynced.style.width = '0%';
  bytesProgressText.textContent = '0 B / 0 B';
  percentText.textContent = '0.00%';
  syncedBytesLabel.textContent = '0 B';
  metricSpeed.textContent = '0.00 MB/sn';
  metricEta.textContent = '—';
  metricMd5Status.textContent = 'Sıfırlandı';
  setStatusBadge('idle', 'Sıfırlandı');
  appendLog('[Sıfırlandı] Hedef dosya ve .meta.json temizlendi.');
  await refreshMetaState();
});

// Duraklat
btnPause.addEventListener('click', async () => {
  btnPause.disabled = true;
  setStatusBadge('warn', 'Duraklatılıyor (fsync)...');
  await window.downloaderApi.pauseDownload();
});

// İndirmeyi Başlat / Devam Et
btnStart.addEventListener('click', async () => {
  const url = inputUrl.value.trim();
  const targetPath = inputTarget.value.trim();
  const expectedMd5 = inputExpectedMd5.value.trim();

  if (!url) {
    appendLog('[Hata] Lütfen geçerli bir indirme URL adresi girin.');
    inputUrl.focus();
    return;
  }
  if (!targetPath) {
    appendLog('[Hata] Lütfen kaydedilecek hedef dosya yolunu seçin.');
    inputTarget.focus();
    return;
  }

  setControlsLocked(true);
  setStatusBadge('active', 'İndiriliyor & MD5 Hesaplanıyor...');
  metricMd5Status.textContent = 'Akışta Hesaplanıyor';
  headerContextLabel.textContent = targetPath.split(/[\\/]/).pop() || 'İndiriliyor';

  verifyFilePath.textContent = targetPath;
  verifyExpectedMd5.textContent = expectedMd5 || '(Belirtilmedi)';
  verifyCalculatedMd5.textContent = 'Hesaplanıyor...';
  verifyFinalResult.textContent = 'İndirme sürüyor...';

  const response = await window.downloaderApi.startDownload({
    url,
    targetPath,
    expectedMd5: expectedMd5 || undefined,
    concurrency: parseInt(selectConcurrency.value, 10),
    chunkSizeMB: parseInt(selectChunkSize.value, 10),
    saveIntervalMB: parseInt(selectSaveInterval.value, 10)
  });

  setControlsLocked(false);
  metricSpeed.textContent = '0.00 MB/sn';
  metricEta.textContent = '—';
  metricWorkers.textContent = '0';
  metricRamChunks.textContent = '0 Parça';

  if (response.status === 'completed') {
    const res = response.result;
    setStatusBadge('ok', 'Tamamlandı & Doğrulandı');
    metricMd5Status.textContent = expectedMd5 ? 'Eşleşti (Doğrulandı)' : res.md5.slice(0, 12) + '…';

    verifyResumedFrom.textContent = res.resumedFromBytes > 0
      ? `${formatBytes(res.resumedFromBytes)} (${res.resumedFromBytes.toLocaleString()} B)`
      : '0 B (Sıfırdan)';
    verifyTotalBytes.textContent = `${formatBytes(res.bytes)} (${res.bytes.toLocaleString()} B)`;
    verifyCalculatedMd5.textContent = res.md5;
    verifyFinalResult.textContent = expectedMd5
      ? 'BAŞARILI — Sunucu MD5 özeti ile birebir eşleşti.'
      : 'TAMAMLANDI — Akış MD5 özeti başarıyla üretildi.';
  } else if (response.status === 'paused') {
    setStatusBadge('warn', 'Duraklatıldı (Checkpoint Kaydedildi)');
    metricMd5Status.textContent = 'State Kaydedildi (.meta.json)';
  } else {
    setStatusBadge('err', 'Hata Oluştu');
    metricMd5Status.textContent = 'Kesildi / Hata';
    verifyFinalResult.textContent = `HATA: ${response.message}`;
    appendLog(`[Hata] ${response.message}`);
  }

  await refreshMetaState();
});

// Canlı İlerleme Dinleyicisi
window.downloaderApi.onProgress((prog) => {
  const pct = prog.percentage ?? 0;
  const syncedPct = prog.totalBytes > 0 ? (prog.lastSyncedBytes / prog.totalBytes) * 100 : 0;

  progressBarWritten.style.width = `${Math.min(100, pct)}%`;
  progressBarSynced.style.width = `${Math.min(100, syncedPct)}%`;

  bytesProgressText.textContent = `${formatBytes(prog.downloadedBytes)} / ${prog.totalBytes > 0 ? formatBytes(prog.totalBytes) : '?'}`;
  percentText.textContent = prog.percentage !== null ? `${prog.percentage.toFixed(2)}%` : '—';
  syncedBytesLabel.textContent = formatBytes(prog.lastSyncedBytes);

  const speedMB = (prog.speedBps || 0) / (1024 * 1024);
  metricSpeed.textContent = `${speedMB.toFixed(2)} MB/sn`;
  metricEta.textContent = formatEta(prog.etaSeconds);
  metricMode.textContent = prog.mode === 'sliding-window-multi' ? 'Sliding-Window' : 'Single-Stream';
  metricWorkers.textContent = String(prog.activeWorkers);
  metricRamChunks.textContent = `${prog.bufferedChunksInRam} Parça`;
});

// Canlı Günlük Dinleyicisi
window.downloaderApi.onLog((msg) => {
  appendLog(msg);
  if (msg.includes('Checkpoint') || msg.includes('Kurtarma')) {
    refreshMetaState();
  }
});

// Başlangıçta varsayılan olarak yerel 128 MB test akışını hazırla
(async () => {
  const endpoint = await window.downloaderApi.getTestEndpoint();
  inputUrl.value = endpoint.url;
  inputTarget.value = endpoint.defaultTarget;
  inputExpectedMd5.value = endpoint.expectedMd5;
  headerContextLabel.textContent = 'synthetic-test-128mb.bin';
  appendLog(`[Hazır] Yerel 128 MB Range + MD5 test akışı yüklendi (${endpoint.url}). İsterseniz kendi URL'inizi girebilirsiniz.`);
  await refreshMetaState();
})();
