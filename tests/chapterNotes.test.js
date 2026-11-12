// Per-chapter notes — pure helpers (src/chapterNotes.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chapterFileName, parseChapterNumber, labGroupForChapterNumber, labDisplayName,
  extractPageNumber, splitNotesMd, splitHeaderTitle, buildChapterFile, labsBlock, stripLabsBlock,
  refreshLabsBlock, appendToChapter, bylineFromHeader, composeIndex, composeCombined,
  resolveChapter, parseChapterFileName, isChapterFile,
} from '../src/chapterNotes.js';

// The seeded notes.md shape (3 chapters; the real seed has 21).
const SEED_MD = [
  '# Understanding Deep Learning',
  '',
  'Simon J.D. Prince, MIT Press (free PDF, CC-BY-NC-ND). Book site with 69 Python notebook exercises, video lectures and slides: https://udlbook.github.io/udlbook/',
  '',
  '## 1. Introduction',
  '<!-- p. 15 -->',
  '',
  '## 2. Supervised learning',
  '<!-- p. 31 -->',
  '',
  '## 3. Shallow neural networks',
  '<!-- p. 39 -->',
  '',
  '',
].join('\n');

// A note-bearing variant: user notes under chapters, a ### sub-heading, a
// page anchor, and a fenced code block containing a `##` line (which must
// NOT split).
const NOTES_MD = [
  '# My Book',
  '',
  'A byline line.',
  '',
  '## 1. Introduction',
  '<!-- p. 15 -->',
  '',
  'My intro notes.',
  '',
  '### A sub-heading inside chapter 1',
  '',
  'More notes.',
  '',
  '<!-- @page 20 · source: book -->',
  '',
  '```python',
  '## not a heading, just code',
  'print(1)',
  '```',
  '',
  '## 2. Supervised learning',
  '<!-- p. 31 -->',
  '',
  'Chapter two notes.',
  '',
].join('\n');

test('splitHeaderTitle: title part vs byline', () => {
  assert.deepEqual(splitHeaderTitle('# My Book\n\nA byline.\n'), { titlePart: '# My Book\n\n', rest: 'A byline.\n' });
  assert.deepEqual(splitHeaderTitle('# Title\n'), { titlePart: '# Title\n', rest: '' });
  assert.deepEqual(splitHeaderTitle('No title here.\n'), { titlePart: '', rest: 'No title here.\n' });
});

test('chapterFileName: number + slug', () => {
  assert.equal(chapterFileName({ number: 2, title: 'Supervised learning' }), 'chapter-02-supervised-learning.md');
  assert.equal(chapterFileName({ number: 12, title: 'Transformers' }), 'chapter-12-transformers.md');
  assert.equal(chapterFileName({ number: 1, title: 'Why does deep learning work?' }), 'chapter-01-why-does-deep-learning-work.md');
});

test('parseChapterNumber / labGroupForChapterNumber / labDisplayName', () => {
  assert.equal(parseChapterNumber('12. Transformers'), 12);
  assert.equal(parseChapterNumber('1) Introduction'), 1);
  assert.equal(parseChapterNumber('Supervised learning'), null);
  assert.equal(labGroupForChapterNumber(2), 'Chap02');
  assert.equal(labGroupForChapterNumber(12), 'Chap12');
  assert.equal(labDisplayName('2_1_Supervised_Learning.ipynb'), '2.1 Supervised Learning');
  assert.equal(labDisplayName('20_2_Full_Batch_Gradient_Descent_GPU.ipynb'), '20.2 Full Batch Gradient Descent GPU');
  assert.equal(labDisplayName('notes.ipynb'), 'notes');
});

test('splitNotesMd: seed shape — header + sections, byte-for-byte rejoin', () => {
  const { header, sections } = splitNotesMd(SEED_MD);
  assert.equal(header, '# Understanding Deep Learning\n\nSimon J.D. Prince, MIT Press (free PDF, CC-BY-NC-ND). Book site with 69 Python notebook exercises, video lectures and slides: https://udlbook.github.io/udlbook/\n\n');
  assert.equal(sections.length, 3);
  assert.equal(sections[0].heading, '1. Introduction');
  assert.equal(sections[0].page, 15);
  assert.equal(sections[0].number, 1);
  assert.equal(sections[1].heading, '2. Supervised learning');
  assert.equal(sections[1].page, 31);
  assert.equal(sections[2].number, 3);
  // Exact round-trip: header + raw sections == the original file.
  assert.equal(header + sections.map((s) => s.raw).join(''), SEED_MD);
});

