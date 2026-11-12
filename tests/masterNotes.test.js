// Single master markdown (2026-11-11 reversal): pure helpers in
// src/masterNotes.js — section splitting, empty-skeleton pruning, Labs
// block stripping, and folding per-chapter files back into one master.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chapterFileNumber, isChapterFile, splitSections, sectionHasContent,
  dropEmptySections, stripLabsBlock, foldChapterFiles,
} from '../src/masterNotes.js';

const HEADER = '# Understanding Deep Learning\n\n'
  + 'Simon J.D. Prince, MIT Press (free PDF, CC-BY-NC-ND). Book site with 69 Python notebook exercises, video lectures and slides: https://udlbook.github.io/udlbook/\n';

const SEEDED = `${HEADER}\n## 1. Introduction\n<!-- p. 15 -->\n\n## 2. Supervised learning\n<!-- p. 31 -->\n\n## 3. Shallow neural networks\n<!-- p. 39 -->\n`;

test('chapterFileNumber / isChapterFile', () => {
  assert.equal(chapterFileNumber('chapter-02-supervised-learning.md'), 2);
  assert.equal(chapterFileNumber('chapter-21-deep-learning-and-ethics.md'), 21);
  assert.equal(chapterFileNumber('notes.md'), null);
  assert.equal(chapterFileNumber('index.md'), null);
  assert.equal(isChapterFile('chapter-06-fitting-models.md'), true);
  assert.equal(isChapterFile('notes.md.migrated'), false);
});

test('splitSections: header + 21-style sections with page anchors', () => {
  const { header, sections } = splitSections(SEEDED);
  assert.equal(header, HEADER);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].heading, '1. Introduction');
  assert.equal(sections[0].anchorPage, 15);
  assert.equal(sections[1].heading, '2. Supervised learning');
  assert.equal(sections[1].anchorPage, 31);
  assert.equal(sections[2].anchorPage, 39);
  // Seeded sections hold only the page comment: no user content.
  assert.equal(sections.every((s) => !sectionHasContent(s)), true);
});

test('sectionHasContent: blank / chapter-anchor-only is empty; a @page anchor IS content', () => {
  const { sections } = splitSections('## A\n<!-- p. 1 -->\n\n## B\n<!-- @page 5 · source: book -->\n\n## C\n- typed note\n');
  assert.equal(sectionHasContent(sections[0]), false);
  // A bare @page anchor is a note the user added with "+ Note here" — it
  // counts, or a note added just before a reload would be pruned away.
  assert.equal(sectionHasContent(sections[1]), true);
  assert.equal(sectionHasContent(sections[2]), true);
});

test('dropEmptySections: drops empty skeleton headings, keeps content verbatim', () => {
  const text = `${HEADER}\n## 1. Introduction\n<!-- p. 15 -->\n\n- my intro note\n\n## 2. Supervised learning\n<!-- p. 31 -->\n\n## 3. Shallow neural networks\n<!-- p. 39 -->\n\n- shallow note\n`;
  const cleaned = dropEmptySections(text);
  assert.equal(cleaned, `${HEADER}\n## 1. Introduction\n<!-- p. 15 -->\n\n- my intro note\n\n## 3. Shallow neural networks\n<!-- p. 39 -->\n\n- shallow note\n`);
  // Idempotent: a second run changes nothing.
  assert.equal(dropEmptySections(cleaned), cleaned);
});

test('dropEmptySections: keeps an anchor-only section (the note IS the anchor)', () => {
  const text = `${HEADER}\n## 3. Shallow neural networks\n<!-- p. 39 -->\n\n<!-- @page 45 · source: book -->\n`;
  assert.equal(dropEmptySections(text), text);
  // ...while a neighbouring empty skeleton heading is still dropped.
  const mixed = `${HEADER}\n## 1. Introduction\n<!-- p. 15 -->\n\n## 3. Shallow neural networks\n<!-- p. 39 -->\n\n<!-- @page 45 · source: book -->\n`;
  assert.equal(dropEmptySections(mixed), text);
});

