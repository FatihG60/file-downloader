const inputUrls = document.getElementById('inputUrls');
const inputTargetFolder = document.getElementById('inputTargetFolder');
const inputExpectedMd5 = document.getElementById('inputExpectedMd5');
const selectConcurrency = document.getElementById('selectConcurrency');
const selectChunkSize = document.getElementById('selectChunkSize');
const selectSaveInterval = document.getElementById('selectSaveInterval');

const btnLoadTestBatch = document.getElementById('btnLoadTestBatch');
const btnBrowseFolder = document.getElementById('btnBrowseFolder');
const btnOpenFolder = document.getElementById('btnOpenFolder');
const btnAddQueue = document.getElementById('btnAddQueue');
const btnPause = document.getElementById('btnPause');
const btnStart = document.getElementById('btnStart');
const btnStartLabel = document.getElementById('btnStartLabel');
const btnClearCompleted = document.getElementById('btnClearCompleted');
const btnResetQueue = document.getElementById('btnResetQueue');

const headerContextLabel = document.getElementById('headerContextLabel');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const activeFileBadge = document.getElementById('activeFileBadge');
const bytesProgressText = document.getElementById('bytesProgressText');
const percentText = document.getElementById('percentText');
const progressBarWritten = document.getElementById('progressBarWritten');
const progressBarSynced = document.getElementById('progressBarSynced');
const syncedBytesLabel = document.getElementById('syncedBytesLabel');

const metricSpeed = document.getElementById('metricSpeed');
const metricEta = document.getElementById('metricEta');
const metricQueueSummary = document.getElementById('metricQueueSummary');
const metricWorkers = document.getElementById('metricWorkers');
const metricRamChunks = document.getElementById('metricRamChunks');
const metricMd5Status = document.getElementById('metricMd5Status');

const queueCountTabLabel = document.getElementById('queueCountTabLabel');
const queueTableBody = document.getElementById('queueTableBody');
const logContainer = document.getElementById('logContainer');

const verifyFilePath = document.getElementById('verifyFilePath');
const verifyResumedFrom = document.getElementById('verifyResumedFrom');
const verifyTotalBytes = document.getElementById('verifyTotalBytes');
const verifyCalculatedMd5 = document.getElementById('verifyCalculatedMd5');
const verifyExpectedMd5 = document.getElementById('verifyExpectedMd5');
const verifyFinalResult = document.getElementById('verifyFinalResult');
const metaJsonViewer = document.getElementById('metaJsonViewer');

let currentQueueItems = [];
let selectedItemId = null;

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

/**
 * Çok satırlı textarea içindeki URL ve opsiyonel '| md5' çiftlerini ayrıştırır.
 */
function parseUrlLines() {
  const rawLines = inputUrls.value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const singleFallbackMd5 = inputExpectedMd5.value.trim();

  return rawLines.map((line) => {
    const parts = line.split('|').map((p) => p.trim());
    const url = parts[0];
    const inlineMd5 = parts[1] || (rawLines.length === 1 ? singleFallbackMd5 : '');
    return {
      url,
      expectedMd5: inlineMd5 || undefined
    };
  });
}

