// Seed script: creates the example project "Understanding Deep Learning".
//   npm run seed [-- --force]
// Downloads the UDL book PDF (v5.0.3, 2026-02-09), extracts the real chapter
// outline from the PDF with pdfjs-dist, and writes per-chapter note files
// (notes/chapter-NN-slug.md) + project.json notesHeader. Also downloads
// the 13 lecture-slide decks (PPTX + LibreOffice-converted PDF) and the
// 69 Python lab notebooks from the udlbook repo.
// Idempotent: re-running tops up missing pieces, never re-downloads files
// that already exist, and never overwrites existing chapter files or
// project.json's user edits (only missing `materials[]` entries are added).
// --force re-downloads source files; chapter files / project.json are still
// preserved (only the seed-owned "68 notebooks" header line is fixed to 69).
//
// Scratch lives under ~/workspace/nm-seed-tmp/ (LibreOffice profile +
// TMPDIR) — NEVER /tmp (512MB tmpfs; the seed payload is ~150-300MB).
// Deck conversion uses host `soffice` when present, else a one-off
// container from the app's own image (see src/convertDeck.js) — no host
// LibreOffice install is needed. When neither is available, seed ASKS
// whether to install LibreOffice via Homebrew (never silently;
// `--install-libreoffice` pre-answers yes for non-interactive runs).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHeading } from '../src/util.js';
import {
  chapterFileName, buildChapterFile, refreshLabsBlock,
} from '../src/chapterNotes.js';
import { convertDeck } from '../src/convertDeck.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const FORCE = process.argv.includes('--force');
const INSTALL_LIBREOFFICE = process.argv.includes('--install-libreoffice');
const SCRATCH = path.resolve(process.env.HOME || '~', 'workspace', 'nm-seed-tmp');

const SLUG = 'understanding-deep-learning';
const PDF_URL =
  'https://github.com/udlbook/udlbook/releases/download/v5.0.3/UnderstandingDeepLearning_02_09_26_C.pdf';
const PDF_SIZE = 22_344_992; // bytes, verified 2026-11-11
const BOOK_SITE = 'https://udlbook.github.io/udlbook/';
const VIDEOS_URL = 'https://www.youtube.com/playlist?list=PLRdABJkXXytCz19PsZ1PCQBKoZGV069k3'; // Tamer Elsayed's DL lectures, linked from the book site

