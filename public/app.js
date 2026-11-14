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
   - POST   /api/projects/:slug/ai-note       {chapter?, prompt, includeNote?, history?}
                                              → {markdown, chapter, contextChars}
   - POST   /api/projects/:slug/export-cells  {notebook, name, cells:[indexes]}
                                              → {markdown, images, cells}
   - GET    /api/projects/:slug/assets/:file  exported plot PNG (notes/assets/)
   - POST   /api/projects/:slug/assets        {dataUrl} → {fileName, path}
                                              pasted screenshot (notes/assets/)
   - POST   /api/execute                      {language, code}
   - POST   /api/execute                      {language, cells:[{source}]}
                                              → {results:[{stdout, stderr, exitCode, images, skipped}]}
                                              (run-all: one shared session; java unsupported)
*/
import * as pdfjsLib from './vendor/pdfjs/pdf.mjs';
import {
  clampNavWidth, clampAiWidth, splitReadingNotebook, gridTemplate,
  sanitizeWidths, sanitizePanels, matchPreset, defaultPanels,
  migrateLayoutModeName, LAYOUT_PRESET_NAMES,
  clampZoom, zoomStep, zoomFromWheel, zoomFromGesture, zoomPercent,
  fitScale, firstFreeName, PANE_DEFAULTS, LAYOUT_PRESETS,
} from './readerLayout.js';
import { MD_QUICK_ACTIONS, mdQuickSnippet } from './mdQuickActions.js';
import {
  recordImpression, recentImpressions, relativeTimeLabel, impressionLabel,
} from './recentImpressions.js';
import {
  emptyReadingPosition, parseReadingPosition, recordReadingPosition,
  storedPageOrDefault,
} from './readingPosition.js';
import {
  imageMarkdownRef, appendImageEdit, embedAssetsInMarkdown,
} from './pasteImage.js';
import {
  resolveScreenshotTarget, pageCanvasSelector, pageHolderSelector,
  normalizeSelectionRect, isClickSelection, cropRegionToCanvas,
} from './screenshotCapture.js';
import {
  AI_CODE_CONTEXT_CHARS, targetCellLabel, targetCellFingerprint,
  formatNotebookCellsForCodeAi,
} from './aiCodeContext.js';
import {
  pushUndoEntry, popUndoEntry,
  editUndoEntry, addUndoEntry, deleteUndoEntry,
  replaceUndoEntry, appendUndoEntry, createEditBaselines,
} from './nbUndo.js';
import {
  openTabsKey, restoreOpenTabs, serializeOpenTabs,
} from './openTabs.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.mjs';

const view = document.getElementById('view');
const RUNNABLE_LANGS = ['python', 'java', 'javascript'];
// Display name per runnable language — shown in the + menu and the
// create dialog. The file format (.ipynb, language-agnostic Jupyter)
// is never shown as a language tag.
const LANG_DISPLAY = { python: 'IPython', java: 'Java', javascript: 'JavaScript' };

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
    const m = line.match(/^(#{2,3})\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ text: m[2].trim(), norm: normalizeHeading(m[2]), line: i, level: m[1].length });
  });
  return out;
}

/* ## headings only — the chapterMap index space. ### sub-headings (e.g. an
   AI note's "### Attention in one line") sit inside a ## section and must
   never shift the chapter indexes: the seeded map counts ## headings
   (0–20 for 21 chapters), and a ### inserted mid-file used to push every
   later chapter one early in notebook follow. Headings without a recorded
   level count as ##. */
function h2Headings(headings) {
  return (headings || []).filter((h) => (h.level ?? 2) === 2);
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
  // Word reads as a PDF project: the file route converts it lazily.
  if (ext === 'docx' || ext === 'doc') return 'pdf';
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
  editorFocused: false,
  headings: [],         // headings of the active note
  outline: [],          // [{title, page, depth}] for PDFs
  chapterMap: {},       // normalized outline title -> note heading index (user override)
  // "Edit links" mode for the Chapters panel: off by default the panel is
  // just clean chapter rows; on, each row gets its "Link to a note heading…"
  // dropdown (the manual chapterMap override). Session-only, defaults off.
  editChapterLinks: false,
  activeChapter: null,  // normalized chapter title currently active
  pdfDoc: null,
  pdfPages: [],         // [{num, top}] measured offsets in the pdf container
  pdfContainer: null,
  // Reader layout (AV-style, 2026-11-11): four panes — chapters nav,
  // reading, working (notebook), AI — in a 7-column grid with draggable
  // dividers between them. `panels` is which panes are visible; `layoutMode`
  // is the matching preset name ('reading' | 'navigation' | 'notetaking' | 'ai') or 'custom'
  // when the Panels checklist diverges from every preset. Widths persist
  // per project in localStorage (see loadReaderLayout / saveReaderLayout);
  // the reading/notebook split is fractions of their combined width.
  layoutMode: 'notetaking',
  panels: { nav: false, reading: true, notebook: true, ai: false },
  widths: { ...PANE_DEFAULTS },
  // Zoom is a multiplier on the width-fitting PDF scale (1 = fit width),
  // per source, per session (not persisted). 'slides' is the Google Slides
  // iframe zoom (a visual scale — see applySlidesZoom).
  zoom: { pdf: 1, deck: 1, slides: 1 },
  // PDF annotations (highlight + note pin): all of the project's
  // annotations, every source; rendered as an overlay on the pdf.js pages
  // (see renderAnnotOverlays). Stored in annotations.json, separate from
  // notes.md. annotTool null = no tool; the Google Slides iframe cannot
  // be annotated (out of scope).
  annotations: [],
  annotTool: null,       // null | 'highlight' | 'note' | 'erase'
  annotColor: 'yellow',  // current highlight / pin color
  selectedAnnotationId: null, // pin whose editor popover is open
  // Left (reading) pane tabs — PDF projects only. pdf = the book PDF,
  // slides = the current chapter's slide deck, preview = the rendered
  // notes.md preview following the current chapter.
  leftTab: 'pdf',       // 'pdf' | 'slides' | 'preview'
  // The deck PDF shown in the Slides tab lives in its own container so
  // each tab keeps its scroll position (the book PDF is never unloaded).
  deckDoc: null,
  deckPages: [],        // [{num, top}] measured offsets in the deck container
  deckContainer: null,
  deckMaterialId: null, // material id of the deck currently shown
  deckChapter: null, // normalized chapter the current deck was chosen for (see loadDeckPdf)
  notesMdContent: null, // cached notes.md text for the left Preview tab
  // Multi-source reader (v1.1): materials[] from GET .../materials.
  // activeSourceId null = the project's main (Book) source. It mirrors the
  // left tab (pdf -> null, slides -> the deck id) so the chapter panel's
  // source note and the AI context line keep working.
  materials: [],
  activeSourceId: null,
  // The PDF the PDF tab is showing: 'book' or an extra PDF material id.
  // The book is the default; the picker appears only when the project has
  // extra PDFs (see syncPdfPicker).
  pdfSourceId: 'book',
  // Recent impressions: pages/slides looked at in the last 5 minutes,
  // session-only. The Page anchor quick action offers them in a dropdown.
  recentImpressions: [],
  // Reading position: where he was, per project AND per source — the book
  // remembers its own page, each extra PDF its own page, each deck its own
  // slide (see public/readingPosition.js). Durable in localStorage, so a
  // refresh or reopen returns to the same page/slide. restoringPosition
  // guards the save while a restore scroll is in flight (a fresh load
  // starts at the top — saving that would clobber the stored position).
  readingPosition: emptyReadingPosition(),
  restoringPosition: false,
  // Sources whose position this session has actually established — by a
  // restore, a jump, or a real scroll of the container. A fresh load
  // leaves every source but the active one at the top, and the save must
  // not overwrite those sources' stored pages with the untouched top
  // until the reader really moves in them. Session-only, never stored.
  positionEstablished: new Set(),
  // Labs (v1.1): chapters from GET .../labs; labTabs are labs opened as
  // notebook tabs. activeTabKind 'note' | 'lab' decides the save endpoint.
  // The Labs index lives behind the tab-bar + menu (no visible section).
  labs: [],
  labTabs: [],          // [{chapter, name}]
  activeTabKind: 'note',
  activeLab: null,      // {chapter, name} when a lab tab is active
  labsOpenChapters: {}, // chapter -> true when its group is expanded in the + menu (shared with the Files directory)
  // Open tabs: owned notes currently on the tab bar. Hiding a tab only
  // removes its name here — the file stays on disk and re-opens from
  // the Files directory. Persisted per project (see openTabs.js).
  openNotes: new Set(),
  showFiles: false,     // Files directory panel visible (forced on when no tab is open)
  saveTimer: null,
  // Left Preview tab: the note being previewed. Null = not picked yet —
  // defaults to the active markdown note, else the master notes.md.
  // Once the user picks from the picker, the selection is manual.
  previewNoteName: null,
  // On-demand AI notes + cell export: one AI thread per notebook, kept in
  // memory for the session (resets on reload — same v1 limit as Finance
  // Mate's Refine panel). Export selection is per notebook too.
  aiTab: 'note',        // 'note' (Note AI) | 'code' (Code AI)
  aiThreads: {},        // notebookKey -> {messages: [{role, content, markdown, applied}]}
  aiCodeThreads: {},    // notebookKey -> {messages: [{role, content, code, explanation, applied}]}
  nbUndoStacks: {},     // notebookKey -> undo stack (LIFO, cap 20, session-only)
  exportSelection: new Set(), // notebook cell indexes selected for export
  exportSelectionFor: null,   // notebook key the selection belongs to
  // AI model picker (AV-style): the server lists the models the key can
  // use (GET /api/llm/models); the choice persists in localStorage and is
  // sent with every ai-note / ai-code request.
  aiModels: [],         // [{name}] from the server, or [] when unconfigured
  aiModel: '',          // selected model id ('' = configured default)
  aiModelsLoaded: false,
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
  state.layoutMode = 'notetaking';
  state.panels = { nav: false, reading: true, notebook: true, ai: false };
  state.widths = { ...PANE_DEFAULTS };
  state.zoom = { pdf: 1, deck: 1, slides: 1 };
  state.annotations = [];
  state.annotTool = null;
  state.annotColor = 'yellow';
  state.selectedAnnotationId = null;
  state.previewNoteName = null;
  state.leftTab = 'pdf';
  state.deckDoc = null;
  state.deckPages = [];
  state.deckContainer = null;
  state.deckMaterialId = null;
  state.deckChapter = null;
  state.notesMdContent = null;
  state.materials = [];
  state.activeSourceId = null;
  state.pdfSourceId = 'book';
  state.recentImpressions = [];
  state.readingPosition = emptyReadingPosition();
  state.restoringPosition = false;
  state.positionEstablished = new Set();
  state.labs = [];
  state.labTabs = [];
  state.activeTabKind = 'note';
  state.activeLab = null;
  state.labsOpenChapters = {};
  state.openNotes = new Set();
  state.showFiles = false;
  state.coverGenerated = false;
  state.editorFocused = false;
  state.aiTab = 'note';
  state.aiThreads = {};
  state.aiCodeThreads = {};
  state.aiModels = [];
  state.aiModel = '';
  try { state.aiModel = window.localStorage.getItem(AI_MODEL_KEY) || ''; } catch { /* ignore */ }
  state.aiModelsLoaded = false;
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

// A refresh mid-scroll (or mid-flight after a chapter click) should keep
// the last position the reader was actually on — flush the current
// position before the page goes away. Synchronous localStorage write.
window.addEventListener('beforeunload', () => {
  try { saveReadingPosition(); } catch { /* ignore */ }
});

/* Zoom shortcuts (bound once): Cmd/Ctrl + +/- zooms the reading pane's
   document, Cmd/Ctrl + 0 fits it to the pane width. Skipped while typing
   in an input/textarea, and on the Preview tab (nothing to zoom there).
   The pinch gesture is handled separately on the scroll containers
   (ctrl+wheel / Safari gesture events — see mountPdfViewer). */
document.addEventListener('keydown', (e) => {
  if (!document.body.classList.contains('reader-open')) return;
  // Escape closes the pin editor, then clears the active annotation tool.
  // (In a text field it only closes the editor — clearing the tool from a
  // text field would be surprising.)
  if (e.key === 'Escape') {
    if (state.selectedAnnotationId) { closeAnnotEditor(); return; }
    if (state.annotTool) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      setAnnotTool(null);
    }
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const key = activeZoomKey();
  if (!key) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(key, zoomStep(state.zoom[key], 1), { immediate: true }); }
  else if (e.key === '-') { e.preventDefault(); setZoom(key, zoomStep(state.zoom[key], -1), { immediate: true }); }
  else if (e.key === '0') { e.preventDefault(); setZoom(key, 1, { immediate: true }); }
});

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

        <label for="ap-file">File (PDF, Word, video, or PowerPoint)</label>
        <input type="file" id="ap-file" name="file"
               accept=".pdf,.docx,.doc,.mp4,.webm,.mov,.mkv,.m4v,.ppt,.pptx,.key">
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

  // Open tabs: restored from the last session (hiding a tab sticks);
  // nothing stored yet → every editable note starts open, as before.
  state.openNotes = restoreOpenTabs(readStoredOpenTabs(), state.notes);

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
  await loadAnnotations();

  // Reading position: load the stored per-source positions before the
  // reader renders, and guard the save while the first load is in flight
  // — a fresh load starts at the top, and saving that would clobber the
  // stored position before the restore runs. restoreReadingPosition
  // clears the flag when it finishes.
  loadReadingPosition();
  state.restoringPosition = true;

  // Default note: the first editable note — notes.md is read-only and
  // never opens in the right pane (it lives in the left preview).
  const def = defaultEditorNote();
  if (def) {
    try { await loadNote(def.name); }
    catch { /* notebook pane renders empty; tabs still work */ }
  }

  // notes.md never opens in the editor, but the chapter panel resolves
  // chapters against its ## headings — keep the cache warm so the
  // resolution works from the first render.
  if (state.notes.some((n) => n.name === 'notes.md')) {
    try {
      const data = await apiGet(`/api/projects/${encodeURIComponent(slug)}/notes/notes.md`);
      syncNotesMdCache(typeof data === 'string' ? data : (data.content ?? ''));
    } catch { /* cache stays null; headings fall back */ }
  }

  renderReaderShell();
  renderChapterPanel();
  await renderReadingPane();
  await restoreReadingPosition();
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
  loadReaderLayout(); // per-project persisted panels + widths, else Notetaking
  document.body.classList.add('reader-open'); // edge-to-edge: no app header, no view padding
  view.innerHTML = `
    <div class="reader" id="reader">
      <header class="topbar">
        <a class="back-link" href="#/">‹ Shelf</a>
        <button type="button" id="chapter-toggle" aria-pressed="${state.panels.nav ? 'true' : 'false'}"
                title="Show or hide the chapter panel">Chapters</button>
        <h1>${esc(p.title || 'Untitled')}</h1>
        <button type="button" id="layout-menu-btn" title="Layout — presets and panels">▦ Layout</button>
        ${switcher}
        <span class="topbar-split">
          <button type="button" id="screenshot-top" title="Drag to select a region of the page to capture">Screenshot</button><button type="button" id="screenshot-top-chevron" class="topbar-chevron" title="Choose an image file from disk" aria-label="Screenshot options">▾</button>
        </span>
        <button type="button" id="ai-toggle-top" class="${state.panels.ai ? 'active' : ''}"
                title="Ask the AI — opens the AI panel">✨ Ask AI</button>
        <button type="button" id="theme-toggle-top" class="theme-toggle"
                title="Switch to dark theme" aria-label="Switch to dark theme">🌙</button>
      </header>
      <aside class="chapter-panel" id="chapter-panel" aria-label="Chapters"></aside>
      <div class="reader-divider" id="divider-nav" data-divider="nav" title="Drag to resize the chapter panel" aria-hidden="true"></div>
      <section class="reading-pane" id="reading-pane" aria-label="Reading pane"></section>
      <div class="reader-divider" id="divider-reading" data-divider="reading" title="Drag to resize the reading and working panes" aria-hidden="true"></div>
      <aside class="notebook-pane" id="notebook-pane" aria-label="Notebook"></aside>
      <div class="reader-divider" id="divider-ai" data-divider="ai" title="Drag to resize the AI panel" aria-hidden="true"></div>
      <aside class="ai-column" id="ai-column" aria-label="AI panel"></aside>
    </div>`;

  const switcherEl = $('#source-switcher', view);
  if (switcherEl) {
    switcherEl.addEventListener('change', () => {
      switchSource(switcherEl.value || null);
    });
  }

  $('#layout-menu-btn', view).addEventListener('click', (e) => {
    openLayoutMenu(e.currentTarget);
  });
  $('#screenshot-top', view).addEventListener('click', onTopbarScreenshot);
  $('#screenshot-top-chevron', view).addEventListener('click', (e) => {
    openScreenshotMenu(e.currentTarget, () => activeMdEditor());
  });
  $('#ai-toggle-top', view).addEventListener('click', toggleAiPanel);
  $('#theme-toggle-top', view).addEventListener('click', toggleTheme);
  syncThemeToggle();
  $('#chapter-toggle', view).addEventListener('click', () => {
    updatePanels({ ...state.panels, nav: !state.panels.nav });
  });
  bindDivider($('#divider-nav', view), 'nav');
  bindDivider($('#divider-reading', view), 'reading');
  bindDivider($('#divider-ai', view), 'ai');

  renderNotebookPane();
  renderAiColumn();
  applyReaderLayout({ save: false });
}

/* ---------------- reader layout: persistence ---------------- */

// The AI model choice is global (not per project): one localStorage key,
// like the AV's av-ai-model-v1.
const AI_MODEL_KEY = 'nm-ai-model-v1';

// One localStorage entry per project: {panels, widths, layoutMode}.
// Same spirit as the AV's av-dock-v1 key. A missing/corrupt entry means
// the Notetaking default; widths/panels are sanitized on load.
function readerLayoutKey() {
  return `nm-reader-layout:${state.project?.slug || 'default'}`;
}

function loadReaderLayout() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(readerLayoutKey()) || 'null');
    if (!raw || typeof raw !== 'object') return;
    state.panels = sanitizePanels(raw.panels);
    state.widths = sanitizeWidths(raw.widths);
    // The mode is re-derived from the panels, so a stored 'focus' (the
    // pre-rename name for Notetaking) migrates by itself; the stored name
    // is still passed through the one-time alias as a fallback.
    state.layoutMode = matchPreset(state.panels)
      || migrateLayoutModeName(raw.layoutMode) || 'custom';
  } catch {
    // Corrupt entry — keep the Notetaking default.
  }
}

function saveReaderLayout() {
  try {
    window.localStorage.setItem(readerLayoutKey(), JSON.stringify({
      panels: state.panels,
      widths: state.widths,
      layoutMode: state.layoutMode,
    }));
  } catch {
    // Storage unavailable — the layout simply does not persist.
  }
}

/* ---------------- reading position: persistence ---------------- */

// One localStorage entry per project (see public/readingPosition.js):
// {activeTab, activeSource, positions: {[sourceId]: page}}. Same spirit
// as the layout key above — per-browser reading state, not shared data,
// so it lives in localStorage, not project.json.
function readingPositionKey() {
  return `nm-reading-position:${state.project?.slug || 'default'}`;
}

function loadReadingPosition() {
  try {
    state.readingPosition = parseReadingPosition(
      window.localStorage.getItem(readingPositionKey()),
    );
  } catch {
    state.readingPosition = emptyReadingPosition();
  }
}

/* A source's position is established in this session once it has been
   restored, jumped to, or really scrolled — never by a fresh mount
   sitting at the top. The save only records established sources (see
   saveReadingPosition). */
function markPositionEstablished(sourceId) {
  if (sourceId) state.positionEstablished.add(String(sourceId));
}

function isPositionEstablished(sourceId) {
  return state.positionEstablished.has(String(sourceId));
}

/* Save where he is: the current tab's source + page. Cheap and
   idempotent — only writes when the store actually changed, so the
   scroll handlers can call it on every scroll tick. The Preview tab has
   no page of its own: it records the tab only, so opening the preview
   never overwrites the book page he was on. Suppressed while a restore
   scroll is in flight, and on non-PDF projects (nothing to restore). */
function saveReadingPosition() {
  if (!state.project || state.restoringPosition) return;
  if (String(state.project.kind || '').toLowerCase() !== 'pdf') return;
  let next = state.readingPosition;
  if (state.leftTab === 'preview') {
    next = recordReadingPosition(next, { tab: 'preview' });
  } else {
    const reading = currentReadingPage();
    if (!reading) return;
    // A Slides tab whose deck has not loaded yet reports slide 1 by
    // default — recording that would clobber the deck's stored slide
    // before the load restores it.
    if (state.leftTab === 'slides' && (!state.deckDoc || state.deckMaterialId !== reading.sourceId)) return;
    if (isPositionEstablished(reading.sourceId)) {
      next = recordReadingPosition(next, { sourceId: reading.sourceId, page: reading.page, tab: state.leftTab });
    } else {
      // The source has not been read, restored or scrolled in this
      // session (a fresh load leaves every source but the active one at
      // the top): record that it is the active source, but do NOT
      // overwrite its stored page with the untouched top-of-document
      // position — it will be restored, not overwritten, when he moves
      // in it.
      next = recordReadingPosition(next, { sourceId: reading.sourceId, tab: state.leftTab });
    }
  }
  const prevJson = JSON.stringify(state.readingPosition);
  state.readingPosition = next;
  if (JSON.stringify(next) === prevJson) return;
  try {
    window.localStorage.setItem(readingPositionKey(), JSON.stringify(next));
  } catch {
    // Storage unavailable — the position simply does not persist.
  }
}

/* The page to restore for a source, from the store, clamped to the
   document actually loaded (out of range -> page 1). */
function storedPageFor(sourceId, numPages) {
  return storedPageOrDefault(state.readingPosition, sourceId, numPages);
}

/* Restore the PDF tab's source to its stored page after a source load
   (book or extra PDF): the switch path reloads the container at the top,
   so without this a source switch would always land on page 1. No-op
   when nothing is stored for the source. */
function restorePdfSourcePosition(sourceId) {
  if (!state.pdfDoc || state.pdfSourceId !== sourceId) return;
  const page = storedPageFor(sourceId, state.pdfDoc.numPages);
  if (page > 1) {
    markPositionEstablished(sourceId);
    scrollBookToPage(page, { behavior: 'auto' });
  }
}

/* Same for a deck load: the container is rebuilt at the top on every deck
   switch, so the deck returns to the slide it was left on. */
function restoreDeckPosition(materialId) {
  if (!state.deckDoc || state.deckMaterialId !== materialId) return;
  const slide = storedPageFor(materialId, state.deckDoc.numPages);
  if (slide > 1) {
    markPositionEstablished(materialId);
    scrollDeckToPage(slide, { behavior: 'auto' });
  }
}

