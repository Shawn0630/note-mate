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
   - POST   /api/import/ai/propose   (multipart file + optional title)
   - POST   /api/import/ai/apply     (multipart file + proposal JSON + title)
   - GET    /api/projects/:slug/notes
   - GET    /api/projects/:slug/notes/:name
   - PUT    /api/projects/:slug/notes/:name   {content}
   - POST   /api/projects/:slug/cover         {dataUrl}
   - POST   /api/projects/:slug/chapter-map   {mapping}
   - POST   /api/execute                      {language, code}
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
   This is a verbatim port of normalizeHeading in src/util.js — the keys must
   match the backend's chapterMap exactly (e.g. {"introduction": 0}).
   normalize: lowercase, strip leading "Chapter N:" / "Appendix A -" /
   numbering like "1.2 ", strip trailing dots, strip punctuation, collapse spaces.
   Match exact, then startsWith/contains. */
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
   Returns [{text, norm, line}] where line is the 0-based source line. */
function headingsFromMarkdown(text) {
  const out = [];
  String(text || '').split('\n').forEach((line, i) => {
    const m = line.match(/^#{2,3}\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ text: m[1].trim(), norm: normalizeHeading(m[1]), line: i });
  });
  return out;
}

/* Headings from an ipynb notebook object (markdown cells only). */
function headingsFromNotebook(nb) {
  const out = [];
  if (!nb || !Array.isArray(nb.cells)) return out;
  nb.cells.forEach((cell, ci) => {
    if (cell.cell_type !== 'markdown') return;
    const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
    headingsFromMarkdown(src).forEach((h) => out.push({ ...h, cellIndex: ci }));
  });
  return out;
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
  mdMode: 'preview',    // 'edit' | 'preview' for markdown notes
  follow: true,         // scroll-spy follow toggle
  editorFocused: false,
  headings: [],         // headings of the active note
  outline: [],          // [{title, page, depth}] for PDFs
  chapterMap: {},       // normalized outline title -> note heading index (user override)
  activeChapter: null,  // normalized chapter title currently active
  pdfDoc: null,
  pdfPages: [],         // [{num, top}] measured offsets in the pdf container
  pdfContainer: null,
  // Scroll-spy suppression while a programmatic chapter-click scroll is in
  // flight: the smooth scroll fires scroll events the whole way down, and
  // without this the spy would overwrite the clicked chapter with the first
  // subsection sharing its page (every chapter's first subsection starts on
  // the same page as the chapter). Armed in setActiveChapter when it scrolls
  // the PDF; released by onPdfScroll on arrival, or by the timestamp.
  suppressSpyUntil: 0, // ms epoch — ignore the spy while Date.now() < this
  suppressSpyPage: null, // target page of the in-flight click scroll
  suppressSpyTop: null,  // target scrollTop of the in-flight click scroll
  // Multi-source reader (v1.1): materials[] from GET .../materials.
  // activeSourceId null = the project's main (Book) source.
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
};

function resetReaderState() {
  if (state.pdfDoc) { try { state.pdfDoc.destroy(); } catch { /* ignore */ } }
  state.project = null;
  state.notes = [];
  state.activeNoteName = null;
  state.activeNoteKind = null;
  state.activeNoteContent = '';
  state.activeNotebook = null;
  state.mdMode = 'preview';
  state.headings = [];
  state.outline = [];
  state.chapterMap = {};
  state.activeChapter = null;
  state.pdfDoc = null;
  state.pdfPages = [];
  state.pdfContainer = null;
  state.suppressSpyUntil = 0;
  state.suppressSpyPage = null;
  state.suppressSpyTop = null;
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
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
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
  state.chapterMap = (project.chapterMap && typeof project.chapterMap === 'object')
    ? project.chapterMap : {};

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

  // Default note: notes.md if present, else the first note.
  const def = state.notes.find((n) => n.name === 'notes.md')
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
  const chaptersHidden = sessionStorage.getItem(`nm-chapters-hidden:${p.slug}`) === '1';
  const bookLabel = String(p.kind || '').toLowerCase() === 'pdf'
    ? 'Book (PDF)' : `Main source (${kindLabel(p.kind)})`;
  const switcher = state.materials.length
    ? `<select id="source-switcher" class="source-switcher" aria-label="Reading source"
         title="Switch reading source">
         <option value="">${esc(bookLabel)}</option>
         ${state.materials.map((m) => `<option value="${esc(m.id)}"${m.hasFile ? '' : ' disabled'}>${esc(m.label || m.id)}${m.hasFile ? '' : ' — download only'}</option>`).join('')}
       </select>`
    : '';
  view.innerHTML = `
    <div class="reader ${chaptersHidden ? 'chapters-hidden' : ''}" id="reader">
      <header class="topbar">
        <a class="back-link" href="#/">‹ Shelf</a>
        <button type="button" id="chapter-toggle" aria-pressed="${chaptersHidden ? 'false' : 'true'}"
                title="Show or hide the chapter panel">Chapters</button>
        <h1>${esc(p.title || 'Untitled')}</h1>
        ${switcher}
        <span class="badge">${esc(kindLabel(p.kind))}</span>
      </header>
      <aside class="chapter-panel" id="chapter-panel" aria-label="Chapters"></aside>
      <section class="reading-pane" id="reading-pane" aria-label="Reading pane"></section>
      <aside class="notebook-pane" id="notebook-pane" aria-label="Notebook"></aside>
    </div>`;

  const switcherEl = $('#source-switcher', view);
  if (switcherEl) {
    switcherEl.addEventListener('change', () => {
      switchSource(switcherEl.value || null);
    });
  }

  $('#chapter-toggle', view).addEventListener('click', () => {
    const reader = $('#reader', view);
    const hidden = reader.classList.toggle('chapters-hidden');
    sessionStorage.setItem(`nm-chapters-hidden:${p.slug}`, hidden ? '1' : '0');
    $('#chapter-toggle', view).setAttribute('aria-pressed', hidden ? 'false' : 'true');
    if (state.pdfDoc) measurePdfPages();
  });

  renderNotebookPane();
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
    pane.innerHTML = `<div class="reading-scroll" id="pdf-scroll"><p class="reading-note">Loading PDF…</p></div>`;
    await loadPdf(fileUrl, sourceUrl);
  } else if (kind === 'video') {
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

  // One placeholder per page; canvases render lazily near the viewport.
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
  measurePdfPages();

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

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) renderPage(e.target); });
  }, { root: container, rootMargin: '600px 0px' });
  placeholders.forEach((h) => io.observe(h));

  // Scroll-spy: current page -> active chapter -> follow the notebook.
  let ticking = false;
  container.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; onPdfScroll(); });
  }, { passive: true });

  // Lazy cover: first page rendered small, posted once per open.
  if (!state.project.cover && !state.coverGenerated) {
    state.coverGenerated = true;
    generateCover(pdf);
  }
  onPdfScroll();
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
  let best = null;
  for (const ch of state.outline) {
    if (ch.page != null && ch.page <= pageNum) best = ch;
    else if (ch.page != null && ch.page > pageNum) break;
  }
  return best;
}

