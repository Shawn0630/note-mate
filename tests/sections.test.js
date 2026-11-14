import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
const tmpData = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-sections-'));
process.env.DATA_DIR = tmpData;

const { default: app } = await import('../src/server.js');
const {
  buildLabsSection, mergeSections, normalizeSections,
  nextSectionName, sectionIdFor, scanLabsOnDisk,
} = await import('../src/sections.js');

let server;
let base;
before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(tmpData, { recursive: true, force: true });
});

async function reqJson(method, p, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

const UPLOAD_NB = {
  cells: [{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['x = 1'] }],
  metadata: {
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python' },
    language_info: { name: 'python' },
  },
  nbformat: 4,
  nbformat_minor: 5,
};

// --- Pure helpers ---

test('buildLabsSection: paths, chapters, sorted, language python', () => {
  const section = buildLabsSection([
    { chapter: 'Chap02', name: '2_1_X.ipynb' },
    { chapter: 'Chap01', name: '1_2_B.ipynb' },
    { chapter: 'Chap01', name: '1_1_A.ipynb' },
  ]);
  assert.equal(section.id, 'labs');
  assert.equal(section.name, 'Labs');
  assert.deepEqual(section.notebooks.map((n) => n.name), ['1_1_A.ipynb', '1_2_B.ipynb', '2_1_X.ipynb']);
  assert.equal(section.notebooks[0].path, 'notes/labs/Chap01/1_1_A.ipynb');
  assert.equal(section.notebooks[0].chapter, 'Chap01');
  assert.equal(section.notebooks[0].language, 'python');
});

test('mergeSections: adds missing labs, keeps user sections and user entries, idempotent', () => {
  const seed = buildLabsSection([
    { chapter: 'Chap01', name: '1_1_A.ipynb' },
    { chapter: 'Chap01', name: '1_2_B.ipynb' },
  ]);
  const existing = [
    { id: 'my-stuff', name: 'My Stuff', notebooks: [
      { name: 'scratch.ipynb', path: 'notes/sections/my-stuff/scratch.ipynb', language: 'python' },
    ] },
    { id: 'labs', name: 'Labs', notebooks: [
      { name: '1_1_A.ipynb', path: 'notes/labs/Chap01/1_1_A.ipynb', chapter: 'Chap01', language: 'python' },
      { name: 'custom.ipynb', path: 'notes/sections/labs/custom.ipynb', language: 'java' },
    ] },
  ];
  const merged = mergeSections(existing, seed);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].name, 'My Stuff'); // user section untouched
  const labs = merged.find((s) => s.id === 'labs');
  assert.deepEqual(labs.notebooks.map((n) => n.name), ['1_1_A.ipynb', 'custom.ipynb', '1_2_B.ipynb']);
  // Idempotent: merging again changes nothing.
  assert.deepEqual(mergeSections(merged, seed), merged);
  // No existing sections: the seed section is appended.
  assert.deepEqual(mergeSections([], seed), [seed]);
  assert.deepEqual(mergeSections(undefined, seed), [seed]);
});

test('normalizeSections: drops malformed sections and entries', () => {
  const out = normalizeSections([
    { id: 'ok', name: 'OK', notebooks: [
      { name: 'a.ipynb', path: 'notes/sections/ok/a.ipynb', language: 'Python' },
      { name: '../evil.ipynb', path: 'notes/sections/ok/evil.ipynb' },
      { name: 'b.txt', path: 'notes/sections/ok/b.txt' },
    ] },
    { id: 'bad id!', name: 'Bad' },
    { id: 'noname', notebooks: [] },
    null,
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].notebooks.length, 1);
  assert.equal(out[0].notebooks[0].language, 'python'); // lowercased
});

test('nextSectionName and sectionIdFor', () => {
  assert.equal(nextSectionName([]), 'Section 1');
  assert.equal(nextSectionName([{ name: 'Section 1' }, { name: 'Labs' }]), 'Section 2');
  assert.equal(sectionIdFor('My Stuff', []), 'my-stuff');
  assert.equal(sectionIdFor('My Stuff', [{ id: 'my-stuff' }]), 'my-stuff-2');
  assert.equal(sectionIdFor('My Stuff', [{ id: 'my-stuff' }, { id: 'my-stuff-2' }]), 'my-stuff-3');
  assert.equal(sectionIdFor('', []), 'project'); // slugify's empty-input fallback
});

