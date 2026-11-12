// PDF annotations (highlight + note pin) — pure validation / normalization.
// Storage is one per-project file, `annotations.json` beside `notes/`
// (see server.js); annotations are separate from notes.md and survive the
// master-notes migration untouched (the migration only touches notes/).
// An annotation:
//   { id, source, page, type, rect, color, text, createdAt, updatedAt }
//   source: 'book' (the project PDF) or a deck material id
//   page:   1-based page / slide number
//   type:   'highlight' | 'note'
//   rect:   normalized {x, y, w, h} in 0..1, relative to the page box.
//           A note pin is a point: w = h = 0.
//   color:  one of ANNOTATION_COLORS (pins render in their color too)
//   text:   the note text (notes only; '' for highlights)
import { randomUUID } from 'node:crypto';

export const ANNOTATIONS_FILE = 'annotations.json';
export const ANNOTATION_COLORS = ['yellow', 'green', 'pink', 'blue'];
export const ANNOTATION_TYPES = ['highlight', 'note'];
export const MAX_NOTE_TEXT = 2000;

export function emptyAnnotationsDoc() {
  return { version: 1, annotations: [] };
}

/** Parse a stored annotations doc; empty/missing input is an empty doc.
 * Throws on malformed JSON (the server surfaces it instead of silently
 * dropping the user's annotations). */
export function parseAnnotationsDoc(raw) {
  if (raw == null || String(raw).trim() === '') return emptyAnnotationsDoc();
  const doc = JSON.parse(String(raw));
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.annotations)) {
    throw new Error('annotations file is not a {annotations: []} document');
  }
  return { version: 1, annotations: doc.annotations };
}

export function newAnnotationId() {
  return `a-${randomUUID()}`;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Clamp a rect into the unit square (drag overshoot past a page edge
 * clamps instead of rejecting). w/h stay >= 0. */
export function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') throw new Error('rect {x, y, w, h} is required');
  const { x, y, w, h } = rect;
  if (![x, y, w, h].every(isFiniteNumber)) {
    throw new Error('rect x/y/w/h must be finite numbers');
  }
  const cx = Math.min(1, Math.max(0, x));
  const cy = Math.min(1, Math.max(0, y));
  const cw = Math.min(1 - cx, Math.max(0, w));
  const ch = Math.min(1 - cy, Math.max(0, h));
  return { x: cx, y: cy, w: cw, h: ch };
}

/** Validate a full annotation body (POST) or a merged existing+patch
 * (PUT) and return the sanitized fields. Unknown fields are dropped. */
export function validateAnnotationInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('annotation body (object) is required');
  }
  const source = typeof input.source === 'string' ? input.source.trim() : '';
  if (!source) throw new Error('source (string) is required');
  const page = Number(input.page);
  if (!Number.isInteger(page) || page < 1) {
    throw new Error('page (positive integer) is required');
  }
  const type = typeof input.type === 'string' ? input.type.trim().toLowerCase() : '';
  if (!ANNOTATION_TYPES.includes(type)) {
    throw new Error(`type must be one of: ${ANNOTATION_TYPES.join(', ')}`);
  }
  const rect = normalizeRect(input.rect);
  if (type === 'highlight' && (rect.w <= 0 || rect.h <= 0)) {
    throw new Error('a highlight needs a non-empty rect (drag a rectangle)');
  }
  const color = typeof input.color === 'string' ? input.color.trim().toLowerCase() : '';
  if (input.text !== undefined && typeof input.text !== 'string') {
    throw new Error('text must be a string');
  }
  const text = typeof input.text === 'string' ? input.text : '';
  if (text.length > MAX_NOTE_TEXT) {
    throw new Error(`text must be at most ${MAX_NOTE_TEXT} characters`);
  }
  return {
    source,
    page,
    type,
    rect,
    color: ANNOTATION_COLORS.includes(color) ? color : 'yellow',
    text: type === 'note' ? text : '',
  };
}
