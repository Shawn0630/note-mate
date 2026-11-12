// Per-chapter notes — server endpoints (src/server.js + src/chapterNotes.js).
// Fixtures are legacy single-file notes.md projects; the server migrates
// them on first GET.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTinyPdf } from './pdftext.test.js';

process.env.NODE_ENV = 'test';
const tmpData = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-chapter-notes-'));
process.env.DATA_DIR = tmpData;
process.env.LLM_ENV_FILE = path.join(tmpData, 'no-such.env');

const { default: app } = await import('../src/server.js');

let server;
let base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(tmpData, { recursive: true, force: true });
});

async function req(p, opts = {}) {
  const res = await fetch(`${base}${p}`, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { res, json, text };
}

const jsonReq = (p, method, body) => req(p, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

// The seeded notes.md shape (3 chapters) + user notes under chapter 2,
// a ### sub-heading, and a page anchor.
const LEGACY_MD = [
  '# Fixture Book',
  '',
  'Simon J.D. Prince, MIT Press (free PDF, CC-BY-NC-ND). Book site: https://example.com/',
  '',
  '## 1. Introduction',
  '<!-- p. 15 -->',
  '',
  '## 2. Supervised learning',
  '<!-- p. 31 -->',
  '',
  'My chapter-two notes.',
  '',
  '### A sub-heading inside chapter 2',
  '',
  '<!-- @page 40 · source: book -->',
  '',
  '## 3. Shallow neural networks',
  '<!-- p. 39 -->',
  '',
  '',
].join('\n');

async function makeLegacyProject(slug, notesMd, { labs = [], outline = null } = {}) {
  const dir = path.join(tmpData, 'projects', slug);
  await fsp.mkdir(path.join(dir, 'notes'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'source.pdf'), makeTinyPdf('Fixture'));
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify({
    slug, title: 'Fixture Book', kind: 'pdf', sourceType: 'file', file: 'source.pdf',
    chapterMap: {},
    ...(outline ? { outline } : {}),
  }));
  await fsp.writeFile(path.join(dir, 'notes', 'notes.md'), notesMd);
  for (const { chapter, name } of labs) {
    const nb = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] });
    await fsp.mkdir(path.join(dir, 'notes', 'labs', chapter), { recursive: true });
    await fsp.writeFile(path.join(dir, 'notes', 'labs', chapter, name), nb);
  }
  return dir;
}