// 13 lecture decks, in lecture order. UDLChapN.pptx covers ≈ book chapter N
// (2-13); there is NO UDLChap1.pptx — the Introduction deck comes from
// Google Drive instead (verified downloadable 2026-11-11, 51,832,977 bytes).
const DRIVE_INTRO_ID = '17RHb11BrydOvxSFNbRIomE1QKLVI087m';
const DRIVE_INTRO_SIZE = 51_832_977;
const DECKS = [
  { id: 'slides-introduction', title: 'Introduction', file: 'Introduction.pptx',
    url: `https://drive.google.com/uc?export=download&id=${DRIVE_INTRO_ID}`, driveId: DRIVE_INTRO_ID },
  { id: 'slides-chap2', title: 'Supervised Learning', file: 'UDLChap2.pptx',
    url: 'https://raw.githubusercontent.com/udlbook/udlbook/main/Slides/UDLChap2.pptx' },
  { id: 'slides-chap3', title: 'Shallow Neural Networks', file: 'UDLChap3.pptx',
    url: 'https://raw.githubusercontent.com/udlbook/udlbook/main/Slides/UDLChap3.pptx' },
  { id: 'slides-chap4', title: 'Deep Neural Networks', file: 'UDLChap4.pptx',
    url: 'https://raw.githubusercontent.com/udlbook/udlbook/main/Slides/UDLChap4.pptx' },
  { id: 'slides-chap5', title: 'Loss Functions', file: 'UDLChap5.pptx',
    url: 'https://raw.githubusercontent.com/udlbook/udlbook/main/Slides/UDLChap5.pptx' },
  { id: 'slides-chap6', title: 'Fitting Models', file: 'UDLChap6.pptx',
    url: 'https://raw.githubusercontent.com/udlbook/udlbook/main/Slides/UDLChap6.pptx' },
  { id: 'slides-chap7', title: 'Computing Gradients', file: 'UDLChap7.pptx',
    url: 'https://raw.githubusercontent.com/udlbook/udlbook/main/Slides/UDLChap7.pptx' },
  { id: 'slides-chap8', title: 'Initialization', file: 'UDLChap8.pptx',
    url: 'https://raw.githubusercontent.com/udlbook/udlbook/main/Slides/UDLChap8.pptx' },
  { id: 'slides-chap9', title: 'Performance', file: 'UDLChap9.pptx',
    url: 'https://raw.githubusercontent.com/udlbook/udlbook/main/Slides/UDLChap9.pptx' },
  { id: 'slides-chap10', title: 'Regularization', file: 'UDLChap10.pptx',
    url: 'https://raw.githubusercontent.com/udlbook/udlbook/main/Slides/UDLChap10.pptx' },
  { id: 'slides-chap11', title: 'Convolutional Networks', file: 'UDLChap11.pptx',
    url: 'https://raw.githubusercontent.com/udlbook/udlbook/main/Slides/UDLChap11.pptx' },
  { id: 'slides-chap12', title: 'Image Generation', file: 'UDLChap12.pptx',
    url: 'https://raw.githubusercontent.com/udlbook/udlbook/main/Slides/UDLChap12.pptx' },
  { id: 'slides-chap13', title: 'Transformers and LLMs', file: 'UDLChap13.pptx',
    url: 'https://raw.githubusercontent.com/udlbook/udlbook/main/Slides/UDLChap13.pptx' },
];

// Fallback chapter list (title + first page) from the book's own Contents
// (MIT Press / eCampus listing). Used only if the PDF outline cannot be read.
const FALLBACK_CHAPTERS = [
  ['Introduction', 1], ['Supervised learning', 17], ['Shallow neural networks', 25],
  ['Deep neural networks', 41], ['Loss functions', 56], ['Fitting models', 77],
  ['Gradients and initialization', 96], ['Measuring performance', 118],
  ['Regularization', 138], ['Convolutional networks', 161], ['Residual networks', 186],
  ['Transformers', 207], ['Graph neural networks', 240], ['Unsupervised learning', 268],
  ['Generative Adversarial Networks', 275], ['Normalizing flows', 303],
  ['Variational autoencoders', 326], ['Diffusion models', 348],
  ['Reinforcement learning', 373], ['Why does deep learning work?', 401],
  ['Deep learning and ethics', 420],
];

const PPTX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04

function isPptx(buf) {
  return buf.length > 4 && buf.subarray(0, 4).equals(PPTX_MAGIC);
}

async function fileExistsOk(file, magic) {
  try {
    const st = await fsp.stat(file);
    if (st.size === 0) return false;
    if (magic) {
      const head = Buffer.alloc(magic.length);
      const fd = await fsp.open(file, 'r');
      try { await fd.read(head, 0, magic.length, 0); } finally { await fd.close(); }
      return head.equals(magic);
    }
    return true;
  } catch {
    return false;
  }
}

