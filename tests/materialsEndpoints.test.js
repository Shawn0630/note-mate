// Endpoint tests for materials: POST /materials (PDF / Word / PowerPoint
// intake) and the file routes, including lazy Word -> PDF conversion.
// The conversion assertions run live with the real soffice and are skipped
// when soffice is not installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeTinyPdf } from './pdftext.test.js';

const execFileAsync = promisify(execFile);

process.env.NODE_ENV = 'test';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nm-materials-endpoints-'));
process.env.DATA_DIR = tmp;
process.env.LLM_ENV_FILE = path.join(tmp, 'no-such.env');

const { default: app } = await import('../src/server.js');

let server;
let base;
const projectDir = path.join(tmp, 'projects', 'fixture-book');
const docxDir = path.join(tmp, 'projects', 'fixture-doc');

const hasSoffice = await (async () => {
  try { await execFileAsync('soffice', ['--version'], { timeout: 10_000 }); return true; }
  catch { return false; }
})();

// A real minimal .docx (python3 zipfile): two paragraphs, a page break
// between them. soffice here cannot EXPORT docx, but it imports and
// converts docx -> pdf fine.
async function makeDocx(file) {
  const script = `
import zipfile
ct = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'''
rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'''
doc = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word doc first page.</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/><w:t>Second page.</w:t></w:r></w:p></w:body></w:document>'''
with zipfile.ZipFile(${JSON.stringify(file)}, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', ct)
    z.writestr('_rels/.rels', rels)
    z.writestr('word/document.xml', doc)
`;
  await execFileAsync('python3', ['-c', script], { timeout: 30_000 });
}

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
    materials: [],
  }));
  await fs.writeFile(path.join(projectDir, 'notes', 'notes.md'), '# Fixture Book\n');
  await fs.mkdir(path.join(docxDir, 'notes'), { recursive: true });
  await makeDocx(path.join(docxDir, 'source.docx'));
  await fs.writeFile(path.join(docxDir, 'project.json'), JSON.stringify({
    slug: 'fixture-doc',
    title: 'Fixture Doc',
    kind: 'pdf',
    sourceType: 'file',
    file: 'source.docx',
    outline: [],
    chapterMap: {},
    materials: [],
  }));
  await fs.writeFile(path.join(docxDir, 'notes', 'notes.md'), '# Fixture Doc\n');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
});

const get = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), text: null };
};
const getJson = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, json: await r.json() };
};
const postMaterial = async (slug, fileName, buffer, label) => {
  const form = new FormData();
  form.append('file', new Blob([buffer]), fileName);
  if (label) form.append('label', label);
  const r = await fetch(`${base}/api/projects/${slug}/materials`, { method: 'POST', body: form });
  return { status: r.status, json: await r.json() };
};

test('POST /materials: a PDF becomes a kind-pdf material and serves', async () => {
  const pdf = makeTinyPdf('Extra PDF');
  const r = await postMaterial('fixture-book', 'appendix.pdf', pdf, 'Appendix');
  assert.equal(r.status, 201);
  assert.equal(r.json.id, 'appendix');
  assert.equal(r.json.kind, 'pdf');
  assert.equal(r.json.hasFile, true);
  const list = await getJson('/api/projects/fixture-book/materials');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.map((m) => m.id), ['appendix']);
  const file = await get('/api/projects/fixture-book/materials/appendix/file');
  assert.equal(file.status, 200);
  assert.equal(file.buf.subarray(0, 5).toString(), '%PDF-');
});

test('POST /materials: a Word doc becomes a kind-pdf material; its file converts on first read', { skip: !hasSoffice }, async () => {
  const docxPath = path.join(tmp, 'upload.docx');
  await makeDocx(docxPath);
  const buf = await fs.readFile(docxPath);
  const r = await postMaterial('fixture-book', 'memo.docx', buf, 'Memo');
  assert.equal(r.status, 201);
  assert.equal(r.json.id, 'memo');
  assert.equal(r.json.kind, 'pdf');
  assert.equal(r.json.hasFile, true);
  // No converted PDF exists yet — the first read converts it.
  const converted = path.join(projectDir, 'materials', 'memo.pdf');
  await assert.rejects(fs.stat(converted));
  const file = await get('/api/projects/fixture-book/materials/memo/file');
  assert.equal(file.status, 200);
  assert.equal(file.buf.subarray(0, 5).toString(), '%PDF-');
  const st = await fs.stat(converted);
  assert.ok(st.size > 0);
  // Second read reuses the cache.
  const again = await get('/api/projects/fixture-book/materials/memo/file');
  assert.equal(again.status, 200);
  assert.equal(again.buf.subarray(0, 5).toString(), '%PDF-');
});

test('POST /materials: bad extension is 400, missing project is 404, missing file is 400', async () => {
  const bad = await postMaterial('fixture-book', 'notes.txt', Buffer.from('hello'), 'Notes');
  assert.equal(bad.status, 400);
  const gone = await postMaterial('no-such-project', 'a.pdf', makeTinyPdf('x'), 'A');
  assert.equal(gone.status, 404);
  const r = await fetch(`${base}/api/projects/fixture-book/materials`, { method: 'POST' });
  assert.equal(r.status, 400);
});

test('GET /materials/:id/file: unknown material is 404', async () => {
  const r = await get('/api/projects/fixture-book/materials/nope/file');
  assert.equal(r.status, 404);
});

test('GET /projects/:slug/file: a Word document as the main source converts on first read', { skip: !hasSoffice }, async () => {
  const file = await get('/api/projects/fixture-doc/file');
  assert.equal(file.status, 200);
  assert.equal(file.buf.subarray(0, 5).toString(), '%PDF-');
  const st = await fs.stat(path.join(docxDir, 'source.pdf'));
  assert.ok(st.size > 0);
});