async function inspectSelectedItem(item) {
  if (!item) return;

  verifyFilePath.textContent = item.targetPath;
  verifyResumedFrom.textContent =
    item.resumedFromBytes > 0
      ? `${formatBytes(item.resumedFromBytes)} (${item.resumedFromBytes.toLocaleString()} B)`
      : '0 B (Sıfırdan)';
  verifyTotalBytes.textContent =
    item.totalBytes > 0 ? `${formatBytes(item.totalBytes)} (${item.totalBytes.toLocaleString()} B)` : '—';
  verifyCalculatedMd5.textContent = item.calculatedMd5 || (item.status === 'downloading' ? 'Akışta hesaplanıyor...' : '—');
  verifyExpectedMd5.textContent = item.expectedMd5 || '(Belirtilmedi)';

  if (item.status === 'completed') {
    verifyFinalResult.textContent = item.expectedMd5
      ? 'BAŞARILI — Sunucu MD5 özeti ile birebir eşleşti.'
      : 'TAMAMLANDI — Akış MD5 özeti başarıyla üretildi.';
  } else if (item.status === 'paused') {
    verifyFinalResult.textContent = 'DURAKLATILDI — Ara MD5 durumu .meta.json dosyasında korunuyor.';
  } else if (item.status === 'error') {
    verifyFinalResult.textContent = `HATA: ${item.errorMessage || 'Bilinmeyen hata'}`;
  } else {
    verifyFinalResult.textContent = 'Beklemede / İndiriliyor';
  }

  const metaInfo = await window.downloaderApi.inspectMeta(item.targetPath);
  if (metaInfo.exists && metaInfo.rawJson) {
    metaJsonViewer.textContent = metaInfo.rawJson;
  } else if (metaInfo.fileExists) {
    metaJsonViewer.textContent = `Dosya diskte mevcut (${formatBytes(metaInfo.fileSizeOnDisk)}), aktif .meta.json bulunmuyor (İndirme tamamlandığında .meta.json otomatik temizlenir).`;
  } else {
    metaJsonViewer.textContent = 'Bu dosya için henüz diskte .meta.json oluşturulmadı.';
  }
}

function renderQueueTable(items, activeItemId, isRunning) {
  currentQueueItems = items;
  queueCountTabLabel.textContent = String(items.length);

  const completedCount = items.filter((x) => x.status === 'completed').length;
  const pausedOrPendingCount = items.filter((x) => x.status === 'queued' || x.status === 'paused' || x.status === 'error').length;
  metricQueueSummary.textContent = `${completedCount} / ${items.length} Tamamlandı`;

  btnStart.disabled = isRunning;
  btnPause.disabled = !isRunning;

  if (isRunning) {
    const activeIdx = items.findIndex((x) => x.id === activeItemId);
    const activeItem = items[activeIdx];
    setStatusBadge('active', 'Sıralı Kuyruk İndiriliyor');
    if (activeItem) {
      activeFileBadge.textContent = `Dosya ${activeIdx + 1}/${items.length}: ${activeItem.fileName}`;
      headerContextLabel.textContent = `[${activeIdx + 1}/${items.length}] ${activeItem.fileName}`;
    }
  } else {
    metricSpeed.textContent = '0.00 MB/sn';
    metricEta.textContent = '—';
    metricWorkers.textContent = '0';
    metricRamChunks.textContent = '0 Parça';

    if (items.length > 0 && completedCount === items.length) {
      setStatusBadge('ok', 'Tüm Kuyruk Tamamlandı');
      activeFileBadge.textContent = `${items.length} Dosya Tamamlandı`;
      headerContextLabel.textContent = 'Tüm Kuyruk Tamamlandı';
      btnStartLabel.textContent = 'Kuyruğu Sırayla Başlat';
    } else if (items.some((x) => x.status === 'paused')) {
      setStatusBadge('warn', 'Kuyruk Duraklatıldı (fsync Checkpoint Hazır)');
      btnStartLabel.textContent = 'Kaldığı Yerden Devam Et';
    } else if (pausedOrPendingCount > 0) {
      setStatusBadge('idle', `Kuyrukta ${pausedOrPendingCount} Dosya Bekliyor`);
      btnStartLabel.textContent = 'Kuyruğu Sırayla Başlat';
    } else {
      setStatusBadge('idle', 'Beklemede');
      activeFileBadge.textContent = 'Aktif Dosya Yok';
      btnStartLabel.textContent = 'Kuyruğu Sırayla Başlat';
    }
  }

  queueTableBody.innerHTML = '';

  if (items.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    tr.innerHTML = '<td colspan="6">Kuyrukta henüz dosya yok. Yukarıdan birden fazla URL ekleyip sırayla başlatabilirsiniz.</td>';
    queueTableBody.appendChild(tr);
    return;
  }

  if (!selectedItemId || !items.some((x) => x.id === selectedItemId)) {
    selectedItemId = activeItemId || items[0].id;
  }

  items.forEach((item, idx) => {
    const tr = document.createElement('tr');
    if (item.id === selectedItemId) {
      tr.classList.add('selected-row');
    }

    const statusLabels = {
      queued: 'Sırada Bekliyor',
      downloading: 'İndiriliyor',
      paused: 'Duraklatıldı (fsync)',
      completed: 'Tamamlandı',
      error: 'Hata'
    };

    const pctText = item.percentage !== null ? `${item.percentage.toFixed(1)}%` : '0.0%';
    const sizeText =
      item.totalBytes > 0
        ? `${formatBytes(item.downloadedBytes)} / ${formatBytes(item.totalBytes)} (${pctText})`
        : formatBytes(item.downloadedBytes);

    let md5Display = '—';
    if (item.calculatedMd5) {
      md5Display = item.expectedMd5
        ? `Doğrulandı (${item.calculatedMd5.slice(0, 10)}…)`
        : item.calculatedMd5;
    } else if (item.expectedMd5) {
      md5Display = `Beklenen: ${item.expectedMd5.slice(0, 10)}…`;
    } else if (item.status === 'downloading') {
      md5Display = 'Akışta hesaplanıyor...';
    }

    tr.innerHTML = `
      <td class="col-idx">${idx + 1}</td>
      <td class="col-name">
        <div class="file-primary">${item.fileName}</div>
        <div class="file-sub-url" title="${item.url}">${item.url}</div>
      </td>
      <td class="col-status">
        <span class="q-status-pill q-${item.status}">
          <span class="q-dot"></span>
          <span>${statusLabels[item.status] || item.status}</span>
        </span>
      </td>
      <td class="col-size">${sizeText}</td>
      <td class="col-md5" title="${item.calculatedMd5 || item.expectedMd5 || ''}">${md5Display}</td>
      <td class="col-act">
        <button type="button" class="row-action-btn btn-open-item" data-path="${item.targetPath}">Klasör</button>
      </td>
    `;

    tr.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-open-item')) {
        window.downloaderApi.openInFolder(item.targetPath);
        return;
      }
      selectedItemId = item.id;
      document.querySelectorAll('#queueTableBody tr').forEach((r) => r.classList.remove('selected-row'));
      tr.classList.add('selected-row');
      inspectSelectedItem(item);
    });

    queueTableBody.appendChild(tr);
  });

  const sel = items.find((x) => x.id === selectedItemId);
  if (sel) {
    inspectSelectedItem(sel);
  }
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