/* Restore the reader to where he was, on project open: the last-active
   tab + source at its stored page/slide. Anything stale — a source that
   no longer exists, a page past the end — falls back to the PDF tab at
   page 1, and the project still opens. The flag guards the save while
   the restore scroll is in flight (a fresh load starts at the top). */
async function restoreReadingPosition() {
  state.restoringPosition = true;
  try {
    if (String(state.project?.kind || '').toLowerCase() !== 'pdf') return;
    const stored = state.readingPosition;
    if (stored.activeTab === 'slides') {
      const target = resolveAnchorTarget(stored.activeSource, state.materials);
      if (target.target === 'material' && target.kind === 'slides') {
        // Pre-seed the deck choice so the Slides tab opens on the stored
        // deck instead of the chapter's deck (see setLeftTab/applyLeftTab),
        // and pin it to the current chapter so a later chapter click still
        // re-resolves the deck the usual way.
        state.deckMaterialId = target.id;
        state.deckChapter = state.activeChapter ?? null;
        setLeftTab('slides');
        await ensureDeckLoaded(target.id);
        if (state.deckDoc && state.deckMaterialId === target.id) {
          markPositionEstablished(target.id);
          scrollDeckToPage(storedPageFor(target.id, state.deckDoc.numPages), { behavior: 'auto' });
        }
        return;
      }
      // Stale deck: the source he was on no longer exists — fall back to
      // the PDF tab at page 1 (not the book's stored page, which belongs
      // to a different source he was not on).
      setLeftTab('pdf');
      await ensurePdfSourceLoaded(PAGE_ANCHOR_SOURCE_BOOK);
      if (state.pdfDoc) {
        markPositionEstablished(PAGE_ANCHOR_SOURCE_BOOK);
        scrollBookToPage(1, { behavior: 'auto' });
      }
      return;
    }
    if (stored.activeTab === 'preview') {
      setLeftTab('preview');
      return;
    }
    let sourceId = PAGE_ANCHOR_SOURCE_BOOK;
    const target = resolveAnchorTarget(stored.activeSource, state.materials);
    if (target.target === 'material' && target.kind === 'pdf') {
      sourceId = target.id;
    } else if (stored.activeSource !== PAGE_ANCHOR_SOURCE_BOOK) {
      // Stale PDF source (an extra PDF that no longer exists): page 1,
      // not the book's stored page.
      setLeftTab('pdf');
      await ensurePdfSourceLoaded(PAGE_ANCHOR_SOURCE_BOOK);
      if (state.pdfDoc) {
        markPositionEstablished(PAGE_ANCHOR_SOURCE_BOOK);
        scrollBookToPage(1, { behavior: 'auto' });
      }
      return;
    }
    setLeftTab('pdf');
    await ensurePdfSourceLoaded(sourceId);
    if (!state.pdfDoc) return; // the document failed to load — leave as is
    markPositionEstablished(sourceId);
    scrollBookToPage(storedPageFor(sourceId, state.pdfDoc.numPages), { behavior: 'auto' });
  } finally {
    state.restoringPosition = false;
  }
}

/* Apply the current panels + widths to the reader grid: the 7-column
   template, which panes are visible, which dividers are live, the
   Chapters button's pressed state, and the ✨ Ask AI toggle. A layout
   change re-measures the PDF pages (the containers change width) and
   re-fits the viewers at the new width. */
function applyReaderLayout({ save = true } = {}) {
  const reader = $('#reader', view);
  if (!reader) return;
  reader.style.gridTemplateColumns = gridTemplate(state.panels, state.widths);
  const show = (sel, visible) => {
    const el = $(sel, view);
    if (el) el.style.display = visible ? '' : 'none';
  };
  show('#chapter-panel', state.panels.nav);
  show('#reading-pane', state.panels.reading);
  const notebookWasHidden = $('#notebook-pane', view)?.style.display === 'none';
  show('#notebook-pane', state.panels.notebook);
  show('#ai-column', state.panels.ai);
  // Cell editors measure 0 while hidden; re-fit them the moment the
  // working pane comes back into view (preset / panel toggle).
  if (state.panels.notebook && notebookWasHidden) fitCellEditors();
  const dividerVisible = {
    'divider-nav': state.panels.nav && state.panels.reading,
    'divider-reading': state.panels.reading && state.panels.notebook,
    'divider-ai': state.panels.notebook && state.panels.ai,
  };
  Object.entries(dividerVisible).forEach(([id, visible]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
  });
  const chBtn = $('#chapter-toggle', view);
  if (chBtn) chBtn.setAttribute('aria-pressed', state.panels.nav ? 'true' : 'false');
  const aiTop = $('#ai-toggle-top', view);
  if (aiTop) aiTop.classList.toggle('active', state.panels.ai);
  if (state.pdfDoc) measurePdfPages();
  if (state.deckDoc) measureDeckPages();
  renderAiColumn();
  if (state.pdfContainer) scheduleRefit(state.pdfContainer, 60);
  if (state.deckContainer) scheduleRefit(state.deckContainer, 60);
  if (save) saveReaderLayout();
}

/* Apply a preset's panels (Reading / Navigation / Notetaking / AI). The mode only
   changes which panes are visible — the chapter, page, active tabs and
   selection survive. */
function applyLayoutPreset(name) {
  if (!LAYOUT_PRESETS[name]) return;
  state.panels = { ...LAYOUT_PRESETS[name] };
  state.layoutMode = name;
  applyReaderLayout();
}

/* Set panels directly (checklist, Chapters button, Ask AI toggle). The
   mode label follows: the matching preset name, or 'custom'. */
function updatePanels(next) {
  state.panels = { ...next };
  state.layoutMode = matchPreset(state.panels) || 'custom';
  applyReaderLayout();
}

/* The ✨ Ask AI toggle and the AI column's × are the same action: show
   the AI panel (with the working pane, like the AI preset) or hide it. */
function toggleAiPanel() {
  if (state.panels.ai) {
    updatePanels({ ...state.panels, ai: false });
  } else {
    updatePanels({ ...state.panels, notebook: true, ai: true });
  }
}

/* Draggable divider (AV ResizableContainer pattern, without the docking
   system: resize only). Pointer drag on the 7px gutter; the widths are
   applied live and persisted on release. */
function bindDivider(div, key) {
  if (!div) return;
  div.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = { ...state.widths };
    const readingEl = $('.reading-pane', view);
    const notebookEl = $('.notebook-pane', view);
    const total = (readingEl?.getBoundingClientRect().width || 0)
      + (notebookEl?.getBoundingClientRect().width || 0);
    const startReadingPx = readingEl?.getBoundingClientRect().width || 0;
    div.classList.add('dragging');
    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (key === 'nav') {
        state.widths.nav = clampNavWidth(start.nav + dx);
      } else if (key === 'ai') {
        state.widths.ai = clampAiWidth(start.ai - dx);
      } else {
        const s = splitReadingNotebook(startReadingPx + dx, total);
        state.widths.readingFr = s.readingFr;
        state.widths.notebookFr = s.notebookFr;
      }
      applyReaderLayout({ save: false });
      if (state.pdfContainer) scheduleRefit(state.pdfContainer, 60);
      if (state.deckContainer) scheduleRefit(state.deckContainer, 60);
    };
    const up = () => {
      div.classList.remove('dragging');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      saveReaderLayout();
      if (state.pdfContainer) scheduleRefit(state.pdfContainer, 0);
      if (state.deckContainer) scheduleRefit(state.deckContainer, 0);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}

/* ---------------- floating menus (Layout menu, + menu) ---------------- */

// One floating menu at a time, fixed-positioned under its anchor button
// (the AV's LayoutsMenu does the same — the header clips overflow, so an
// in-flow absolute popover would be cut off). Closes on outside click or
// Escape; repositioned to stay inside the viewport.
let floatingMenu = null;

function closeFloatingMenu() {
  if (!floatingMenu) return;
  floatingMenu.el.remove();
  document.removeEventListener('pointerdown', floatingMenu.onOutside, true);
  document.removeEventListener('keydown', floatingMenu.onKey, true);
  floatingMenu = null;
}

function showFloatingMenu(anchorEl, el) {
  closeFloatingMenu();
  document.body.appendChild(el);
  const rect = anchorEl.getBoundingClientRect();
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let left = Math.min(rect.left, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = rect.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 4);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  const onOutside = (e) => {
    if (!el.contains(e.target) && !anchorEl.contains(e.target)) closeFloatingMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeFloatingMenu(); }
  };
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  floatingMenu = { el, anchor: anchorEl, onOutside, onKey };
  return el;
}

/* The Layout menu (AV LayoutsMenu pattern): three preset cards with
   miniature split diagrams, plus a Panels checklist to show/hide
   individual panes — so a hidden panel can be restored without picking
   a whole preset. No custom saved layouts (the AV's "+ Save Current
   Layout" is out of scope here). */
function openLayoutMenu(anchorBtn) {
  if (floatingMenu?.anchor === anchorBtn) { closeFloatingMenu(); return; }
  const el = document.createElement('div');
  el.className = 'floating-menu layout-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', 'Layout');
  // Mini split diagrams: nav is the narrow dark strip, AI the narrow
  // accent strip; reading/working are the wide cells. Reading is one
  // wide cell alone.
  const diagrams = {
    reading: [''],
    navigation: ['nav', ''],
    notetaking: ['', ''],
    ai: ['', '', 'ai'],
  };
  const names = { reading: 'Reading', navigation: 'Navigation', notetaking: 'Notetaking', ai: 'AI' };
  const panelKeys = ['nav', 'reading', 'notebook', 'ai'];
  const render = () => {
    el.innerHTML = `
      <div class="layout-grid">
        ${LAYOUT_PRESET_NAMES.map((name) => `
          <div class="layout-card${state.layoutMode === name ? ' active' : ''}" data-layout-preset="${name}" role="menuitem" tabindex="0">
            <div class="layout-diagram">
              ${diagrams[name].map((cls) => `<div class="layout-cell${cls ? ` ${cls}` : ''}"></div>`).join('')}
            </div>
            <div class="layout-card-name">${names[name]}</div>
          </div>`).join('')}
      </div>
      <div class="menu-section">Panels</div>
      <div class="layout-panels">
        ${panelKeys.map((key) => `
          <label class="layout-panel-row">
            <input type="checkbox" data-panel="${key}" ${state.panels[key] ? 'checked' : ''}>
            <span>${{ nav: 'Chapters', reading: 'Reading pane', notebook: 'Working pane', ai: 'AI panel' }[key]}</span>
          </label>`).join('')}
      </div>`;
    $$('.layout-card', el).forEach((card) => {
      const pick = () => { applyLayoutPreset(card.dataset.layoutPreset); closeFloatingMenu(); };
      card.addEventListener('click', pick);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
    $$('.layout-panel-row input', el).forEach((box) => {
      box.addEventListener('change', () => {
        updatePanels({ ...state.panels, [box.dataset.panel]: box.checked });
        render(); // refresh the active-card highlight; the menu stays open
      });
    });
  };
  render();
  showFloatingMenu(anchorBtn, el);
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
    materialId,
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
    // scroll position; the preview renders a markdown note the user picks
    // (the master notes.md by default).
    pane.innerHTML = `
      <div class="reading-tabs" id="reading-tabs" role="tablist" aria-label="Reading">
        <button type="button" class="reading-tab${state.leftTab === 'pdf' ? ' active' : ''}" data-left-tab="pdf" role="tab">PDF</button>
        <button type="button" class="reading-tab${state.leftTab === 'slides' ? ' active' : ''}" data-left-tab="slides" role="tab">Slides</button>
        <button type="button" class="reading-tab${state.leftTab === 'preview' ? ' active' : ''}" data-left-tab="preview" role="tab">Markdown preview</button>
      </div>
      <div class="reading-tab-panels">
        <div class="reading-tab-panel" id="panel-pdf" ${state.leftTab === 'pdf' ? '' : 'hidden'}>
          <div class="picker-row picker-row-dark" id="pdf-picker-row" hidden>
            <label>PDF <select id="pdf-picker" aria-label="PDF document"></select></label>
            <button type="button" id="pdf-add-material-btn" class="mini-btn" title="Add a PDF, Word or PowerPoint file to this project">＋ Add</button>
          </div>
          <div class="picker-row picker-row-dark" id="pdf-zoom-row">
            ${zoomControlsHtml('pdf')}
            ${annotToolsHtml()}
          </div>
          <div class="reading-scroll" id="pdf-scroll"><p class="reading-note">Loading PDF…</p></div>
        </div>
        <div class="reading-tab-panel" id="panel-slides" ${state.leftTab === 'slides' ? '' : 'hidden'}>
          <div class="deck-picker-row">
            <label>Deck <select id="deck-picker" aria-label="Slide deck"></select></label>
            <span class="deck-page-indicator" id="deck-page-indicator"></span>
            <button type="button" id="deck-add-material-btn" class="mini-btn" title="Add a PDF, Word or PowerPoint file to this project">＋ Add</button>
            ${zoomControlsHtml('deck')}
            ${annotToolsHtml()}
          </div>
          <div class="reading-scroll" id="deck-scroll"><p class="reading-note">${state.materials.length ? 'Open the Slides tab to read a deck.' : 'No slide decks in this project.'}</p></div>
        </div>
        <div class="reading-tab-panel" id="panel-preview" ${state.leftTab === 'preview' ? '' : 'hidden'}>
          <div class="picker-row picker-row-paper" id="preview-picker-row">
            <label>Note <select id="preview-note-picker" aria-label="Note to preview"></select></label>
            <button type="button" id="preview-export-btn" class="mini-btn" title="Download the note being previewed">Export</button>
          </div>
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
    const deckAddBtn = $('#deck-add-material-btn', pane);
    if (deckAddBtn) deckAddBtn.addEventListener('click', promptAddMaterial);
    syncPdfPicker();
    $('#pdf-picker', pane).addEventListener('change', (e) => {
      ensurePdfSourceLoaded(e.target.value === 'book' ? PAGE_ANCHOR_SOURCE_BOOK : e.target.value);
    });
    const pdfAddBtn = $('#pdf-add-material-btn', pane);
    if (pdfAddBtn) pdfAddBtn.addEventListener('click', promptAddMaterial);
    syncPreviewNotePicker();
    $('#preview-note-picker', pane).addEventListener('change', (e) => {
      state.previewNoteName = e.target.value || null;
      renderLeftPreview();
    });
    $('#preview-export-btn', pane).addEventListener('click', exportPreviewedNote);
    bindZoomControls(pane);
    bindAnnotTools(pane);
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
    pane.innerHTML = `
      <div class="picker-row picker-row-dark" id="slides-zoom-row">
        ${zoomControlsHtml('slides')}
        <span class="zoom-hint">Google Slides embed — zoom is a visual scale</span>
      </div>
      <div class="slides-wrap" id="slides-wrap"><iframe src="${esc(embed)}" title="Slides"
      allowfullscreen></iframe></div>`;
    bindZoomControls(pane);
    applySlidesZoom();
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

/* Fill the PDF picker (Book + extra PDF materials); the row shows only
   when the project has extra PDFs — a single-book project looks exactly
   as before. Called on pane render, on source change and after a material
   is added. */
function syncPdfPicker() {
  const row = $('#pdf-picker-row', view);
  const sel = $('#pdf-picker', view);
  if (!row || !sel) return;
  const extras = pdfMaterialsList();
  row.hidden = extras.length === 0;
  if (extras.length === 0) return;
  const current = state.pdfSourceId || PAGE_ANCHOR_SOURCE_BOOK;
  sel.innerHTML = `<option value="book"${current === PAGE_ANCHOR_SOURCE_BOOK ? ' selected' : ''}>Book (PDF)</option>`
    + extras.map((m) => `<option value="${esc(m.id)}"${m.id === current ? ' selected' : ''}>${esc(m.label || m.id)}</option>`).join('');
}

/* Add a material to this project: a PDF, Word or PowerPoint file. The
   file picker opens from the ＋ button in a picker row; the server stores
   it (Word/PowerPoint convert lazily) and the pickers refresh. */
function promptAddMaterial() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,.docx,.doc,.pptx,.ppt';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    await addMaterialFile(file);
  });
  input.click();
}

async function addMaterialFile(file) {
  const form = new FormData();
  form.append('file', file);
  try {
    const created = await api(`/api/projects/${encodeURIComponent(state.project.slug)}/materials`, { method: 'POST', body: form });
    const materials = await apiGet(`/api/projects/${encodeURIComponent(state.project.slug)}/materials`);
    state.materials = Array.isArray(materials) ? materials : [];
    syncDeckPicker();
    syncPdfPicker();
    setSaveStatus(`Added “${created?.label || file.name}” — open it from the picker.`);
  } catch (err) {
    setSaveStatus(err.message, 'error');
  }
}

/* Switch the left (reading) tab. The deck loads lazily on first Slides
   open; the preview renders on open. The tab also drives activeSourceId
   (pdf/preview -> the book, slides -> the deck) so the chapter panel's
   source note and the AI context line follow it. */
function setLeftTab(tab) {
  if (!['pdf', 'slides', 'preview'].includes(tab)) return;
  state.leftTab = tab;
  state.activeSourceId = tab === 'slides'
    ? state.deckMaterialId
    : (tab === 'pdf' && state.pdfSourceId && state.pdfSourceId !== PAGE_ANCHOR_SOURCE_BOOK ? state.pdfSourceId : null);
  applyLeftTab();
  renderChapterPanel();
  updateAiContext();
  // The tab switch itself is a position change even when no scroll event
  // fires (e.g. returning to a tab whose container never moved).
  saveReadingPosition();
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
  if (state.leftTab === 'pdf') {
    measurePdfPages();
    if (state.pdfContainer) scheduleRefit(state.pdfContainer, 60);
  }
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
    if (state.deckContainer) scheduleRefit(state.deckContainer, 60);
  }
  if (state.leftTab === 'preview') {
    syncPreviewNotePicker();
    renderLeftPreview({ follow: true });
  }
  updateZoomLabels();
}

/* ---------------- zoom ---------------- */

// Compact zoom controls (same "no big buttons" direction as the rest of
// this round): − / % / + / Fit on one slim row per viewer. PDF pages
// re-render at the zoom scale — never a CSS stretch of a rendered canvas
// (see mountPdfViewer). Zoom is a multiplier on the width-fitting scale:
// 1 = fit width, 1.25 = 125%, and so on. Per source, per session.
function zoomControlsHtml(key) {
  return `
    <span class="zoom-controls" data-zoom-key="${key}">
      <button type="button" class="zoom-btn" data-zoom-out title="Zoom out (Ctrl+-)">−</button>
      <button type="button" class="zoom-pct" data-zoom-pct title="Zoom — click to fit width">${zoomPercent(state.zoom[key] ?? 1)}%</button>
      <button type="button" class="zoom-btn" data-zoom-in title="Zoom in (Ctrl++)">+</button>
      <button type="button" class="zoom-btn zoom-fit" data-zoom-fit title="Fit width (Ctrl+0)">Fit</button>
    </span>`;
}

/* One delegated click handler per reading pane covers every zoom row in
   it (PDF row, deck row, Slides row). */
function bindZoomControls(root) {
  if (!root || root.dataset.zoomBound) return;
  root.dataset.zoomBound = '1';
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-zoom-in], [data-zoom-out], [data-zoom-fit], [data-zoom-pct]');
    if (!btn) return;
    const wrap = btn.closest('[data-zoom-key]');
    if (!wrap) return;
    const key = wrap.dataset.zoomKey;
    if (btn.hasAttribute('data-zoom-in')) setZoom(key, zoomStep(state.zoom[key], 1), { immediate: true });
    else if (btn.hasAttribute('data-zoom-out')) setZoom(key, zoomStep(state.zoom[key], -1), { immediate: true });
    else setZoom(key, 1, { immediate: true }); // Fit, or the % label — both reset to fit width
  });
}

function updateZoomLabels() {
  $$('[data-zoom-pct]', view).forEach((el) => {
    const key = el.closest('[data-zoom-key]')?.dataset.zoomKey;
    if (key) el.textContent = `${zoomPercent(state.zoom[key] ?? 1)}%`;
  });
}

/* Which viewer the zoom shortcuts / wheel act on right now: the active
   left tab for PDF projects, the Slides embed for slides projects. The
   Preview tab has nothing to zoom. */
function activeZoomKey() {
  if (String(state.project?.kind || '').toLowerCase() === 'slides') return 'slides';
  if (String(state.project?.kind || '').toLowerCase() !== 'pdf') return null;
  if (state.leftTab === 'pdf') return 'pdf';
  if (state.leftTab === 'slides') return 'deck';
  return null;
}

function setZoom(key, value, { immediate = false } = {}) {
  if (!['pdf', 'deck', 'slides'].includes(key)) return;
  state.zoom[key] = clampZoom(value);
  updateZoomLabels();
  if (key === 'slides') {
    applySlidesZoom();
    return;
  }
  const container = key === 'deck' ? state.deckContainer : state.pdfContainer;
  if (container) scheduleRefit(container, immediate ? 0 : 120);
}

/* Google Slides embed (kind 'slides'): there is no re-renderable document,
   so zoom is a visual scale on the iframe — the iframe's layout size
   shrinks to 1/zoom and a transform scales it back up, so the content
   renders larger inside the same wrapper. Honest limit: the embed keeps
   its own internal resolution; this is not a true re-render like the
   pdf.js viewers. */
function applySlidesZoom() {
  const wrap = $('#slides-wrap', view);
  if (!wrap) return;
  const iframe = $('iframe', wrap);
  if (!iframe) return;
  const z = state.zoom.slides ?? 1;
  if (z === 1) {
    iframe.style.width = '';
    iframe.style.height = '';
    iframe.style.transform = '';
    return;
  }
  iframe.style.width = `${100 / z}%`;
  iframe.style.height = `${100 / z}%`;
  iframe.style.transform = `scale(${z})`;
  iframe.style.transformOrigin = '0 0';
}

// A pane-width change re-fits the PDF viewers at the new width (resize
// drag, layout switch, tab return). Debounced, and a no-op when the width
// (and therefore the scale) has not moved — the ResizeObserver also fires
// on mount, so the guard matters.
const pdfResizeObserver = new ResizeObserver((entries) => {
  entries.forEach((entry) => scheduleRefit(entry.target, 120));
});

const refitTimers = new WeakMap();
function scheduleRefit(container, delay = 120) {
  if (!container) return;
  const prev = refitTimers.get(container);
  if (prev) clearTimeout(prev);
  refitTimers.set(container, setTimeout(() => {
    refitTimers.delete(container);
    refitPdfViewer(container);
  }, delay));
}

function pdfScrollAnchor(container, zoomKey) {
  const pages = zoomKey === 'deck' ? state.deckPages : state.pdfPages;
  const mount = container._pdfMount;
  const pageH = mount?.pageH || 1;
  let page = 1;
  const y = container.scrollTop + 80;
  for (const pg of pages) {
    if (pg.top <= y) page = pg.num;
    else break;
  }
  const pg = pages.find((p) => p.num === page);
  const fraction = pg ? Math.min(1, Math.max(0, (container.scrollTop - pg.top) / pageH)) : 0;
  return { page, fraction };
}

// Refit one viewer, serialized per container so rapid drags cannot
// interleave two re-mounts of the same element.
function refitPdfViewer(container) {
  const prev = container._pdfRefit || Promise.resolve();
  const next = prev.then(() => refitPdfViewerInner(container)).catch(() => {});
  container._pdfRefit = next;
  return next;
}

async function refitPdfViewerInner(container) {
  const mount = container._pdfMount;
  if (!mount || !container.isConnected) return;
  if (!container.getClientRects().length) return; // hidden tab — nothing to fit
  const newWidth = container.clientWidth;
  const newScale = fitScale(Math.max(200, newWidth - 32), mount.pageWpt)
    * (state.zoom[mount.zoomKey] ?? 1);
  if (Math.abs(newWidth - mount.width) <= 4 && Math.abs(newScale - mount.scale) < 0.01) return;
  const anchor = pdfScrollAnchor(container, mount.zoomKey);
  await mountPdfViewer(container, mount.pdf, {
    measure: mount.measure, onScroll: mount.onScroll, zoomKey: mount.zoomKey,
    sourceId: mount.sourceId,
  });
  // mountPdfViewer re-measures; restore the anchored page + fraction.
  const pages = mount.zoomKey === 'deck' ? state.deckPages : state.pdfPages;
  const pg = pages.find((p) => p.num === anchor.page);
  const pageH = container._pdfMount?.pageH || mount.pageH;
  if (pg) container.scrollTop = Math.max(0, pg.top - 8 + anchor.fraction * pageH);
}

/* ---------------- PDF annotations ---------------- */

// Highlight (drag a rectangle) + note pin (click to drop a pin with
// text). No freehand in this round. Stored per project in annotations.json
// (see src/annotations.js + src/server.js), rendered as an overlay layer
// on the pdf.js page holders — never baked into the PDF file. Coordinates
// are normalized (0..1 of the page box), so highlights and pins survive
// pane resizes, refits and zooms. Deck slides are PDFs too, so the same
// mechanism applies there (source = the deck material id); the Google
// Slides iframe cannot be annotated and gets no tools.
const ANNOT_COLORS = ['yellow', 'green', 'pink', 'blue'];
const ANNOT_COLOR_HEX = { yellow: '#eab308', green: '#16a34a', pink: '#db2777', blue: '#2563eb' };
let annotDrag = null; // in-flight highlight drag {container, holder, sourceId, page, startX, startY, rect, ghost}

async function loadAnnotations() {
  try {
    const data = await apiGet(`/api/projects/${encodeURIComponent(state.project.slug)}/annotations`);
    state.annotations = Array.isArray(data?.annotations) ? data.annotations : [];
  } catch {
    state.annotations = [];
  }
}

async function createAnnotation(fields) {
  const res = await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/annotations`, 'POST', fields);
  if (res?.annotation) {
    state.annotations.push(res.annotation);
    refreshAnnotOverlays();
    return res.annotation;
  }
  return null;
}

