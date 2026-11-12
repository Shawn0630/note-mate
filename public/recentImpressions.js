/* Recent impressions: the pages/slides the reader has looked at in the
   last few minutes, most recent first. Pure functions — no DOM — so they
   are unit-testable in node. The Page anchor quick action offers these in
   a dropdown, so the user can anchor to something he was just looking at,
   not only the page he is on now.
   An entry is {sourceId, page, at} (at = Date.now() ms). Consecutive views
   of the same page collapse to the latest timestamp; the list is capped. */
export const RECENT_WINDOW_MS = 5 * 60 * 1000;
export const RECENT_MAX = 8;

/* Record a view. Returns the new list (most recent first): drops entries
   older than the window, collapses a repeat of the current head, caps. */
export function recordImpression(list, entry, now = Date.now()) {
  const at = entry.at ?? now;
  const fresh = (list || []).filter((e) => now - e.at <= RECENT_WINDOW_MS);
  if (fresh.length && fresh[0].sourceId === entry.sourceId && fresh[0].page === entry.page) {
    fresh[0] = { ...fresh[0], at };
    return fresh;
  }
  return [{ sourceId: entry.sourceId, page: entry.page, at }, ...fresh].slice(0, RECENT_MAX);
}

/* The entries still inside the window, most recent first. */
export function recentImpressions(list, now = Date.now()) {
  return (list || []).filter((e) => now - e.at <= RECENT_WINDOW_MS);
}

/* "just now" under a minute, else "N min ago". */
export function relativeTimeLabel(at, now = Date.now()) {
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return 'just now';
  return mins === 1 ? '1 min ago' : `${mins} min ago`;
}

/* Dropdown label for an impression. `meta` carries what the label needs:
   {chapterTitle} for book pages, {material} ({label, kind}) for materials.
   Book: "p. 55 · Deep neural networks"; deck: "Slide 2 · Deep Neural
   Networks"; another PDF: "p. 3 · Appendix". */
export function impressionLabel(entry, meta = {}) {
  if (!entry) return '';
  if (entry.sourceId === 'book') {
    return meta.chapterTitle ? `p. ${entry.page} · ${meta.chapterTitle}` : `p. ${entry.page}`;
  }
  const kind = String(meta.material?.kind || '').toLowerCase();
  const label = meta.material?.label || entry.sourceId;
  if (kind === 'slides' || (meta.material == null && String(entry.sourceId).startsWith('slides-'))) {
    return `Slide ${entry.page} · ${label}`;
  }
  return `p. ${entry.page} · ${label}`;
}
