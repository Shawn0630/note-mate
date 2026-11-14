// Full-data export / import (the Finance Mate pattern, file-based).
// One ZIP archive carrying the WHOLE Note Mate data (all projects:
// project.json, sources, notes, notebooks, sections, assets,
// annotations). The AI call log and the sync log live under data/admin/
// and are NEVER in the archive — they are local-only diagnostics.
//
// Manifest (note-mate-export.json, top level of the archive):
//   { format, version, app, exported_at, projects: [slugs],
//     files: [{ path, size, sha256 }], checksum }
// The checksum is SHA-256 over the manifest WITHOUT the checksum field
// (FM's payloadChecksum shape: checksum over exactly the content).
// Import validates the archive fully BEFORE writing anything; on a
// project-slug collision the existing project is KEPT and the archived
// one is skipped (reported in the summary) — an import never silently
// destroys data, and no backup is needed because nothing is replaced.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createZip, readZip } from './zipStore.js';

export const DATA_EXPORT_FORMAT = 'note-mate-export';
export const DATA_EXPORT_VERSION = 1;
export const DATA_EXPORT_APP = 'note-mate';
export const DATA_EXPORT_MANIFEST = 'note-mate-export.json';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fail(msg) {
  const err = new Error(msg);
  err.status = 400;
  throw err;
}

/** Checksum over the manifest content (everything except `checksum`). */
export function manifestChecksum(manifest) {
  const { checksum: _ignored, ...rest } = manifest ?? {};
  return sha256Hex(Buffer.from(JSON.stringify(rest), 'utf8'));
}

export function buildManifest({ files, projects, exportedAt }) {
  const manifest = {
    format: DATA_EXPORT_FORMAT,
    version: DATA_EXPORT_VERSION,
    app: DATA_EXPORT_APP,
    exported_at: exportedAt,
    projects: [...projects].sort(),
    files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
  };
  manifest.checksum = manifestChecksum(manifest);
  return manifest;
}

// Recursively collect regular files under dir (relative paths, '/'
// separators). Symlinks are skipped — an export never follows a link
// out of the data dir.
async function collectFiles(dir, relBase = '') {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...(await collectFiles(abs, rel)));
    else if (e.isFile()) out.push({ rel, abs });
  }
  return out;
}

/**
 * Build the full-data export archive from a data dir. Only project dirs
 * that carry a parseable project.json are included (a stray directory
 * under projects/ is not a project and is left out — import enforces the
 * same rule, so export and import always agree). Returns
 * { buffer, manifest, projects, fileCount }.
 */