async function updateAnnotation(id, patch) {
  const res = await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/annotations/${encodeURIComponent(id)}`, 'PUT', patch);
  if (res?.annotation) {
    const i = state.annotations.findIndex((a) => a.id === id);
    if (i !== -1) state.annotations[i] = res.annotation;
    refreshAnnotOverlays();
    return res.annotation;
  }
  return null;
}

async function deleteAnnotation(id) {
  // No body: apiJson would send JSON 'null', which Express's strict JSON
  // parser rejects with 400.
  await api(`/api/projects/${encodeURIComponent(state.project.slug)}/annotations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.annotations = state.annotations.filter((a) => a.id !== id);
  if (state.selectedAnnotationId === id) closeAnnotEditor();
  refreshAnnotOverlays();
}

/* Compact annotation tools (same "no big buttons" direction as the rest
   of this round): Highlight / Note / Erase toggles + a color dot that
   cycles the highlight color. One group per PDF viewer row (book + deck);
   both reflect the same tool state. */
function annotToolsHtml() {
  return `
    <span class="annot-tools">
      <button type="button" class="zoom-btn annot-tool-btn" data-annot-tool="highlight" title="Highlight — drag a rectangle on the page">🖍</button>
      <button type="button" class="zoom-btn annot-tool-btn" data-annot-tool="note" title="Note pin — click to drop a pin with text">📍</button>
      <button type="button" class="zoom-btn annot-tool-btn" data-annot-tool="erase" title="Erase — click an annotation to delete it">⌫</button>
      <button type="button" class="annot-color-dot" data-annot-color title="Highlight color — click to cycle">●</button>
    </span>`;
}

function bindAnnotTools(root) {
  if (!root || root.dataset.annotBound) return;
  root.dataset.annotBound = '1';
  root.addEventListener('click', (e) => {
    const toolBtn = e.target.closest('[data-annot-tool]');
    if (toolBtn) {
      const tool = toolBtn.dataset.annotTool;
      setAnnotTool(state.annotTool === tool ? null : tool);
      return;
    }
    if (e.target.closest('[data-annot-color]')) cycleAnnotColor();
  });
}

function syncAnnotTools() {
  $$('[data-annot-tool]', view).forEach((b) => {
    b.classList.toggle('active', b.dataset.annotTool === state.annotTool);
  });
  $$('[data-annot-color]', view).forEach((b) => {
    b.style.color = ANNOT_COLOR_HEX[state.annotColor] || ANNOT_COLOR_HEX.yellow;
    b.title = `Highlight color: ${state.annotColor} — click to cycle`;
  });
}

function setAnnotTool(tool) {
  state.annotTool = tool || null;
  closeAnnotEditor();
  refreshAnnotOverlays();
}

function cycleAnnotColor() {
  const i = ANNOT_COLORS.indexOf(state.annotColor);
  state.annotColor = ANNOT_COLORS[(i + 1) % ANNOT_COLORS.length];
  syncAnnotTools();
}

/* Rebuild the overlay layers of one viewer from state.annotations.
   Each .pdf-page holder gets one .annot-layer (created once, kept across
   re-renders); the layer's children are rebuilt from the annotations for
   that source + page. The layer only takes pointer events while a tool
   is active — otherwise clicks pass through to the page and only the
   pins (pointer-events auto) stay clickable. */
function renderAnnotOverlays(container) {
  const mount = container._pdfMount;
  if (!mount) return;
  const sourceId = mount.sourceId || 'book';
  const byPage = new Map();
  for (const a of state.annotations) {
    if (a.source !== sourceId) continue;
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page).push(a);
  }
  container.querySelectorAll('.pdf-page').forEach((holder) => {
    const page = Number(holder.dataset.page);
    let layer = holder.querySelector('.annot-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'annot-layer';
      holder.appendChild(layer);
      layer.addEventListener('pointerdown', (e) => onAnnotLayerPointerDown(e, container, layer));
      layer.addEventListener('click', (e) => onAnnotLayerClick(e, container, layer));
    }
    layer.innerHTML = '';
    layer.classList.toggle('annot-tool-active', !!state.annotTool);
    layer.dataset.tool = state.annotTool || '';
    for (const a of byPage.get(page) || []) {
      if (a.type === 'highlight') {
        const el = document.createElement('div');
        el.className = 'annot-highlight';
        el.dataset.annotId = a.id;
        el.dataset.color = a.color || 'yellow';
        el.style.left = `${a.rect.x * 100}%`;
        el.style.top = `${a.rect.y * 100}%`;
        el.style.width = `${a.rect.w * 100}%`;
        el.style.height = `${a.rect.h * 100}%`;
        layer.appendChild(el);
      } else {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'annot-pin';
        el.dataset.annotId = a.id;
        el.dataset.color = a.color || 'yellow';
        el.style.left = `${a.rect.x * 100}%`;
        el.style.top = `${a.rect.y * 100}%`;
        el.title = a.text ? a.text : 'Note — click to edit';
        el.setAttribute('aria-label', a.text ? `Note: ${a.text}` : 'Note pin');
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          openAnnotEditor(a);
        });
        layer.appendChild(el);
      }
    }
  });
  repositionAnnotEditor();
}

function refreshAnnotOverlays() {
  if (state.pdfContainer) renderAnnotOverlays(state.pdfContainer);
  if (state.deckContainer) renderAnnotOverlays(state.deckContainer);
  syncAnnotTools();
}

/* Highlight drag: pointerdown starts it on the layer (only while the
   highlight tool is active); a document-level move/up pair tracks it so
   the drag survives leaving the page. A drag under 6px in either
   dimension is an accidental click, not a highlight. */
function onAnnotLayerPointerDown(e, container, layer) {
  if (state.annotTool !== 'highlight') return;
  const holder = layer.closest('.pdf-page');
  if (!holder) return;
  e.preventDefault();
  const r = holder.getBoundingClientRect();
  const startX = (e.clientX - r.left) / r.width;
  const startY = (e.clientY - r.top) / r.height;
  const ghost = document.createElement('div');
  ghost.className = 'annot-highlight annot-ghost';
  ghost.dataset.color = state.annotColor;
  layer.appendChild(ghost);
  annotDrag = {
    container, layer, holder,
    sourceId: container._pdfMount?.sourceId || 'book',
    page: Number(holder.dataset.page), startX, startY, rect: null, ghost,
  };
  const move = (ev) => {
    if (!annotDrag) return;
    const hr = annotDrag.holder.getBoundingClientRect();
    const cx = Math.min(1, Math.max(0, (ev.clientX - hr.left) / hr.width));
    const cy = Math.min(1, Math.max(0, (ev.clientY - hr.top) / hr.height));
    const x = Math.min(annotDrag.startX, cx);
    const y = Math.min(annotDrag.startY, cy);
    const w = Math.abs(cx - annotDrag.startX);
    const h = Math.abs(cy - annotDrag.startY);
    annotDrag.rect = { x, y, w, h };
    Object.assign(annotDrag.ghost.style, {
      left: `${x * 100}%`, top: `${y * 100}%`,
      width: `${w * 100}%`, height: `${h * 100}%`,
    });
  };
  const up = async (ev) => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    const d = annotDrag;
    annotDrag = null;
    if (!d) return;
    move(ev);
    const rect = d.rect || { x: d.startX, y: d.startY, w: 0, h: 0 };
    const hr = d.holder.getBoundingClientRect();
    d.ghost.remove();
    if (rect.w * hr.width < 6 || rect.h * hr.height < 6) return;
    try {
      await createAnnotation({
        source: d.sourceId, page: d.page, type: 'highlight',
        rect, color: state.annotColor,
      });
    } catch (err) {
      window.alert(`Could not save the highlight: ${err.message}`);
    }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

/* Layer click: note tool drops a pin (and opens its editor); erase deletes
   the annotation under the cursor; with no tool the layer never receives
   the click (pins handle their own clicks). */
async function onAnnotLayerClick(e, container, layer) {
  const holder = layer.closest('.pdf-page');
  if (!holder) return;
  const tool = state.annotTool;
  if (tool === 'erase') {
    const el = e.target.closest('[data-annot-id]');
    if (!el) return;
    try {
      await deleteAnnotation(el.dataset.annotId);
    } catch (err) {
      window.alert(`Could not delete the annotation: ${err.message}`);
    }
    return;
  }
  if (tool !== 'note') return;
  const r = holder.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  try {
    const a = await createAnnotation({
      source: container._pdfMount?.sourceId || 'book',
      page: Number(holder.dataset.page), type: 'note',
      rect: { x, y, w: 0, h: 0 }, color: state.annotColor, text: '',
    });
    if (a) openAnnotEditor(a);
  } catch (err) {
    window.alert(`Could not save the note: ${err.message}`);
  }
}

/* The pin editor: a small popover positioned over the pin, inside the
   scroll container so it scrolls with the page. It is NOT a child of the
   overlay layer, so overlay re-renders (refit, tool change) never destroy
   it — it is repositioned instead. */
function openAnnotEditor(annotation) {
  closeAnnotEditor();
  state.selectedAnnotationId = annotation.id;
  const container = annotation.source === 'book' ? state.pdfContainer : state.deckContainer;
  if (!container) return;
  const holder = container.querySelector(`.pdf-page[data-page="${annotation.page}"]`);
  if (!holder) return;
  const editor = document.createElement('div');
  editor.className = 'annot-editor';
  editor.dataset.annotId = annotation.id;
  const ta = document.createElement('textarea');
  ta.value = annotation.text || '';
  ta.placeholder = 'Note…';
  ta.rows = 3;
  ta.setAttribute('aria-label', 'Note text');
  const row = document.createElement('div');
  row.className = 'annot-editor-row';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'mini-btn';
  save.textContent = 'Save';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'mini-btn annot-del';
  del.textContent = 'Delete';
  row.append(save, del);
  editor.append(ta, row);
  editor.addEventListener('pointerdown', (e) => e.stopPropagation());
  save.addEventListener('click', async () => {
    try {
      await updateAnnotation(annotation.id, { text: ta.value });
      closeAnnotEditor();
    } catch (err) {
      window.alert(`Could not save the note: ${err.message}`);
    }
  });
  del.addEventListener('click', async () => {
    try {
      await deleteAnnotation(annotation.id);
    } catch (err) {
      window.alert(`Could not delete the note: ${err.message}`);
    }
  });
  container.appendChild(editor);
  positionAnnotEditor(editor, annotation, holder, container);
  ta.focus();
}

function positionAnnotEditor(editor, annotation, holder, container) {
  const hr = holder.getBoundingClientRect();
  const cr = container.getBoundingClientRect();
  const x = hr.left - cr.left + container.scrollLeft + annotation.rect.x * hr.width;
  const y = hr.top - cr.top + container.scrollTop + annotation.rect.y * hr.height;
  const w = Math.min(240, container.clientWidth - 16);
  editor.style.width = `${w}px`;
  editor.style.left = `${Math.min(Math.max(8, x - 12), Math.max(8, container.clientWidth - w - 8))}px`;
  editor.style.top = `${y + 16}px`;
}

function repositionAnnotEditor() {
  const editor = $('.annot-editor', view);
  if (!editor) return;
  const a = state.annotations.find((x) => x.id === state.selectedAnnotationId);
  if (!a) { closeAnnotEditor(); return; }
  const container = a.source === 'book' ? state.pdfContainer : state.deckContainer;
  if (!container) { closeAnnotEditor(); return; }
  const holder = container.querySelector(`.pdf-page[data-page="${a.page}"]`);
  if (!holder) { closeAnnotEditor(); return; }
  if (editor.parentElement !== container) container.appendChild(editor);
  positionAnnotEditor(editor, a, holder, container);
}

function closeAnnotEditor() {
  state.selectedAnnotationId = null;
  const editor = $('.annot-editor', view);
  if (editor) editor.remove();
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
  return { sourceId: state.pdfSourceId || PAGE_ANCHOR_SOURCE_BOOK, page: currentPdfPage() };
}

/* Jump the LEFT pane to an anchored page/slide (chip click). Resolves the
   anchor's source — book, deck, or any extra PDF material — switches to
   the right tab, loads the material when needed, and scrolls there. A
   missing or unreadable source reports instead of failing silently. */
async function jumpToAnchor(sourceId, page) {
  if (String(state.project?.kind || '').toLowerCase() !== 'pdf') return;
  const target = resolveAnchorTarget(sourceId);
  if (target.target === 'book') {
    setLeftTab('pdf');
    await ensurePdfSourceLoaded(PAGE_ANCHOR_SOURCE_BOOK);
    scrollBookToPage(page);
    return;
  }
  if (target.target === 'material' && target.kind === 'slides') {
    setLeftTab('slides');
    await ensureDeckLoaded(target.id);
    if (!state.deckDoc || state.deckMaterialId !== target.id) {
      setSaveStatus('Can’t open that deck — its file is not in this project.', 'error');
      return;
    }
    scrollDeckToPage(page);
    return;
  }
  if (target.target === 'material' && target.kind === 'pdf') {
    setLeftTab('pdf');
    await ensurePdfSourceLoaded(target.id);
    if (!state.pdfDoc || state.pdfSourceId !== target.id) {
      setSaveStatus('Can’t open that document — its file is not in this project.', 'error');
      return;
    }
    scrollBookToPage(page);
    return;
  }
  setSaveStatus(`Can’t jump — “${sourceId}” is not in this project.`, 'error');
}

/* Scroll the book container to a page, with the same scroll-spy
   suppression as a chapter click (see setActiveChapter). Restores pass
   behavior 'auto' — the reader should land, not watch a flight. */
function scrollBookToPage(page, { behavior = 'smooth' } = {}) {
  const container = state.pdfContainer;
  if (!container) return;
  measurePdfPages();
  const pg = state.pdfPages.find((p) => p.num === page);
  if (!pg) return;
  const top = Math.max(0, pg.top - 8);
  state.suppressSpyUntil = Date.now() + 3000;
  state.suppressSpyPage = page;
  state.suppressSpyTop = top;
  container.scrollTo({ top, behavior });
}

function scrollDeckToPage(page, { behavior = 'smooth' } = {}) {
  const container = state.deckContainer;
  if (!container) return;
  measureDeckPages();
  const pg = state.deckPages.find((p) => p.num === page);
  if (!pg) return;
  container.scrollTo({ top: Math.max(0, pg.top - 8), behavior });
}

/* ---------------- PDF ---------------- */

async function loadPdf(fileUrl, sourceUrl, sourceId = 'book') {
  const container = $('#pdf-scroll', view);
  if (!container) return;
  // Load token: a source switch while a big document is still fetching
  // starts a newer load; the older one must abandon its work instead of
  // mounting over the newer document, writing an error into its
  // container, or resetting its scroll.
  const myToken = ++pdfLoadToken;
  state.pdfContainer = container;
  state.pdfSourceId = sourceId;
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
    if (myToken !== pdfLoadToken) return; // superseded — the newer load owns the container now
    container.innerHTML = `<p class="reading-note">Could not load this PDF: ${esc(err.message)}</p>`;
    // No readable document: clear the outline so the chapter panel falls
    // back to the note headings as navigation (same as a slide deck).
    state.outline = [];
    renderChapterPanel();
    return;
  }
  if (myToken !== pdfLoadToken) { try { pdf.destroy(); } catch { /* ignore */ } return; }
  state.pdfDoc = pdf;

  // Outline (chapters) — resolve each destination to a page number.
  try {
    const outline = await pdf.getOutline();
    state.outline = await flattenOutline(pdf, outline || []);
  } catch {
    state.outline = [];
  }
  renderChapterPanel();

  await mountPdfViewer(container, pdf, {
    measure: measurePdfPages, onScroll: onPdfScroll, zoomKey: 'pdf', sourceId,
    isCurrent: () => myToken === pdfLoadToken,
  });
  if (myToken !== pdfLoadToken) return; // superseded mid-mount — leave the newer load's scroll alone

  // A source switch reloads the container: the old document's scroll offset
  // must not carry over numerically into the new one (it would land on
  // whatever page sits at that offset — e.g. p. 2 of the book after leaving
  // a 3-page memo at p. 2). A fresh load always starts at the top.
  container.scrollTop = 0;

  // Lazy cover: first page rendered small, posted once per open.
  if (!state.project.cover && !state.coverGenerated) {
    state.coverGenerated = true;
    generateCover(pdf);
  }
  onPdfScroll();
}

/* Load a PDF into the PDF tab: the book, or an extra PDF material.
   Mirrors ensureDeckLoaded (one in-flight load, skip when already loaded).
   Switching PDFs reloads the container, so the scroll position of the
   previous PDF is not kept — the book and the decks keep theirs because
   they live in separate containers. */
let pdfLoadPromise = null; // {sourceId, promise} — one in-flight PDF load
let pdfLoadToken = 0; // increments per loadPdf call; a stale load abandons its work (see loadPdf)

async function ensurePdfSourceLoaded(sourceId) {
  const id = sourceId || PAGE_ANCHOR_SOURCE_BOOK;
  if (state.pdfDoc && state.pdfSourceId === id) return;
  if (pdfLoadPromise && pdfLoadPromise.sourceId === id) {
    await pdfLoadPromise.promise;
    return;
  }
  pdfLoadPromise = { sourceId: id, promise: loadPdfSource(id) };
  try {
    await pdfLoadPromise.promise;
  } finally {
    if (pdfLoadPromise?.sourceId === id) pdfLoadPromise = null;
  }
}

async function loadPdfSource(sourceId) {
  // A source switch reloads the container at the top, and loadPdf's
  // trailing onPdfScroll would save page 1 and clobber the stored
  // position — so the load + restore run under the restore guard, and
  // the source returns to the page it was left on.
  state.restoringPosition = true;
  try {
    if (sourceId === PAGE_ANCHOR_SOURCE_BOOK) {
      await loadPdf(
        `/api/projects/${encodeURIComponent(state.project.slug)}/file`,
        state.project.url || state.project.sourceUrl || '',
        PAGE_ANCHOR_SOURCE_BOOK,
      );
    } else {
      const mat = state.materials.find((m) => String(m.id) === String(sourceId));
      if (!mat || mat.hasFile === false) {
        setSaveStatus(`Can’t open “${mat?.label || sourceId}” — its file is not in this project.`, 'error');
        return;
      }
      await loadPdf(
        `/api/projects/${encodeURIComponent(state.project.slug)}/materials/${encodeURIComponent(sourceId)}/file`,
        '',
        sourceId,
      );
    }
    restorePdfSourcePosition(sourceId);
  } finally {
    state.restoringPosition = false;
  }
  // The chapter panel's source note and the AI context line follow the
  // newly loaded PDF (same as loadDeckPdf for decks).
  state.activeSourceId = sourceId === PAGE_ANCHOR_SOURCE_BOOK ? null : sourceId;
  syncPdfPicker();
  renderChapterPanel();
  updateAiContext();
}

/* Shared PDF viewer mounting: one placeholder per page, canvases render
   lazily near the viewport (IntersectionObserver), scroll events throttled
   through requestAnimationFrame. Used by the book (loadPdf) and by slide
   decks (loadDeckPdf) so both tabs keep their own scroll position. */
/* Shared PDF viewer mounting: one placeholder per page, canvases render
   lazily near the viewport (IntersectionObserver), scroll events throttled
   through requestAnimationFrame. Used by the book (loadPdf) and by slide
   decks (loadDeckPdf) so both tabs keep their own scroll position.
   The scale is WIDTH-FITTING: the container's usable width over page 1's
   width in points, times the zoom multiplier (1 = fit width). A pane
   resize or a zoom change re-mounts at the new scale (see refitPdfViewer)
   — pages re-render, never CSS-stretched. */
