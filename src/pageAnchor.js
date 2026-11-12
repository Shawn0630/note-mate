// Page anchors: a note block can be anchored to a page of the book PDF or a
// slide of a slide deck. The anchor lives IN notes.md as an HTML comment
// attached to the block — the single source of truth, never a second copy in
// project.json (which would drift). Format:
//
//   <!-- @page 100 · source: book -->
//   <!-- @page 12 · source: slides-chap2 -->
//
// 'book' is the project's main PDF; anything else is a material id (deck).
// The seed already writes `<!-- p. N -->` comments; this is the same
// convention with the source made explicit so a chip can jump back to it.

export const PAGE_ANCHOR_SOURCE_BOOK = 'book';

export function formatPageAnchor({ page, sourceId }) {
  const n = Number(page);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('page must be a positive integer');
  }
  const src = String(sourceId || PAGE_ANCHOR_SOURCE_BOOK).trim();
  if (!src || /\s/.test(src)) {
    throw new Error('sourceId must be a non-empty token without spaces');
  }
  return `<!-- @page ${n} · source: ${src} -->`;
}

// Scan markdown text for anchor comments. Returns [{page, sourceId, index}]
// in document order (index = offset of the comment in the text).
export function parsePageAnchors(text) {
  const out = [];
  const re = /<!--\s*@page\s+(\d+)\s*·\s*source:\s*([^\s>]+)\s*-->/g;
  for (const m of String(text ?? '').matchAll(re)) {
    out.push({ page: Number(m[1]), sourceId: m[2], index: m.index });
  }
  return out;
}

// Chip label for an anchor. The material label (e.g. "Supervised Learning")
// is the deck's display name; falls back to the raw id.
export function anchorChipLabel(anchor, materialLabel) {
  if (!anchor) return '';
  if (anchor.sourceId === PAGE_ANCHOR_SOURCE_BOOK) return `p. ${anchor.page}`;
  return `${materialLabel || anchor.sourceId} · p. ${anchor.page}`;
}
