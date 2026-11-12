import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveChapterRange, resolvePageRange, extractChapterSection, insertMarkdownUnderHeading,
  stripMarkdownFences, demoteHeadings, validateAiNoteMarkdown,
  buildAiNotePrompt, generateAiNote,
  MAX_AI_NOTE_PROMPT_CHARS, MAX_AI_NOTE_RESPONSE_CHARS,
} from '../src/aiNote.js';

const OUTLINE = [
  { title: 'Introduction', page: 1 },
  { title: 'Background Mathematics', page: 15 },
  { title: 'Transformers', page: 221 },
  { title: 'Appendix', page: 435 },
];

test('resolveChapterRange: a subsection does not end its parent chapter', () => {
  const outline = [
    { title: 'A', page: 1, depth: 0 },
    { title: 'A.1', page: 2, depth: 1 },
    { title: 'A.2', page: 3, depth: 1 },
    { title: 'B', page: 5, depth: 0 },
  ];
  assert.deepEqual(resolveChapterRange(outline, 'A', 10), { title: 'A', startPage: 1, endPage: 4 });
  assert.deepEqual(resolveChapterRange(outline, 'A.1', 10), { title: 'A.1', startPage: 2, endPage: 2 });
  assert.deepEqual(resolveChapterRange(outline, 'A.2', 10), { title: 'A.2', startPage: 3, endPage: 4 });
  assert.deepEqual(resolveChapterRange(outline, 'B', 10), { title: 'B', startPage: 5, endPage: 10 });
});

test('resolveChapterRange: middle chapter ends before the next', () => {
  assert.deepEqual(
    resolveChapterRange(OUTLINE, 'Background Mathematics', 450),
    { title: 'Background Mathematics', startPage: 15, endPage: 220 },
  );
});

test('resolveChapterRange: last chapter ends at numPages; null numPages stays open', () => {
  assert.deepEqual(
    resolveChapterRange(OUTLINE, 'Appendix', 450),
    { title: 'Appendix', startPage: 435, endPage: 450 },
  );
  assert.deepEqual(
    resolveChapterRange(OUTLINE, 'Appendix', null),
    { title: 'Appendix', startPage: 435, endPage: null },
  );
});

test('resolveChapterRange: title matching is normalized; no match / null page / empty outline', () => {
  assert.deepEqual(
    resolveChapterRange(OUTLINE, '20. transformers', 450).title,
    'Transformers',
  );
  assert.equal(resolveChapterRange(OUTLINE, 'No Such Chapter', 450), null);
  assert.equal(resolveChapterRange(
    [{ title: 'No Page', page: null }], 'No Page', 10), null);
  assert.equal(resolveChapterRange([], 'Introduction', 10), null);
});

test('resolvePageRange: the outline section containing the page, through the next entry', () => {
  const outline = [
    { title: 'Title', page: 1, depth: 0 },
    { title: 'Motivation', page: 4, depth: 0 },
    { title: 'Details', page: 9, depth: 1 },
    { title: 'Summary', page: 12, depth: 0 },
  ];
  assert.deepEqual(resolvePageRange(outline, 1, 20), { title: 'Title', startPage: 1, endPage: 3 });
  assert.deepEqual(resolvePageRange(outline, 6, 20), { title: 'Motivation', startPage: 4, endPage: 8 });
  // A subsection (depth 1) still bounds the section: page 10 is in Details.
  assert.deepEqual(resolvePageRange(outline, 10, 20), { title: 'Details', startPage: 9, endPage: 11 });
  // Last section runs to numPages; null numPages stays open.
  assert.deepEqual(resolvePageRange(outline, 15, 20), { title: 'Summary', startPage: 12, endPage: 20 });
  assert.deepEqual(resolvePageRange(outline, 15, null), { title: 'Summary', startPage: 12, endPage: null });
});