// 3'lü Test Kuyruğu Yükle
btnLoadTestBatch.addEventListener('click', async () => {
  const batch = await window.downloaderApi.getTestBatch();
  if (!inputTargetFolder.value.trim()) {
    inputTargetFolder.value = batch.defaultFolder;
  }
  inputUrls.value = batch.files.map((f) => `${f.url} | ${f.expectedMd5}`).join('\n');
  appendLog(`[Test Paketi Hazır] 3 adet yerel dosya (${batch.files.map((f) => f.sizeMB + 'MB').join(' + ')}) URL kutusuna eklendi.`);
});

// Klasör Seç
btnBrowseFolder.addEventListener('click', async () => {
  const folder = await window.downloaderApi.pickTargetFolder(inputTargetFolder.value.trim());
  if (folder) {
    inputTargetFolder.value = folder;
  }
});

// Klasörü Aç
btnOpenFolder.addEventListener('click', () => {
  const folder = inputTargetFolder.value.trim();
  if (folder) window.downloaderApi.openInFolder(folder);
});

// Kuyruğa Ekle
btnAddQueue.addEventListener('click', async () => {
  const parsedItems = parseUrlLines();
  const targetFolder = inputTargetFolder.value.trim();
  if (parsedItems.length === 0) {
    appendLog('[Uyarı] Kuyruğa eklemek için en az 1 URL girin.');
    inputUrls.focus();
    return;
  }
  if (!targetFolder) {
    appendLog('[Uyarı] Lütfen hedef indirme klasörünü seçin.');
    inputTargetFolder.focus();
    return;
  }

  const res = await window.downloaderApi.enqueueItems({
    items: parsedItems,
    targetFolder,
    concurrency: parseInt(selectConcurrency.value, 10),
    chunkSizeMB: parseInt(selectChunkSize.value, 10),
    saveIntervalMB: parseInt(selectSaveInterval.value, 10)
  });

  inputUrls.value = '';
  inputExpectedMd5.value = '';
  appendLog(`[Kuyruk] ${res.addedCount} yeni dosya sıraya eklendi (Toplam: ${res.items.length}).`);
});

