import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSyncSupported, parseSyncSidecar, decideSyncCheck, sha256Hex,
  SYNC_FILE_NAME, SYNC_SIDECAR_NAME, DATA_EXPORT_FORMAT, DATA_EXPORT_VERSION,
} from '../public/dataSync.js';

test('sync file names + format', () => {
  assert.equal(SYNC_FILE_NAME, 'note-mate-export.zip');
  assert.equal(SYNC_SIDECAR_NAME, 'note-mate-export.json');
  assert.equal(DATA_EXPORT_FORMAT, 'note-mate-export');
  assert.equal(DATA_EXPORT_VERSION, 1);
});

test('isSyncSupported: false in node (no showDirectoryPicker)', () => {
  assert.equal(isSyncSupported(), false);
});

test('sha256Hex: known vector', async () => {
  const hex = await sha256Hex(new TextEncoder().encode('abc'));
  assert.equal(hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('parseSyncSidecar: valid sidecar; rejects bad JSON / wrong format / bad hash', () => {
  const good = {
    format: 'note-mate-export', version: 1,
    exported_at: '2026-11-13T12:00:00.000Z', sha256: 'a'.repeat(64), bytes: 123,
  };
  assert.deepEqual(parseSyncSidecar(JSON.stringify(good)), {
    exported_at: good.exported_at, sha256: good.sha256, bytes: 123,
  });
  assert.throws(() => parseSyncSidecar('not json'), /not valid JSON/);
  assert.throws(() => parseSyncSidecar(JSON.stringify({ ...good, format: 'finance-mate-export' })), /not a note-mate export/);
  assert.throws(() => parseSyncSidecar(JSON.stringify({ ...good, version: 2 })), /not a note-mate export/);
  assert.throws(() => parseSyncSidecar(JSON.stringify({ ...good, sha256: 'xyz' })), /not a note-mate export/);
  assert.throws(() => parseSyncSidecar(JSON.stringify({ ...good, exported_at: '' })), /not a note-mate export/);
});

test('decideSyncCheck: no sidecar -> upload-missing; same hash -> none; older -> none (older); newer -> download', () => {
  assert.deepEqual(decideSyncCheck({ sidecar: null, lastHash: 'x', lastExportedAt: '2026-11-13T00:00:00.000Z' }), { action: 'upload-missing' });
  const sidecar = { exported_at: '2026-11-13T12:00:00.000Z', sha256: 'a'.repeat(64), bytes: 1 };
  // Same content hash: nothing to do (loop prevention).
  assert.deepEqual(decideSyncCheck({ sidecar, lastHash: sidecar.sha256, lastExportedAt: '2026-11-13T11:00:00.000Z' }), { action: 'none' });
  // Folder file predates this server's state: our next upload wins.
  assert.deepEqual(decideSyncCheck({ sidecar, lastHash: 'b'.repeat(64), lastExportedAt: '2026-11-13T13:00:00.000Z' }), { action: 'none', reason: 'older' });
  // Newer file from another machine: download.
  assert.deepEqual(decideSyncCheck({ sidecar, lastHash: 'b'.repeat(64), lastExportedAt: '2026-11-13T11:00:00.000Z' }), { action: 'download' });
  // Fresh browser (no local state): a folder file is always a download.
  assert.deepEqual(decideSyncCheck({ sidecar, lastHash: null, lastExportedAt: null }), { action: 'download' });
});