test('dropEmptySections: all-empty master becomes the header only', () => {
  assert.equal(dropEmptySections(SEEDED), HEADER);
  assert.equal(dropEmptySections(dropEmptySections(SEEDED)), HEADER);
});

test('stripLabsBlock: removes the generated block, leaves no double blank', () => {
  const ch = '## 2. Supervised learning\n<!-- p. 31 -->\n\n- my note\n\n<!-- labs:start -->\n### Labs\n\n- [2.1 Supervised Learning](labs/Chap02/2_1_Supervised_Learning.ipynb)\n<!-- labs:end -->\n';
  assert.equal(stripLabsBlock(ch), '## 2. Supervised learning\n<!-- p. 31 -->\n\n- my note');
  // No block -> unchanged.
  assert.equal(stripLabsBlock('## 2. Supervised learning\n<!-- p. 31 -->\n\n- my note\n'), '## 2. Supervised learning\n<!-- p. 31 -->\n\n- my note\n');
});

test('foldChapterFiles: user content kept in order, empty chapters dropped, Labs stripped', () => {
  const files = [
    { name: 'chapter-06-fitting-models.md',
      content: '## 6. Fitting models\n<!-- p. 91 -->\n\n<!-- @page 100 · source: book -->\n\n- my fitting note\n\n<!-- labs:start -->\n### Labs\n\n- [6.1 Line Search](labs/Chap06/6_1_Line_Search.ipynb)\n<!-- labs:end -->\n' },
    { name: 'chapter-02-supervised-learning.md',
      content: '## 2. Supervised learning\n<!-- p. 31 -->\n\n- my supervised note\n\n<!-- labs:start -->\n### Labs\n\n- [2.1 Supervised Learning](labs/Chap02/2_1_Supervised_Learning.ipynb)\n<!-- labs:end -->\n' },
    { name: 'chapter-03-shallow-neural-networks.md',
      content: '## 3. Shallow neural networks\n<!-- p. 39 -->\n\n<!-- labs:start -->\n### Labs\n\n- [3.1 Shallow Networks I](labs/Chap03/3_1_Shallow_Networks_I.ipynb)\n<!-- labs:end -->\n' },
  ];
  const master = foldChapterFiles(HEADER, files);
  assert.equal(master, `${HEADER}\n## 2. Supervised learning\n<!-- p. 31 -->\n\n- my supervised note\n\n## 6. Fitting models\n<!-- p. 91 -->\n\n<!-- @page 100 · source: book -->\n\n- my fitting note\n`);
  // A chapter file whose only content is a @page anchor still contributes:
  // the anchor is a note the user added, not skeleton noise.
  const anchorsOnly = foldChapterFiles(HEADER, [
    { name: 'chapter-06-fitting-models.md',
      content: '## 6. Fitting models\n<!-- p. 91 -->\n\n<!-- @page 100 · source: book -->\n\n<!-- labs:start -->\n### Labs\n\n- [6.1 Line Search](labs/Chap06/6_1_Line_Search.ipynb)\n<!-- labs:end -->\n' },
  ]);
  assert.equal(anchorsOnly, `${HEADER}\n## 6. Fitting models\n<!-- p. 91 -->\n\n<!-- @page 100 · source: book -->\n`);
  // A chapter file with only the chapter anchor + Labs still contributes nothing.
  const skeletonOnly = foldChapterFiles(HEADER, [
    { name: 'chapter-03-shallow-neural-networks.md',
      content: '## 3. Shallow neural networks\n<!-- p. 39 -->\n\n<!-- labs:start -->\n### Labs\n\n- [3.1 Shallow Networks I](labs/Chap03/3_1_Shallow_Networks_I.ipynb)\n<!-- labs:end -->\n' },
  ]);
  assert.equal(skeletonOnly, HEADER);
});
