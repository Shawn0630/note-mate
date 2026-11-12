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

// Chip label for an anchor. `material` is the material the anchor points
// at ({label, kind}) or null for the book. A deck reads "Slide N", any other
// PDF material reads "p. N · <label>" (the label disambiguates it from the
// book), the book reads "p. N".
export function anchorChipLabel(anchor, material) {
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

// Where does an anchor jump? 'book' is the project's main PDF; anything
// else is a material id. Returns {target:'book'}, {target:'material', id,
// kind} (kind 'slides' = deck, 'pdf' = a PDF document), or
// {target:'unknown'} when the id is not a readable material of this
// project. The anchor FORMAT already names any material by id — this is
// the resolution half that makes jumping work across all of them.
export function resolveAnchorTarget(sourceId, materials) {
  if (!sourceId || sourceId === PAGE_ANCHOR_SOURCE_BOOK) return { target: 'book' };
  const mat = (materials || []).find((m) => String(m.id) === String(sourceId));
  if (!mat || mat.hasFile === false) return { target: 'unknown' };
  const kind = String(mat.kind || '').toLowerCase();
  if (kind !== 'slides' && kind !== 'pdf') return { target: 'unknown' };
  return { target: 'material', id: mat.id, kind };
}

/** The project's extra PDF documents (kind 'pdf'), i.e. the ones the PDF
    tab's picker offers next to the book. Decks (kind 'slides') live in the
    Slides tab instead. */
export function pdfMaterials(materials) {
  return (materials || []).filter((m) => String(m.kind || '').toLowerCase() === 'pdf'
    && m.hasFile !== false);
}
