// PDF annotations (highlight + note pin): pure validation / normalization
// for the per-project annotations.json store (see src/server.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANNOTATIONS_FILE, ANNOTATION_COLORS,
  emptyAnnotationsDoc, parseAnnotationsDoc, newAnnotationId,
  normalizeRect, validateAnnotationInput,
} from '../src/annotations.js';

test('annotations file + empty doc', () => {
  assert.equal(ANNOTATIONS_FILE, 'annotations.json');
  assert.deepEqual(emptyAnnotationsDoc(), { version: 1, annotations: [] });
  assert.deepEqual(parseAnnotationsDoc(''), { version: 1, annotations: [] });
  assert.deepEqual(parseAnnotationsDoc(null), { version: 1, annotations: [] });
  assert.throws(() => parseAnnotationsDoc('{bad json'), /Unexpected token|not valid JSON|Expected/);
  assert.throws(() => parseAnnotationsDoc('{"annotations": {}}'), /annotations: \[\]/);
});

test('newAnnotationId: unique, prefixed', () => {
  const a = newAnnotationId();
  const b = newAnnotationId();
  assert.ok(a.startsWith('a-'));
  assert.notEqual(a, b);
});

test('normalizeRect: clamps into the unit square', () => {
  assert.deepEqual(normalizeRect({ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }), { x: 0.1, y: 0.2, w: 0.3, h: 0.05 });
  assert.deepEqual(normalizeRect({ x: -0.1, y: 1.2, w: 2, h: 2 }), { x: 0, y: 1, w: 1, h: 0 });
  const edge = normalizeRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 });
  assert.equal(edge.x, 0.9);
  assert.equal(edge.y, 0.9);
  assert.ok(Math.abs(edge.w - 0.1) < 1e-9); // 1 - 0.9 in floating point
  assert.ok(Math.abs(edge.h - 0.1) < 1e-9);
  assert.deepEqual(normalizeRect({ x: 0.5, y: 0.5, w: 0, h: 0 }), { x: 0.5, y: 0.5, w: 0, h: 0 });
  assert.throws(() => normalizeRect(null), /rect/);
  assert.throws(() => normalizeRect({ x: 0, y: 0, w: NaN, h: 0 }), /finite/);
});

test('validateAnnotationInput: highlight + note pin', () => {
  const hl = validateAnnotationInput({
    source: 'book', page: 100, type: 'highlight',
    rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 }, color: 'green', text: 'ignored for highlights',
  });
  assert.equal(hl.source, 'book');
  assert.equal(hl.page, 100);
  assert.equal(hl.type, 'highlight');
  assert.equal(hl.color, 'green');
  assert.equal(hl.text, ''); // highlights carry no text
  const pin = validateAnnotationInput({
    source: 'slides-chap4', page: 3, type: 'note',
    rect: { x: 0.5, y: 0.5, w: 0, h: 0 }, color: 'pink', text: 'remember this',
  });
  assert.equal(pin.type, 'note');
  assert.equal(pin.text, 'remember this');
  assert.deepEqual(pin.rect, { x: 0.5, y: 0.5, w: 0, h: 0 });
  // Unknown color falls back to yellow; unknown fields are dropped.
  const def = validateAnnotationInput({
    source: 'book', page: 1, type: 'highlight',
    rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, color: 'magenta', bogus: 1,
  });
  assert.equal(def.color, 'yellow');
  assert.equal(def.bogus, undefined);
});

test('validateAnnotationInput: rejects bad input', () => {
  const base = { source: 'book', page: 1, type: 'highlight', rect: { x: 0, y: 0, w: 0.1, h: 0.1 } };
  assert.throws(() => validateAnnotationInput(null), /required/);
  assert.throws(() => validateAnnotationInput({ ...base, source: '' }), /source/);
  assert.throws(() => validateAnnotationInput({ ...base, page: 0 }), /page/);
  assert.throws(() => validateAnnotationInput({ ...base, page: 1.5 }), /page/);
  assert.throws(() => validateAnnotationInput({ ...base, type: 'freehand' }), /type must be/);
  assert.throws(() => validateAnnotationInput({ ...base, rect: { x: 0, y: 0, w: 0, h: 0 } }), /non-empty rect/);
  assert.throws(() => validateAnnotationInput({ ...base, type: 'note', rect: { x: 0, y: 0, w: 0, h: 0 }, text: 42 }), /text must be a string/);
  assert.throws(() => validateAnnotationInput({ ...base, type: 'note', rect: { x: 0, y: 0, w: 0, h: 0 }, text: 'x'.repeat(2001) }), /at most 2000/);
  assert.equal(ANNOTATION_COLORS.join(','), 'yellow,green,pink,blue');
});
