/* Note Mate frontend — vanilla JS, hash routing.
   API contract: see README / backend src/server.js.
   - GET    /api/projects
   - POST   /api/projects            (multipart title+file, or JSON {title, kind, url})
   - GET    /api/projects/:slug
   - GET    /api/projects/:slug/file
   - GET    /api/projects/:slug/materials
   - GET    /api/projects/:slug/materials/:id/file
   - GET    /api/projects/:slug/labs
   - GET    /api/projects/:slug/labs/:chapter/:name
   - PUT    /api/projects/:slug/labs/:chapter/:name   {content}
   - GET    /api/projects/:slug/chapters
   - POST   /api/projects/:slug/chapters  {title, page?} -> {chapter, chapters}
   - POST   /api/import/ai/propose   (multipart file + optional title)
   - POST   /api/import/ai/apply     (multipart file + proposal JSON + title)
   - GET    /api/projects/:slug/notes
   - GET    /api/projects/:slug/notes/:name
   - PUT    /api/projects/:slug/notes/:name   {content}
     (index.md and notes.md are rejected: the index is app-maintained,
     notes.md is legacy; chapter files return {name, content, chapter})
   - POST   /api/projects/:slug/notes/migrate  -> {migrated, chapters}
   - GET    /api/projects/:slug/notes/export   (one combined .md download)
   - POST   /api/projects/:slug/cover         {dataUrl}
   - POST   /api/projects/:slug/chapter-map   {mapping} (kept for compat;
     chapter resolution no longer uses chapterMap — see below)
   - POST   /api/projects/:slug/ai-note       {chapter?, prompt, includeNote?, history?}
                                              → {markdown, chapter, contextChars}
   - POST   /api/projects/:slug/export-cells  {notebook, name, cells:[indexes]}
                                              → {markdown, images, cells}
   - GET    /api/projects/:slug/assets/:file  exported plot PNG (notes/assets/)
   - POST   /api/execute                      {language, code}
   - POST   /api/execute                      {language, cells:[{source}]}
                                              → {results:[{stdout, stderr, exitCode, images, skipped}]}
                                              (run-all: one shared session; java unsupported)

   Per-chapter notes (2026-11-11): notes live in one file per chapter
   (notes/chapter-NN-slug.md) and the app owns a master index
   (notes/index.md) with hyperlinks to each chapter file and its labs.
   Chapters resolve by FILE — the old heading-index chapterMap is gone
   for notes (a ### inside a chapter file can never shift another
   chapter). Opening a chapter opens its file in the right pane; the
   left Markdown preview tab renders that file (the index when no
   chapter is active). "+ Note here", Ask AI Apply, and cell-export
   Insert all write into the current chapter's file, before its
   generated ### Labs block.
*/
import * as pdfjsLib from './vendor/pdfjs/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.mjs';

const view = document.getElementById('view');
const RUNNABLE_LANGS = ['python', 'java', 'javascript'];

/* ---------------- helpers ---------------- */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const msg = (data && data.error) || (data && data.message) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

const apiGet = (path) => api(path);
const apiJson = (path, method, body) => api(path, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/* Shared chapter <-> note-heading matching rule.
   This is a verbatim port of normalizeHeading in src/util.js.
   normalize: lowercase, strip leading "Chapter N:" / "Appendix A -" /
   numbering like "1.2 ", strip trailing dots, strip punctuation, collapse spaces.
   Match exact, then startsWith/contains. Chapter resolution uses it to
   match an outline title to a chapter file's `##` heading (the heading
   carries its number, e.g. "12. Transformers" — the number is stripped
   here, so it matches the outline's "Transformers"). */
function normalizeHeading(text) {
  let s = String(text ?? '').toLowerCase().trim();
  // Leading "chapter 1:", "appendix a -", "part 2." etc.
  s = s.replace(/^(chapter|appendix|part)\s+[a-z0-9]+(?:\.[0-9]+)?\s*[:.\-–—]?\s*/u, '');
  // Leading numbering: "1.2 ", "1.2.3 - ", "1: ", "21 "
  s = s.replace(/^\d+(?:\.\d+)*\s*[:.\-–—]?\s+/u, '');
  // Trailing dots (e.g. contents-page leaders)
  s = s.replace(/[.]+$/u, '');
  // Strip punctuation to spaces, collapse whitespace.
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function matchHeading(chapterTitle, headings) {
  const cn = normalizeHeading(chapterTitle);
  if (!cn) return null;
  const exact = headings.find((h) => h.norm === cn);
  if (exact) return exact;
  const starts = headings.find((h) => h.norm.startsWith(cn) || cn.startsWith(h.norm));
  if (starts) return starts;
  const contains = headings.find((h) => h.norm.includes(cn) || cn.includes(h.norm));
  return contains || null;
}

/* Extract ## / ### headings from markdown text.
   Returns [{text, norm, line}] where line is the 0-based source line.
   Used only by the AI-import preview (skeleton headings); chapter
   navigation no longer reads headings — chapters are files. */
function headingsFromMarkdown(text) {
  const out = [];
  String(text || '').split('\n').forEach((line, i) => {
    const m = line.match(/^(#{2,3})\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ text: m[2].trim(), norm: normalizeHeading(m[2]), line: i, level: m[1].length });
  });
  return out;
}

/* A per-chapter file name: chapter-NN-slug.md. */
function isChapterFileName(name) {
  return /^chapter-\d+-.+\.md$/i.test(String(name ?? ''));
}

/* The lab group dir for a chapter number: chapter 12 -> "Chap12". */
function labGroupForChapterNumber(n) {
  return n == null ? null : `Chap${String(n).padStart(2, '0')}`;
}

function kindLabel(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'pdf') return 'PDF';
  if (k === 'video') return 'Video';
  if (k === 'slides') return 'Slides';
  if (k === 'ppt') return 'PPT';
  return kind ? String(kind).toUpperCase() : 'File';
}

function kindFromExtension(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (['mp4', 'webm', 'mov', 'mkv', 'm4v'].includes(ext)) return 'video';
  if (['ppt', 'pptx', 'key'].includes(ext)) return 'ppt';
  return null;
}

function kindFromUrl(url) {
  const u = String(url || '').toLowerCase();
  if (/youtu\.?be/.test(u)) return 'video';
  if (u.includes('docs.google.com/presentation')) return 'slides';
  if (u.includes('.pdf')) return 'pdf';
  if (/\.(ppt|pptx)(\?|$)/.test(u)) return 'ppt';
  return null;
}

function youtubeEmbedUrl(url) {
  const u = String(url || '');
  let m = u.match(/[?&]v=([\w-]{6,})/) || u.match(/youtu\.be\/([\w-]{6,})/)
    || u.match(/\/embed\/([\w-]{6,})/) || u.match(/\/shorts\/([\w-]{6,})/);
  return m ? `https://www.youtube.com/embed/${m[1]}` : null;
}

function slidesEmbedUrl(url) {
  const u = String(url || '');
  const m = u.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return `https://docs.google.com/presentation/d/${m[1]}/embed?start=false&loop=false`;
  return u;
}

function coverUrl(project) {
  // Backend stores the cover as cover.png; served from the cover endpoint.
  return `/api/projects/${encodeURIComponent(project.slug)}/cover`;
}

function noteCountOf(project) {
  if (Array.isArray(project.noteFiles)) return project.noteFiles.length;
  if (typeof project.noteFiles === 'number') return project.noteFiles;
  return 0;
}

/* ---------------- app state ---------------- */

const state = {
  projects: [],
  // reader session state
  project: null,
  notes: [],            // [{name, kind}]
  activeNoteName: null,
  activeNoteKind: null, // 'md' | 'ipynb'
  activeNoteContent: '', // raw text content of active note
  activeNotebook: null,  // parsed nbformat object when active note is ipynb
  execCounter: 0,     // per-notebook execution counter (execution_count)
  // The right pane is the WORKING side: a markdown note opens in its editor
  // there (the rendered preview lives in the LEFT pane's Preview tab).
  follow: true,         // scroll-spy follow toggle
  editorFocused: false,
  mdDirty: false,       // the active markdown note has unsaved edits
  outline: [],          // [{title, page, depth}] for PDFs
  // Per-chapter notes: [{number, title, page, file, labs}] from GET
  // .../:slug (chapters resolve by FILE — no heading-index map anymore).
  chapters: [],
  activeChapter: null,  // normalized chapter title currently active
  pdfDoc: null,
  pdfPages: [],         // [{num, top}] measured offsets in the pdf container
  pdfContainer: null,
  // Reader layout (reader split, 2026-11-11): three modes, per-session.
  // Navigation = nav + reading pane, notebook hidden; Focus = nav hidden,
  // reading + notebook 50/50; AI = Focus + the AI panel as the rightmost
  // column. The Chapters button toggles the nav manually within the mode
  // (navVisible) without changing the mode label; the mode buttons set the
  // canonical arrangement. The ✨ Ask AI toggle and the AI mode button are
  // the same action: opening AI switches to AI mode, closing the panel
  // (its ×) returns to Focus.
  layoutMode: 'focus',  // 'navigation' | 'focus' | 'ai'
  navVisible: false,    // manual nav state within the current mode
  // Left (reading) pane tabs — PDF projects only. pdf = the book PDF,
  // slides = the current chapter's slide deck, preview = the rendered
  // chapter file (or the master index when no chapter is active).
  leftTab: 'pdf',       // 'pdf' | 'slides' | 'preview'
  // The deck PDF shown in the Slides tab lives in its own container so
  // each tab keeps its scroll position (the book PDF is never unloaded).
  deckDoc: null,
  deckPages: [],        // [{num, top}] measured offsets in the deck container
  deckContainer: null,
  deckMaterialId: null, // material id of the deck currently shown
  deckChapter: null, // normalized chapter the current deck was chosen for (see loadDeckPdf)
  noteCache: {},        // md note name -> last-known text (left Preview tab)
  previewFile: null,    // the file the left Preview tab last rendered
  showIndex: false,     // the left Preview tab shows notes/index.md
  // Multi-source reader (v1.1): materials[] from GET .../materials.
  // activeSourceId null = the project's main (Book) source. It mirrors the
  // left tab (pdf -> null, slides -> the deck id) so the chapter panel's
  // source note and the AI context line keep working.
  materials: [],
  activeSourceId: null,
  // Labs (v1.1): chapters from GET .../labs; labTabs are labs opened as
  // notebook tabs. activeTabKind 'note' | 'lab' decides the save endpoint.
  labs: [],
  labTabs: [],          // [{chapter, name}]
  activeTabKind: 'note',
  activeLab: null,      // {chapter, name} when a lab tab is active
  labsCollapsed: false,
  labsOpenChapters: {}, // chapter -> true when its file group is expanded
  saveTimer: null,
  suppressFollowScroll: false,
  // On-demand AI notes + cell export: one AI thread per notebook, kept in
  // memory for the session (resets on reload — same v1 limit as Finance
  // Mate's Refine panel). Export selection is per notebook too.
  aiPanelOpen: false,   // true exactly while layoutMode is 'ai'
  aiTab: 'note',        // 'note' (Note AI) | 'code' (Code AI)
  aiThreads: {},        // notebookKey -> {messages: [{role, content, markdown, applied}]}
  aiCodeThreads: {},    // notebookKey -> {messages: [{role, content, code, explanation, applied}]}
  exportSelection: new Set(), // notebook cell indexes selected for export
  exportSelectionFor: null,   // notebook key the selection belongs to
  // Scroll-spy suppression while a programmatic chapter-click scroll is in
  // flight: the smooth scroll fires scroll events the whole way down, and
  // without this the spy would overwrite the clicked chapter with the first
  // subsection sharing its page (every chapter's first subsection starts on
  // the same page as the chapter). Armed in setActiveChapter when it scrolls
  // the PDF; released by onPdfScroll on arrival, or by the timestamp.
  suppressSpyUntil: 0, // ms epoch — ignore the spy while Date.now() < this
  suppressSpyPage: null, // target page of the in-flight click scroll
  suppressSpyTop: null,  // target scrollTop of the in-flight click scroll
};

function resetReaderState() {
  if (state.pdfDoc) { try { state.pdfDoc.destroy(); } catch { /* ignore */ } }
  if (state.deckDoc) { try { state.deckDoc.destroy(); } catch { /* ignore */ } }
  state.project = null;
  state.notes = [];
  state.activeNoteName = null;
  state.activeNoteKind = null;
  state.activeNoteContent = '';
  state.activeNotebook = null;
  state.mdDirty = false;
  state.outline = [];
  state.chapters = [];
  state.activeChapter = null;
  state.pdfDoc = null;
  state.pdfPages = [];
  state.pdfContainer = null;
  state.suppressSpyUntil = 0;
  state.suppressSpyPage = null;
  state.suppressSpyTop = null;
  state.layoutMode = 'focus';
  state.navVisible = false;
  state.leftTab = 'pdf';
  state.deckDoc = null;
  state.deckPages = [];
  state.deckContainer = null;
  state.deckMaterialId = null;
  state.deckChapter = null;
  state.noteCache = {};
  state.previewFile = null;
  state.showIndex = false;
  state.materials = [];
  state.activeSourceId = null;
  state.labs = [];
  state.labTabs = [];
  state.activeTabKind = 'note';
  state.activeLab = null;
  state.labsCollapsed = false;
  state.labsOpenChapters = {};
  state.coverGenerated = false;
  state.editorFocused = false;
  state.aiPanelOpen = false;
  state.aiTab = 'note';
  state.aiThreads = {};
  state.aiCodeThreads = {};
  state.exportSelection = new Set();
  state.exportSelectionFor = null;
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
  document.body.classList.remove('reader-open'); // edge-to-edge only while a reader is open
}

/* ---------------- routing ---------------- */

function route() {
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/project\/([^/?#]+)/);
  if (m) {
    openProject(decodeURIComponent(m[1]));
  } else {
    renderHome();
  }
}

window.addEventListener('hashchange', route);

function showError(message, detail) {
  view.innerHTML = `
    <div class="view-error">
      <h2>Something went wrong</h2>
      <p>${esc(message)}</p>
      ${detail ? `<p>${esc(detail)}</p>` : ''}
      <p><a href="#/">Back to the shelf</a></p>
    </div>`;
}

/* ---------------- home: bookshelf ---------------- */

async function renderHome() {
  resetReaderState();
  view.innerHTML = `
    <div class="shelf-head">
      <div>
        <h1>My Shelf</h1>
        <p>Your reading projects — open one to read and take notes side by side.</p>
      </div>
      <button class="primary" id="add-project-btn">+ Add project</button>
    </div>
    <div id="shelf"><p>Loading your shelf…</p></div>`;

  $('#add-project-btn', view).addEventListener('click', openAddProjectModal);

  try {
    const projects = await apiGet('/api/projects');
    state.projects = Array.isArray(projects) ? projects : [];
  } catch (err) {
    $('#shelf', view).innerHTML = `
      <div class="view-error">
        <h2>Could not load your shelf</h2>
        <p>${esc(err.message)}</p>
        <p>Is the Note Mate server running? Try reloading the page.</p>
      </div>`;
    return;
  }

  const shelf = $('#shelf', view);
  if (state.projects.length === 0) {
    shelf.innerHTML = `
      <div class="empty-state">
        <h2>Your shelf is empty</h2>
        <p>Add your first project — a PDF, a video, a slide deck or a presentation —
           and start taking notes next to it.</p>
        <button class="primary" id="empty-add-btn">+ Add your first project</button>
      </div>`;
    $('#empty-add-btn', shelf).addEventListener('click', openAddProjectModal);
    return;
  }

  // Shelf rows of 5 books, each row sitting on a wood board.
  const ROW = 5;
  let html = '';
  for (let i = 0; i < state.projects.length; i += ROW) {
    const row = state.projects.slice(i, i + ROW);
    html += `<div class="shelf-row">${row.map(bookCardHtml).join('')}`;
    if (i === 0) {
      html += `
        <button class="book-card add-card" id="add-card-btn" type="button">
          <span class="add-plus">+</span>
          <span class="add-label">Add project</span>
        </button>`;
    }
    html += `</div>`;
  }
  shelf.innerHTML = html;

  $$('.book-card[data-slug]', shelf).forEach((card) => {
    card.addEventListener('click', () => {
      location.hash = `#/project/${encodeURIComponent(card.dataset.slug)}`;
    });
  });
  const addCard = $('#add-card-btn', shelf);
  if (addCard) addCard.addEventListener('click', openAddProjectModal);

  // Cover images: try the cover endpoint, then a static cover.png path,
  // then fall back to the title-letter tile.
  $$('.book-cover img', shelf).forEach((img) => {
    img.addEventListener('error', () => {
      if (!img.dataset.triedStatic) {
        img.dataset.triedStatic = '1';
        img.src = `/projects/${encodeURIComponent(img.dataset.slug)}/cover.png`;
      } else {
        const wrap = img.closest('.book-cover');
        if (wrap) {
          wrap.innerHTML = `<div class="book-cover-fallback">${esc(img.dataset.letter || '?')}</div>`;
        }
      }
    }, { once: false });
  });
}

function bookCardHtml(project) {
  const letter = String(project.title || '?').trim().charAt(0).toUpperCase() || '?';
  const cover = project.cover
    ? `<img src="${esc(coverUrl(project))}" alt="" data-slug="${esc(project.slug)}" data-letter="${esc(letter)}" loading="lazy">`
    : `<div class="book-cover-fallback">${esc(letter)}</div>`;
  return `
    <article class="book-card" data-slug="${esc(project.slug)}" tabindex="0" role="link"
             aria-label="${esc(project.title || 'Untitled project')}">
      <div class="book-cover">${cover}</div>
      <div class="book-body">
        <h3 class="book-title">${esc(project.title || 'Untitled')}</h3>
        <p class="book-author">${esc(project.author || '')}</p>
        <div class="book-meta">
          <span class="badge">${esc(kindLabel(project.kind))}</span>
          <span>${noteCountOf(project)} note${noteCountOf(project) === 1 ? '' : 's'}</span>
        </div>
      </div>
    </article>`;
}

/* ---------------- add project modal ---------------- */

function openAddProjectModal() {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'add-project-modal';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="add-project-title">
      <h2 id="add-project-title">Add a project</h2>
      <p class="modal-sub">Upload a file, or paste a link to a Google Slides deck,
         a YouTube video, or a PDF on the web.</p>
      <form id="add-project-form">
        <label for="ap-title">Title</label>
        <input type="text" id="ap-title" name="title" placeholder="e.g. Machine Learning — Lecture 1" required>

        <label for="ap-file">File (PDF, video, or PowerPoint)</label>
        <input type="file" id="ap-file" name="file"
               accept=".pdf,.mp4,.webm,.mov,.mkv,.m4v,.ppt,.pptx,.key">
        <div class="hint" id="ap-file-hint"></div>

        <div class="ai-import-row" id="ap-ai-row" hidden>
          <button type="button" id="ap-ai-btn" disabled>✨ Import with AI</button>
          <span class="hint">AI drafts the chapter outline and blank note headings — you write the notes.</span>
        </div>
        <div class="form-error" id="ap-ai-status"></div>

        <div class="or-divider">or link a URL instead</div>

        <label for="ap-url">URL</label>
        <input type="url" id="ap-url" name="url"
               placeholder="https://docs.google.com/presentation/d/… or https://www.youtube.com/watch?v=…">
        <div class="hint" id="ap-url-hint"></div>

        <div class="form-error" id="ap-error"></div>
        <div class="modal-actions">
          <button type="button" id="ap-cancel">Cancel</button>
          <button type="submit" class="primary" id="ap-submit">Add project</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(overlay);

  const fileInput = $('#ap-file', overlay);
  const urlInput = $('#ap-url', overlay);
  const fileHint = $('#ap-file-hint', overlay);
  const urlHint = $('#ap-url-hint', overlay);

  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    const aiRow = $('#ap-ai-row', overlay);
    const aiBtn = $('#ap-ai-btn', overlay);
    if (!f) {
      fileHint.textContent = '';
      aiRow.hidden = true;
      aiBtn.disabled = true;
      return;
    }
    const kind = kindFromExtension(f.name);
    fileHint.textContent = kind
      ? `Detected kind: ${kindLabel(kind)} — ${f.name}`
      : 'Could not detect the kind from this file name.';
    // AI import needs a PDF. Show the row whenever a file is chosen; enable
    // the button only for PDFs so the plain Create path is never blocked.
    aiRow.hidden = false;
    const isPdf = /\.pdf$/i.test(f.name);
    aiBtn.disabled = !isPdf;
    aiBtn.title = isPdf ? '' : 'AI import needs a PDF file';
    if (f) urlInput.value = '';
  });
  urlInput.addEventListener('input', () => {
    const v = urlInput.value.trim();
    if (!v) { urlHint.textContent = ''; return; }
    const kind = kindFromUrl(v);
    urlHint.textContent = kind
      ? `Detected kind: ${kindLabel(kind)}`
      : 'Kind could not be detected — add a Google Slides, YouTube, or PDF link.';
    if (v) fileInput.value = '';
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  $('#ap-cancel', overlay).addEventListener('click', closeModal);
  $('#ap-ai-btn', overlay).addEventListener('click', () => {
    const file = fileInput.files[0];
    if (!file) return;
    proposeAiImport(overlay, file, $('#ap-title', overlay).value.trim());
  });

  $('#add-project-form', overlay).addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('#ap-error', overlay);
    const submitBtn = $('#ap-submit', overlay);
    errBox.textContent = '';
    const title = $('#ap-title', overlay).value.trim();
    const file = fileInput.files[0];
    const url = urlInput.value.trim();
    if (!title) { errBox.textContent = 'Please give the project a title.'; return; }
    if (!file && !url) { errBox.textContent = 'Upload a file or paste a URL.'; return; }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding…';
    try {
      let created;
      if (file) {
        const form = new FormData();
        form.append('title', title);
        form.append('file', file);
        created = await api('/api/projects', { method: 'POST', body: form });
      } else {
        const kind = kindFromUrl(url) || 'pdf';
        created = await apiJson('/api/projects', 'POST', { title, kind, url });
      }
      closeModal();
      if (created && created.slug) {
        location.hash = `#/project/${encodeURIComponent(created.slug)}`;
      } else {
        renderHome();
      }
    } catch (err) {
      errBox.textContent = err.message;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add project';
    }
  });

  $('#ap-title', overlay).focus();
}

function closeModal() {
  const existing = document.getElementById('add-project-modal');
  if (existing) existing.remove();
}

/* ---------------- AI import (v1.1) ---------------- */

/* Ask the backend to draft an outline + note skeleton for the chosen PDF.
   Nothing is written by this call. A 503 (LLM unconfigured) or 400 (bad PDF)
   shows inline in the Add-project modal and leaves the plain Create path
   working. */
async function proposeAiImport(overlay, file, title) {
  const statusEl = $('#ap-ai-status', overlay);
  const btn = $('#ap-ai-btn', overlay);
  statusEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Asking AI…';
  const form = new FormData();
  form.append('file', file);
  if (title) form.append('title', title);
  try {
    const data = await api('/api/import/ai/propose', { method: 'POST', body: form });
    // Contract delta (live backend, 2026-11-11): propose returns the proposal
    // fields spread at the top level — {outline, noteSkeleton, chapterMap,
    // title, pagesExtracted, numPages} — not nested under `proposal`.
    // Accept both shapes; keep only the three proposal fields for apply.
    const raw = (data && data.proposal) || data;
    if (!raw || !Array.isArray(raw.outline)
      || typeof raw.noteSkeleton !== 'string'
      || !raw.chapterMap || typeof raw.chapterMap !== 'object') {
      throw new Error('The AI import returned no proposal.');
    }
    openAiPreviewModal(file, title, {
      outline: raw.outline,
      noteSkeleton: raw.noteSkeleton,
      chapterMap: raw.chapterMap,
    });
  } catch (err) {
    statusEl.textContent = /not configured/i.test(err.message)
      ? 'LLM not configured — add LLM_API_KEY and LLM_MODEL to server/.env'
      : err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Import with AI';
  }
}

function closeAiPreviewModal() {
  const existing = document.getElementById('ai-preview-modal');
  if (existing) existing.remove();
}

/* Preview what the AI drafted, before anything is written. The note skeleton
   is headings only — blank sections for the user to write in himself. */
function openAiPreviewModal(file, title, proposal) {
  closeAiPreviewModal();
  const outline = Array.isArray(proposal.outline) ? proposal.outline : [];
  const skeleton = typeof proposal.noteSkeleton === 'string' ? proposal.noteSkeleton : '';
  const chapterMap = (proposal.chapterMap && typeof proposal.chapterMap === 'object')
    ? proposal.chapterMap : {};
  const skeletonHeadings = headingsFromMarkdown(skeleton);

  const mapRows = outline.map((ch) => {
    const idx = chapterMap[normalizeHeading(ch.title)];
    const target = typeof idx === 'number' && skeletonHeadings[idx]
      ? `note heading ${idx + 1} — “${skeletonHeadings[idx].text}”`
      : 'no matching note heading';
    return `<li>${esc(ch.title || '')} → ${esc(target)}</li>`;
  }).join('');
  const mapHtml = outline.length
    ? `<ul class="ai-map-list">${mapRows}</ul>`
    : '<p class="hint">No chapter → note mapping was returned.</p>';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay ai-preview-overlay';
  overlay.id = 'ai-preview-modal';
  overlay.innerHTML = `
    <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="ai-preview-title">
      <h2 id="ai-preview-title">Import with AI — preview</h2>
      <p class="ai-notice">Headings only — your notes stay blank for you to write in.
        AI drafts the chapter outline and empty note sections; it does not write your notes.</p>

      <h3>Outline</h3>
      ${outline.length
        ? `<ol class="ai-outline-list">${outline.map((ch) => `<li>${esc(ch.title || '')}${ch.page != null ? ` <span class="chapter-page">p. ${ch.page}</span>` : ''}</li>`).join('')}</ol>`
        : '<p class="hint">No outline was returned.</p>'}

      <h3>Note skeleton (headings only)</h3>
      <div class="ai-skeleton" id="ai-skeleton"></div>

      <h3>Chapter → note mapping</h3>
      ${mapHtml}

      <label for="ai-title">Project title</label>
      <input type="text" id="ai-title" value="${esc(title || '')}"
             placeholder="e.g. Machine Learning — Lecture 1">

      <div class="form-error" id="ai-apply-error"></div>
      <div class="modal-actions">
        <button type="button" id="ai-cancel">Cancel</button>
        <button type="button" class="primary" id="ai-apply">Apply — create project</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const skelEl = $('#ai-skeleton', overlay);
  skelEl.innerHTML = window.marked ? window.marked.parse(skeleton || '') : esc(skeleton || '');
  if (!skeleton.trim()) skelEl.innerHTML = '<p class="hint">Empty skeleton.</p>';

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAiPreviewModal(); });
  $('#ai-cancel', overlay).addEventListener('click', closeAiPreviewModal);

  $('#ai-apply', overlay).addEventListener('click', async () => {
    const errBox = $('#ai-apply-error', overlay);
    const applyBtn = $('#ai-apply', overlay);
    errBox.textContent = '';
    const currentTitle = ($('#ai-title', overlay).value || '').trim();
    if (!currentTitle) {
      errBox.textContent = 'Give the project a title, then Apply.';
      return;
    }
    applyBtn.disabled = true;
    applyBtn.textContent = 'Creating…';
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('proposal', JSON.stringify(proposal));
      form.append('title', currentTitle);
      const created = await api('/api/import/ai/apply', { method: 'POST', body: form });
      closeAiPreviewModal();
      closeModal();
      const project = created && created.project ? created.project : created;
      if (project && project.slug) {
        location.hash = `#/project/${encodeURIComponent(project.slug)}`;
      } else {
        renderHome();
      }
    } catch (err) {
      errBox.textContent = err.message && /already exists|conflict|409/i.test(err.message)
        ? 'A project with this title already exists — pick a different title.'
        : err.message;
      applyBtn.disabled = false;
      applyBtn.textContent = 'Apply — create project';
    }
  });
}