async function mountPdfViewer(container, pdf, { measure, onScroll, zoomKey = 'pdf', sourceId = 'book', isCurrent = () => true }) {
  const page = await pdf.getPage(1);
  // A newer load started while this one was fetching: do not clear the
  // container — the newer load owns it now (see the load tokens).
  if (!isCurrent()) return;
  const pageWpt = page.getViewport({ scale: 1 }).width;
  const scale = fitScale(Math.max(200, container.clientWidth - 32), pageWpt)
    * (state.zoom[zoomKey] ?? 1);
  const vp = page.getViewport({ scale });
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
  // The re-fit record: what refitPdfViewer needs to decide whether the
  // width/scale moved and to rebuild at the new size.
  container._pdfMount = {
    pdf, measure, onScroll, zoomKey, sourceId, pageWpt, pageW, pageH,
    width: container.clientWidth, scale,
  };
  renderAnnotOverlays(container);

  const renderPage = async (holder) => {
    if (holder.dataset.rendered) return;
    holder.dataset.rendered = '1';
    try {
      const pg = await pdf.getPage(Number(holder.dataset.page));
      const viewport = pg.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const num = $('.page-num', holder);
      holder.insertBefore(canvas, num);
      await pg.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      // The canvas exists in the DOM while pdf.js is still painting it, so
      // the Screenshot button needs a finished-render flag, not just the
      // canvas: an unfinished canvas reads back blank white.
      holder.dataset.renderDone = '1';
    } catch {
      delete holder.dataset.rendered;
      delete holder.dataset.renderDone;
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
  // replaced on every deck load (see loadDeckPdf). The zoom listeners
  // ride along: Ctrl/Cmd+wheel (the trackpad pinch arrives as wheel
  // events with ctrlKey set in Chrome — and in Safari, which additionally
  // fires gesture events) zooms the document, never the whole page.
  // The wheel listener is non-passive so preventDefault can stop the
  // browser's own pinch-zoom; touch-action (CSS) keeps touch scrolling
  // while the browser stays out of touch pinch-zoom.
  if (!container.dataset.scrollBound) {
    container.dataset.scrollBound = '1';
    let ticking = false;
    container.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; onScroll({ fromEvent: true }); });
    }, { passive: true });
    container.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(zoomKey, zoomFromWheel(state.zoom[zoomKey] ?? 1, e.deltaY), { immediate: false });
    }, { passive: false });
    let gestureStartZoom = 1;
    container.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      gestureStartZoom = state.zoom[zoomKey] ?? 1;
    });
    container.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      setZoom(zoomKey, zoomFromGesture(gestureStartZoom, e.scale || 1), { immediate: false });
    });
    container.addEventListener('gestureend', (e) => { e.preventDefault(); });
  }
  pdfResizeObserver.observe(container);
}

/* Load a slide deck into the Slides tab's own container (the book PDF is
   never unloaded). The deck keeps its own document, page offsets and scroll
   position; it never touches the chapter panel (the panel stays the book's
   outline) or the scroll-spy. */