// Kuyruğu Sırayla Başlat / Devam Et
btnStart.addEventListener('click', async () => {
  const parsedItems = parseUrlLines();
  const targetFolder = inputTargetFolder.value.trim();

  if (!targetFolder) {
    appendLog('[Hata] Lütfen kaydedilecek hedef klasörü seçin.');
    inputTargetFolder.focus();
    return;
  }

  if (parsedItems.length === 0 && currentQueueItems.length === 0) {
    appendLog('[Hata] Lütfen en az bir indirme URL adresi girin.');
    inputUrls.focus();
    return;
  }

  inputUrls.value = '';
  inputExpectedMd5.value = '';

  await window.downloaderApi.startQueue({
    items: parsedItems,
    targetFolder,
    concurrency: parseInt(selectConcurrency.value, 10),
    chunkSizeMB: parseInt(selectChunkSize.value, 10),
    saveIntervalMB: parseInt(selectSaveInterval.value, 10)
  });
});

// Duraklat
btnPause.addEventListener('click', async () => {
  btnPause.disabled = true;
  setStatusBadge('warn', 'Duraklatılıyor (fsync)...');
  await window.downloaderApi.pauseQueue();
});

// Tamamlananları Temizle
btnClearCompleted.addEventListener('click', async () => {
  await window.downloaderApi.clearCompleted();
});

// Kuyruğu & Dosyaları Sıfırla
btnResetQueue.addEventListener('click', async () => {
  await window.downloaderApi.resetQueue(true);
  progressBarWritten.style.width = '0%';
  progressBarSynced.style.width = '0%';
  bytesProgressText.textContent = '0 B / 0 B';
  percentText.textContent = '0.00%';
  syncedBytesLabel.textContent = '0 B';
  metricMd5Status.textContent = 'Sıfırlandı';
  appendLog('[Sıfırlandı] Tüm kuyruk ve geçici .meta.json dosyaları temizlendi.');
});

// Kuyruk Güncelleme Dinleyicisi
window.downloaderApi.onQueueUpdated((state) => {
  renderQueueTable(state.items, state.activeItemId, state.isRunning);
});

// Aktif Dosya Canlı İlerleme Dinleyicisi
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
  metricWorkers.textContent = String(prog.activeWorkers);
  metricRamChunks.textContent = `${prog.bufferedChunksInRam} Parça`;
  metricMd5Status.textContent = `${prog.item.fileName} (Hesaplanıyor)`;

  // Tablodaki aktif satırın boyut/yüzde hücresini canlı güncelle
  const idx = currentQueueItems.findIndex((x) => x.id === prog.item.id);
  if (idx !== -1) {
    currentQueueItems[idx] = prog.item;
    const rows = queueTableBody.querySelectorAll('tr');
    if (rows[idx]) {
      const sizeCell = rows[idx].querySelector('.col-size');
      if (sizeCell) {
        const pctStr = prog.percentage !== null ? `${prog.percentage.toFixed(1)}%` : '0.0%';
        sizeCell.textContent = `${formatBytes(prog.downloadedBytes)} / ${formatBytes(prog.totalBytes)} (${pctStr})`;
      }
    }
  }
});

// Canlı Günlük Dinleyicisi
window.downloaderApi.onLog((msg) => {
  appendLog(msg);
});

// Açılışta 3'lü örnek test kuyruğunu hazırla
(async () => {
  const batch = await window.downloaderApi.getTestBatch();
  inputTargetFolder.value = batch.defaultFolder;
  inputUrls.value = batch.files.map((f) => `${f.url} | ${f.expectedMd5}`).join('\n');
  appendLog(
    `[Hazır] Çoklu URL sıralı indirme kuyruğu hazır. 3 adet test URL'i (${batch.files.map((f) => f.fileName).join(', ')}) yüklendi.`
  );
})();
