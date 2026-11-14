// Endpoint tests for the Manage-page deletes (user 2026-11-14):
// DELETE /materials/:id, DELETE /sections/:sectionId and DELETE
// /sections/:sectionId/notebooks/:name. Each delete removes the entry
// and its file (a file material's file + source document; a section's
// notebook files + its directory; the Labs delete also removes
// notes/labs/ so the lazy backfill never resurrects it). repo-files/
// and notes.md are never touched; unknown ids are 404.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTinyPdf } from './pdftext.test.js';

process.env.NODE_ENV = 'test';
const tmpData = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-manage-deletes-'));
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

const UPLOAD_NB = {
  cells: [{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['x = 1'] }],
  metadata: {
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python' },
    language_info: { name: 'python' },
  },
  nbformat: 4,
  nbformat_minor: 5,
};

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

const getJson = (p) => reqJson('GET', p);
const delJson = (p) => reqJson('DELETE', p);

async function seedProject(slug, { kind = null, sourceType = 'none', file = null, materials = [], sections = [] } = {}) {
  const dir = path.join(tmpData, 'projects', slug);
  await fsp.mkdir(path.join(dir, 'notes'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify({
    slug, title: slug, author: null, kind, sourceType,
    ...(file ? { file } : {}),
    cover: null, materials, chapterMap: {}, links: [],
    ...(sections.length ? { sections } : {}),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  await fsp.writeFile(path.join(dir, 'notes', 'notes.md'), `# ${slug}\n`);
  return dir;
}

async function writeNb(dir, relPath) {
  const file = path.join(dir, relPath);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(UPLOAD_NB, null, 2), 'utf8');
  return file;
}

const VIDEO_MAT = {
  id: 'lecture-1', label: 'Lecture 1', kind: 'video',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ',
};
const LINK_MAT = {
  id: 'guide', label: 'Guide', kind: 'link', url: 'https://example.com/guide',
};

// --- DELETE /materials/:id ---

test('DELETE /materials/:id: a video material drops the entry only; a second delete is 404', async () => {
  await seedProject('del-mat-video', { materials: [VIDEO_MAT, LINK_MAT] });
  const r = await delJson('/api/projects/del-mat-video/materials/lecture-1');
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, 'lecture-1');
  assert.deepEqual(r.json.materials.map((m) => m.id), ['guide']);
  const list = await getJson('/api/projects/del-mat-video/materials');
  assert.deepEqual(list.json.map((m) => m.id), ['guide']);
  // The link material is untouched on disk (it never had a file).
  assert.equal(list.json[0].kind, 'link');
  const again = await delJson('/api/projects/del-mat-video/materials/lecture-1');
  assert.equal(again.status, 404);
  const unknown = await delJson('/api/projects/del-mat-video/materials/nope');
  assert.equal(unknown.status, 404);
  const gone = await delJson('/api/projects/no-such-project/materials/lecture-1');
  assert.equal(gone.status, 404);
});

test('DELETE /materials/:id: a link material drops the entry only', async () => {
  await seedProject('del-mat-link', { materials: [VIDEO_MAT, LINK_MAT] });
  const r = await delJson('/api/projects/del-mat-link/materials/guide');
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, 'guide');
  assert.deepEqual(r.json.materials.map((m) => m.id), ['lecture-1']);
});

test('DELETE /materials/:id: a file material also deletes its file from disk', async () => {
  const dir = await seedProject('del-mat-file', { materials: [] });
  const form = new FormData();
  form.append('file', new Blob([makeTinyPdf('Extra PDF')]), 'appendix.pdf');
  form.append('label', 'Appendix');
  const up = await fetch(`${base}/api/projects/del-mat-file/materials`, { method: 'POST', body: form });
  assert.equal(up.status, 201);
  const created = await up.json();
  assert.equal(created.id, 'appendix');
  const fileOnDisk = path.join(dir, 'materials', 'appendix.pdf');
  assert.equal((await fsp.stat(fileOnDisk)).isFile(), true);
  const r = await delJson('/api/projects/del-mat-file/materials/appendix');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.materials, []);
  await assert.rejects(fsp.stat(fileOnDisk));
  const list = await getJson('/api/projects/del-mat-file/materials');
  assert.deepEqual(list.json, []);
});

test('DELETE /materials/:id: never touches the main Source', async () => {
  const dir = await seedProject('del-mat-source', {
    kind: 'pdf', sourceType: 'file', file: 'source.pdf', materials: [VIDEO_MAT],
  });
  await fsp.writeFile(path.join(dir, 'source.pdf'), makeTinyPdf('Book'));
  const r = await delJson('/api/projects/del-mat-source/materials/lecture-1');
  assert.equal(r.status, 200);
  const file = await fetch(`${base}/api/projects/del-mat-source/file`);
  assert.equal(file.status, 200);
  assert.equal((await file.arrayBuffer()).byteLength > 0, true);
  const proj = await getJson('/api/projects/del-mat-source');
  assert.equal(proj.json.file, 'source.pdf');
});

// --- DELETE /sections/:sectionId/notebooks/:name ---