let deckLoadPromise = null; // {materialId, promise} — one in-flight deck load
let deckLoadToken = 0; // increments per loadDeckPdf call; a stale load abandons its work (see loadDeckPdf)
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
  // Load token (same as loadPdf): a deck switch while a deck is still
  // fetching starts a newer load; the older one abandons its work.
  const myToken = ++deckLoadToken;
  // Replace the container so a re-mount never stacks scroll listeners on
  // the same element (mountPdfViewer binds them once per element). The
  // clone carries the data-scroll-bound flag as an attribute — drop it so
  // the fresh element gets its own listener.
  const fresh = container.cloneNode(false);
  delete fresh.dataset.scrollBound;
  container.replaceWith(fresh);
  state.deckContainer = fresh;
  state.deckMaterialId = materialId;
  // The context line (and the chapter panel's source note) follow the
  // newly chosen deck at once — the label resolves from state.materials,
  // so this does not wait for the async PDF load below.
  state.activeSourceId = materialId;
  updateAiContext();
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
    if (myToken !== deckLoadToken) return; // superseded — the newer load owns the container now
    fresh.innerHTML = `<p class="reading-note">Could not load this deck: ${esc(err.message)}</p>`;
    return;
  }
  if (myToken !== deckLoadToken) { try { pdf.destroy(); } catch { /* ignore */ } return; }
  state.deckDoc = pdf;
  await mountPdfViewer(fresh, pdf, {
    measure: measureDeckPages, onScroll: onDeckScroll, zoomKey: 'deck', sourceId: materialId,
    isCurrent: () => myToken === deckLoadToken,
  });
  if (myToken !== deckLoadToken) return; // superseded mid-mount — leave the newer load's scroll alone
  // The container is rebuilt at the top on every deck switch: return to
  // the slide this deck was left on (nothing stored -> stay on slide 1).
  restoreDeckPosition(materialId);
  // The Slides tab may have opened before the load finished; the chapter
  // panel's source note and the AI context line follow the loaded deck.
  if (state.leftTab === 'slides') {
    state.activeSourceId = materialId;
    renderChapterPanel();
    updateAiContext();
  }
  syncDeckPicker();
  updateDeckPageIndicator();
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
function onDeckScroll({ fromEvent = false } = {}) {
  if (fromEvent) markPositionEstablished(state.deckMaterialId);
  updateDeckPageIndicator();
  updateAiContext();
  saveReadingPosition();
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
  // never a subsection (depth 1+): subsections have no notes.md section,
  // so settling on one would strand note-follow, page anchors and AI
  // context ("Momentum" at p.100 instead of "Fitting models"). Entries
  // with a chapterMap match (a ## heading in notes.md) are the chapters;
  // front matter (Preface, Acknowledgements) and appendices (Notation,
  // Bibliography, Index) are skipped. When the map is empty — e.g. an
  // uploaded PDF whose headings never matched — any depth-0 entry counts.
  // Before the first chapter (cover / front matter) the first chapter is
  // current, so the note/AI context is never empty on the opening pages.
  const map = state.chapterMap || {};
  const mapped = state.outline.filter((ch) => ch.depth === 0 && ch.page != null
    && Object.prototype.hasOwnProperty.call(map, normalizeHeading(ch.title)));
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

function onPdfScroll({ fromEvent = false } = {}) {
  // Record the page even when the outline is empty (an outline-less PDF
  // still has pages worth anchoring to) — the spy below needs the outline.
  noteReadingImpression();
  // Only a real scroll event establishes the position: the direct call
  // at the end of loadPdf runs on a fresh mount sitting at the top, and
  // saving that would clobber the stored page before it is restored.
  if (fromEvent) markPositionEstablished(state.pdfSourceId);
  saveReadingPosition();
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
  // The index counts ## headings only (h2Headings): ### sub-headings must
  // not shift it — see h2Headings.
  // Chapters resolve against notes.md's headings (the master), never the
  // open note's — notes.md never opens in the editor.
  const h2 = h2Headings(notesMdHeadings());
  const override = state.chapterMap[normalizeHeading(chapter.title)];
  if (typeof override === 'number' && h2[override]) {
    return h2[override];
  }
  return matchHeading(chapter.title, h2);
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
    // The manual chapterMap override ("Link to a note heading…") lives
    // behind the Edit links toggle: off by default the panel is clean
    // chapter rows; on, every row gets its dropdown, with the currently
    // resolved heading (override or auto-match) pre-selected so the mode
    // is a real link editor — including for chapters whose auto-match is
    // wrong, which the old always-on dropdowns could never fix (they only
    // showed for unmatched chapters).
    const editLinks = state.editChapterLinks;
    panel.innerHTML = `<div class="chapter-head"><h2>Chapters</h2>
      <button type="button" id="edit-links-toggle" class="chapter-edit-toggle${editLinks ? ' active' : ''}"
        aria-pressed="${editLinks}" title="Show the chapter → note heading link dropdowns">✎ Edit links</button></div>${sourceNote}` + state.outline.map((ch, i) => {
      const matched = resolvedChapterHeading(ch);
      const isActive = state.activeChapter === normalizeHeading(ch.title);
      const indent = ch.depth ? ` style="padding-left:${16 + ch.depth * 14}px"` : '';
      let row = `<button type="button" class="chapter-row${isActive ? ' active' : ''}"
          data-chapter="${i}"${indent}>${esc(ch.title)}${ch.page != null ? `<span class="chapter-page">p. ${ch.page}</span>` : ''}</button>`;
      if (editLinks) {
        const h2 = h2Headings(notesMdHeadings());
        const matchedIdx = matched ? h2.findIndex((h) => h.norm === matched.norm) : -1;
        row += `<div class="chapter-link">
          <select data-link-chapter="${i}" aria-label="Link chapter to a note heading">
            <option value="">Link to a note heading…</option>
            ${h2.map((h, hi) => `<option value="${hi}"${hi === matchedIdx ? ' selected' : ''}>${esc(h.text)}</option>`).join('')}
          </select>
        </div>`;
      }
      return row;
    }).join('');

    $('#edit-links-toggle', panel)?.addEventListener('click', () => {
      state.editChapterLinks = !state.editChapterLinks;
      renderChapterPanel();
    });

    $$('.chapter-row', panel).forEach((btn) => {
      btn.addEventListener('click', () => {
        const ch = state.outline[Number(btn.dataset.chapter)];
        setActiveChapter(ch, { scrollNotebook: true, scrollPdf: true });
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

  // No PDF outline (or not a PDF): the master note's ## headings are the nav.
  const headings = notesMdHeadings();
  panel.innerHTML = `<h2>${kind === 'pdf' ? 'Headings' : 'Notes'}</h2>${sourceNote}` +
    (headings.length
      ? headings.map((h, i) => `
          <button type="button" class="chapter-row${state.activeChapter === h.norm ? ' active' : ''}"
            data-heading="${i}">${esc(h.text)}</button>`).join('')
      : `<p class="chapter-empty">No headings yet — add a <code>## Heading</code>
         to your note and it will show up here as navigation.</p>`);
  $$('.chapter-row', panel).forEach((btn) => {
    btn.addEventListener('click', () => {
      const h = headings[Number(btn.dataset.heading)];
      state.activeChapter = h.norm;
      $$('.chapter-row', panel).forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      scrollNotebookToHeading(h);
    });
  });
}

function setActiveChapter(chapter, { scrollNotebook = false, scrollPdf = false } = {}) {
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
  if (scrollNotebook) {
    const heading = resolvedChapterHeading(chapter);
    scrollNotebookToHeading(heading); // null -> leave the notebook alone
  }
  updateAiContext(); // keep the Ask AI panel's context line live
  followDeckToChapter(chapter);
  scrollLeftPreviewToChapter();
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

/* The Labs section never follows the chapter: the index lists the labs and
   the user chooses which one to open by clicking it. No chapter click,
   scroll-spy move, or tab change ever opens, switches, or expands a lab. */

/* Keep the cached notes.md text fresh (the left Preview tab renders from
   it when the active right tab is not notes.md). */
function syncNotesMdCache(text) {
  state.notesMdContent = typeof text === 'string' ? text : null;
}

/* Render the left Preview tab from notes.md: the active note's content
   when notes.md is open, else the cached text, fetched lazily. The preview
   keeps its scroll position across re-renders; with follow=true it scrolls
   to the current chapter once (tab open), never on content updates. */
/* The Preview tab's note picker (like the Slides tab's deck picker): the
   project's markdown notes, master notes.md included. The effective note
   is the manual pick, else the active markdown note, else the master. */
function mdNotes() {
  const notes = (state.notes || []).filter((n) => n.kind === 'md');
  notes.sort((a, b) => (a.name === 'notes.md' ? -1 : b.name === 'notes.md' ? 1 : a.name.localeCompare(b.name)));
  return notes;
}

/* The markdown notes Note AI Apply may write to: every .md note EXCEPT
   the master notes.md — notes.md is the read-only directory (preview
   only, never an editor tab), not a place AI writes into. */
function editableMdNotes() {
  return mdNotes().filter((n) => n.name !== 'notes.md');
}

/* Default Apply destination: the editable note open in the right pane,
   else the first editable note. Null when the project has no editable
   note — Apply is disabled then, never filed into notes.md. */
function defaultAiApplyDest() {
  const dests = editableMdNotes();
  if (state.activeTabKind === 'note' && state.activeNoteKind === 'md' && state.activeNoteName) {
    const open = dests.find((n) => n.name === state.activeNoteName);
    if (open) return open;
  }
  return dests[0] || null;
}

function previewNoteName() {
  const names = mdNotes().map((n) => n.name);
  if (state.previewNoteName && names.includes(state.previewNoteName)) {
    return state.previewNoteName;
  }
  if (state.activeNoteKind === 'md' && state.activeNoteName && names.includes(state.activeNoteName)) {
    return state.activeNoteName;
  }
  if (names.includes('notes.md')) return 'notes.md';
  return names[0] || null;
}

function syncPreviewNotePicker() {
  const sel = $('#preview-note-picker', view);
  if (!sel) return;
  const current = previewNoteName();
  sel.innerHTML = mdNotes().map((n) => (
    `<option value="${esc(n.name)}"${n.name === current ? ' selected' : ''}>${esc(n.name)}</option>`
  )).join('');
}

/* Fetch the previewed note's text: the live editor content when it is
   the active note, the notes.md cache when that is it, else the API. */
async function previewNoteText() {
  const name = previewNoteName();
  if (!name) return { name, text: '' };
  if (state.activeTabKind === 'note' && state.activeNoteName === name) {
    return { name, text: state.activeNoteContent };
  }
  if (name === 'notes.md' && state.notesMdContent != null) {
    return { name, text: state.notesMdContent };
  }
  try {
    const data = await apiGet(`/api/projects/${encodeURIComponent(state.project.slug)}/notes/${encodeURIComponent(name)}`);
    const text = typeof data === 'string' ? data : (data.content ?? '');
    if (name === 'notes.md') state.notesMdContent = text;
    return { name, text };
  } catch {
    return { name, text: '' };
  }
}

/* Download the note currently being previewed (the old toolbar Export
   notes, moved here next to the picker). Local assets/... images the note
   references are embedded as base64 data URIs, so the downloaded .md
   shows the images when opened elsewhere; external URLs stay as-is. */
async function exportPreviewedNote() {
  const { name, text } = await previewNoteText();
  if (!name) return;
  const embedded = await embedAssetsInMarkdown(text, async (file) => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(state.project.slug)}/assets/${encodeURIComponent(file)}`);
      if (!res.ok) return null;
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('read failed'));
        r.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  });
  downloadBlob(embedded, `${state.project.slug}-${name}`);
}

async function renderLeftPreview({ follow = false } = {}) {
  const el = $('#left-md-preview', view);
  if (!el) return;
  const { text } = await previewNoteText();
  renderMdPreview(el, text);
  if (follow) scrollLeftPreviewToChapter(false);
}

/* Scroll the left Preview tab to the current chapter's heading. */
function scrollLeftPreviewToChapter(smooth = true) {
  const scroll = $('#left-preview-scroll', view);
  const el = $('#left-md-preview', view);
  if (!scroll || !el) return;
  const ch = activeOutlineChapter();
  if (!ch) return;
  const heading = resolvedChapterHeading(ch);
  if (!heading) return;
  const target = el.querySelector(`[data-h="${CSS.escape(heading.norm)}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}

/* Scroll the notebook pane to a heading. Guards: never while the markdown
   editor textarea is focused (user typing). The Follow toggle is gone
   (toolbar removed 2026-11-11) — the scroll-spy follow itself stays
   always on, as it was by default.
   A heading with no match never scrolls the notebook: top-of-note is never a
   useful destination, so a null heading (or a heading with no element in the
   rendered note) leaves the notebook exactly where it is. */
function scrollNotebookToHeading(heading) {
  if (state.editorFocused) return;
  if (!heading) return;
  const body = $('.notebook-body', view);
  if (!body) return;

  if (state.activeNoteKind === 'ipynb') {
    const el = body.querySelector(`[data-h="${CSS.escape(heading.norm)}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  // Edit mode: scroll the textarea so the heading line is visible — but
  // only when the open note actually has that heading (chapters resolve
  // against notes.md, which never opens in the editor).
  const ta = $('.md-editor', body);
  if (!ta) return;
  const match = (state.headings || []).find((hh) => hh.norm === heading.norm);
  if (!match) return;
  const lines = ta.value.split('\n');
  const idx = Math.min(match.line ?? 0, lines.length - 1);
  const lineHeight = 22; // 13.5px font * 1.65 line-height
  ta.scrollTop = Math.max(0, idx * lineHeight - 40);
}

/* ---------------- notebook ---------------- */

/* The note the right pane opens by default: the first editable markdown
   note, else the first other note — never notes.md (read-only, preview
   only). Null when the project has no editable note. */
/* Fallback when the active note is closed or deleted: the first OPEN
   tab (a markdown note first) — a closed file is never re-opened
   behind his back. Null when no tab is open: the pane shows the Files
   directory instead. */
function defaultEditorNote() {
  const open = (state.notes || []).filter((n) => state.openNotes?.has(n.name));
  return open.find((n) => n.kind === 'md' && n.name !== 'notes.md')
    || open.find((n) => n.name !== 'notes.md')
    || null;
}

/* Open-tabs persistence (see openTabs.js): one localStorage entry per
   project. A failed write never blocks the UI. */
function readStoredOpenTabs() {
  try { return window.localStorage.getItem(openTabsKey(state.project.slug)); } catch { return null; }
}

function persistOpenTabs() {
  try {
    window.localStorage.setItem(openTabsKey(state.project.slug), serializeOpenTabs(state.openNotes));
  } catch { /* ignore */ }
}

/* How many tabs are open (owned notes + labs) — the Files directory
   shows by default when this is zero. */
function openTabCount() {
  return (state.openNotes?.size || 0) + (state.labTabs?.length || 0);
}

function filesVisible() {
  return state.showFiles || openTabCount() === 0;
}

/* No editable note is open: clear the editor state so the right pane
   shows its empty state (notes.md never opens here). */
function clearActiveNote() {
  state.activeTabKind = 'note';
  state.activeLab = null;
  state.activeNoteName = null;
  state.activeNoteKind = 'md';
  state.activeNoteContent = '';
  state.activeNotebook = null;
  state.headings = [];
}

async function loadNote(name) {
  // notes.md is read-only: it never opens in the right pane. Show it in
  // the left preview instead and leave the editor alone.
  if (name === 'notes.md') {
    state.previewNoteName = 'notes.md';
    renderLeftPreview();
    return;
  }
  const slug = state.project.slug;
  // Activation token: tab switches, opens and close-fallbacks all race
  // through this loader (each awaits a GET). The LAST requested
  // activation wins — an older one resolving late must not clobber the
  // newer active tab (a close's fallback load resolving after the user
  // already clicked another tab used to yank them back).
  const token = ++activationSeq;
  const data = await apiGet(`/api/projects/${encodeURIComponent(slug)}/notes/${encodeURIComponent(name)}`);
  if (token !== activationSeq) return; // superseded by a newer activation
  const content = typeof data === 'string' ? data : (data.content ?? '');
  state.activeTabKind = 'note';
  state.activeLab = null;
  state.activeNoteName = name;
  state.activeNoteKind = name.toLowerCase().endsWith('.ipynb') ? 'ipynb' : 'md';
  state.activeNoteContent = content;
  state.activeNotebook = null;
  if (name === 'notes.md') syncNotesMdCache(content);
  if (state.activeNoteKind === 'ipynb') {
    try { state.activeNotebook = JSON.parse(content || '{"cells":[]}'); }
    catch { state.activeNotebook = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }; }
    if (!Array.isArray(state.activeNotebook.cells)) state.activeNotebook.cells = [];
    state.headings = headingsFromNotebook(state.activeNotebook);
    resetExecCounter();
  } else {
    state.headings = headingsFromMarkdown(content);
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

/* Note rename/delete (AV TabContainer style). Tabs always display as
   plain labels; rename is entered explicitly with a double-click on
   the tab name. In rename mode the input looks exactly like the tab
   label — transparent, borderless, same font — and its width follows
   the name (AV AutosizeInput equivalent), so a long name is never cut
   off. Enter/blur commits, Escape cancels. Delete is two-click: the
   first click arms the tab's × for 2s, the second confirms. notes.md —
   the master filing home — has no tab at all, and the server refuses
   to rename or delete it. */
let armedNoteDelete = null;
let armedNoteDeleteTimer = 0;
/* Activation sequence for loadNote/loadLab (see loadNote): the latest
   requested activation wins over any earlier one still in flight. */
let activationSeq = 0;
let noteRenameSuppressed = false;
let renamingNoteName = null;
let paneRendering = false;
// True while renderNotebookPane is rebuilding the tab bar: a rename
// input focused at that moment is destroyed by the rebuild, and its
// blur fires synchronously inside the innerHTML assignment — that
// blur is a render artifact, not a user commit (see commitNoteRename).

function sizeNoteTabInput(input) {
  // Size the rename input to its text with a hidden mirror span in the
  // same font (AV's AutosizeInput does the same) — no fixed width, so
  // the name is never squeezed or cut off.
  let mirror = document.getElementById('note-tab-input-mirror');
  if (!mirror) {
    mirror = document.createElement('span');
    mirror.id = 'note-tab-input-mirror';
    mirror.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;top:-9999px;left:-9999px;';
    document.body.appendChild(mirror);
  }
  const cs = getComputedStyle(input);
  mirror.style.font = cs.font;
  mirror.textContent = input.value || 'x';
  input.style.width = `${mirror.offsetWidth + 2}px`;
}

function enterNoteRename(name) {
  renamingNoteName = name;
  renderNotebookPane(); // focus + selection happen at the end of the render
}

function suppressNoteRenameCommit() {
  // Clicking the tab's own × blurs the rename input; the delete intent
  // wins and the half-typed rename is dropped. The blur runs
  // synchronously inside this mousedown, so clear the flag next tick.
  noteRenameSuppressed = true;
  setTimeout(() => { noteRenameSuppressed = false; }, 0);
}

function cancelNoteRename(input) {
  renamingNoteName = null;
  input.dataset.done = '1';
  input.blur();
  renderNotebookPane();
}

async function commitNoteRename(oldName, input) {
  // Blur fired while the tab bar is being re-rendered (the input is
  // destroyed by the rebuild, e.g. the pending tab switch behind a
  // double-click on an inactive tab): not a user commit — leave rename
  // mode alone so the re-render restores the input. A disconnected
  // input is the same case (blur from removal, not from the user).
  if (paneRendering || !input.isConnected) return;
  renamingNoteName = null;
  if (input.dataset.done) return;
  input.dataset.done = '1';
  if (noteRenameSuppressed) return; // the delete click owns the next render
  const name = input.value.trim();
  if (!name || name === oldName) { renderNotebookPane(); return; }
  if (!name.toLowerCase().endsWith('.md')) {
    renderNotebookPane();
    setSaveStatus('Rename failed: the name must end with .md.', 'error');
    return;
  }
  if (state.notes.some((n) => n.name === name)) {
    renderNotebookPane();
    setSaveStatus(`Rename failed: ${name} already exists.`, 'error');
    return;
  }
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
  try {
    await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/notes/${encodeURIComponent(oldName)}/rename`, 'POST', { name });
  } catch (err) {
    renderNotebookPane();
    setSaveStatus(`Rename failed: ${err.message}`, 'error');
    return;
  }
  const entry = state.notes.find((n) => n.name === oldName);
  if (entry) entry.name = name;
  if (state.openNotes.has(oldName)) {
    state.openNotes.delete(oldName);
    state.openNotes.add(name);
    persistOpenTabs();
  }
  if (state.activeNoteName === oldName) state.activeNoteName = name;
  if (state.previewNoteName === oldName) state.previewNoteName = name;
  // Status last: renderNotebookPane rebuilds the tab bar (and with it
  // #save-status), so a message set before the render would be wiped.
  renderNotebookPane();
  renderChapterPanel();
  renderLeftPreview();
  setSaveStatus(`Renamed to ${name}.`);
}

function armNoteDelete(name) {
  if (armedNoteDelete !== name) {
    if (armedNoteDeleteTimer) window.clearTimeout(armedNoteDeleteTimer);
    armedNoteDelete = name;
    armedNoteDeleteTimer = window.setTimeout(() => {
      armedNoteDelete = null;
      renderNotebookPane();
    }, 2000);
    renderNotebookPane();
    return;
  }
  if (armedNoteDeleteTimer) window.clearTimeout(armedNoteDeleteTimer);
  armedNoteDelete = null;
  deleteNote(name);
}

async function deleteNote(name) {
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
  try {
    await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/notes/${encodeURIComponent(name)}`, 'DELETE');
  } catch (err) {
    renderNotebookPane();
    setSaveStatus(`Delete failed: ${err.message}`, 'error');
    return;
  }
  state.notes = state.notes.filter((n) => n.name !== name);
  state.openNotes.delete(name);
  persistOpenTabs();
  if (state.previewNoteName === name) state.previewNoteName = null;
  if (state.activeTabKind === 'note' && state.activeNoteName === name) {
    await activateFallbackTab();
  }
  // Status last: renderNotebookPane rebuilds the tab bar (and with it
  // #save-status), so a message set before the render would be wiped.
  renderNotebookPane();
  renderChapterPanel();
  renderLeftPreview();
  setSaveStatus(`Deleted ${name}.`);
}

function renderNotebookPane() {
  const pane = $('#notebook-pane', view);
  if (!pane) return;
  // A rename in progress for a note that no longer exists (deleted
  // elsewhere) leaves rename mode instead of rendering a stale input.
  if (renamingNoteName && !state.notes.some((n) => n.name === renamingNoteName)) renamingNoteName = null;
  // No toolbar row: the tab bar is on top, the editor/notebook directly
  // below. Preview lives in the left pane (picker + Export next to it),
  // Ask AI in the top bar, + Note here / new note / new notebook / labs
  // in the + menu, and everything autosaves (see renderNotebookBody and
  // saveNotebook) — so nothing needs a Save button.
  paneRendering = true;
  // The Files directory lives between the tab bar and the body when it
  // is toggled on — but with no tab open the empty body shows it
  // instead (one line, then the list), so it is never rendered twice.
  const showFilesPanel = filesVisible() && openTabCount() > 0;
  pane.innerHTML = `
    <div class="notebook-tabs" id="notebook-tabs"></div>
    ${showFilesPanel ? '<div class="files-panel" id="files-panel"></div>' : ''}
    <div class="notebook-body" id="notebook-body"></div>`;
  paneRendering = false;

  const tabs = $('#notebook-tabs', pane);
  state.notes.forEach((n) => {
    // notes.md is read-only: it has no editor tab (browse + preview it
    // from the left pane's Markdown preview picker). A note whose tab
    // was closed stays out of the bar until it is re-opened from Files.
    if (n.name === 'notes.md') return;
    if (!state.openNotes.has(n.name)) return;
    const isActive = state.activeTabKind === 'note' && n.name === state.activeNoteName;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `note-tab${isActive ? ' active' : ''}`;
    if (n.kind === 'md' && renamingNoteName === n.name) {
      // Rename mode (entered by double-click): a borderless input
      // styled exactly like the tab label; Enter/blur commits, Escape
      // cancels. It grows with the name as you type.
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'note-tab-input';
      input.value = n.name;
      input.title = 'Rename this note (Enter to confirm, Esc to cancel)';
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('input', () => sizeNoteTabInput(input));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); cancelNoteRename(input); }
      });
      input.addEventListener('blur', () => commitNoteRename(n.name, input));
      tab.appendChild(input);
    } else {
      tab.textContent = n.name;
      if (n.kind === 'md') tab.title = 'Double-click to rename';
    }
    // × only closes (hides) the tab — the file stays on disk and
    // re-opens from Files. Deleting a file lives in the Files directory
    // now (two-click arm there); a tab × never deletes anything.
    // Seeded labs were already close-only; owned notes/notebooks match
    // them now.
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.title = 'Close tab';
    close.addEventListener('mousedown', () => suppressNoteRenameCommit());
    close.addEventListener('click', (e) => { e.stopPropagation(); closeNoteTab(n.name); });
    tab.appendChild(close);
    tab.addEventListener('click', async () => {
      if (isActive) return;
      await loadNote(n.name);
      renderNotebookPane();
      renderChapterPanel();
    });
    tabs.appendChild(tab);
  });
  // Double-click a markdown tab name to rename (single-click still
  // switches). Delegated to the tab bar, not the tab: switching tabs
  // re-renders the bar between the two clicks of a double-click, so a
  // per-tab listener can miss the second click entirely — and when the
  // two clicks land on different elements the dblclick event itself
  // targets their common ancestor, so the tab is resolved from the
  // mouse position instead of the event target.
  tabs.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tab-close')) return; // that's the close ×
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const tabEl = under?.closest('.note-tab');
    if (!tabEl || tabEl.classList.contains('lab-tab')) return;
    const name = (tabEl.querySelector('input')?.value || tabEl.textContent || '')
      .replace(/Sure\?|✕/g, '').trim();
    const note = state.notes.find((n) => n.name === name);
    if (note?.kind === 'md') enterNoteRename(note.name);
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
  // The + button is just a +: it opens the chooser (new note, new
  // notebook per language, labs, Note here) — AV TabContainer style.
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'note-tab-add';
  addBtn.textContent = '+';
  addBtn.title = 'Add — note, notebook, lab, or a note at the current page';
  addBtn.addEventListener('click', (e) => { e.stopPropagation(); openAddMenu(addBtn); });
  tabs.appendChild(addBtn);
  // Files toggle: the directory (open / hide / delete) sits between the
  // tab bar and the body while it is on; with no tab open it shows by
  // default in the empty body instead.
  const filesBtn = document.createElement('button');
  filesBtn.type = 'button';
  filesBtn.className = `note-tab-files${filesVisible() ? ' active' : ''}`;
  filesBtn.textContent = 'Files';
  filesBtn.title = 'Show or hide the file list';
  filesBtn.setAttribute('aria-pressed', filesVisible() ? 'true' : 'false');
  filesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.showFiles = !state.showFiles;
    renderNotebookPane();
  });
  tabs.appendChild(filesBtn);
  // Autosave status lives at the right end of the tab bar.
  const status = document.createElement('span');
  status.className = 'save-status';
  status.id = 'save-status';
  tabs.appendChild(status);

  // A rename in progress survives a re-render (e.g. the pending tab
  // switch behind a double-click on an inactive tab recreates the
  // input) — put the focus back in it, text selected.
  if (renamingNoteName) {
    const input = $('.note-tab-input', tabs);
    if (input) { sizeNoteTabInput(input); input.focus(); input.select(); }
  }

  const filesPanel = $('#files-panel', pane);
  if (filesPanel) renderFilesList(filesPanel);

  renderNotebookBody();
}

/* ---------------- Files directory ---------------- */

/* Language tag for a notebook row: the + menu's create entries use the
   same words (Python / Java / JavaScript). Unknown metadata falls back
   to the raw value; null → no tag. */
const NB_LANG_TAG = { python: 'Python', java: 'Java', javascript: 'JavaScript' };

function filesSection(title) {
  const el = document.createElement('div');
  el.className = 'files-section';
  el.textContent = title;
  return el;
}

/* One directory row: the name opens the file (or focuses its tab), the
   tag names the kind (language / Master / Lab), and owned files get the
   two-click delete — the ONLY place a file can be deleted from.
   notes.md (Master) and labs never get a delete control. */
function filesRow({ label, title, tag, active, deletable, name, onOpen }) {
  const row = document.createElement('div');
  row.className = `files-row${active ? ' active' : ''}`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'files-row-name';
  btn.textContent = label;
  if (title) btn.title = title;
  btn.addEventListener('click', onOpen);
  row.appendChild(btn);
  if (tag) {
    const t = document.createElement('span');
    t.className = 'files-tag';
    t.textContent = tag;
    row.appendChild(t);
  }
  if (deletable) {
    const del = document.createElement('span');
    del.className = `files-del${armedNoteDelete === name ? ' armed' : ''}`;
    del.textContent = armedNoteDelete === name ? 'Sure?' : '✕';
    del.title = armedNoteDelete === name ? 'Click again to confirm delete' : 'Delete this file';
    del.addEventListener('click', (e) => { e.stopPropagation(); armNoteDelete(name); });
    row.appendChild(del);
  }
  return row;
}

function renderFilesList(host) {
  host.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'files-list';
  const mds = (state.notes || []).filter((n) => n.kind === 'md');
  if (mds.length) {
    list.appendChild(filesSection('Notes'));
    mds.forEach((n) => {
      list.appendChild(filesRow({
        label: n.name,
        tag: n.name === 'notes.md' ? 'Master' : null,
        active: state.activeTabKind === 'note' && state.activeNoteName === n.name,
        deletable: n.name !== 'notes.md',
        name: n.name,
        onOpen: () => openNoteFromDirectory(n.name),
      }));
    });
  }
  const nbs = (state.notes || []).filter((n) => n.kind === 'ipynb');
  if (nbs.length) {
    list.appendChild(filesSection('Notebooks'));
    nbs.forEach((n) => {
      list.appendChild(filesRow({
        label: n.name,
        tag: n.language ? (NB_LANG_TAG[String(n.language).toLowerCase()] || String(n.language)) : null,
        active: state.activeTabKind === 'note' && state.activeNoteName === n.name,
        deletable: true,
        name: n.name,
        onOpen: () => openNoteFromDirectory(n.name),
      }));
    });
  }
  if ((state.labs || []).length) {
    list.appendChild(filesSection('Labs'));
    state.labs.forEach((group) => {
      const files = Array.isArray(group.files) ? group.files : [];
      if (!files.length) return;
      const open = !!state.labsOpenChapters[group.chapter];
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'files-group-head';
      const headLabel = document.createElement('span');
      headLabel.textContent = `${open ? '▾' : '▸'} ${chapterDisplayName(group.chapter)}`;
      const headCount = document.createElement('span');
      headCount.className = 'files-count';
      headCount.textContent = String(files.length);
      head.append(headLabel, headCount);
      head.addEventListener('click', () => {
        state.labsOpenChapters[group.chapter] = !open;
        refreshFilesLists();
      });
      list.appendChild(head);
      if (open) {
        files.forEach((f) => {
          const isActive = state.activeTabKind === 'lab' && state.activeLab
            && state.activeLab.chapter === group.chapter && state.activeLab.name === f.name;
          list.appendChild(filesRow({
            label: labDisplayName(f.name),
            title: `${group.chapter}/${f.name}`,
            tag: 'Lab',
            active: isActive,
            deletable: false,
            name: f.name,
            onOpen: () => openLab(group.chapter, f.name),
          }));
        });
      }
    });
  }
  host.appendChild(list);
}

/* Re-fill every directory list in the DOM (the panel slot, or the empty
   body) without rebuilding the tab bar or the editor — used by the lab
   group toggle, so expanding a chapter never drops editor focus. */
function refreshFilesLists() {
  $$('.files-panel').forEach((host) => renderFilesList(host));
}

/* Open a file from the Files directory: add it to the open tabs (a
   closed tab re-opens), then load it — or do nothing when it is already
   the active tab. notes.md never opens in the editor: it shows in the
   left preview instead (loadNote handles that). */
async function openNoteFromDirectory(name) {
  if (state.activeTabKind === 'note' && state.activeNoteName === name) return;
  state.openNotes.add(name);
  persistOpenTabs();
  try {
    await loadNote(name);
  } catch (err) {
    state.openNotes.delete(name);
    persistOpenTabs();
    window.alert(`Could not open ${name}: ${err.message}`);
    return;
  }
  renderNotebookPane();
  renderChapterPanel();
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

/* The tab-bar + menu (AV TabContainer spirit: a bare + that opens a
   chooser): Note here, new markdown note, new notebooks — one per
   runnable language, since language is stored per notebook in metadata,
   so each kind is one click with no language prompt — and the lab index
   grouped by chapter with counts. Choosing a lab opens a new tab; the
   same lab twice focuses the existing tab. */
function openAddMenu(anchorBtn) {
  const reading = currentReadingPage();
  const readingKind = reading && reading.sourceId !== PAGE_ANCHOR_SOURCE_BOOK
    ? String((state.materials || []).find((m) => m.id === reading.sourceId)?.kind || '').toLowerCase()
    : null;
  const pageLabel = reading
    ? `Note here — at ${readingKind === 'slides' ? `slide ${reading.page}` : `p. ${reading.page}`}`
    : 'Note here — at current page';
  const menu = document.createElement('div');
  menu.className = 'floating-menu add-menu';
  const addSection = (title) => {
    const h = document.createElement('div');
    h.className = 'menu-section';
    h.textContent = title;
    menu.appendChild(h);
  };
  const addItem = ({ label, ext = '', disabled = false, hint = '', onClick }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.disabled = disabled;
    const l = document.createElement('span');
    l.textContent = label;
    const e = document.createElement('span');
    e.className = 'menu-ext';
    e.textContent = ext;
    b.append(l, e);
    if (hint) b.title = hint;
    b.addEventListener('click', () => { closeFloatingMenu(); onClick(); });
    menu.appendChild(b);
  };
  addSection('Add');
  addItem({
    label: pageLabel,
    disabled: !reading,
    hint: reading
      ? 'Anchor a note under the current chapter in notes.md'
      : 'No page here — switch to the PDF or Slides tab to anchor a note',
    onClick: addNoteAtCurrentPage,
  });
  addItem({ label: 'Markdown note', ext: '.md', onClick: createMdNote });
  addItem({ label: 'IPython notebook', ext: 'Python', onClick: () => createIpynbNote('python') });
  addItem({ label: 'Java notebook', ext: 'Java', onClick: () => createIpynbNote('java') });
  addItem({ label: 'JavaScript notebook', ext: 'JavaScript', onClick: () => createIpynbNote('javascript') });
  if (state.labs.length) {
    addSection('Labs');
    state.labs.forEach((group) => {
      const files = Array.isArray(group.files) ? group.files : [];
      if (!files.length) return;
      const open = !!state.labsOpenChapters[group.chapter];
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'menu-group-head';
      const headLabel = document.createElement('span');
      headLabel.textContent = `${open ? '▾' : '▸'} ${chapterDisplayName(group.chapter)}`;
      const headCount = document.createElement('span');
      headCount.className = 'menu-count';
      headCount.textContent = String(files.length);
      head.append(headLabel, headCount);
      head.addEventListener('click', () => {
        state.labsOpenChapters[group.chapter] = !open;
        closeFloatingMenu();
        openAddMenu(anchorBtn);
      });
      menu.appendChild(head);
      if (open) {
        files.forEach((f) => {
          const isOpen = state.labTabs.some((t) => t.chapter === group.chapter && t.name === f.name);
          const isActive = state.activeTabKind === 'lab' && state.activeLab
            && state.activeLab.chapter === group.chapter && state.activeLab.name === f.name;
          addItem({
            label: `${isOpen ? '● ' : ''}${labDisplayName(f.name)}`,
            ext: isActive ? 'active' : '',
            onClick: () => openLab(group.chapter, f.name),
          });
        });
      }
    });
  }
  showFloatingMenu(anchorBtn, menu);
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
  // Same activation token as loadNote: last requested wins.
  const token = ++activationSeq;
  const data = await apiGet(`/api/projects/${encodeURIComponent(slug)}/labs/${encodeURIComponent(chapter)}/${encodeURIComponent(name)}`);
  if (token !== activationSeq) return; // superseded by a newer activation
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
  resetExecCounter();
}

/* Flush the active editor's pending work before its tab closes: a
   debounced markdown save, or an open notebook cell session. A markdown
   cell's editor only copies its text into the cell on Done — a close
   must copy it first, or the typed text would be dropped with the tab.
   Blur already flushed most of this (code cells save on blur, the md
   editor schedules a save on blur); this covers the rest, and the saves
   are idempotent. */
async function flushActiveNoteEdits() {
  if (!state.activeNoteName) return;
  if (state.activeNoteKind === 'md') {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    await saveActiveMdNote(false);
    return;
  }
  if (state.activeNoteKind === 'ipynb' && state.activeNotebook) {
    const body = $('#notebook-body', view);
    if (body) {
      body.querySelectorAll('[data-md-editor]:not([hidden]) textarea').forEach((ta) => {
        const cell = state.activeNotebook.cells?.[Number(ta.dataset.cellIdx)];
        if (!cell) return;
        setNbCellSource(cell, ta.value);
        commitNbEdit(cell);
      });
    }
    commitAllNbEdits();
    await saveNotebook();
  }
}

/* After the active tab closes (or its file is deleted): activate the
   first remaining open tab — an owned note first, else a lab — or clear
   the pane when none is open. */
async function activateFallbackTab() {
  const def = defaultEditorNote();
  if (def) {
    try { await loadNote(def.name); return; } catch { /* fall through */ }
  }
  const lab = (state.labTabs || [])[0];
  if (lab) {
    try { await loadLab(lab.chapter, lab.name); return; } catch { /* fall through */ }
  }
  clearActiveNote();
}

/* Close (hide) an owned note's tab: the file stays on disk and re-opens
   from Files. The active tab's pending edits flush first, so closing
   never loses typed text. */
async function closeNoteTab(name) {
  const wasActive = state.activeTabKind === 'note' && state.activeNoteName === name;
  if (wasActive) await flushActiveNoteEdits();
  state.openNotes.delete(name);
  persistOpenTabs();
  if (!wasActive) { renderNotebookPane(); return; }
  await activateFallbackTab();
  renderNotebookPane();
  renderChapterPanel();
}

/* Close a lab tab: only hides it — the lab file stays on disk and
   re-opens from the Labs picker or the Files directory. */
async function closeLabTab(lab) {
  state.labTabs = state.labTabs.filter(
    (t) => !(t.chapter === lab.chapter && t.name === lab.name));
  const wasActive = state.activeTabKind === 'lab' && state.activeLab
    && state.activeLab.chapter === lab.chapter && state.activeLab.name === lab.name;
  if (!wasActive) { renderNotebookPane(); return; }
  await flushActiveNoteEdits();
  await activateFallbackTab();
  renderNotebookPane();
  renderChapterPanel();
}

/* Add a note anchored at the page being read: insert the anchor comment
   under the current chapter's ## heading in notes.md (end of the section;
   create the heading if missing — same rule as Ask AI Apply). notes.md is
   read-only, so nothing opens in the editor: the anchor is filed by the
   API and the left preview refreshes to show it. */
async function addNoteAtCurrentPage() {
  const reading = currentReadingPage();
  if (!reading) return;
  const ch = activeOutlineChapter();
  const heading = ch ? ch.title : 'AI notes';
  const anchor = formatPageAnchor({ page: reading.page, sourceId: reading.sourceId });
  const { inserted } = await insertIntoNotesMd(heading, anchor, chapterPageAnchor(ch));
  if (!inserted) {
    setSaveStatus('A note is already anchored here — nothing added.');
    return;
  }
  renderChapterPanel();
  renderLeftPreview();
  const material = reading.sourceId === PAGE_ANCHOR_SOURCE_BOOK
    ? null
    : (state.materials || []).find((m) => m.id === reading.sourceId) || null;
  setSaveStatus(`Note anchored at ${anchorChipLabel(reading, material)} in notes.md.`);
}

function setSaveStatus(text, cls = '') {
  const el = $('#save-status', view);
  if (el) { el.textContent = text; el.className = `save-status ${cls}`.trim(); }
}

/* Today's date as YYYY-MM-DD on the Vancouver day. */
function vancouverDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/* Insert a quick-action snippet at the editor cursor (see
   mdQuickActions.js). document.execCommand('insertText') keeps the
   insertion as one native undo step, so Ctrl/Cmd+Z takes it back; the
   input event it fires drives the autosave + live preview like typing. */
function insertMdQuickAction(ta, action, override = {}) {
  if (!ta) return;
  const start = ta.selectionStart ?? 0;
  const end = ta.selectionEnd ?? start;
  const opts = {};
  if (action === 'date') opts.date = vancouverDateStr();
  if (action === 'anchor') {
    if (override.anchor) {
      opts.anchor = override.anchor;
    } else {
      const reading = currentReadingPage();
      if (!reading) {
        setSaveStatus('No page to anchor to — open the book or a deck first.');
        return;
      }
      opts.anchor = formatPageAnchor(reading);
    }
  }
  let snip;
  try {
    snip = mdQuickSnippet(action, ta.value.slice(0, start), ta.value.slice(end), opts);
  } catch (err) {
    setSaveStatus(err.message, 'error');
    return;
  }
  ta.focus();
  ta.setSelectionRange(start, end);
  const done = document.execCommand('insertText', false, snip.text);
  if (!done) {
    ta.setRangeText(snip.text, start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  ta.setSelectionRange(start + snip.selStart, start + snip.selEnd);
  ta.focus();
}

/* Paste a screenshot into the markdown editor: the image uploads first
   (notes/assets/, content-hash named), then a small popup near the cursor
   offers [Append to note] (the reference at the END of the note) or
   [Copy markdown] (the `![...](assets/...)` code, shown so it can be
   copied by hand too). Nothing is inserted until he picks one — dismissing
   (Esc / click elsewhere / ×) inserts nothing, and the already-uploaded
   file stays in notes/assets/ as an orphan (harmless; a re-paste of the
   same screenshot reuses the same hash-named file). Text pastes have no
   image item and fall through to the default paste untouched. */
async function handleMdEditorPaste(ta, e) {
  const item = [...(e.clipboardData?.items || [])]
    .find((it) => it.type && it.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const file = item.getAsFile();
  if (!file) return;
  setSaveStatus('Uploading image…');
  let dataUrl;
  try {
    dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('could not read the image'));
      r.readAsDataURL(file);
    });
  } catch (err) {
    setSaveStatus(`Could not paste image: ${err.message}`, 'error');
    return;
  }
  await uploadImageAndShowMenu(ta, dataUrl, 'Could not paste image');
}

/* Upload an image data URL to notes/assets/ (content-hash named, deduped
   like a paste) and show the paste-image popup with its markdown code.
   Shared by paste, the Screenshot button and the file picker — one upload
   path, one popup. Returns the upload record, or null on failure (the
   status line already says what went wrong). */
async function uploadImageAndShowMenu(ta, dataUrl, errLabel) {
  let uploaded;
  try {
    uploaded = await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/assets`,
      'POST', { dataUrl });
  } catch (err) {
    setSaveStatus(`${errLabel}: ${err.message}`, 'error');
    return null;
  }
  setSaveStatus('Image uploaded.');
  showPasteImageMenu(ta, imageMarkdownRef(uploaded.fileName));
  return uploaded;
}

/* Shared by whole-page capture and region select: resolve the capturable
   canvas for the current left tab and wait for pdf.js to finish painting
   it. Returns { canvas, container }, or null after setting a status hint
   (no page / still loading — never a blank capture). */
async function getRenderedPageCanvas() {
  const target = resolveScreenshotTarget({
    kind: state.project?.kind,
    leftTab: state.leftTab,
    pdfPage: currentPdfPage(),
    deckPage: currentDeckPage(),
    hasPdfContainer: !!state.pdfContainer,
    hasDeckContainer: !!state.deckContainer,
  });
  if (target.error) {
    setSaveStatus('No page to capture — open a PDF page or slide first.');
    return null;
  }
  const container = target.container === 'deck' ? state.deckContainer : state.pdfContainer;
  // The canvas exists in the DOM while pdf.js is still painting it, so a
  // capture taken the instant a page/slide appears would read back blank
  // white. Wait briefly for the finished-render flag (covers a tab switch
  // or a scroll straight onto an unrendered page); if the page still
  // hasn't finished, say so instead of uploading a blank image.
  const holderSel = pageHolderSelector(target.page);
  const holder = () => container?.querySelector(holderSel);
  let rendered = false;
  for (let i = 0; i < 20 && !rendered; i++) {
    if (holder()?.dataset.renderDone) { rendered = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!rendered) {
    setSaveStatus(holder()
      ? 'Page still loading — try again in a moment.'
      : 'No page to capture — open a PDF page or slide first.');
    return null;
  }
  const canvas = container?.querySelector(pageCanvasSelector(target.page));
  if (!canvas || !canvas.width || !canvas.height) {
    setSaveStatus('No page to capture — open a PDF page or slide first.');
    return null;
  }
  return { canvas, container };
}

/* Crop one rectangle out of a rendered page canvas as a PNG data URL. */
function cropCanvasToDataUrl(canvas, { sx, sy, sw, sh }) {
  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out.toDataURL('image/png');
}

/* The editable markdown note's textarea, or null when no editable note is
   open (a notebook tab, or the notes.md-only empty state). The top-bar
   Screenshot button is global, so it resolves this at capture time, not
   at click time. */
function activeMdEditor() {
  return $('#md-editor', view) ?? null;
}

/* Screenshot callers pass either the editor textarea or a getter for it
   (the top-bar button resolves the open note at capture time). */
function resolveNoteTa(ta) {
  return typeof ta === 'function' ? ta() : ta;
}

/* Top-bar Screenshot: the button is global, so make sure there is a page
   to capture before entering region select — show the reading pane if a
   layout hid it, and move off the Markdown preview tab onto a PDF/slide
   tab when the project has one. Only a project with no capturable
   material at all still ends in the "No page to capture" hint. */
async function onTopbarScreenshot() {
  if (!state.panels.reading) {
    updatePanels({ ...state.panels, reading: true });
  }
  if (String(state.project?.kind || '').toLowerCase() === 'pdf'
    && state.leftTab !== 'pdf' && state.leftTab !== 'slides') {
    if (state.pdfContainer) setLeftTab('pdf');
    else if (state.deckContainer) setLeftTab('slides');
  }
  await enterRegionSelect(() => activeMdEditor());
}

/* Screenshot button (main click): macOS-style region select. A
   translucent overlay covers the reading pane; drag to draw the region,
   release to capture just that part of the current PDF page / deck
   slide (the canvas the reader already rendered — never re-rendered or
   re-fetched). The cropped PNG uploads through the same assets endpoint
   as paste, then shows the same popup (Append to note / Copy markdown).
   Esc, or a click without dragging, cancels — nothing uploaded. A
   selection outside the page, or too small, shows a status hint and
   uploads nothing. When the left pane shows no page canvas (video,
   YouTube, a Google Slides iframe, the Markdown preview tab, a page not
   rendered yet), a status hint and nothing else. */
async function enterRegionSelect(ta) {
  const got = await getRenderedPageCanvas();
  if (!got) return;
  const { canvas, container } = got;
  const paneRect = container.getBoundingClientRect();
  if (!paneRect.width || !paneRect.height) {
    setSaveStatus('No page to capture — open a PDF page or slide first.');
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'screenshot-select-overlay';
  overlay.style.left = `${paneRect.left}px`;
  overlay.style.top = `${paneRect.top}px`;
  overlay.style.width = `${paneRect.width}px`;
  overlay.style.height = `${paneRect.height}px`;
  overlay.innerHTML = `<div class="screenshot-select-hint">Drag to select a region — Esc to cancel</div>`;
  const rectEl = document.createElement('div');
  rectEl.className = 'screenshot-select-rect';
  rectEl.hidden = true;
  document.body.append(overlay, rectEl);
  let start = null;
  let sel = null;
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    rectEl.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    start = { x: e.clientX, y: e.clientY };
    sel = null;
    rectEl.hidden = true;
    try { overlay.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!start) return;
    sel = normalizeSelectionRect(start.x, start.y, e.clientX, e.clientY);
    rectEl.hidden = false;
    rectEl.style.left = `${sel.x}px`;
    rectEl.style.top = `${sel.y}px`;
    rectEl.style.width = `${sel.width}px`;
    rectEl.style.height = `${sel.height}px`;
  });
  const finish = async () => {
    if (!start) return;
    start = null;
    if (!sel || isClickSelection(sel)) { close(); return; } // a click, not a drag
    // Re-measure the canvas at release: the pane may have scrolled
    // mid-drag, and the crop maps viewport coordinates to pixels.
    const crop = cropRegionToCanvas({
      canvasRect: canvas.getBoundingClientRect(),
      canvasWidth: canvas.width, canvasHeight: canvas.height, sel,
    });
    close();
    if (crop.error === 'outside') {
      setSaveStatus('Selection is outside the page — drag inside the page.');
      return;
    }
    if (crop.error === 'too-small') {
      setSaveStatus('Selection too small — drag a larger region.');
      return;
    }
    let dataUrl;
    try {
      dataUrl = cropCanvasToDataUrl(canvas, crop);
    } catch {
      setSaveStatus('Could not capture this region.', 'error');
      return;
    }
    setSaveStatus('Uploading image…');
    await uploadImageAndShowMenu(resolveNoteTa(ta), dataUrl, 'Could not upload screenshot');
  };
  overlay.addEventListener('pointerup', finish);
  overlay.addEventListener('pointercancel', close);
}

/* The Screenshot chevron: "Choose image file…" — pick an existing PNG or
   JPEG from disk instead of capturing the current page; same upload +
   popup afterwards. */
function openScreenshotMenu(anchorBtn, ta) {
  if (floatingMenu?.anchor === anchorBtn) { closeFloatingMenu(); return; }
  const el = document.createElement('div');
  el.className = 'floating-menu impression-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', 'Screenshot options');
  el.innerHTML = `<button type="button" class="impression-row" data-screenshot-file role="menuitem">
      <span class="impression-label">Choose image file…</span></button>`;
  el.addEventListener('click', (e) => {
    if (!e.target.closest('[data-screenshot-file]')) return;
    closeFloatingMenu();
    openScreenshotFilePicker(ta);
  });
  showFloatingMenu(anchorBtn, el);
}

/* File picker behind the Screenshot chevron (same pattern as ＋ Add
   material): PNG/JPEG only; the server rejects anything else with a 400,
   surfaced here as a status error. Cancelling the picker does nothing. */
function openScreenshotFilePicker(ta) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g)$/.test(file.type || '')) {
      setSaveStatus('Choose a PNG or JPEG image.', 'error');
      return;
    }
    setSaveStatus('Uploading image…');
    let dataUrl;
    try {
      dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('could not read the image'));
        r.readAsDataURL(file);
      });
    } catch (err) {
      setSaveStatus(`Could not upload image: ${err.message}`, 'error');
      return;
    }
    await uploadImageAndShowMenu(resolveNoteTa(ta), dataUrl, 'Could not upload image');
  });
  input.click();
}