function onPdfScroll() {
  if (!state.pdfDoc || !state.outline.length) return;
  if (Date.now() < state.suppressSpyUntil) {
    // A programmatic chapter-click scroll is still in flight: ignore the spy
    // so the clicked chapter stays active. Release early once the scroll has
    // arrived at (and stopped on) the target page — this event still does not
    // run the spy; the next manual scroll will. The timestamp is the backstop
    // for a scroll that can never reach its target (e.g. clamped at max
    // scrollTop on the last page).
    const arrived = state.suppressSpyPage != null
      && state.pdfContainer
      && state.suppressSpyTop != null
      && currentPdfPage() >= state.suppressSpyPage
      && Math.abs(state.pdfContainer.scrollTop - state.suppressSpyTop) <= 2;
    if (arrived) {
      state.suppressSpyUntil = 0;
      state.suppressSpyPage = null;
      state.suppressSpyTop = null;
    }
    return;
  }
  const ch = chapterForPage(currentPdfPage());
  if (ch && normalizeHeading(ch.title) !== state.activeChapter) {
    setActiveChapter(ch, { scrollNotebook: true });
  }
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

function resolvedChapterHeading(chapter) {
  // User override (chapterMap) wins; otherwise the shared matching rule.
  // Canonical backend shape: { "<normalized outline title>": <heading index> },
  // e.g. {"introduction": 0, "supervised learning": 1, ...}. Lookup order:
  // chapterMap[normalizeHeading(title)] (if in range) -> auto-match -> null.
  const override = state.chapterMap[normalizeHeading(chapter.title)];
  if (typeof override === 'number' && state.headings[override]) {
    return state.headings[override];
  }
  return matchHeading(chapter.title, state.headings);
}

function renderChapterPanel() {
  const panel = $('#chapter-panel', view);
  if (!panel) return;
  const kind = String(state.project?.kind || '').toLowerCase();

  // A slide deck has no PDF outline of its own: when the active source's PDF
  // yields no outline, state.outline is empty and this falls through to the
  // note-headings nav below — nothing is invented.
  const sourceNote = state.activeSourceId
    ? `<p class="chapter-source">Source: ${esc(activeSourceLabel())}</p>` : '';

  if (kind === 'pdf' && state.outline.length) {
    panel.innerHTML = `<h2>Chapters</h2>${sourceNote}` + state.outline.map((ch, i) => {
      const matched = resolvedChapterHeading(ch);
      const isActive = state.activeChapter === normalizeHeading(ch.title);
      const indent = ch.depth ? ` style="padding-left:${16 + ch.depth * 14}px"` : '';
      let row = `<button type="button" class="chapter-row${isActive ? ' active' : ''}"
          data-chapter="${i}"${indent}>${esc(ch.title)}${ch.page != null ? `<span class="chapter-page">p. ${ch.page}</span>` : ''}</button>`;
      if (!matched) {
        row += `<div class="chapter-link">
          <select data-link-chapter="${i}" aria-label="Link chapter to a note heading">
            <option value="">Link to a note heading…</option>
            ${state.headings.map((h, hi) => `<option value="${hi}">${esc(h.text)}</option>`).join('')}
          </select>
        </div>`;
      }
      return row;
    }).join('');

    $$('.chapter-row', panel).forEach((btn) => {
      btn.addEventListener('click', () => {
        const ch = state.outline[Number(btn.dataset.chapter)];
        setActiveChapter(ch, { scrollNotebook: true, scrollPdf: true, force: true });
      });
    });
    $$('select[data-link-chapter]', panel).forEach((sel) => {
      sel.addEventListener('change', async () => {
        const ch = state.outline[Number(sel.dataset.linkChapter)];
        if (sel.value === '' || !ch) return;
        state.chapterMap[normalizeHeading(ch.title)] = Number(sel.value);
        try {
          await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/chapter-map`,
            'POST', { mapping: state.chapterMap });
        } catch {
          // Keep the local mapping even if the save failed; it still works this visit.
        }
        renderChapterPanel();
      });
    });
    return;
  }

  // No PDF outline (or not a PDF): the note's ## headings are the nav.
  const headings = state.headings;
  panel.innerHTML = `<h2>${kind === 'pdf' ? 'Headings' : 'Notes'}</h2>${sourceNote}` +
    (headings.length
      ? headings.map((h, i) => `
          <button type="button" class="chapter-row${state.activeChapter === h.norm ? ' active' : ''}"
            data-heading="${i}">${esc(h.text)}</button>`).join('')
      : `<p class="chapter-empty">No headings yet — add a <code>## Heading</code>
         to your note and it will show up here as navigation.</p>`);
  $$('.chapter-row', panel).forEach((btn) => {
    btn.addEventListener('click', () => {
      const h = state.headings[Number(btn.dataset.heading)];
      state.activeChapter = h.norm;
      $$('.chapter-row', panel).forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      scrollNotebookToHeading(h, true);
    });
  });
}

function setActiveChapter(chapter, { scrollNotebook = false, scrollPdf = false, force = false } = {}) {
  state.activeChapter = normalizeHeading(chapter.title);
  $$('#chapter-panel .chapter-row').forEach((row) => {
    const idx = Number(row.dataset.chapter);
    row.classList.toggle('active', !Number.isNaN(idx) && state.outline[idx] === chapter);
  });
  if (scrollPdf && chapter.page != null && state.pdfContainer) {
    const pg = state.pdfPages.find((p) => p.num === chapter.page);
    if (pg) {
      const top = Math.max(0, pg.top - 8);
      // Arm scroll-spy suppression for this programmatic scroll (see state):
      // the smooth scroll fires scroll events the whole way, and the spy
      // would otherwise overwrite the clicked chapter with its first
      // subsection. The 3000ms backstop covers a scroll that never lands on
      // its target; onPdfScroll releases early on arrival.
      state.suppressSpyUntil = Date.now() + 3000;
      state.suppressSpyPage = chapter.page;
      state.suppressSpyTop = top;
      state.pdfContainer.scrollTo({ top, behavior: 'smooth' });
    }
  }
  if (scrollNotebook) {
    const heading = resolvedChapterHeading(chapter);
    scrollNotebookToHeading(heading, force); // null -> leave the notebook alone
  }
}

/* Scroll the notebook pane to a heading.
   Guards: never while the markdown editor textarea is focused (user typing),
   and never while the Follow toggle is off — except for explicit chapter clicks,
   which pass force=true.
   A heading with no match never scrolls the notebook: top-of-note is never a
   useful destination, so a null heading (or a heading with no element in the
   rendered note) leaves the notebook exactly where it is. */
function scrollNotebookToHeading(heading, force = false) {
  if (!force) {
    if (!state.follow) return;
    if (state.editorFocused) return;
  }
  if (!heading) return;
  const body = $('.notebook-body', view);
  if (!body) return;

  if (state.mdMode === 'preview' || state.activeNoteKind === 'ipynb') {
    const el = body.querySelector(`[data-h="${CSS.escape(heading.norm)}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  // Edit mode: scroll the textarea so the heading line is visible.
  const ta = $('.md-editor', body);
  if (!ta) return;
  const lines = ta.value.split('\n');
  const idx = Math.min(heading.line ?? 0, lines.length - 1);
  const lineHeight = 22; // 13.5px font * 1.65 line-height
  ta.scrollTop = Math.max(0, idx * lineHeight - 40);
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
  if (state.activeNoteKind === 'ipynb') {
    try { state.activeNotebook = JSON.parse(content || '{"cells":[]}'); }
    catch { state.activeNotebook = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }; }
    if (!Array.isArray(state.activeNotebook.cells)) state.activeNotebook.cells = [];
    state.headings = headingsFromNotebook(state.activeNotebook);
  } else {
    state.headings = headingsFromMarkdown(content);
  }
}

function renderNotebookPane() {
  const pane = $('#notebook-pane', view);
  if (!pane) return;
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
    tab.textContent = n.name;
    tab.addEventListener('click', async () => {
      if (state.activeTabKind === 'note' && n.name === state.activeNoteName) return;
      await loadNote(n.name);
      state.mdMode = 'preview';
      renderNotebookPane();
      renderChapterPanel();
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
  state.headings = headingsFromNotebook(state.activeNotebook);
}

/* Close a lab tab. Saves are explicit (same as notes), so closing never
   loses saved work; unsaved in-memory edits to that lab are dropped. */
async function closeLabTab(lab) {
  state.labTabs = state.labTabs.filter(
    (t) => !(t.chapter === lab.chapter && t.name === lab.name));
  const wasActive = state.activeTabKind === 'lab' && state.activeLab
    && state.activeLab.chapter === lab.chapter && state.activeLab.name === lab.name;
  if (!wasActive) { renderNotebookPane(); return; }
  const def = state.notes.find((n) => n.name === 'notes.md')
    || state.notes.find((n) => n.kind === 'md')
    || state.notes[0];
  if (def) {
    try { await loadNote(def.name); } catch { /* pane renders empty */ }
    state.mdMode = 'preview';
  } else {
    state.activeTabKind = 'note';
    state.activeLab = null;
    state.activeNoteName = null;
    state.activeNoteKind = 'md';
    state.activeNoteContent = '';
    state.activeNotebook = null;
    state.headings = [];
  }
  renderNotebookPane();
  renderChapterPanel();
}

function renderNotebookToolbar() {
  const bar = $('#notebook-toolbar', view);
  if (!bar) return;
  if (state.activeNoteKind === 'md') {
    bar.innerHTML = `
      <button type="button" id="md-mode-toggle">${state.mdMode === 'edit' ? 'Preview' : 'Edit'}</button>
      <label class="follow-toggle" title="Follow the reading pane: scroll the notebook to the current chapter">
        <input type="checkbox" id="follow-toggle" ${state.follow ? 'checked' : ''}> Follow
      </label>
      <span class="spacer"></span>
      <span class="save-status" id="save-status"></span>
      <button type="button" id="md-save-btn">Save</button>`;
    $('#md-mode-toggle', bar).addEventListener('click', () => {
      state.mdMode = state.mdMode === 'edit' ? 'preview' : 'edit';
      renderNotebookToolbar();
      renderNotebookBody();
    });
    $('#follow-toggle', bar).addEventListener('change', (e) => { state.follow = e.target.checked; });
    $('#md-save-btn', bar).addEventListener('click', () => saveActiveMdNote(true));
  } else {
    bar.innerHTML = `
      <label class="follow-toggle" title="Follow the reading pane: scroll the notebook to the current chapter">
        <input type="checkbox" id="follow-toggle" ${state.follow ? 'checked' : ''}> Follow
      </label>
      <span class="spacer"></span>
      <span class="save-status" id="save-status"></span>`;
    $('#follow-toggle', bar).addEventListener('change', (e) => { state.follow = e.target.checked; });
  }
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
  if (state.mdMode === 'edit') {
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
      setSaveStatus('Unsaved changes', 'dirty');
    });
  } else {
    body.innerHTML = `<div class="md-preview" id="md-preview"></div>`;
    renderMdPreview($('#md-preview', body), state.activeNoteContent);
  }
}

/* Render markdown into el; tag headings with data-h for scroll-spy and
   attach a Run button to python/java/javascript fenced code blocks. */
function renderMdPreview(el, text) {
  el.innerHTML = window.marked ? window.marked.parse(text || '') : esc(text || '');
  $$('h2, h3', el).forEach((h) => { h.dataset.h = normalizeHeading(h.textContent); });
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
}

async function runCode(language, code) {
  return apiJson('/api/execute', 'POST', { language, code });
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
    await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/notes/${encodeURIComponent(name)}`,
      'PUT', { content });
    state.headings = headingsFromMarkdown(content);
    renderChapterPanel();
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
    state.headings = headingsFromNotebook(state.activeNotebook);
    renderChapterPanel();
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
    state.mdMode = 'edit';
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

function renderIpynbBody(body) {
  const nb = state.activeNotebook;
  const lang = nb?.metadata?.language_info?.name
    || nb?.metadata?.kernelspec?.language || 'python';
  body.innerHTML = `<div class="nb-cells" id="nb-cells"></div>`;
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
        <div class="nb-cell-head"><span>Code · ${esc(lang)}</span><span class="spacer"></span>
          <button type="button" data-cell-del="${idx}">Delete</button></div>
        <textarea class="nb-code-source" spellcheck="false"></textarea>
        <div class="nb-cell-foot">
          <button type="button" class="run-btn" data-cell-run="${idx}">▶ Run</button>
          <span class="save-status" data-cell-status="${idx}"></span>
        </div>
        <div class="nb-output" data-cell-output="${idx}"></div>`;
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
      $(`[data-cell-del="${idx}"]`, cellEl).addEventListener('click', async () => {
        if (!window.confirm('Delete this cell?')) return;
        nb.cells.splice(idx, 1);
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
      saveNotebook().then(() => renderNotebookBody());
    });
    $(`[data-add-code="${idx}"]`, addRow).addEventListener('click', () => {
      nb.cells.splice(idx + 1, 0, { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: '' });
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
  el.innerHTML = html;
}

/* ---------------- boot ---------------- */

// Ctrl/Cmd+S saves the markdown note whenever its editor is open,
// even if focus has moved off the textarea (e.g. to a toolbar button).
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's'
    && state.activeNoteKind === 'md' && state.mdMode === 'edit' && state.project) {
    e.preventDefault();
    saveActiveMdNote(true);
  }
});

route();
