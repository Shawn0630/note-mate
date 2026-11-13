import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTinyPdf } from './pdftext.test.js';

process.env.NODE_ENV = 'test';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nm-assets-endpoints-'));
process.env.DATA_DIR = tmp;
process.env.LLM_ENV_FILE = path.join(tmp, 'no-such.env');

const { default: app } = await import('../src/server.js');

let server;
let base;
const projectDir = path.join(tmp, 'projects', 'fixture-book');
const assetsDir = path.join(projectDir, 'notes', 'assets');

// 1x1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';
// Minimal JPEG: SOI + JFIF header + EOI (the server never parses pixels,
// it only validates the data: URL shape and stores the bytes).
const JPG_B64 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]).toString('base64');
const PNG_BYTES = Buffer.from(PNG_B64, 'base64');
const JPG_BYTES = Buffer.from(JPG_B64, 'base64');

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
  await fs.writeFile(path.join(projectDir, 'notes', 'notes.md'), '# Fixture Book\n');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
});

const reqJson = async (method, p, body) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
};
const reqRaw = async (p) => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, type: res.headers.get('content-type'), buf: Buffer.from(await res.arrayBuffer()) };
};
const upload = (dataUrl, slug = 'fixture-book') =>
  reqJson('POST', `/api/projects/${slug}/assets`, { dataUrl });

test('upload PNG: content-hash name, file on disk, served back byte-identical', async () => {
  const r = await upload(`data:image/png;base64,${PNG_B64}`);
  assert.equal(r.status, 200);
  assert.match(r.json.fileName, /^pasted-[0-9a-f]{8}\.png$/);
  assert.equal(r.json.path, `assets/${r.json.fileName}`);
  const stored = await fs.readFile(path.join(assetsDir, r.json.fileName));
  assert.deepEqual(stored, PNG_BYTES);
  const got = await reqRaw(`/api/projects/fixture-book/assets/${r.json.fileName}`);
  assert.equal(got.status, 200);
  assert.match(got.type, /image\/png/);
  assert.deepEqual(got.buf, PNG_BYTES);
});

test('upload: same bytes twice reuses the same file (dedupe)', async () => {
  const a = await upload(`data:image/png;base64,${PNG_B64}`);
  const b = await upload(`data:image/png;base64,${PNG_B64}`);
  assert.equal(a.json.fileName, b.json.fileName);
});

test('upload JPEG: stored as .jpg, served as image/jpeg', async () => {
  const r = await upload(`data:image/jpeg;base64,${JPG_B64}`);
  assert.equal(r.status, 200);
  assert.match(r.json.fileName, /^pasted-[0-9a-f]{8}\.jpg$/);
  const stored = await fs.readFile(path.join(assetsDir, r.json.fileName));
  assert.deepEqual(stored, JPG_BYTES);
  const got = await reqRaw(`/api/projects/fixture-book/assets/${r.json.fileName}`);
  assert.equal(got.status, 200);
  assert.match(got.type, /image\/jpeg/);
  assert.deepEqual(got.buf, JPG_BYTES);
});

test('upload: bad dataUrl is 400; unknown project is 404', async () => {
  for (const bad of [undefined, '', 'not-a-data-url', 'data:image/gif;base64,AAAA', 'data:text/plain;base64,AAAA']) {
    const r = await upload(bad);
    assert.equal(r.status, 400, `expected 400 for ${bad}`);
  }
  const r = await upload(`data:image/png;base64,${PNG_B64}`, 'no-such-project');
  assert.equal(r.status, 404);
});

test('serve: bad file name is 400; missing file is 404', async () => {
  for (const bad of ['../notes.md', 'x.gif', '.png', 'a b.png']) {
    const got = await reqRaw(`/api/projects/fixture-book/assets/${encodeURIComponent(bad)}`);
    assert.equal(got.status, 400, `expected 400 for ${bad}`);
  }
  const missing = await reqRaw('/api/projects/fixture-book/assets/pasted-deadbeef.png');
  assert.equal(missing.status, 404);
  const noProject = await reqRaw('/api/projects/no-such-project/assets/pasted-deadbeef.png');
  assert.equal(noProject.status, 404);
});
