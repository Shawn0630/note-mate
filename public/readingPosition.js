/* Reading position: where the reader was, per project AND per source.
   Pure functions — no DOM — so they are unit-testable in node.
   The store is one localStorage entry per project slug:
     { activeTab, activeSource, positions, videoPositions }
   - activeTab: the left tab he was on ('pdf' | 'slides' | 'preview' | 'video').
   - activeSource: the source of that tab ('book' or a material id).
   - positions: { [sourceId]: page } — the last page/slide seen for EACH
     source. The book remembers its own page, each extra PDF remembers
     its own page, each slides deck remembers its own slide, so switching
     tabs/sources returns to THAT source's own page, and a refresh or
     reopen restores the last-active source at its page.
   - videoPositions: { [materialId]: seconds } — the playback position in
     seconds for EACH YouTube video material, independent per video.
     A video with no entry starts at 0; finishing a video clears its
     entry, so the next open starts from the beginning.
   Pages are 1-based. A stored page is only trusted when it is in range
   for the document actually loaded (checked by the caller, which knows
   numPages); out-of-range / unknown-source stores fall back to page 1. */
export const READING_POSITION_KEY_PREFIX = 'nm-reading-position:';
export const READING_POSITION_TABS = ['pdf', 'slides', 'preview', 'video'];

export function readingPositionKey(slug) {
  return `${READING_POSITION_KEY_PREFIX}${slug}`;
}

export function emptyReadingPosition() {
  return { activeTab: 'pdf', activeSource: 'book', positions: {}, videoPositions: {} };
}

function cleanPage(page) {
  const n = Number(page);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function cleanSourceId(sourceId) {
  const s = String(sourceId ?? '').trim();
  return s && !/\s/.test(s) ? s : null;
}

/* Parse a stored value (JSON string, or an already-parsed object) into a
   sanitized store. Anything malformed, wrong-typed or out of shape falls
   back to the empty store — a corrupt entry must never block opening. */
export function parseReadingPosition(raw) {
  const empty = emptyReadingPosition();
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return empty;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return empty;
  const activeTab = READING_POSITION_TABS.includes(obj.activeTab) ? obj.activeTab : 'pdf';
  const activeSource = cleanSourceId(obj.activeSource) || 'book';
  const positions = {};
  const rawPositions = obj.positions;
  if (rawPositions && typeof rawPositions === 'object' && !Array.isArray(rawPositions)) {
    for (const [sourceId, page] of Object.entries(rawPositions)) {
      const cleanId = cleanSourceId(sourceId);
      const cleanPg = cleanPage(page);
      if (cleanId && cleanPg != null) positions[cleanId] = cleanPg;
    }
  }
  const videoPositions = {};
  const rawVideoPositions = obj.videoPositions;
  if (rawVideoPositions && typeof rawVideoPositions === 'object' && !Array.isArray(rawVideoPositions)) {
    for (const [sourceId, seconds] of Object.entries(rawVideoPositions)) {
      const cleanId = cleanSourceId(sourceId);
      const cleanSec = cleanSeconds(seconds);
      if (cleanId && cleanSec != null) videoPositions[cleanId] = cleanSec;
    }
  }
  return { activeTab, activeSource, positions, videoPositions };
}

/* A video position is whole seconds, at least 1 — 0 means "at the start",
   which needs no entry. Anything else (negative, fractional, non-numeric)
   is dropped, like a bad page. */
function cleanSeconds(seconds) {
  const n = Number(seconds);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/* Record a view: the source's page updates, and it becomes the active
   source/tab. Returns a NEW store; the input is untouched. A view without
   a page updates the active source/tab only and leaves the per-source
   positions alone — that covers the Preview tab (it shows a note, not a
   page, so opening it never overwrites the book page he was on) and a
   source the reader just switched to but has not read yet in this
   session (a fresh load leaves every source but the active one at the
   top — recording that top-of-document page would clobber the stored
   position before it is ever restored). */
export function recordReadingPosition(store, { sourceId, page, tab } = {}) {
  const base = parseReadingPosition(store);
  const cleanTab = READING_POSITION_TABS.includes(tab) ? tab : base.activeTab;
  const cleanId = cleanSourceId(sourceId);
  const cleanPg = cleanPage(page);
  if (cleanId && cleanPg != null) {
    return {
      ...base,
      activeTab: cleanTab,
      activeSource: cleanId,
      positions: { ...base.positions, [cleanId]: cleanPg },
    };
  }
  if (cleanId) {
    return { ...base, activeTab: cleanTab, activeSource: cleanId };
  }
  return { ...base, activeTab: cleanTab };
}

/* The stored page for a source, or null when nothing is stored for it. */
export function positionFor(store, sourceId) {
  const base = parseReadingPosition(store);
  const cleanId = cleanSourceId(sourceId);
  if (!cleanId) return null;
  const page = base.positions[cleanId];
  return page != null ? page : null;
}

/* The page to restore for a source given the document actually loaded:
   the stored page when it is in range, else page 1 (the graceful fallback
   for a stale store — a page that no longer exists, or a source whose
   document shrank). numPages must be a positive integer; anything else
   also falls back to page 1. */
export function storedPageOrDefault(store, sourceId, numPages) {
  const total = Number(numPages);
  if (!Number.isInteger(total) || total < 1) return 1;
  const page = positionFor(store, sourceId);
  if (page == null || page < 1 || page > total) return 1;
  return page;
}

/* Record a video's playback position in whole seconds. Returns a NEW
   store; the input is untouched. seconds >= 1 stores it; null / 0 / an
   invalid value CLEARS the entry — the video starts from the beginning
   next time (used when a video finishes, or when it is back at the
   start). Positions are per video, independent of the page positions. */
export function recordVideoPosition(store, { sourceId, seconds } = {}) {
  const base = parseReadingPosition(store);
  const cleanId = cleanSourceId(sourceId);
  if (!cleanId) return base;
  const cleanSec = cleanSeconds(seconds);
  const videoPositions = { ...base.videoPositions };
  if (cleanSec == null) delete videoPositions[cleanId];
  else videoPositions[cleanId] = cleanSec;
  return { ...base, videoPositions };
}

/* The stored playback position in seconds for a video, or null when
   nothing is stored for it (starts from the beginning). */
export function videoPositionFor(store, sourceId) {
  const base = parseReadingPosition(store);
  const cleanId = cleanSourceId(sourceId);
  if (!cleanId) return null;
  const seconds = base.videoPositions[cleanId];
  return seconds != null ? seconds : null;
}
