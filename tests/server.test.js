import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
const tmpData = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-server-test-'));
process.env.DATA_DIR = tmpData;

const { default: app } = await import('../src/server.js');

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

async function req(p, opts = {}) {
  const res = await fetch(`${base}${p}`, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { res, json, text };
}

test('GET /health', async () => {
  const { res, json } = await req('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(json, { ok: true });
});

test('projects: empty list, URL create, slug collision, get, notes CRUD', async () => {
  let r = await req('/api/projects');
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json, []);

  r = await req('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'My Test Book', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
  });
  assert.equal(r.res.status, 201);
  assert.equal(r.json.slug, 'my-test-book');
  assert.equal(r.json.kind, 'video');
  assert.equal(r.json.sourceType, 'url');
  assert.deepEqual(r.json.noteFiles, ['notes.md']);

  // Same title again -> -2 slug.
  r = await req('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'My Test Book', url: 'https://example.com/x.pdf' }),
  });
  assert.equal(r.res.status, 201);
  assert.equal(r.json.slug, 'my-test-book-2');
  assert.equal(r.json.kind, 'pdf');

  // Bad create: no title / bad url.
  r = await req('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/x.pdf' }),
  });
  assert.equal(r.res.status, 400);

  r = await req('/api/projects/my-test-book');
  assert.equal(r.res.status, 200);
  assert.equal(r.json.title, 'My Test Book');
  assert.deepEqual(r.json.noteFiles, ['notes.md']);

  // URL project file endpoint redirects.
  r = await req('/api/projects/my-test-book/file', { redirect: 'manual' });
  assert.equal(r.res.status, 302);
  assert.match(r.res.headers.get('location'), /youtube/);

  // Notes list + read + write + traversal rejection.
  r = await req('/api/projects/my-test-book/notes');
  assert.deepEqual(r.json, [{ name: 'notes.md', kind: 'md' }]);

  r = await req('/api/projects/my-test-book/notes/notes.md');
  assert.match(r.json.content, /^# My Test Book/);

  r = await req('/api/projects/my-test-book/notes/new-note.ipynb', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '{"nbformat":4,"cells":[]}' }),
  });
  assert.equal(r.res.status, 200);
  assert.equal(r.json.name, 'new-note.ipynb');

  r = await req('/api/projects/my-test-book/notes/..%2F..%2Fproject.json');
  assert.equal(r.res.status, 400);

  r = await req('/api/projects/my-test-book/notes/evil.txt', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'x' }),
  });
  assert.equal(r.res.status, 400);

  // Chapter map merge.
  r = await req('/api/projects/my-test-book/chapter-map', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mapping: { '1': 0, '2': 1 } }),
  });
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json.chapterMap, { 1: 0, 2: 1 });

  // Cover download (GET) — the bookshelf <img> src; 404 while no cover.
  r = await req('/api/projects/my-test-book/cover');
  assert.equal(r.res.status, 404);

  // Cover upload.
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await req('/api/projects/my-test-book/cover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl: `data:image/png;base64,${tinyPng}` }),
  });
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json, { cover: 'cover.png' });
  assert.ok(fs.existsSync(path.join(tmpData, 'projects', 'my-test-book', 'cover.png')));

  // Cover download (GET) — the bookshelf <img> src, after upload.
  // (Direct fetch: the req() helper already consumes the body as text.)
  const coverRes = await fetch(`${base}/api/projects/my-test-book/cover`);
  assert.equal(coverRes.status, 200);
  assert.match(coverRes.headers.get('content-type'), /image\/png/);
  const coverBytes = Buffer.from(await coverRes.arrayBuffer());
  assert.equal(coverBytes.subarray(1, 4).toString('latin1'), 'PNG');
  // And the bytes on disk are exactly the uploaded PNG.
  assert.deepEqual(
    fs.readFileSync(path.join(tmpData, 'projects', 'my-test-book', 'cover.png')),
    Buffer.from(tinyPng, 'base64'),
  );
});