/* ---------------- reader ---------------- */

async function openProject(slug) {
  resetReaderState();
  view.innerHTML = `<div class="view-error"><p>Loading project…</p></div>`;
  let project;
  try {
    project = await apiGet(`/api/projects/${encodeURIComponent(slug)}`);
  } catch (err) {
    showError('Could not open this project.', err.message);
    return;
  }
  state.project = project;
  // Per-chapter notes: [{number, title, page, file, labs}] — the GET
  // already migrated a legacy notes.md (see the backend).
  state.chapters = Array.isArray(project.chapters) ? project.chapters : [];

  try {
    const notes = await apiGet(`/api/projects/${encodeURIComponent(slug)}/notes`);
    state.notes = Array.isArray(notes) ? notes : [];
  } catch {
    state.notes = [];
  }

  // v1.1: materials + labs. Both are optional — a 404 (older backend, or a
  // project without them) just leaves the switcher / Labs section hidden.
  try {
    const materials = await apiGet(`/api/projects/${encodeURIComponent(slug)}/materials`);
    state.materials = Array.isArray(materials) ? materials : [];
  } catch {
    state.materials = [];
  }
  try {
    const labs = await apiGet(`/api/projects/${encodeURIComponent(slug)}/labs`);
    const chapters = labs && Array.isArray(labs.chapters) ? labs.chapters
      : (Array.isArray(labs) ? labs : []);
    state.labs = chapters;
  } catch {
    state.labs = [];
  }

  // Default note: the first chapter's file when there are chapters,
  // else the first markdown note, else the first note.
  const firstChapter = (state.chapters || [])[0];
  const def = (firstChapter && state.notes.find((n) => n.name === firstChapter.file))
    || state.notes.find((n) => n.kind === 'md')
    || state.notes[0];
  if (def) {
    try { await loadNote(def.name); }
    catch { /* notebook pane renders empty; tabs still work */ }
  }

  renderReaderShell();
  renderChapterPanel();
  await renderReadingPane();
}

function renderReaderShell() {
  const p = state.project;
  const isPdf = String(p.kind || '').toLowerCase() === 'pdf';
  // The top-bar source switcher is retired for PDF projects: the left
  // pane's tabs (PDF / Slides / Markdown preview) are the switcher now,
  // with the deck picker inside the Slides tab. Other project kinds keep
  // the switcher (they have no left tabs).
  const bookLabel = isPdf
    ? 'Book (PDF)' : `Main source (${kindLabel(p.kind)})`;
  const switcher = !isPdf && state.materials.length
    ? `<select id="source-switcher" class="source-switcher" aria-label="Reading source"
         title="Switch reading source">
         <option value="">${esc(bookLabel)}</option>
         ${state.materials.map((m) => `<option value="${esc(m.id)}"${m.hasFile ? '' : ' disabled'}>${esc(m.label || m.id)}${m.hasFile ? '' : ' — download only'}</option>`).join('')}
       </select>`
    : '';
  document.body.classList.add('reader-open'); // edge-to-edge: no app header, no view padding
  view.innerHTML = `
    <div class="reader layout-${state.layoutMode} ${state.navVisible ? 'nav-visible' : 'nav-hidden'}" id="reader">
      <header class="topbar">
        <a class="back-link" href="#/">‹ Shelf</a>
        <button type="button" id="chapter-toggle" aria-pressed="${state.navVisible ? 'true' : 'false'}"
                title="Show or hide the chapter panel">Chapters</button>
        <h1>${esc(p.title || 'Untitled')}</h1>
        <div class="layout-switcher" role="group" aria-label="Layout">
          <button type="button" data-layout-mode="navigation" class="${state.layoutMode === 'navigation' ? 'active' : ''}">Navigation</button>
          <button type="button" data-layout-mode="focus" class="${state.layoutMode === 'focus' ? 'active' : ''}">Focus</button>
          <button type="button" data-layout-mode="ai" class="${state.layoutMode === 'ai' ? 'active' : ''}">AI</button>
        </div>
        ${switcher}
        <button type="button" id="ai-toggle-top" class="${state.aiPanelOpen ? 'active' : ''}"
                title="Ask the AI — opens the AI panel (same as the AI layout)">✨ Ask AI</button>
        <span class="badge">${esc(kindLabel(p.kind))}</span>
      </header>
      <aside class="chapter-panel" id="chapter-panel" aria-label="Chapters"></aside>
      <section class="reading-pane" id="reading-pane" aria-label="Reading pane"></section>
      <aside class="notebook-pane" id="notebook-pane" aria-label="Notebook"></aside>
      <aside class="ai-column" id="ai-column" aria-label="AI panel" hidden></aside>
    </div>`;

  const switcherEl = $('#source-switcher', view);
  if (switcherEl) {
    switcherEl.addEventListener('change', () => {
      switchSource(switcherEl.value || null);
    });
  }

  $$('.layout-switcher [data-layout-mode]', view).forEach((btn) => {
    btn.addEventListener('click', () => setLayoutMode(btn.dataset.layoutMode));
  });
  $('#ai-toggle-top', view).addEventListener('click', () => {
    setLayoutMode(state.layoutMode === 'ai' ? 'focus' : 'ai');
  });
  $('#chapter-toggle', view).addEventListener('click', () => {
    state.navVisible = !state.navVisible;
    applyReaderLayout();
  });

  renderNotebookPane();
  renderAiColumn();
}

/* Apply the current layout mode + manual nav state to the reader grid:
   which panes are visible, the mode buttons' active state, the Chapters
   button's pressed state, and the AI column. A layout change re-measures
   the PDF pages (the containers change width) and refreshes the left
   preview + the page-note button. */
