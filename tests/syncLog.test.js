import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordSyncLog, listSyncLog } from '../src/syncLog.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nm-synclog-'));
}

test('record + list: newest-first, capped at 50', async () => {
  const dir = await tmpDir();
  for (let i = 0; i < 3; i++) {
    recordSyncLog({ direction: i % 2 ? 'download' : 'upload', status: 'ok', bytes: 100 + i, detail: `sync ${i}` }, dir);
  }
  const rows = listSyncLog(50, dir);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].detail, 'sync 2');
  assert.equal(rows[2].detail, 'sync 0');
  assert.equal(rows[0].direction, 'upload');
  assert.ok(rows[0].created_at);
  await fs.rm(dir, { recursive: true, force: true });
});

test('record: validates direction, status, bytes, detail length', async () => {
  const dir = await tmpDir();
  assert.throws(() => recordSyncLog({ direction: 'sideways', status: 'ok' }, dir), (e) => e.status === 400);
  assert.throws(() => recordSyncLog({ direction: 'upload', status: 'maybe' }, dir), (e) => e.status === 400);
  assert.throws(() => recordSyncLog({ direction: 'upload', status: 'ok', bytes: -1 }, dir), (e) => e.status === 400);
  assert.throws(() => recordSyncLog({ direction: 'upload', status: 'ok', bytes: 1.5 }, dir), (e) => e.status === 400);
  assert.throws(() => recordSyncLog({ direction: 'upload', status: 'ok', detail: 'x'.repeat(501) }, dir), (e) => e.status === 400);
  // Optional fields may be absent.
  const row = recordSyncLog({ direction: 'download', status: 'skipped' }, dir);
  assert.equal(row.bytes, null);
  assert.equal(row.detail, null);
  assert.deepEqual(listSyncLog(50, dir), [row]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('list: missing file -> empty', async () => {
  const dir = await tmpDir();
  assert.deepEqual(listSyncLog(50, dir), []);
  await fs.rm(dir, { recursive: true, force: true });
});
