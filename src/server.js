// Note Mate backend — Node ESM + Express, file-based storage under DATA_DIR.
// No database. Serves the API the frontend builds against; see README.md.
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { slugify, resolveProjectPath, parseNotebook } from './util.js';
import { extractPdfText } from './pdftext.js';
import { extractPdfOutline } from './pdfOutline.js';
import { proposeProjectData, LLM_NOT_CONFIGURED, listModels, isAllowedModel } from './llm.js';
import { validateProposal } from './aiImport.js';
import {
  generateAiNote, resolveChapterRange, resolvePageRange, extractChapterSection,
  MAX_AI_NOTE_PROMPT_CHARS, MAX_AI_NOTE_HISTORY_MESSAGES,
  MAX_AI_NOTE_HISTORY_CHARS, MAX_AI_NOTE_NOTE_CHARS, MAX_CHAPTER_PAGES,
} from './aiNote.js';
import {
  generateAiCode, AI_CODE_LANGUAGES, MAX_AI_CODE_PROMPT_CHARS, MAX_AI_CODE_CELLS_CHARS,
} from './aiCode.js';
import { cellsToMarkdown, notebookToMarkdown } from './cellExport.js';
import {
  isChapterFile, chapterFileNumber, splitSections, sectionHasContent,
  dropEmptySections, stripLabsBlock, foldChapterFiles,
  INDEX_FILE, LEGACY_NOTES_FILE, MIGRATED_BACKUP_FILE, CHAPTER_BACKUP_DIR,
} from './masterNotes.js';
import { formatPageAnchor } from './pageAnchor.js';
import {
  addNoteLinkEntry, removeNoteLinkEntries, renameNoteLinkEntries,
} from './noteLinks.js';
import {
  ANNOTATIONS_FILE, emptyAnnotationsDoc, parseAnnotationsDoc,
  newAnnotationId, validateAnnotationInput,
} from './annotations.js';
import { ensurePdf, isConvertibleDoc } from './convertDocument.js';
import { createZip } from './zipStore.js';
import { readAiCalls } from './aiCallLog.js';
import { recordSyncLog, listSyncLog } from './syncLog.js';
import { buildDataExport, applyDataImport } from './dataExport.js';
import {
  SECTION_NOTEBOOKS_DIR, SECTION_ID_RE,
  SECTION_NOTEBOOK_NAME_RE, SECTION_LANGUAGES,
  normalizeSections, findSection, nextSectionName, sectionIdFor,
  scanLabsOnDisk, buildLabsSection, mergeSections,
} from './sections.js';

const execFileAsync = promisify(execFile);

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const PORT = Number(process.env.PORT || 9300);

const MAX_CODE_BYTES = 200 * 1024; // ~200KB cap on /api/execute code
const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
// Run-all (cells) mode: one shared session, so the caps are per batch.
const MAX_RUN_ALL_CELLS = 200;
const MAX_RUN_ALL_TOTAL_BYTES = 2 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB — books/videos can be large
});

const app = express();
app.use(express.json({ limit: '20mb' }));

// ---------------------------------------------------------------------------
// Project storage helpers
// ---------------------------------------------------------------------------

function projectsDir() {
  return path.join(DATA_DIR, 'projects');
}

async function readProject(slug) {
  const file = resolveProjectPath(DATA_DIR, slug, 'project.json');
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw);
}

async function writeProject(slug, project) {
  const file = resolveProjectPath(DATA_DIR, slug, 'project.json');
  project.updatedAt = new Date().toISOString();
  await fsp.writeFile(file, JSON.stringify(project, null, 2) + '\n', 'utf8');
  return project;
}

