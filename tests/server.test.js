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

  // GET migrates the legacy notes.md starter (# title + ## Notes) into a
  // per-chapter file: notes.md -> notes.md.migrated, chapter-01-notes.md
  // created, index.md generated, chapters listed.
  r = await req('/api/projects/my-test-book');
  assert.equal(r.res.status, 200);
  assert.equal(r.json.title, 'My Test Book');
  assert.deepEqual(r.json.noteFiles, ['chapter-01-notes.md']);
  assert.deepEqual(r.json.chapters, [
    { number: 1, title: 'Notes', page: null, file: 'chapter-01-notes.md', labs: [] },
  ]);
  assert.ok(fs.existsSync(path.join(tmpData, 'projects', 'my-test-book', 'notes', 'notes.md.migrated')));
  assert.ok(fs.existsSync(path.join(tmpData, 'projects', 'my-test-book', 'notes', 'index.md')));
  assert.equal(r.json.notesHeader, '# My Test Book\n\n');

  // URL project file endpoint redirects.
  r = await req('/api/projects/my-test-book/file', { redirect: 'manual' });
  assert.equal(r.res.status, 302);
  assert.match(r.res.headers.get('location'), /youtube/);

  // Notes list + read + write + traversal rejection. The legacy notes.md
  // is never a tab; the chapter file is.
  r = await req('/api/projects/my-test-book/notes');
  assert.deepEqual(r.json, [{ name: 'chapter-01-notes.md', kind: 'md' }]);

  r = await req('/api/projects/my-test-book/notes/chapter-01-notes.md');
  assert.match(r.json.content, /^## Notes/);

  r = await req('/api/projects/my-test-book/notes/notes.md');
  assert.equal(r.res.status, 404);

  r = await req('/api/projects/my-test-book/notes/index.md');
  assert.match(r.json.content, /\[Notes\]\(chapter-01-notes\.md\)/);

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