function applyReaderLayout() {
  const reader = $('#reader', view);
  if (!reader) return;
  reader.className = `reader layout-${state.layoutMode} ${state.navVisible ? 'nav-visible' : 'nav-hidden'}`;
  $$('.layout-switcher [data-layout-mode]', view).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.layoutMode === state.layoutMode);
  });
  const chBtn = $('#chapter-toggle', view);
  if (chBtn) chBtn.setAttribute('aria-pressed', state.navVisible ? 'true' : 'false');
  const aiTop = $('#ai-toggle-top', view);
  if (aiTop) aiTop.classList.toggle('active', state.aiPanelOpen);
  const col = $('#ai-column', view);
  if (col) col.hidden = state.layoutMode !== 'ai';
  if (state.pdfDoc) measurePdfPages();
  if (state.deckDoc) measureDeckPages();
  renderAiColumn();
  updatePageNoteButton();
}

/* Set a layout mode. The mode buttons set the canonical arrangement
   (Navigation = nav on + notebook off; Focus = nav off + notebook on;
   AI = Focus + the AI panel); the mode only changes which panes are
   visible — the chapter, page, active tabs and selection survive. */
function setLayoutMode(mode) {
  if (!['navigation', 'focus', 'ai'].includes(mode)) return;
  if (state.layoutMode === mode) return;
  state.layoutMode = mode;
  state.aiPanelOpen = mode === 'ai';
  state.navVisible = mode === 'navigation';
  applyReaderLayout();
  renderNotebookToolbar();
}

/* ---------------- source switching (v1.1) ---------------- */

function activeSourceLabel() {
  if (!state.activeSourceId) {
    return String(state.project?.kind || '').toLowerCase() === 'pdf'
      ? 'Book (PDF)' : 'Main source';
  }
  const mat = state.materials.find((m) => String(m.id) === String(state.activeSourceId));
  return mat ? (mat.label || mat.id) : 'Material';
}

/* Switch the reading pane to another source. null = the project's main source
   (re-renders the native reader). A material loads its PDF into the existing
   pdf.js viewer; the notebook pane is untouched. A material with no file is
   never selectable (its <option> is disabled). */
async function switchSource(materialId) {
  state.activeSourceId = materialId;
  const pane = $('#reading-pane', view);
  if (!pane) return;
  if (!materialId) {
    await renderReadingPane();
    return;
  }
  const mat = state.materials.find((m) => String(m.id) === String(materialId));
  pane.innerHTML = `<div class="reading-scroll" id="pdf-scroll"><p class="reading-note">Loading ${esc(mat?.label || 'material')}…</p></div>`;
  await loadPdf(
    `/api/projects/${encodeURIComponent(state.project.slug)}/materials/${encodeURIComponent(materialId)}/file`,
    '',
  );
}

/* ---------------- reading pane ---------------- */

async function renderReadingPane() {
  const p = state.project;
  const pane = $('#reading-pane', view);
  if (!pane) return;
  const kind = String(p.kind || '').toLowerCase();
  const fileUrl = `/api/projects/${encodeURIComponent(p.slug)}/file`;
  const sourceUrl = p.url || p.sourceUrl || '';

  if (kind === 'pdf') {
    // Tabbed reading pane: PDF | Slides | Markdown preview. The book PDF
    // and the deck PDF live in separate containers so each tab keeps its
    // scroll position; the preview renders the current chapter's file
    // (or the master index when no chapter is active).
    pane.innerHTML = `
      <div class="reading-tabs" id="reading-tabs" role="tablist" aria-label="Reading">
        <button type="button" class="reading-tab${state.leftTab === 'pdf' ? ' active' : ''}" data-left-tab="pdf" role="tab">PDF</button>
        <button type="button" class="reading-tab${state.leftTab === 'slides' ? ' active' : ''}" data-left-tab="slides" role="tab">Slides</button>
        <button type="button" class="reading-tab${state.leftTab === 'preview' ? ' active' : ''}" data-left-tab="preview" role="tab">Markdown preview</button>
      </div>
      <div class="reading-tab-panels">
        <div class="reading-tab-panel" id="panel-pdf" ${state.leftTab === 'pdf' ? '' : 'hidden'}>
          <div class="reading-scroll" id="pdf-scroll"><p class="reading-note">Loading PDF…</p></div>
        </div>
        <div class="reading-tab-panel" id="panel-slides" ${state.leftTab === 'slides' ? '' : 'hidden'}>
          <div class="deck-picker-row">
            <label>Deck <select id="deck-picker" aria-label="Slide deck"></select></label>
            <span class="deck-page-indicator" id="deck-page-indicator"></span>
          </div>
          <div class="reading-scroll" id="deck-scroll"><p class="reading-note">${state.materials.length ? 'Open the Slides tab to read a deck.' : 'No slide decks in this project.'}</p></div>
        </div>
        <div class="reading-tab-panel" id="panel-preview" ${state.leftTab === 'preview' ? '' : 'hidden'}>
          <div class="preview-crumb" id="preview-crumb"></div>
          <div class="reading-scroll" id="left-preview-scroll"><div class="md-preview" id="left-md-preview"></div></div>
        </div>
      </div>`;
    $$('#reading-tabs [data-left-tab]', pane).forEach((btn) => {
      btn.addEventListener('click', () => setLeftTab(btn.dataset.leftTab));
    });
    syncDeckPicker();
    $('#deck-picker', pane).addEventListener('change', (e) => {
      if (e.target.value) ensureDeckLoaded(e.target.value);
    });
    await loadPdf(fileUrl, sourceUrl);
    applyLeftTab();
    return;
  }
  if (kind === 'video') {
    const yt = sourceUrl ? youtubeEmbedUrl(sourceUrl) : null;
    if (yt) {
      pane.innerHTML = `<div class="video-wrap"><iframe src="${esc(yt)}" title="YouTube video"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen></iframe></div>`;
    } else {
      pane.innerHTML = `<div class="video-wrap"><video controls preload="metadata"
        src="${esc(fileUrl)}"></video></div>`;
    }
  } else if (kind === 'slides') {
    const embed = sourceUrl ? slidesEmbedUrl(sourceUrl) : fileUrl;
    pane.innerHTML = `<div class="slides-wrap"><iframe src="${esc(embed)}" title="Slides"
      allowfullscreen></iframe></div>`;
  } else if (kind === 'ppt') {
    pane.innerHTML = `
      <div class="ppt-card">
        <h2>PowerPoint file</h2>
        <p class="file-name">${esc(p.file || p.sourceName || p.title || 'presentation')}</p>
        <p>Preview isn't available in v1 — download to open in PowerPoint / Keynote.</p>
        <a href="${esc(fileUrl)}" download><button class="primary" type="button">Download</button></a>
      </div>`;
  } else {
    pane.innerHTML = `<p class="reading-note">This project kind has no reader yet.
      <a href="${esc(fileUrl)}">Download the source file</a>.</p>`;
  }
}

/* The deck for the chapter the reader is on (the Slides tab default), or
   the first deck with a file when the chapter has none. */
function defaultDeckId() {
  const ch = activeOutlineChapter();
  const byChapter = ch ? deckForChapter(ch.title) : null;
  if (byChapter && byChapter.hasFile !== false) return byChapter.id;
  // A subsection (or a chapter with no deck of its own) has no deck: use
  // the chapter containing the current book page instead of falling through
  // to the first deck.
  const pageChapter = state.pdfDoc ? chapterForPage(currentPdfPage()) : null;
  const byPage = pageChapter ? deckForChapter(pageChapter.title) : null;
  if (byPage && byPage.hasFile !== false) return byPage.id;
  const first = (state.materials || []).find((m) => m.hasFile !== false);
  return first ? first.id : null;
}

/* Fill the deck picker; select the current chapter's deck (or the deck
   already open). Called on pane render and on chapter change. */
function syncDeckPicker() {
  const sel = $('#deck-picker', view);
  if (!sel) return;
  const current = state.deckMaterialId || defaultDeckId();
  sel.innerHTML = (state.materials || []).map((m) => (
    `<option value="${esc(m.id)}"${m.hasFile ? '' : ' disabled'}${m.id === current ? ' selected' : ''}>${esc(m.label || m.id)}${m.hasFile ? '' : ' — download only'}</option>`
  )).join('');
}

/* Switch the left (reading) tab. The deck loads lazily on first Slides
   open; the preview renders on open. The tab also drives activeSourceId
   (pdf/preview -> the book, slides -> the deck) so the chapter panel's
   source note and the AI context line follow it. */
function setLeftTab(tab) {
  if (!['pdf', 'slides', 'preview'].includes(tab)) return;
  state.leftTab = tab;
  state.activeSourceId = tab === 'slides' ? state.deckMaterialId : null;
  applyLeftTab();
  renderChapterPanel();
  updateAiContext();
  updatePageNoteButton();
}

function applyLeftTab() {
  $$('#reading-tabs [data-left-tab]', view).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.leftTab === state.leftTab);
  });
  const panels = { pdf: '#panel-pdf', slides: '#panel-slides', preview: '#panel-preview' };
  Object.entries(panels).forEach(([tab, sel]) => {
    const el = $(sel, view);
    if (el) el.hidden = tab !== state.leftTab;
  });
  if (state.leftTab === 'pdf') measurePdfPages();
  if (state.leftTab === 'slides') {
    const want = defaultDeckId();
    // The deck follows the chapter: a chapter clicked while the PDF tab was
    // open re-resolves the deck when the Slides tab opens — an already-
    // loaded deck is NOT kept just because it is loaded. A deck chosen
    // while viewing the current chapter (including a manual picker choice)
    // stays until the chapter changes.
    if (want && want !== state.deckMaterialId && state.activeChapter !== (state.deckChapter ?? null)) {
      ensureDeckLoaded(want);
    } else {
      ensureDeckLoaded(state.deckMaterialId || want);
    }
    measureDeckPages();
  }
  if (state.leftTab === 'preview') renderLeftPreview();
}

/* The page the user is reading, as a page-anchor {sourceId, page}:
   the book PDF's current page, the deck's current slide, or (Preview tab)
   the active chapter's start page. Null when the project has no pages
   (video / slides / ppt kinds) or no chapter is active. */
function currentReadingPage() {
  if (String(state.project?.kind || '').toLowerCase() !== 'pdf') return null;
  if (state.leftTab === 'slides') {
    if (!state.deckMaterialId) return null;
    return { sourceId: state.deckMaterialId, page: currentDeckPage() };
  }
  if (state.leftTab === 'preview') {
    const ch = activeOutlineChapter();
    if (!ch || ch.page == null) return null;
    return { sourceId: PAGE_ANCHOR_SOURCE_BOOK, page: ch.page };
  }
  if (!state.pdfDoc) return null; // the book has not loaded yet
  return { sourceId: PAGE_ANCHOR_SOURCE_BOOK, page: currentPdfPage() };
}

/* Jump the LEFT pane to an anchored page/slide (chip click). Switches to
   the right tab, loads the deck when needed, and scrolls there. */
async function jumpToAnchor(sourceId, page) {
  if (String(state.project?.kind || '').toLowerCase() !== 'pdf') return;
  if (!sourceId || sourceId === PAGE_ANCHOR_SOURCE_BOOK) {
    setLeftTab('pdf');
    scrollBookToPage(page);
    return;
  }
  setLeftTab('slides');
  await ensureDeckLoaded(sourceId);
  scrollDeckToPage(page);
}

/* Scroll the book container to a page, with the same scroll-spy
   suppression as a chapter click (see setActiveChapter). */
function scrollBookToPage(page) {
  const container = state.pdfContainer;
  if (!container) return;
  measurePdfPages();
  const pg = state.pdfPages.find((p) => p.num === page);
  if (!pg) return;
  const top = Math.max(0, pg.top - 8);
  state.suppressSpyUntil = Date.now() + 3000;
  state.suppressSpyPage = page;
  state.suppressSpyTop = top;
  container.scrollTo({ top, behavior: 'smooth' });
}

function scrollDeckToPage(page) {
  const container = state.deckContainer;
  if (!container) return;
  measureDeckPages();
  const pg = state.deckPages.find((p) => p.num === page);
  if (!pg) return;
  container.scrollTo({ top: Math.max(0, pg.top - 8), behavior: 'smooth' });
}

/* ---------------- PDF ---------------- */

async function loadPdf(fileUrl, sourceUrl) {
  const container = $('#pdf-scroll', view);
  if (!container) return;
  state.pdfContainer = container;
  // Source switches reload into the same viewer: drop the previous document
  // and any in-flight chapter-click suppression (its target page belongs to
  // the old document). The race fix itself is unchanged — setActiveChapter
  // re-arms suppression for the next click.
  if (state.pdfDoc) { try { state.pdfDoc.destroy(); } catch { /* ignore */ } state.pdfDoc = null; }
  state.suppressSpyUntil = 0;
  state.suppressSpyPage = null;
  state.suppressSpyTop = null;
  let pdf;
  try {
    const url = sourceUrl && /\.pdf(\?|#|$)/i.test(sourceUrl) ? sourceUrl : fileUrl;
    const task = pdfjsLib.getDocument({ url });
    pdf = await task.promise;
  } catch (err) {
    container.innerHTML = `<p class="reading-note">Could not load this PDF: ${esc(err.message)}</p>`;
    // No readable document: clear the outline so the chapter panel falls
    // back to the note headings as navigation (same as a slide deck).
    state.outline = [];
    renderChapterPanel();
    return;
  }
  state.pdfDoc = pdf;

  // Outline (chapters) — resolve each destination to a page number.
  try {
    const outline = await pdf.getOutline();
    state.outline = await flattenOutline(pdf, outline || []);
  } catch {
    state.outline = [];
  }
  renderChapterPanel();

  await mountPdfViewer(container, pdf, { measure: measurePdfPages, onScroll: onPdfScroll });

  // Lazy cover: first page rendered small, posted once per open.
  if (!state.project.cover && !state.coverGenerated) {
    state.coverGenerated = true;
    generateCover(pdf);
  }
  onPdfScroll();
}

/* Shared PDF viewer mounting: one placeholder per page, canvases render
   lazily near the viewport (IntersectionObserver), scroll events throttled
   through requestAnimationFrame. Used by the book (loadPdf) and by slide
   decks (loadDeckPdf) so both tabs keep their own scroll position. */
async function mountPdfViewer(container, pdf, { measure, onScroll }) {
  const SCALE = 1.3;
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: SCALE });
  const pageW = Math.floor(vp.width);
  const pageH = Math.floor(vp.height);
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  const placeholders = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const holder = document.createElement('div');
    holder.className = 'pdf-page';
    holder.dataset.page = String(n);
    holder.style.width = `${pageW}px`;
    holder.style.height = `${pageH}px`;
    holder.innerHTML = `<span class="page-num">p. ${n}</span>`;
    frag.appendChild(holder);
    placeholders.push(holder);
  }
  container.appendChild(frag);
  measure();

  const renderPage = async (holder) => {
    if (holder.dataset.rendered) return;
    holder.dataset.rendered = '1';
    try {
      const pg = await pdf.getPage(Number(holder.dataset.page));
      const viewport = pg.getViewport({ scale: SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const num = $('.page-num', holder);
      holder.insertBefore(canvas, num);
      await pg.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    } catch {
      delete holder.dataset.rendered;
    }
  };

  // A re-mount into the same container (deck switches) drops the old
  // observer so it stops holding the detached placeholders.
  if (container._pdfObserver) container._pdfObserver.disconnect();
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) renderPage(e.target); });
  }, { root: container, rootMargin: '600px 0px' });
  container._pdfObserver = io;
  placeholders.forEach((h) => io.observe(h));

  // The scroll listener is bound once per element: the book container is
  // recreated on every renderReadingPane, and the deck container is
  // replaced on every deck load (see loadDeckPdf).
  if (!container.dataset.scrollBound) {
    container.dataset.scrollBound = '1';
    let ticking = false;
    container.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; onScroll(); });
    }, { passive: true });
  }
}

/* Load a slide deck into the Slides tab's own container (the book PDF is
   never unloaded). The deck keeps its own document, page offsets and scroll
   position; it never touches the chapter panel (the panel stays the book's
   outline) or the scroll-spy. */
let deckLoadPromise = null; // {materialId, promise} — one in-flight deck load
let leftPreviewTimer = null; // debounce for the left Preview tab's live sync

async function ensureDeckLoaded(materialId) {
  if (!materialId) return;
  if (state.deckDoc && state.deckMaterialId === materialId) return;
  if (deckLoadPromise && deckLoadPromise.materialId === materialId) {
    await deckLoadPromise.promise;
    return;
  }
  deckLoadPromise = { materialId, promise: loadDeckPdf(materialId) };
  try {
    await deckLoadPromise.promise;
  } finally {
    if (deckLoadPromise?.materialId === materialId) deckLoadPromise = null;
  }
}

