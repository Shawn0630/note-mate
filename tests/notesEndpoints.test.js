import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTinyPdf } from './pdftext.test.js';

process.env.NODE_ENV = 'test';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nm-notes-endpoints-'));
process.env.DATA_DIR = tmp;
process.env.LLM_ENV_FILE = path.join(tmp, 'no-such.env');

const { default: app } = await import('../src/server.js');

let server;
let base;
const projectDir = path.join(tmp, 'projects', 'fixture-book');
const notePath = (name) => path.join(projectDir, 'notes', name);

before(async () => {
  await fs.mkdir(path.join(projectDir, 'notes'), { recursive: true });
  await fs.writeFile(path.join(projectDir, 'source.pdf'), makeTinyPdf('Fixture Book'));
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: 'fixture-book',
    title: 'Fixture Book',
    kind: 'pdf',
    sourceType: 'file',
    file: 'source.pdf',
    outline: [],
    chapterMap: {},
  }));
  await fs.writeFile(notePath('notes.md'), '# Fixture Book\n');
  await fs.writeFile(notePath('a.md'), '# A note\n\nkeep me\n');
  await fs.writeFile(notePath('b.md'), '# B note\n');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
});

const req = async (method, p, body) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
};
const listNotes = async () => {
  const r = await req('GET', '/api/projects/fixture-book/notes');
  assert.equal(r.status, 200);
  return r.json.map((n) => n.name);
};
const exists = async (name) => {
  try { await fs.stat(notePath(name)); return true; } catch { return false; }
};

test('rename: file moves on disk, content preserved, list follows', async () => {
  const r = await req('POST', '/api/projects/fixture-book/notes/a.md/rename', { name: 'renamed.md' });
  assert.equal(r.status, 200);
  assert.equal(r.json.name, 'renamed.md');
  assert.equal(await exists('a.md'), false);
  assert.equal(await exists('renamed.md'), true);
  assert.equal(await fs.readFile(notePath('renamed.md'), 'utf8'), '# A note\n\nkeep me\n');
  assert.deepEqual((await listNotes()).sort(), ['b.md', 'notes.md', 'renamed.md']);
});

test('rename: to an existing name is 409, nothing moves', async () => {
  const r = await req('POST', '/api/projects/fixture-book/notes/renamed.md/rename', { name: 'b.md' });
  assert.equal(r.status, 409);
  assert.equal(await exists('renamed.md'), true);
  assert.equal(await exists('b.md'), true);
});

test('rename: notes.md cannot be renamed (400); invalid names are 400; missing note is 404', async () => {
  assert.equal((await req('POST', '/api/projects/fixture-book/notes/notes.md/rename', { name: 'master2.md' })).status, 400);
  assert.equal(await exists('notes.md'), true);
  assert.equal((await req('POST', '/api/projects/fixture-book/notes/renamed.md/rename', { name: 'noext' })).status, 400);
  assert.equal((await req('POST', '/api/projects/fixture-book/notes/renamed.md/rename', { name: '../evil.md' })).status, 400);
  assert.equal((await req('POST', '/api/projects/fixture-book/notes/renamed.md/rename', {})).status, 400);
  assert.equal((await req('POST', '/api/projects/fixture-book/notes/ghost.md/rename', { name: 'x.md' })).status, 404);
  assert.equal(await exists('renamed.md'), true);
});

test('delete: file is gone, list follows', async () => {
  const r = await req('DELETE', '/api/projects/fixture-book/notes/b.md');
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, 'b.md');
  assert.equal(await exists('b.md'), false);
  assert.deepEqual((await listNotes()).sort(), ['notes.md', 'renamed.md']);
});

test('delete: notes.md cannot be deleted (400); missing note is 404; bad name is 400', async () => {
  assert.equal((await req('DELETE', '/api/projects/fixture-book/notes/notes.md')).status, 400);
  assert.equal(await exists('notes.md'), true);
  assert.equal((await req('DELETE', '/api/projects/fixture-book/notes/ghost.md')).status, 404);
  assert.equal((await req('DELETE', '/api/projects/fixture-book/notes/bad%20name.md')).status, 400);
});

test('delete: an owned .ipynb notebook deletes like a note (notes.md stays protected)', async () => {
  const nb = JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 });
  const put = await req('PUT', '/api/projects/fixture-book/notes/scratch.ipynb', { content: nb });
  assert.equal(put.status, 200);
  assert.equal(await exists('scratch.ipynb'), true);
  const r = await req('DELETE', '/api/projects/fixture-book/notes/scratch.ipynb');
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, 'scratch.ipynb');
  assert.equal(await exists('scratch.ipynb'), false);
  assert.deepEqual((await listNotes()).sort(), ['notes.md', 'renamed.md']);
});
