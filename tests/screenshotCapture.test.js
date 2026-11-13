import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveScreenshotTarget, pageCanvasSelector, pageHolderSelector } from '../public/screenshotCapture.js';

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
