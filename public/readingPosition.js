/* Reading position: where the reader was, per project AND per source.
   Pure functions — no DOM — so they are unit-testable in node.
   The store is one localStorage entry per project slug:
     { activeTab, activeSource, positions }
   - activeTab: the left tab he was on ('pdf' | 'slides' | 'preview').
   - activeSource: the source of that tab ('book' or a material id).
   - positions: { [sourceId]: page } — the last page/slide seen for EACH
     source. The book remembers its own page, each extra PDF remembers
     its own page, each slides deck remembers its own slide, so switching
     tabs/sources returns to THAT source's own page, and a refresh or
     reopen restores the last-active source at its page.
   Pages are 1-based. A stored page is only trusted when it is in range
   for the document actually loaded (checked by the caller, which knows
   numPages); out-of-range / unknown-source stores fall back to page 1. */
export const READING_POSITION_KEY_PREFIX = 'nm-reading-position:';
export const READING_POSITION_TABS = ['pdf', 'slides', 'preview'];

export function readingPositionKey(slug) {
  return `${READING_POSITION_KEY_PREFIX}${slug}`;
}

export function emptyReadingPosition() {
  return { activeTab: 'pdf', activeSource: 'book', positions: {} };
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
  return { activeTab, activeSource, positions };
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