test('resolvePageRange: no outline entry at/before the page falls back to a window', () => {
  assert.deepEqual(resolvePageRange([], 10, 20), { title: null, startPage: 8, endPage: 15 });
  assert.deepEqual(resolvePageRange([], 1, 20), { title: null, startPage: 1, endPage: 6 });
  assert.deepEqual(resolvePageRange([{ title: 'Late', page: 30 }], 5, 20), { title: null, startPage: 3, endPage: 10 });
  assert.equal(resolvePageRange([], 0, 20), null);
  assert.equal(resolvePageRange([], 'abc', 20), null);
});

const NOTES = [
  '# Understanding Deep Learning',
  '',
  '## 1. Introduction',
  '',
  'My intro notes.',
  '',
  '### A detail',
  '',
  'More intro.',
  '',
  '## 2. Background Mathematics',
  '',
  'Math notes here.',
  '',
  '## 3. Transformers',
  '',
].join('\n');

test('extractChapterSection: returns the section under the heading, stops at the next ##', () => {
  const section = extractChapterSection(NOTES, 'Background Mathematics');
  assert.equal(section, 'Math notes here.');
  const intro = extractChapterSection(NOTES, '1. Introduction');
  assert.match(intro, /My intro notes\./);
  assert.match(intro, /A detail/); // ### subheadings do not end the section
  assert.match(intro, /More intro\./);
  assert.equal(extractChapterSection(NOTES, 'No Such Heading'), '');
  assert.equal(extractChapterSection(NOTES, 'Transformers'), ''); // empty section
});