async function loadDeckPdf(materialId) {
  const container = $('#deck-scroll', view);
  if (!container || !materialId) return;
  const mat = state.materials.find((m) => String(m.id) === String(materialId));
  // listMaterials() strips the server-side `file` path and reports only
  // `hasFile` — the file URL is built from the material id below, so the
  // guard must read hasFile, never mat.file (always undefined here).
  if (!mat || mat.hasFile === false) return;
  // Replace the container so a re-mount never stacks scroll listeners on
  // the same element (mountPdfViewer binds them once per element). The
  // clone carries the data-scroll-bound flag as an attribute — drop it so
  // the fresh element gets its own listener.
  const fresh = container.cloneNode(false);
  delete fresh.dataset.scrollBound;
  container.replaceWith(fresh);
  state.deckContainer = fresh;
  state.deckMaterialId = materialId;
  // The deck was chosen while viewing this chapter: opening the Slides tab
  // later keeps it until the chapter changes. A manual picker choice made
  // while viewing a chapter therefore survives tab toggles, while a chapter
  // clicked on the PDF tab re-resolves the deck on the next Slides open
  // (applyLeftTab). Recorded here — synchronously, before the async fetch —
  // so it captures the chapter at decision time, not at load completion.
  state.deckChapter = state.activeChapter ?? null;
  if (state.deckDoc) { try { state.deckDoc.destroy(); } catch { /* ignore */ } state.deckDoc = null; }
  fresh.innerHTML = `<p class="reading-note">Loading ${esc(mat.label || 'deck')}…</p>`;
  let pdf;
  try {
    const url = `/api/projects/${encodeURIComponent(state.project.slug)}/materials/${encodeURIComponent(materialId)}/file`;
    pdf = await pdfjsLib.getDocument({ url }).promise;
  } catch (err) {
    fresh.innerHTML = `<p class="reading-note">Could not load this deck: ${esc(err.message)}</p>`;
    return;
  }
  state.deckDoc = pdf;
  await mountPdfViewer(fresh, pdf, { measure: measureDeckPages, onScroll: onDeckScroll });
  // The Slides tab may have opened before the load finished; the chapter
  // panel's source note and the AI context line follow the loaded deck.
  if (state.leftTab === 'slides') {
    state.activeSourceId = materialId;
    renderChapterPanel();
    updateAiContext();
  }
  syncDeckPicker();
  updateDeckPageIndicator();
  updatePageNoteButton();
}

function measureDeckPages() {
  const container = state.deckContainer;
  if (!container) return;
  // Same hidden-panel guard as measurePdfPages: all-zero tops would make
  // currentDeckPage() return the last slide for any scrollTop.
  if (!container.getClientRects().length) return;
  state.deckPages = $$('.pdf-page', container).map((el) => ({
    num: Number(el.dataset.page),
    top: el.offsetTop,
  }));
}

function currentDeckPage() {
  const container = state.deckContainer;
  if (!container || !state.deckPages.length) return 1;
  const y = container.scrollTop + 80;
  let current = 1;
  for (const pg of state.deckPages) {
    if (pg.top <= y) current = pg.num;
    else break;
  }
  return current;
}

function updateDeckPageIndicator() {
  const el = $('#deck-page-indicator', view);
  if (!el) return;
  el.textContent = state.deckDoc
    ? `Slide ${currentDeckPage()} / ${state.deckDoc.numPages}`
    : '';
}

/* Deck scroll: the slide indicator + the AI context line follow the slide
   (no chapter follow — the deck has no chapter mapping of its own). */
function onDeckScroll() {
  updateDeckPageIndicator();
  updateAiContext();
  updatePageNoteButton();
}

async function flattenOutline(pdf, items, depth = 0, out = []) {
  for (const item of items) {
    let pageNum = null;
    try {
      if (item.dest) {
        const dest = typeof item.dest === 'string'
          ? await pdf.getDestination(item.dest) : item.dest;
        if (Array.isArray(dest) && dest[0]) {
          const idx = await pdf.getPageIndex(dest[0]);
          pageNum = idx + 1;
        }
      }
    } catch { /* leave pageNum null */ }
    out.push({ title: String(item.title || ''), page: pageNum, depth });
    if (Array.isArray(item.items) && item.items.length) {
      await flattenOutline(pdf, item.items, depth + 1, out);
    }
  }
  return out;
}

function measurePdfPages() {
  const container = state.pdfContainer;
  if (!container) return;
  // A hidden panel reports offsetTop 0 for every page: measuring while the
  // PDF tab is hidden (a layout switch on the Slides/Preview tab, a chip
  // jump from the preview) would corrupt state.pdfPages with all-zero tops,
  // and currentPdfPage() would then return the last page for any scrollTop.
  // Keep the last good measurements instead; applyLeftTab re-measures on
  // return to the tab.
  if (!container.getClientRects().length) return;
  state.pdfPages = $$('.pdf-page', container).map((el) => ({
    num: Number(el.dataset.page),
    top: el.offsetTop,
  }));
}

function currentPdfPage() {
  const container = state.pdfContainer;
  if (!container || !state.pdfPages.length) return 1;
  const y = container.scrollTop + 80;
  let current = 1;
  for (const pg of state.pdfPages) {
    if (pg.top <= y) current = pg.num;
    else break;
  }
  return current;
}

function chapterForPage(pageNum) {
  // Resolve to the CHAPTER containing the page — a depth-0 outline entry —
  // never a subsection (depth 1+): subsections have no chapter file, so
  // settling on one would strand note-follow, page anchors and AI
  // context ("Momentum" at p.100 instead of "Fitting models"). Entries
  // that resolve to a chapter file (by title or page) are the chapters;
  // front matter (Preface, Acknowledgements) and appendices (Notation,
  // Bibliography, Index) are skipped. When no entry resolves — e.g. an
  // uploaded PDF whose headings never matched — any depth-0 entry counts.
  // Before the first chapter (cover / front matter) the first chapter is
  // current, so the note/AI context is never empty on the opening pages.
  const mapped = state.outline.filter((ch) => ch.depth === 0 && ch.page != null
    && resolvedChapter(ch) !== null);
  const pool = mapped.length
    ? mapped
    : state.outline.filter((ch) => ch.depth === 0 && ch.page != null);
  let best = null;
  for (const ch of pool) {
    if (ch.page <= pageNum) best = ch;
    else break;
  }
  return best || pool[0] || null;
}

function onPdfScroll() {
  if (!state.pdfDoc || !state.outline.length) return;
  if (Date.now() < state.suppressSpyUntil) {
    // A programmatic chapter-click scroll is still in flight: ignore the spy
    // so the clicked chapter stays active. Release early once the scroll has
    // arrived at (and stopped on) the target page — and resolve the chapter
    // for that page at once, so a programmatic jump (chapter click, anchor
    // chip) updates the active chapter immediately instead of waiting for
    // the next manual scroll, which would leave AI context and anchors
    // pointing at the stale chapter. The timestamp is the backstop for a
    // scroll that can never reach its target (e.g. clamped at max
    // scrollTop on the last page).
    const arrived = state.suppressSpyPage != null
      && state.pdfContainer
      && state.suppressSpyTop != null
      && currentPdfPage() >= state.suppressSpyPage
      && Math.abs(state.pdfContainer.scrollTop - state.suppressSpyTop) <= 2;
    if (!arrived) return;
    state.suppressSpyUntil = 0;
    state.suppressSpyPage = null;
    state.suppressSpyTop = null;
    // Fall through to the spy below.
  }
  const ch = chapterForPage(currentPdfPage());
  if (ch && normalizeHeading(ch.title) !== state.activeChapter) {
    setActiveChapter(ch, { scrollNotebook: true });
  }
  // The button advertises the page being read: refresh it on every scroll,
  // not only on chapter changes — otherwise a manual scroll inside the
  // same chapter leaves it showing the old page (the deck scroll already
  // does this; the book scroll did not).
  updatePageNoteButton();
}