async function downloadPdf(dest) {
  try {
    const st = await fsp.stat(dest);
    if (!FORCE && st.size === PDF_SIZE) {
      console.log(`source.pdf already present (${st.size} bytes) — skipping download`);
      return;
    }
    if (!FORCE && st.size > 0) {
      console.log(`source.pdf present but size ${st.size} != ${PDF_SIZE} — re-downloading`);
    }
  } catch {
    // Not present; download below.
  }
  console.log(`Downloading ${PDF_URL} ...`);
  const res = await fetch(PDF_URL);
  if (!res.ok) throw new Error(`PDF download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== PDF_SIZE) {
    console.warn(`Warning: downloaded ${buf.length} bytes, expected ${PDF_SIZE} — keeping it anyway`);
  }
  await fsp.writeFile(dest, buf);
  console.log(`Wrote source.pdf (${buf.length} bytes)`);
}

/** Extract top-level numbered chapters from the PDF outline via pdfjs-dist. */
async function extractOutline(pdfPath) {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await fsp.readFile(pdfPath));
    const pdf = await pdfjs.getDocument({ data }).promise;
    const outline = await pdf.getOutline();
    if (!outline?.length) {
      console.log('PDF has no outline — using fallback chapter list');
      return null;
    }
    const chapters = [];
    // This PDF's outline titles carry no numbers ("Introduction", not
    // "1 Introduction"), so chapters are the top-level items between the
    // front matter and the appendices/back matter.
    const SKIP = new Set([
      'preface', 'acknowledgements', 'contents',
      'notation', 'mathematics', 'probability', 'bibliography', 'index',
    ]);
    for (const item of outline) {
      const title = String(item.title || '').trim().replace(/\.+$/, '');
      if (!title || SKIP.has(title.toLowerCase())) continue;
      let page = null;
      try {
        let dest = item.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest)) page = (await pdf.getPageIndex(dest[0])) + 1;
      } catch { /* page number is best-effort */ }
      chapters.push({ num: chapters.length + 1, title, page });
    }
    chapters.sort((a, b) => a.num - b.num);
    if (chapters.length !== 21) {
      console.log(`Outline yielded ${chapters.length} numbered chapters (expected 21) — using fallback list`);
      return null;
    }
    await pdf.destroy();
    return chapters;
  } catch (err) {
    console.log(`Could not read PDF outline (${err.message}) — using fallback chapter list`);
    return null;
  }
}

/** Download one slide deck; returns {ok, bytes} — never throws. */
async function downloadDeck(deck, slidesDir) {
  const dest = path.join(slidesDir, deck.file);
  if (!FORCE && await fileExistsOk(dest, PPTX_MAGIC)) {
    const { size } = await fsp.stat(dest);
    console.log(`  ${deck.file} already present (${size} bytes) — skipping`);
    return { ok: true, bytes: size, skipped: true };
  }
  console.log(`  downloading ${deck.title} (${deck.file}) ...`);
  try {
    let buf = await fetchDeck(deck);
    if (!isPptx(buf)) {
      // Google Drive sometimes answers large downloads with a confirm page;
      // retry once with the confirm token if one is embedded.
      const text = buf.toString('utf8');
      const m = text.match(/confirm=([0-9A-Za-z_]+)/);
      if (m) {
        console.log(`  ${deck.file}: Drive confirm page — retrying with confirm token`);
        const res = await fetch(`${deck.url}&confirm=${m[1]}`);
        if (!res.ok) throw new Error(`HTTP ${res.status} on confirm retry`);
        buf = Buffer.from(await res.arrayBuffer());
      }
    }
    if (!isPptx(buf)) {
      throw new Error(`downloaded bytes are not a PPTX (magic ${buf.subarray(0, 8).toString('hex')}, ${buf.length} bytes)`);
    }
    await fsp.writeFile(dest, buf);
    console.log(`  wrote ${deck.file} (${buf.length} bytes)`);
    return { ok: true, bytes: buf.length };
  } catch (err) {
    console.log(`  FAILED ${deck.file}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function fetchDeck(deck) {
  const res = await fetch(deck.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Full repo tree (cached at /tmp/udl-tree.json when present, else GitHub API). */
async function fetchRepoTree() {
  const cached = '/tmp/udl-tree.json';
  try {
    const raw = await fsp.readFile(cached, 'utf8');
    console.log('Using cached repo tree /tmp/udl-tree.json');
    return JSON.parse(raw);
  } catch {
    console.log('Fetching repo tree from GitHub API ...');
    const res = await fetch('https://api.github.com/repos/udlbook/udlbook/git/trees/main?recursive=1');
    if (!res.ok) throw new Error(`GitHub API failed: HTTP ${res.status}`);
    return res.json();
  }
}

/** Download the 69 lab notebooks; returns {downloaded, skipped, failed}. */
async function downloadLabs(labsDir) {
  const tree = await fetchRepoTree();
  const labPaths = tree.tree
    .filter((e) => e.path.startsWith('Notebooks/') && e.path.endsWith('.ipynb'))
    .map((e) => e.path)
    .sort();
  console.log(`Lab notebooks in repo: ${labPaths.length} (site lists 68; repo has 69)`);
  const counts = {};
  let downloaded = 0;
  let skipped = 0;
  const failed = [];
  for (const repoPath of labPaths) {
    const [, chapter, name] = repoPath.split('/');
    counts[chapter] = (counts[chapter] ?? 0) + 1;
    const dest = path.join(labsDir, chapter, name);
    if (!FORCE && await fileExistsOk(dest)) {
      skipped += 1;
      continue;
    }
    try {
      const url = `https://raw.githubusercontent.com/udlbook/udlbook/main/${repoPath}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // Sanity: a notebook is JSON; a GitHub error page is not.
      JSON.parse(buf.toString('utf8'));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, buf);
      downloaded += 1;
    } catch (err) {
      failed.push(`${repoPath}: ${err.message}`);
      console.log(`  FAILED lab ${repoPath}: ${err.message}`);
    }
  }
  console.log(`Labs: ${downloaded} downloaded, ${skipped} already present, ${failed.length} failed`);
  console.log(`Per-chapter counts: ${JSON.stringify(counts)}`);
  return { total: labPaths.length, downloaded, skipped, failed, counts };
}

/** Build the materials[] entries for project.json from deck results. */
function buildMaterials(deckResults) {
  return DECKS.map((deck) => {
    const r = deckResults[deck.id] ?? {};
    const entry = {
      id: deck.id,
      label: deck.title,
      kind: 'slides',
      ...(r.pdfOk ? { file: `slides/${deck.file.replace(/\.pptx$/i, '.pdf')}` } : {}),
      sourceFile: `slides/${deck.file}`,
      sourceUrl: deck.url,
    };
    return entry;
  });
}

async function main() {
  await fsp.mkdir(SCRATCH, { recursive: true });
  const dir = path.join(DATA_DIR, 'projects', SLUG);
  const notesDir = path.join(dir, 'notes');
  const slidesDir = path.join(dir, 'slides');
  const labsDir = path.join(notesDir, 'labs');
  await fsp.mkdir(notesDir, { recursive: true });
  await fsp.mkdir(slidesDir, { recursive: true });
  await fsp.mkdir(labsDir, { recursive: true });

  const pdfPath = path.join(dir, 'source.pdf');
  await downloadPdf(pdfPath);

  const outline = await extractOutline(pdfPath);
  const chapters = outline ?? FALLBACK_CHAPTERS.map(([title, page], i) => ({
    num: i + 1, title, page,
  }));
  console.log(`Chapters (${outline ? 'from PDF outline' : 'fallback Contents list'}): ${chapters.length}`);

  // --- Slides: 13 decks (PPTX kept as source, LO-converted PDF renderable) ---
  console.log('Slides:');
  const deckResults = {};
  // One ctx per seed run: the container image is built at most once, and
  // the Homebrew-install prompt is asked at most once.
  const convertCtx = { imageBuilt: false, installAsked: false, installDeclined: false, installAttempted: false };
  for (const deck of DECKS) {
    const dl = await downloadDeck(deck, slidesDir);
    let conv = { ok: false };
    if (dl.ok) conv = await convertDeck(deck, slidesDir, { root: ROOT, dataDir: DATA_DIR, scratch: SCRATCH, force: FORCE, autoInstall: INSTALL_LIBREOFFICE, ctx: convertCtx });
    deckResults[deck.id] = {
      pptxOk: dl.ok, pptxBytes: dl.bytes ?? 0,
      pdfOk: conv.ok, pdfBytes: conv.bytes ?? 0,
      error: dl.ok ? conv.error : dl.error,
    };
  }
  const slidesOk = Object.values(deckResults).filter((r) => r.pdfOk).length;
  const slidesFailed = DECKS.filter((d) => !deckResults[d.id].pdfOk);
  console.log(`Slides: ${slidesOk}/13 PDFs converted${slidesFailed.length ? `; FAILED: ${slidesFailed.map((d) => d.file).join(', ')}` : ''}`);
  const materials = buildMaterials(deckResults);

  // --- Labs: 69 notebooks, exact repo filenames ---
  console.log('Labs:');
  const labs = await downloadLabs(labsDir);

  // The placeholder exercises.ipynb was seed-owned, never user content;
  // the real labs supersede it.
  try {
    await fsp.rm(path.join(notesDir, 'exercises.ipynb'), { force: true });
    console.log('Removed placeholder notes/exercises.ipynb (superseded by notes/labs/)');
  } catch { /* already gone */ }

  // --- project.json: never overwrite user edits; only top up materials[] ---
  // The notes header block (title + byline) is the per-chapter layout's
  // `notesHeader`: the server stores it verbatim so the single-file export
  // reconstructs the old notes.md shape.
  const headerBlock = [
    '# Understanding Deep Learning\n',
    '\n',
    'Simon J.D. Prince, MIT Press (free PDF, CC-BY-NC-ND). ',
    'Book site with 69 Python notebook exercises, video lectures and slides: ',
    `${BOOK_SITE}\n`,
    '\n',
  ].join('');
  const now = new Date().toISOString();
  const projectFile = path.join(dir, 'project.json');
  let existing = null;
  try {
    existing = JSON.parse(await fsp.readFile(projectFile, 'utf8'));
  } catch { /* absent — create below */ }
  if (existing) {
    const before = JSON.stringify(existing.materials ?? null);
    const byId = new Map((existing.materials ?? []).map((m) => [m.id, m]));
    for (const m of materials) byId.set(m.id, { ...(byId.get(m.id) ?? {}), ...m });
    existing.materials = [...byId.values()];
    if (JSON.stringify(existing.materials) !== before) {
      existing.updatedAt = now;
      await fsp.writeFile(projectFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
      console.log('project.json: materials[] topped up (other fields preserved)');
    } else {
      console.log('project.json: materials[] already complete — untouched');
    }
    if (!existing.notesHeader) {
      // A project seeded before the per-chapter layout: the header is the
      // seed's own text unless a legacy notes.md exists, in which case the
      // server's migration overwrites this with the file's own header.
      existing.notesHeader = headerBlock;
      existing.updatedAt = now;
      await fsp.writeFile(projectFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
      console.log('project.json: notesHeader added');
    }
  } else {
    const project = {
      slug: SLUG,
      title: 'Understanding Deep Learning',
      author: 'Simon J.D. Prince',
      kind: 'pdf',
      sourceType: 'file',
      file: 'source.pdf',
      cover: null,
      materials,
      // Canonical chapterMap scheme (shared with the frontend):
      // normalized outline title -> index of its `##` heading in notes.md
      // (0-based). Manual overrides POST the same shape to /chapter-map.
      // Kept for compatibility; chapter resolution now uses files.
      chapterMap: Object.fromEntries(chapters.map((c, i) => [normalizeHeading(c.title), i])),
      notesHeader: headerBlock,
      links: [
        { label: 'Book site & Python notebooks', url: BOOK_SITE },
        { label: 'Video lectures (YouTube, Tamer Elsayed)', url: VIDEOS_URL },
        // The book site hosts the full lecture-slide PPTX decks (Google Drive);
        // link the site rather than a Drive URL that may move.
        { label: 'Lecture slides (PPTX, via book site)', url: BOOK_SITE },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await fsp.writeFile(projectFile, JSON.stringify(project, null, 2) + '\n', 'utf8');
    console.log('wrote: project.json (new)');
  }

  // --- Per-chapter note files: one file per chapter (## heading + page
  // comment, empty body) — the headings-only skeleton, split by file.
  // Written only when absent, NEVER overwritten (not even with --force:
  // chapter files hold the user's own notes). When a legacy notes.md
  // exists it stays the source of truth — the server splits it on first
  // load — so the seed never writes chapter files over it.
  // The one seed-owned fix on re-run: the header line said "68 Python
  // notebook exercises"; the repo actually has 69. Only that phrase is
  // touched — user-written note content is never overwritten.
  const notesMdPath = path.join(notesDir, 'notes.md');
  const writeChapterIfAbsent = async (file, content) => {
    try {
      await fsp.stat(file);
      console.log(`exists, skipping: ${path.relative(ROOT, file)}`);
      return false;
    } catch { /* absent — write */ }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
    console.log(`wrote: ${path.relative(ROOT, file)}`);
    return true;
  };
  // Labs on disk per chapter dir (downloaded above), for the generated
  // `### Labs` block in each chapter file.
  const labsByChapter = new Map();
  try {
    for (const group of await fsp.readdir(labsDir, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const files = (await fsp.readdir(path.join(labsDir, group.name)))
        .filter((n) => n.toLowerCase().endsWith('.ipynb'))
        .sort()
        .map((name) => ({ name, path: `labs/${group.name}/${name}` }));
      labsByChapter.set(group.name, files);
    }
  } catch { /* no labs yet */ }
  let legacyExists = false;
  try {
    await fsp.stat(notesMdPath);
    legacyExists = true;
  } catch { /* absent */ }
  if (legacyExists) {
    try {
      const current = await fsp.readFile(notesMdPath, 'utf8');
      if (current.includes('68 Python notebook exercises')) {
        await fsp.writeFile(
          notesMdPath,
          current.replace('68 Python notebook exercises', '69 Python notebook exercises'),
          'utf8',
        );
        console.log('notes.md: header line fixed 68 -> 69 notebooks (content otherwise untouched)');
      } else {
        console.log('exists, skipping: notes.md (legacy — migration splits it on first load)');
      }
    } catch {
      console.log('exists, skipping: notes.md');
    }
  } else {
    for (const c of chapters) {
      const file = chapterFileName({ number: c.num, title: c.title });
      const groupLabs = labsByChapter.get(`Chap${String(c.num).padStart(2, '0')}`) ?? [];
      const content = refreshLabsBlock(
        buildChapterFile({ heading: `${c.num}. ${c.title}`, page: c.page, body: '' }),
        groupLabs, c.num,
      );
      await writeChapterIfAbsent(path.join(notesDir, file), content);
    }
  }

  // --- Summary ---
  let totalBytes = 0;
  const du = async (p) => {
    try {
      const st = await fsp.stat(p);
      return st.isDirectory()
        ? (await Promise.all((await fsp.readdir(p)).map((n) => du(path.join(p, n))))).reduce((a, b) => a + b, 0)
        : st.size;
    } catch { return 0; }
  };
  totalBytes = await du(dir);
  console.log('--- Seed summary ---');
  console.log(`Project dir: ${path.relative(ROOT, dir)} (${(totalBytes / 1024 / 1024).toFixed(1)} MB total)`);
  console.log(`Slides: ${slidesOk}/13 converted to PDF${slidesFailed.length ? ` — FAILED: ${slidesFailed.map((d) => `${d.file} (${deckResults[d.id].error})`).join('; ')}` : ''}`);
  console.log(`Labs: ${labs.total} notebooks (${labs.downloaded} downloaded this run, ${labs.skipped} already present, ${labs.failed.length} failed)`);
  if (labs.failed.length) console.log(`Lab failures: ${labs.failed.join('; ')}`);
  console.log(`Seed done: ${path.relative(ROOT, dir)}`);
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
