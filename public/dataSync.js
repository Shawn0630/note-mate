// Browser iCloud sync — the Finance Mate browser-sync pattern, adapted
// to Note Mate's full-data ZIP export.
//
// Sync runs in the browser via the File System Access API (Chrome / Edge
// on desktop — Safari and Firefox have no folder picker, so they get
// manual Export / Import only). The user picks a folder once (e.g. in
// iCloud Drive); the directory handle persists in IndexedDB and the page
// reads/writes the export archive in that folder while it is open. No
// Docker bind-mount is needed: the folder lives on the user's Mac and
// iCloud syncs it; this app never sees the Mac's filesystem, only the
// folder the user picked.
//
// Same machinery as the manual export/import, reused, not reimplemented:
// an upload fetches GET /api/admin/data/export and writes that ZIP to the
// folder; a download reads the folder's ZIP and POSTs it to
// /api/admin/data/import (same validation, slug collisions skipped,
// last-write-wins by exported_at, loop prevention by content hash).
// The folder holds two files: the ZIP (the data) and a small JSON
// sidecar (exported_at + sha256) that the check reads to decide whether
// a download is needed without reading the whole archive. Every event
// is also logged to the server sync log so Admin shows it after reload.
// The ZIP is written before the sidecar, so a half-finished upload can
// never look like a newer valid sync: the check verifies the ZIP's hash
// against the sidecar before importing.
//
// This module touches browser globals only inside functions, so its pure
// helpers (parseSyncSidecar, decideSyncCheck, sha256Hex) are unit-tested
// from node.
export const SYNC_FILE_NAME = 'note-mate-export.zip';
export const SYNC_SIDECAR_NAME = 'note-mate-export.json';
export const SYNC_POLL_MS = 5 * 60 * 1000;
export const SYNC_DEBOUNCE_MS = 60 * 1000;
export const SYNC_STATE_KEY = 'nm-browser-sync-state';
export const DATA_EXPORT_FORMAT = 'note-mate-export';
export const DATA_EXPORT_VERSION = 1;

export function isSyncSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate the sync sidecar (the small JSON next to the ZIP in the sync
 * folder). Returns { exported_at, sha256, bytes }. Throws with a reason.
 */
export function parseSyncSidecar(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('sync file is not valid JSON');
  }
  if (!obj || obj.format !== DATA_EXPORT_FORMAT || obj.version !== DATA_EXPORT_VERSION
    || typeof obj.exported_at !== 'string' || !obj.exported_at
    || typeof obj.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(obj.sha256)) {
    throw new Error('sync file is not a note-mate export');
  }
  return {
    exported_at: obj.exported_at,
    sha256: obj.sha256,
    bytes: Number.isInteger(obj.bytes) ? obj.bytes : null,
  };
}

/**
 * Pure decision for a sync check. `sidecar` is null when the folder has
 * no sidecar yet. Returns { action: 'none' } | { action: 'download' } |
 * { action: 'upload-missing' }; 'none' carries reason 'older' when the
 * folder file predates this server's state (our next upload wins).
 */
export function decideSyncCheck({ sidecar, lastHash, lastExportedAt }) {
  if (!sidecar) return { action: 'upload-missing' };
  if (lastHash && sidecar.sha256 === lastHash) return { action: 'none' };
  if (lastExportedAt && sidecar.exported_at <= lastExportedAt) {
    return { action: 'none', reason: 'older' };
  }
  return { action: 'download' };
}

export const syncState = {
  supported: isSyncSupported(),
  handle: null,            // FileSystemDirectoryHandle, from IndexedDB
  folderName: null,
  permission: 'unknown',   // granted | prompt | denied
  connected: false,
  running: false,
  dirty: false,
  lastHash: null,          // sha256 of the folder ZIP as last written / imported
  lastExportedAt: null,
  lastAt: null,
  lastDirection: null,
  pollTimer: null,
  debounceTimer: null,
};

// ---- persisted state (this browser only) ----
function loadSyncState() {
  try {
    const s = JSON.parse(localStorage.getItem(SYNC_STATE_KEY) || '{}');
    syncState.lastHash = s.lastHash || null;
    syncState.lastExportedAt = s.lastExportedAt || null;
    syncState.lastAt = s.lastAt || null;
    syncState.lastDirection = s.lastDirection || null;
    syncState.dirty = s.dirty === true;
  } catch { /* a corrupt state starts fresh */ }
}
function saveSyncState() {
  try {
    localStorage.setItem(SYNC_STATE_KEY, JSON.stringify({
      lastHash: syncState.lastHash,
      lastExportedAt: syncState.lastExportedAt,
      lastAt: syncState.lastAt,
      lastDirection: syncState.lastDirection,
      dirty: syncState.dirty,
    }));
  } catch { /* private mode — sync still works for this page load */ }
}
function clearSyncState() {
  try { localStorage.removeItem(SYNC_STATE_KEY); } catch { /* ignore */ }
  syncState.lastHash = null;
  syncState.lastExportedAt = null;
  syncState.lastAt = null;
  syncState.lastDirection = null;
  syncState.dirty = false;
}