async function generateCover(pdf) {
  try {
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const scale = 300 / vp.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const dataUrl = canvas.toDataURL('image/png');
    await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/cover`, 'POST', { dataUrl });
    state.project.cover = 'cover.png';
  } catch {
    // Lazy cover generation is best-effort; ignore failures silently.
  }
}

/* ---------------- chapter panel ---------------- */

/* Resolve an outline chapter (or a chapter title) to its chapter file:
   the entry in state.chapters [{number, title, page, file, labs}].
   Title match first (normalized — the file's `##` heading carries its
   number, e.g. "12. Transformers", which normalizes to the outline's
   "Transformers"), then page match (so a renamed heading still resolves
   by its `<!-- p. N -->` comment). Null when the chapter has no file yet. */
function resolvedChapter(chapter) {
  const list = state.chapters || [];
  const title = typeof chapter === 'string' ? chapter : chapter?.title;
  const page = typeof chapter === 'object' ? chapter?.page : null;
  if (title) {
    const norm = normalizeHeading(title);
    if (norm) {
      const byTitle = list.find((c) => normalizeHeading(c.title) === norm);
      if (byTitle) return byTitle;
    }
  }
  if (Number.isInteger(page)) {
    const byPage = list.find((c) => c.page === page);
    if (byPage) return byPage;
  }
  return null;
}

/* The chapter file the reader is on (null when no chapter is active). */
function currentChapterFile() {
  const ch = activeOutlineChapter();
  if (ch) {
    const entry = resolvedChapter(ch);
    if (entry) return entry.file;
  }
  // No outline chapter: the active note when it is a chapter file, else
  // the first chapter (a video project still has chapters to preview).
  if (state.activeTabKind === 'note' && isChapterFileName(state.activeNoteName)) {
    return state.activeNoteName;
  }
  return (state.chapters || [])[0]?.file ?? null;
}

/* The chapter entry the reader is on (null when no chapter is active). */
function currentChapterEntry() {
  const file = currentChapterFile();
  return file ? (state.chapters || []).find((c) => c.file === file) ?? null : null;
}

function renderChapterPanel() {
  const panel = $('#chapter-panel', view);
  if (!panel) return;
  const kind = String(state.project?.kind || '').toLowerCase();

  // A slide deck has no PDF outline of its own: when the active source's PDF
  // yields no outline, state.outline is empty and this falls through to the
  // chapter-files nav below — nothing is invented.
  const sourceNote = state.activeSourceId
    ? `<p class="chapter-source">Source: ${esc(activeSourceLabel())}</p>` : '';

  if (kind === 'pdf' && state.outline.length) {
    panel.innerHTML = `<h2>Chapters</h2>${sourceNote}` + state.outline.map((ch, i) => {
      const isActive = state.activeChapter === normalizeHeading(ch.title);
      const indent = ch.depth ? ` style="padding-left:${16 + ch.depth * 14}px"` : '';
      return `<button type="button" class="chapter-row${isActive ? ' active' : ''}"
          data-chapter="${i}" data-chapter-title="${esc(normalizeHeading(ch.title))}"${indent}>${esc(ch.title)}${ch.page != null ? `<span class="chapter-page">p. ${ch.page}</span>` : ''}</button>`;
    }).join('');

    $$('.chapter-row', panel).forEach((btn) => {
      btn.addEventListener('click', () => {
        const ch = state.outline[Number(btn.dataset.chapter)];
        setActiveChapter(ch, { scrollNotebook: true, scrollPdf: true, force: true });
      });
    });
    return;
  }

  // No PDF outline (or not a PDF): the chapter files are the nav.
  const chapters = state.chapters || [];
  panel.innerHTML = `<h2>Chapters</h2>${sourceNote}` +
    (chapters.length
      ? chapters.map((c) => `
          <button type="button" class="chapter-row${state.activeChapter === normalizeHeading(c.title) ? ' active' : ''}"
            data-chapter-title="${esc(normalizeHeading(c.title))}">${esc(c.title)}${c.page != null ? `<span class="chapter-page">p. ${c.page}</span>` : ''}</button>`).join('')
      : `<p class="chapter-empty">No chapters yet — add a note and it will
         show up here as navigation.</p>`);
  $$('.chapter-row', panel).forEach((btn) => {
    btn.addEventListener('click', () => {
      const entry = (state.chapters || []).find((c) => normalizeHeading(c.title) === btn.dataset.chapterTitle);
      if (!entry) return;
      setActiveChapter(entry, { scrollNotebook: true, force: true });
    });
  });
}

async function setActiveChapter(chapter, { scrollNotebook = false, scrollPdf = false, force = false } = {}) {
  state.activeChapter = normalizeHeading(chapter.title);
  state.showIndex = false; // a chapter change shows the chapter, not the index
  $$('#chapter-panel .chapter-row').forEach((row) => {
    row.classList.toggle('active', row.dataset.chapterTitle === state.activeChapter);
  });
  if (scrollPdf && chapter.page != null && state.pdfContainer) {
    const pg = state.pdfPages.find((p) => p.num === chapter.page);
    if (pg) {
      const top = Math.max(0, pg.top - 8);
      // Arm scroll-spy suppression for this programmatic scroll (see state):
      // the smooth scroll fires scroll events the whole way, and the spy
      // would otherwise overwrite the clicked chapter with an intermediate
      // chapter as the scroll passes through it. The 3000ms backstop covers
      // a scroll that never lands on its target; onPdfScroll releases early
      // on arrival and resolves the chapter for the target page.
      state.suppressSpyUntil = Date.now() + 3000;
      state.suppressSpyPage = chapter.page;
      state.suppressSpyTop = top;
      state.pdfContainer.scrollTo({ top, behavior: 'smooth' });
    }
  }
  if (scrollNotebook) await followChapterFile(chapter, force);
  updateAiContext(); // keep the Ask AI panel's context line live
  updatePageNoteButton(); // the "+ Note here" button follows the page
  followDeckToChapter(chapter);
  followLabsToChapter(chapter);
  renderLeftPreview(); // the preview renders the chapter's file
}

/* Follow the chapter in the notebook pane: open the chapter's file.
   An explicit chapter click (force) always opens the file. The scroll-spy
   (not force) only switches when the user is already in a chapter file —
   a lab or a standalone note is never yanked away by scrolling — and
   never while the editor is focused or Follow is off. A chapter with no
   file yet gets one created on demand (explicit click only). Unsaved
   edits in the current markdown note are saved first so following never
   drops them. */
async function followChapterFile(chapter, force) {
  const entry = resolvedChapter(chapter);
  if (!entry) {
    if (!force) return;
    try {
      const created = await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/chapters`,
        'POST', { title: chapter.title, page: chapter.page ?? null });
      if (Array.isArray(created.chapters)) state.chapters = created.chapters;
      if (created.chapter) await openChapterFile(created.chapter);
    } catch {
      // Leave the pane alone — the chapter still has no file.
    }
    return;
  }
  if (!force) {
    if (!state.follow || state.editorFocused) return;
    if (!(state.activeTabKind === 'note' && isChapterFileName(state.activeNoteName))) return;
  }
  if (state.activeTabKind === 'note' && state.activeNoteName === entry.file) return;
  await openChapterFile(entry);
}

async function openChapterFile(entry) {
  if (state.activeTabKind === 'note' && state.activeNoteKind === 'md' && state.mdDirty) {
    await saveActiveMdNote(false);
  }
  try {
    await loadNote(entry.file);
  } catch {
    return;
  }
  renderNotebookPane();
}

/* The Slides tab follows the chapter: when the chapter has its own deck,
   the tab switches to it (picker + viewer). When it has none, the current
   deck stays. Only acts while the Slides tab is open — otherwise the deck
   is picked up when the tab opens (defaultDeckId). */
function followDeckToChapter(chapter) {
  if (state.leftTab !== 'slides') return;
  const deck = deckForChapter(chapter.title);
  if (!deck || deck.hasFile === false) return;
  if (deck.id === state.deckMaterialId) return;
  syncDeckPicker();
  ensureDeckLoaded(deck.id);
}

/* The Labs section follows the chapter: the chapter's lab group expands
   (ChapNN from the chapter file's number) so its labs are visible. The
   notebook pane is never scrolled — expanding is enough. */
function followLabsToChapter(chapter) {
  const entry = resolvedChapter(chapter);
  const group = labGroupForChapterNumber(entry?.number ?? null);
  if (!group || !state.labs.some((g) => g.chapter === group)) return;
  if (state.labsOpenChapters[group]) return;
  state.labsOpenChapters[group] = true;
  renderLabsSection();
}

/* Keep the cached note text fresh (the left Preview tab renders from it
   when the active right tab is not the previewed file). */
function syncNoteCache(name, text) {
  if (typeof name === 'string') state.noteCache[name] = typeof text === 'string' ? text : null;
}

/* Render the left Preview tab: the current chapter's file, or the master
   index when no chapter is active (or the user picked Index in the crumb).
   The preview keeps its scroll position across re-renders of the SAME file;
   a different file scrolls to the top. The crumb above it links back to
   the index. */
async function renderLeftPreview() {
  const el = $('#left-md-preview', view);
  if (!el) return;
  const file = (state.showIndex || !currentChapterFile()) ? 'index.md' : currentChapterFile();
  let text;
  if (state.activeTabKind === 'note' && state.activeNoteName === file) {
    text = state.activeNoteContent;
  } else if (state.noteCache[file] != null) {
    text = state.noteCache[file];
  } else {
    try {
      const data = await apiGet(`/api/projects/${encodeURIComponent(state.project.slug)}/notes/${encodeURIComponent(file)}`);
      text = typeof data === 'string' ? data : (data.content ?? '');
      state.noteCache[file] = text;
    } catch {
      text = '';
    }
  }
  const changed = state.previewFile !== file;
  renderMdPreview(el, text);
  state.previewFile = file;
  if (changed) {
    const scroll = $('#left-preview-scroll', view);
    if (scroll) scroll.scrollTop = 0;
  }
  const crumb = $('#preview-crumb', view);
  if (crumb) {
    if (file === 'index.md') {
      crumb.innerHTML = `<span class="preview-crumb-here">Index</span>`;
    } else {
      const entry = (state.chapters || []).find((c) => c.file === file);
      crumb.innerHTML = `<button type="button" class="preview-crumb-link" id="preview-crumb-index">Index</button><span class="preview-crumb-sep"> › </span><span>${esc(entry ? entry.title : file)}</span>`;
      $('#preview-crumb-index', crumb).addEventListener('click', () => {
        state.showIndex = true;
        renderLeftPreview();
      });
    }
  }
}


/* ---------------- notebook ---------------- */

async function loadNote(name) {
  const slug = state.project.slug;
  const data = await apiGet(`/api/projects/${encodeURIComponent(slug)}/notes/${encodeURIComponent(name)}`);
  const content = typeof data === 'string' ? data : (data.content ?? '');
  state.activeTabKind = 'note';
  state.activeLab = null;
  state.activeNoteName = name;
  state.activeNoteKind = name.toLowerCase().endsWith('.ipynb') ? 'ipynb' : 'md';
  state.activeNoteContent = content;
  state.activeNotebook = null;
  state.mdDirty = false;
  syncNoteCache(name, content);
  if (state.activeNoteKind === 'ipynb') {
    try { state.activeNotebook = JSON.parse(content || '{"cells":[]}'); }
    catch { state.activeNotebook = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }; }
    if (!Array.isArray(state.activeNotebook.cells)) state.activeNotebook.cells = [];
    resetExecCounter();
  }
}

/* Continue execution_count from the highest count already stored in the
   notebook (0 when none ran yet), so a reloaded notebook keeps counting. */
function resetExecCounter() {
  state.execCounter = 0;
  (state.activeNotebook?.cells ?? []).forEach((c) => {
    if (typeof c.execution_count === 'number') {
      state.execCounter = Math.max(state.execCounter, c.execution_count);
    }
  });
}

function renderNotebookPane() {
  const pane = $('#notebook-pane', view);
  if (!pane) return;
  // The AI panel used to live here (embedded); it is now the rightmost
  // column of the reader (see renderAiColumn) — no ai-panel div here.
  pane.innerHTML = `
    <div class="notebook-tabs" id="notebook-tabs"></div>
    <div class="notebook-toolbar" id="notebook-toolbar"></div>
    <div class="labs-section" id="labs-section" hidden></div>
    <div class="notebook-body" id="notebook-body"></div>`;

  const tabs = $('#notebook-tabs', pane);
  state.notes.forEach((n) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `note-tab${state.activeTabKind === 'note' && n.name === state.activeNoteName ? ' active' : ''}`;
    // A chapter file shows its chapter title; the filename is the tooltip.
    const chapter = (state.chapters || []).find((c) => c.file === n.name);
    tab.textContent = chapter ? chapter.title : n.name;
    tab.title = n.name;
    tab.addEventListener('click', async () => {
      if (state.activeTabKind === 'note' && n.name === state.activeNoteName) return;
      await loadNote(n.name);
      renderNotebookPane();
      // Opening a chapter file makes it the current chapter (same rule as
      // an index link): the preview, the AI context and the "+ Note here"
      // button follow the file. A plain note leaves the chapter alone.
      const entry = (state.chapters || []).find((c) => c.file === n.name);
      if (entry) await setActiveChapter(entry, { scrollNotebook: true });
      else renderChapterPanel();
    });
    tabs.appendChild(tab);
  });
  // Labs opened as tabs (v1.1): only the opened lab becomes a tab.
  state.labTabs.forEach((lab) => {
    const isActive = state.activeTabKind === 'lab' && state.activeLab
      && state.activeLab.chapter === lab.chapter && state.activeLab.name === lab.name;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `note-tab lab-tab${isActive ? ' active' : ''}`;
    tab.title = `${lab.chapter}/${lab.name}`;
    const label = document.createElement('span');
    label.textContent = labDisplayName(lab.name);
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.title = 'Close lab tab';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeLabTab(lab); });
    tab.append(label, close);
    tab.addEventListener('click', async () => {
      if (isActive) return;
      await loadLab(lab.chapter, lab.name);
      renderNotebookPane();
      renderChapterPanel();
    });
    tabs.appendChild(tab);
  });
  const addMd = document.createElement('button');
  addMd.type = 'button';
  addMd.className = 'note-tab-add';
  addMd.textContent = '+ Note';
  addMd.addEventListener('click', createMdNote);
  tabs.appendChild(addMd);
  const addNb = document.createElement('button');
  addNb.type = 'button';
  addNb.className = 'note-tab-add';
  addNb.textContent = '+ Notebook';
  addNb.addEventListener('click', createIpynbNote);
  tabs.appendChild(addNb);

  renderNotebookToolbar();
  renderLabsSection();
  renderNotebookBody();
}

/* ---------------- labs (v1.1) ---------------- */

/* "Chap01" -> "Chapter 1"; anything else is shown as-is. */
function chapterDisplayName(chapter) {
  const m = String(chapter ?? '').match(/(\d+)/);
  return m ? `Chapter ${Number(m[1])}` : String(chapter ?? '');
}

/* "1_1_BackgroundMathematics.ipynb" -> "1.1 Background Mathematics".
   Falls back to the raw name minus the extension (underscores to spaces). */
function labDisplayName(name) {
  const base = String(name ?? '').replace(/\.ipynb$/i, '');
  const m = base.match(/^(\d+)_(\d+)_(.+)$/);
  if (m) {
    const title = m[3].replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
    return `${m[1]}.${m[2]} ${title}`;
  }
  return base.replace(/_/g, ' ');
}

function renderLabsSection() {
  const sec = $('#labs-section', view);
  if (!sec) return;
  if (!state.labs.length) { sec.innerHTML = ''; sec.hidden = true; return; }
  sec.hidden = false;
  const total = state.labs.reduce((n, c) => n + (Array.isArray(c.files) ? c.files.length : 0), 0);
  const toggle = state.labsCollapsed ? '▸' : '▾';
  let html = `
    <button type="button" class="labs-head" id="labs-head" aria-expanded="${state.labsCollapsed ? 'false' : 'true'}">
      <span>${toggle} Labs</span>
      <span class="labs-count">${total} notebook${total === 1 ? '' : 's'}</span>
    </button>`;
  if (!state.labsCollapsed) {
    html += `<div class="labs-groups">` + state.labs.map((group) => {
      const files = Array.isArray(group.files) ? group.files : [];
      const open = !!state.labsOpenChapters[group.chapter];
      const rows = open ? files.map((f) => {
        const isOpen = state.labTabs.some((t) => t.chapter === group.chapter && t.name === f.name);
        const isActive = state.activeTabKind === 'lab' && state.activeLab
          && state.activeLab.chapter === group.chapter && state.activeLab.name === f.name;
        return `<button type="button" class="lab-file${isActive ? ' active' : ''}${isOpen ? ' open' : ''}"
            data-lab-chapter="${esc(group.chapter)}" data-lab-name="${esc(f.name)}"
            title="${esc(group.chapter)}/${esc(f.name)}">${esc(labDisplayName(f.name))}</button>`;
      }).join('') : '';
      return `
        <div class="labs-group">
          <button type="button" class="labs-group-head" data-labs-chapter="${esc(group.chapter)}">
            <span>${open ? '▾' : '▸'} ${esc(chapterDisplayName(group.chapter))}</span>
            <span class="labs-count">${files.length}</span>
          </button>
          ${open ? `<div class="labs-files">${rows || '<p class="labs-empty">No files in this chapter.</p>'}</div>` : ''}
        </div>`;
    }).join('') + `</div>`;
  }
  sec.innerHTML = html;

  $('#labs-head', sec).addEventListener('click', () => {
    state.labsCollapsed = !state.labsCollapsed;
    renderLabsSection();
  });
  $$('.labs-group-head', sec).forEach((btn) => {
    btn.addEventListener('click', () => {
      const ch = btn.dataset.labsChapter;
      state.labsOpenChapters[ch] = !state.labsOpenChapters[ch];
      renderLabsSection();
    });
  });
  $$('.lab-file', sec).forEach((btn) => {
    btn.addEventListener('click', async () => {
      await openLab(btn.dataset.labChapter, btn.dataset.labName);
    });
  });
}

/* Open a lab as a notebook tab (same rendering + ▶ Run path as note
   notebooks). Only this lab becomes a tab — the rest stay listed. */
async function openLab(chapter, name) {
  const existing = state.labTabs.find((t) => t.chapter === chapter && t.name === name);
  if (!existing) state.labTabs.push({ chapter, name });
  try {
    await loadLab(chapter, name);
  } catch (err) {
    window.alert(`Could not open this lab: ${err.message}`);
    return;
  }
  renderNotebookPane();
  renderChapterPanel();
}

async function loadLab(chapter, name) {
  const slug = state.project.slug;
  const data = await apiGet(`/api/projects/${encodeURIComponent(slug)}/labs/${encodeURIComponent(chapter)}/${encodeURIComponent(name)}`);
  // Same shape as GET notes/:name ({name, content}); tolerate a bare
  // notebook object too.
  let content;
  if (typeof data === 'string') content = data;
  else if (data && typeof data.content === 'string') content = data.content;
  else if (data && Array.isArray(data.cells)) content = JSON.stringify(data);
  else content = '';
  state.activeTabKind = 'lab';
  state.activeLab = { chapter, name };
  state.activeNoteName = name;
  state.activeNoteKind = 'ipynb';
  state.activeNoteContent = content;
  state.activeNotebook = null;
  try { state.activeNotebook = JSON.parse(content || '{"cells":[]}'); }
  catch { state.activeNotebook = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }; }
  if (!Array.isArray(state.activeNotebook.cells)) state.activeNotebook.cells = [];
  resetExecCounter();
}

/* Close a lab tab. Saves are explicit (same as notes), so closing never
   loses saved work; unsaved in-memory edits to that lab are dropped. */
async function closeLabTab(lab) {
  state.labTabs = state.labTabs.filter(
    (t) => !(t.chapter === lab.chapter && t.name === lab.name));
  const wasActive = state.activeTabKind === 'lab' && state.activeLab
    && state.activeLab.chapter === lab.chapter && state.activeLab.name === lab.name;
  if (!wasActive) { renderNotebookPane(); return; }
  const firstChapter = (state.chapters || [])[0];
  const def = (firstChapter && state.notes.find((n) => n.name === firstChapter.file))
    || state.notes.find((n) => n.kind === 'md')
    || state.notes[0];
  if (def) {
    try { await loadNote(def.name); } catch { /* pane renders empty */ }
  } else {
    state.activeTabKind = 'note';
    state.activeLab = null;
    state.activeNoteName = null;
    state.activeNoteKind = 'md';
    state.activeNoteContent = '';
    state.activeNotebook = null;
  }
  renderNotebookPane();
  renderChapterPanel();
}

function renderNotebookToolbar() {
  const bar = $('#notebook-toolbar', view);
  if (!bar) return;
  if (state.activeNoteKind === 'md') {
    bar.innerHTML = `
      <button type="button" id="md-preview-btn" title="Open the rendered preview in the left pane">Preview</button>
      <button type="button" id="ai-toggle" class="${state.aiPanelOpen ? 'active' : ''}" title="Ask the AI to draft markdown notes from the current chapter — a proposal, never a silent write">✨ Ask AI</button>
      <button type="button" id="page-note-btn" title="Add a note anchored at the page being read">+ Note here</button>
      <label class="follow-toggle" title="Follow the reading pane: open the current chapter's file">
        <input type="checkbox" id="follow-toggle" ${state.follow ? 'checked' : ''}> Follow
      </label>
      <span class="spacer"></span>
      <span class="save-status" id="save-status"></span>
      <button type="button" id="notes-export-btn" title="Download all chapter notes as one combined .md file">Export notes</button>
      <button type="button" id="md-save-btn">Save</button>`;
    // Preview opens the LEFT pane's Markdown preview tab (the one preview);
    // the right pane stays in Edit mode.
    $('#md-preview-btn', bar).addEventListener('click', () => setLeftTab('preview'));
    $('#follow-toggle', bar).addEventListener('change', (e) => { state.follow = e.target.checked; });
    $('#md-save-btn', bar).addEventListener('click', () => saveActiveMdNote(true));
  } else {
    bar.innerHTML = `
      <button type="button" id="ai-toggle" class="${state.aiPanelOpen ? 'active' : ''}" title="Ask the AI to draft markdown notes from the current chapter — a proposal, never a silent write">✨ Ask AI</button>
      <button type="button" id="page-note-btn" title="Add a note anchored at the page being read">+ Note here</button>
      <label class="follow-toggle" title="Follow the reading pane: open the current chapter's file">
        <input type="checkbox" id="follow-toggle" ${state.follow ? 'checked' : ''}> Follow
      </label>
      <span class="spacer"></span>
      <button type="button" id="notes-export-btn" title="Download all chapter notes as one combined .md file">Export notes</button>
      <span class="save-status" id="save-status"></span>`;
    $('#follow-toggle', bar).addEventListener('change', (e) => { state.follow = e.target.checked; });
  }
  const aiBtn = $('#ai-toggle', bar);
  if (aiBtn) {
    // The ✨ Ask AI toggle and the AI mode button are the same action:
    // opening AI switches to AI mode, closing it returns to Focus.
    aiBtn.addEventListener('click', () => {
      setLayoutMode(state.layoutMode === 'ai' ? 'focus' : 'ai');
    });
  }
  const pageBtn = $('#page-note-btn', bar);
  if (pageBtn) {
    pageBtn.addEventListener('click', addNoteAtCurrentPage);
    updatePageNoteButton();
  }
  const exportBtn = $('#notes-export-btn', bar);
  if (exportBtn) exportBtn.addEventListener('click', exportNotesCombined);
}

/* The "+ Note here" button (notebook toolbar) is enabled exactly when the
   reader is on a page: book PDF / Slides tab, or the Preview tab with an
   active chapter. Video / slides / ppt projects have no pages. */
function updatePageNoteButton() {
  const btn = $('#page-note-btn', view);
  if (!btn) return;
  const reading = currentReadingPage();
  btn.disabled = !reading;
  btn.title = reading
    ? `Add a note anchored at ${reading.sourceId === PAGE_ANCHOR_SOURCE_BOOK ? `p. ${reading.page}` : `slide ${reading.page}`} — it lands in this chapter's note file`
    : 'No page here — switch to the PDF or Slides tab to anchor a note';
}

/* Add a note anchored at the page being read: insert the anchor comment
   into the current chapter's file (before its generated ### Labs block;
   create the chapter file on demand), then open that file in the editor
   with the cursor on the line after the anchor so the user can type the
   note right there. */
async function addNoteAtCurrentPage() {
  const reading = currentReadingPage();
  if (!reading) return;
  const entry = currentChapterEntry();
  const anchor = formatPageAnchor({ page: reading.page, sourceId: reading.sourceId });
  const { inserted, file } = await insertIntoChapterFile(entry, anchor);
  if (!inserted) {
    setSaveStatus('A note is already anchored here — nothing added.');
    return;
  }
  if (!(state.activeTabKind === 'note' && state.activeNoteName === file)) {
    try { await loadNote(file); } catch { /* pane renders empty */ }
  }
  renderNotebookPane();
  renderChapterPanel();
  renderLeftPreview();
  const ta = $('#md-editor', view);
  if (ta) {
    const lines = ta.value.split('\n');
    const idx = lines.findIndex((l) => l.includes(anchor));
    if (idx >= 0) {
      ta.focus();
      const pos = lines.slice(0, idx + 1).join('\n').length + 1;
      ta.setSelectionRange(pos, pos);
    }
  }
  setSaveStatus(`Note anchored at ${anchorChipLabel(reading, activeSourceLabel())} in ${file}.`);
}

function setSaveStatus(text, cls = '') {
  const el = $('#save-status', view);
  if (el) { el.textContent = text; el.className = `save-status ${cls}`.trim(); }
}

function renderNotebookBody() {
  const body = $('#notebook-body', view);
  if (!body) return;
  if (state.activeNoteKind === 'ipynb') {
    renderIpynbBody(body);
    return;
  }
  // Markdown notes are always edited here; the rendered preview lives in
  // the LEFT pane's Preview tab (opened by the Preview button).
  body.innerHTML = `<textarea class="md-editor" id="md-editor" spellcheck="false"></textarea>`;
  const ta = $('#md-editor', body);
  ta.value = state.activeNoteContent;
  ta.addEventListener('focus', () => { state.editorFocused = true; });
  ta.addEventListener('blur', () => {
    state.editorFocused = false;
    // Autosave on blur (debounced): only PUT when the text changed.
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveActiveMdNote(false), 400);
  });
  ta.addEventListener('input', () => {
    state.activeNoteContent = ta.value;
    state.mdDirty = true;
    setSaveStatus('Unsaved changes', 'dirty');
    // The left Preview tab shows the same file — keep it live.
    syncNoteCache(state.activeNoteName, ta.value);
    if (leftPreviewTimer) clearTimeout(leftPreviewTimer);
    leftPreviewTimer = setTimeout(() => renderLeftPreview(), 400);
  });
}

/* Render markdown into el; tag headings with data-h for scroll-spy and
   attach a Run button to python/java/javascript fenced code blocks. */
function renderMdPreview(el, text) {
  el.innerHTML = window.marked ? window.marked.parse(text || '') : esc(text || '');
  rewriteAssetSrcs(el); // exported plots (assets/...) resolve via the asset API
  $$('h2, h3', el).forEach((h) => { h.dataset.h = normalizeHeading(h.textContent); });
  // Page anchors: an `<!-- @page N · source: <id> -->` comment in the
  // markdown becomes a chip; clicking it jumps the LEFT pane to that
  // page/slide in the correct source tab. (marked keeps HTML comments as
  // Comment nodes, so they are findable after the render.)
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((comment) => {
    const m = comment.textContent.match(/^\s*@page\s+(\d+)\s*·\s*source:\s*([^\s>]+)\s*$/);
    if (!m) return;
    const anchor = { page: Number(m[1]), sourceId: m[2] };
    const label = anchor.sourceId === PAGE_ANCHOR_SOURCE_BOOK
      ? null
      : (state.materials || []).find((x) => x.id === anchor.sourceId)?.label;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'page-anchor-chip';
    chip.dataset.anchorSource = anchor.sourceId;
    chip.dataset.anchorPage = String(anchor.page);
    chip.textContent = `📍 ${anchorChipLabel(anchor, label)}`;
    chip.title = `Jump to ${anchor.sourceId === PAGE_ANCHOR_SOURCE_BOOK ? `p. ${anchor.page} of the book` : `slide ${anchor.page} of ${label || anchor.sourceId}`}`;
    chip.addEventListener('click', () => jumpToAnchor(anchor.sourceId, anchor.page));
    comment.replaceWith(chip);
  });
  $$('pre', el).forEach((pre) => {
    const code = $('code', pre);
    if (!code) return;
    const lang = (code.className.match(/language-([\w-]+)/) || [])[1];
    if (!lang || !RUNNABLE_LANGS.includes(lang.toLowerCase())) return;
    const bar = document.createElement('div');
    bar.className = 'code-run-bar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'run-btn';
    btn.textContent = '▶ Run';
    const out = document.createElement('div');
    out.className = 'run-output';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Running…';
      out.innerHTML = '';
      try {
        const result = await runCode(lang.toLowerCase(), code.textContent);
        out.innerHTML = renderExecuteResult(result);
      } catch (err) {
        out.innerHTML = `<span class="run-stderr">${esc(err.message)}</span>`;
      }
      btn.disabled = false;
      btn.textContent = '▶ Run';
    });
    bar.appendChild(btn);
    pre.after(bar);
    bar.after(out);
  });
  // In-app links: a relative .md link opens that chapter file in the
  // notebook pane; a labs/ChapNN/*.ipynb link opens that lab. (The master
  // index and the chapter files' ### Labs blocks link this way.)
  $$('a', el).forEach((a) => {
    const href = a.getAttribute('href');
    if (!href || /^(https?:|mailto:|#)/i.test(href)) return;
    const labMatch = href.match(/^labs\/(Chap\d+)\/([^/]+\.ipynb)(?:#.*)?$/i);
    if (labMatch) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openLab(labMatch[1], labMatch[2]);
      });
      return;
    }
    const mdMatch = href.match(/^([^/#?]+\.md)(?:#.*)?$/i);
    if (mdMatch) {
      const target = decodeURIComponent(mdMatch[1]);
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!(state.notes || []).some((n) => n.name === target)) return;
        const entry = (state.chapters || []).find((c) => c.file === target);
        try { await loadNote(target); } catch { return; }
        renderNotebookPane();
        // A chapter-file link is a jump to that chapter: make it current
        // so the preview, the AI context and the "+ Note here" button
        // follow the file that just opened (a plain note leaves the
        // chapter alone).
        if (entry) await setActiveChapter(entry, { scrollNotebook: true });
        else { renderChapterPanel(); renderLeftPreview(); }
      });
    }
  });
}

async function runCode(language, code) {
  return apiJson('/api/execute', 'POST', { language, code });
}

/* Run cells 0..N in one shared session; returns {results: [...]} aligned
   with the submitted cells. A cell that raises stops the run; later
   results carry skipped: true. */
async function runCells(language, sources) {
  return apiJson('/api/execute', 'POST', {
    language,
    cells: sources.map((source) => ({ source })),
  });
}

/* Render {stdout, stderr, exitCode, images} into HTML. */
function renderExecuteResult(result) {
  let html = '';
  if (result.stdout) html += esc(result.stdout);
  if (result.stderr) html += `<span class="run-stderr">${esc(result.stderr)}</span>`;
  if (result.exitCode != null && result.exitCode !== 0 && !result.stderr) {
    html += `<span class="run-stderr">Exit code ${result.exitCode}</span>`;
  }
  if (Array.isArray(result.images)) {
    result.images.forEach((img) => {
      if (img && img.data) {
        html += `<img src="data:${esc(img.mime || 'image/png')};base64,${img.data}" alt="output image">`;
      }
    });
  }
  return html || '<span style="color:#8a7a68">(no output)</span>';
}

async function saveActiveMdNote(showStatus) {
  if (state.activeNoteKind !== 'md') return;
  const name = state.activeNoteName;
  const content = state.activeNoteContent;
  if (showStatus) setSaveStatus('Saving…');
  try {
    const res = await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/notes/${encodeURIComponent(name)}`,
      'PUT', { content });
    // The PUT refreshes the generated ### Labs block and returns the
    // stored text; adopt it so the editor and the preview agree.
    const stored = res && typeof res.content === 'string' ? res.content : content;
    state.activeNoteContent = stored;
    state.mdDirty = false;
    syncNoteCache(name, stored);
    if (res && res.chapter) {
      const i = (state.chapters || []).findIndex((c) => c.file === name);
      if (i >= 0) state.chapters[i] = res.chapter;
    }
    if (state.previewFile === name || isChapterFileName(name)) renderLeftPreview();
    if (showStatus) {
      const t = new Date();
      setSaveStatus(`Saved ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`);
    } else {
      setSaveStatus('Saved');
    }
  } catch (err) {
    setSaveStatus(`Save failed: ${err.message}`, 'error');
  }
}

async function saveNotebook() {
  const text = JSON.stringify(state.activeNotebook, null, 2);
  state.activeNoteContent = text;
  const slug = encodeURIComponent(state.project.slug);
  try {
    if (state.activeTabKind === 'lab' && state.activeLab) {
      // Lab tabs save through the labs API, not the notes API.
      await apiJson(`/api/projects/${slug}/labs/${encodeURIComponent(state.activeLab.chapter)}/${encodeURIComponent(state.activeLab.name)}`,
        'PUT', { content: text });
    } else {
      await apiJson(`/api/projects/${slug}/notes/${encodeURIComponent(state.activeNoteName)}`,
        'PUT', { content: text });
    }
    setSaveStatus('Saved');
  } catch (err) {
    setSaveStatus(`Save failed: ${err.message}`, 'error');
  }
}

/* ---------------- creating notes ---------------- */

async function createMdNote() {
  const name = window.prompt('New note name (ends with .md):', 'notes-2.md');
  if (!name) return;
  const clean = name.trim().endsWith('.md') ? name.trim() : `${name.trim()}.md`;
  try {
    await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/notes/${encodeURIComponent(clean)}`,
      'PUT', { content: `# ${clean.replace(/\.md$/, '')}\n\n` });
    state.notes.push({ name: clean, kind: 'md' });
    await loadNote(clean);
    renderNotebookPane();
    renderChapterPanel();
    const ta = $('#md-editor', view);
    if (ta) ta.focus();
  } catch (err) {
    window.alert(`Could not create the note: ${err.message}`);
  }
}