test('multipart upload creates a file project', async () => {
  const form = new FormData();
  form.append('title', 'Uploaded PDF');
  form.append('file', new Blob(['%PDF-fake'], { type: 'application/pdf' }), 'book.pdf');
  const res = await fetch(`${base}/api/projects`, { method: 'POST', body: form });
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.slug, 'uploaded-pdf');
  assert.equal(json.kind, 'pdf');
  assert.equal(json.sourceType, 'file');

  const fileRes = await fetch(`${base}/api/projects/uploaded-pdf/file`);
  assert.equal(fileRes.status, 200);
  assert.equal(await fileRes.text(), '%PDF-fake');
});

test('POST /api/execute: python, javascript, java, validation', async () => {
  let r = await req('/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'python', code: 'print("hi from python")' }),
  });
  assert.equal(r.res.status, 200);
  assert.equal(r.json.stdout, 'hi from python\n');
  assert.equal(r.json.exitCode, 0);
  assert.deepEqual(r.json.images, []);

  r = await req('/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      language: 'python',
      code: 'import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nplt.plot([0,1],[0,1])\nplt.savefig("plot.png")\nprint("plotted")\n',
    }),
  });
  assert.equal(r.json.exitCode, 0);
  assert.equal(r.json.stdout, 'plotted\n');
  assert.equal(r.json.images.length, 1);
  assert.equal(r.json.images[0].mime, 'image/png');
  assert.ok(r.json.images[0].data.length > 100);

  r = await req('/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'javascript', code: 'console.log(1 + 2); console.error("oops");' }),
  });
  assert.equal(r.json.stdout, '3\n');
  assert.equal(r.json.stderr, 'oops\n');
  assert.equal(r.json.exitCode, 0);

  r = await req('/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      language: 'java',
      code: 'public class Main { public static void main(String[] a) { System.out.println("hi java"); } }',
    }),
  });
  assert.equal(r.json.exitCode, 0);
  assert.equal(r.json.stdout, 'hi java\n');

  // Non-zero exit still returns 200 with the exit code.
  r = await req('/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'python', code: 'raise SystemExit(3)' }),
  });
  assert.equal(r.res.status, 200);
  assert.equal(r.json.exitCode, 3);

  // Validation.
  r = await req('/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'ruby', code: 'puts 1' }),
  });
  assert.equal(r.res.status, 400);
  r = await req('/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'python', code: '   ' }),
  });
  assert.equal(r.res.status, 400);
});

async function createVideoProject(title) {
  const r = await req('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
  });
  assert.equal(r.res.status, 201);
  return r.json.slug;
}

const LEGACY_MASTER = '# Fold Test\n\nByline here.\n\n'
  + '## 1. Introduction\n<!-- p. 15 -->\n\n'
  + '## 2. Supervised learning\n<!-- p. 31 -->\n\n'
  + '## 3. Shallow neural networks\n<!-- p. 39 -->\n';

