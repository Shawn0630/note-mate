import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTinyPdf } from './pdftext.test.js';

process.env.NODE_ENV = 'test';
const tmpData = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-ai-test-'));
process.env.DATA_DIR = tmpData;
// Deterministic LLM config for these tests: a nonexistent .env file so no
// real key can leak in from the repo, plus a stub where needed.
process.env.LLM_ENV_FILE = path.join(tmpData, 'no-such.env');

const { default: app } = await import('../src/server.js');

let server;
let base;
before(async () => {
  // Fixture project with materials + labs.
  const dir = path.join(tmpData, 'projects', 'fixture-book');
  await fsp.mkdir(path.join(dir, 'slides'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'notes', 'labs', 'Chap01'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'notes', 'labs', 'Chap02'), { recursive: true });
  const nb = (n) => JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [`print(${n})`] }] });
  await fsp.writeFile(path.join(dir, 'source.pdf'), makeTinyPdf('Fixture Book'));
  await fsp.writeFile(path.join(dir, 'slides', 'Deck.pdf'), Buffer.from('%PDF-1.4 fake deck pdf content here'));
  await fsp.writeFile(path.join(dir, 'notes', 'notes.md'), '# Fixture Book\n\n## 1. Intro\n\n');
  await fsp.writeFile(path.join(dir, 'notes', 'labs', 'Chap01', '1_1_Test.ipynb'), nb(1));
  await fsp.writeFile(path.join(dir, 'notes', 'labs', 'Chap02', '2_1_Second.ipynb'), nb(2));
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify({
    slug: 'fixture-book',
    title: 'Fixture Book',
    author: null,
    kind: 'pdf',
    sourceType: 'file',
    file: 'source.pdf',
    cover: null,
    materials: [
      { id: 'slides-intro', label: 'Introduction', kind: 'slides', file: 'slides/Deck.pdf', sourceFile: 'slides/Deck.pptx', sourceUrl: 'https://example.com/intro.pptx' },
      { id: 'slides-missing', label: 'No PDF yet', kind: 'slides', sourceFile: 'slides/Missing.pptx', sourceUrl: 'https://example.com/missing.pptx' },
    ],
    chapterMap: {},
    links: [],
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
  }, null, 2));
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

test('GET /:slug includes materials[]', async () => {
  const r = await req('/api/projects/fixture-book');
  assert.equal(r.res.status, 200);
  assert.equal(r.json.materials.length, 2);
  assert.equal(r.json.materials[0].id, 'slides-intro');
});

test('materials: list, file, Range, 404s', async () => {
  const r = await req('/api/projects/fixture-book/materials');
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json, [
    { id: 'slides-intro', label: 'Introduction', kind: 'slides', hasFile: true, sourceUrl: 'https://example.com/intro.pptx' },
    { id: 'slides-missing', label: 'No PDF yet', kind: 'slides', hasFile: false, sourceUrl: 'https://example.com/missing.pptx' },
  ]);

  const fileRes = await fetch(`${base}/api/projects/fixture-book/materials/slides-intro/file`);
  assert.equal(fileRes.status, 200);
  assert.match(await fileRes.text(), /fake deck pdf/);

  const rangeRes = await fetch(`${base}/api/projects/fixture-book/materials/slides-intro/file`, {
    headers: { Range: 'bytes=0-3' },
  });
  assert.equal(rangeRes.status, 206);
  assert.equal(await rangeRes.text(), '%PDF');

  const noFile = await req('/api/projects/fixture-book/materials/slides-missing/file');
  assert.equal(noFile.res.status, 404);
  const unknown = await req('/api/projects/fixture-book/materials/nope/file');
  assert.equal(unknown.res.status, 404);
  const unknownProject = await req('/api/projects/nope/materials');
  assert.equal(unknownProject.res.status, 404);
});

test('labs: list, get, put round-trip, validation', async () => {
  let r = await req('/api/projects/fixture-book/labs');
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json, {
    chapters: [
      { chapter: 'Chap01', files: [{ name: '1_1_Test.ipynb', path: 'labs/Chap01/1_1_Test.ipynb' }] },
      { chapter: 'Chap02', files: [{ name: '2_1_Second.ipynb', path: 'labs/Chap02/2_1_Second.ipynb' }] },
    ],
  });

  r = await req('/api/projects/fixture-book/labs/Chap01/1_1_Test.ipynb');
  assert.equal(r.res.status, 200);
  assert.equal(r.json.name, '1_1_Test.ipynb');
  assert.match(r.json.content, /print\(1\)/);

  // PUT round-trip: save a modified notebook, read it back.
  const updated = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['print(42)'] }] });
  r = await req('/api/projects/fixture-book/labs/Chap01/1_1_Test.ipynb', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: updated }),
  });
  assert.equal(r.res.status, 200);
  r = await req('/api/projects/fixture-book/labs/Chap01/1_1_Test.ipynb');
  assert.match(r.json.content, /print\(42\)/);

  // Invalid notebook JSON, wrong extension, traversal.
  r = await req('/api/projects/fixture-book/labs/Chap01/1_1_Test.ipynb', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'not json' }),
  });
  assert.equal(r.res.status, 400);
  r = await req('/api/projects/fixture-book/labs/Chap01/evil.md', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'x' }),
  });
  assert.equal(r.res.status, 400);
  r = await req('/api/projects/fixture-book/labs/..%2F..%2Fsecret/1_1_Test.ipynb');
  assert.equal(r.res.status, 400);
  r = await req('/api/projects/fixture-book/labs/Chap99/1_1_Test.ipynb');
  assert.equal(r.res.status, 404);
  r = await req('/api/projects/nope/labs');
  assert.equal(r.res.status, 404);
});