// ---- the picked folder, kept in IndexedDB (handles survive reloads) ----
function syncIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('note-mate-sync', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('handles'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function syncIdbGet() {
  const db = await syncIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').get('syncDir');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function syncIdbPut(handle) {
  const db = await syncIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, 'syncDir');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function syncIdbDelete() {
  const db = await syncIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').delete('syncDir');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Small fetch-JSON helper for the engine (it never goes through the app's
// api() wrapper — that wrapper marks sync dirty, which would loop).
async function fetchJson(path, opts = {}) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const msg = (data && data.error) || (data && data.message) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

// ---- sync log (Admin → Data) ----
export async function postSyncLogEvent(entry) {
  // The log must never fail a sync itself.
  try { await fetchJson('/api/admin/data/sync/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) }); } catch { /* keep going */ }
  loadSyncLog();
}
export async function loadSyncLog() {
  const host = document.getElementById('sync-log');
  if (!host) return;
  try {
    const r = await fetchJson('/api/admin/data/sync/log');
    const rows = r.log || [];
    host.innerHTML = rows.length
      ? `<table class="admin-table"><thead><tr><th>When</th><th>Direction</th><th>Result</th><th>Size</th><th></th></tr></thead><tbody>${rows.map((e) => `<tr>
        <td style="white-space:nowrap">${escHtml(new Date(e.created_at).toLocaleString('en-CA'))}</td>
        <td>${e.direction === 'upload' ? 'Upload' : 'Download'}</td>
        <td>${e.status === 'ok' ? 'OK' : e.status === 'skipped' ? 'Skipped' : 'Failed'}</td>
        <td>${e.bytes == null ? '—' : `${(e.bytes / 1024).toFixed(1)} KB`}</td>
        <td>${escHtml(e.detail || '')}</td></tr>`).join('')}</tbody></table>`
      : '<div class="manage-status">No syncs yet.</div>';
  } catch {
    host.innerHTML = '<div class="manage-status">Sync log unavailable.</div>';
  }
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function renderSyncStatus() {
  const statusEl = document.getElementById('sync-status');
  const panel = document.getElementById('sync-panel');
  const unsupported = document.getElementById('sync-unsupported');
  if (!statusEl || !panel || !unsupported) return;
  if (!syncState.supported) {
    unsupported.classList.remove('hidden');
    panel.classList.add('hidden');
    return;
  }
  unsupported.classList.add('hidden');
  panel.classList.remove('hidden');
  const reconnectBtn = document.getElementById('sync-reconnect-btn');
  if (reconnectBtn) {
    reconnectBtn.classList.toggle('hidden',
      syncState.permission !== 'prompt' && syncState.permission !== 'denied');
  }
  if (!syncState.handle) statusEl.textContent = 'Not connected.';
  else if (syncState.permission !== 'granted') statusEl.textContent = `Folder “${syncState.folderName}” needs permission — press Reconnect.`;
  else if (syncState.lastAt) statusEl.textContent = `Connected to “${syncState.folderName}” · Last synced ${new Date(syncState.lastAt).toLocaleString('en-CA')} · ${syncState.lastDirection || ''}`;
  else statusEl.textContent = `Connected to “${syncState.folderName}” — not synced yet.`;
}

// ---- folder lifecycle ----
export async function chooseSyncFolder() {
  if (!syncState.supported) return;
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (!e || e.name !== 'AbortError') setSyncMsg(`Could not open the folder picker: ${e.message || e}`);
    return;
  }
  try { await syncIdbPut(handle); } catch (e) {
    setSyncMsg(`Could not remember the folder: ${e.message}`);
    return;
  }
  syncState.handle = handle;
  syncState.folderName = handle.name;
  syncState.permission = 'granted';
  syncState.connected = true;
  saveSyncState();
  renderSyncStatus();
  startSyncPoll();
  checkSync({ manual: true });
}

export async function initSync() {
  if (!syncState.supported) { renderSyncStatus(); return; }
  loadSyncState();
  let handle = null;
  try { handle = await syncIdbGet(); } catch { handle = null; }
  if (!handle) { renderSyncStatus(); return; }
  syncState.handle = handle;
  syncState.folderName = handle.name;
  let perm = 'prompt';
  try { perm = await handle.queryPermission({ mode: 'readwrite' }); } catch { perm = 'prompt'; }
  syncState.permission = perm;
  syncState.connected = perm === 'granted';
  renderSyncStatus();
  if (perm === 'granted') {
    startSyncPoll();
    // A change made right before a reload, or a file another machine
    // wrote while this page was closed: catch up quietly on load.
    if (syncState.dirty) scheduleSyncUpload();
    else checkSync({ manual: false });
  }
}

export async function reconnectSyncFolder() {
  if (!syncState.handle) return;
  let perm;
  try {
    perm = await syncState.handle.requestPermission({ mode: 'readwrite' });
  } catch (e) {
    setSyncMsg(`Permission request failed: ${e.message || e}`);
    return;
  }
  syncState.permission = perm;
  syncState.connected = perm === 'granted';
  renderSyncStatus();
  if (perm === 'granted') {
    startSyncPoll();
    checkSync({ manual: true });
  }
}

export async function forgetSyncFolder() {
  try { await syncIdbDelete(); } catch { /* already gone */ }
  stopSyncPoll();
  if (syncState.debounceTimer) { clearTimeout(syncState.debounceTimer); syncState.debounceTimer = null; }
  syncState.handle = null;
  syncState.folderName = null;
  syncState.permission = 'unknown';
  syncState.connected = false;
  clearSyncState();
  renderSyncStatus();
}

function startSyncPoll() {
  if (syncState.pollTimer) return;
  syncState.pollTimer = setInterval(() => { checkSync({ manual: false }); }, SYNC_POLL_MS);
}
function stopSyncPoll() {
  if (syncState.pollTimer) { clearInterval(syncState.pollTimer); syncState.pollTimer = null; }
}

function setSyncMsg(text) {
  const el = document.getElementById('sync-status');
  if (el) el.textContent = text;
}

// ---- dirty tracking: a successful app write schedules an upload ----
export function markSyncDirty() {
  syncState.dirty = true;
  saveSyncState();
  if (syncState.connected) scheduleSyncUpload();
}
export function scheduleSyncUpload() {
  if (syncState.debounceTimer) clearTimeout(syncState.debounceTimer);
  syncState.debounceTimer = setTimeout(() => {
    syncState.debounceTimer = null;
    uploadSync({ manual: false });
  }, SYNC_DEBOUNCE_MS);
}

// ---- upload: this server's export → the sync folder ----
export async function uploadSync({ manual = false } = {}) {
  if (!syncState.handle || syncState.permission !== 'granted' || syncState.running) {
    return { action: 'skipped' };
  }
  syncState.running = true;
  try {
    setSyncMsg('Uploading…');
    const res = await fetch('/api/admin/data/export');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `export failed (${res.status})`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const hash = await sha256Hex(buf);
    if (hash === syncState.lastHash) {
      setSyncMsg('Already in sync.');
      if (manual) {
        await postSyncLogEvent({ direction: 'upload', status: 'skipped', bytes: buf.byteLength, detail: 'Already in sync.' });
      }
      return { action: 'none' };
    }
    const exportedAt = new Date().toISOString();
    // ZIP first, sidecar second — a half-finished upload can never look
    // like a newer valid sync (the check verifies the ZIP hash).
    const fileHandle = await syncState.handle.getFileHandle(SYNC_FILE_NAME, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      const CHUNK = 64 * 1024;
      for (let done = 0; done < buf.byteLength; done += CHUNK) {
        await writable.write(buf.slice(done, done + CHUNK));
      }
      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch { /* already closed */ }
      throw e;
    }
    const sidecar = {
      format: DATA_EXPORT_FORMAT,
      version: DATA_EXPORT_VERSION,
      exported_at: exportedAt,
      sha256: hash,
      bytes: buf.byteLength,
    };
    const sideHandle = await syncState.handle.getFileHandle(SYNC_SIDECAR_NAME, { create: true });
    const sideWritable = await sideHandle.createWritable();
    try {
      await sideWritable.write(new TextEncoder().encode(JSON.stringify(sidecar, null, 2)));
      await sideWritable.close();
    } catch (e) {
      try { await sideWritable.abort(); } catch { /* already closed */ }
      throw e;
    }
    syncState.lastHash = hash;
    syncState.lastExportedAt = exportedAt;
    syncState.lastAt = new Date().toISOString();
    syncState.lastDirection = 'upload';
    syncState.dirty = false;
    saveSyncState();
    await postSyncLogEvent({ direction: 'upload', status: 'ok', bytes: buf.byteLength, exported_at: exportedAt, detail: 'Uploaded to the sync folder.' });
    setSyncMsg('Upload complete.');
    renderSyncStatus();
    return { action: 'uploaded', bytes: buf.byteLength };
  } catch (e) {
    await postSyncLogEvent({ direction: 'upload', status: 'error', detail: e.message });
    setSyncMsg(`Upload failed: ${e.message}`);
    renderSyncStatus();
    return { action: 'error', error: e.message };
  } finally {
    syncState.running = false;
  }
}

// ---- check: a newer file in the folder → import it ----
export async function checkSync({ manual = false } = {}) {
  if (!syncState.handle || syncState.permission !== 'granted' || syncState.running) {
    return { action: 'skipped' };
  }
  syncState.running = true;
  try {
    setSyncMsg('Checking the sync folder…');
    let sidecarText;
    try {
      const sideHandle = await syncState.handle.getFileHandle(SYNC_SIDECAR_NAME);
      const sideFile = await sideHandle.getFile();
      sidecarText = await sideFile.text();
    } catch (e) {
      if (e && e.name === 'NotFoundError') {
        // No sidecar yet: write ours (first connect, or the user deleted it).
        syncState.running = false;
        return uploadSync({ manual });
      }
      throw e;
    }
    let sidecar;
    try {
      sidecar = parseSyncSidecar(sidecarText);
    } catch (e) {
      throw new Error(`sync file is not valid: ${e.message}`);
    }
    const decision = decideSyncCheck({
      sidecar,
      lastHash: syncState.lastHash,
      lastExportedAt: syncState.lastExportedAt,
    });
    if (decision.action === 'none') {
      setSyncMsg('Already in sync.');
      if (manual) {
        await postSyncLogEvent({
          direction: 'download',
          status: 'skipped',
          bytes: sidecar.bytes,
          detail: decision.reason === 'older' ? 'Sync file is older than this server.' : 'Already in sync.',
        });
      }
      return { action: 'none' };
    }
    // Newer file from another machine: read the ZIP, verify its hash
    // against the sidecar, then import it through the normal import path.
    // The request carries the log entry — the page reloads afterwards.
    const zipHandle = await syncState.handle.getFileHandle(SYNC_FILE_NAME);
    const zipFile = await zipHandle.getFile();
    const buf = new Uint8Array(await zipFile.arrayBuffer());
    const hash = await sha256Hex(buf);
    if (hash !== sidecar.sha256) throw new Error('sync file checksum mismatch — the folder copy is incomplete');
    setSyncMsg('Downloading…');
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'application/zip' }), SYNC_FILE_NAME);
    form.append('sync', JSON.stringify({ direction: 'download', bytes: buf.byteLength, exported_at: sidecar.exported_at }));
    await fetchJson('/api/admin/data/import', { method: 'POST', body: form });
    syncState.lastHash = hash;
    syncState.lastExportedAt = sidecar.exported_at;
    syncState.lastAt = new Date().toISOString();
    syncState.lastDirection = 'download';
    syncState.dirty = false;
    saveSyncState();
    setSyncMsg('Download complete — reloading.');
    renderSyncStatus();
    setTimeout(() => { location.reload(); }, 1200);
    return { action: 'downloaded', bytes: buf.byteLength };
  } catch (e) {
    await postSyncLogEvent({ direction: 'download', status: 'error', detail: e.message });
    setSyncMsg(`Download failed: ${e.message}`);
    renderSyncStatus();
    return { action: 'error', error: e.message };
  } finally {
    syncState.running = false;
  }
}

export async function syncNow() {
  if (!syncState.handle) { setSyncMsg('Choose a sync folder first.'); return; }
  if (syncState.permission !== 'granted') { setSyncMsg('Reconnect the sync folder first.'); return; }
  if (syncState.dirty) {
    const r = await uploadSync({ manual: true });
    if (r.action === 'uploaded') setSyncMsg('Sync uploaded.');
    else if (r.action === 'error') setSyncMsg(`Sync failed: ${r.error}`);
    else if (r.action === 'none') setSyncMsg('Already in sync.');
    loadSyncLog();
    return;
  }
  const r = await checkSync({ manual: true });
  if (r.action === 'none') setSyncMsg('Already in sync.');
  else if (r.action === 'error') setSyncMsg(`Sync failed: ${r.error}`);
  loadSyncLog();
}

// Test / debug handle (the directory picker cannot be driven headlessly,
// so the probe drives the engine with a stubbed handle here — same
// pattern as FM's window.browserSync).
export const noteSync = {
  state: syncState,
  init: initSync,
  choose: chooseSyncFolder,
  reconnect: reconnectSyncFolder,
  forget: forgetSyncFolder,
  now: syncNow,
  upload: uploadSync,
  check: checkSync,
};
if (typeof window !== 'undefined') window.noteSync = noteSync;
