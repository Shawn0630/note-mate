// Note Mate backend — Node ESM + Express, file-based storage under DATA_DIR.
// No database. Serves the API the frontend builds against; see README.md.
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { slugify, resolveProjectPath, parseNotebook } from './util.js';
import { extractPdfText } from './pdftext.js';
import { proposeProjectData, LLM_NOT_CONFIGURED } from './llm.js';
import { validateProposal } from './aiImport.js';

const execFileAsync = promisify(execFile);

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const PORT = Number(process.env.PORT || 9300);

const MAX_CODE_BYTES = 200 * 1024; // ~200KB cap on /api/execute code
const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

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
    let hasFile = false;
    if (m.file) {
      try {
        await fsp.stat(resolveProjectPath(DATA_DIR, slug, m.file));
        hasFile = true;
      } catch {
        hasFile = false;
      }
    }
    out.push({
      id: m.id,
      label: m.label,
      kind: m.kind,
      hasFile,
      ...(m.sourceUrl ? { sourceUrl: m.sourceUrl } : {}),
    });
  }
  return out;
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
      if (!sourceUrl || typeof sourceUrl !== 'string') {
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
      ...(sourceType === 'file' ? { file: fileName } : { sourceUrl }),
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
    res.json({
      ...project,
      materials: project.materials ?? [],
      noteFiles: await listNoteFiles(req.params.slug),
    });
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
    const filePath = resolveProjectPath(DATA_DIR, req.params.slug, project.file);
    await fsp.stat(filePath); // 404 when the file is gone
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
    if (!material.file) return res.status(404).json({ error: 'material has no file' });
    const filePath = resolveProjectPath(DATA_DIR, req.params.slug, material.file);
    await fsp.stat(filePath); // 404 when the file is gone
    // Same Range-supporting pattern as the main file route.
    res.sendFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'project or file not found' });
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
      proposal = await proposeProjectData({ kind: 'pdf', title, text: extracted.text });
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

app.get('/api/projects/:slug/notes', async (req, res, next) => {
  try {
    await readProject(req.params.slug);
    const names = await listNoteFiles(req.params.slug);
    res.json(names.map((name) => ({ name, kind: name.endsWith('.ipynb') ? 'ipynb' : 'md' })));
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
// Code execution — runs in a fresh temp dir, 30s timeout, dir deleted after.
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
    const { language, code } = req.body ?? {};
    if (!LANGUAGES.has(language)) {
      return res.status(400).json({ error: 'language must be python, java, or javascript' });
    }
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