let pasteImageMenu = null;

function closePasteImageMenu() {
  if (!pasteImageMenu) return;
  pasteImageMenu.el.remove();
  document.removeEventListener('pointerdown', pasteImageMenu.onOutside, true);
  document.removeEventListener('keydown', pasteImageMenu.onKey, true);
  pasteImageMenu = null;
}

/* Caret position in viewport coordinates, via a mirror div (same font,
   padding, width as the textarea, text up to the caret + a marker span).
   Used to put the paste popup next to where he is typing. */
function textareaCaretPos(ta) {
  const rect = ta.getBoundingClientRect();
  const cs = getComputedStyle(ta);
  const div = document.createElement('div');
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  div.style.width = `${ta.clientWidth}px`;
  div.style.font = cs.font;
  div.style.padding = cs.padding;
  div.style.border = cs.border;
  div.style.lineHeight = cs.lineHeight;
  div.style.letterSpacing = cs.letterSpacing;
  div.textContent = ta.value.slice(0, ta.selectionStart ?? 0);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  div.appendChild(marker);
  document.body.appendChild(div);
  const x = rect.left + marker.offsetLeft - ta.scrollLeft;
  const y = rect.top + marker.offsetTop - ta.scrollTop;
  div.remove();
  return { x, y };
}

/* The paste-image popup: the markdown code (selected), Append to note /
   Copy markdown / ×. `ta` may be null when the image came from the
   top-bar Screenshot button with no editable note open — then there is
   nothing to append to: Append is disabled with a one-line hint, and
   Copy still works. Positioned near the caret when there is one, else
   top-right under the top bar. */
function showPasteImageMenu(ta, code) {
  closePasteImageMenu();
  const canAppend = !!ta && ta.isConnected;
  const el = document.createElement('div');
  el.className = 'floating-menu paste-image-menu';
  el.setAttribute('role', 'menu');
  el.innerHTML = `
    <input type="text" class="paste-image-code" readonly value="${esc(code)}" aria-label="Markdown for the pasted image">
    <div class="paste-image-actions">
      <button type="button" data-paste-action="append" ${canAppend ? '' : 'disabled'}>Append to note</button>
      <button type="button" data-paste-action="copy">Copy markdown</button>
      <button type="button" class="paste-image-close" data-paste-action="close" aria-label="Close">×</button>
    </div>
    ${canAppend ? '' : '<div class="paste-image-hint">Open a note to append</div>'}`;
  document.body.appendChild(el);
  // Near the caret, clamped to the viewport (below the line, or above it
  // when there is no room below); top-right under the top bar when there
  // is no editor caret to anchor to.
  const pos = canAppend ? textareaCaretPos(ta) : { x: window.innerWidth - 340, y: 56 };
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let left = Math.min(pos.x, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = pos.y + 24;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, pos.y - mh - 4);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  const codeInput = $('.paste-image-code', el);
  codeInput.addEventListener('click', () => codeInput.select());
  codeInput.addEventListener('focus', () => codeInput.select());
  const onOutside = (e) => { if (!el.contains(e.target)) closePasteImageMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePasteImageMenu(); } };
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  pasteImageMenu = { el, onOutside, onKey };
  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-paste-action]');
    if (!btn) return;
    const action = btn.dataset.pasteAction;
    if (action === 'close') { closePasteImageMenu(); return; }
    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(code);
        setSaveStatus('Markdown copied.');
        closePasteImageMenu();
      } catch {
        setSaveStatus('Copy failed — select the code above.', 'error');
      }
      return;
    }
    if (action === 'append') {
      if (!canAppend) return;
      closePasteImageMenu();
      appendImageToNote(ta, code);
    }
  });
  codeInput.focus();
  codeInput.select();
}

/* Append the image reference at the END of the note (one native undo
   step, so Ctrl/Cmd+Z takes it back; the input event it fires drives the
   autosave + live preview like typing). */
function appendImageToNote(ta, code) {
  const edit = appendImageEdit(ta.value, code);
  ta.focus();
  ta.setSelectionRange(edit.start, edit.end);
  const done = document.execCommand('insertText', false, edit.text);
  if (!done) {
    ta.setRangeText(edit.text, edit.start, edit.end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  ta.focus();
  setSaveStatus('Image appended to note.');
}

/* The Page anchor dropdown: pages/slides looked at in the last 5 minutes,
   most recent first. Clicking one inserts THAT anchor at the cursor; the
   main Page anchor button still inserts the current page. With no recent
   page at all, the menu says so instead of offering anything. */
function openAnchorImpressionsMenu(anchorBtn, ta) {
  if (floatingMenu?.anchor === anchorBtn) { closeFloatingMenu(); return; }
  const now = Date.now();
  const entries = recentImpressions(state.recentImpressions, now);
  const el = document.createElement('div');
  el.className = 'floating-menu impression-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', 'Recent pages');
  if (!entries.length) {
    el.innerHTML = '<div class="impression-empty">No page to anchor to</div>';
  } else {
    el.innerHTML = entries.map((entry, i) => `
      <button type="button" class="impression-row" data-impression="${i}" role="menuitem">
        <span class="impression-label">${esc(impressionLabel(entry, impressionMeta(entry)))}</span>
        <span class="impression-time">${esc(relativeTimeLabel(entry.at, now))}</span>
      </button>`).join('');
  }
  el.addEventListener('click', (e) => {
    const row = e.target.closest('[data-impression]');
    if (!row) return;
    const entry = entries[Number(row.dataset.impression)];
    if (!entry) return;
    closeFloatingMenu();
    insertMdQuickAction(ta, 'anchor', { anchor: formatPageAnchor(entry) });
  });
  showFloatingMenu(anchorBtn, el);
}

function renderNotebookBody() {
  const body = $('#notebook-body', view);
  if (!body) return;
  body.classList.remove('has-quick-actions'); // re-added below for md notes
  if (state.activeTabKind === 'note' && !state.activeNoteName) {
    // No editable note is open (notes.md never opens here): one line,
    // then the Files directory — the way back in. (With a tab open the
    // directory lives in its panel above the body instead, so the list
    // is never rendered twice.)
    body.innerHTML = `<div class="notebook-empty">No note open — pick a file below, or press + to create one.</div>${openTabCount() === 0 ? '<div class="files-panel" id="files-panel"></div>' : ''}`;
    const filesPanel = $('#files-panel', body);
    if (filesPanel) renderFilesList(filesPanel);
    return;
  }
  if (state.activeNoteKind === 'ipynb') {
    renderIpynbBody(body);
    return;
  }
  // Markdown notes are always edited here; the rendered preview lives in
  // the LEFT pane's Preview tab (pick the note there). One slim row of
  // quick actions sits above the editor — labels only, no prose.
  body.classList.add('has-quick-actions');
  // The Page anchor action is a split button: the main button inserts an
  // anchor for the current page; the chevron opens a dropdown of recent
  // pages. (Screenshot moved to the reader top bar — it is global now.)
  const splitBtn = (a, menuTitle, menuLabel) => `<span class="md-action-split"><button type="button" data-md-action="${a.id}" title="${esc(a.title)}">${esc(a.label)}</button><button type="button" class="md-action-chevron" data-md-action-menu="${a.id}" title="${esc(menuTitle)}" aria-label="${esc(menuLabel)}">▾</button></span>`;
  const actionsHtml = MD_QUICK_ACTIONS.map((a) => {
    if (a.id === 'anchor') return splitBtn(a, 'Anchor to a page you looked at recently', 'Recent pages');
    return `<button type="button" data-md-action="${a.id}" title="${esc(a.title)}">${esc(a.label)}</button>`;
  }).join('');
  body.innerHTML = `<div class="md-quick-actions" role="toolbar" aria-label="Quick actions">${actionsHtml}</div><textarea class="md-editor" id="md-editor" spellcheck="false"></textarea>`;
  const ta = $('#md-editor', body);
  // mousedown preventDefault keeps focus (and the selection) in the
  // editor while a quick-action button is clicked.
  $('.md-quick-actions', body).addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) e.preventDefault();
  });
  $('.md-quick-actions', body).addEventListener('click', (e) => {
    const menuBtn = e.target.closest('button[data-md-action-menu]');
    if (menuBtn) {
      openAnchorImpressionsMenu(menuBtn, ta); return;
    }
    const btn = e.target.closest('button[data-md-action]');
    if (!btn) return;
    insertMdQuickAction(ta, btn.dataset.mdAction);
  });
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
    // Autosave (debounced): the Save button is gone — typing saves itself.
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveActiveMdNote(false), 800);
    // The left Preview tab shows the same note when it is the previewed
    // one — keep it live.
    if (previewNoteName() === state.activeNoteName) {
      if (state.activeNoteName === 'notes.md') syncNotesMdCache(ta.value);
      if (leftPreviewTimer) clearTimeout(leftPreviewTimer);
      leftPreviewTimer = setTimeout(() => renderLeftPreview(), 400);
    }
  });
  // Pasting a screenshot uploads it first, then offers Append / Copy in a
  // popup — nothing is inserted until he picks one. Text pastes are
  // untouched (no image item on the clipboard).
  ta.addEventListener('paste', (e) => handleMdEditorPaste(ta, e));
}

/* Typeset LaTeX math in a rendered markdown element (notebook markdown
   cells AND the left Markdown preview both go through renderMdPreview,
   so one call covers both). KaTeX is vendored locally (public/vendor/
   katex — katex.min.js + auto-render.min.js + CSS + fonts, no CDN);
   renderMathInElement is its auto-render helper. Delimiters: inline
   $...$ and \(...\), display $$...$$ and \[...\], plus
   \begin{equation}/\begin{align} environments (the UDL labs use them).
   throwOnError: false — a construct KaTeX cannot render falls back to
   the raw source text (shown red, but visible) instead of breaking the
   cell. Code/pre are skipped by auto-render's ignoredTags. No-op when
   KaTeX failed to load. */
const KATEX_DELIMITERS = [
  { left: '$$', right: '$$', display: true },
  { left: '$', right: '$', display: false },
  { left: '\\(', right: '\\)', display: false },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\begin{equation}', right: '\\end{equation}', display: true },
  { left: '\\begin{equation*}', right: '\\end{equation*}', display: true },
  { left: '\\begin{align}', right: '\\end{align}', display: true },
  { left: '\\begin{align*}', right: '\\end{align*}', display: true },
];

function renderMathInPreview(el) {
  if (!el || typeof window.renderMathInElement !== 'function') return;
  try {
    window.renderMathInElement(el, {
      delimiters: KATEX_DELIMITERS,
      throwOnError: false,
      strict: 'ignore',
    });
  } catch {
    // Math is decorative here — a failure must never break the preview.
  }
}

/* Render markdown into el; tag headings with data-h for scroll-spy and
   attach a Run button to python/java/javascript fenced code blocks. */
function renderMdPreview(el, text) {
  el.innerHTML = window.marked ? window.marked.parse(text || '') : esc(text || '');
  rewriteAssetSrcs(el); // exported plots (assets/...) resolve via the asset API
  renderMathInPreview(el); // $...$ / $$...$$ / \begin{equation} → typeset KaTeX
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
    const material = anchor.sourceId === PAGE_ANCHOR_SOURCE_BOOK
      ? null
      : (state.materials || []).find((x) => x.id === anchor.sourceId) || null;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'page-anchor-chip';
    chip.dataset.anchorSource = anchor.sourceId;
    chip.dataset.anchorPage = String(anchor.page);
    chip.textContent = anchorChipLabel(anchor, material);
    const jumpWord = anchor.sourceId === PAGE_ANCHOR_SOURCE_BOOK
      ? `p. ${anchor.page} of the book`
      : material?.kind === 'slides'
        ? `slide ${anchor.page} of ${material.label || anchor.sourceId}`
        : `p. ${anchor.page} of ${material?.label || anchor.sourceId}`;
    chip.title = `Jump to ${jumpWord}`;
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
  if (state.activeNoteKind !== 'md' || !state.activeNoteName) return;
  const name = state.activeNoteName;
  const content = state.activeNoteContent;
  if (showStatus) setSaveStatus('Saving…');
  try {
    await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/notes/${encodeURIComponent(name)}`,
      'PUT', { content });
    state.headings = headingsFromMarkdown(content);
    renderChapterPanel();
    if (name === 'notes.md') syncNotesMdCache(content);
    // Only the note being previewed refreshes the left Preview tab.
    if (previewNoteName() === name) renderLeftPreview();
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

/* ---------------- creating notebooks ---------------- */

// One-click export of the master: the master IS a single file, so export
// downloads the saved notes.md as `<slug>-notes.md`. (The editor may hold
// unsaved typing — the export is the saved file, like a download.)
/* Create a markdown note from the + menu: prompt for the name with a
   prefilled first-free name; if the name already exists, open it instead
   of overwriting. */
async function createMdNote() {
  const name = window.prompt('New markdown note name (ends with .md):',
    firstFreeName(state.notes.map((n) => n.name), 'note', '.md'));
  if (!name) return;
  const clean = name.trim().endsWith('.md') ? name.trim() : `${name.trim()}.md`;
  if (state.notes.some((n) => n.name === clean)) {
    state.openNotes.add(clean);
    persistOpenTabs();
    await loadNote(clean);
    renderNotebookPane();
    renderChapterPanel();
    return;
  }
  try {
    await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/notes/${encodeURIComponent(clean)}`,
      'PUT', { content: `# ${clean.replace(/\.md$/, '')}\n` });
    state.notes.push({ name: clean, kind: 'md' });
    state.openNotes.add(clean);
    persistOpenTabs();
    await loadNote(clean);
    renderNotebookPane();
    renderChapterPanel();
  } catch (err) {
    window.alert(`Could not create the note: ${err.message}`);
  }
}

/* Create a notebook of one language from the + menu. Language is stored
   per notebook in metadata (kernelspec + language_info), so each kind is
   one click — no language prompt. A name that already exists opens the
   existing notebook instead of overwriting it. */