async function createIpynbNote() {
  const name = window.prompt('New notebook name (ends with .ipynb):', 'scratch.ipynb');
  if (!name) return;
  const clean = name.trim().endsWith('.ipynb') ? name.trim() : `${name.trim()}.ipynb`;
  let lang = window.prompt('Language (python, java, or javascript):', 'python');
  lang = (lang || 'python').trim().toLowerCase();
  if (!RUNNABLE_LANGS.includes(lang)) lang = 'python';
  const nb = {
    cells: [{ cell_type: 'markdown', metadata: {}, source: [`# ${clean.replace(/\.ipynb$/, '')}\n`] }],
    metadata: { kernelspec: { display_name: lang, language: lang, name: lang }, language_info: { name: lang } },
    nbformat: 4,
    nbformat_minor: 5,
  };
  try {
    await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/notes/${encodeURIComponent(clean)}`,
      'PUT', { content: JSON.stringify(nb, null, 2) });
    state.notes.push({ name: clean, kind: 'ipynb' });
    await loadNote(clean);
    renderNotebookPane();
    renderChapterPanel();
  } catch (err) {
    window.alert(`Could not create the notebook: ${err.message}`);
  }
}

/* ---------------- ipynb rendering ---------------- */

function nbCellSource(cell) {
  return Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
}

function setNbCellSource(cell, text) {
  // Keep nbformat shape: store source as a single string (accepted by the
  // backend's documented shape, string or string[]).
  cell.source = text;
}

/* Code cells from the top through notebook index idx, in order. */
function codeCellsUpTo(idx) {
  const list = [];
  (state.activeNotebook?.cells ?? []).forEach((c, i) => {
    if (c.cell_type === 'code' && i <= idx) list.push({ nbIndex: i, cell: c });
  });
  return list;
}

/* Run a list of code cells [{nbIndex, cell}] in one shared session and
   apply the per-cell results in place. Skipped cells (after an error)
   keep their previous outputs. Saves the notebook once at the end. All
   run buttons are disabled while a run-all is in flight so a concurrent
   single-cell run cannot race the save. */
async function runNotebookCells(list, statusEl) {
  if (!list.length) return;
  const lang = state.activeNotebook?.metadata?.language_info?.name
    || state.activeNotebook?.metadata?.kernelspec?.language || 'python';
  const btns = $$('#nb-cells .run-btn, #nb-run-all');
  btns.forEach((b) => { b.disabled = true; });
  if (statusEl) statusEl.textContent = 'Running…';
  try {
    const { results } = await runCells(lang, list.map(({ cell }) => nbCellSource(cell)));
    let ran = 0;
    let failed = null;
    list.forEach(({ nbIndex, cell }, k) => {
      const r = results[k];
      if (!r || r.skipped) return;
      ran += 1;
      cell.outputs = outputsFromExecuteResult(r);
      cell.execution_count = ++state.execCounter;
      renderCellOutputs($(`[data-cell-output="${nbIndex}"]`, $('#nb-cells')), cell);
      if (r.exitCode !== 0 && r.exitCode != null && failed == null) failed = nbIndex;
    });
    await saveNotebook();
    if (statusEl) {
      statusEl.textContent = failed != null
        ? `Stopped at cell ${failed + 1} (error)`
        : `Ran ${ran} cell${ran === 1 ? '' : 's'}`;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = `Run failed: ${err.message}`;
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

function renderIpynbBody(body) {
  const nb = state.activeNotebook;
  const lang = nb?.metadata?.language_info?.name
    || nb?.metadata?.kernelspec?.language || 'python';
  // The export selection belongs to one notebook; a different notebook
  // starts with an empty selection.
  if (state.exportSelectionFor !== notebookKey()) {
    state.exportSelection = new Set();
    state.exportSelectionFor = notebookKey();
  }
  // Run-all is unavailable for Java: cells cannot share one session.
  const runAllRow = lang === 'java' ? '' : `
    <div class="nb-runall-row">
      <button type="button" class="run-btn" id="nb-run-all"
        title="Run all code cells top to bottom in one shared session">▶ Run all</button>
      <span class="save-status" id="nb-runall-status"></span>
    </div>`;
  const exportRow = `
    <div class="nb-export-row">
      <button type="button" id="nb-export-md" disabled
        title="Generate markdown from the selected code cells (code fences, outputs, plots as files)">Export to Markdown</button>
      <span class="save-status" id="nb-export-count">Select cells to export</span>
    </div>`;
  body.innerHTML = `${runAllRow}${exportRow}<div class="nb-cells" id="nb-cells"></div>`;
  const runAllBtn = $('#nb-run-all', body);
  if (runAllBtn) {
    runAllBtn.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.textContent = 'Running…';
      await runNotebookCells(codeCellsUpTo(Infinity), $('#nb-runall-status', body));
      btn.textContent = '▶ Run all';
    });
  }
  $('#nb-export-md', body).addEventListener('click', exportSelectedCells);
  const wrap = $('#nb-cells', body);

  nb.cells.forEach((cell, idx) => {
    const cellEl = document.createElement('div');
    cellEl.className = 'nb-cell';
    if (cell.cell_type === 'markdown') {
      cellEl.innerHTML = `
        <div class="nb-cell-head"><span>Markdown</span><span class="spacer"></span>
          <button type="button" data-md-edit="${idx}">Edit</button></div>
        <div class="md-preview" data-md-view="${idx}"></div>
        <div data-md-editor="${idx}" hidden>
          <textarea class="md-editor" rows="6" spellcheck="false"></textarea>
        </div>`;
      const viewEl = $(`[data-md-view="${idx}"]`, cellEl);
      renderMdPreview(viewEl, nbCellSource(cell));
      const editBtn = $(`[data-md-edit="${idx}"]`, cellEl);
      const editorWrap = $(`[data-md-editor="${idx}"]`, cellEl);
      const ta = $('textarea', editorWrap);
      ta.value = nbCellSource(cell);
      editBtn.addEventListener('click', () => {
        const editing = editorWrap.hidden;
        editorWrap.hidden = !editing;
        viewEl.hidden = editing;
        editBtn.textContent = editing ? 'Done' : 'Edit';
        if (!editing) {
          setNbCellSource(cell, ta.value);
          renderMdPreview(viewEl, ta.value);
          saveNotebook();
        } else {
          ta.focus();
        }
      });
    } else {
      // Code cell: editable source, Run button, outputs area.
      cellEl.innerHTML = `
        <div class="nb-cell-head"><label class="nb-export-check" title="Select for Markdown export">
            <input type="checkbox" data-cell-select="${idx}" ${state.exportSelection.has(idx) ? 'checked' : ''}> Export</label>
          <span>Code · ${esc(lang)}</span><span class="spacer"></span>
          <button type="button" data-cell-del="${idx}">Delete</button></div>
        <textarea class="nb-code-source" spellcheck="false"></textarea>
        <div class="nb-cell-foot">
          <button type="button" class="run-btn" data-cell-run="${idx}">▶ Run</button>
          ${lang === 'java' ? '' : `<button type="button" class="run-btn" data-cell-run-above="${idx}" title="Run this cell and every code cell above it in one shared session">▶ Run all above</button>`}
          <span class="save-status" data-cell-status="${idx}"></span>
        </div>
        <div class="nb-output" data-cell-output="${idx}"></div>`;
      $(`[data-cell-select="${idx}"]`, cellEl).addEventListener('change', (e) => {
        if (e.currentTarget.checked) state.exportSelection.add(idx);
        else state.exportSelection.delete(idx);
        updateExportButton();
      });
      const ta = $('.nb-code-source', cellEl);
      ta.value = nbCellSource(cell);
      ta.addEventListener('input', () => { setNbCellSource(cell, ta.value); });
      ta.addEventListener('blur', () => saveNotebook());
      ta.addEventListener('focus', () => { state.editorFocused = true; });
      ta.addEventListener('blur', () => { state.editorFocused = false; });
      renderCellOutputs($(`[data-cell-output="${idx}"]`, cellEl), cell);
      $(`[data-cell-run="${idx}"]`, cellEl).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const status = $(`[data-cell-status="${idx}"]`, cellEl);
        btn.disabled = true;
        btn.textContent = 'Running…';
        status.textContent = '';
        try {
          const result = await runCode(lang, nbCellSource(cell));
          cell.outputs = outputsFromExecuteResult(result);
          cell.execution_count = ++state.execCounter;
          renderCellOutputs($(`[data-cell-output="${idx}"]`, cellEl), cell);
          await saveNotebook(); // outputs persist in the notebook file
        } catch (err) {
          cell.outputs = [{ output_type: 'stream', name: 'stderr', text: err.message }];
          renderCellOutputs($(`[data-cell-output="${idx}"]`, cellEl), cell);
          status.textContent = 'Run failed';
        }
        btn.disabled = false;
        btn.textContent = '▶ Run';
      });
      const runAboveBtn = $(`[data-cell-run-above="${idx}"]`, cellEl);
      if (runAboveBtn) {
        runAboveBtn.addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          const status = $(`[data-cell-status="${idx}"]`, cellEl);
          btn.textContent = 'Running…';
          await runNotebookCells(codeCellsUpTo(idx), status);
          btn.textContent = '▶ Run all above';
        });
      }
      $(`[data-cell-del="${idx}"]`, cellEl).addEventListener('click', async () => {
        if (!window.confirm('Delete this cell?')) return;
        nb.cells.splice(idx, 1);
        state.exportSelection = new Set(); // indexes shift — drop the selection
        await saveNotebook();
        renderNotebookBody();
      });
    }
    wrap.appendChild(cellEl);

    // Per-cell add buttons.
    const addRow = document.createElement('div');
    addRow.className = 'nb-add-row';
    addRow.innerHTML = `
      <button type="button" data-add-md="${idx}">+ Markdown cell</button>
      <button type="button" data-add-code="${idx}">+ Code cell</button>`;
    $(`[data-add-md="${idx}"]`, addRow).addEventListener('click', () => {
      nb.cells.splice(idx + 1, 0, { cell_type: 'markdown', metadata: {}, source: '' });
      state.exportSelection = new Set(); // indexes shift — drop the selection
      saveNotebook().then(() => renderNotebookBody());
    });
    $(`[data-add-code="${idx}"]`, addRow).addEventListener('click', () => {
      nb.cells.splice(idx + 1, 0, { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: '' });
      state.exportSelection = new Set(); // indexes shift — drop the selection
      saveNotebook().then(() => renderNotebookBody());
    });
    wrap.appendChild(addRow);
  });

  const bottomRow = document.createElement('div');
  bottomRow.className = 'nb-add-row';
  bottomRow.innerHTML = `
    <button type="button" id="nb-add-md-bottom">+ Markdown cell</button>
    <button type="button" id="nb-add-code-bottom">+ Code cell</button>`;
  $('#nb-add-md-bottom', bottomRow).addEventListener('click', () => {
    nb.cells.push({ cell_type: 'markdown', metadata: {}, source: '' });
    saveNotebook().then(() => renderNotebookBody());
  });
  $('#nb-add-code-bottom', bottomRow).addEventListener('click', () => {
    nb.cells.push({ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: '' });
    saveNotebook().then(() => renderNotebookBody());
  });
  wrap.appendChild(bottomRow);
  updateExportButton(); // restores the button state after a re-render
}

function outputsFromExecuteResult(result) {
  // Map {stdout, stderr, images} onto nbformat outputs without duplicating
  // text: stdout/stderr become stream outputs, images become display_data.
  const outputs = [];
  if (result.stdout) {
    outputs.push({ output_type: 'stream', name: 'stdout', text: result.stdout });
  }
  if (result.stderr) {
    outputs.push({ output_type: 'stream', name: 'stderr', text: result.stderr });
  }
  if (Array.isArray(result.images)) {
    result.images.forEach((img) => {
      if (img && img.data) {
        outputs.push({
          output_type: 'display_data',
          metadata: {},
          data: { 'image/png': img.data },
        });
      }
    });
  }
  return outputs;
}

function renderCellOutputs(el, cell) {
  if (!el) return;
  const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
  let html = '';
  outputs.forEach((o) => {
    if (o.output_type === 'stream') {
      const cls = o.name === 'stderr' ? ' style="color:#b3261e"' : '';
      html += `<span${cls}>${esc(o.text || '')}</span>`;
    } else if (o.output_type === 'execute_result' || o.output_type === 'display_data') {
      const data = o.data || {};
      if (data['image/png']) {
        html += `<img src="data:image/png;base64,${data['image/png']}" alt="cell output image">`;
      }
      if (data['text/plain']) html += esc(data['text/plain']);
    } else if (o.output_type === 'error') {
      html += `<span style="color:#b3261e">${esc([o.ename, o.evalue].filter(Boolean).join(': '))}</span>`;
      if (Array.isArray(o.traceback)) html += esc(o.traceback.join('\n'));
    }
  });
  // A cell that ran successfully but produced nothing shows the same
  // placeholder as the markdown-preview run path. Never-run cells keep
  // execution_count null, so stored empty outputs stay blank.
  if (!html && cell.execution_count != null) {
    html = '<span style="color:#8a7a68">(no output)</span>';
  }
  el.innerHTML = html;
}

/* ---------------- on-demand AI notes + cell export ---------------- */

// A stable key for the current notebook (note or lab tab): one AI thread
// and one export selection per notebook.
function notebookKey() {
  if (state.activeTabKind === 'lab' && state.activeLab) {
    return `lab:${state.activeLab.chapter}/${state.activeLab.name}`;
  }
  return `note:${state.activeNoteName}`;
}

function notebookDisplayName() {
  if (state.activeTabKind === 'lab' && state.activeLab) return labDisplayName(state.activeLab.name);
  return String(state.activeNoteName || 'notebook').replace(/\.(ipynb|md)$/i, '');
}

/* The outline chapter the reader is on (null when none — e.g. a video
   project, or a heading-only nav). The AI request uses the outline title
   verbatim so the server can match it against the stored outline.
   Prefer a depth-0 entry: a chapter title can also appear as a subsection
   elsewhere ("Supervised learning" is a subsection of the Introduction at
   p.15 AND the chapter at p.31) — the subsection's page must never stand
   in for the chapter's. */
function activeOutlineChapter() {
  if (!state.activeChapter) return null;
  const list = state.outline || [];
  return list.find((ch) => ch.depth === 0 && normalizeHeading(ch.title) === state.activeChapter)
    || list.find((ch) => normalizeHeading(ch.title) === state.activeChapter) || null;
}

/* Display title for the context line: the outline chapter, else the
   current chapter file's title, else null. */
function activeChapterTitle() {
  const ch = activeOutlineChapter();
  if (ch) return ch.title;
  const entry = currentChapterEntry();
  return entry ? entry.title : null;
}

/* One context sentence for the AI panel, from the material currently being
   read (left pane source + page). Book PDF -> the chapter's text; Slides
   tab -> the deck around the current slide; Preview tab -> the chapter. */
function aiContextText() {
  const reading = currentReadingPage();
  const ch = activeOutlineChapter();
  if (reading && reading.sourceId !== PAGE_ANCHOR_SOURCE_BOOK) {
    return `Context: ${activeSourceLabel()} (slide ${reading.page}) — the AI reads this deck around the current slide.`;
  }
  if (ch) {
    return `Context: ${ch.title}${ch.page != null ? ` (p. ${ch.page})` : ''} — the AI reads this chapter's PDF text.`;
  }
  const title = activeChapterTitle();
  if (title) {
    return `Context: ${title} — no PDF chapter text for it; the AI works from your request (and your notes, if included) only.`;
  }
  return 'Context: no chapter selected — the AI works from your request only.';
}

