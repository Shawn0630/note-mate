// Reader layout math — pure, no DOM. Imported by public/app.js and
// unit-tested in tests/readerLayout.test.js.
//
// The reader is a 9-column grid: nav | divider | reading | divider |
// notebook | divider | AI | divider | Files. Panes are shown/hidden per layout preset (or
// individually via the Layout menu's Panels checklist); widths are
// per-project, persisted in localStorage, and survive mode switches.
// Reading/notebook share the middle as fractions of their combined width
// (50/50 default); nav and AI are fixed pixel widths. Zoom is a multiplier
// on the width-fitting PDF scale (1 = fit width).
//
// Conventions borrowed from the algorithm visualizer (AV):
// - divider gutter 7px with a 1px visible line (AV Divider), ew-resize;
// - tab-bar line-height 32px, base chrome font 13px (AV dimensions.scss);
// - Layouts menu: preset cards with miniature split diagrams + a Panels
//   checklist, fixed popover anchored to the button;
// - model picker: the server lists the models the key can use, the choice
//   is remembered in localStorage and sent with every AI request.

export const DIVIDER_PX = 7;

export const PANE_MIN = {
  nav: 180,
  reading: 300,
  notebook: 300,
  ai: 280,
  files: 200,
};

export const PANE_MAX = {
  nav: 480,
  ai: 560,
  files: 480,
};

export const PANE_DEFAULTS = {
  nav: 248,
  readingFr: 0.5,
  notebookFr: 0.5,
  ai: 340,
  files: 260,
};

/** The four layout presets: which of the four panes each one shows.
   Reading is the reading pane alone, full width. The Files panel is
   in none of them — it is hidden by default and opened on demand,
   like the Chapters panel is opened by its own toggle. */
export const LAYOUT_PRESETS = {
  reading: { nav: false, reading: true, notebook: false, ai: false, files: false },
  navigation: { nav: true, reading: true, notebook: false, ai: false, files: false },
  notetaking: { nav: false, reading: true, notebook: true, ai: false, files: false },
  ai: { nav: false, reading: true, notebook: true, ai: true, files: false },
};

export const LAYOUT_PRESET_NAMES = ['reading', 'navigation', 'notetaking', 'ai'];

/** One-time migration for stored layout-mode names, AV-style (the AV
   migrates its old strip/focus store once on load): 'focus' was renamed
   to 'notetaking' 2026-11-11. Unknown names return null. */
export const LAYOUT_MODE_ALIASES = { focus: 'notetaking' };

export function migrateLayoutModeName(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (LAYOUT_PRESET_NAMES.includes(n)) return n;
  if (Object.hasOwn(LAYOUT_MODE_ALIASES, n)) return LAYOUT_MODE_ALIASES[n];
  return null;
}

export const PANEL_TITLES = {
  nav: 'Chapters',
  reading: 'Reading pane',
  notebook: 'Working pane',
  ai: 'AI panel',
  files: 'Files panel',
};

/** Default panels for a fresh project: Notetaking (the 50/50 split). */
export function defaultPanels() {
  return { ...LAYOUT_PRESETS.notetaking };
}

/** Panels object → preset name when it matches one exactly, else null.
   The Files panel counts: a preset match with Files open is 'custom'. */
export function matchPreset(panels) {
  if (!panels) return null;
  for (const name of LAYOUT_PRESET_NAMES) {
    const preset = LAYOUT_PRESETS[name];
    if (preset.nav === !!panels.nav && preset.reading === !!panels.reading
      && preset.notebook === !!panels.notebook && preset.ai === !!panels.ai
      && preset.files === !!panels.files) {
      return name;
    }
  }
  return null;
}

export function clampNavWidth(px) {
  return Math.min(PANE_MAX.nav, Math.max(PANE_MIN.nav, Math.round(px)));
}

export function clampAiWidth(px) {
  return Math.min(PANE_MAX.ai, Math.max(PANE_MIN.ai, Math.round(px)));
}

export function clampFilesWidth(px) {
  return Math.min(PANE_MAX.files, Math.max(PANE_MIN.files, Math.round(px)));
}

/**
 * Split the reading+notebook combined width after a divider drag.
 * `readingPx` is the dragged reading width, `totalPx` the combined width
 * of both panes (constant during the drag). Each side keeps at least its
 * minimum; when the total is too small to honour both, the split is even.
 * Returns fractions summing to 1 (used as fr values, so the split stays
 * proportional when the window resizes).
 */
export function splitReadingNotebook(readingPx, totalPx) {
  const total = Math.max(0, totalPx);
  if (total <= PANE_MIN.reading + PANE_MIN.notebook) {
    return { readingFr: 0.5, notebookFr: 0.5 };
  }
  const reading = Math.min(
    total - PANE_MIN.notebook,
    Math.max(PANE_MIN.reading, readingPx),
  );
  const readingFr = reading / total;
  return { readingFr, notebookFr: 1 - readingFr };
}

/**
 * The reader's 9-column grid template for the given panels + widths.
 * Hidden panes and their adjacent dividers collapse to 0. The Files
 * panel is the rightmost column, after AI — its divider sits between
 * AI and Files, or between the working pane and Files when AI is off.
 */
