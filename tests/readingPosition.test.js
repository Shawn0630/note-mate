import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readingPositionKey, emptyReadingPosition, parseReadingPosition,
  recordReadingPosition, positionFor, storedPageOrDefault,
  recordVideoPosition, videoPositionFor,
} from '../public/readingPosition.js';

test('readingPositionKey: per-project localStorage key', () => {
  assert.equal(readingPositionKey('understanding-deep-learning'), 'nm-reading-position:understanding-deep-learning');
});

test('emptyReadingPosition: book, pdf tab, no positions', () => {
  assert.deepEqual(emptyReadingPosition(), { activeTab: 'pdf', activeSource: 'book', positions: {}, videoPositions: {} });
});

test('parseReadingPosition: valid store passes through', () => {
  const store = parseReadingPosition(JSON.stringify({
    activeTab: 'slides', activeSource: 'slides-chap4',
    positions: { book: 60, 'slides-chap4': 5 },
  }));
  assert.deepEqual(store, {
    activeTab: 'slides', activeSource: 'slides-chap4',
    positions: { book: 60, 'slides-chap4': 5 },
    videoPositions: {},
  });
});

test('parseReadingPosition: corrupt / wrong-typed input falls back to empty', () => {
  assert.deepEqual(parseReadingPosition('not json'), emptyReadingPosition());
  assert.deepEqual(parseReadingPosition(''), emptyReadingPosition());
  assert.deepEqual(parseReadingPosition(null), emptyReadingPosition());
  assert.deepEqual(parseReadingPosition(undefined), emptyReadingPosition());
  assert.deepEqual(parseReadingPosition(42), emptyReadingPosition());
  assert.deepEqual(parseReadingPosition([1, 2]), emptyReadingPosition());
  assert.deepEqual(parseReadingPosition(JSON.stringify({ activeTab: 'bogus', activeSource: '', positions: 'nope' })), emptyReadingPosition());
});

test('parseReadingPosition: bad pages and bad source ids are dropped, good ones kept', () => {
  const store = parseReadingPosition(JSON.stringify({
    activeTab: 'pdf', activeSource: 'book',
    positions: { book: 60, 'slides-chap4': 0, 'slides-chap2': -3, 'slides-chap3': 2.5, 'slides-chap5': '7', 'bad id': 4 },
  }));
  assert.deepEqual(store.positions, { book: 60, 'slides-chap5': 7 });
});

test('recordReadingPosition: per-source pages accumulate, switching sources keeps each own page', () => {
  let store = emptyReadingPosition();
  store = recordReadingPosition(store, { sourceId: 'book', page: 60, tab: 'pdf' });
  assert.deepEqual(store, { activeTab: 'pdf', activeSource: 'book', positions: { book: 60 }, videoPositions: {} });
  store = recordReadingPosition(store, { sourceId: 'slides-chap4', page: 5, tab: 'slides' });
  assert.deepEqual(store, {
    activeTab: 'slides', activeSource: 'slides-chap4',
    positions: { book: 60, 'slides-chap4': 5 },
    videoPositions: {},
  });
  // Back to the book at a new page: the deck keeps its slide.
  store = recordReadingPosition(store, { sourceId: 'book', page: 61, tab: 'pdf' });
  assert.deepEqual(store.positions, { book: 61, 'slides-chap4': 5 });
  assert.equal(store.activeSource, 'book');
});

test('recordReadingPosition: a view without a page updates the tab only', () => {
  let store = recordReadingPosition(emptyReadingPosition(), { sourceId: 'book', page: 60, tab: 'pdf' });
  store = recordReadingPosition(store, { tab: 'preview' });
  assert.equal(store.activeTab, 'preview');
  assert.deepEqual(store.positions, { book: 60 });
  assert.equal(store.activeSource, 'book');
});

test('recordReadingPosition: a source without a page moves the active source, keeps its stored page', () => {
  let store = recordReadingPosition(emptyReadingPosition(), { sourceId: 'book', page: 60, tab: 'pdf' });
  store = recordReadingPosition(store, { sourceId: 'slides-chap4', tab: 'slides' });
  assert.equal(store.activeSource, 'slides-chap4');
  assert.equal(store.activeTab, 'slides');
  assert.deepEqual(store.positions, { book: 60 });
});

test('recordReadingPosition: invalid page or source is ignored, input untouched', () => {
  const before = recordReadingPosition(emptyReadingPosition(), { sourceId: 'book', page: 60, tab: 'pdf' });
  const snapshot = JSON.stringify(before);
  assert.deepEqual(recordReadingPosition(before, { sourceId: 'book', page: 0, tab: 'pdf' }), before);
  assert.deepEqual(recordReadingPosition(before, { sourceId: 'book', page: 2.5, tab: 'pdf' }), before);
  assert.deepEqual(recordReadingPosition(before, { sourceId: '', page: 5, tab: 'pdf' }), before);
  assert.equal(JSON.stringify(before), snapshot);
});