async function createIpynbNote(lang = 'python') {
  lang = RUNNABLE_LANGS.includes(lang) ? lang : 'python';
  // Language-aware prompt; .ipynb is appended automatically below if
  // the typed name lacks it, so the dialog never presents it as a
  // requirement. The prefill is still the full default filename.
  const name = window.prompt(`New ${LANG_DISPLAY[lang]} notebook name:`,
    firstFreeName(state.notes.map((n) => n.name), `${lang}-scratch`, '.ipynb'));
  if (!name) return;
  const clean = name.trim().endsWith('.ipynb') ? name.trim() : `${name.trim()}.ipynb`;
  if (state.notes.some((n) => n.name === clean)) {
    state.openNotes.add(clean);
    persistOpenTabs();
    await loadNote(clean);
    renderNotebookPane();
    renderChapterPanel();
    return;
  }
  // New notebooks start Jupyter-style: one empty code cell, no
  // auto-created markdown title cell (user 2026-11-12).
  const nb = {
    cells: [{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [] }],
    metadata: { kernelspec: { display_name: lang, language: lang, name: lang }, language_info: { name: lang } },
    nbformat: 4,
    nbformat_minor: 5,
  };
  try {
    await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/notes/${encodeURIComponent(clean)}`,
      'PUT', { content: JSON.stringify(nb, null, 2) });
    state.notes.push({ name: clean, kind: 'ipynb' });
    state.openNotes.add(clean);
    persistOpenTabs();
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

/* Notebook cell editors auto-grow to fit their content: height follows
   the code (minimum ~3 lines from CSS min-height), so a normal cell
   never shows a cramped inner scroll. NB_CELL_MAX_HEIGHT is the AUTO-fit
   cap — past it the editor scrolls internally instead of taking over
   the page. A manual drag (the explicit .nb-cell-resize bar under the
   editor) sets a MINIMUM height for the session, kept in cellManualHeights
   (WeakMap keyed by cell object: never written into the .ipynb, dies with
   the cell, so a reload / tab switch starts fresh). Auto-grow still
   grows past a dragged height when the content is taller, but never
   shrinks below it; the 480px cap does not apply once a cell has been
   dragged. No-op while the editor is hidden (scrollHeight is 0 then);
   fitCellEditors re-fits when the pane becomes visible. */
const NB_CELL_MAX_HEIGHT = 480;
const cellManualHeights = new WeakMap();

/* The notebook cell an editor textarea belongs to (set as data-cell-idx
   at render time), for its dragged minimum height. */
function cellForEditor(ta) {
  const idx = Number(ta?.dataset?.cellIdx);
  if (!Number.isInteger(idx)) return null;
  return state.activeNotebook?.cells?.[idx] ?? null;
}

function manualMinHeightFor(ta) {
  const cell = cellForEditor(ta);
  return cell ? (cellManualHeights.get(cell) || 0) : 0;
}

function autoGrowCellEditor(ta) {
  if (!ta || !ta.isConnected || ta.offsetParent === null) return;
  ta.style.height = 'auto';
  const content = ta.scrollHeight;
  const manual = manualMinHeightFor(ta);
  let h;
  if (manual > 0) {
    // Dragged height is a floor for the session: grow past it when the
    // content is taller, never shrink below it.
    h = Math.max(content, manual);
    ta.style.overflowY = 'hidden';
  } else {
    h = Math.min(content, NB_CELL_MAX_HEIGHT);
    ta.style.overflowY = content > NB_CELL_MAX_HEIGHT ? 'auto' : 'hidden';
  }
  ta.style.height = `${h}px`;
}

/* Explicit drag handle under a cell editor (the native textarea grip is
   a ~12px texture that is effectively invisible against the dark code
   background, so the user drags this bar instead). Pointer drag resizes
   live; the height is recorded as the cell's manual minimum, so the
   next keystroke (auto-grow) keeps it. Dragging shorter than the
   content has no lasting effect — the drag is a floor, and auto-grow
   re-expands to fit the content on release. */
function attachCellResize(handle, ta, cell) {
  if (!handle || !ta) return;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = ta.offsetHeight;
    try { handle.setPointerCapture(e.pointerId); } catch { /* no capture */ }
    const onMove = (ev) => {
      const h = Math.max(88, startH + (ev.clientY - startY));
      ta.style.height = `${h}px`;
      ta.style.overflowY = ta.scrollHeight > h ? 'auto' : 'hidden';
      if (cell) cellManualHeights.set(cell, h);
    };
    const done = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', done);
      handle.removeEventListener('pointercancel', done);
      autoGrowCellEditor(ta); // reconcile: keeps the dragged minimum, grows if content is taller
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', done);
    handle.addEventListener('pointercancel', done);
  });
}

/* Re-fit every cell editor currently on screen (code cells + any
   markdown cell editor open in Edit mode). */
function fitCellEditors() {
  $$('#nb-cells textarea.nb-code-source, #nb-cells [data-md-editor]:not([hidden]) textarea')
    .forEach(autoGrowCellEditor);
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
  const btns = $$('#nb-cells .run-btn, #nb-run-all, #nb-undo');
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
    syncNbUndoButton(); // Undo's disabled state follows its stack, not the run
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
  // One toolbar row above the cells: Undo + Run all (Run all not for
  // Java — cells cannot share one session), at the TOP RIGHT with
  // breathing room. Export lives at the cell level now (a rail button
  // beside each code cell), so the toolbar carries no Export button.
  // Undo covers this notebook's edits, adds, deletes and Code AI
  // Applies — never runs. Disabled while its stack is empty.
  const runAllRow = `
    <div class="nb-runall-row">
      <span class="save-status" id="nb-runall-status"></span>
      <button type="button" id="nb-undo" title="Undo the last change in this notebook"
        ${(nbUndoStack().length || nbEditBaselines.hasUncommittedChange()) ? '' : 'disabled'}>Undo</button>
      ${lang === 'java' ? '' : `<button type="button" class="run-btn" id="nb-run-all"
        title="Run all code cells top to bottom in one shared session">▶ Run all</button>`}
    </div>`;
  body.innerHTML = `${runAllRow}<div class="nb-cells" id="nb-cells"></div>`;
  const undoBtn = $('#nb-undo', body);
  if (undoBtn) {
    undoBtn.addEventListener('click', () => undoNotebook());
  }
  const runAllBtn = $('#nb-run-all', body);
  if (runAllBtn) {
    runAllBtn.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.textContent = 'Running…';
      await runNotebookCells(codeCellsUpTo(Infinity), $('#nb-runall-status', body));
      btn.textContent = '▶ Run all';
    });
  }
  const wrap = $('#nb-cells', body);

  nb.cells.forEach((cell, idx) => {
    const cellEl = document.createElement('div');
    cellEl.className = 'nb-cell';
    cellEl.dataset.nbIndex = String(idx);
    if (cell.cell_type === 'markdown') {
      cellEl.innerHTML = `
      <div class="nb-cell-card">
        <div class="nb-cell-head"><span>Markdown</span><span class="spacer"></span>
          <button type="button" data-md-edit="${idx}">Edit</button></div>
        <div class="md-preview" data-md-view="${idx}"></div>
        <div data-md-editor="${idx}" hidden>
          <textarea class="md-editor" rows="6" spellcheck="false"></textarea>
          <div class="nb-cell-resize" data-cell-resize="${idx}" title="Drag to resize"><span aria-hidden="true">⋯</span></div>
        </div>
      </div>`;
      const viewEl = $(`[data-md-view="${idx}"]`, cellEl);
      renderMdPreview(viewEl, nbCellSource(cell));
      const editBtn = $(`[data-md-edit="${idx}"]`, cellEl);
      const editorWrap = $(`[data-md-editor="${idx}"]`, cellEl);
      const ta = $('textarea', editorWrap);
      ta.value = nbCellSource(cell);
      ta.dataset.cellIdx = String(idx);
      attachCellResize($('.nb-cell-resize', editorWrap), ta, cell);
      ta.addEventListener('input', () => autoGrowCellEditor(ta));
      editBtn.addEventListener('click', () => {
        const editing = editorWrap.hidden;
        editorWrap.hidden = !editing;
        viewEl.hidden = editing;
        editBtn.textContent = editing ? 'Done' : 'Edit';
        if (!editing) {
          setNbCellSource(cell, ta.value);
          commitNbEdit(cell); // one undo step for the whole edit session
          renderMdPreview(viewEl, ta.value);
          saveNotebook();
        } else {
          nbEditBaselines.begin(cell, nbCellSource(cell));
          autoGrowCellEditor(ta);
          ta.focus();
        }
      });
    } else {
      // Code cell: editable source, Run button, outputs area. The head row
      // carries the per-cell actions in one line: ✨ AI pins this cell as
      // the Code AI target, Export starts the export flow for this cell,
      // Delete removes it.
      cellEl.innerHTML = `
      <div class="nb-cell-card">
        <div class="nb-cell-head"><label class="nb-export-check" title="Select for Markdown export">
            <input type="checkbox" data-cell-select="${idx}" ${state.exportSelection.has(idx) ? 'checked' : ''}> Export</label>
          <span>Code · ${esc(lang)}</span><span class="spacer"></span>
          <button type="button" class="rail-btn rail-btn-ai" data-cell-ai="${idx}" title="Ask Code AI about this cell">✨ AI</button>
          <button type="button" class="rail-btn" data-cell-export="${idx}" title="Export this cell to Markdown">Export</button>
          <button type="button" data-cell-del="${idx}">Delete</button></div>
        <textarea class="nb-code-source" spellcheck="false"></textarea>
        <div class="nb-cell-resize" data-cell-resize="${idx}" title="Drag to resize"><span aria-hidden="true">⋯</span></div>
        <div class="nb-cell-foot">
          <button type="button" class="run-btn" data-cell-run="${idx}">▶ Run</button>
          ${lang === 'java' ? '' : `<button type="button" class="run-btn" data-cell-run-above="${idx}" title="Run this cell and every code cell above it in one shared session">▶ Run all above</button>`}
          <span class="save-status" data-cell-status="${idx}"></span>
        </div>
        <div class="nb-output" data-cell-output="${idx}"></div>
      </div>`;
      $(`[data-cell-select="${idx}"]`, cellEl).addEventListener('change', (e) => {
        if (e.currentTarget.checked) state.exportSelection.add(idx);
        else state.exportSelection.delete(idx);
      });
      // Head row: ✨ AI pins this cell as the Code AI target; Export selects
      // this cell and opens the export picker for it.
      $(`[data-cell-ai="${idx}"]`, cellEl).addEventListener('click', () => pinAiCodeTarget(idx));
      $(`[data-cell-export="${idx}"]`, cellEl).addEventListener('click', () => {
        state.exportSelection.add(idx);
        const cb = $(`[data-cell-select="${idx}"]`, cellEl);
        if (cb) cb.checked = true;
        exportSelectedCells();
      });
      const ta = $('.nb-code-source', cellEl);
      ta.value = nbCellSource(cell);
      ta.dataset.cellIdx = String(idx);
      attachCellResize($('.nb-cell-resize', cellEl), ta, cell);
      ta.addEventListener('input', () => { setNbCellSource(cell, ta.value); autoGrowCellEditor(ta); syncNbUndoButton(); });
      ta.addEventListener('blur', () => { commitNbEdit(cell); saveNotebook(); });
      ta.addEventListener('focus', () => { state.editorFocused = true; nbEditBaselines.begin(cell, nbCellSource(cell)); });
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
        commitAllNbEdits();
        pushUndoEntry(nbUndoStack(), deleteUndoEntry({ cell: nb.cells[idx], index: idx }));
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
      const newCell = { cell_type: 'markdown', metadata: {}, source: '' };
      nb.cells.splice(idx + 1, 0, newCell);
      commitAllNbEdits();
      pushUndoEntry(nbUndoStack(), addUndoEntry({ cell: newCell }));
      state.exportSelection = new Set(); // indexes shift — drop the selection
      saveNotebook().then(() => renderNotebookBody());
    });
    $(`[data-add-code="${idx}"]`, addRow).addEventListener('click', () => {
      const newCell = { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: '' };
      nb.cells.splice(idx + 1, 0, newCell);
      commitAllNbEdits();
      pushUndoEntry(nbUndoStack(), addUndoEntry({ cell: newCell }));
      state.exportSelection = new Set(); // indexes shift — drop the selection
      saveNotebook().then(() => renderNotebookBody());
    });
    wrap.appendChild(addRow);
  });

  // No bottom add row: it duplicated the last cell's per-cell row (the
  // last cell's "add after" IS "append at the end"). The only notebook
  // with no per-cell row is an empty one (every cell deleted) — keep a
  // single add row there, or the notebook would have no way to grow.
  if (!nb.cells.length) {
    const emptyRow = document.createElement('div');
    emptyRow.className = 'nb-add-row';
    const addFirstCell = (cellType) => {
      const newCell = cellType === 'markdown'
        ? { cell_type: 'markdown', metadata: {}, source: '' }
        : { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: '' };
      nb.cells.push(newCell);
      commitAllNbEdits();
      pushUndoEntry(nbUndoStack(), addUndoEntry({ cell: newCell }));
      saveNotebook().then(() => renderNotebookBody());
    };
    for (const [label, cellType] of [['+ Markdown cell', 'markdown'], ['+ Code cell', 'code']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', () => addFirstCell(cellType));
      emptyRow.appendChild(btn);
    }
    wrap.appendChild(emptyRow);
  }
  // Fit every cell editor NOW that the cells are in the DOM: measuring
  // scrollHeight before appendChild returns 0, so the per-cell fit
  // above could never run at render time — only the input listener
  // fitted, which is why lab notebooks opened from the picker (whose
  // cells arrive with multi-line content) stayed at the ~88px CSS
  // minimum with an inner scrollbar. Cells in a hidden pane measure
  // 0 and are re-fit by applyReaderLayout when the pane reappears.
  fitCellEditors();
  markAiTargetCell(); // re-apply the pinned-target outline after a re-render
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
   verbatim so the server can match it against the stored outline. */
function activeOutlineChapter() {
  if (!state.activeChapter) return null;
  return (state.outline || []).find((ch) => normalizeHeading(ch.title) === state.activeChapter) || null;
}

/* Display title for the context line: the outline chapter, else the active
   note heading, else null. */
function activeChapterTitle() {
  const ch = activeOutlineChapter();
  if (ch) return ch.title;
  const h = notesMdHeadings().find((hh) => hh.norm === state.activeChapter)
    || (state.headings || []).find((hh) => hh.norm === state.activeChapter);
  return h ? h.text : null;
}

/* One context sentence for the AI panel, from the material currently being
   read (left pane source + page). Book PDF -> the chapter's text; Slides
   tab -> the deck around the current slide; Preview tab -> the chapter. */
function aiContextText() {
  const reading = currentReadingPage();
  const ch = activeOutlineChapter();
  if (reading && reading.sourceId !== PAGE_ANCHOR_SOURCE_BOOK) {
    const mat = (state.materials || []).find((m) => String(m.id) === String(reading.sourceId));
    if (String(mat?.kind || '').toLowerCase() === 'slides') {
      return `Context: ${activeSourceLabel()} (slide ${reading.page}) — the AI reads this deck around the current slide.`;
    }
    return `Context: ${activeSourceLabel()} (p. ${reading.page}) — the AI reads this document around the current page.`;
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

/* Record the page/slide being read as a recent impression (session-only,
   last 5 minutes — see public/recentImpressions.js). The Page anchor
   quick action offers these in a dropdown. */
function noteReadingImpression() {
  const reading = currentReadingPage();
  if (!reading) return;
  state.recentImpressions = recordImpression(state.recentImpressions, reading);
}

/* What an impression label needs: the chapter for a book page, the
   material for a deck/PDF page. The chapter resolves against the book's
   outline, so it is omitted while an extra PDF is showing (its outline
   is loaded in place of the book's). */
function impressionMeta(entry) {
  if (!entry) return {};
  if (entry.sourceId === PAGE_ANCHOR_SOURCE_BOOK) {
    if (state.pdfSourceId && state.pdfSourceId !== PAGE_ANCHOR_SOURCE_BOOK) return {};
    const ch = chapterForPage(entry.page);
    return { chapterTitle: ch ? ch.title : null };
  }
  const material = (state.materials || []).find((m) => String(m.id) === String(entry.sourceId));
  return { material: material || null };
}

/* Keep the AI panel's context lines live as the reader moves chapters.
   Cheap: text updates, only when the panel is open. Called from
   renderAiPanel and from setActiveChapter. */
function updateAiContext() {
  const el = $('#ai-context', view);
  if (el) el.textContent = aiContextText();
  const codeEl = $('#ai-code-context', view);
  if (codeEl) {
    // Name the language Code AI will write, so a Java/JS notebook does
    // not look like the Python-only panel it used to be.
    const langName = { python: 'Python', java: 'Java', javascript: 'JavaScript' }[notebookLanguage()];
    const nb = state.activeNotebook
      ? `Notebook: ${notebookDisplayName()}${langName ? ` (${langName})` : ''}. ` : '';
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
  // The same events that move the context line also record the page as a
  // recent impression for the Page anchor dropdown (onPdfScroll covers
  // book page scrolls within a chapter).
  noteReadingImpression();
}

/* Port of insertMarkdownUnderHeading in src/aiNote.js — the same rule on
   both sides: insert at the end of the section under the ## heading
   matching headingTitle; append a new ## section when it is missing (with
   headingAnchor, e.g. `<!-- p. 31 -->`, under it when given); a
   second insert of the exact same block is a no-op (inserted: false). */
function insertMarkdownUnderHeading(notesText, headingTitle, markdown, headingAnchor = null) {
  const block = String(markdown || '').trim();
  if (!block) return { text: String(notesText ?? ''), inserted: false };
  const lines = String(notesText ?? '').split('\n');
  const headings = headingsFromMarkdown(notesText);
  const hit = matchHeading(headingTitle, headings);
  if (!hit) {
    const base = String(notesText ?? '');
    const sep = base && !base.endsWith('\n') ? '\n' : '';
    const gap = base && !base.endsWith('\n\n') ? '\n' : '';
    const anchorLine = headingAnchor ? `${String(headingAnchor).trim()}\n\n` : '';
    return { text: `${base}${sep}${gap}## ${headingTitle}\n\n${anchorLine}${block}\n`, inserted: true };
  }
  const start = hit.line + 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  const section = lines.slice(start, end).join('\n');
  if (section.includes(block)) return { text: String(notesText ?? ''), inserted: false };
  const before = lines.slice(0, end);
  while (before.length && before[before.length - 1].trim() === '') before.pop();
  const after = lines.slice(end);
  return { text: [...before, '', block, '', ...after].join('\n'), inserted: true };
}

/* Page anchors — verbatim port of src/pageAnchor.js (same format, same
   rules on both sides). A note block anchored to a page of the book PDF or
   a slide of a deck carries `<!-- @page N · source: <id> -->` in notes.md;
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

function anchorChipLabel(anchor, material) {
  if (!anchor) return '';
  if (anchor.sourceId === PAGE_ANCHOR_SOURCE_BOOK) return `p. ${anchor.page}`;
  // With the material in hand the kind decides. Without it, fall back to
  // the seed's naming convention: deck ids are `slides-*`.
  const kind = material ? String(material.kind || '').toLowerCase() : null;
  if (kind === 'slides' || (kind == null && String(anchor.sourceId).startsWith('slides-'))) {
    return `Slide ${anchor.page}`;
  }
  const label = material?.label || anchor.sourceId;
  return `p. ${anchor.page} · ${label}`;
}

/* Port of resolveAnchorTarget in src/pageAnchor.js (same rules on both
   sides): where does an anchor jump — the book, a material (deck or extra
   PDF), or nowhere (unknown id / unreadable / not page-addressable). */
function resolveAnchorTarget(sourceId) {
  if (!sourceId || sourceId === PAGE_ANCHOR_SOURCE_BOOK) return { target: 'book' };
  const mat = (state.materials || []).find((m) => String(m.id) === String(sourceId));
  if (!mat || mat.hasFile === false) return { target: 'unknown' };
  const kind = String(mat.kind || '').toLowerCase();
  if (kind !== 'slides' && kind !== 'pdf') return { target: 'unknown' };
  return { target: 'material', id: mat.id, kind };
}

/* Port of pdfMaterials in src/pageAnchor.js: the project's extra PDF
   documents (kind 'pdf') — the ones the PDF tab's picker offers next to
   the book. Decks (kind 'slides') live in the Slides tab instead. */
function pdfMaterialsList() {
  return (state.materials || []).filter((m) => String(m.kind || '').toLowerCase() === 'pdf'
    && m.hasFile !== false);
}

/* Chapter number from a note heading's text: "12. Transformers" -> 12.
   The seeded notes.md numbers its ## headings; an unnumbered heading has
   no number and maps to no deck/lab group. */
function chapterNumberFromHeading(headingText) {
  const m = String(headingText ?? '').match(/^\s*(\d+)\s*[.)]\s/);
  return m ? Number(m[1]) : null;
}

/* The ## headings of notes.md — the chapter list the deck/lab follow
   resolves against. The active note's headings are notes.md's when
   notes.md is open; otherwise parse the cached notes.md text (kept fresh
   by every notes.md write path). Falls back to the active note's headings
   when notes.md has never been loaded (e.g. no notes file yet). */
function notesMdHeadings() {
  if (state.activeTabKind === 'note' && state.activeNoteName === 'notes.md') return state.headings || [];
  if (state.notesMdContent != null) return headingsFromMarkdown(state.notesMdContent);
  return state.headings || [];
}

/* The slide deck for a chapter. Two rules, in order:
   1. By number: the seeded decks are slides-introduction / slides-chapN,
      numbered like the ## headings ("12. Transformers" -> slides-chap12).
      This is the primary rule because deck labels do NOT match chapter
      titles: chap 12's deck is labelled "Image Generation" and chap 13's
      "Transformers and LLMs" (the UDL site's deck titles).
   2. By label, with the same normalized matching as chapterMap.
   Returns the material or null. */