export function gridTemplate(panels, widths) {
  const w = { ...PANE_DEFAULTS, ...(widths || {}) };
  const p = { nav: false, reading: true, notebook: true, ai: false, files: false, ...(panels || {}) };
  const nav = p.nav ? `${clampNavWidth(w.nav)}px` : '0px';
  const d1 = p.nav && p.reading ? `${DIVIDER_PX}px` : '0px';
  // fr tracks only fill the container when their factors sum to >= 1, so a
  // lone fr pane (Reading, or Navigation) takes 1fr, not its stored split
  // fraction — otherwise it would sit at half width with empty space.
  const readingFr = p.reading && !p.notebook ? 1 : w.readingFr;
  const reading = p.reading ? `minmax(0, ${readingFr}fr)` : '0px';
  const d2 = p.reading && p.notebook ? `${DIVIDER_PX}px` : '0px';
  const notebookFr = p.notebook && !p.reading ? 1 : w.notebookFr;
  const notebook = p.notebook ? `minmax(0, ${notebookFr}fr)` : '0px';
  const d3 = p.notebook && p.ai ? `${DIVIDER_PX}px` : '0px';
  const ai = p.ai ? `${clampAiWidth(w.ai)}px` : '0px';
  const d4 = p.files && (p.ai || p.notebook) ? `${DIVIDER_PX}px` : '0px';
  const files = p.files ? `${clampFilesWidth(w.files)}px` : '0px';
  return `${nav} ${d1} ${reading} ${d2} ${notebook} ${d3} ${ai} ${d4} ${files}`;
}

/** Sanitize a stored widths object (bad values fall back to defaults). */
export function sanitizeWidths(raw) {
  const out = { ...PANE_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  if (Number.isFinite(raw.nav)) out.nav = clampNavWidth(raw.nav);
  if (Number.isFinite(raw.ai)) out.ai = clampAiWidth(raw.ai);
  if (Number.isFinite(raw.files)) out.files = clampFilesWidth(raw.files);
  const rf = Number(raw.readingFr);
  const nf = Number(raw.notebookFr);
  if (Number.isFinite(rf) && Number.isFinite(nf) && rf > 0 && nf > 0) {
    out.readingFr = rf / (rf + nf);
    out.notebookFr = nf / (rf + nf);
  }
  return out;
}

/** Sanitize a stored panels object (unknown keys dropped, defaults kept). */
export function sanitizePanels(raw) {
  if (!raw || typeof raw !== 'object') return defaultPanels();
  return {
    nav: raw.nav === true,
    reading: raw.reading !== false,
    notebook: raw.notebook !== false,
    ai: raw.ai === true,
    files: raw.files === true,
  };
}

// ---------------------------------------------------------------------------
// Zoom — a multiplier on the width-fitting PDF scale (1 = fit width).
// ---------------------------------------------------------------------------

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 1.25;

export function clampZoom(z) {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** One zoom-in (+) / zoom-out (−) button step. */
export function zoomStep(zoom, dir) {
  const z = clampZoom(zoom);
  return clampZoom(dir >= 0 ? z * ZOOM_STEP : z / ZOOM_STEP);
}

/**
 * Ctrl/Cmd+wheel (and the trackpad pinch, which browsers deliver as wheel
 * events with ctrlKey set): exponential in the wheel delta so a pinch
 * gesture zooms smoothly instead of jumping a fixed step per event.
 */
export function zoomFromWheel(zoom, deltaY) {
  return clampZoom(clampZoom(zoom) * Math.exp(-deltaY * 0.002));
}

/** Safari gesture events: scale is relative to the gesture's start. */
export function zoomFromGesture(startZoom, scale) {
  return clampZoom(clampZoom(startZoom) * scale);
}

export function zoomPercent(zoom) {
  return Math.round(clampZoom(zoom) * 100);
}

/**
 * The width-fitting scale for a PDF page: the container's usable width
 * over the page's width in points, clamped so a very wide pane does not
 * render absurdly large and a narrow one stays legible.
 */
export function fitScale(availWidth, pageWidthPt) {
  if (!Number.isFinite(availWidth) || !Number.isFinite(pageWidthPt) || pageWidthPt <= 0) return 1;
  return Math.min(2, Math.max(0.5, availWidth / pageWidthPt));
}

// ---------------------------------------------------------------------------
// New-file naming — first free name for a base + extension.
// ---------------------------------------------------------------------------

/** `['note.md'] + ('note', '.md')` → `'note-2.md'`; free → `'note.md'`. */
export function firstFreeName(existingNames, base, ext) {
  const taken = new Set((existingNames || []).map((n) => String(n)));
  const cleanBase = String(base || 'untitled').trim() || 'untitled';
  if (!taken.has(`${cleanBase}${ext}`)) return `${cleanBase}${ext}`;
  for (let i = 2; i < 1000; i += 1) {
    const name = `${cleanBase}-${i}${ext}`;
    if (!taken.has(name)) return name;
  }
  return `${cleanBase}-${Date.now()}${ext}`;
}
