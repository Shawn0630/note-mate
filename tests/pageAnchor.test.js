import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPageAnchor, parsePageAnchors, anchorChipLabel, resolveAnchorTarget,
  pdfMaterials, PAGE_ANCHOR_SOURCE_BOOK,
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

test('anchorChipLabel: book is just the page, a deck is Slide N, another PDF names itself', () => {
  assert.equal(anchorChipLabel({ page: 100, sourceId: 'book' }), 'p. 100');
  assert.equal(anchorChipLabel({ page: 100, sourceId: PAGE_ANCHOR_SOURCE_BOOK }), 'p. 100');
  assert.equal(anchorChipLabel({ page: 12, sourceId: 'slides-chap2' }, { label: 'Supervised Learning', kind: 'slides' }), 'Slide 12');
  assert.equal(anchorChipLabel({ page: 12, sourceId: 'slides-chap2' }), 'Slide 12');
  assert.equal(anchorChipLabel({ page: 3, sourceId: 'extra-pdf' }, { label: 'Appendix', kind: 'pdf' }), 'p. 3 · Appendix');
  assert.equal(anchorChipLabel({ page: 3, sourceId: 'extra-pdf' }), 'p. 3 · extra-pdf');
  assert.equal(anchorChipLabel(null), '');
});

test('resolveAnchorTarget: book, deck, extra PDF, unknown', () => {
  const materials = [
    { id: 'slides-chap2', kind: 'slides', hasFile: true },
    { id: 'extra-pdf', kind: 'pdf', hasFile: true },
    { id: 'gone-deck', kind: 'slides', hasFile: false },
    { id: 'clip', kind: 'video', hasFile: true },
  ];
  assert.deepEqual(resolveAnchorTarget('book', materials), { target: 'book' });
  assert.deepEqual(resolveAnchorTarget(null, materials), { target: 'book' });
  assert.deepEqual(resolveAnchorTarget('slides-chap2', materials), { target: 'material', id: 'slides-chap2', kind: 'slides' });
  assert.deepEqual(resolveAnchorTarget('extra-pdf', materials), { target: 'material', id: 'extra-pdf', kind: 'pdf' });
  assert.deepEqual(resolveAnchorTarget('gone-deck', materials), { target: 'unknown' });
  assert.deepEqual(resolveAnchorTarget('clip', materials), { target: 'unknown' });
  assert.deepEqual(resolveAnchorTarget('no-such-id', materials), { target: 'unknown' });
  assert.deepEqual(resolveAnchorTarget('extra-pdf', []), { target: 'unknown' });
});

test('pdfMaterials: only readable kind-pdf materials, decks excluded', () => {
  const materials = [
    { id: 'slides-chap2', kind: 'slides', hasFile: true },
    { id: 'extra-pdf', kind: 'pdf', hasFile: true },
    { id: 'gone-pdf', kind: 'pdf', hasFile: false },
    { id: 'clip', kind: 'video', hasFile: true },
  ];
  assert.deepEqual(pdfMaterials(materials).map((m) => m.id), ['extra-pdf']);
  assert.deepEqual(pdfMaterials([]), []);
});

test('formatPageAnchor: linked anchor carries the note part; bare anchor unchanged', () => {
  assert.equal(
    formatPageAnchor({ page: 18, sourceId: 'book', note: 'my-note.md' }),
    '<!-- @page 18 · source: book · note: my-note.md -->');
  assert.equal(
    formatPageAnchor({ page: 3, sourceId: 'slides-introduction', note: 'intro.md' }),
    '<!-- @page 3 · source: slides-introduction · note: intro.md -->');
  assert.equal(formatPageAnchor({ page: 18, sourceId: 'book', note: null }),
    '<!-- @page 18 · source: book -->');
  assert.throws(() => formatPageAnchor({ page: 1, sourceId: 'book', note: 'has space.md' }), /without spaces/);
  assert.throws(() => formatPageAnchor({ page: 1, sourceId: 'book', note: 'note.txt' }), /\.md/);
});

test('parsePageAnchors: linked anchors carry note, bare anchors carry null', () => {
  const text = [
    '## Introduction', '',
    '<!-- @page 18 · source: book · note: my-note.md -->', '',
    '<!-- @page 7 · source: book -->', '',
    '<!-- @page 3 · source: slides-introduction · note: intro.md -->',
  ].join('\n');
  assert.deepEqual(parsePageAnchors(text), [
    { page: 18, sourceId: 'book', note: 'my-note.md', index: text.indexOf('<!-- @page 18') },
    { page: 7, sourceId: 'book', note: null, index: text.indexOf('<!-- @page 7') },
    { page: 3, sourceId: 'slides-introduction', note: 'intro.md', index: text.indexOf('<!-- @page 3') },
  ]);
});

test('anchorChipLabel: linked anchor shows the note stem + the page', () => {
  assert.equal(anchorChipLabel({ page: 18, sourceId: 'book', note: 'my-note.md' }), 'my-note · p. 18');
  assert.equal(anchorChipLabel({ page: 3, sourceId: 'slides-introduction', note: 'intro.md' }), 'intro · Slide 3');
  assert.equal(anchorChipLabel({ page: 18, sourceId: 'book', note: null }), 'p. 18');
});