test('DELETE section notebook: entry + file go; siblings stay; unknown notebook/section 404', async () => {
  const dir = await seedProject('del-nb', {
    sections: [{
      id: 'my-stuff', name: 'My Stuff',
      notebooks: [
        { name: 'a.ipynb', path: 'notes/sections/my-stuff/a.ipynb', language: 'python' },
        { name: 'b.ipynb', path: 'notes/sections/my-stuff/b.ipynb', language: 'python' },
      ],
    }],
  });
  await writeNb(dir, 'notes/sections/my-stuff/a.ipynb');
  await writeNb(dir, 'notes/sections/my-stuff/b.ipynb');
  const r = await delJson('/api/projects/del-nb/sections/my-stuff/notebooks/a.ipynb');
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, 'a.ipynb');
  assert.deepEqual(r.json.sections[0].notebooks.map((n) => n.name), ['b.ipynb']);
  await assert.rejects(fsp.stat(path.join(dir, 'notes/sections/my-stuff/a.ipynb')));
  assert.equal((await fsp.stat(path.join(dir, 'notes/sections/my-stuff/b.ipynb'))).isFile(), true);
  const again = await delJson('/api/projects/del-nb/sections/my-stuff/notebooks/a.ipynb');
  assert.equal(again.status, 404);
  const badSection = await delJson('/api/projects/del-nb/sections/nope/notebooks/b.ipynb');
  assert.equal(badSection.status, 404);
  const gone = await delJson('/api/projects/no-such-project/sections/my-stuff/notebooks/b.ipynb');
  assert.equal(gone.status, 404);
});

test('DELETE section notebook: a Labs notebook leaves the disk and is not resurrected', async () => {
  const dir = await seedProject('del-lab-nb', { sections: [] });
  await writeNb(dir, 'notes/labs/Chap01/a.ipynb');
  await writeNb(dir, 'notes/labs/Chap01/b.ipynb');
  // The first read backfills the Labs section from disk.
  const before = await getJson('/api/projects/del-lab-nb');
  assert.deepEqual(before.json.sections.map((s) => s.id), ['labs']);
  assert.deepEqual(before.json.sections[0].notebooks.map((n) => n.name), ['a.ipynb', 'b.ipynb']);
  const r = await delJson('/api/projects/del-lab-nb/sections/labs/notebooks/a.ipynb');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.sections[0].notebooks.map((n) => n.name), ['b.ipynb']);
  await assert.rejects(fsp.stat(path.join(dir, 'notes/labs/Chap01/a.ipynb')));
  // A fresh read does not bring 'a' back — the file is gone, so the
  // backfill has nothing to merge.
  const after = await getJson('/api/projects/del-lab-nb');
  assert.deepEqual(after.json.sections[0].notebooks.map((n) => n.name), ['b.ipynb']);
});

// --- DELETE /sections/:sectionId ---

test('DELETE section: entry + files + directory go; repo-files/ untouched; unknown id 404', async () => {
  const dir = await seedProject('del-section', {
    sections: [{
      id: 'my-stuff', name: 'My Stuff',
      notebooks: [
        {
          name: 'micrograd.ipynb', path: 'notes/sections/my-stuff/micrograd.ipynb',
          language: 'python', repoId: 'fixture-course-repo', repoPath: '001_intro/micrograd.ipynb',
        },
        { name: 'scratch.ipynb', path: 'notes/sections/my-stuff/scratch.ipynb', language: 'python' },
      ],
    }],
  });
  await writeNb(dir, 'notes/sections/my-stuff/micrograd.ipynb');
  await writeNb(dir, 'notes/sections/my-stuff/scratch.ipynb');
  // Shared repo staging: deleting the section must never touch it.
  const staged = path.join(dir, 'repo-files', 'fixture-course-repo', 'data', 'names.txt');
  await fsp.mkdir(path.dirname(staged), { recursive: true });
  await fsp.writeFile(staged, 'alice\n', 'utf8');
  const r = await delJson('/api/projects/del-section/sections/my-stuff');
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, 'my-stuff');
  assert.deepEqual(r.json.sections, []);
  await assert.rejects(fsp.stat(path.join(dir, 'notes/sections/my-stuff')));
  assert.equal(await fsp.readFile(staged, 'utf8'), 'alice\n');
  const notesMd = await fsp.readFile(path.join(dir, 'notes', 'notes.md'), 'utf8');
  assert.match(notesMd, /del-section/);
  const again = await delJson('/api/projects/del-section/sections/my-stuff');
  assert.equal(again.status, 404);
  const badId = await delJson('/api/projects/del-section/sections/BAD_ID!');
  assert.equal(badId.status, 400);
  const gone = await delJson('/api/projects/no-such-project/sections/my-stuff');
  assert.equal(gone.status, 404);
});

test('DELETE section: deleting Labs removes notes/labs/ and never comes back', async () => {
  const dir = await seedProject('del-labs', { sections: [] });
  await writeNb(dir, 'notes/labs/Chap01/a.ipynb');
  await writeNb(dir, 'notes/labs/Chap02/b.ipynb');
  const before = await getJson('/api/projects/del-labs');
  assert.deepEqual(before.json.sections.map((s) => s.id), ['labs']);
  assert.equal(before.json.sections[0].notebooks.length, 2);
  const r = await delJson('/api/projects/del-labs/sections/labs');
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, 'labs');
  assert.deepEqual(r.json.sections, []);
  await assert.rejects(fsp.stat(path.join(dir, 'notes', 'labs')));
  // Fresh reads (which run the lazy backfill) do not resurrect it.
  const after = await getJson('/api/projects/del-labs');
  assert.deepEqual(after.json.sections ?? [], []);
  const labs = await getJson('/api/projects/del-labs/labs');
  assert.deepEqual(labs.json, { chapters: [] });
});