test('splitNotesMd: user notes — ### and fenced ## never split a chapter', () => {
  const { header, sections } = splitNotesMd(NOTES_MD);
  assert.equal(sections.length, 2);
  assert.match(sections[0].raw, /### A sub-heading inside chapter 1/);
  assert.match(sections[0].raw, /## not a heading, just code/);
  assert.match(sections[0].raw, /<!-- @page 20 · source: book -->/);
  assert.match(sections[0].raw, /My intro notes\./);
  assert.match(sections[1].raw, /Chapter two notes\./);
  assert.equal(header + sections.map((s) => s.raw).join(''), NOTES_MD);
});

test('splitNotesMd: no headings — everything is the header', () => {
  const { header, sections } = splitNotesMd('# Title\n\nFreeform notes.\n');
  assert.equal(header, '# Title\n\nFreeform notes.\n');
  assert.deepEqual(sections, []);
});

test('extractPageNumber: p. comment and @page anchor', () => {
  assert.equal(extractPageNumber('## 2. X\n<!-- p. 31 -->\n'), 31);
  assert.equal(extractPageNumber('<!-- @page 100 · source: book -->'), 100);
  assert.equal(extractPageNumber('<!-- @page 12 · source: slides-chap2 -->'), null);
  assert.equal(extractPageNumber('no comment'), null);
});

test('buildChapterFile: heading + page comment + body', () => {
  assert.equal(
    buildChapterFile({ heading: '2. Supervised learning', page: 31, body: '' }),
    '## 2. Supervised learning\n<!-- p. 31 -->\n',
  );
  assert.equal(
    buildChapterFile({ heading: 'Notes', page: null, body: 'Hello.\n' }),
    '## Notes\n\nHello.\n',
  );
});

const LABS_CH2 = [
  { name: '2_1_Supervised_Learning.ipynb', path: 'labs/Chap02/2_1_Supervised_Learning.ipynb' },
];

test('labs block: append, strip, refresh — byte-exact', () => {
  const file = buildChapterFile({ heading: '2. Supervised learning', page: 31, body: '' });
  const withLabs = refreshLabsBlock(file, LABS_CH2, 2);
  assert.match(withLabs, /<!-- labs:start -->\n### Labs\n\n- \[2\.1 Supervised Learning\]\(labs\/Chap02\/2_1_Supervised_Learning\.ipynb\)\n<!-- labs:end -->/);
  // Strip returns the pre-block text verbatim.
  assert.equal(stripLabsBlock(withLabs), file);
  // Refresh with the same labs is a no-op.
  assert.equal(refreshLabsBlock(withLabs, LABS_CH2, 2), withLabs);
  // Refresh with no labs removes the block.
  assert.equal(refreshLabsBlock(withLabs, [], 2), file);
  // Refresh with a changed list replaces the inner list only.
  const two = [...LABS_CH2, { name: '2_2_Extra.ipynb', path: 'labs/Chap02/2_2_Extra.ipynb' }];
  assert.match(refreshLabsBlock(withLabs, two, 2), /2\.2 Extra/);
  assert.equal(stripLabsBlock(refreshLabsBlock(withLabs, two, 2)), file);
  // No labs and no block: unchanged.
  assert.equal(refreshLabsBlock(file, [], 2), file);
});

test('appendToChapter: lands before the Labs block; idempotent', () => {
  const file = refreshLabsBlock(
    buildChapterFile({ heading: '2. Supervised learning', page: 31, body: 'My notes.\n' }),
    LABS_CH2, 2,
  );
  const { text, inserted } = appendToChapter(file, '<!-- @page 40 · source: book -->');
  assert.equal(inserted, true);
  // The anchor is above the Labs block; the block itself is intact.
  assert.ok(text.indexOf('@page 40') < text.indexOf('<!-- labs:start -->'));
  assert.ok(text.endsWith('<!-- labs:end -->\n'));
  // Second append of the same block is a no-op.
  assert.deepEqual(appendToChapter(text, '<!-- @page 40 · source: book -->'), { text, inserted: false });
  // Without a Labs block it appends at the end.
  const plain = buildChapterFile({ heading: '2. Supervised learning', page: 31, body: 'My notes.\n' });
  const appended = appendToChapter(plain, 'New note.');
  assert.equal(appended.text, '## 2. Supervised learning\n<!-- p. 31 -->\n\nMy notes.\n\nNew note.\n');
});

test('appendToChapter: a ### inside one chapter cannot shift another', () => {
  // The old fragility: inserting a ### heading mid-file shifted every
  // later chapter's heading index. With files, each chapter's text is
  // independent — appending a ### to chapter 1 leaves chapter 2 untouched.
  const ch1 = buildChapterFile({ heading: '1. Introduction', page: 15, body: 'Notes.\n' });
  const ch2 = buildChapterFile({ heading: '2. Supervised learning', page: 31, body: 'Notes.\n' });
  const ch1b = appendToChapter(ch1, '### A brand new sub-heading\n\nMore notes.').text;
  assert.match(ch1b, /### A brand new sub-heading/);
  assert.equal(ch2, buildChapterFile({ heading: '2. Supervised learning', page: 31, body: 'Notes.\n' }));
  // And the sections still compose to the same combined file.
  const combined = composeCombined({
    notesHeader: '# My Book\n\n',
    chapterContents: [{ content: ch1b }, { content: ch2 }],
  });
  assert.match(combined, /## 1\. Introduction/);
  assert.match(combined, /## 2\. Supervised learning/);
  assert.equal((combined.match(/^## /gm) || []).length, 2);
});

test('bylineFromHeader / composeIndex', () => {
  const { header } = splitNotesMd(SEED_MD);
  assert.equal(
    bylineFromHeader(header),
    'Simon J.D. Prince, MIT Press (free PDF, CC-BY-NC-ND). Book site with 69 Python notebook exercises, video lectures and slides: https://udlbook.github.io/udlbook/',
  );
  const index = composeIndex({
    title: 'Understanding Deep Learning',
    byline: bylineFromHeader(header),
    chapters: [
      { number: 1, title: '1. Introduction', page: 15, file: 'chapter-01-introduction.md', labs: [{ name: '1_1_BackgroundMathematics.ipynb', path: 'labs/Chap01/1_1_BackgroundMathematics.ipynb' }] },
      { number: 2, title: '2. Supervised learning', page: 31, file: 'chapter-02-supervised-learning.md', labs: LABS_CH2 },
      { number: 14, title: '14. Unsupervised learning', page: 283, file: 'chapter-14-unsupervised-learning.md', labs: [] },
    ],
  });
  assert.match(index, /^<!-- This index is maintained by Note Mate/);
  assert.match(index, /# Understanding Deep Learning/);
  assert.match(index, /Simon J\.D\. Prince/);
  assert.match(index, /- \[1\. Introduction\]\(chapter-01-introduction\.md\) — p\. 15/);
  assert.match(index, /Exercises: \[1\.1 Background Mathematics\]\(labs\/Chap01\/1_1_BackgroundMathematics\.ipynb\)/);
  assert.match(index, /- \[2\. Supervised learning\]\(chapter-02-supervised-learning\.md\) — p\. 31/);
  assert.match(index, /Exercises: \[2\.1 Supervised Learning\]\(labs\/Chap02\/2_1_Supervised_Learning\.ipynb\)/);
  // No labs -> no Exercises line for that chapter.
  assert.doesNotMatch(index, /Unsupervised learning.*Exercises/s);
});

test('composeCombined: split → export round-trips the original', () => {
  const { header, sections } = splitNotesMd(SEED_MD);
  const chapterContents = sections.map((s) => ({
    content: refreshLabsBlock(s.raw, s.number === 2 ? LABS_CH2 : [], s.number),
  }));
  // The Labs block is generated chrome — export strips it, so the
  // round-trip is exact even though the chapter files carry the block.
  assert.equal(composeCombined({ notesHeader: header, chapterContents }), SEED_MD);
  // Same for the note-bearing variant (###, anchor, fenced ## all survive).
  const n = splitNotesMd(NOTES_MD);
  const nContents = n.sections.map((s) => ({ content: s.raw }));
  assert.equal(composeCombined({ notesHeader: n.header, chapterContents: nContents }), NOTES_MD);
});

test('resolveChapter: by title (numbers stripped), then by page', () => {
  const chapters = [
    { number: 1, title: '1. Introduction', page: 15, file: 'chapter-01-introduction.md', labs: [] },
    { number: 2, title: '2. Supervised learning', page: 31, file: 'chapter-02-supervised-learning.md', labs: [] },
  ];
  assert.equal(resolveChapter(chapters, { title: 'Supervised learning' }).file, 'chapter-02-supervised-learning.md');
  assert.equal(resolveChapter(chapters, { title: '2. Supervised learning' }).file, 'chapter-02-supervised-learning.md');
  // Renamed heading still resolves by page.
  assert.equal(resolveChapter(chapters, { title: 'Something else', page: 15 }).file, 'chapter-01-introduction.md');
  assert.equal(resolveChapter(chapters, { title: 'Nope', page: 999 }), null);
});

test('parseChapterFileName / isChapterFile', () => {
  assert.deepEqual(parseChapterFileName('chapter-02-supervised-learning.md'), { number: 2, slug: 'supervised-learning' });
  assert.equal(parseChapterFileName('notes.md'), null);
  assert.equal(parseChapterFileName('index.md'), null);
  assert.equal(isChapterFile('chapter-01-introduction.md'), true);
  assert.equal(isChapterFile('index.md'), false);
  assert.equal(isChapterFile('scratch.ipynb'), false);
});
