// Browser-sync log — every browser sync event recorded here so the
// admin panel can show what happened, when, in which direction, and why
// it failed. File-based (this app has no SQL): append-only JSONL under
// data/admin/sync-log.jsonl, mirroring FM's sync_log table shape.
// Browser-side events reach the server through POST
// /api/admin/data/sync/log; a download import carries its log entry
// inside the import request itself (same pattern as FM).
import fs from 'node:fs';
import path from 'node:path';
import { adminDir } from './aiCallLog.js';

export const SYNC_LOG_FILE = 'sync-log.jsonl';
export const SYNC_LOG_DIRECTIONS = ['upload', 'download'];
export const SYNC_LOG_STATUSES = ['ok', 'error', 'skipped'];

export function syncLogPath(dataDir) {
  return path.join(adminDir(dataDir), SYNC_LOG_FILE);
}

/** Validate + append one entry. Throws an Error with status 400 on bad input. */
export function recordSyncLog(entry, dataDir) {
  const fail = (msg) => {
    const err = new Error(msg);
    err.status = 400;
    throw err;
  };
  if (!SYNC_LOG_DIRECTIONS.includes(entry?.direction)) fail(`bad sync direction: ${entry?.direction}`);
  if (!SYNC_LOG_STATUSES.includes(entry?.status)) fail(`bad sync status: ${entry?.status}`);
  if (entry?.bytes !== null && entry?.bytes !== undefined
    && (!Number.isInteger(entry.bytes) || entry.bytes < 0)) {
    fail('sync log bytes must be a non-negative integer');
  }
  if (entry?.detail !== null && entry?.detail !== undefined && typeof entry.detail !== 'string') {
    fail('sync log detail must be text');
  }
  if (typeof entry?.detail === 'string' && entry.detail.length > 500) {
    fail('sync log detail is too long (max 500 chars)');
  }
  const clean = {
    created_at: new Date().toISOString(),
    direction: entry.direction,
    status: entry.status,
    bytes: entry.bytes == null ? null : entry.bytes,
    exported_at: entry.exported_at == null ? null : String(entry.exported_at),
    detail: entry.detail == null ? null : String(entry.detail).slice(0, 500),
  };
  const dir = adminDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(syncLogPath(dataDir), `${JSON.stringify(clean)}\n`, 'utf8');
  return clean;
}

/** Newest first. Missing file or corrupt lines → empty / skipped. */
export function listSyncLog(limit = 50, dataDir) {
  try {
    const lines = fs.readFileSync(syncLogPath(dataDir), 'utf8')
      .split('\n').filter((line) => line.trim());
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip a corrupt line */ }
    }
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    return entries.reverse().slice(0, n);
  } catch {
    return [];
  }
}
