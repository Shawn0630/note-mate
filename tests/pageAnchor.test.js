import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPageAnchor, parsePageAnchors, anchorChipLabel, PAGE_ANCHOR_SOURCE_BOOK,
} from '../src/pageAnchor.js';

test('formatPageAnchor: book and deck anchors, rejects bad page/source', () => {
  assert.equal(formatPageAnchor({ page: 100, sourceId: 'book' }), '<!-- @page 100 · source: book -->');
  assert.equal(formatPageAnchor({ page: 12, sourceId: 'slides-chap2' }), '<!-- @page 12 · source: slides-chap2 -->');
  assert.equal(formatPageAnchor({ page: '25' }), '<!-- @page 25 · source: book -->');
  assert.throws(() => formatPageAnchor({ page: 0 }), /positive integer/);
  assert.throws(() => formatPageAnchor({ page: 1.5 }), /positive integer/);
  assert.throws(() => formatPageAnchor({ page: 'abc' }), /positive integer/);
  assert.throws(() => formatPageAnchor({ page: 3, sourceId: 'has space' }), /without spaces/);
});

test('parsePageAnchors: finds anchors in order with page + source', () => {
  const text = [
    '# Book', '', '## 2. Supervised learning', '',
    '<!-- @page 25 · source: book -->', '', 'Some notes.',
    '<!-- @page 12 · source: slides-chap2 -->', '',
    '<!-- p. 99 -->', // the seed's older convention is NOT an anchor
    '<!-- @page 3 · source: book -->',
  ].join('\n');
  assert.deepEqual(parsePageAnchors(text).map(({ page, sourceId }) => ({ page, sourceId })), [
    { page: 25, sourceId: 'book' },
    { page: 12, sourceId: 'slides-chap2' },
    { page: 3, sourceId: 'book' },
  ]);
  assert.deepEqual(parsePageAnchors('# No anchors here\n\nplain text.'), []);
  assert.deepEqual(parsePageAnchors(''), []);
});

test('anchorChipLabel: book is just the page, a deck names the deck', () => {
  assert.equal(anchorChipLabel({ page: 100, sourceId: 'book' }), 'p. 100');
  assert.equal(anchorChipLabel({ page: 100, sourceId: PAGE_ANCHOR_SOURCE_BOOK }), 'p. 100');
  assert.equal(anchorChipLabel({ page: 12, sourceId: 'slides-chap2' }, 'Supervised Learning'), 'Supervised Learning · p. 12');
  assert.equal(anchorChipLabel({ page: 12, sourceId: 'slides-chap2' }), 'slides-chap2 · p. 12');
  assert.equal(anchorChipLabel(null), '');
});