function deckForChapter(chapterTitle) {
  if (!chapterTitle) return null;
  const heading = matchHeading(chapterTitle, notesMdHeadings());
  const n = chapterNumberFromHeading(heading?.text);
  if (n != null) {
    const id = n === 1 ? 'slides-introduction' : `slides-chap${n}`;
    const byId = (state.materials || []).find((m) => m.id === id);
    if (byId) return byId;
  }
  const norm = normalizeHeading(chapterTitle);
  return (state.materials || []).find((m) => normalizeHeading(m.label || m.id) === norm) || null;
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

/* The `<!-- p. N -->` anchor for a chapter's `##` heading, from its
   outline start page — the same anchor the seeded master carries. Null
   when there is no chapter (or no page), so the heading is created bare. */
function chapterPageAnchor(chapter) {
  return chapter && chapter.page != null ? `<!-- p. ${chapter.page} -->` : null;
}

/* Insert markdown under a ## heading in any markdown note through the
   existing notes PUT path. A missing note is created (notes.md from the
   project title, like the seed's header; any other note from its own name,
   like the + menu's create). The filing rule is the same everywhere: under
   the chapter's ## heading, created on demand with the page anchor.
   Returns {inserted, headingTitle, noteName}. */
async function insertIntoNote(noteName, headingTitle, markdown, headingAnchor = null) {
  const slug = encodeURIComponent(state.project.slug);
  let current = '';
  let exists = true;
  try {
    const data = await apiGet(`/api/projects/${slug}/notes/${encodeURIComponent(noteName)}`);
    current = typeof data === 'string' ? data : (data.content ?? '');
  } catch (err) {
    if (/note not found/.test(err.message || '')) {
      current = noteName === 'notes.md'
        ? `# ${state.project.title}\n`
        : `# ${noteName.replace(/\.md$/, '')}\n`;
      exists = false;
    } else throw err;
  }
  const { text, inserted } = insertMarkdownUnderHeading(current, headingTitle, markdown, headingAnchor);
  if (!inserted) return { inserted: false, headingTitle, noteName };
  await apiJson(`/api/projects/${slug}/notes/${encodeURIComponent(noteName)}`, 'PUT', { content: text });
  if (noteName === 'notes.md') syncNotesMdCache(text);
  renderLeftPreview();
  if (!exists && !state.notes.some((n) => n.name === noteName)) {
    state.notes.push({ name: noteName, kind: 'md' });
    renderNotebookPane();
  }
  if (state.activeTabKind === 'note' && state.activeNoteName === noteName) {
    state.activeNoteContent = text;
    state.headings = headingsFromMarkdown(text);
    renderChapterPanel();
    const ta = $('#md-editor', view); if (ta) ta.value = text;
  }
  return { inserted: true, headingTitle, noteName };
}

/* The notes.md case of insertIntoNote (+ Note here, cell-export Insert). */
async function insertIntoNotesMd(headingTitle, markdown, headingAnchor = null) {
  return insertIntoNote('notes.md', headingTitle, markdown, headingAnchor);
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
   only — never open in Navigation or Notetaking). Head: two tabs (Note AI |
   Code AI) + a close × that returns to Notetaking. Body: #ai-panel, rendered
   by renderAiPanel. */
function renderAiColumn() {
  const col = $('#ai-column', view);
  if (!col) return;
  if (!state.panels.ai) { col.hidden = true; return; }
  col.hidden = false;
  if (col.dataset.built !== '1') {
    col.dataset.built = '1';
    col.innerHTML = `
      <div class="ai-column-head">
        <div class="ai-tabs" role="tablist" aria-label="AI">
          <button type="button" class="ai-tab" data-ai-tab="note" role="tab">✨ Note AI</button>
          <button type="button" class="ai-tab" data-ai-tab="code" role="tab">&lt;/&gt; Code AI</button>
        </div>
        <button type="button" id="ai-close" title="Close the AI panel (back to Notetaking)">✕</button>
      </div>
      <div class="ai-model-row">
        <label>Model <select id="ai-model" aria-label="AI model"></select></label>
      </div>
      <div class="ai-column-body" id="ai-panel"></div>`;
    $$('.ai-tab', col).forEach((btn) => {
      btn.addEventListener('click', () => {
        state.aiTab = btn.dataset.aiTab;
        renderAiColumn();
      });
    });
    $('#ai-close', col).addEventListener('click', () => toggleAiPanel());
    $('#ai-model', col).addEventListener('change', (e) => {
      state.aiModel = e.target.value || '';
      try { window.localStorage.setItem(AI_MODEL_KEY, state.aiModel); } catch { /* ignore */ }
    });
    loadAiModels();
  }
  $$('.ai-tab', col).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.aiTab === state.aiTab);
  });
  renderAiPanel();
}

/* The model picker (AV AiAssistant style): the server lists the models
   the configured key can use (GET /api/llm/models, configured model
   first); the choice is remembered in localStorage and sent with every
   ai-note / ai-code request. Fetched once per page load. */
async function loadAiModels() {
  if (state.aiModelsLoaded) { syncAiModelSelect(); return; }
  state.aiModelsLoaded = true;
  try {
    const data = await apiGet('/api/llm/models');
    state.aiModels = Array.isArray(data?.models) ? data.models.map((m) => String(m.name || m)) : [];
    // `configured` is a boolean on this endpoint; the configured model's
    // name is `model`. (A boolean `true` once landed in the list as a
    // bogus option — do not read the name from `configured`.)
    if (data?.model && !state.aiModels.includes(data.model)) {
      state.aiModels.unshift(data.model);
    }
  } catch {
    state.aiModels = [];
  }
  syncAiModelSelect();
}

function syncAiModelSelect() {
  const sel = $('#ai-model', view);
  if (!sel) return;
  const models = state.aiModels.length ? state.aiModels : (state.aiModel ? [state.aiModel] : []);
  const current = state.aiModel || models[0] || '';
  sel.innerHTML = models.map((m) => (
    `<option value="${esc(m)}"${m === current ? ' selected' : ''}>${esc(String(m).replace(/^models\//, ''))}</option>`
  )).join('');
  if (!models.length) {
    sel.innerHTML = '<option value="">No model configured</option>';
    sel.disabled = true;
  } else {
    sel.disabled = false;
  }
}

function renderAiPanel() {
  const panel = $('#ai-panel', view);
  if (!panel) return;
  if (!state.panels.ai) { panel.innerHTML = ''; panel.dataset.key = ''; return; }
  const key = `${state.aiTab}:${notebookKey()}`;
  if (panel.dataset.key !== key) {
    panel.dataset.key = key;
    if (state.aiTab === 'code') {
      panel.innerHTML = `
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
   when undeclared — the seeded labs all declare it). */
function notebookLanguage() {
  const md = state.activeNotebook?.metadata || {};
  return String(md.kernelspec?.language || md.language_info?.name || 'python').toLowerCase();
}

/* The language Code AI will write for the open notebook, or null when
   the notebook's language is not one it supports (should not happen
   with the app's own notebook kinds — a notebook whose metadata names
   something else entirely). */
function aiCodeLanguage() {
  if (!state.activeNotebook) return null;
  const lang = notebookLanguage();
  return RUNNABLE_LANGS.includes(lang) ? lang : null;
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
  if (!state.aiCodeThreads[key]) state.aiCodeThreads[key] = { messages: [], target: null };
  const thread = state.aiCodeThreads[key];
  if (!('target' in thread)) thread.target = null;
  return thread;
}

/* Pin a code cell as the Code AI context + Apply target: the ✨ AI button
   beside the cell. The panel opens on the Code AI tab with the cell shown
   as the target; Apply replaces this cell in place. Clearing the target
   returns to the unpinned flow (Apply appends a new cell at the end). */
function pinAiCodeTarget(idx) {
  const cell = state.activeNotebook?.cells?.[idx];
  if (!cell || cell.cell_type !== 'code') return;
  aiCodeThread().target = {
    index: idx,
    label: targetCellLabel(cell),
    fingerprint: targetCellFingerprint(cell),
  };
  state.aiTab = 'code';
  if (!state.panels.ai) toggleAiPanel();
  renderAiColumn();
  markAiTargetCell();
  const input = $('#ai-code-prompt', view);
  if (input) input.focus();
}

function clearAiCodeTarget() {
  aiCodeThread().target = null;
  renderAiCodeThread();
  markAiTargetCell();
}

/* Outline the pinned target cell in the notebook body (the card, not the
   rail button — the outline is what the eye finds when scrolling). */
function markAiTargetCell() {
  const target = aiCodeThread().target;
  $$('#nb-cells .nb-cell').forEach((el) => {
    el.classList.toggle('nb-cell-ai-target',
      !!target && Number(el.dataset.nbIndex) === target.index);
  });
  $$('#nb-cells .rail-btn-ai').forEach((btn) => {
    btn.classList.toggle('active',
      !!target && Number(btn.dataset.cellAi) === target.index);
  });
}

function renderAiCodeThread() {
  const thread = $('#ai-code-thread', view);
  if (!thread) return;
  const { messages, target } = aiCodeThread();
  thread.innerHTML = '';
  // Pinned target chip — shown even before the first question, so the
  // panel always says which cell Apply will replace. Label-only.
  if (target) {
    const chip = document.createElement('div');
    chip.className = 'ai-target-chip';
    const label = document.createElement('span');
    label.textContent = `Target: ${target.label}`;
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = '✕';
    clear.title = 'Clear target';
    clear.addEventListener('click', () => clearAiCodeTarget());
    chip.append(label, clear);
    thread.appendChild(chip);
  }
  // Empty thread stays empty: the input + chips are self-evident, and
  // asking with no supported notebook open reports it as a status message.
  if (!messages.length) {
    return;
  }
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
  if (!panel || !state.panels.ai || state.aiTab !== 'code') return;
  const input = $('#ai-code-prompt', panel);
  const statusEl = $('#ai-code-status', panel);
  const sendBtn = $('#ai-code-send', panel);
  const prompt = (input.value || '').trim();
  statusEl.classList.remove('error');
  if (!prompt) { statusEl.textContent = 'Type what you want the code to do.'; return; }
  if (prompt.length > 2000) { statusEl.textContent = 'Keep the request under 2000 characters.'; return; }
  if (!state.activeNotebook) {
    statusEl.textContent = 'Open a notebook first — Code AI writes code for the current notebook.';
    statusEl.classList.add('error');
    return;
  }
  const lang = aiCodeLanguage();
  if (!lang) {
    statusEl.textContent = 'Code AI supports Python, Java and JavaScript notebooks.';
    statusEl.classList.add('error');
    return;
  }
  const thread = aiCodeThread();
  const history = thread.messages.slice(-6).map((m) => ({
    role: m.role,
    content: m.role === 'assistant' ? (m.code || '') : m.content,
  }));
  // The WHOLE notebook as context (code + markdown cells, in order),
  // with the pinned cell marked TARGET — capped at 32k chars (the server
  // caps too), so the model writes code that fits the notebook it is in.
  const { parts: cells } = formatNotebookCellsForCodeAi(
    state.activeNotebook.cells || [],
    thread.target ? thread.target.index : null,
    AI_CODE_CONTEXT_CHARS,
  );
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
      language: lang,
      source: reading && reading.sourceId !== PAGE_ANCHOR_SOURCE_BOOK ? reading.sourceId : null,
      page: reading ? reading.page : null,
      cells,
      targetCell: thread.target ? thread.target.index : null,
      history,
      model: state.aiModel || undefined,
    });
    thread.messages.push({
      role: 'assistant', content: '', code: res.code || '', explanation: res.explanation || '',
      applied: false, target: thread.target ? { ...thread.target } : null,
    });
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
  if (!state.activeNotebook || !aiCodeLanguage()) {
    const statusEl = $('#ai-code-status', view);
    if (statusEl) {
      statusEl.textContent = 'The notebook changed — Code AI supports Python, Java and JavaScript notebooks.';
      statusEl.classList.add('error');
    }
    return;
  }
  // Pinned target: replace that cell in place — but only when the cell
  // still holds what was pinned (same first line). Its old outputs belong
  // to the old source, so they are cleared with it; the stale error a cell
  // showed before the fix must not survive under the new code. Other cells
  // are untouched. notes.md is untouched — this writes the notebook only.
  commitAllNbEdits(); // open typing sessions commit before the Apply entry
  const target = msg.target;
  const targetCell = target && Number.isInteger(target.index)
    ? state.activeNotebook.cells[target.index] : null;
  const statusEl = $('#ai-code-status', view);
  if (targetCell && targetCell.cell_type === 'code'
    && targetCellFingerprint(targetCell) === target.fingerprint) {
    // Snapshot the cell (and the pin) first — Apply is reversible via
    // the notebook toolbar's Undo button.
    pushUndoEntry(nbUndoStack(), replaceUndoEntry({
      msgIndex: i, cell: targetCell,
      prevSource: nbCellSource(targetCell),
      prevOutputs: targetCell.outputs,
      prevExecutionCount: targetCell.execution_count,
      prevTarget: target ? { ...target } : null,
    }));
    setNbCellSource(targetCell, msg.code);
    targetCell.outputs = [];
    targetCell.execution_count = null;
    await saveNotebook();
    msg.applied = true;
    // Keep the pin on the same cell so the user can iterate on it: its
    // fingerprint/label now describe the new source.
    thread.target = {
      index: target.index,
      label: targetCellLabel(targetCell),
      fingerprint: targetCellFingerprint(targetCell),
    };
    renderAiCodeThread();
    renderNotebookBody();
    const el = $(`#nb-cells .nb-cell[data-nb-index="${target.index}"]`, view);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (statusEl) statusEl.textContent = 'Replaced the target cell in place.';
    return;
  }
  // No pin, or the pinned cell moved/changed since the question: append a
  // new code cell at the end of the notebook (never edits an existing cell).
  const newCell = {
    cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: msg.code,
  };
  state.activeNotebook.cells.push(newCell);
  pushUndoEntry(nbUndoStack(), appendUndoEntry({ msgIndex: i, cell: newCell }));
  await saveNotebook();
  msg.applied = true;
  renderAiCodeThread();
  renderNotebookBody();
  const body = $('#notebook-body', view);
  const cellEls = body ? $$('.nb-cell', body) : [];
  const last = cellEls[cellEls.length - 1];
  if (last) last.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (statusEl) {
    statusEl.textContent = target
      ? 'Target cell changed — added as a new code cell at the end of the notebook.'
      : 'Added as a new code cell at the end of the notebook.';
  }
}

/* This notebook's undo stack (LIFO, cap 20, in-memory): one stack per
   open .ipynb notebook, keyed like the ai-code threads. Runs never push
   entries — only edits, adds, deletes and Code AI Applies do. */
function nbUndoStack() {
  const key = notebookKey();
  if (!state.nbUndoStacks[key]) state.nbUndoStacks[key] = [];
  return state.nbUndoStacks[key];
}

/* The toolbar Undo button follows the stack: enabled only while this
   notebook has something to undo — including an uncommitted typing
   session (clicking it commits the session first, then undoes it). */
function syncNbUndoButton() {
  const btn = $('#nb-undo', view);
  if (btn) btn.disabled = !(nbUndoStack().length || nbEditBaselines.hasUncommittedChange());
}

/* Typing coalescing baselines (see nbUndo.js): one undo step per edit
   session, never per keystroke. The WeakMap keeps baselines off the cell
   objects, so they can never leak into the saved .ipynb file. */
const nbEditBaselines = createEditBaselines();

/* Commit a finished typing session: if the cell's source moved since the
   session started, one undo step for the whole session. Called on blur
   (code cells) / Done (markdown cells). */
function commitNbEdit(cell) {
  const prevSource = nbEditBaselines.commit(cell, nbCellSource(cell));
  if (prevSource !== null) {
    pushUndoEntry(nbUndoStack(), editUndoEntry({ cell, prevSource }));
    syncNbUndoButton();
  }
}

/* Commit every open typing session onto the stack, in the order they
   began. Mutation entry points (Apply, add, delete, Undo itself) call
   this BEFORE pushing their own entry: a re-render blurs the focused
   editor, and that blur's commit would otherwise land on top of the
   mutation's entry and break LIFO order. A real mouse click already
   blurred first (so this finds nothing); a programmatic trigger needs it. */
function commitAllNbEdits() {
  for (const { cell, prevSource } of nbEditBaselines.commitAll()) {
    pushUndoEntry(nbUndoStack(), editUndoEntry({ cell, prevSource }));
  }
  syncNbUndoButton();
}

/* Undo the most recent notebook change (LIFO): a typing session restores
   the cell's pre-session source; an add removes the cell; a delete puts
   it back; a pinned Code AI Apply restores the cell's previous source,
   outputs and execution_count (and the pin as it was, when the pin still
   points at that cell); an appended Apply removes the added cell. An
   undone Apply returns its proposal card to its pre-Apply state.
   Session-only — the stack lives in memory and clears on reload. */
async function undoNotebook() {
  commitAllNbEdits(); // a focused editor's session commits first, then undoes
  const stack = nbUndoStack();
  const entry = popUndoEntry(stack);
  if (!entry) {
    const statusEl = $('#nb-runall-status', view);
    if (statusEl) statusEl.textContent = 'Nothing to undo.';
    return;
  }
  const cells = state.activeNotebook.cells;
  if (entry.kind === 'edit') {
    if (cells.includes(entry.cell)) setNbCellSource(entry.cell, entry.prevSource);
  } else if (entry.kind === 'add' || entry.kind === 'append') {
    const idx = cells.indexOf(entry.cell);
    if (idx >= 0) {
      cells.splice(idx, 1);
      state.exportSelection = new Set(); // indexes shift — drop the selection
    }
  } else if (entry.kind === 'delete') {
    cells.splice(Math.min(entry.index, cells.length), 0, entry.cell);
    state.exportSelection = new Set();
  } else if (entry.kind === 'replace') {
    if (cells.includes(entry.cell)) {
      setNbCellSource(entry.cell, entry.prevSource);
      entry.cell.outputs = entry.prevOutputs;
      entry.cell.execution_count = entry.prevExecutionCount;
      // The pin describes the new source after Apply; put it back to the
      // restored one — unless the user re-pinned or cleared it since.
      const thread = aiCodeThread();
      const curIdx = cells.indexOf(entry.cell);
      if (entry.prevTarget && thread.target && thread.target.index === curIdx) {
        thread.target = { ...entry.prevTarget, index: curIdx };
      }
    }
  }
  // An undone Apply returns its proposal card to its pre-Apply state.
  if (entry.msgIndex !== undefined && entry.msgIndex !== null) {
    const msg = aiCodeThread().messages[entry.msgIndex];
    if (msg) msg.applied = false;
    renderAiCodeThread();
  }
  await saveNotebook();
  renderNotebookBody();
  syncNbUndoButton();
  // Re-query: the render rebuilt the toolbar, so the element captured
  // at the top of this function is detached now.
  const statusEl = $('#nb-runall-status', view);
  if (statusEl) {
    statusEl.textContent = entry.kind === 'replace' || entry.kind === 'append'
      ? 'Undid the last Apply.' : 'Undid the last change.';
  }
}

function renderAiThread() {
  const thread = $('#ai-thread', view);
  if (!thread) return;
  const { messages } = aiThread();
  // Empty thread stays empty: the input + chips are self-evident.
  if (!messages.length) {
    thread.innerHTML = '';
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
      // Destination picker: which EDITABLE markdown note Apply writes
      // to — notes.md is never offered (it is the read-only master
      // directory, preview only). Default is the note open in the right
      // pane, else the first editable note; shown only when there is
      // more than one editable note, so a single-note project has no
      // extra friction. The choice lives on the message, so each
      // proposal can go to a different note. With no editable note,
      // Apply is disabled with a hint instead of filing into notes.md.
      const dests = editableMdNotes();
      const defaultDest = defaultAiApplyDest();
      const dest = (msg.destNote && dests.some((n) => n.name === msg.destNote))
        ? msg.destNote : (defaultDest ? defaultDest.name : null);
      if (dests.length > 1) {
        const destSel = document.createElement('select');
        destSel.className = 'ai-apply-dest';
        destSel.setAttribute('aria-label', 'Note to apply to');
        destSel.title = 'Apply to this note';
        destSel.innerHTML = dests.map((n) => (
          `<option value="${esc(n.name)}"${n.name === dest ? ' selected' : ''}>${esc(n.name)}</option>`
        )).join('');
        destSel.addEventListener('change', () => { msg.destNote = destSel.value; });
        actions.append(destSel);
      }
      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'primary';
      applyBtn.textContent = msg.applied ? 'Applied ✓' : 'Apply';
      applyBtn.disabled = !!msg.applied || !dest;
      if (!dest) applyBtn.title = 'No editable note — create one first';
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
      if (!dest) {
        const hint = document.createElement('span');
        hint.className = 'ai-apply-hint';
        hint.textContent = 'No editable note — create one first.';
        actions.append(hint);
      }
      el.append(body, actions);
    }
    thread.appendChild(el);
  });
  thread.scrollTop = thread.scrollHeight;
}

async function askAi() {
  const panel = $('#ai-panel', view);
  if (!panel || !state.panels.ai) return;
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
      model: state.aiModel || undefined,
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
  const ch = activeOutlineChapter();
  const heading = ch ? ch.title : 'AI notes';
  const statusEl = $('#ai-status', view);
  // Destination: this proposal's picker choice, falling back to the open
  // editable note (else the first editable note). notes.md is never a
  // destination — with no editable note, Apply refuses instead of
  // filing into the master.
  const dests = editableMdNotes();
  const defaultDest = defaultAiApplyDest();
  const dest = (msg.destNote && dests.some((n) => n.name === msg.destNote))
    ? msg.destNote : (defaultDest ? defaultDest.name : null);
  if (!dest) {
    if (statusEl) {
      statusEl.textContent = 'No editable note — create one first.';
      statusEl.classList.add('error');
    }
    return;
  }
  try {
    const { inserted } = await insertIntoNote(dest, heading, msg.markdown, chapterPageAnchor(ch));
    msg.applied = true;
    msg.destNote = dest;
    if (statusEl) {
      statusEl.textContent = inserted
        ? `Inserted under “${heading}” in ${dest}.`
        : `Already in ${dest} — nothing added.`;
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

async function exportSelectedCells() {
  const indices = [...state.exportSelection].sort((a, b) => a - b);
  if (!indices.length || !state.activeNotebook) return;
  const name = state.activeTabKind === 'lab' && state.activeLab
    ? state.activeLab.name : state.activeNoteName;
  try {
    const res = await apiJson(`/api/projects/${encodeURIComponent(state.project.slug)}/export-cells`, 'POST', {
      notebook: state.activeNotebook, name, cells: indices,
    });
    openCellExportModal(res.markdown, name, res.images || []);
  } catch (err) {
    const status = $('#nb-runall-status', view);
    if (status) status.textContent = `Export failed: ${err.message}`;
  }
}

function closeCellExportModal() {
  const existing = document.getElementById('cell-export-modal');
  if (existing) existing.remove();
}

/* Preview what the export produces, before anything is written to notes.md.
   Two targets from one preview: [Insert into note] appends under the
   current chapter's ## heading in notes.md; [Download .md] saves the file
   (links resolve when it lives in notes/). */
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
    const ch = activeOutlineChapter();
    const heading = ch ? ch.title : notebookDisplayName();
    btn.disabled = true;
    btn.textContent = 'Inserting…';
    try {
      const { inserted } = await insertIntoNotesMd(heading, markdown, chapterPageAnchor(ch));
      btn.textContent = inserted ? 'Inserted ✓' : 'Already inserted ✓';
    } catch (err) {
      errBox.textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Insert into note';
    }
  });
}

/* ---------------- theme: dark / light ---------------- */

// Manual toggle only (no system-follow): the choice persists in
// localStorage, default is the current light look. The inline script in
// index.html applies the saved theme before first paint.
const THEME_KEY = 'nm-theme';
function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}
function syncThemeToggle() {
  const dark = currentTheme() === 'dark';
  $$('.theme-toggle').forEach((btn) => {
    btn.textContent = dark ? '☀️' : '🌙';
    btn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
    btn.setAttribute('aria-label', btn.title);
  });
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
  syncThemeToggle();
}
function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}
function initThemeToggle() {
  $$('.theme-toggle').forEach((btn) => btn.addEventListener('click', toggleTheme));
  syncThemeToggle();
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

initThemeToggle();
route();