test('migration: GET splits legacy notes.md into chapter files + index + backup', async () => {
  const dir = await makeLegacyProject('migrate-book', LEGACY_MD, {
    labs: [{ chapter: 'Chap02', name: '2_1_Supervised_Learning.ipynb' }],
  });
  const r = await req('/api/projects/migrate-book');
  assert.equal(r.res.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.chapters.map((c) => c.file), [
    'chapter-01-introduction.md',
    'chapter-02-supervised-learning.md',
    'chapter-03-shallow-neural-networks.md',
  ]);
  assert.equal(r.json.chapters[1].page, 31);
  assert.deepEqual(r.json.chapters[1].labs, [
    { name: '2_1_Supervised_Learning.ipynb', path: 'labs/Chap02/2_1_Supervised_Learning.ipynb' },
  ]);
  assert.equal(r.json.notesHeader, '# Fixture Book\n\nSimon J.D. Prince, MIT Press (free PDF, CC-BY-NC-ND). Book site: https://example.com/\n\n');
  // Chapter files: heading + page comment + the user's notes, byte-for-byte.
  const ch2 = await fsp.readFile(path.join(dir, 'notes', 'chapter-02-supervised-learning.md'), 'utf8');
  assert.match(ch2, /^## 2\. Supervised learning\n<!-- p\. 31 -->\n/);
  assert.match(ch2, /My chapter-two notes\./);
  assert.match(ch2, /### A sub-heading inside chapter 2/);
  assert.match(ch2, /<!-- @page 40 · source: book -->/);
  // The generated Labs block is appended at the end of the chapter file.
  assert.match(ch2, /<!-- labs:start -->\n### Labs\n\n- \[2\.1 Supervised Learning\]\(labs\/Chap02\/2_1_Supervised_Learning\.ipynb\)\n<!-- labs:end -->/);
  // Chapter 1 has no labs and no notes: heading + page comment (+ the
  // blank line that separated it from the next heading in the original).
  assert.equal(
    await fsp.readFile(path.join(dir, 'notes', 'chapter-01-introduction.md'), 'utf8'),
    '## 1. Introduction\n<!-- p. 15 -->\n\n',
  );
  // Legacy file renamed to the backup, byte-for-byte.
  assert.equal(await fsp.readFile(path.join(dir, 'notes', 'notes.md.migrated'), 'utf8'), LEGACY_MD);
  assert.ok(!fs.existsSync(path.join(dir, 'notes', 'notes.md')));
  // The index links every chapter (+ page) and the lab.
  const index = await fsp.readFile(path.join(dir, 'notes', 'index.md'), 'utf8');
  assert.match(index, /# Fixture Book/);
  assert.match(index, /Simon J\.D\. Prince/);
  assert.match(index, /- \[2\. Supervised learning\]\(chapter-02-supervised-learning\.md\) — p\. 31/);
  assert.match(index, /Exercises: \[2\.1 Supervised Learning\]\(labs\/Chap02\/2_1_Supervised_Learning\.ipynb\)/);
});

test('migration is idempotent: second GET + explicit POST migrate change nothing', async () => {
  const dir = await makeLegacyProject('idem-book', LEGACY_MD);
  const first = await req('/api/projects/idem-book');
  assert.equal(first.res.status, 200);
  const before = await fsp.readFile(path.join(dir, 'notes', 'chapter-02-supervised-learning.md'), 'utf8');
  const second = await req('/api/projects/idem-book');
  assert.equal(second.res.status, 200);
  assert.deepEqual(second.json.chapters, first.json.chapters);
  const again = await jsonReq('/api/projects/idem-book/notes/migrate', 'POST', {});
  assert.equal(again.res.status, 200);
  assert.equal(again.json.migrated, false);
  assert.equal(await fsp.readFile(path.join(dir, 'notes', 'chapter-02-supervised-learning.md'), 'utf8'), before);
  // The backup is still the byte-exact original.
  assert.equal(await fsp.readFile(path.join(dir, 'notes', 'notes.md.migrated'), 'utf8'), LEGACY_MD);
});

test('export: split → export round-trips the original notes.md', async () => {
  await makeLegacyProject('export-book', LEGACY_MD, {
    labs: [{ chapter: 'Chap02', name: '2_1_Supervised_Learning.ipynb' }],
  });
  await req('/api/projects/export-book'); // migrate
  const res = await fetch(`${base}/api/projects/export-book/notes/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /export-book-notes\.md/);
  assert.equal(await res.text(), LEGACY_MD);
});

test('notes list excludes the legacy file and the index; PUT rejects both', async () => {
  await makeLegacyProject('guard-book', LEGACY_MD);
  await req('/api/projects/guard-book'); // migrate
  const list = await req('/api/projects/guard-book/notes');
  assert.deepEqual(list.json.map((n) => n.name), [
    'chapter-01-introduction.md',
    'chapter-02-supervised-learning.md',
    'chapter-03-shallow-neural-networks.md',
  ]);
  for (const name of ['index.md', 'notes.md']) {
    const r = await jsonReq(`/api/projects/guard-book/notes/${name}`, 'PUT', { content: 'x' });
    assert.equal(r.res.status, 400, name);
    assert.match(r.json.error, name === 'index.md' ? /maintained by the app/ : /legacy/);
  }
  // ...but the index itself is readable (and regenerated when missing).
  const idx = await req('/api/projects/guard-book/notes/index.md');
  assert.equal(idx.res.status, 200);
  assert.match(idx.json.content, /\[1\. Introduction\]/);
});

test('PUT chapter file: index follows a renamed heading; Labs block refreshes', async () => {
  const dir = await makeLegacyProject('put-book', LEGACY_MD, {
    labs: [{ chapter: 'Chap02', name: '2_1_Supervised_Learning.ipynb' }],
  });
  await req('/api/projects/put-book'); // migrate
  // Rename chapter 2's heading and drop its Labs block: the PUT refreshes
  // the block from the labs on disk and the index follows the new title.
  const edited = '## 2. Supervised learning (revised)\n<!-- p. 31 -->\n\nMy chapter-two notes.\n';
  const r = await jsonReq('/api/projects/put-book/notes/chapter-02-supervised-learning.md', 'PUT', { content: edited });
  assert.equal(r.res.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.chapter.title, '2. Supervised learning (revised)');
  assert.equal(r.json.chapter.page, 31);
  const stored = await fsp.readFile(path.join(dir, 'notes', 'chapter-02-supervised-learning.md'), 'utf8');
  assert.match(stored, /<!-- labs:start -->/);
  assert.match(stored, /2\.1 Supervised Learning/);
  const index = await fsp.readFile(path.join(dir, 'notes', 'index.md'), 'utf8');
  assert.match(index, /\[2\. Supervised learning \(revised\)\]\(chapter-02-supervised-learning\.md\)/);
  // The chapter list reflects the rename too.
  const chapters = await req('/api/projects/put-book/chapters');
  assert.equal(chapters.json.chapters[1].title, '2. Supervised learning (revised)');
});

test('a ### inside one chapter file cannot shift another chapter', async () => {
  await makeLegacyProject('shift-book', LEGACY_MD);
  await req('/api/projects/shift-book'); // migrate
  const before = await req('/api/projects/shift-book/chapters');
  // Insert a ### sub-heading (plus notes) into chapter 1's file.
  const ch1 = '## 1. Introduction\n<!-- p. 15 -->\n\n### My new sub-heading\n\nSome notes.\n';
  const r = await jsonReq('/api/projects/shift-book/notes/chapter-01-introduction.md', 'PUT', { content: ch1 });
  assert.equal(r.res.status, 200);
  const after = await req('/api/projects/shift-book/chapters');
  assert.deepEqual(after.json.chapters, before.json.chapters);
  // And the export still has exactly one ## per chapter, in order.
  const res = await fetch(`${base}/api/projects/shift-book/notes/export`);
  const exported = await res.text();
  assert.deepEqual([...exported.matchAll(/^## (.+)$/gm)].map((m) => m[1]), [
    '1. Introduction', '2. Supervised learning', '3. Shallow neural networks',
  ]);
  assert.match(exported, /### My new sub-heading/);
});

test('POST /chapters: creates a chapter file; idempotent for an existing title', async () => {
  const dir = await makeLegacyProject('create-book', LEGACY_MD);
  await req('/api/projects/create-book'); // migrate
  const created = await jsonReq('/api/projects/create-book/chapters', 'POST', { title: 'Deep neural networks', page: 55 });
  assert.equal(created.res.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.chapter.file, 'chapter-04-deep-neural-networks.md');
  assert.equal(created.json.chapter.page, 55);
  assert.equal(
    await fsp.readFile(path.join(dir, 'notes', 'chapter-04-deep-neural-networks.md'), 'utf8'),
    '## Deep neural networks\n<!-- p. 55 -->\n',
  );
  assert.equal(created.json.chapters.length, 4);
  // Creating it again returns the existing chapter (200, no duplicate).
  const again = await jsonReq('/api/projects/create-book/chapters', 'POST', { title: 'Deep neural networks', page: 55 });
  assert.equal(again.res.status, 200);
  assert.equal(again.json.chapter.file, 'chapter-04-deep-neural-networks.md');
  assert.equal(again.json.chapters.length, 4);
  // Validation.
  const bad = await jsonReq('/api/projects/create-book/chapters', 'POST', { title: '  ' });
  assert.equal(bad.res.status, 400);
  const badPage = await jsonReq('/api/projects/create-book/chapters', 'POST', { title: 'X', page: 0 });
  assert.equal(badPage.res.status, 400);
});

test('migration of a heading-less notes.md keeps the content as one Notes chapter', async () => {
  const dir = await makeLegacyProject('freeform-book', '# Freeform\n\nJust some prose, no headings.\n');
  const r = await req('/api/projects/freeform-book');
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json.chapters.map((c) => c.file), ['chapter-01-notes.md']);
  const ch = await fsp.readFile(path.join(dir, 'notes', 'chapter-01-notes.md'), 'utf8');
  assert.match(ch, /^## Notes\n\nJust some prose, no headings\.\n$/);
  assert.equal(r.json.notesHeader, '# Freeform\n\n');
  const res = await fetch(`${base}/api/projects/freeform-book/notes/export`);
  assert.equal(await res.text(), '# Freeform\n\n## Notes\n\nJust some prose, no headings.\n');
});

test('ai-note includeNote reads the migrated chapter file (stub)', async () => {
  await makeLegacyProject('ainote-book', LEGACY_MD, {
    outline: [
      { title: 'Introduction', page: 1 },
      { title: 'Supervised learning', page: 1 },
      { title: 'Shallow neural networks', page: 1 },
    ],
  });
  await req('/api/projects/ainote-book'); // migrate — notes.md is gone now
  const saved = process.env.LLM_STUB_RESPONSE;
  process.env.LLM_STUB_RESPONSE = '### Draft\n\n- a point';
  try {
    const res = await fetch(`${base}/api/projects/ainote-book/ai-note`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chapter: 'Supervised learning', prompt: 'Summarize.', includeNote: true }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const json = JSON.parse(text);
    assert.equal(json.markdown, '### Draft\n\n- a point');
    assert.ok(json.contextChars > 0);
  } finally {
    if (saved === undefined) delete process.env.LLM_STUB_RESPONSE;
    else process.env.LLM_STUB_RESPONSE = saved;
  }
});

test('GET chapters / export on an unknown project are 404s', async () => {
  assert.equal((await req('/api/projects/nope/chapters')).res.status, 404);
  assert.equal((await req('/api/projects/nope/notes/export')).res.status, 404);
  assert.equal((await jsonReq('/api/projects/nope/notes/migrate', 'POST', {})).res.status, 404);
});
