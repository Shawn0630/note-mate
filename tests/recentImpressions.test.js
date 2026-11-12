import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordImpression, recentImpressions, relativeTimeLabel, impressionLabel,
  RECENT_WINDOW_MS, RECENT_MAX,
} from '../public/recentImpressions.js';

const T0 = 1_000_000_000_000;

test('recordImpression: most recent first, repeat of the head collapses', () => {
  let list = [];
  list = recordImpression(list, { sourceId: 'book', page: 55 }, T0);
  list = recordImpression(list, { sourceId: 'book', page: 60 }, T0 + 30_000);
  assert.deepEqual(list.map((e) => e.page), [60, 55]);
  // Same page again: no duplicate, timestamp refreshed.
  list = recordImpression(list, { sourceId: 'book', page: 60 }, T0 + 45_000);
  assert.deepEqual(list.map((e) => e.page), [60, 55]);
  assert.equal(list[0].at, T0 + 45_000);
  // A different page in between, then back: a new entry (not a collapse).
  list = recordImpression(list, { sourceId: 'slides-chap2', page: 2 }, T0 + 60_000);
  list = recordImpression(list, { sourceId: 'book', page: 60 }, T0 + 70_000);
  assert.deepEqual(list.map((e) => `${e.sourceId}:${e.page}`), ['book:60', 'slides-chap2:2', 'book:60', 'book:55']);
});

test('recordImpression: cap and 5-minute window', () => {
  let list = [];
  for (let i = 1; i <= RECENT_MAX + 3; i++) {
    list = recordImpression(list, { sourceId: 'book', page: i }, T0 + i * 1000);
  }
  assert.equal(list.length, RECENT_MAX);
  assert.equal(list[0].page, RECENT_MAX + 3);
  // Everything older than the window drops on the next record.
  list = recordImpression(list, { sourceId: 'book', page: 99 }, T0 + RECENT_WINDOW_MS + 60_000);
  assert.deepEqual(list.map((e) => e.page), [99]);
});

test('recentImpressions: filters to the window, keeps order', () => {
  const list = [
    { sourceId: 'book', page: 60, at: T0 },
    { sourceId: 'book', page: 55, at: T0 - RECENT_WINDOW_MS - 1 },
    { sourceId: 'slides-chap2', page: 2, at: T0 - 60_000 },
  ];
  assert.deepEqual(recentImpressions(list, T0).map((e) => e.page), [60, 2]);
  assert.deepEqual(recentImpressions(list, T0 + RECENT_WINDOW_MS + 1), []);
});

test('relativeTimeLabel: just now, minutes', () => {
  assert.equal(relativeTimeLabel(T0, T0 + 5_000), 'just now');
  assert.equal(relativeTimeLabel(T0, T0 + 59_000), 'just now');
  assert.equal(relativeTimeLabel(T0, T0 + 60_000), '1 min ago');
  assert.equal(relativeTimeLabel(T0, T0 + 4 * 60_000 + 30_000), '4 min ago');
});

test('impressionLabel: book chapter, deck, extra PDF', () => {
  assert.equal(
    impressionLabel({ sourceId: 'book', page: 55 }, { chapterTitle: 'Deep neural networks' }),
    'p. 55 · Deep neural networks',
  );
  assert.equal(impressionLabel({ sourceId: 'book', page: 55 }, {}), 'p. 55');
  assert.equal(
    impressionLabel({ sourceId: 'slides-chap2', page: 2 }, { material: { label: 'Deep Neural Networks', kind: 'slides' } }),
    'Slide 2 · Deep Neural Networks',
  );
  assert.equal(
    impressionLabel({ sourceId: 'extra-pdf', page: 3 }, { material: { label: 'Appendix', kind: 'pdf' } }),
    'p. 3 · Appendix',
  );
  assert.equal(impressionLabel(null), '');
});
