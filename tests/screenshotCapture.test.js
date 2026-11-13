import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveScreenshotTarget, pageCanvasSelector, pageHolderSelector,
  normalizeSelectionRect, isClickSelection, cropRegionToCanvas,
} from '../public/screenshotCapture.js';

test('resolveScreenshotTarget: PDF tab captures the book page', () => {
  assert.deepEqual(
    resolveScreenshotTarget({ kind: 'pdf', leftTab: 'pdf', pdfPage: 15, deckPage: 3, hasPdfContainer: true, hasDeckContainer: true }),
    { container: 'pdf', page: 15 });
});

test('resolveScreenshotTarget: Slides tab captures the deck slide', () => {
  assert.deepEqual(
    resolveScreenshotTarget({ kind: 'pdf', leftTab: 'slides', pdfPage: 15, deckPage: 5, hasPdfContainer: true, hasDeckContainer: true }),
    { container: 'deck', page: 5 });
});

test('resolveScreenshotTarget: Markdown preview tab has no canvas', () => {
  assert.deepEqual(
    resolveScreenshotTarget({ kind: 'pdf', leftTab: 'preview', pdfPage: 15, deckPage: 5, hasPdfContainer: true, hasDeckContainer: true }),
    { error: 'no-canvas' });
});

test('resolveScreenshotTarget: non-PDF projects have no canvas', () => {
  for (const kind of ['video', 'slides', 'ppt', undefined, null, '']) {
    assert.deepEqual(
      resolveScreenshotTarget({ kind, leftTab: 'pdf', pdfPage: 1, deckPage: 1, hasPdfContainer: true, hasDeckContainer: true }),
      { error: 'no-canvas' }, `kind=${kind}`);
  }
});

test('resolveScreenshotTarget: missing viewer container has no canvas', () => {
  assert.deepEqual(
    resolveScreenshotTarget({ kind: 'pdf', leftTab: 'pdf', pdfPage: 1, deckPage: 1, hasPdfContainer: false, hasDeckContainer: true }),
    { error: 'no-canvas' });
  assert.deepEqual(
    resolveScreenshotTarget({ kind: 'pdf', leftTab: 'slides', pdfPage: 1, deckPage: 1, hasPdfContainer: true, hasDeckContainer: false }),
    { error: 'no-canvas' });
});

test('pageCanvasSelector: selects the page holder canvas', () => {
  assert.equal(pageCanvasSelector(15), '.pdf-page[data-page="15"] canvas');
  assert.equal(pageCanvasSelector(1), '.pdf-page[data-page="1"] canvas');
});

test('pageHolderSelector: selects the page holder', () => {
  assert.equal(pageHolderSelector(15), '.pdf-page[data-page="15"]');
  assert.equal(pageHolderSelector(1), '.pdf-page[data-page="1"]');
});

test('normalizeSelectionRect: drag in either direction normalizes', () => {
  assert.deepEqual(normalizeSelectionRect(10, 20, 50, 80), { x: 10, y: 20, width: 40, height: 60 });
  assert.deepEqual(normalizeSelectionRect(50, 80, 10, 20), { x: 10, y: 20, width: 40, height: 60 });
  assert.deepEqual(normalizeSelectionRect(30, 30, 30, 30), { x: 30, y: 30, width: 0, height: 0 });
});

test('isClickSelection: below threshold in both dims is a click', () => {
  assert.equal(isClickSelection({ x: 0, y: 0, width: 0, height: 0 }), true);
  assert.equal(isClickSelection({ x: 0, y: 0, width: 3, height: 3 }), true);
  assert.equal(isClickSelection({ x: 0, y: 0, width: 3, height: 100 }), false);
  assert.equal(isClickSelection({ x: 0, y: 0, width: 100, height: 3 }), false);
  assert.equal(isClickSelection({ x: 0, y: 0, width: 40, height: 60 }), false);
});

// Canvas at 1x: rect 100x200 at (50, 60), canvas 750x1000 at (0, 0).
const C1 = { canvasRect: { x: 0, y: 0, width: 750, height: 1000 }, canvasWidth: 750, canvasHeight: 1000 };

test('cropRegionToCanvas: selection inside the canvas maps 1:1', () => {
  assert.deepEqual(
    cropRegionToCanvas({ ...C1, sel: { x: 100, y: 200, width: 300, height: 150 } }),
    { sx: 100, sy: 200, sw: 300, sh: 150 });
});

test('cropRegionToCanvas: 2x canvas scale doubles the pixels', () => {
  assert.deepEqual(
    cropRegionToCanvas({
      canvasRect: { x: 100, y: 50, width: 750, height: 1000 },
      canvasWidth: 1500, canvasHeight: 2000,
      sel: { x: 200, y: 150, width: 300, height: 150 },
    }),
    { sx: 200, sy: 200, sw: 600, sh: 300 });
});

test('cropRegionToCanvas: selection partly outside is clamped to the canvas', () => {
  assert.deepEqual(
    cropRegionToCanvas({ ...C1, sel: { x: -100, y: -50, width: 300, height: 200 } }),
    { sx: 0, sy: 0, sw: 200, sh: 150 });
  assert.deepEqual(
    cropRegionToCanvas({ ...C1, sel: { x: 600, y: 900, width: 300, height: 300 } }),
    { sx: 600, sy: 900, sw: 150, sh: 100 });
});

test('cropRegionToCanvas: selection fully outside the canvas', () => {
  for (const sel of [
    { x: -300, y: 100, width: 100, height: 100 }, // left
    { x: 800, y: 100, width: 100, height: 100 }, // right
    { x: 100, y: -200, width: 100, height: 100 }, // above
    { x: 100, y: 1100, width: 100, height: 100 }, // below
    { x: 100, y: 100, width: 0, height: 0 }, // empty
  ]) {
    assert.deepEqual(cropRegionToCanvas({ ...C1, sel }), { error: 'outside' }, JSON.stringify(sel));
  }
});

test('cropRegionToCanvas: overlap too small in canvas pixels', () => {
  assert.deepEqual(
    cropRegionToCanvas({ ...C1, sel: { x: 100, y: 100, width: 30, height: 2 } }),
    { error: 'too-small' });
  assert.deepEqual(
    cropRegionToCanvas({ ...C1, sel: { x: 100, y: 100, width: 2, height: 30 } }),
    { error: 'too-small' });
  // 4px in each dimension is enough.
  assert.deepEqual(
    cropRegionToCanvas({ ...C1, sel: { x: 100, y: 100, width: 4, height: 4 } }),
    { sx: 100, sy: 100, sw: 4, sh: 4 });
});

test('cropRegionToCanvas: degenerate canvas resolves to outside', () => {
  assert.deepEqual(
    cropRegionToCanvas({ canvasRect: { x: 0, y: 0, width: 0, height: 0 }, canvasWidth: 750, canvasHeight: 1000, sel: { x: 0, y: 0, width: 10, height: 10 } }),
    { error: 'outside' });
  assert.deepEqual(
    cropRegionToCanvas({ canvasRect: { x: 0, y: 0, width: 750, height: 1000 }, canvasWidth: 0, canvasHeight: 0, sel: { x: 0, y: 0, width: 10, height: 10 } }),
    { error: 'outside' });
});