export async function buildDataExport(dataDir) {
  const projectsRoot = path.join(dataDir, 'projects');
  const slugs = [];
  try {
    for (const e of await fsp.readdir(projectsRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (!SLUG_RE.test(e.name)) continue;
      try {
        const raw = await fsp.readFile(path.join(projectsRoot, e.name, 'project.json'), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) slugs.push(e.name);
      } catch {
        // No (parseable) project.json — not a project, skip it.
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  slugs.sort();
  const files = [];
  for (const slug of slugs) {
    const dirFiles = await collectFiles(path.join(projectsRoot, slug), `projects/${slug}`);
    for (const f of dirFiles) {
      const buf = await fsp.readFile(f.abs);
      files.push({ path: f.rel, size: buf.length, sha256: sha256Hex(buf), data: buf });
    }
  }
  const exportedAt = new Date().toISOString();
  const manifest = buildManifest({ files, projects: slugs, exportedAt });
  const zip = createZip();
  zip.addFile(DATA_EXPORT_MANIFEST, JSON.stringify(manifest, null, 2));
  for (const f of files) zip.addFile(f.path, f.data);
  return { buffer: zip.toBuffer(), manifest, projects: slugs, fileCount: files.length };
}

/**
 * Validate an export archive fully (structure + checksum + file hashes).
 * Returns { manifest, entries } — `entries` are the archive's files
 * EXCEPT the manifest. Throws an Error with status 400 on any problem;
 * nothing is written by this function.
 */
export function validateDataArchive(input) {
  const entries = readZip(input); // throws 400 on a non-stored zip
  const manifestEntry = entries.find((e) => e.name === DATA_EXPORT_MANIFEST);
  if (!manifestEntry) fail('export is missing its manifest (note-mate-export.json)');
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch {
    fail('export manifest is not valid JSON');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('export manifest is malformed');
  }
  if (manifest.format !== DATA_EXPORT_FORMAT) fail('not a note-mate export file');
  if (manifest.version !== DATA_EXPORT_VERSION) {
    fail(`unsupported export version ${manifest.version} (this app reads version ${DATA_EXPORT_VERSION})`);
  }
  if (manifest.app !== DATA_EXPORT_APP) fail('not a note-mate export file');
  if (typeof manifest.exported_at !== 'string' || !manifest.exported_at) {
    fail('export is missing exported_at');
  }
  if (!Array.isArray(manifest.projects)
    || manifest.projects.some((s) => typeof s !== 'string' || !SLUG_RE.test(s))) {
    fail('export manifest has bad projects');
  }
  if (!Array.isArray(manifest.files)) fail('export manifest has no files');
  if (typeof manifest.checksum !== 'string'
    || manifest.checksum !== manifestChecksum(manifest)) {
    fail('export checksum mismatch — the file was edited or is corrupt');
  }
  const byPath = new Map();
  for (const f of manifest.files) {
    if (!f || typeof f.path !== 'string' || !Number.isInteger(f.size) || f.size < 0
      || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) {
      fail(`export manifest has a bad file entry: ${JSON.stringify(f)}`);
    }
    const parts = f.path.split('/');
    if (parts.length < 3 || parts[0] !== 'projects' || !SLUG_RE.test(parts[1])
      || parts.some((seg) => seg === '' || seg === '.' || seg === '..')) {
      fail(`export file path escapes its project: ${f.path}`);
    }
    if (!manifest.projects.includes(parts[1])) {
      fail(`export file belongs to an unlisted project: ${f.path}`);
    }
    if (byPath.has(f.path)) fail(`export lists a file twice: ${f.path}`);
    byPath.set(f.path, f);
  }
  const seen = new Set();
  for (const e of entries) {
    if (e.name === DATA_EXPORT_MANIFEST) continue;
    if (seen.has(e.name)) fail(`archive contains a file twice: ${e.name}`);
    seen.add(e.name);
    const want = byPath.get(e.name);
    if (!want) fail(`archive contains an unlisted file: ${e.name}`);
    if (e.data.length !== want.size || sha256Hex(e.data) !== want.sha256) {
      fail(`archive file hash mismatch: ${e.name}`);
    }
  }
  if (seen.size !== byPath.size) {
    const missing = [...byPath.keys()].find((p) => !seen.has(p));
    fail(`archive is missing a listed file: ${missing}`);
  }
  for (const slug of manifest.projects) {
    if (!byPath.has(`projects/${slug}/project.json`)) {
      fail(`export is missing project.json for project ${slug}`);
    }
  }
  return { manifest, entries: entries.filter((e) => e.name !== DATA_EXPORT_MANIFEST) };
}

/**
 * Validate + restore an export archive into a data dir. Projects whose
 * slug already exists are KEPT and skipped (reported); only missing
 * projects are written, each staged to a temp dir and renamed into place
 * so a half-written project never lands. Returns
 * { imported: [slugs], skipped: [{ slug, reason }], files: n }.
 * Throws (status 400) on validation failure — nothing is written then.
 */
export async function applyDataImport(dataDir, input) {
  const { manifest, entries } = validateDataArchive(input);
  const projectsRoot = path.join(dataDir, 'projects');
  await fsp.mkdir(projectsRoot, { recursive: true });
  const imported = [];
  const skipped = [];
  let files = 0;
  const bySlug = new Map();
  for (const e of entries) {
    const slug = e.name.split('/')[1];
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(e);
  }
  for (const slug of manifest.projects) {
    const dest = path.join(projectsRoot, slug);
    try {
      await fsp.stat(dest);
      skipped.push({ slug, reason: 'already exists — kept, not overwritten' });
      continue;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const staging = path.join(projectsRoot, `.import-${slug}-${process.pid}-${Date.now()}`);
    await fsp.mkdir(staging, { recursive: true });
    try {
      for (const e of bySlug.get(slug) || []) {
        const rel = e.name.slice(`projects/${slug}/`.length);
        const target = path.join(staging, ...rel.split('/'));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, e.data);
        files += 1;
      }
      await fsp.rename(staging, dest);
      imported.push(slug);
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }
  return { imported, skipped, files };
}

// Re-exported for the sync sidecar + tests.
export { sha256Hex };