/* Keep the AI panel's context lines live as the reader moves chapters.
   Cheap: text updates, only when the panel is open. Called from
   renderAiPanel and from setActiveChapter. */
function updateAiContext() {
  const el = $('#ai-context', view);
  if (el) el.textContent = aiContextText();
  const codeEl = $('#ai-code-context', view);
  if (codeEl) {
    const nb = state.activeNotebook ? `Notebook: ${notebookDisplayName()}. ` : '';
    codeEl.textContent = `${nb}${aiContextText()}`;
  }
  // "Include my notes" only applies when a book chapter is in context
  // (a deck's slides have no note section to include).
  const wrap = $('#ai-include-wrap', view);
  if (wrap) {
    const reading = currentReadingPage();
    wrap.hidden = !activeOutlineChapter()
      || (reading != null && reading.sourceId !== PAGE_ANCHOR_SOURCE_BOOK);
  }
}

/* Port of stripLabsBlock / appendToChapter in src/chapterNotes.js — the
   same rule on both sides: a block goes into a chapter file BEFORE the
   generated ### Labs block (the block is generated, never hand-edited);
   a second insert of the exact same block is a no-op (inserted: false).
   The server re-applies the same rule on PUT, so a stale client copy
   still lands in the right place. */
const LABS_BLOCK_START = '<!-- labs:start -->';
const LABS_BLOCK_END = '<!-- labs:end -->';

function stripLabsBlock(text) {
  const src = String(text ?? '');
  const start = src.indexOf(`\n${LABS_BLOCK_START}`);
  if (start === -1) return src;
  const endMarker = src.indexOf(LABS_BLOCK_END, start);
  if (endMarker === -1) return src;
  let end = endMarker + LABS_BLOCK_END.length;
  if (src[end] === '\n') end += 1;
  return src.slice(0, start) + src.slice(end);
}

function appendToChapterFile(content, block) {
  const b = String(block ?? '').trim();
  if (!b) return { text: String(content ?? ''), inserted: false };
  const src = String(content ?? '');
  if (stripLabsBlock(src).includes(b)) return { text: src, inserted: false };
  const marker = src.indexOf(LABS_BLOCK_START);
  if (marker === -1) {
    const base = src && !src.endsWith('\n') ? `${src}\n` : src;
    const sep = src && !src.endsWith('\n\n') ? '\n' : '';
    return { text: `${base}${sep}${b}\n`, inserted: true };
  }
  // Insert before the Labs block: keep everything up to the last
  // non-blank line before it, then the block, then the block.
  const before = src.slice(0, marker).replace(/\s+$/, '');
  const after = src.slice(marker);
  const sep = before ? '\n\n' : '';
  return { text: `${before}${sep}${b}\n\n${after}`, inserted: true };
}

/* Page anchors — verbatim port of src/pageAnchor.js (same format, same
   rules on both sides). A note block anchored to a page of the book PDF or
   a slide of a deck carries `<!-- @page N · source: <id> -->` in the chapter file;
   'book' is the main PDF, anything else is a material id. */
const PAGE_ANCHOR_SOURCE_BOOK = 'book';

function formatPageAnchor({ page, sourceId }) {
  const n = Number(page);
  if (!Number.isInteger(n) || n < 1) throw new Error('page must be a positive integer');
  const src = String(sourceId || PAGE_ANCHOR_SOURCE_BOOK).trim();
  if (!src || /\s/.test(src)) throw new Error('sourceId must be a non-empty token without spaces');
  return `<!-- @page ${n} · source: ${src} -->`;
}

function parsePageAnchors(text) {
  const out = [];
  const re = /<!--\s*@page\s+(\d+)\s*·\s*source:\s*([^\s>]+)\s*-->/g;
  for (const m of String(text ?? '').matchAll(re)) {
    out.push({ page: Number(m[1]), sourceId: m[2], index: m.index });
  }
  return out;
}

function anchorChipLabel(anchor, materialLabel) {
  if (!anchor) return '';
  if (anchor.sourceId === PAGE_ANCHOR_SOURCE_BOOK) return `p. ${anchor.page}`;
  return `${materialLabel || anchor.sourceId} · p. ${anchor.page}`;
}

/* The slide deck for a chapter. Two rules, in order:
   1. By number: the seeded decks are slides-introduction / slides-chapN,
      numbered like the chapter files ("12. Transformers" -> slides-chap12).
      This is the primary rule because deck labels do NOT match chapter
      titles: chap 12's deck is labelled "Image Generation" and chap 13's
      "Transformers and LLMs" (the UDL site's deck titles).
   2. By label, with the same normalized matching as chapter resolution.
   Returns the material or null. */
function deckForChapter(chapterTitle) {
  if (!chapterTitle) return null;
  const entry = resolvedChapter(chapterTitle);
  const n = entry?.number;
  if (n != null) {
    const id = n === 1 ? 'slides-introduction' : `slides-chap${n}`;
    const byId = (state.materials || []).find((m) => m.id === id);
    if (byId) return byId;
  }
  const norm = normalizeHeading(chapterTitle);
  return (state.materials || []).find((m) => normalizeHeading(m.label || m.id) === norm) || null;
}

/* One-click export: download all chapter notes as a single combined .md
   (## headings + <!-- p. N --> comments + anchors — the old notes.md
   shape). Standalone notes are excluded. */
async function exportNotesCombined() {
  const slug = encodeURIComponent(state.project.slug);
  try {
    const res = await fetch(`/api/projects/${slug}/notes/export`);
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.project.slug}-notes.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    setSaveStatus(`Export failed: ${err.message}`, 'error');
  }
}

function downloadBlob(content, fileName, mime = 'text/markdown') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Insert markdown into a chapter file through the existing notes PUT
   path (before the generated ### Labs block, idempotent). `entry` is the
   chapter entry (or null — then the current chapter's entry). A chapter
   with no file yet gets one created on demand. Returns {inserted, file}. */
async function insertIntoChapterFile(entry, markdown) {
  const slug = encodeURIComponent(state.project.slug);
  let target = entry || currentChapterEntry();
  if (!target) {
    // No chapter anywhere: create one from the current outline chapter
    // (or a plain "Notes" chapter) so the block has a file to land in.
    const ch = activeOutlineChapter();
    const created = await apiJson(`/api/projects/${slug}/chapters`, 'POST',
      { title: ch ? ch.title : 'Notes', page: ch?.page ?? null });
    if (Array.isArray(created.chapters)) state.chapters = created.chapters;
    target = created.chapter || null;
    if (!target) throw new Error('Could not create a chapter file');
  }
  let current = '';
  let exists = false;
  try {
    const data = await apiGet(`/api/projects/${slug}/notes/${encodeURIComponent(target.file)}`);
    current = typeof data === 'string' ? data : (data.content ?? '');
    exists = true;
  } catch (err) {
    if (!/note not found/.test(err.message || '')) throw err;
  }
  const { text, inserted } = appendToChapterFile(current, markdown);
  if (!inserted) return { inserted: false, file: target.file };
  const res = await apiJson(`/api/projects/${slug}/notes/${encodeURIComponent(target.file)}`,
    'PUT', { content: text });
  const stored = res && typeof res.content === 'string' ? res.content : text;
  syncNoteCache(target.file, stored);
  if (res && res.chapter) {
    const i = (state.chapters || []).findIndex((c) => c.file === target.file);
    if (i >= 0) state.chapters[i] = res.chapter;
  }
  if (!exists && !state.notes.some((n) => n.name === target.file)) {
    state.notes.push({ name: target.file, kind: 'md' });
    renderNotebookPane();
  }
  if (state.activeTabKind === 'note' && state.activeNoteName === target.file) {
    state.activeNoteContent = stored;
    const ta = $('#md-editor', view); if (ta) ta.value = stored;
  }
  renderLeftPreview();
  return { inserted: true, file: target.file };
}

/* ---------------- Ask AI panel ---------------- */

const AI_QUICK_CHIPS = [
  'Summarize this chapter in 5 bullets',
  'Explain the key ideas in my own study-note style',
  'List the key formulas and definitions here',
];

function aiThread() {
  const key = notebookKey();
  if (!state.aiThreads[key]) state.aiThreads[key] = { messages: [] };
  return state.aiThreads[key];
}

/* The AI panel is its own column on the far right of the reader (AI mode
   only — never open in Navigation or Focus). Head: two tabs (Note AI |
   Code AI) + a close × that returns to Focus. Body: #ai-panel, rendered
   by renderAiPanel. */
function renderAiColumn() {
  const col = $('#ai-column', view);
  if (!col) return;
  if (state.layoutMode !== 'ai') { col.hidden = true; return; }
  col.hidden = false;
  if (col.dataset.built !== '1') {
    col.dataset.built = '1';
    col.innerHTML = `
      <div class="ai-column-head">
        <div class="ai-tabs" role="tablist" aria-label="AI">
          <button type="button" class="ai-tab" data-ai-tab="note" role="tab">✨ Note AI</button>
          <button type="button" class="ai-tab" data-ai-tab="code" role="tab">Code AI</button>
        </div>
        <button type="button" id="ai-close" title="Close the AI panel (back to Focus)">✕</button>
      </div>
      <div class="ai-column-body" id="ai-panel"></div>`;
    $$('.ai-tab', col).forEach((btn) => {
      btn.addEventListener('click', () => {
        state.aiTab = btn.dataset.aiTab;
        renderAiColumn();
      });
    });
    $('#ai-close', col).addEventListener('click', () => setLayoutMode('focus'));
  }
  $$('.ai-tab', col).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.aiTab === state.aiTab);
  });
  renderAiPanel();
}

