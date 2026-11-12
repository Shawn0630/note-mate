// PDF annotations endpoints: GET/POST/PUT/DELETE on
// /api/projects/:slug/annotations, stored in annotations.json beside notes/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTinyPdf } from './pdftext.test.js';

process.env.NODE_ENV = 'test';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nm-annotations-'));
process.env.DATA_DIR = tmp;
process.env.LLM_ENV_FILE = path.join(tmp, 'no-such.env');

const { default: app } = await import('../src/server.js');

let server;
let base;
const projectDir = path.join(tmp, 'projects', 'fixture-book');

before(async () => {
  await fs.mkdir(path.join(projectDir, 'notes'), { recursive: true });
  await fs.writeFile(path.join(projectDir, 'source.pdf'), makeTinyPdf('Fixture Book'));
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: 'fixture-book', title: 'Fixture Book', kind: 'pdf', sourceType: 'file', file: 'source.pdf',
  }));
  await fs.writeFile(path.join(projectDir, 'notes', 'notes.md'), '# Fixture Book\n');
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
  return { status: res.status, json: await res.json() };
};

test('annotations: empty list when no file; create + read + update + delete', async () => {
  const empty = await req('GET', '/api/projects/fixture-book/annotations');
  assert.equal(empty.status, 200, JSON.stringify(empty.json));
  assert.deepEqual(empty.json, { annotations: [] });

  const created = await req('POST', '/api/projects/fixture-book/annotations', {
    source: 'book', page: 100, type: 'highlight',
    rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 }, color: 'green',
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.ok(created.json.annotation.id.startsWith('a-'));
  assert.equal(created.json.annotation.color, 'green');
  assert.equal(created.json.annotation.text, '');
  const id = created.json.annotation.id;

  const pin = await req('POST', '/api/projects/fixture-book/annotations', {
    source: 'slides-chap4', page: 3, type: 'note',
    rect: { x: 0.5, y: 0.5, w: 0, h: 0 }, text: 'remember this',
  });
  assert.equal(pin.status, 201, JSON.stringify(pin.json));
  const pinId = pin.json.annotation.id;

  const list = await req('GET', '/api/projects/fixture-book/annotations');
  assert.equal(list.json.annotations.length, 2);

  // Stored on disk, beside notes/ — and separate from notes.md.
  const onDisk = JSON.parse(await fs.readFile(path.join(projectDir, 'annotations.json'), 'utf8'));
  assert.equal(onDisk.annotations.length, 2);
  assert.equal(await fs.readFile(path.join(projectDir, 'notes', 'notes.md'), 'utf8'), '# Fixture Book\n');

  const updated = await req('PUT', `/api/projects/fixture-book/annotations/${pinId}`, { text: 'edited note' });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal(updated.json.annotation.text, 'edited note');
  assert.equal(updated.json.annotation.source, 'slides-chap4'); // partial update keeps the rest

  const gone = await req('DELETE', `/api/projects/fixture-book/annotations/${id}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.deepEqual(gone.json, { deleted: true });
  const after = await req('GET', '/api/projects/fixture-book/annotations');
  assert.equal(after.json.annotations.length, 1);
  assert.equal(after.json.annotations[0].id, pinId);
});

test('annotations: 400 on bad input, 404 on missing project/annotation', async () => {
  const bad = await req('POST', '/api/projects/fixture-book/annotations', {
    source: 'book', page: 1, type: 'highlight', rect: { x: 0, y: 0, w: 0, h: 0 },
  });
  assert.equal(bad.status, 400, JSON.stringify(bad.json));
  const badType = await req('POST', '/api/projects/fixture-book/annotations', {
    source: 'book', page: 1, type: 'freehand', rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
  });
  assert.equal(badType.status, 400, JSON.stringify(badType.json));
  const noProject = await req('GET', '/api/projects/no-such/annotations');
  assert.equal(noProject.status, 404, JSON.stringify(noProject.json));
  const noAnnot = await req('PUT', '/api/projects/fixture-book/annotations/a-missing', { text: 'x' });
  assert.equal(noAnnot.status, 404, JSON.stringify(noAnnot.json));
  const noDel = await req('DELETE', '/api/projects/fixture-book/annotations/a-missing');
  assert.equal(noDel.status, 404, JSON.stringify(noDel.json));
});