test('positionFor: stored page or null', () => {
  const store = recordReadingPosition(emptyReadingPosition(), { sourceId: 'slides-chap4', page: 5, tab: 'slides' });
  assert.equal(positionFor(store, 'slides-chap4'), 5);
  assert.equal(positionFor(store, 'book'), null);
  assert.equal(positionFor(store, ''), null);
  assert.equal(positionFor(null, 'book'), null);
});

test('storedPageOrDefault: in-range stored page, else page 1', () => {
  const store = {
    activeTab: 'pdf', activeSource: 'book',
    positions: { book: 60, 'slides-chap4': 5, 'slides-chap2': 99 },
  };
  assert.equal(storedPageOrDefault(store, 'book', 500), 60);
  assert.equal(storedPageOrDefault(store, 'slides-chap4', 8), 5);
  // Out of range (deck has only 8 slides, book only 500 pages) -> 1.
  assert.equal(storedPageOrDefault(store, 'slides-chap2', 8), 1);
  assert.equal(storedPageOrDefault(store, 'book', 30), 1);
  // Nothing stored -> 1. Bad numPages -> 1.
  assert.equal(storedPageOrDefault(store, 'slides-chap9', 8), 1);
  assert.equal(storedPageOrDefault(store, 'book', 0), 1);
  assert.equal(storedPageOrDefault(store, 'book', null), 1);
});

test('parseReadingPosition: videoPositions pass through, bad seconds dropped', () => {
  const store = parseReadingPosition(JSON.stringify({
    activeTab: 'video', activeSource: 'lecture-1',
    positions: { book: 60 },
    videoPositions: { 'lecture-1': 320, 'lecture-2': 45, 'bad': 0, 'neg': -5, 'frac': 12.5, 'str': '90', 'bad id': 7 },
  }));
  assert.equal(store.activeTab, 'video');
  assert.equal(store.activeSource, 'lecture-1');
  assert.deepEqual(store.videoPositions, { 'lecture-1': 320, 'lecture-2': 45, str: 90 });
  // A store written before videoPositions existed parses with an empty map.
  assert.deepEqual(parseReadingPosition(JSON.stringify({ activeTab: 'pdf', activeSource: 'book', positions: {} })).videoPositions, {});
});

test('recordVideoPosition: per-video seconds are independent of pages', () => {
  let store = recordReadingPosition(emptyReadingPosition(), { sourceId: 'book', page: 60, tab: 'pdf' });
  store = recordVideoPosition(store, { sourceId: 'lecture-1', seconds: 320 });
  assert.equal(videoPositionFor(store, 'lecture-1'), 320);
  assert.equal(videoPositionFor(store, 'lecture-2'), null);
  assert.deepEqual(store.positions, { book: 60 });
  store = recordVideoPosition(store, { sourceId: 'lecture-2', seconds: 45 });
  assert.deepEqual(store.videoPositions, { 'lecture-1': 320, 'lecture-2': 45 });
  // Updating one video leaves the other alone.
  store = recordVideoPosition(store, { sourceId: 'lecture-1', seconds: 400 });
  assert.deepEqual(store.videoPositions, { 'lecture-1': 400, 'lecture-2': 45 });
  // The active tab/source is untouched by a video record.
  assert.equal(store.activeTab, 'pdf');
  assert.equal(store.activeSource, 'book');
});

test('recordVideoPosition: null / 0 / invalid seconds clear the entry', () => {
  let store = recordVideoPosition(emptyReadingPosition(), { sourceId: 'lecture-1', seconds: 320 });
  store = recordVideoPosition(store, { sourceId: 'lecture-1', seconds: null });
  assert.equal(videoPositionFor(store, 'lecture-1'), null);
  assert.deepEqual(store.videoPositions, {});
  store = recordVideoPosition(store, { sourceId: 'lecture-1', seconds: 120 });
  store = recordVideoPosition(store, { sourceId: 'lecture-1', seconds: 0 });
  assert.equal(videoPositionFor(store, 'lecture-1'), null);
  store = recordVideoPosition(store, { sourceId: 'lecture-1', seconds: 120 });
  store = recordVideoPosition(store, { sourceId: 'lecture-1', seconds: 12.5 });
  assert.equal(videoPositionFor(store, 'lecture-1'), null);
  // Bad source id: no change, input untouched.
  const before = recordVideoPosition(emptyReadingPosition(), { sourceId: 'lecture-1', seconds: 60 });
  const snapshot = JSON.stringify(before);
  assert.deepEqual(recordVideoPosition(before, { sourceId: '', seconds: 60 }), before);
  assert.equal(JSON.stringify(before), snapshot);
});

test('recordReadingPosition: video tab records the tab + video, no page', () => {
  let store = recordReadingPosition(emptyReadingPosition(), { sourceId: 'lecture-1', tab: 'video' });
  assert.equal(store.activeTab, 'video');
  assert.equal(store.activeSource, 'lecture-1');
  assert.deepEqual(store.positions, {});
  assert.deepEqual(store.videoPositions, {});
});