test('notes migrate: per-chapter files fold back into the master, backup kept', async () => {
  const slug = await createVideoProject('Fold Test');
  const notesDir = path.join(tmpData, 'projects', slug, 'notes');
  // The 55d1761 state: no notes.md, only notes.md.migrated + chapter files + index.md.
  await fsp.rm(path.join(notesDir, 'notes.md'));
  await fsp.writeFile(path.join(notesDir, 'notes.md.migrated'), LEGACY_MASTER, 'utf8');
  await fsp.writeFile(path.join(notesDir, 'chapter-02-supervised-learning.md'),
    '## 2. Supervised learning\n<!-- p. 31 -->\n\n- my supervised note\n\n<!-- labs:start -->\n### Labs\n\n- [2.1 Supervised Learning](labs/Chap02/2_1_Supervised_Learning.ipynb)\n<!-- labs:end -->\n', 'utf8');
  await fsp.writeFile(path.join(notesDir, 'chapter-06-fitting-models.md'),
    '## 6. Fitting models\n<!-- p. 91 -->\n\n- my fitting note\n\n<!-- labs:start -->\n### Labs\n\n- [6.1 Line Search](labs/Chap06/6_1_Line_Search.ipynb)\n<!-- labs:end -->\n', 'utf8');
  await fsp.writeFile(path.join(notesDir, 'chapter-03-shallow-neural-networks.md'),
    '## 3. Shallow neural networks\n<!-- p. 39 -->\n\n<!-- labs:start -->\n### Labs\n\n- [3.1 Shallow Networks I](labs/Chap03/3_1_Shallow_Networks_I.ipynb)\n<!-- labs:end -->\n', 'utf8');
  await fsp.writeFile(path.join(notesDir, 'index.md'), '# Index\n\n- [2. Supervised learning](chapter-02-supervised-learning.md)\n', 'utf8');

  const r = await req(`/api/projects/${slug}/notes/migrate`, { method: 'POST' });
  assert.equal(r.res.status, 200);
  assert.equal(r.json.migrated, 'folded');
  assert.equal(r.json.chapters, 3);
  assert.equal(r.json.droppedEmpty, 1); // ch3 had no user content
  assert.equal(r.json.backupDir, '.chapter-backup');

  const master = await fsp.readFile(path.join(notesDir, 'notes.md'), 'utf8');
  assert.equal(master, '# Fold Test\n\nByline here.\n\n'
    + '## 2. Supervised learning\n<!-- p. 31 -->\n\n- my supervised note\n\n'
    + '## 6. Fitting models\n<!-- p. 91 -->\n\n- my fitting note\n');
  // Old files are moved to the backup dir, not deleted; the index is gone.
  const backup = await fsp.readdir(path.join(notesDir, '.chapter-backup'));
  assert.deepEqual(backup.sort(), [
    'chapter-02-supervised-learning.md',
    'chapter-03-shallow-neural-networks.md',
    'chapter-06-fitting-models.md',
    'index.md',
    'notes.md.migrated',
  ]);
  assert.equal(fs.existsSync(path.join(notesDir, 'chapter-02-supervised-learning.md')), false);
  assert.equal(fs.existsSync(path.join(notesDir, 'index.md')), false);
  // The notes list shows only the master (the backup dir is not listed).
  const list = await req(`/api/projects/${slug}/notes`);
  assert.deepEqual(list.json, [{ name: 'notes.md', kind: 'md' }]);
  // Second run is a no-op.
  const again = await req(`/api/projects/${slug}/notes/migrate`, { method: 'POST' });
  assert.equal(again.json.migrated, 'none');
});

test('notes migrate: legacy single notes.md drops empty skeleton headings', async () => {
  const slug = await createVideoProject('Prune Test');
  const notesDir = path.join(tmpData, 'projects', slug, 'notes');
  await fsp.writeFile(path.join(notesDir, 'notes.md'), LEGACY_MASTER, 'utf8');
  const r = await req(`/api/projects/${slug}/notes/migrate`, { method: 'POST' });
  assert.equal(r.res.status, 200);
  assert.equal(r.json.migrated, 'pruned');
  assert.equal(r.json.droppedEmpty, 3);
  assert.equal(await fsp.readFile(path.join(notesDir, 'notes.md'), 'utf8'),
    '# Fold Test\n\nByline here.\n');
  const again = await req(`/api/projects/${slug}/notes/migrate`, { method: 'POST' });
  assert.equal(again.json.migrated, 'none');
});

test('notes migrate: lazy on project GET', async () => {
  const slug = await createVideoProject('Lazy Test');
  const notesDir = path.join(tmpData, 'projects', slug, 'notes');
  await fsp.rm(path.join(notesDir, 'notes.md'));
  await fsp.writeFile(path.join(notesDir, 'notes.md.migrated'), LEGACY_MASTER, 'utf8');
  await fsp.writeFile(path.join(notesDir, 'chapter-02-supervised-learning.md'),
    '## 2. Supervised learning\n<!-- p. 31 -->\n\n- lazy note\n', 'utf8');
  const r = await req(`/api/projects/${slug}`);
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json.noteFiles, ['notes.md']);
  assert.match(await fsp.readFile(path.join(notesDir, 'notes.md'), 'utf8'), /- lazy note/);
});