test('insertMarkdownUnderHeading: empty section, non-empty section, missing heading', () => {
  // Empty section: the block goes right after the heading.
  let r = insertMarkdownUnderHeading(NOTES, 'Transformers', '- a note');
  assert.equal(r.inserted, true);
  assert.match(r.text, /## 3\. Transformers\n\n- a note/);

  // Non-empty section: appended at the end of the section, before the next ##.
  r = insertMarkdownUnderHeading(NOTES, 'Background Mathematics', '- math note');
  assert.equal(r.inserted, true);
  assert.match(r.text, /Math notes here\.\n\n- math note\n\n## 3\. Transformers/);

  // Missing heading: a new ## section is appended at the end.
  r = insertMarkdownUnderHeading(NOTES, 'New Chapter', '- fresh');
  assert.equal(r.inserted, true);
  assert.match(r.text, /## New Chapter\n\n- fresh\n$/);
});

test('insertMarkdownUnderHeading: second Apply of the same block is a no-op', () => {
  const first = insertMarkdownUnderHeading(NOTES, 'Background Mathematics', '- math note');
  assert.equal(first.inserted, true);
  const second = insertMarkdownUnderHeading(first.text, 'Background Mathematics', '- math note');
  assert.equal(second.inserted, false);
  assert.equal(second.text, first.text);
  // A different block still inserts.
  const third = insertMarkdownUnderHeading(first.text, 'Background Mathematics', '- another note');
  assert.equal(third.inserted, true);
  assert.match(third.text, /- math note/);
  assert.match(third.text, /- another note/);
  // Empty markdown never inserts.
  assert.equal(insertMarkdownUnderHeading(NOTES, 'Transformers', '  ').inserted, false);
});

test('insertMarkdownUnderHeading: heading created on demand carries its page anchor', () => {
  // Missing heading + anchor: the new section is `##` + anchor + block.
  const r = insertMarkdownUnderHeading(NOTES, 'New Chapter', '- fresh', '<!-- p. 91 -->');
  assert.equal(r.inserted, true);
  assert.match(r.text, /## New Chapter\n\n<!-- p\. 91 -->\n\n- fresh\n$/);
  // Missing heading, no anchor: the old bare shape.
  const bare = insertMarkdownUnderHeading(NOTES, 'New Chapter', '- fresh');
  assert.match(bare.text, /## New Chapter\n\n- fresh\n$/);
  // Existing heading: the anchor is NOT re-added (the section already has one).
  const existing = insertMarkdownUnderHeading(NOTES, 'Transformers', '- a note', '<!-- p. 221 -->');
  assert.equal(existing.inserted, true);
  assert.equal((existing.text.match(/<!-- p\. 221 -->/g) || []).length, 0);
});

test('stripMarkdownFences + demoteHeadings', () => {
  assert.equal(stripMarkdownFences('```markdown\n# Hi\n```'), '# Hi');
  assert.equal(stripMarkdownFences('```\n- a\n```'), '- a');
  assert.equal(stripMarkdownFences('- plain'), '- plain');
  assert.equal(demoteHeadings('# Title\n## Section\n### Sub\ntext'), '### Title\n### Section\n### Sub\ntext');
  assert.equal(demoteHeadings('##x not a heading'), '##x not a heading');
});

test('validateAiNoteMarkdown: accepts markdown, demotes ##, rejects empty/JSON/over-long', () => {
  assert.equal(validateAiNoteMarkdown('## Summary\n\n- a'), '### Summary\n\n- a');
  assert.equal(validateAiNoteMarkdown('```markdown\n- a\n```'), '- a');
  assert.throws(() => validateAiNoteMarkdown('   '), /no markdown/);
  assert.throws(() => validateAiNoteMarkdown(42), /must be markdown text/);
  assert.throws(
    () => validateAiNoteMarkdown('{"outline": [], "noteSkeleton": "# T", "chapterMap": {}}'),
    /not markdown notes/,
  );
  assert.throws(
    () => validateAiNoteMarkdown('x'.repeat(MAX_AI_NOTE_RESPONSE_CHARS + 1)),
    /exceeds/,
  );
});

test('buildAiNotePrompt: chapter text, prompt, rules, history, truncation marker', () => {
  const prompt = buildAiNotePrompt({
    bookTitle: 'UDL',
    chapter: { title: 'Transformers', startPage: 221, endPage: 250 },
    chapterText: '--- page 221 ---\nAttention is all you need.',
    noteSection: 'My notes so far.',
    prompt: 'Summarize in 5 bullets.',
    history: [{ role: 'user', content: 'make it shorter' }, { role: 'assistant', content: '- a\n- b' }],
  });
  assert.match(prompt, /Book: UDL/);
  assert.match(prompt, /Chapter: Transformers \(pages 221–250\)/);
  assert.match(prompt, /Attention is all you need/);
  assert.match(prompt, /My notes so far/);
  assert.match(prompt, /Summarize in 5 bullets/);
  assert.match(prompt, /NEVER invent page numbers/);
  assert.match(prompt, /User: make it shorter/);
  assert.match(prompt, /Assistant: - a/);

  const long = buildAiNotePrompt({
    bookTitle: 'UDL',
    chapter: null,
    chapterText: 'y'.repeat(40000),
    noteSection: '',
    prompt: 'hi',
  });
  assert.match(long, /chapter text truncated/);
  assert.match(long, /Chapter: none selected/);
});

function withLlmEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; }
  const savedFile = process.env.LLM_ENV_FILE;
  process.env.LLM_ENV_FILE = '/nonexistent/none.env';
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      if (savedFile === undefined) delete process.env.LLM_ENV_FILE; else process.env.LLM_ENV_FILE = savedFile;
    });
}

test('generateAiNote: stub returns markdown (demoted); no config -> 503', async () => {
  await withLlmEnv({ LLM_STUB_RESPONSE: '## Summary\n\n- a\n- b' }, async () => {
    const out = await generateAiNote({
      bookTitle: 'UDL',
      chapter: { title: 'Transformers', startPage: 221, endPage: 250 },
      chapterText: 'text',
      noteSection: '',
      prompt: 'Summarize.',
    });
    assert.equal(out, '### Summary\n\n- a\n- b');
  });
  await withLlmEnv({ LLM_STUB_RESPONSE: undefined, LLM_API_KEY: undefined, LLM_MODEL: undefined }, async () => {
    await assert.rejects(
      generateAiNote({ bookTitle: 'X', chapter: null, chapterText: '', noteSection: '', prompt: 'hi' }),
      (err) => err.code === 'LLM_NOT_CONFIGURED' && err.status === 503,
    );
  });
});

test('caps: prompt length constant is sane', () => {
  assert.equal(MAX_AI_NOTE_PROMPT_CHARS, 2000);
  assert.ok(MAX_AI_NOTE_RESPONSE_CHARS >= 10000);
});