const STUB_PROPOSAL = {
  outline: [{ title: 'Introduction', page: 1 }, { title: 'Methods', page: null }],
  noteSkeleton: '# Stub Book\n\n## 1. Introduction\n\n## 2. Methods\n\n',
  chapterMap: { introduction: 0, methods: 1 },
};

test('ai/propose with LLM_STUB_RESPONSE: 200, headings-only proposal, writes nothing', async () => {
  process.env.LLM_STUB_RESPONSE = JSON.stringify(STUB_PROPOSAL);
  const form = new FormData();
  form.append('title', 'Stub Book');
  form.append('file', new Blob([makeTinyPdf('Hello Deep Learning')], { type: 'application/pdf' }), 'stub.pdf');
  const res = await fetch(`${base}/api/import/ai/propose`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.outline, STUB_PROPOSAL.outline);
  assert.equal(json.noteSkeleton, STUB_PROPOSAL.noteSkeleton);
  assert.deepEqual(json.chapterMap, STUB_PROPOSAL.chapterMap);
  assert.equal(json.pagesExtracted, 1);
  // Nothing written to data/.
  assert.ok(!fs.existsSync(path.join(tmpData, 'projects', 'stub-book')));
  delete process.env.LLM_STUB_RESPONSE;
});

test('ai/propose without any LLM config: 503', async () => {
  delete process.env.LLM_STUB_RESPONSE;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  const form = new FormData();
  form.append('title', 'Stub Book');
  form.append('file', new Blob([makeTinyPdf('Hello')], { type: 'application/pdf' }), 'stub.pdf');
  const res = await fetch(`${base}/api/import/ai/propose`, { method: 'POST', body: form });
  assert.equal(res.status, 503);
  const json = await res.json();
  assert.equal(json.error, 'LLM not configured');
  assert.match(json.hint, /LLM_API_KEY/);
});

test('ai/propose with a bad PDF: 400', async () => {
  process.env.LLM_STUB_RESPONSE = JSON.stringify(STUB_PROPOSAL);
  const form = new FormData();
  form.append('file', new Blob(['not a pdf'], { type: 'application/pdf' }), 'bad.pdf');
  const res = await fetch(`${base}/api/import/ai/propose`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
  delete process.env.LLM_STUB_RESPONSE;
});

test('ai/apply: creates a project from a validated proposal; 409 on collision; 400 on prose', async () => {
  const form = new FormData();
  form.append('title', 'AI Test Book');
  form.append('proposal', JSON.stringify(STUB_PROPOSAL));
  form.append('file', new Blob([makeTinyPdf('Hello Deep Learning')], { type: 'application/pdf' }), 'ai.pdf');
  let res = await fetch(`${base}/api/import/ai/apply`, { method: 'POST', body: form });
  assert.equal(res.status, 201);
  let json = await res.json();
  assert.equal(json.project.slug, 'ai-test-book');
  assert.deepEqual(json.project.outline, STUB_PROPOSAL.outline);
  assert.deepEqual(json.project.chapterMap, STUB_PROPOSAL.chapterMap);
  assert.equal(
    fs.readFileSync(path.join(tmpData, 'projects', 'ai-test-book', 'notes', 'chapter-01-introduction.md'), 'utf8'),
    '## 1. Introduction\n\n',
  );
  assert.equal(
    fs.readFileSync(path.join(tmpData, 'projects', 'ai-test-book', 'notes', 'chapter-02-methods.md'), 'utf8'),
    '## 2. Methods\n\n',
  );
  // The skeleton's header lives in project.json notesHeader, and the
  // master index links both chapter files.
  const appliedProject = JSON.parse(
    fs.readFileSync(path.join(tmpData, 'projects', 'ai-test-book', 'project.json'), 'utf8'),
  );
  assert.equal(appliedProject.notesHeader, '# Stub Book\n\n');
  assert.match(
    fs.readFileSync(path.join(tmpData, 'projects', 'ai-test-book', 'notes', 'index.md'), 'utf8'),
    /\[1\. Introduction\]\(chapter-01-introduction\.md\)/,
  );
  assert.match(
    fs.readFileSync(path.join(tmpData, 'projects', 'ai-test-book', 'notes', 'index.md'), 'utf8'),
    /\[2\. Methods\]\(chapter-02-methods\.md\)/,
  );
  assert.deepEqual(json.project.noteFiles, ['chapter-01-introduction.md', 'chapter-02-methods.md']);
  assert.ok(fs.existsSync(path.join(tmpData, 'projects', 'ai-test-book', 'source.pdf')));

  // Same title again -> 409 slug collision.
  const form2 = new FormData();
  form2.append('title', 'AI Test Book');
  form2.append('proposal', JSON.stringify(STUB_PROPOSAL));
  form2.append('file', new Blob([makeTinyPdf('Hello')], { type: 'application/pdf' }), 'ai.pdf');
  res = await fetch(`${base}/api/import/ai/apply`, { method: 'POST', body: form2 });
  assert.equal(res.status, 409);

  // Proposal with prose in the skeleton -> 400, nothing written.
  const prose = { ...STUB_PROPOSAL, noteSkeleton: '# T\n\n## 1. Introduction\n\nA summary paragraph.\n' };
  const form3 = new FormData();
  form3.append('title', 'Prose Book');
  form3.append('proposal', JSON.stringify(prose));
  form3.append('file', new Blob([makeTinyPdf('Hello')], { type: 'application/pdf' }), 'ai.pdf');
  res = await fetch(`${base}/api/import/ai/apply`, { method: 'POST', body: form3 });
  assert.equal(res.status, 400);
  assert.ok(!fs.existsSync(path.join(tmpData, 'projects', 'prose-book')));
});