test('scanLabsOnDisk: .ipynb files per chapter dir, sorted; missing dir reads as none', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-scan-'));
  try {
    await fsp.mkdir(path.join(dir, 'Chap02'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'Chap01'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'Chap02', '2_1_X.ipynb'), '{}');
    await fsp.writeFile(path.join(dir, 'Chap01', '1_2_B.ipynb'), '{}');
    await fsp.writeFile(path.join(dir, 'Chap01', '1_1_A.ipynb'), '{}');
    await fsp.writeFile(path.join(dir, 'Chap01', 'readme.txt'), 'not a notebook');
    await fsp.writeFile(path.join(dir, 'loose.ipynb'), '{}'); // top-level file, not a chapter
    assert.deepEqual(await scanLabsOnDisk(dir), [
      { chapter: 'Chap01', name: '1_1_A.ipynb' },
      { chapter: 'Chap01', name: '1_2_B.ipynb' },
      { chapter: 'Chap02', name: '2_1_X.ipynb' },
    ]);
    assert.deepEqual(await scanLabsOnDisk(path.join(dir, 'no-such-dir')), []);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// --- Endpoints ---

async function makeProject(title) {
  const r = await reqJson('POST', '/api/projects', { title });
  assert.equal(r.status, 201);
  return r.json.slug;
}

test('create section: name → slug id; empty name → first-free "Section N"', async () => {
  const slug = await makeProject('Section Creator');
  const r = await reqJson('POST', `/api/projects/${slug}/sections`, { name: 'My Stuff' });
  assert.equal(r.status, 201);
  assert.equal(r.json.id, 'my-stuff');
  assert.equal(r.json.name, 'My Stuff');
  assert.deepEqual(r.json.notebooks, []);
  const def = await reqJson('POST', `/api/projects/${slug}/sections`, {});
  assert.equal(def.status, 201);
  assert.equal(def.json.name, 'Section 1');
  const def2 = await reqJson('POST', `/api/projects/${slug}/sections`, { name: '' });
  assert.equal(def2.json.name, 'Section 2');
  // Same name twice: allowed, ids stay unique.
  const dup = await reqJson('POST', `/api/projects/${slug}/sections`, { name: 'My Stuff' });
  assert.equal(dup.status, 201);
  assert.equal(dup.json.id, 'my-stuff-2');
  const got = await reqJson('GET', `/api/projects/${slug}`);
  assert.equal(got.json.sections.length, 4);
  // Bad names and unknown projects.
  assert.equal((await reqJson('POST', `/api/projects/${slug}/sections`, { name: 'x'.repeat(121) })).status, 400);
  assert.equal((await reqJson('POST', '/api/projects/no-such-project/sections', { name: 'X' })).status, 404);
});

test('add notebook by create: one empty code cell, language metadata, GET/PUT round-trip', async () => {
  const slug = await makeProject('Create In Section');
  const sec = await reqJson('POST', `/api/projects/${slug}/sections`, { name: 'Practice' });
  assert.equal(sec.status, 201);
  for (const lang of ['python', 'java', 'javascript']) {
    const r = await reqJson('POST', `/api/projects/${slug}/sections/practice/notebooks`,
      { name: `${lang}-scratch.ipynb`, language: lang });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.path, `notes/sections/practice/${lang}-scratch.ipynb`);
    assert.equal(r.json.language, lang);
    const onDisk = JSON.parse(await fsp.readFile(
      path.join(tmpData, 'projects', slug, 'notes', 'sections', 'practice', `${lang}-scratch.ipynb`), 'utf8'));
    assert.equal(onDisk.cells.length, 1);
    assert.equal(onDisk.cells[0].cell_type, 'code');
    assert.deepEqual(onDisk.cells[0].source, []);
    assert.equal(onDisk.metadata.kernelspec.language, lang);
  }
  // GET returns the stored notebook; PUT saves an edit.
  const got = await reqJson('GET', `/api/projects/${slug}/sections/practice/notebooks/python-scratch.ipynb`);
  assert.equal(got.status, 200);
  assert.equal(got.json.path, 'notes/sections/practice/python-scratch.ipynb');
  const nb = JSON.parse(got.json.content);
  nb.cells[0].source = ['print(1)'];
  const put = await reqJson('PUT', `/api/projects/${slug}/sections/practice/notebooks/python-scratch.ipynb`,
    { content: JSON.stringify(nb) });
  assert.equal(put.status, 200);
  const got2 = await reqJson('GET', `/api/projects/${slug}/sections/practice/notebooks/python-scratch.ipynb`);
  assert.deepEqual(JSON.parse(got2.json.content).cells[0].source, ['print(1)']);
  // Duplicate name, bad language, bad name, unknown section/notebook.
  assert.equal((await reqJson('POST', `/api/projects/${slug}/sections/practice/notebooks`,
    { name: 'python-scratch.ipynb', language: 'python' })).status, 409);
  assert.equal((await reqJson('POST', `/api/projects/${slug}/sections/practice/notebooks`,
    { name: 'x.ipynb', language: 'ruby' })).status, 400);
  assert.equal((await reqJson('POST', `/api/projects/${slug}/sections/practice/notebooks`,
    { name: '../evil.ipynb', language: 'python' })).status, 400);
  assert.equal((await reqJson('POST', `/api/projects/${slug}/sections/nope/notebooks`,
    { name: 'x.ipynb', language: 'python' })).status, 404);
  assert.equal((await reqJson('GET', `/api/projects/${slug}/sections/practice/notebooks/nope.ipynb`)).status, 404);
  assert.equal((await reqJson('GET', `/api/projects/${slug}/sections/nope/notebooks/x.ipynb`)).status, 404);
  assert.equal((await reqJson('GET', `/api/projects/${slug}/sections/bad%20id/notebooks/x.ipynb`)).status, 400);
});

test('add notebook by upload: valid .ipynb stored, language from metadata; rejects junk', async () => {
  const slug = await makeProject('Upload Into Section');
  const sec = await reqJson('POST', `/api/projects/${slug}/sections`, { name: 'Uploaded' });
  assert.equal(sec.status, 201);
  const form = new FormData();
  form.append('file', new Blob([JSON.stringify(UPLOAD_NB)], { type: 'application/json' }), '2_1_Uploaded.ipynb');
  const res = await fetch(`${base}/api/projects/${slug}/sections/uploaded/notebooks`, { method: 'POST', body: form });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.name, '2_1_Uploaded.ipynb');
  assert.equal(body.path, 'notes/sections/uploaded/2_1_Uploaded.ipynb');
  assert.equal(body.language, 'python');
  const onDisk = await fsp.readFile(
    path.join(tmpData, 'projects', slug, 'notes', 'sections', 'uploaded', '2_1_Uploaded.ipynb'), 'utf8');
  assert.equal(JSON.parse(onDisk).cells[0].source[0], 'x = 1');
  // Duplicate upload → 409.
  const form2 = new FormData();
  form2.append('file', new Blob([JSON.stringify(UPLOAD_NB)], { type: 'application/json' }), '2_1_Uploaded.ipynb');
  const dup = await fetch(`${base}/api/projects/${slug}/sections/uploaded/notebooks`, { method: 'POST', body: form2 });
  assert.equal(dup.status, 409);
  // Non-ipynb file → 400.
  const badExt = new FormData();
  badExt.append('file', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
  const badRes = await fetch(`${base}/api/projects/${slug}/sections/uploaded/notebooks`, { method: 'POST', body: badExt });
  assert.equal(badRes.status, 400);
  // Invalid notebook JSON → 400.
  const badJson = new FormData();
  badJson.append('file', new Blob(['not json'], { type: 'application/json' }), 'bad.ipynb');
  const badJsonRes = await fetch(`${base}/api/projects/${slug}/sections/uploaded/notebooks`, { method: 'POST', body: badJson });
  assert.equal(badJsonRes.status, 400);
});

test('Labs-section entries resolve through the section API (seed shape)', async () => {
  const slug = await makeProject('Labs Section Api');
  // Simulate what the seed writes: a Labs section pointing at notes/labs/.
  await fsp.mkdir(path.join(tmpData, 'projects', slug, 'notes', 'labs', 'Chap01'), { recursive: true });
  await fsp.writeFile(
    path.join(tmpData, 'projects', slug, 'notes', 'labs', 'Chap01', '1_1_A.ipynb'),
    JSON.stringify(UPLOAD_NB), 'utf8');
  const project = JSON.parse(await fsp.readFile(path.join(tmpData, 'projects', slug, 'project.json'), 'utf8'));
  project.sections = [{
    id: 'labs', name: 'Labs',
    notebooks: [{ name: '1_1_A.ipynb', path: 'notes/labs/Chap01/1_1_A.ipynb', chapter: 'Chap01', language: 'python' }],
  }];
  await fsp.writeFile(path.join(tmpData, 'projects', slug, 'project.json'), JSON.stringify(project, null, 2));
  const got = await reqJson('GET', `/api/projects/${slug}/sections/labs/notebooks/1_1_A.ipynb`);
  assert.equal(got.status, 200);
  assert.equal(got.json.path, 'notes/labs/Chap01/1_1_A.ipynb');
  assert.equal(JSON.parse(got.json.content).cells[0].source[0], 'x = 1');
  // PUT through the section API writes the same lab file.
  const nb = JSON.parse(got.json.content);
  nb.cells[0].source = ['y = 2'];
  const put = await reqJson('PUT', `/api/projects/${slug}/sections/labs/notebooks/1_1_A.ipynb`,
    { content: JSON.stringify(nb) });
  assert.equal(put.status, 200);
  const onDisk = JSON.parse(await fsp.readFile(
    path.join(tmpData, 'projects', slug, 'notes', 'labs', 'Chap01', '1_1_A.ipynb'), 'utf8'));
  assert.deepEqual(onDisk.cells[0].source, ['y = 2']);
});
