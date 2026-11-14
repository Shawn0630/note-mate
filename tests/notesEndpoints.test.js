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
  const pyNb = { cells: [], metadata: { kernelspec: { language: 'python', name: 'python3' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 };
  await fs.writeFile(notePath('py.ipynb'), JSON.stringify(pyNb));
  const jvNb = { cells: [], metadata: { kernelspec: { language: 'java', name: 'java' } }, nbformat: 4, nbformat_minor: 5 };
  await fs.writeFile(notePath('jv.ipynb'), JSON.stringify(jvNb));
  await fs.writeFile(notePath('bad.ipynb'), '{not json');
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
  assert.deepEqual((await listNotes()).sort(), ['b.md', 'bad.ipynb', 'jv.ipynb', 'notes.md', 'py.ipynb', 'renamed.md']);
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
  assert.deepEqual((await listNotes()).sort(), ['bad.ipynb', 'jv.ipynb', 'notes.md', 'py.ipynb', 'renamed.md']);
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
  assert.deepEqual((await listNotes()).sort(), ['bad.ipynb', 'jv.ipynb', 'notes.md', 'py.ipynb', 'renamed.md']);
});

test('list: notebooks carry their language from metadata; md entries carry none', async () => {
  const r = await req('GET', '/api/projects/fixture-book/notes');
  assert.equal(r.status, 200);
  const byName = Object.fromEntries(r.json.map((n) => [n.name, n]));
  assert.equal(byName['py.ipynb'].kind, 'ipynb');
  assert.equal(byName['py.ipynb'].language, 'python');
  assert.equal(byName['jv.ipynb'].kind, 'ipynb');
  assert.equal(byName['jv.ipynb'].language, 'java');
  assert.equal(byName['bad.ipynb'].kind, 'ipynb');
  assert.equal(byName['bad.ipynb'].language, null);
  assert.equal(byName['notes.md'].kind, 'md');
  assert.equal('language' in byName['notes.md'], false);
  assert.equal(byName['renamed.md'].kind, 'md');
  assert.equal('language' in byName['renamed.md'], false);
});

const readNotesMd = async () => fs.readFile(notePath('notes.md'), 'utf8');

