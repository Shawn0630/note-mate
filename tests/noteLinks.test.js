import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNoteLinkEntries, addNoteLinkEntry, removeNoteLinkEntries, renameNoteLinkEntries,
} from '../src/noteLinks.js';

const LINK = '<!-- @page 18 · source: book · note: my-note.md -->';
const LINK2 = '<!-- @page 42 · source: slides-chap2 · note: my-note.md -->';
const BARE = '<!-- @page 7 · source: book -->';

test('parseNoteLinkEntries: only linked anchors, in order', () => {
  const text = ['# Book', '', '## One', '', LINK, '', BARE, '', '## Two', '', LINK2].join('\n');
  assert.deepEqual(parseNoteLinkEntries(text).map(({ page, sourceId, note }) => ({ page, sourceId, note })), [
    { page: 18, sourceId: 'book', note: 'my-note.md' },
    { page: 42, sourceId: 'slides-chap2', note: 'my-note.md' },
  ]);
  assert.deepEqual(parseNoteLinkEntries('# No anchors\n'), []);
});

test('addNoteLinkEntry: creates the heading (with chapter anchor) when missing', () => {
  const { text, added } = addNoteLinkEntry('# Book\n', {
    heading: 'Introduction', headingAnchor: '<!-- p. 15 -->',
    page: 18, sourceId: 'book', note: 'my-note.md',
  });
  assert.equal(added, true);
  assert.match(text, /## Introduction\n\n<!-- p\. 15 -->\n\n<!-- @page 18 · source: book · note: my-note\.md -->\n/);
});

test('addNoteLinkEntry: appends under an existing heading; same line twice is a no-op', () => {
  const start = '# Book\n\n## Introduction\n\n<!-- p. 15 -->\n';
  const first = addNoteLinkEntry(start, { heading: 'Introduction', page: 18, sourceId: 'book', note: 'my-note.md' });
  assert.equal(first.added, true);
  assert.ok(first.text.includes(LINK));
  assert.ok(first.text.includes('<!-- p. 15 -->'));
  const second = addNoteLinkEntry(first.text, { heading: 'Introduction', page: 18, sourceId: 'book', note: 'my-note.md' });
  assert.equal(second.added, false);
  assert.equal(second.text, first.text);
});

test('addNoteLinkEntry: heading match ignores numbering', () => {
  const start = '# Book\n\n## 2. Supervised learning\n\n';
  const { text, added } = addNoteLinkEntry(start, {
    heading: 'Supervised learning', page: 25, sourceId: 'book', note: 'sup.md',
  });
  assert.equal(added, true);
  assert.ok(!text.includes('## Supervised learning\n'));
  assert.ok(text.includes('<!-- @page 25 · source: book · note: sup.md -->'));
});

test('removeNoteLinkEntries: removes one entry, drops the heading left empty, keeps the other', () => {
  const text = ['# Book', '', '## One', '', '<!-- p. 15 -->', '', LINK, '',
    '## Two', '', LINK2, '', '## Three', '', BARE, ''].join('\n');
  const { text: out, removed } = removeNoteLinkEntries(text, 'my-note.md', { page: 18, sourceId: 'book' });
  assert.equal(removed, 1);
  assert.ok(!out.includes(LINK));
  assert.ok(out.includes(LINK2));
  assert.ok(!out.includes('## One')); // left with only <!-- p. 15 --> → dropped
  assert.ok(out.includes('## Two'));
  assert.ok(out.includes('## Three')); // bare anchor counts as content → kept
  assert.ok(out.includes(BARE));
});

test('removeNoteLinkEntries: removing all of a note drops its headings but keeps content sections', () => {
  const text = ['# Book', '', '## One', '', LINK, '', 'Some real text.', '',
    '## Two', '', LINK2, ''].join('\n');
  const { text: out, removed } = removeNoteLinkEntries(text, 'my-note.md');
  assert.equal(removed, 2);
  assert.ok(out.includes('## One')); // real text under it → kept
  assert.ok(out.includes('Some real text.'));
  assert.ok(!out.includes('## Two')); // nothing left → dropped
});

test('removeNoteLinkEntries: nothing matching is a no-op', () => {
  const text = '# Book\n\n## One\n\n' + LINK + '\n';
  const { text: out, removed } = removeNoteLinkEntries(text, 'other.md');
  assert.equal(removed, 0);
  assert.equal(out, text);
});

test('renameNoteLinkEntries: retargets every entry for the file, nothing else', () => {
  const text = ['# Book', '', '## One', '', LINK, '', '## Two', '', LINK2, '', BARE, ''].join('\n');
  const { text: out, renamed } = renameNoteLinkEntries(text, 'my-note.md', 'renamed.md');
  assert.equal(renamed, 2);
  assert.ok(out.includes('<!-- @page 18 · source: book · note: renamed.md -->'));
  assert.ok(out.includes('<!-- @page 42 · source: slides-chap2 · note: renamed.md -->'));
  assert.ok(!out.includes('note: my-note.md'));
  assert.ok(out.includes(BARE));
  const none = renameNoteLinkEntries(text, 'ghost.md', 'x.md');
  assert.equal(none.renamed, 0);
  assert.equal(none.text, text);
});