function renderAiPanel() {
  const panel = $('#ai-panel', view);
  if (!panel) return;
  if (state.layoutMode !== 'ai') { panel.innerHTML = ''; panel.dataset.key = ''; return; }
  const key = `${state.aiTab}:${notebookKey()}`;
  if (panel.dataset.key !== key) {
    panel.dataset.key = key;
    if (state.aiTab === 'code') {
      panel.innerHTML = `
        <p class="ai-panel-sub">Writes Python code for the current notebook — a proposal only. Nothing is written until you press Apply.</p>
        <p class="ai-context" id="ai-code-context"></p>
        <div class="ai-thread" id="ai-code-thread"></div>
        <div class="ai-input-row">
          <input type="text" id="ai-code-prompt" placeholder="What should the code do? e.g. plot the attention weights" autocomplete="off">
          <button type="button" class="primary" id="ai-code-send">Send</button>
        </div>
        <div class="ai-status" id="ai-code-status"></div>`;
      $('#ai-code-send', panel).addEventListener('click', askAiCode);
      $('#ai-code-prompt', panel).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); askAiCode(); }
      });
      renderAiCodeThread();
    } else {
      panel.innerHTML = `
        <p class="ai-panel-sub">Drafts markdown notes from the current chapter — a proposal only. Nothing is written until you press Apply.</p>
        <p class="ai-context" id="ai-context"></p>
        <label class="ai-include" id="ai-include-wrap">
          <input type="checkbox" id="ai-include-note"> Include my notes for this chapter
        </label>
        <div class="ai-thread" id="ai-thread"></div>
        <div class="ai-chips" id="ai-chips"></div>
        <div class="ai-input-row">
          <input type="text" id="ai-prompt" placeholder="What should the AI write? e.g. summarize this chapter in 5 bullets" autocomplete="off">
          <button type="button" class="primary" id="ai-send">Send</button>
        </div>
        <div class="ai-status" id="ai-status"></div>
        <button type="button" id="ai-clear" class="ai-clear">Clear session</button>`;
      const chipsEl = $('#ai-chips', panel);
      AI_QUICK_CHIPS.forEach((chip) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ai-chip';
        b.textContent = chip;
        b.addEventListener('click', () => { $('#ai-prompt', panel).value = chip; askAi(); });
        chipsEl.appendChild(b);
      });
      $('#ai-send', panel).addEventListener('click', askAi);
      $('#ai-prompt', panel).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); askAi(); }
      });
      $('#ai-clear', panel).addEventListener('click', () => {
        aiThread().messages = [];
        renderAiThread();
      });
      renderAiThread();
    }
  }
  updateAiContext();
}

/* The current notebook's language (kernelspec / language_info; 'python'
   when undeclared — the seeded labs all declare it). Code AI is Python
   only, so anything else disables it with a note. */
function notebookLanguage() {
  const md = state.activeNotebook?.metadata || {};
  return String(md.kernelspec?.language || md.language_info?.name || 'python').toLowerCase();
}

/* The current notebook's project-relative path, as the ai-code request
   carries it: labs live under notes/labs/<Chapter>/, note notebooks under
   notes/. */
function notebookPath() {
  if (state.activeTabKind === 'lab' && state.activeLab) {
    return `notes/labs/${state.activeLab.chapter}/${state.activeLab.name}`;
  }
  return `notes/${state.activeNoteName}`;
}

function aiCodeThread() {
  const key = notebookKey();
  if (!state.aiCodeThreads[key]) state.aiCodeThreads[key] = { messages: [] };
  return state.aiCodeThreads[key];
}

function renderAiCodeThread() {
  const thread = $('#ai-code-thread', view);
  if (!thread) return;
  const { messages } = aiCodeThread();
  if (!messages.length) {
    const ready = state.activeNotebook && notebookLanguage() === 'python';
    thread.innerHTML = ready
      ? '<p class="hint">Ask in plain language — the AI writes Python for the notebook you have open, from the material you are reading and the cells so far. Apply appends it as a new code cell at the end.</p>'
      : '<p class="hint">Code AI writes Python for the current notebook. Open a Python notebook (a lab, or a .ipynb note) to use it — Java and JavaScript notebooks are not supported yet.</p>';
    return;
  }
  thread.innerHTML = '';
  messages.forEach((msg, i) => {
    const el = document.createElement('div');
    el.className = `ai-msg ai-msg-${msg.role}`;
    if (msg.role === 'user') {
      el.textContent = msg.content;
    } else {
      const body = document.createElement('div');
      body.className = 'ai-msg-body';
      const pre = document.createElement('pre');
      pre.className = 'ai-code-proposal';
      const code = document.createElement('code');
      code.textContent = msg.code || '';
      pre.appendChild(code);
      body.appendChild(pre);
      if (msg.explanation) {
        const exp = document.createElement('p');
        exp.className = 'ai-code-explanation';
        exp.textContent = msg.explanation;
        body.appendChild(exp);
      }
      const actions = document.createElement('div');
      actions.className = 'ai-msg-actions';
      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'primary';
      applyBtn.textContent = msg.applied ? 'Applied ✓' : 'Apply';
      applyBtn.disabled = !!msg.applied;
      applyBtn.addEventListener('click', () => applyAiCode(i));
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(msg.code || '');
          copyBtn.textContent = 'Copied ✓';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        } catch { copyBtn.textContent = 'Copy failed'; }
      });
      actions.append(applyBtn, copyBtn);
      el.append(body, actions);
    }
    thread.appendChild(el);
  });
  thread.scrollTop = thread.scrollHeight;
}

async function askAiCode() {
  const panel = $('#ai-panel', view);
  if (!panel || state.layoutMode !== 'ai' || state.aiTab !== 'code') return;
  const input = $('#ai-code-prompt', panel);
  const statusEl = $('#ai-code-status', panel);
  const sendBtn = $('#ai-code-send', panel);
  const prompt = (input.value || '').trim();
  statusEl.classList.remove('error');
  if (!prompt) { statusEl.textContent = 'Type what you want the code to do.'; return; }
  if (prompt.length > 2000) { statusEl.textContent = 'Keep the request under 2000 characters.'; return; }
  if (!state.activeNotebook || notebookLanguage() !== 'python') {
    statusEl.textContent = 'Open a Python notebook first — Code AI writes code for the current Python notebook.';
    statusEl.classList.add('error');
    return;
  }
  const thread = aiCodeThread();
  const history = thread.messages.slice(-6).map((m) => ({
    role: m.role,
    content: m.role === 'assistant' ? (m.code || '') : m.content,
  }));
  // The current notebook's code cells, capped at 8k chars (the server caps
  // too) so the model writes code that fits.
  const cells = [];
  let cellsChars = 0;
  for (const c of (state.activeNotebook.cells || [])) {
    if (c.cell_type !== 'code') continue;
    const src = nbCellSource(c);
    if (cellsChars + src.length > 8000) break;
    cells.push(src);
    cellsChars += src.length;
  }
  const reading = currentReadingPage();
  thread.messages.push({ role: 'user', content: prompt });
  input.value = '';
  sendBtn.disabled = true;
  statusEl.textContent = 'Asking the AI…';
  renderAiCodeThread();
  try {
    const res = await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/ai-code`, 'POST', {
      chapter: activeChapterTitle(),
      prompt,
      notebook: notebookPath(),
      source: reading && reading.sourceId !== PAGE_ANCHOR_SOURCE_BOOK ? reading.sourceId : null,
      page: reading ? reading.page : null,
      cells,
      history,
    });
    thread.messages.push({ role: 'assistant', content: '', code: res.code || '', explanation: res.explanation || '', applied: false });
    statusEl.textContent = res.chapter?.title ? `Drafted from “${res.chapter.title}”.` : 'Drafted.';
  } catch (err) {
    statusEl.textContent = /LLM not configured/i.test(err.message || '')
      ? 'AI is not configured — set LLM_API_KEY and LLM_MODEL in server/.env, then restart the server.'
      : err.message;
    statusEl.classList.add('error');
  } finally {
    sendBtn.disabled = false;
    renderAiCodeThread();
  }
}

async function applyAiCode(i) {
  const thread = aiCodeThread();
  const msg = thread.messages[i];
  if (!msg || msg.role !== 'assistant' || msg.applied) return;
  if (!state.activeNotebook || notebookLanguage() !== 'python') {
    const statusEl = $('#ai-code-status', view);
    if (statusEl) {
      statusEl.textContent = 'The notebook changed — open a Python notebook to apply this code.';
      statusEl.classList.add('error');
    }
    return;
  }
  // No cell-selection UI exists in v1, so Apply appends a new code cell at
  // the end of the notebook (never edits an existing cell). The note files
  // are untouched — this writes the notebook only.
  state.activeNotebook.cells.push({
    cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: msg.code,
  });
  await saveNotebook();
  msg.applied = true;
  renderAiCodeThread();
  renderNotebookBody();
  const body = $('#notebook-body', view);
  const cellEls = body ? $$('.nb-cell', body) : [];
  const last = cellEls[cellEls.length - 1];
  if (last) last.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const statusEl = $('#ai-code-status', view);
  if (statusEl) statusEl.textContent = 'Added as a new code cell at the end of the notebook.';
}

function renderAiThread() {
  const thread = $('#ai-thread', view);
  if (!thread) return;
  const { messages } = aiThread();
  if (!messages.length) {
    thread.innerHTML = '<p class="hint">Ask in plain language — the AI drafts a note proposal from the current chapter. Apply inserts it into that chapter’s file.</p>';
    return;
  }
  thread.innerHTML = '';
  messages.forEach((msg, i) => {
    const el = document.createElement('div');
    el.className = `ai-msg ai-msg-${msg.role}`;
    if (msg.role === 'user') {
      el.textContent = msg.content;
    } else {
      const body = document.createElement('div');
      body.className = 'ai-msg-body';
      body.innerHTML = window.marked ? window.marked.parse(msg.markdown || '') : esc(msg.markdown || '');
      const actions = document.createElement('div');
      actions.className = 'ai-msg-actions';
      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'primary';
      applyBtn.textContent = msg.applied ? 'Applied ✓' : 'Apply';
      applyBtn.disabled = !!msg.applied;
      applyBtn.addEventListener('click', () => applyAiNote(i));
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(msg.markdown || '');
          copyBtn.textContent = 'Copied ✓';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        } catch { copyBtn.textContent = 'Copy failed'; }
      });
      actions.append(applyBtn, copyBtn);
      el.append(body, actions);
    }
    thread.appendChild(el);
  });
  thread.scrollTop = thread.scrollHeight;
}

async function askAi() {
  const panel = $('#ai-panel', view);
  if (!panel || !state.aiPanelOpen) return;
  const input = $('#ai-prompt', panel);
  const statusEl = $('#ai-status', panel);
  const sendBtn = $('#ai-send', panel);
  const prompt = (input.value || '').trim();
  statusEl.classList.remove('error');
  if (!prompt) { statusEl.textContent = 'Type what you want the AI to write.'; return; }
  if (prompt.length > 2000) { statusEl.textContent = 'Keep the request under 2000 characters.'; return; }
  const thread = aiThread();
  const ch = activeOutlineChapter();
  const history = thread.messages.slice(-6).map((m) => ({
    role: m.role,
    content: m.role === 'assistant' ? (m.markdown || '') : m.content,
  }));
  thread.messages.push({ role: 'user', content: prompt });
  input.value = '';
  sendBtn.disabled = true;
  statusEl.textContent = 'Asking the AI…';
  renderAiThread();
  try {
    const reading = currentReadingPage();
    const res = await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/ai-note`, 'POST', {
      chapter: ch ? ch.title : null,
      prompt,
      includeNote: ch ? !!$('#ai-include-note', panel)?.checked : false,
      history,
      source: reading && reading.sourceId !== PAGE_ANCHOR_SOURCE_BOOK ? reading.sourceId : null,
      page: reading ? reading.page : null,
    });
    thread.messages.push({ role: 'assistant', content: '', markdown: res.markdown || '', applied: false });
    const ctxLabel = res.chapter?.title || (res.source ? activeSourceLabel() : null);
    statusEl.textContent = ctxLabel ? `Drafted from “${ctxLabel}”.` : 'Drafted (no chapter context).';
  } catch (err) {
    statusEl.textContent = /LLM not configured/i.test(err.message || '')
      ? 'AI is not configured — set LLM_API_KEY and LLM_MODEL in server/.env, then restart the server.'
      : err.message;
    statusEl.classList.add('error');
  } finally {
    sendBtn.disabled = false;
    renderAiThread();
  }
}

async function applyAiNote(i) {
  const thread = aiThread();
  const msg = thread.messages[i];
  if (!msg || msg.role !== 'assistant' || msg.applied) return;
  const entry = currentChapterEntry();
  const statusEl = $('#ai-status', view);
  try {
    const { inserted, file } = await insertIntoChapterFile(entry, msg.markdown);
    msg.applied = true;
    if (statusEl) {
      statusEl.textContent = inserted
        ? `Inserted into ${file}.`
        : `Already in ${file} — nothing added.`;
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = `Could not insert: ${err.message}`;
      statusEl.classList.add('error');
    }
    return;
  }
  renderAiThread();
}

/* ---------------- export cells to Markdown ---------------- */

// Plot files exported under notes/assets/ are referenced with relative
// assets/... links in the markdown (portable for download). In the app's
// own previews those links resolve through the asset API route.
function rewriteAssetSrcs(el) {
  const slug = state.project?.slug;
  if (!slug) return;
  $$('img', el).forEach((img) => {
    const src = img.getAttribute('src');
    if (src && src.startsWith('assets/')) {
      img.src = `/api/projects/${encodeURIComponent(slug)}/assets/${src.slice('assets/'.length)}`;
    }
  });
}

function updateExportButton() {
  const btn = $('#nb-export-md', view);
  const count = $('#nb-export-count', view);
  if (!btn) return;
  const n = state.exportSelection.size;
  btn.disabled = n === 0;
  if (count) {
    count.textContent = n === 0
      ? 'Select cells to export'
      : `${n} cell${n === 1 ? '' : 's'} selected`;
  }
}

async function exportSelectedCells() {
  const indices = [...state.exportSelection].sort((a, b) => a - b);
  if (!indices.length || !state.activeNotebook) return;
  const name = state.activeTabKind === 'lab' && state.activeLab
    ? state.activeLab.name : state.activeNoteName;
  const btn = $('#nb-export-md', view);
  if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
  try {
    const res = await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/export-cells`, 'POST', {
      notebook: state.activeNotebook, name, cells: indices,
    });
    openCellExportModal(res.markdown, name, res.images || []);
  } catch (err) {
    const count = $('#nb-export-count', view);
    if (count) count.textContent = `Export failed: ${err.message}`;
  } finally {
    if (btn) { btn.textContent = 'Export to Markdown'; updateExportButton(); }
  }
}

function closeCellExportModal() {
  const existing = document.getElementById('cell-export-modal');
  if (existing) existing.remove();
}

/* Preview what the export produces, before anything is written to the
   chapter file. Two targets from one preview: [Insert into note] appends
   to the current chapter's file; [Download .md] saves the file (links
   resolve when it lives in notes/). */
function openCellExportModal(markdown, name, images) {
  closeCellExportModal();
  const base = String(name || 'notebook').replace(/\.ipynb$/i, '');
  const fileName = `${base}-cells.md`;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay ai-preview-overlay';
  overlay.id = 'cell-export-modal';
  overlay.innerHTML = `
    <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="cell-export-title">
      <h2 id="cell-export-title">Export cells to Markdown</h2>
      <p class="ai-notice">Deterministic export — no AI. Code as fenced blocks, outputs below,
        plots as files under <code>notes/assets/</code> with relative links.
        ${images.length ? 'Links resolve when this file lives in <code>notes/</code>.' : ''}</p>
      <h3>Preview</h3>
      <div class="ai-skeleton" id="cell-export-preview"></div>
      <h3>Markdown</h3>
      <textarea class="md-editor" id="cell-export-raw" rows="8" readonly spellcheck="false"></textarea>
      <div class="form-error" id="cell-export-error"></div>
      <div class="modal-actions">
        <button type="button" id="cell-export-close">Close</button>
        <button type="button" id="cell-export-copy">Copy</button>
        <button type="button" id="cell-export-download">Download .md</button>
        <button type="button" class="primary" id="cell-export-insert">Insert into note</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const previewEl = $('#cell-export-preview', overlay);
  previewEl.innerHTML = window.marked ? window.marked.parse(markdown || '') : esc(markdown || '');
  rewriteAssetSrcs(previewEl);
  $('#cell-export-raw', overlay).value = markdown || '';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCellExportModal(); });
  $('#cell-export-close', overlay).addEventListener('click', closeCellExportModal);
  $('#cell-export-copy', overlay).addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(markdown);
      e.currentTarget.textContent = 'Copied ✓';
      setTimeout(() => { e.currentTarget.textContent = 'Copy'; }, 1500);
    } catch {
      $('#cell-export-error', overlay).textContent = 'Copy failed — select the text manually.';
    }
  });
  $('#cell-export-download', overlay).addEventListener('click', () => {
    downloadBlob(markdown, fileName);
  });
  $('#cell-export-insert', overlay).addEventListener('click', async (e) => {
    const errBox = $('#cell-export-error', overlay);
    const btn = e.currentTarget;
    errBox.textContent = '';
    const entry = currentChapterEntry();
    btn.disabled = true;
    btn.textContent = 'Inserting…';
    try {
      const { inserted, file } = await insertIntoChapterFile(entry, markdown);
      btn.textContent = inserted ? `Inserted into ${file} ✓` : 'Already inserted ✓';
    } catch (err) {
      errBox.textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Insert into note';
    }
  });
}

/* ---------------- boot ---------------- */

// Ctrl/Cmd+S saves the markdown note whenever its editor is open,
// even if focus has moved off the textarea (e.g. to a toolbar button).
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's'
    && state.activeNoteKind === 'md' && state.project) {
    e.preventDefault();
    saveActiveMdNote(true);
  }
});

route();