async function listNoteFiles(slug) {
  const dir = resolveProjectPath(DATA_DIR, slug, 'notes');
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /\.(md|ipynb)$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/* Best-effort language of a stored notebook (metadata language_info /
   kernelspec) for the Files directory's tag — null when the file is
   unreadable or names no language. Never throws. */
async function notebookLanguageAt(file) {
  try {
    const nb = JSON.parse(await fsp.readFile(file, 'utf8'));
    const lang = nb?.metadata?.language_info?.name || nb?.metadata?.kernelspec?.language || null;
    return typeof lang === 'string' && lang.trim() ? lang.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/* Language of a notebook object already parsed in memory (an upload
   buffer, or a freshly built notebook) — same best-effort rule. */
function notebookLanguageOfObject(nb) {
  const lang = nb?.metadata?.language_info?.name || nb?.metadata?.kernelspec?.language || null;
  return typeof lang === 'string' && lang.trim() ? lang.trim().toLowerCase() : null;
}

async function notebookLanguageOf(slug, name) {
  return notebookLanguageAt(resolveProjectPath(DATA_DIR, slug, 'notes', name));
}

// ---------------------------------------------------------------------------
// Revert migration: one master notes.md (2026-11-11 reversal).
//
// The per-chapter model (55d1761) is gone: notes live in ONE master file,
// `notes.md`, headings created on demand. A project that still carries the
// old model is migrated on first read (and by POST .../notes/migrate):
//   (a) per-chapter files exist -> fold each file's USER content back into
//       the master under its `##` heading, in chapter order, stripping the
//       generated `### Labs` blocks; chapters with no user content vanish
//       (their headings were empty skeleton). The chapter files, the
//       app-generated index.md, the legacy notes.md.migrated and a
//       pre-existing notes.md are MOVED (not deleted) into
//       notes/.chapter-backup/ first, so nothing is ever lost.
//   (b) only the legacy single notes.md exists -> drop its EMPTY skeleton
//       headings in place (headings with content are kept verbatim).
//   (c) neither -> nothing to do.
// Idempotent: after a run there are no chapter files and no empty
// sections left, so a second run is a no-op. Returns a summary
// {migrated: 'folded'|'pruned'|'none', chapters?, droppedEmpty?, backupDir?}.
// ---------------------------------------------------------------------------
async function migrateNotesToMaster(slug) {
  const notesDir = resolveProjectPath(DATA_DIR, slug, 'notes');
  let entries;
  try {
    entries = await fsp.readdir(notesDir, { withFileTypes: true });
  } catch {
    return { migrated: 'none' };
  }
  const names = entries.filter((e) => e.isFile()).map((e) => e.name);
  const chapterFiles = names.filter(isChapterFile).sort((a, b) => {
    const na = chapterFileNumber(a);
    const nb = chapterFileNumber(b);
    return (na ?? 0) - (nb ?? 0) || a.localeCompare(b);
  });
  const hasIndex = names.includes(INDEX_FILE);
  const hasLegacy = names.includes(MIGRATED_BACKUP_FILE);
  const hasMaster = names.includes(LEGACY_NOTES_FILE);

  if (chapterFiles.length) {
    const backupDir = path.join(notesDir, CHAPTER_BACKUP_DIR);
    await fsp.mkdir(backupDir, { recursive: true });
    const moveToBackup = async (name) => {
      let target = path.join(backupDir, name);
      for (let i = 1; ; i++) {
        try {
          await fsp.stat(target);
          const ext = path.extname(name);
          const stem = name.slice(0, name.length - ext.length);
          target = path.join(backupDir, `${stem}.${i}${ext}`);
        } catch {
          break;
        }
      }
      await fsp.rename(path.join(notesDir, name), target);
    };
    // Header for the folded master: the legacy file's header (title +
    // byline, i.e. everything before its first `##`), else the project's
    // stored notesHeader (55d1761 kept the byline there), else the title.
    let header = '';
    if (hasLegacy) {
      const legacy = await fsp.readFile(path.join(notesDir, MIGRATED_BACKUP_FILE), 'utf8');
      header = splitSections(legacy).header;
    }
    if (!header.trim()) {
      try {
        const project = await readProject(slug);
        if (typeof project.notesHeader === 'string' && project.notesHeader.trim()) {
          header = project.notesHeader;
        } else if (project.title) {
          header = `# ${project.title}\n`;
        }
      } catch { /* header stays empty; fold still works */ }
    }
    const files = [];
    for (const name of chapterFiles) {
      files.push({ name, content: await fsp.readFile(path.join(notesDir, name), 'utf8') });
    }
    const folded = foldChapterFiles(header, files);
    // A chapter file contributes nothing when, Labs block aside, it holds
    // no user content — its empty skeleton heading vanishes.
    const droppedEmpty = files.filter((f) => {
      const { sections } = splitSections(stripLabsBlock(f.content));
      return !sections.some(sectionHasContent);
    }).length;
    for (const name of [...chapterFiles, ...(hasIndex ? [INDEX_FILE] : []),
      ...(hasLegacy ? [MIGRATED_BACKUP_FILE] : []),
      ...(hasMaster ? [LEGACY_NOTES_FILE] : [])]) {
      await moveToBackup(name);
    }
    await fsp.writeFile(path.join(notesDir, LEGACY_NOTES_FILE), folded, 'utf8');
    return {
      migrated: 'folded',
      chapters: chapterFiles.length,
      droppedEmpty,
      backupDir: CHAPTER_BACKUP_DIR,
    };
  }

  if (hasMaster) {
    const current = await fsp.readFile(path.join(notesDir, LEGACY_NOTES_FILE), 'utf8');
    const before = splitSections(current).sections.length;
    const cleaned = dropEmptySections(current);
    if (cleaned !== current) {
      await fsp.writeFile(path.join(notesDir, LEGACY_NOTES_FILE), cleaned, 'utf8');
      const after = splitSections(cleaned).sections.length;
      return { migrated: 'pruned', droppedEmpty: before - after };
    }
    return { migrated: 'none' };
  }
  return { migrated: 'none' };
}

/* Lazy Labs-section backfill (2026-11-13): projects seeded before the
   sections round carry no `sections[]` in project.json, so the Manage
   page shows "No sections yet." even though the labs are on disk (the
   Files directory still lists them via the labs API, which scans disk).
   On project read, scan notes/labs/ and merge a Labs section in with
   the same helpers the seed uses (scanLabsOnDisk + buildLabsSection +
   mergeSections). Never touches user sections or user-added entries
   inside Labs, never touches notes.md or any other project.json field.
   A second read after the backfill is a no-op (nothing left to merge).
   Returns the merged sections array when it wrote, else null.
   Best-effort — callers swallow errors, never fails the read. */
async function backfillLabsSection(slug) {
  const labs = await scanLabsOnDisk(resolveProjectPath(DATA_DIR, slug, 'notes', 'labs'));
  if (!labs.length) return null;
  const project = await readProject(slug);
  const merged = mergeSections(project.sections ?? [], buildLabsSection(labs));
  if (JSON.stringify(merged) === JSON.stringify(normalizeSections(project.sections ?? []))) return null;
  project.sections = merged;
  await writeProject(slug, project);
  return merged;
}

function publicProject(project, noteFiles) {
  return {
    slug: project.slug,
    title: project.title,
    author: project.author ?? null,
    kind: project.kind,
    sourceType: project.sourceType,
    cover: project.cover ?? null,
    createdAt: project.createdAt,
    noteFiles,
  };
}

async function uniqueSlug(base) {
  let slug = base;
  let n = 2;
  while (true) {
    try {
      await fsp.stat(path.join(projectsDir(), slug));
      slug = `${base}-${n++}`;
    } catch {
      return slug;
    }
  }
}

function inferKindFromUrl(url) {
  const lower = url.toLowerCase();
  if (/youtube\.com|youtu\.be/.test(lower)) return 'video';
  if (/docs\.google\.com\/presentation/.test(lower)) return 'slides';
  if (/\.pdf($|[?#])/.test(lower)) return 'pdf';
  return null;
}

function inferKindFromExt(ext) {
  switch (ext) {
    case '.pdf': return 'pdf';
    // Word documents read as PDF projects: the file route converts them
    // lazily (see readablePdfPath), so the reader needs no docx kind.
    case '.docx': case '.doc': return 'pdf';
    case '.mp4': case '.mov': case '.webm': case '.mkv': return 'video';
    case '.ppt': case '.pptx': case '.key': return 'ppt';
    default: return 'pdf';
  }
}

const NOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(md|ipynb)$/;

// Labs live under notes/labs/<Chapter>/ — chapter dirs and file names are
// validated the same way as note names (no separators, no traversal).
const LAB_CHAPTER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const LAB_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ipynb$/;

function validateLabRef(chapter, name) {
  if (!LAB_CHAPTER_RE.test(chapter ?? '') || !LAB_NAME_RE.test(name ?? '')) {
    const err = new Error('Invalid lab reference: chapter must be a plain directory name and name a .ipynb file name without path separators');
    err.status = 400;
    throw err;
  }
}

/** Scan notes/labs/ recursively (.ipynb only, sorted) → {chapters: [...]}. */
async function listLabs(slug) {
  const labsDir = resolveProjectPath(DATA_DIR, slug, 'notes', 'labs');
  let chapterDirs;
  try {
    chapterDirs = (await fsp.readdir(labsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return { chapters: [] };
  }
  const chapters = [];
  for (const chapter of chapterDirs) {
    let files;
    try {
      files = (await fsp.readdir(path.join(labsDir, chapter), { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.ipynb'))
        .map((e) => e.name)
        .sort();
    } catch {
      files = [];
    }
    chapters.push({
      chapter,
      files: files.map((name) => ({ name, path: `labs/${chapter}/${name}` })),
    });
  }
  return { chapters };
}

/** Materials from project.json, annotated with whether the file is on disk. */
async function listMaterials(slug, project) {
  const out = [];
  for (const m of project.materials ?? []) {
    out.push({
      id: m.id,
      label: m.label,
      kind: m.kind,
      // Readable = a renderable PDF is there, or its source document can
      // be converted on first read (a deck whose PDF was deleted
      // re-converts from the PPTX; a Word doc converts on first read).
      hasFile: await materialReadable(slug, m),
      ...(m.sourceUrl ? { sourceUrl: m.sourceUrl } : {}),
    });
  }
  return out;
}

// --- Readable PDFs: a stored .pdf is itself; a Word / PowerPoint
// document converts to a cached PDF beside the source on first read (see
// src/convertDocument.js). The reader, the AI context and the file routes
// all go through here, so a converted document behaves like any PDF.
function convertScratchDir() {
  return path.join(os.tmpdir(), 'nm-convert');
}

async function fileExists(file) {
  try { await fsp.stat(file); return true; } catch { return false; }
}

/** The readable PDF for a stored relative path inside a project. */
async function readablePdfPath(slug, relPath) {
  const input = resolveProjectPath(DATA_DIR, slug, relPath);
  if (/\.pdf$/i.test(relPath)) {
    await fsp.stat(input); // throws ENOENT when gone
    return input;
  }
  if (!isConvertibleDoc(input)) {
    const err = new Error(`not a readable document: ${relPath}`);
    err.status = 422;
    throw err;
  }
  const r = await ensurePdf(input, { scratch: convertScratchDir() });
  if (!r.ok) {
    const err = new Error(r.error);
    err.status = 422;
    if (r.code) err.code = r.code;
    throw err;
  }
  return r.path;
}

/** A material is readable when its renderable file exists, or when its
    source document can be converted (a deck whose PDF was deleted
    re-converts from the PPTX; a Word doc converts on first read). */
async function materialReadable(slug, material) {
  if (material.file && await fileExists(resolveProjectPath(DATA_DIR, slug, material.file))) return true;
  if (material.sourceFile && isConvertibleDoc(material.sourceFile)) {
    return fileExists(resolveProjectPath(DATA_DIR, slug, material.sourceFile));
  }
  return false;
}

/** The readable PDF for a material: its `file` when that is a PDF, else a
    conversion of its source document (the deck scheme: file = converted
    PDF, sourceFile = original PPTX/DOCX — a missing PDF re-converts). */
async function materialPdfPath(slug, material) {
  if (material.file) {
    if (/\.pdf$/i.test(material.file)) {
      try {
        return await readablePdfPath(slug, material.file);
      } catch (err) {
        if (err.code !== 'ENOENT' || !material.sourceFile) throw err;
        // The converted PDF is gone but the source document is there:
        // fall through and re-convert it.
      }
    } else {
      return readablePdfPath(slug, material.file);
    }
  }
  if (material.sourceFile) return readablePdfPath(slug, material.sourceFile);
  const err = new Error('material has no readable file');
  err.status = 404;
  throw err;
}

function validateNoteName(name) {
  if (typeof name !== 'string' || !NOTE_NAME_RE.test(name) || name.includes('..')) {
    const err = new Error('Invalid note name: must be a .md or .ipynb file name without path separators');
    err.status = 400;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/projects', async (_req, res, next) => {
  try {
    let slugs = [];
    try {
      slugs = (await fsp.readdir(projectsDir())).sort();
    } catch {
      slugs = [];
    }
    const out = [];
    for (const slug of slugs) {
      try {
        const project = await readProject(slug);
        out.push(publicProject(project, await listNoteFiles(slug)));
      } catch {
        // Skip directories without a readable project.json.
      }
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
});

app.post('/api/projects', upload.single('file'), async (req, res, next) => {
  try {
    const isMultipart = !!req.file || req.is('multipart/form-data');
    let title;
    let kind;
    let sourceType;
    let sourceUrl;
    let fileName;

    if (isMultipart) {
      title = (req.body.title || '').trim();
      kind = (req.body.kind || '').trim() || undefined;
      if (!title) return res.status(400).json({ error: 'title is required' });
      if (!req.file) return res.status(400).json({ error: 'file upload or url is required' });
      sourceType = 'file';
      const ext = path.extname(req.file.originalname || '').toLowerCase() || '.bin';
      fileName = `source${ext}`;
      kind = kind || inferKindFromExt(ext);
    } else {
      ({ title, kind, url: sourceUrl } = req.body ?? {});
      title = (title || '').trim();
      if (!title) return res.status(400).json({ error: 'title is required' });
      if (!sourceUrl) {
        // Name-only project (user 2026-11-13): no source yet — the
        // Management page adds it. kind stays null, sourceType 'none'.
        kind = null;
        sourceType = 'none';
      } else {
        if (typeof sourceUrl !== 'string') {
          return res.status(400).json({ error: 'url is required for URL projects' });
        }
        try {
          new URL(sourceUrl);
        } catch {
          return res.status(400).json({ error: 'url is not a valid URL' });
        }
        sourceType = 'url';
        kind = kind || inferKindFromUrl(sourceUrl) || 'pdf';
      }
    }

    const slug = await uniqueSlug(slugify(title));
    const dir = path.join(projectsDir(), slug);
    const notesDir = path.join(dir, 'notes');
    await fsp.mkdir(notesDir, { recursive: true });

    if (isMultipart) {
      await fsp.writeFile(path.join(dir, fileName), req.file.buffer);
    }

    const now = new Date().toISOString();
    const project = {
      slug,
      title,
      author: null,
      kind,
      sourceType,
      ...(sourceType === 'file' ? { file: fileName } : sourceType === 'url' ? { sourceUrl } : {}),
      cover: null,
      materials: [],
      chapterMap: {},
      links: [],
      createdAt: now,
      updatedAt: now,
    };
    await fsp.writeFile(
      path.join(dir, 'project.json'),
      JSON.stringify(project, null, 2) + '\n',
      'utf8',
    );
    await fsp.writeFile(
      path.join(notesDir, 'notes.md'),
      `# ${title}\n\n## Notes\n`,
      'utf8',
    );
    res.status(201).json(publicProject(project, ['notes.md']));
  } catch (err) {
    next(err);
  }
});

app.get('/api/projects/:slug', async (req, res, next) => {
  try {
    const project = await readProject(req.params.slug);
    // Lazy revert migration (best-effort, never fails the read): a project
    // still on per-chapter files folds back into the single master here.
    try {
      await migrateNotesToMaster(req.params.slug);
    } catch (err) {
      console.warn(`notes migration for ${req.params.slug}: ${err.message}`);
    }
    // Lazy Labs-section backfill (best-effort, never fails the read):
    // a pre-sections project gains its Labs section from the labs on
    // disk the first time it is read; afterwards it is a no-op.
    let backfilledSections = null;
    try {
      backfilledSections = await backfillLabsSection(req.params.slug);
    } catch (err) {
      console.warn(`labs backfill for ${req.params.slug}: ${err.message}`);
    }
    res.json({
      ...project,
      ...(backfilledSections ? { sections: backfilledSections } : {}),
      materials: project.materials ?? [],
      noteFiles: await listNoteFiles(req.params.slug),
    });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// Explicit revert migration (same work as the lazy hook above, but the
// caller sees the summary). Safe to call repeatedly — a second run is a
// no-op ({migrated: 'none'}).
app.post('/api/projects/:slug/notes/migrate', async (req, res, next) => {
  try {
    await readProject(req.params.slug);
    const summary = await migrateNotesToMaster(req.params.slug);
    res.json(summary);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

app.get('/api/projects/:slug/file', async (req, res, next) => {
  try {
    const project = await readProject(req.params.slug);
    if (project.sourceType === 'url') {
      if (!project.sourceUrl) return res.status(404).json({ error: 'no source URL' });
      return res.redirect(302, project.sourceUrl);
    }
    if (!project.file) return res.status(404).json({ error: 'no source file' });
    // A Word document as the main source converts lazily to a cached PDF
    // beside it, so it reads like any PDF project.
    let filePath;
    try {
      filePath = await readablePdfPath(req.params.slug, project.file);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'project or file not found' });
      if (err.status === 422) return res.status(422).json({ error: err.message });
      throw err;
    }
    // res.sendFile honours Range requests, which pdf.js needs.
    res.sendFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project or file not found' });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Materials — extra renderable sources for a project (e.g. lecture-slide
// PDFs), declared in project.json `materials[]`. The main source stays the
// `source`/`file` field; materials are the secondary readers.
// ---------------------------------------------------------------------------

app.get('/api/projects/:slug/materials', async (req, res, next) => {
  try {
    const project = await readProject(req.params.slug);
    res.json(await listMaterials(req.params.slug, project));
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

app.get('/api/projects/:slug/materials/:id/file', async (req, res, next) => {
  try {
    const project = await readProject(req.params.slug);
    const material = (project.materials ?? []).find((m) => m.id === req.params.id);
    if (!material) return res.status(404).json({ error: 'material not found' });
    let filePath;
    try {
      filePath = await materialPdfPath(req.params.slug, material);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'project or file not found' });
      if (err.status === 404) return res.status(404).json({ error: err.message });
      if (err.status === 422) return res.status(422).json({ error: err.message });
      throw err;
    }
    // Same Range-supporting pattern as the main file route.
    res.sendFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project or file not found' });
    next(err);
  }
});

// Add a material to a project: a PDF, Word document or PowerPoint file.
// Word/PowerPoint convert lazily to a cached PDF beside the source (same
// scheme as the seeded decks: file = converted PDF, sourceFile =
// original), so the new material reads, anchors and jumps like any PDF.
// Returns 201 with the material entry (same shape as GET /materials).
app.post('/api/projects/:slug/materials', upload.single('file'), async (req, res, next) => {
  try {
    const project = await readProject(req.params.slug);
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    const isPdf = ext === '.pdf';
    const isDoc = ext === '.docx' || ext === '.doc';
    const isPpt = ext === '.pptx' || ext === '.ppt';
    if (!isPdf && !isDoc && !isPpt) {
      return res.status(400).json({ error: 'only PDF, Word (.docx/.doc) and PowerPoint (.pptx/.ppt) files can be added as materials' });
    }
    const label = (req.body.label || '').trim() || path.basename(req.file.originalname, ext) || 'Material';
    const existing = new Set((project.materials ?? []).map((m) => m.id));
    const base = slugify(label) || 'material';
    let id = base;
    for (let n = 2; existing.has(id); n++) id = `${base}-${n}`;
    const dir = path.join(projectsDir(), req.params.slug, 'materials');
    await fsp.mkdir(dir, { recursive: true });
    const storedName = `${id}${ext}`;
    await fsp.writeFile(path.join(dir, storedName), req.file.buffer);
    const entry = {
      id,
      label,
      kind: isPpt ? 'slides' : 'pdf',
      ...(isPdf
        ? { file: `materials/${storedName}` }
        : { file: `materials/${id}.pdf`, sourceFile: `materials/${storedName}` }),
    };
    project.materials = [...(project.materials ?? []), entry];
    await writeProject(req.params.slug, project);
    const created = (await listMaterials(req.params.slug, project)).find((m) => m.id === id);
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Labs — Python notebooks fetched as-is from the book's repo, stored under
// notes/labs/<Chapter>/. Contents are existing material, never AI-written.
// ---------------------------------------------------------------------------

app.get('/api/projects/:slug/labs', async (req, res, next) => {
  try {
    await readProject(req.params.slug);
    res.json(await listLabs(req.params.slug));
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

app.get('/api/projects/:slug/labs/:chapter/:name', async (req, res, next) => {
  try {
    validateLabRef(req.params.chapter, req.params.name);
    const file = resolveProjectPath(
      DATA_DIR, req.params.slug, 'notes', 'labs', req.params.chapter, req.params.name,
    );
    const content = await fsp.readFile(file, 'utf8');
    try {
      parseNotebook(content); // stored labs must be valid notebooks
    } catch (e) {
      return res.status(400).json({ error: `stored lab is not a valid notebook: ${e.message}` });
    }
    res.json({ name: req.params.name, content });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'lab not found' });
    next(err);
  }
});

app.put('/api/projects/:slug/labs/:chapter/:name', async (req, res, next) => {
  try {
    validateLabRef(req.params.chapter, req.params.name);
    const { content } = req.body ?? {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content (string) is required' });
    }
    try {
      parseNotebook(content); // same notebook validation as the notes helpers
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const file = resolveProjectPath(
      DATA_DIR, req.params.slug, 'notes', 'labs', req.params.chapter, req.params.name,
    );
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
    const project = await readProject(req.params.slug);
    await writeProject(req.params.slug, project); // bump updatedAt
    res.json({ name: req.params.name, content });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Sections — user-addable groups of STATIC notebooks on the Management
// page (project.json `sections[]`). The Labs section is one section among
// others, written by the seed through the same structure. Sections and
// the notebooks in them are NON-DELETABLE by design (his original spec):
// there is deliberately no delete/rename/move endpoint here.
// A section notebook is one file on disk; the entry records its
// project-relative path, so the Labs section's entries keep pointing at
// notes/labs/<Chapter>/ while user-added ones live under
// notes/sections/<section-id>/.
// ---------------------------------------------------------------------------

/** Sections of a project, normalized (malformed entries dropped). */
function getSections(project) {
  return normalizeSections(project?.sections ?? []);
}

function validateSectionId(id) {
  if (!SECTION_ID_RE.test(id ?? '')) {
    const err = new Error('Invalid section id');
    err.status = 400;
    throw err;
  }
}

function validateSectionNotebookName(name) {
  if (!SECTION_NOTEBOOK_NAME_RE.test(name ?? '')) {
    const err = new Error('Invalid notebook name: must be a .ipynb file name without path separators');
    err.status = 400;
    throw err;
  }
}

/** A new notebook the way the + menu builds one: one empty code cell,
    language in kernelspec + language_info. Same shape as the frontend's
    createIpynbNote. */
function newSectionNotebook(lang) {
  return {
    cells: [{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [] }],
    metadata: { kernelspec: { display_name: lang, language: lang, name: lang }, language_info: { name: lang } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

/** The section + entry for a section-notebook request, or a 404. */
async function sectionNotebookEntry(slug, sectionId, name) {
  validateSectionId(sectionId);
  validateSectionNotebookName(name);
  const project = await readProject(slug);
  const sections = getSections(project);
  const section = findSection(sections, sectionId);
  if (!section) {
    const err = new Error('section not found');
    err.status = 404;
    throw err;
  }
  const entry = section.notebooks.find((n) => n.name === name);
  if (!entry) {
    const err = new Error('notebook not found in this section');
    err.status = 404;
    throw err;
  }
  return { project, sections, section, entry };
}

app.post('/api/projects/:slug/sections', async (req, res, next) => {
  try {
    const project = await readProject(req.params.slug);
    const sections = getSections(project);
    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const name = rawName || nextSectionName(sections); // default: "Section 1", "Section 2", …
    if (name.length > 120) {
      return res.status(400).json({ error: 'section name is too long (max 120 characters)' });
    }
    const section = { id: sectionIdFor(name, sections), name, notebooks: [] };
    project.sections = [...sections, section];
    await writeProject(req.params.slug, project);
    res.status(201).json(section);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// Add a static notebook to a section — BOTH ways (his answer 2026-11-13):
// (a) multipart upload of an existing .ipynb file; (b) JSON {name,
// language} creating a new notebook in the section. A name already in
// the section (or a file already on disk there) is a 409, never an
// overwrite.
app.post('/api/projects/:slug/sections/:sectionId/notebooks', upload.single('file'), async (req, res, next) => {
  try {
    validateSectionId(req.params.sectionId);
    const project = await readProject(req.params.slug);
    const sections = getSections(project);
    const section = findSection(sections, req.params.sectionId);
    if (!section) return res.status(404).json({ error: 'section not found' });

    let name;
    let nb;
    let language = null;
    if (req.file) {
      name = req.file.originalname || '';
      if (!name.toLowerCase().endsWith('.ipynb')) {
        return res.status(400).json({ error: 'only .ipynb files can be added as notebooks' });
      }
      validateSectionNotebookName(name);
      try {
        nb = parseNotebook(req.file.buffer.toString('utf8'));
      } catch (e) {
        return res.status(400).json({ error: `uploaded file is not a valid notebook: ${e.message}` });
      }
      language = notebookLanguageOfObject(nb);
    } else {
      const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!rawName) return res.status(400).json({ error: 'name is required' });
      name = rawName.endsWith('.ipynb') ? rawName : `${rawName}.ipynb`;
      validateSectionNotebookName(name);
      const lang = typeof req.body?.language === 'string' ? req.body.language.toLowerCase() : '';
      if (!SECTION_LANGUAGES.includes(lang)) {
        return res.status(400).json({ error: `language must be one of: ${SECTION_LANGUAGES.join(', ')}` });
      }
      nb = newSectionNotebook(lang);
      language = lang;
    }

    if (section.notebooks.some((n) => n.name === name)) {
      return res.status(409).json({ error: `a notebook named ${name} is already in this section` });
    }
    const relPath = `${SECTION_NOTEBOOKS_DIR}/${section.id}/${name}`;
    const file = resolveProjectPath(DATA_DIR, req.params.slug, ...relPath.split('/'));
    if (await fileExists(file)) {
      return res.status(409).json({ error: `a file named ${name} already exists in this section` });
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(nb, null, 2), 'utf8');
    const entry = { name, path: relPath, ...(language ? { language } : {}) };
    section.notebooks.push(entry);
    project.sections = sections;
    await writeProject(req.params.slug, project);
    res.status(201).json(entry);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

app.get('/api/projects/:slug/sections/:sectionId/notebooks/:name', async (req, res, next) => {
  try {
    const { entry } = await sectionNotebookEntry(req.params.slug, req.params.sectionId, req.params.name);
    const file = resolveProjectPath(DATA_DIR, req.params.slug, ...entry.path.split('/'));
    const content = await fsp.readFile(file, 'utf8');
    try {
      parseNotebook(content); // stored section notebooks must be valid notebooks
    } catch (e) {
      return res.status(400).json({ error: `stored notebook is not a valid notebook: ${e.message}` });
    }
    res.json({ name: entry.name, path: entry.path, content });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'notebook not found' });
    next(err);
  }
});

app.put('/api/projects/:slug/sections/:sectionId/notebooks/:name', async (req, res, next) => {
  try {
    const { entry } = await sectionNotebookEntry(req.params.slug, req.params.sectionId, req.params.name);
    const { content } = req.body ?? {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content (string) is required' });
    }
    try {
      parseNotebook(content);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const file = resolveProjectPath(DATA_DIR, req.params.slug, ...entry.path.split('/'));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
    const project = await readProject(req.params.slug);
    await writeProject(req.params.slug, project); // bump updatedAt
    res.json({ name: entry.name, path: entry.path, content });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// AI import — STRUCTURE ONLY. The LLM proposes a chapter outline, a note
// skeleton (## headings with EMPTY bodies), and the chapter→note mapping.
// It never writes note content: markdown notes are the user's own writing.
// propose writes nothing; apply writes the project from a validated proposal.
// ---------------------------------------------------------------------------

app.post('/api/import/ai/propose', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file (PDF) is required' });
    const title = (req.body.title || '').trim()
      || (req.file.originalname || 'Untitled').replace(/\.pdf$/i, '');
    let extracted;
    try {
      extracted = await extractPdfText(req.file.buffer);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    let proposal;
    try {
      proposal = await proposeProjectData({ kind: 'pdf', title, text: extracted.text },
        { log: { feature: 'ai-import', instruction: title } });
    } catch (err) {
      if (err.code === LLM_NOT_CONFIGURED) {
        return res.status(503).json({ error: 'LLM not configured', hint: err.hint });
      }
      if (err.code === 'LLM_BAD_RESPONSE') {
        return res.status(err.status || 400).json({ error: err.message, rawText: err.rawText });
      }
      throw err;
    }
    try {
      proposal = validateProposal(proposal);
    } catch (err) {
      return res.status(400).json({ error: err.message, rawText: JSON.stringify(proposal) });
    }
    // Proposal only — nothing is written to data/ by this endpoint.
    res.json({ ...proposal, title, pagesExtracted: extracted.pages.length, numPages: extracted.numPages });
  } catch (err) {
    next(err);
  }
});

app.post('/api/import/ai/apply', upload.single('file'), async (req, res, next) => {
  try {
    const title = (req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!req.file) return res.status(400).json({ error: 'file (PDF) is required' });
    if (!req.file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      return res.status(400).json({ error: 'file must be a PDF' });
    }
    let rawProposal;
    try {
      rawProposal = JSON.parse(req.body.proposal || '');
    } catch {
      return res.status(400).json({ error: 'proposal must be valid JSON' });
    }
    let proposal;
    try {
      proposal = validateProposal(rawProposal);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const slug = slugify(title);
    try {
      await fsp.stat(path.join(projectsDir(), slug));
      return res.status(409).json({ error: 'a project with this slug already exists', slug });
    } catch {
      // Slug free — create below.
    }
    const dir = path.join(projectsDir(), slug);
    const notesDir = path.join(dir, 'notes');
    await fsp.mkdir(notesDir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'source.pdf'), req.file.buffer);
    const now = new Date().toISOString();
    const project = {
      slug,
      title,
      author: null,
      kind: 'pdf',
      sourceType: 'file',
      file: 'source.pdf',
      cover: null,
      materials: [],
      outline: proposal.outline,
      chapterMap: proposal.chapterMap,
      links: [],
      createdAt: now,
      updatedAt: now,
    };
    await fsp.writeFile(
      path.join(dir, 'project.json'),
      JSON.stringify(project, null, 2) + '\n',
      'utf8',
    );
    // notes.md IS the skeleton: headings with empty bodies, nothing else.
    const skeleton = proposal.noteSkeleton.endsWith('\n')
      ? proposal.noteSkeleton : `${proposal.noteSkeleton}\n`;
    await fsp.writeFile(path.join(notesDir, 'notes.md'), skeleton, 'utf8');
    res.status(201).json({ project: { ...project, noteFiles: ['notes.md'] } });
  } catch (err) {
    next(err);
  }
});

// Whether notes.md still holds only what project creation wrote — the guard
// that lets AI import apply into a name-only project without ever
// overwriting the user's own writing.
function isDefaultNotesMd(text, title) {
  if (text == null) return true;
  const trimmed = text.trim();
  return trimmed === '' || trimmed === `# ${title}` || trimmed === `# ${title}\n\n## Notes`;
}

// Set the main source of a name-only project (Management page). One-shot:
// once a source exists the endpoint refuses (409) — the source defines the
// project and is not swapped from inside it.
app.post('/api/projects/:slug/source', upload.single('file'), async (req, res, next) => {
  try {
    const project = await readProject(req.params.slug);
    if (project.file || project.sourceUrl) {
      return res.status(409).json({ error: 'project already has a source' });
    }
    let kind;
    if (req.file) {
      const ext = path.extname(req.file.originalname || '').toLowerCase();
      if (!/\.(pdf|docx|doc|mp4|webm|mov|mkv|m4v|ppt|pptx|key)$/i.test(ext)) {
        return res.status(400).json({ error: 'unsupported file type' });
      }
      kind = inferKindFromExt(ext);
      const fileName = `source${ext}`;
      await fsp.writeFile(resolveProjectPath(DATA_DIR, req.params.slug, fileName), req.file.buffer);
      project.file = fileName;
    } else if (req.body?.url) {
      const sourceUrl = String(req.body.url);
      try {
        new URL(sourceUrl);
      } catch {
        return res.status(400).json({ error: 'url is not a valid URL' });
      }
      kind = inferKindFromUrl(sourceUrl) || 'pdf';
      project.sourceUrl = sourceUrl;
    } else {
      return res.status(400).json({ error: 'file upload or url is required' });
    }
    project.kind = kind;
    project.sourceType = req.file ? 'file' : 'url';
    await writeProject(req.params.slug, project);
    res.status(200).json(project);
  } catch (err) {
    next(err);
  }
});

// AI import into an EXISTING name-only project: same proposal validation and
// skeleton-only write as the create-flow apply, but it sets the source on
// the project instead of creating one. Refuses (409) if the project already
// has a source, or if notes.md holds anything beyond the creation default.
app.post('/api/projects/:slug/import/ai/apply', upload.single('file'), async (req, res, next) => {
  try {
    const project = await readProject(req.params.slug);
    if (project.file || project.sourceUrl) {
      return res.status(409).json({ error: 'project already has a source' });
    }
    if (!req.file) return res.status(400).json({ error: 'file (PDF) is required' });
    if (!req.file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      return res.status(400).json({ error: 'file must be a PDF' });
    }
    let rawProposal;
    try {
      rawProposal = JSON.parse(req.body.proposal || '');
    } catch {
      return res.status(400).json({ error: 'proposal is not valid JSON' });
    }
    let proposal;
    try {
      proposal = validateProposal(rawProposal);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const current = await readNotesMd(req.params.slug);
    if (!isDefaultNotesMd(current, project.title)) {
      return res.status(409).json({ error: 'notes.md already has content' });
    }
    const dir = path.join(projectsDir(), req.params.slug);
    const notesDir = path.join(dir, 'notes');
    await fsp.mkdir(notesDir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'source.pdf'), req.file.buffer);
    project.kind = 'pdf';
    project.sourceType = 'file';
    project.file = 'source.pdf';
    project.outline = proposal.outline;
    project.chapterMap = proposal.chapterMap;
    await writeProject(req.params.slug, project);
    // notes.md IS the skeleton: headings with empty bodies, nothing else.
    const skeleton = proposal.noteSkeleton.endsWith('\n')
      ? proposal.noteSkeleton : `${proposal.noteSkeleton}\n`;
    await fsp.writeFile(path.join(notesDir, 'notes.md'), skeleton, 'utf8');
    res.status(200).json({ project: { ...project, noteFiles: ['notes.md'] } });
  } catch (err) {
    next(err);
  }
});

// Project Markdown export: one ZIP with a top folder named after the slug —
// notes.md + owned markdown notes verbatim (anchor comment lines stay in
// place), owned notebooks converted to markdown, and the notes/assets/
// folder so `assets/<file>` links resolve in Obsidian. Seeded lab
// notebooks and source PDFs/decks are NOT bundled (see SUMMARY).
app.get('/api/projects/:slug/export', async (req, res, next) => {
  try {
    const slug = req.params.slug;
    await readProject(slug);
    const zip = createZip();
    const root = slug;
    const notesMd = await readNotesMd(slug);
    if (notesMd != null) zip.addFile(`${root}/notes.md`, notesMd);
    for (const name of await listNoteFiles(slug)) {
      if (name === LEGACY_NOTES_FILE) continue;
      const filePath = resolveProjectPath(DATA_DIR, slug, 'notes', name);
      if (name.endsWith('.md')) {
        zip.addFile(`${root}/${name}`, await fsp.readFile(filePath, 'utf8'));
      } else if (name.endsWith('.ipynb')) {
        const nb = parseNotebook(await fsp.readFile(filePath, 'utf8'));
        const stem = name.replace(/\.ipynb$/i, '');
        const { markdown, images } = notebookToMarkdown({ notebook: nb, name });
        zip.addFile(`${root}/${stem}.md`, markdown);
        for (const img of images) {
          zip.addFile(`${root}/assets/${img.fileName}`, Buffer.from(img.base64, 'base64'));
        }
      }
    }
    const assetsDir = resolveProjectPath(DATA_DIR, slug, 'notes', 'assets');
    try {
      const assetNames = (await fsp.readdir(assetsDir))
        .filter((n) => /\.(png|jpe?g)$/i.test(n)).sort();
      for (const n of assetNames) {
        zip.addFile(`${root}/assets/${n}`, await fsp.readFile(path.join(assetsDir, n)));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const buf = zip.toBuffer();
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${slug}-export.zip"`);
    res.set('Content-Length', String(buf.length));
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Admin — AI call log (AV admin.html model), full-data export / import,
// and the browser-sync log. Local only; the AI call log and sync log are
// never part of a data export.
// ---------------------------------------------------------------------------

// AI calls, newest first, paged (limit default 20, max 200).
app.get('/api/admin/ai-calls', async (req, res, next) => {
  try {
    const limit = Number.parseInt(req.query.limit, 10);
    const offset = Number.parseInt(req.query.offset, 10);
    res.json(readAiCalls({
      limit: Number.isFinite(limit) ? limit : 20,
      offset: Number.isFinite(offset) ? offset : 0,
    }, DATA_DIR));
  } catch (err) {
    next(err);
  }
});

// Full-data export: one ZIP of every project (see src/dataExport.js).
app.get('/api/admin/data/export', async (req, res, next) => {
  try {
    const { buffer } = await buildDataExport(DATA_DIR);
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="note-mate-export-${stamp}.zip"`);
    res.set('Content-Length', String(buffer.length));
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// Full-data import: validate fully first, then restore missing projects.
// A slug collision keeps the existing project (skipped, reported).
// An optional `sync` form field carries a sync-download log entry (the
// FM pattern: {direction: 'download', bytes, exported_at}).
app.post('/api/admin/data/import', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file (a note-mate export .zip) is required' });
    const summary = await applyDataImport(DATA_DIR, req.file.buffer);
    if (typeof req.body?.sync === 'string') {
      try {
        const s = JSON.parse(req.body.sync);
        if (s && s.direction === 'download') {
          recordSyncLog({
            direction: 'download',
            status: 'ok',
            bytes: Number.isInteger(s.bytes) ? s.bytes : null,
            exported_at: typeof s.exported_at === 'string' ? s.exported_at : null,
            detail: 'Downloaded from the sync folder.',
          }, DATA_DIR);
        }
      } catch { /* a bad sync field never fails the import */ }
    }
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// Browser-sync log (FM's sync_log shape, file-based).
app.get('/api/admin/data/sync/log', async (req, res, next) => {
  try {
    res.json({ log: listSyncLog(50, DATA_DIR) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/data/sync/log', async (req, res, next) => {
  try {
    const entry = recordSyncLog(req.body ?? {}, DATA_DIR);
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

app.get('/api/projects/:slug/notes', async (req, res, next) => {
  try {
    await readProject(req.params.slug);
    const names = await listNoteFiles(req.params.slug);
    const out = [];
    for (const name of names) {
      const entry = { name, kind: name.endsWith('.ipynb') ? 'ipynb' : 'md' };
      // The Files directory tags notebooks with their language; read it
      // best-effort from the notebook metadata (null when unreadable).
      if (entry.kind === 'ipynb') entry.language = await notebookLanguageOf(req.params.slug, name);
      out.push(entry);
    }
    res.json(out);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

app.get('/api/projects/:slug/notes/:name', async (req, res, next) => {
  try {
    validateNoteName(req.params.name);
    const file = resolveProjectPath(DATA_DIR, req.params.slug, 'notes', req.params.name);
    const content = await fsp.readFile(file, 'utf8');
    res.json({ name: req.params.name, content });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'note not found' });
    next(err);
  }
});

app.put('/api/projects/:slug/notes/:name', async (req, res, next) => {
  try {
    validateNoteName(req.params.name);
    const { content } = req.body ?? {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content (string) is required' });
    }
    const file = resolveProjectPath(DATA_DIR, req.params.slug, 'notes', req.params.name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
    const project = await readProject(req.params.slug);
    await writeProject(req.params.slug, project); // bump updatedAt
    res.json({ name: req.params.name, content });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// Rename a note file on disk. notes.md is the master filing home (+ Note
// here, AI Apply default) and cannot be renamed; the target must not
// already exist. Filing is by content, not filename, so no chapterMap
// change is needed.
app.post('/api/projects/:slug/notes/:name/rename', async (req, res, next) => {
  try {
    validateNoteName(req.params.name);
    const { name } = req.body ?? {};
    if (typeof name !== 'string') {
      return res.status(400).json({ error: 'name (string) is required' });
    }
    validateNoteName(name);
    if (req.params.name === LEGACY_NOTES_FILE) {
      return res.status(400).json({ error: 'notes.md cannot be renamed' });
    }
    const from = resolveProjectPath(DATA_DIR, req.params.slug, 'notes', req.params.name);
    const to = resolveProjectPath(DATA_DIR, req.params.slug, 'notes', name);
    try {
      await fsp.lstat(from);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'note not found' });
      throw err;
    }
    try {
      await fsp.lstat(to);
      return res.status(409).json({ error: 'a note with that name already exists' });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await fsp.rename(from, to);
    // A rename keeps the note's link entries attached to it.
    const notesMd = await retargetNoteLinks(req.params.slug, req.params.name, name);
    const project = await readProject(req.params.slug);
    await writeProject(req.params.slug, project); // bump updatedAt
    res.json({ name, notesMd });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// Delete a note file. notes.md is the master filing home and cannot be
// deleted.
app.delete('/api/projects/:slug/notes/:name', async (req, res, next) => {
  try {
    validateNoteName(req.params.name);
    if (req.params.name === LEGACY_NOTES_FILE) {
      return res.status(400).json({ error: 'notes.md cannot be deleted' });
    }
    const file = resolveProjectPath(DATA_DIR, req.params.slug, 'notes', req.params.name);
    try {
      await fsp.unlink(file);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'note not found' });
      throw err;
    }
    // Cascade: link entries pointing at the deleted file leave notes.md
    // with it (dropping headings left empty by the removal). Bare page
    // anchors and other notes' entries are untouched.
    const notesMd = await cascadeNoteLinks(req.params.slug, req.params.name);
    const project = await readProject(req.params.slug);
    await writeProject(req.params.slug, project); // bump updatedAt
    res.json({ deleted: req.params.name, notesMd });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// Note-link entries in notes.md (user 2026-11-13: master-note anchor →
// note). "+ Note here" creates a note file and files a linked anchor
// under the current chapter; the note editor's anchor control adds /
// removes / re-points entries through these endpoints. notes.md is the
// single source of truth — the note file itself holds no anchor data.
// Every response carries the new notes.md text so the client can sync
// its cache without a second round trip.
async function readNotesMd(slug) {
  try {
    return await fsp.readFile(resolveProjectPath(DATA_DIR, slug, 'notes', LEGACY_NOTES_FILE), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeNotesMd(slug, text) {
  const notesDir = resolveProjectPath(DATA_DIR, slug, 'notes');
  await fsp.mkdir(notesDir, { recursive: true });
  await fsp.writeFile(path.join(notesDir, LEGACY_NOTES_FILE), text, 'utf8');
}

// Remove every link entry for a note file from notes.md (delete cascade).
// Returns the new notes.md text, or null when the project has no notes.md.
async function cascadeNoteLinks(slug, noteName) {
  const current = await readNotesMd(slug);
  if (current == null) return null;
  const { text, removed } = removeNoteLinkEntries(current, noteName);
  if (removed > 0) await writeNotesMd(slug, text);
  return removed > 0 ? text : current;
}

// Retarget a renamed note's link entries. Returns the new notes.md text,
// or null when the project has no notes.md.
async function retargetNoteLinks(slug, from, to) {
  const current = await readNotesMd(slug);
  if (current == null) return null;
  const { text, renamed } = renameNoteLinkEntries(current, from, to);
  if (renamed > 0) await writeNotesMd(slug, text);
  return renamed > 0 ? text : current;
}

// Add one linked entry under `heading` (created on demand). The note file
// must already exist — "+ Note here" creates it first. `headingAnchor` is
// the `<!-- p. N -->` chapter-start line, used only when the heading is
// created here.
app.post('/api/projects/:slug/note-links', async (req, res, next) => {
  try {
    await readProject(req.params.slug);
    const { note, page, sourceId, heading, headingAnchor = null } = req.body ?? {};
    validateNoteName(note);
    if (typeof heading !== 'string' || !heading.trim()) {
      return res.status(400).json({ error: 'heading (string) is required' });
    }
    try {
      formatPageAnchor({ page, sourceId, note });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    try {
      await fsp.lstat(resolveProjectPath(DATA_DIR, req.params.slug, 'notes', note));
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'note not found' });
      throw err;
    }
    let current = await readNotesMd(req.params.slug);
    if (current == null) {
      const project = await readProject(req.params.slug);
      current = `# ${project.title || 'Notes'}\n`;
    }
    const { text, added } = addNoteLinkEntry(current, { heading, headingAnchor, page, sourceId, note });
    if (added) await writeNotesMd(req.params.slug, text);
    res.json({ added, notesMd: text });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// Remove one linked entry ({note, page, sourceId} — the anchor control's ×).
app.post('/api/projects/:slug/note-links/remove', async (req, res, next) => {
  try {
    await readProject(req.params.slug);
    const { note, page, sourceId } = req.body ?? {};
    validateNoteName(note);
    try {
      formatPageAnchor({ page, sourceId, note });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const current = await readNotesMd(req.params.slug);
    if (current == null) return res.status(404).json({ error: 'notes.md not found' });
    const { text, removed } = removeNoteLinkEntries(current, note, { page, sourceId });
    if (removed > 0) await writeNotesMd(req.params.slug, text);
    res.json({ removed, notesMd: text });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// Re-point one entry at the current page, in a single notes.md write:
// remove the old entry, add the new one under `to.heading` (created on
// demand). 404 when the old entry is not there.
app.post('/api/projects/:slug/note-links/repoint', async (req, res, next) => {
  try {
    await readProject(req.params.slug);
    const { note, from, to } = req.body ?? {};
    validateNoteName(note);
    if (!from || !to || typeof to.heading !== 'string' || !to.heading.trim()) {
      return res.status(400).json({ error: 'from, to and to.heading are required' });
    }
    try {
      formatPageAnchor({ page: from.page, sourceId: from.sourceId, note });
      formatPageAnchor({ page: to.page, sourceId: to.sourceId, note });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const current = await readNotesMd(req.params.slug);
    if (current == null) return res.status(404).json({ error: 'notes.md not found' });
    const { text: afterRemove, removed } = removeNoteLinkEntries(current, note, { page: from.page, sourceId: from.sourceId });
    if (removed === 0) return res.status(404).json({ error: 'anchor not found' });
    const { text, added } = addNoteLinkEntry(afterRemove, {
      heading: to.heading, headingAnchor: to.headingAnchor ?? null,
      page: to.page, sourceId: to.sourceId, note,
    });
    await writeNotesMd(req.params.slug, text);
    res.json({ moved: true, added, notesMd: text });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// PDF annotations (highlight + note pin) — one per-project file,
// `annotations.json` beside `notes/`. Separate from notes.md, so the
// master-notes migration never touches them. Rendering is an overlay on
// the pdf.js pages (never baked into the PDF file).
async function readAnnotations(slug) {
  const file = resolveProjectPath(DATA_DIR, slug, ANNOTATIONS_FILE);
  try {
    return parseAnnotationsDoc(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyAnnotationsDoc();
    throw err;
  }
}

async function writeAnnotations(slug, doc) {
  const file = resolveProjectPath(DATA_DIR, slug, ANNOTATIONS_FILE);
  await fsp.writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

app.get('/api/projects/:slug/annotations', async (req, res, next) => {
  try {
    await readProject(req.params.slug);
    const doc = await readAnnotations(req.params.slug);
    res.json({ annotations: doc.annotations });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

app.post('/api/projects/:slug/annotations', async (req, res, next) => {
  try {
    await readProject(req.params.slug);
    let fields;
    try {
      fields = validateAnnotationInput(req.body ?? {});
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const now = new Date().toISOString();
    const annotation = { id: newAnnotationId(), ...fields, createdAt: now, updatedAt: now };
    const doc = await readAnnotations(req.params.slug);
    doc.annotations.push(annotation);
    await writeAnnotations(req.params.slug, doc);
    res.status(201).json({ annotation });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

app.put('/api/projects/:slug/annotations/:id', async (req, res, next) => {
  try {
    await readProject(req.params.slug);
    const doc = await readAnnotations(req.params.slug);
    const idx = doc.annotations.findIndex((a) => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'annotation not found' });
    let fields;
    try {
      // Validate the merged object so partial updates (e.g. text only) work.
      fields = validateAnnotationInput({ ...doc.annotations[idx], ...(req.body ?? {}) });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const annotation = {
      ...doc.annotations[idx], ...fields, updatedAt: new Date().toISOString(),
    };
    doc.annotations[idx] = annotation;
    await writeAnnotations(req.params.slug, doc);
    res.json({ annotation });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

app.delete('/api/projects/:slug/annotations/:id', async (req, res, next) => {
  try {
    await readProject(req.params.slug);
    const doc = await readAnnotations(req.params.slug);
    const idx = doc.annotations.findIndex((a) => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'annotation not found' });
    doc.annotations.splice(idx, 1);
    await writeAnnotations(req.params.slug, doc);
    res.json({ deleted: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// Serve a project's cover image (written by POST .../cover).
// The bookshelf uses this URL as the <img> src; 404 when the project
// has no cover yet (the UI falls back to a title-letter tile).
app.get('/api/projects/:slug/cover', async (req, res, next) => {
  try {
    const project = await readProject(req.params.slug);
    if (!project.cover) return res.status(404).json({ error: 'no cover' });
    const file = resolveProjectPath(DATA_DIR, req.params.slug, 'cover.png');
    res.sendFile(file, { headers: { 'Content-Type': 'image/png' } });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

app.post('/api/projects/:slug/cover', async (req, res, next) => {
  try {
    const { dataUrl } = req.body ?? {};
    const m = typeof dataUrl === 'string'
      && dataUrl.match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) {
      return res.status(400).json({ error: 'dataUrl must be a base64 data: URL for a PNG or JPEG image' });
    }
    const project = await readProject(req.params.slug);
    const file = resolveProjectPath(DATA_DIR, req.params.slug, 'cover.png');
    await fsp.writeFile(file, Buffer.from(m[2], 'base64'));
    project.cover = 'cover.png';
    await writeProject(req.params.slug, project);
    res.json({ cover: 'cover.png' });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

app.post('/api/projects/:slug/chapter-map', async (req, res, next) => {
  try {
    const { mapping } = req.body ?? {};
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      return res.status(400).json({ error: 'mapping (object) is required' });
    }
    const project = await readProject(req.params.slug);
    project.chapterMap = { ...(project.chapterMap ?? {}), ...mapping };
    await writeProject(req.params.slug, project);
    res.json(project);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Shared reading context for the two on-demand AI endpoints (Note AI and
// Code AI): the material currently being read. `source` is null (the book
// PDF) or a material id (a slide deck); `page` is the current page/slide
// (1-based); `chapter` is the current chapter title. Book + chapter title
// -> the chapter's page range (the original ai-note behavior); a deck, or a
// page without a chapter -> the outline section around that page
// (resolvePageRange, which falls back to a small window when the PDF has no
// outline). Returns {text, range, sourceId, sourceLabel, page}, or
// {error: {status, message}} for the route to answer with. Reads no files
// at all when neither a chapter nor a page is given.
// ---------------------------------------------------------------------------

async function buildReadingContext(slug, project, { source, chapter, page }) {
  const sourceId = typeof source === 'string' && source.trim() ? source.trim() : null;
  const chapterTitle = typeof chapter === 'string' ? chapter.trim() : '';
  const pageNum = Number.isInteger(page) && page >= 1 ? page : null;
  if (!chapterTitle && pageNum === null) {
    return { text: '', range: null, sourceId, sourceLabel: project.title, page: null };
  }
  let buf;
  let sourceLabel;
  if (!sourceId) {
    if (String(project.kind).toLowerCase() !== 'pdf' || project.sourceType !== 'file' || !project.file) {
      return { error: { status: 400, message: 'chapter context needs a PDF project with a downloaded file' } };
    }
    try {
      buf = await fsp.readFile(await readablePdfPath(slug, project.file));
    } catch (err) {
      return { error: { status: err.status || 400, message: err.message } };
    }
    sourceLabel = project.title;
  } else {
    const material = (project.materials ?? []).find((m) => m.id === sourceId);
    if (!material) return { error: { status: 400, message: `unknown source: ${sourceId}` } };
    if (!material.file && !material.sourceFile) return { error: { status: 400, message: `source ${sourceId} has no file` } };
    try {
      buf = await fsp.readFile(await materialPdfPath(slug, material));
    } catch (err) {
      return { error: { status: err.status || 400, message: err.message } };
    }
    sourceLabel = material.label || material.id;
  }
  // The chapter's page range comes from an outline — the stored one when
  // the project has it (AI import), otherwise the PDF's own outline
  // (seeded / file-uploaded projects store none; the reader reads the
  // same outline client-side). A page range does not need an outline at
  // all (resolvePageRange falls back to a window), so a missing outline
  // only fails the chapter path.
  let outline = [];
  if (!sourceId && chapterTitle) {
    outline = Array.isArray(project.outline) && project.outline.length ? project.outline : null;
    if (!outline) outline = await extractPdfOutline(buf);
    if (!outline.length) {
      return { error: { status: 400, message: 'this project has no chapter outline — ask without a chapter' } };
    }
  } else if (!sourceId && Array.isArray(project.outline) && project.outline.length) {
    outline = project.outline;
  } else {
    outline = await extractPdfOutline(buf);
  }
  let range = null;
  if (!sourceId && chapterTitle) {
    range = resolveChapterRange(outline, chapterTitle, null);
    if (!range) {
      return { error: { status: 400, message: `chapter not found in the outline: ${chapterTitle}` } };
    }
  } else if (pageNum !== null) {
    range = resolvePageRange(outline, pageNum, null);
  }
  if (!range) {
    return { text: '', range: null, sourceId, sourceLabel, page: pageNum };
  }
  let extracted;
  try {
    extracted = await extractPdfText(buf, {
      startPage: range.startPage,
      endPage: range.endPage ?? Infinity,
      maxPages: MAX_CHAPTER_PAGES,
    });
  } catch (err) {
    return { error: { status: err.status || 400, message: err.message } };
  }
  return {
    text: extracted.text || '',
    range: {
      title: range.title,
      startPage: range.startPage,
      endPage: extracted.pages.length
        ? extracted.pages[extracted.pages.length - 1].page : range.startPage,
    },
    sourceId,
    sourceLabel,
    page: pageNum,
  };
}

// Validate the shared `history` field of the on-demand AI endpoints.
// Returns the cleaned history (each message capped) or throws an Error
// with `status = 400`.
function parseAiHistory(history) {
  if (history === undefined) return [];
  const fail = (msg) => {
    const err = new Error(msg);
    err.status = 400;
    throw err;
  };
  if (!Array.isArray(history)) fail('history must be an array of {role, content}');
  if (history.length > MAX_AI_NOTE_HISTORY_MESSAGES) {
    fail(`history holds at most ${MAX_AI_NOTE_HISTORY_MESSAGES} messages`);
  }
  return history.map((m) => {
    if (!m || typeof m !== 'object' || !['user', 'assistant'].includes(m.role)
      || typeof m.content !== 'string') {
      fail('history entries must be {role: "user"|"assistant", content: string}');
    }
    return { role: m.role, content: m.content.slice(0, MAX_AI_NOTE_HISTORY_CHARS) };
  });
}

// ---------------------------------------------------------------------------
// LLM models — the AI panel's model picker (same pattern as the AV's
// /ai/models): the server reports which models the API key can use, the
// client remembers the choice and sends it with each ai-note / ai-code
// request. AI import keeps using the configured model.
// ---------------------------------------------------------------------------

app.get('/api/llm/models', async (req, res, next) => {
  try {
    res.json(await listModels());
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// On-demand AI notes — the user asks in plain language for markdown notes
// based on the CURRENT chapter; the model returns a PROPOSAL and nothing is
// written until the user presses Apply in the notebook pane (client-side,
// through the notes PUT path). This is the opposite of AI import, which
// generates STRUCTURE ONLY and never note content — see src/aiNote.js.
// Context: the chapter's page range from the project's stored outline,
// extracted server-side from the source PDF (never sent by the client).
// The request may also carry `source` (a deck id — context then comes from
// the deck around `page`) and `page` (the current page/slide).
// ---------------------------------------------------------------------------

app.post('/api/projects/:slug/ai-note', async (req, res, next) => {
  try {
    const { chapter, prompt, includeNote, history, source, page, model } = req.body ?? {};
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt (string) is required' });
    }
    if (model !== undefined && model !== null
      && (typeof model !== 'string' || !(await isAllowedModel(model)))) {
      return res.status(400).json({ error: 'model is not available for this API key' });
    }
    if (prompt.length > MAX_AI_NOTE_PROMPT_CHARS) {
      return res.status(400).json({ error: `prompt exceeds the ${MAX_AI_NOTE_PROMPT_CHARS}-character limit` });
    }
    let cleanHistory;
    try {
      cleanHistory = parseAiHistory(history);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const project = await readProject(req.params.slug);
    const ctx = await buildReadingContext(req.params.slug, project, { source, chapter, page });
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.message });
    let noteSection = '';
    if (includeNote && ctx.range?.title) {
      try {
        const notes = await fsp.readFile(
          resolveProjectPath(DATA_DIR, req.params.slug, 'notes', 'notes.md'), 'utf8');
        noteSection = extractChapterSection(notes, ctx.range.title).slice(0, MAX_AI_NOTE_NOTE_CHARS);
      } catch {
        noteSection = ''; // No notes.md yet — the AI works from the chapter alone.
      }
    }

    let markdown;
    try {
      markdown = await generateAiNote({
        bookTitle: project.title,
        chapter: ctx.range,
        chapterText: ctx.text,
        noteSection,
        prompt: prompt.trim(),
        history: cleanHistory,
        model: typeof model === 'string' && model.trim() ? model.trim() : undefined,
        log: { feature: 'ai-note', instruction: prompt.trim() },
      });
    } catch (err) {
      if (err.code === LLM_NOT_CONFIGURED) {
        return res.status(503).json({ error: 'LLM not configured', hint: err.hint });
      }
      if (err.code === 'LLM_BAD_RESPONSE') {
        return res.status(err.status || 502).json({ error: err.message });
      }
      if (err.status === 400) return res.status(400).json({ error: err.message });
      throw err;
    }
    res.json({ markdown, chapter: ctx.range, source: ctx.sourceId, page: ctx.page, contextChars: ctx.text.length });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// On-demand Code AI — the second tab of the AI panel. Same proposal-only
// rule as ai-note, but the model returns code in the notebook's language
// (Python, Java or JavaScript, via `language` — 'python' when absent) for
// the notebook the user is working in; Apply replaces the pinned target
// cell in place, or appends a new code cell when nothing is pinned
// (client-side, through the notebook PUT path). The request carries the
// active reading source + page (same context rules as ai-note) plus the
// whole notebook's cell sources (`cells`, capped server-side at
// MAX_AI_CODE_CELLS_CHARS) and the pinned cell index (`targetCell`) so
// the model writes code that fits.
// ---------------------------------------------------------------------------

app.post('/api/projects/:slug/ai-code', async (req, res, next) => {
  try {
    const { chapter, prompt, notebook, source, page, cells, targetCell, history, model, language } = req.body ?? {};
    if (language !== undefined && language !== null
      && !AI_CODE_LANGUAGES.includes(String(language).toLowerCase())) {
      return res.status(400).json({ error: 'language must be python, java, or javascript' });
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt (string) is required' });
    }
    if (model !== undefined && model !== null
      && (typeof model !== 'string' || !(await isAllowedModel(model)))) {
      return res.status(400).json({ error: 'model is not available for this API key' });
    }
    if (prompt.length > MAX_AI_CODE_PROMPT_CHARS) {
      return res.status(400).json({ error: `prompt exceeds the ${MAX_AI_CODE_PROMPT_CHARS}-character limit` });
    }
    if (typeof notebook !== 'string' || !notebook.trim() || !/\.ipynb$/i.test(notebook.trim())) {
      return res.status(400).json({ error: 'notebook (an .ipynb path) is required' });
    }
    if (notebook.includes('..')) {
      return res.status(400).json({ error: 'notebook must stay inside the project' });
    }
    if (page !== undefined && page !== null && (!Number.isInteger(page) || page < 1)) {
      return res.status(400).json({ error: 'page must be a positive integer' });
    }
    if (targetCell !== undefined && targetCell !== null
      && (!Number.isInteger(targetCell) || targetCell < 0)) {
      return res.status(400).json({ error: 'targetCell must be a non-negative integer' });
    }
    let cleanHistory;
    try {
      cleanHistory = parseAiHistory(history);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    let notebookCells = '';
    if (cells !== undefined) {
      if (!Array.isArray(cells) || cells.some((c) => typeof c !== 'string')) {
        return res.status(400).json({ error: 'cells must be an array of strings' });
      }
      notebookCells = cells.join('\n\n').slice(0, MAX_AI_CODE_CELLS_CHARS);
    }

    const project = await readProject(req.params.slug);
    const ctx = await buildReadingContext(req.params.slug, project, { source, chapter, page });
    if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.message });

    let result;
    try {
      result = await generateAiCode({
        bookTitle: project.title,
        chapter: ctx.range,
        sourceLabel: ctx.sourceLabel,
        page: ctx.page,
        readingText: ctx.text,
        notebookCells,
        prompt: prompt.trim(),
        hasTargetCell: Number.isInteger(targetCell),
        language: language == null ? undefined : String(language).toLowerCase(),
        history: cleanHistory,
        model: typeof model === 'string' && model.trim() ? model.trim() : undefined,
        log: {
          feature: 'ai-code',
          instruction: prompt.trim(),
          language: language == null ? 'python' : String(language).toLowerCase(),
        },
      });
    } catch (err) {
      if (err.code === LLM_NOT_CONFIGURED) {
        return res.status(503).json({ error: 'LLM not configured', hint: err.hint });
      }
      if (err.code === 'LLM_BAD_RESPONSE') {
        return res.status(err.status || 502).json({ error: err.message });
      }
      if (err.status === 400) return res.status(400).json({ error: err.message });
      throw err;
    }
    res.json({ ...result, chapter: ctx.range, source: ctx.sourceId, page: ctx.page, contextChars: ctx.text.length });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Export selected notebook cells to Markdown — DETERMINISTIC, no LLM.
// The client sends the notebook JSON (exactly what the user sees, saved or
// not) + the selected cell indexes. Plot PNGs are written as files under
// notes/assets/ (content-hash deduped: re-exporting unchanged content
// reuses the same file) and referenced with relative assets/... links.
// The endpoint returns the markdown; the client previews it and either
// inserts it into notes.md (notes PUT path) or downloads it as .md.
// ---------------------------------------------------------------------------

app.post('/api/projects/:slug/export-cells', async (req, res, next) => {
  try {
    await readProject(req.params.slug); // 404 before anything is written
    const { notebook, name, cells } = req.body ?? {};
    if (typeof notebook !== 'object' || notebook === null || Array.isArray(notebook)) {
      return res.status(400).json({ error: 'notebook (object) is required' });
    }
    let nb;
    try {
      nb = parseNotebook(JSON.stringify(notebook));
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.ipynb$/.test(name)) {
      return res.status(400).json({ error: 'name must be a .ipynb file name without path separators' });
    }
    if (!Array.isArray(cells) || cells.length === 0) {
      return res.status(400).json({ error: 'select at least one cell to export' });
    }
    for (const i of cells) {
      if (!Number.isInteger(i) || i < 0 || i >= nb.cells.length) {
        return res.status(400).json({ error: `cell index out of range: ${i}` });
      }
    }
    let rendered;
    try {
      rendered = cellsToMarkdown({ notebook: nb, name, indices: cells });
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    // Write plot PNGs (dedupe: same content-hash name already on disk wins).
    const assetsDir = resolveProjectPath(DATA_DIR, req.params.slug, 'notes', 'assets');
    await fsp.mkdir(assetsDir, { recursive: true });
    const images = [];
    for (const img of rendered.images) {
      const file = path.join(assetsDir, img.fileName);
      try {
        await fsp.stat(file); // already there — same hash means same bytes
      } catch {
        await fsp.writeFile(file, Buffer.from(img.base64, 'base64'));
      }
      images.push({ cellIndex: img.cellIndex, fileName: img.fileName, path: `assets/${img.fileName}` });
    }
    res.json({ markdown: rendered.markdown, images, cells: cells.length });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// Upload a pasted screenshot (or any PNG/JPEG image) into notes/assets/.
// Body is JSON {dataUrl} — the same base64 pattern as the cover upload.
// The file name is content-hash deduped (pasted-<hash8>.<ext>): pasting
// the same screenshot twice reuses one file, and the name is server-chosen
// so no client-supplied name can traverse. The client inserts the returned
// `assets/<fileName>` reference into the note; previews resolve it through
// the asset route below.
const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;
app.post('/api/projects/:slug/assets', async (req, res, next) => {
  try {
    const { dataUrl } = req.body ?? {};
    const m = typeof dataUrl === 'string'
      && dataUrl.match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) {
      return res.status(400).json({ error: 'dataUrl must be a base64 data: URL for a PNG or JPEG image' });
    }
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_PASTED_IMAGE_BYTES) {
      return res.status(413).json({ error: 'image is too large (max 10 MB)' });
    }
    await readProject(req.params.slug); // 404 before writing anything
    const ext = m[1] === 'png' ? 'png' : 'jpg';
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
    const fileName = `pasted-${hash}.${ext}`;
    const assetsDir = resolveProjectPath(DATA_DIR, req.params.slug, 'notes', 'assets');
    await fsp.mkdir(assetsDir, { recursive: true });
    const file = path.join(assetsDir, fileName);
    try {
      await fsp.stat(file); // already there — same hash means same bytes
    } catch {
      await fsp.writeFile(file, buf);
    }
    res.json({ fileName, path: `assets/${fileName}` });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project not found' });
    next(err);
  }
});

// Serve an asset file written by the cell export or the paste upload
// (notes/assets/<file>). PNG or JPEG only; file names are content-hash
// suffixed by the writing route, so a name that exists is a file the app
// wrote. The markdown itself keeps relative assets/... links (portable for
// download); the app's previews rewrite those links to this route at
// render time.
app.get('/api/projects/:slug/assets/:file', async (req, res, next) => {
  try {
    const file = req.params.file;
    const m = file.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\.(png|jpe?g)$/);
    if (!m) {
      return res.status(400).json({ error: 'asset file must be a .png or .jpg file name' });
    }
    await readProject(req.params.slug); // 404 before touching the disk
    const abs = resolveProjectPath(DATA_DIR, req.params.slug, 'notes', 'assets', file);
    res.type(m[2] === 'png' ? 'image/png' : 'image/jpeg');
    res.sendFile(abs);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'asset not found' });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Code execution — runs in a fresh temp dir, 30s timeout, dir deleted after.
// Single-cell mode runs one snippet in isolation. Cells mode (POST
// /api/execute with {language, cells: [{source}]}) runs cells 0..N in ONE
// shared session via src/pythonRunner.py / src/jsRunner.mjs, returning
// per-cell {stdout, stderr, exitCode, images, skipped}; a cell that raises
// stops the run and later cells are skipped. Java has no cells mode.
// v1 limitation: no network sandboxing. See README.md.
// ---------------------------------------------------------------------------

const LANGUAGES = new Set(['python', 'java', 'javascript']);

async function runCommand(cmd, args, cwd, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? (err.killed ? `Timed out after ${EXEC_TIMEOUT_MS / 1000}s\n` : String(err.message)),
      exitCode: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

app.post('/api/execute', async (req, res, next) => {
  try {
    const { language, code, cells } = req.body ?? {};
    if (!LANGUAGES.has(language)) {
      return res.status(400).json({ error: 'language must be python, java, or javascript' });
    }

    // ---- run-all / run-above mode: cells 0..N in ONE shared session ----
    // python → src/pythonRunner.py (one process, shared namespace, per-cell
    // stdout/stderr/images; plt.show() saves figures as PNGs).
    // javascript → src/jsRunner.mjs (one node process, cells concatenated
    // into a single module, outputs split back per cell on markers).
    // java has no run-all: cells cannot be concatenated into one program.
    if (cells !== undefined) {
      if (language === 'java') {
        return res.status(400).json({
          error: 'run-all is not supported for java: cells cannot share one session — run each cell on its own',
        });
      }
      if (!Array.isArray(cells) || cells.length === 0) {
        return res.status(400).json({ error: 'cells must be a non-empty array of {source}' });
      }
      if (cells.length > MAX_RUN_ALL_CELLS) {
        return res.status(400).json({ error: `at most ${MAX_RUN_ALL_CELLS} cells per run` });
      }
      const sources = [];
      let total = 0;
      for (const c of cells) {
        const src = typeof c === 'string' ? c : c?.source;
        if (typeof src !== 'string' || !src.trim()) {
          return res.status(400).json({ error: 'each cell needs a non-empty source string' });
        }
        total += Buffer.byteLength(src, 'utf8');
        if (total > MAX_RUN_ALL_TOTAL_BYTES) {
          return res.status(400).json({
            error: `cells exceed the ${MAX_RUN_ALL_TOTAL_BYTES / 1024 / 1024}MB total limit`,
          });
        }
        sources.push(src);
      }

      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'note-mate-exec-'));
      try {
        await fsp.writeFile(
          path.join(dir, 'cells.json'),
          JSON.stringify(sources.map((source) => ({ source }))),
          'utf8',
        );
        const runnerName = language === 'python' ? 'pythonRunner.py' : 'jsRunner.mjs';
        const runnerPath = fileURLToPath(new URL(`./${runnerName}`, import.meta.url));
        const cmd = language === 'python' ? 'python3' : 'node';
        const run = await runCommand(cmd, [runnerPath, 'cells.json', 'results.json'], dir, { MPLBACKEND: 'Agg' });
        let parsed;
        try {
          parsed = JSON.parse(await fsp.readFile(path.join(dir, 'results.json'), 'utf8'));
        } catch {
          const err = new Error(
            `execution runner failed: ${(run.stderr || run.stdout || 'no output').slice(0, 500)}`,
          );
          err.status = 500;
          throw err;
        }
        if (!parsed || !Array.isArray(parsed.results) || parsed.results.length !== sources.length) {
          const err = new Error('execution runner returned malformed results');
          err.status = 500;
          throw err;
        }
        return res.json({ results: parsed.results });
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    }

    // ---- single-cell mode (unchanged) ----
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'code must be a non-empty string' });
    }
    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
      return res.status(400).json({ error: `code exceeds the ${MAX_CODE_BYTES / 1024}KB limit` });
    }

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'note-mate-exec-'));
    try {
      let result;
      if (language === 'python') {
        await fsp.writeFile(path.join(dir, 'solution.py'), code, 'utf8');
        result = await runCommand('python3', ['-u', 'solution.py'], dir, { MPLBACKEND: 'Agg' });
      } else if (language === 'javascript') {
        await fsp.writeFile(path.join(dir, 'solution.mjs'), code, 'utf8');
        result = await runCommand('node', ['solution.mjs'], dir);
      } else {
        await fsp.writeFile(path.join(dir, 'Main.java'), code, 'utf8');
        const compiled = await runCommand('javac', ['Main.java'], dir);
        result = compiled.exitCode === 0
          ? await runCommand('java', ['Main'], dir)
          : compiled;
      }

      // Collect any PNG files the code wrote (e.g. matplotlib plt.savefig).
      const images = [];
      try {
        const entries = await fsp.readdir(dir);
        for (const name of entries.filter((n) => n.toLowerCase().endsWith('.png')).sort()) {
          const buf = await fsp.readFile(path.join(dir, name));
          images.push({ data: buf.toString('base64'), mime: 'image/png' });
        }
      } catch {
        // Image collection is best-effort; the run result still stands.
      }

      res.json({
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.exitCode,
        images,
      });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Static frontend (owned by the frontend agent) + error handling
// ---------------------------------------------------------------------------

app.use(express.static(path.resolve('public')));

app.use((_req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'internal error' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Note Mate listening on http://localhost:${PORT} (DATA_DIR=${DATA_DIR})`);
  });
}

export default app;