test('note-links: add files a linked entry under a new heading; notesMd returned', async () => {
  const put = await req('PUT', '/api/projects/fixture-book/notes/link-note.md', { content: '# Link note\n' });
  assert.equal(put.status, 200);
  const r = await req('POST', '/api/projects/fixture-book/note-links', {
    note: 'link-note.md', page: 18, sourceId: 'book',
    heading: 'Chapter One', headingAnchor: '<!-- p. 15 -->',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.added, true);
  assert.match(r.json.notesMd, /## Chapter One\n\n<!-- p\. 15 -->\n\n<!-- @page 18 · source: book · note: link-note\.md -->/);
  assert.equal(await readNotesMd(), r.json.notesMd);
});

test('note-links: adding the same entry again is a no-op', async () => {
  const before = await readNotesMd();
  const r = await req('POST', '/api/projects/fixture-book/note-links', {
    note: 'link-note.md', page: 18, sourceId: 'book', heading: 'Chapter One',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.added, false);
  assert.equal(r.json.notesMd, before);
  assert.equal(before.split('note: link-note.md').length - 1, 1);
});

test('note-links: a second anchor from another chapter lands on the same note (many-to-one)', async () => {
  const r = await req('POST', '/api/projects/fixture-book/note-links', {
    note: 'link-note.md', page: 42, sourceId: 'slides-chap2', heading: 'Chapter Two',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.added, true);
  assert.ok(r.json.notesMd.includes('<!-- @page 18 · source: book · note: link-note.md -->'));
  assert.ok(r.json.notesMd.includes('<!-- @page 42 · source: slides-chap2 · note: link-note.md -->'));
  assert.ok(r.json.notesMd.includes('## Chapter Two'));
});

test('note-links: add validates — missing note 404, bad page 400, missing heading 400', async () => {
  assert.equal((await req('POST', '/api/projects/fixture-book/note-links', {
    note: 'ghost.md', page: 1, sourceId: 'book', heading: 'X',
  })).status, 404);
  assert.equal((await req('POST', '/api/projects/fixture-book/note-links', {
    note: 'link-note.md', page: 0, sourceId: 'book', heading: 'X',
  })).status, 400);
  assert.equal((await req('POST', '/api/projects/fixture-book/note-links', {
    note: 'link-note.md', page: 1, sourceId: 'book', heading: '',
  })).status, 400);
  assert.equal((await req('POST', '/api/projects/fixture-book/note-links', {
    note: 'link-note.md', page: 1, sourceId: 'book',
  })).status, 400);
});

test('note-links: repoint moves the entry under the new chapter heading', async () => {
  const r = await req('POST', '/api/projects/fixture-book/note-links/repoint', {
    note: 'link-note.md',
    from: { page: 18, sourceId: 'book' },
    to: { page: 50, sourceId: 'book', heading: 'Chapter Two' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.moved, true);
  assert.ok(!r.json.notesMd.includes('<!-- @page 18 · source: book · note: link-note.md -->'));
  assert.ok(r.json.notesMd.includes('<!-- @page 50 · source: book · note: link-note.md -->'));
  assert.ok(!r.json.notesMd.includes('## Chapter One')); // left with only <!-- p. 15 --> → dropped
  assert.ok(r.json.notesMd.includes('## Chapter Two'));
  const missing = await req('POST', '/api/projects/fixture-book/note-links/repoint', {
    note: 'link-note.md',
    from: { page: 18, sourceId: 'book' },
    to: { page: 51, sourceId: 'book', heading: 'Chapter Two' },
  });
  assert.equal(missing.status, 404);
});

test('note-links: remove drops one entry; the other stays', async () => {
  const r = await req('POST', '/api/projects/fixture-book/note-links/remove', {
    note: 'link-note.md', page: 42, sourceId: 'slides-chap2',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.removed, 1);
  assert.ok(!r.json.notesMd.includes('<!-- @page 42 · source: slides-chap2 · note: link-note.md -->'));
  assert.ok(r.json.notesMd.includes('<!-- @page 50 · source: book · note: link-note.md -->'));
  const again = await req('POST', '/api/projects/fixture-book/note-links/remove', {
    note: 'link-note.md', page: 42, sourceId: 'slides-chap2',
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.removed, 0);
});

test('delete: linked entries leave notes.md with the file; a bare anchor stays', async () => {
  // A bare-anchor heading (old "+ Note here" slot) under Chapter Three.
  const before = await readNotesMd();
  const withBare = `${before.replace(/\n+$/, '')}\n\n## Chapter Three\n\n<!-- @page 7 · source: book -->\n`;
  assert.equal((await req('PUT', '/api/projects/fixture-book/notes/notes.md', { content: withBare })).status, 200);
  const r = await req('DELETE', '/api/projects/fixture-book/notes/link-note.md');
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, 'link-note.md');
  assert.equal(await exists('link-note.md'), false);
  assert.ok(!r.json.notesMd.includes('note: link-note.md'));
  assert.ok(!r.json.notesMd.includes('## Chapter Two')); // its only entry is gone → dropped
  assert.ok(r.json.notesMd.includes('## Chapter Three'));
  assert.ok(r.json.notesMd.includes('<!-- @page 7 · source: book -->'));
  assert.equal(await readNotesMd(), r.json.notesMd);
});

test('rename: link entries follow the new name', async () => {
  assert.equal((await req('PUT', '/api/projects/fixture-book/notes/old-name.md', { content: '# Old\n' })).status, 200);
  const add = await req('POST', '/api/projects/fixture-book/note-links', {
    note: 'old-name.md', page: 5, sourceId: 'book', heading: 'Chapter Three',
  });
  assert.equal(add.status, 200);
  assert.equal(add.json.added, true);
  const r = await req('POST', '/api/projects/fixture-book/notes/old-name.md/rename', { name: 'new-name.md' });
  assert.equal(r.status, 200);
  assert.equal(r.json.name, 'new-name.md');
  assert.ok(r.json.notesMd.includes('<!-- @page 5 · source: book · note: new-name.md -->'));
  assert.ok(!r.json.notesMd.includes('note: old-name.md'));
});
