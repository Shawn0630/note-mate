import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';

process.env.NODE_ENV = 'test';
const tmpData = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-project-manage-'));
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

async function reqJson(method, p, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function reqRaw(p) {
  const res = await fetch(`${base}${p}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition') };
}

// Parse a stored (uncompressed) ZIP by walking local file headers.
function parseZip(buf) {
  const entries = new Map(); // name → Buffer
  let p = 0;
  while (p + 4 <= buf.length) {
    if (buf.readUInt32LE(p) !== 0x04034b50) break;
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const size = buf.readUInt32LE(p + 22);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const start = p + 30 + nameLen + extraLen;
    entries.set(name, Buffer.from(buf.subarray(start, start + size)));
    p = start + size;
  }
  return entries;
}

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const PDF_BYTES = Buffer.from('%PDF-1.4\n% fake minimal pdf\n');
const PLOT_NAME = `scratch-cell-2-${crypto.createHash('sha256').update(Buffer.from(PNG_1X1, 'base64')).digest('hex').slice(0, 8)}.png`;
const PROPOSAL = {
  outline: [{ title: 'Introduction', page: 1 }, { title: 'Methods', page: null }],
  noteSkeleton: '# AI Book\n\n## 1. Introduction\n\n## 2. Methods\n\n',
  chapterMap: { introduction: 0, methods: 1 },
};

function aiApplyForm(pdfBuffer = PDF_BYTES, proposal = PROPOSAL) {
  const form = new FormData();
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), 'book.pdf');
  form.append('proposal', JSON.stringify(proposal));
  return form;
}

test('name-only create: no file/URL needed, kind null, sourceType none', async () => {
  const r = await reqJson('POST', '/api/projects', { title: 'Name Only Book' });
  assert.equal(r.status, 201);
  assert.equal(r.json.slug, 'name-only-book');
  assert.equal(r.json.kind, null);
  assert.equal(r.json.sourceType, 'none');
  assert.equal('file' in r.json, false);
  assert.equal('sourceUrl' in r.json, false);
  assert.deepEqual(r.json.noteFiles, ['notes.md']);
  const got = await reqJson('GET', '/api/projects/name-only-book');
  assert.equal(got.json.kind, null);
  const notes = await reqJson('GET', '/api/projects/name-only-book/notes/notes.md');
  assert.equal(notes.json.content, '# Name Only Book\n');
});

test('set source: file upload, then 409 on second attempt; bad extension 400', async () => {
  const created = await reqJson('POST', '/api/projects', { title: 'Source Setter' });
  assert.equal(created.status, 201);
  const form = new FormData();
  form.append('file', new Blob([PDF_BYTES], { type: 'application/pdf' }), 'book.pdf');
  const res = await fetch(`${base}/api/projects/source-setter/source`, { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, 'pdf');
  assert.equal(body.sourceType, 'file');
  assert.equal(body.file, 'source.pdf');
  // Second attempt refuses — the source defines the project.
  const res2 = await fetch(`${base}/api/projects/source-setter/source`, { method: 'POST', body: form });
  assert.equal(res2.status, 409);

  const bad = await reqJson('POST', '/api/projects', { title: 'Bad Source' });
  assert.equal(bad.status, 201);
  const badForm = new FormData();
  badForm.append('file', new Blob([Buffer.from('MZ')], { type: 'application/octet-stream' }), 'evil.exe');
  const badRes = await fetch(`${base}/api/projects/bad-source/source`, { method: 'POST', body: badForm });
  assert.equal(badRes.status, 400);
});

test('set source: URL link, then 409 on second attempt', async () => {
  const created = await reqJson('POST', '/api/projects', { title: 'URL Source' });
  assert.equal(created.status, 201);
  const r = await reqJson('POST', '/api/projects/url-source/source', { url: 'https://example.com/deck.pdf' });
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, 'pdf');
  assert.equal(r.json.sourceType, 'url');
  assert.equal(r.json.sourceUrl, 'https://example.com/deck.pdf');
  const r2 = await reqJson('POST', '/api/projects/url-source/source', { url: 'https://example.com/other.pdf' });
  assert.equal(r2.status, 409);
});

test('AI apply into project: happy path, 409 on sourced project, 409 on non-default notes.md, 400 non-PDF', async () => {
  const created = await reqJson('POST', '/api/projects', { title: 'AI Book' });
  assert.equal(created.status, 201);
  const res = await fetch(`${base}/api/projects/ai-book/import/ai/apply`, { method: 'POST', body: aiApplyForm() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.project.kind, 'pdf');
  assert.equal(body.project.file, 'source.pdf');
  assert.equal(body.project.outline.length, 2);
  const notes = await reqJson('GET', '/api/projects/ai-book/notes/notes.md');
  assert.equal(notes.json.content, PROPOSAL.noteSkeleton);
  // Now sourced — a second apply refuses.
  const res2 = await fetch(`${base}/api/projects/ai-book/import/ai/apply`, { method: 'POST', body: aiApplyForm() });
  assert.equal(res2.status, 409);

  // Non-default notes.md refuses.
  const written = await reqJson('POST', '/api/projects', { title: 'AI Book Two' });
  assert.equal(written.status, 201);
  const put = await reqJson('PUT', '/api/projects/ai-book-two/notes/notes.md', { content: '# AI Book Two\n\nMy own words.\n' });
  assert.equal(put.status, 200);
  const res3 = await fetch(`${base}/api/projects/ai-book-two/import/ai/apply`, { method: 'POST', body: aiApplyForm() });
  assert.equal(res3.status, 409);

  // Non-PDF file refuses.
  const notPdf = await reqJson('POST', '/api/projects', { title: 'AI Book Three' });
  assert.equal(notPdf.status, 201);
  const badForm = new FormData();
  badForm.append('file', new Blob([Buffer.from('not a pdf')], { type: 'text/plain' }), 'notes.txt');
  badForm.append('proposal', JSON.stringify(PROPOSAL));
  const res4 = await fetch(`${base}/api/projects/ai-book-three/import/ai/apply`, { method: 'POST', body: badForm });
  assert.equal(res4.status, 400);
});

test('export: ZIP with notes.md + owned notes + converted notebooks + assets; labs and sources excluded', async () => {
  const created = await reqJson('POST', '/api/projects', { title: 'Export Me' });
  assert.equal(created.status, 201);
  const slug = 'export-me';
  const notesMd = '# Export Me\n\n## Introduction\n<!-- @page 3 · source: book · note: intro.md -->\n\nSome body text.\n\n## Preface\n<!-- @page 1 · source: book -->\n\n![shot](assets/pasted-aaaabbbb.png)\n';
  const putMd = await reqJson('PUT', `/api/projects/${slug}/notes/notes.md`, { content: notesMd });
  assert.equal(putMd.status, 200);
  const note = '# My intro\n\n<!-- @page 3 · source: book -->\n\n![fig](assets/pasted-aaaabbbb.png)\n';
  const putNote = await reqJson('PUT', `/api/projects/${slug}/notes/intro.md`, { content: note });
  assert.equal(putNote.status, 200);
  const notebook = {
    nbformat: 4, nbformat_minor: 5,
    metadata: { kernelspec: { language: 'python' }, language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', metadata: {}, source: '## Scratch work\n\nA note.' },
      {
        cell_type: 'code', execution_count: 1, metadata: {}, source: 'print(1 + 1)',
        outputs: [
          { output_type: 'stream', name: 'stdout', text: '2\n' },
          { output_type: 'display_data', data: { 'image/png': PNG_1X1 }, metadata: {} },
        ],
      },
    ],
  };
  const putNb = await reqJson('PUT', `/api/projects/${slug}/notes/scratch.ipynb`, { content: JSON.stringify(notebook) });
  assert.equal(putNb.status, 200);
  // One real pasted asset on disk (referenced by both notes).
  const asset = await reqJson('POST', `/api/projects/${slug}/assets`, { dataUrl: `data:image/png;base64,${PNG_1X1}` });
  assert.equal(asset.status, 200);
  const pastedName = asset.json.fileName;
  // Rewrite the notes to reference the real pasted file name.
  const notesMdReal = notesMd.replaceAll('pasted-aaaabbbb.png', pastedName);
  await reqJson('PUT', `/api/projects/${slug}/notes/notes.md`, { content: notesMdReal });
  await reqJson('PUT', `/api/projects/${slug}/notes/intro.md`, { content: note.replaceAll('pasted-aaaabbbb.png', pastedName) });
  // A seeded lab must NOT be exported.
  const labDir = path.join(tmpData, 'projects', slug, 'notes', 'labs', 'Chap01');
  await fsp.mkdir(labDir, { recursive: true });
  await fsp.writeFile(path.join(labDir, 'lab.ipynb'), JSON.stringify(notebook), 'utf8');

  const got = await reqRaw(`/api/projects/${slug}/export`);
  assert.equal(got.status, 200);
  assert.match(got.type, /application\/zip/);
  assert.match(got.disposition, /attachment; filename="export-me-export\.zip"/);
  const entries = parseZip(got.buf);
  const names = [...entries.keys()].sort();
  assert.deepEqual(names, [
    `export-me/assets/${pastedName}`,
    `export-me/assets/${PLOT_NAME}`,
    'export-me/intro.md',
    'export-me/notes.md',
    'export-me/scratch.md',
  ]);
  // notes.md verbatim, anchor comment lines in place.
  assert.equal(entries.get('export-me/notes.md').toString('utf8'), notesMdReal);
  assert.match(entries.get('export-me/notes.md').toString('utf8'), /<!-- @page 3 · source: book · note: intro\.md -->/);
  assert.match(entries.get('export-me/notes.md').toString('utf8'), /<!-- @page 1 · source: book -->/);
  assert.equal(entries.get('export-me/intro.md').toString('utf8'), note.replaceAll('pasted-aaaabbbb.png', pastedName));
  // Notebook converted: markdown verbatim, code fenced, stdout block, plot link.
  const scratch = entries.get('export-me/scratch.md').toString('utf8');
  assert.ok(scratch.startsWith('# scratch\n\n## Scratch work\n\nA note.'));
  assert.match(scratch, /```python\nprint\(1 \+ 1\)\n```/);
  assert.match(scratch, /```\n2\n```/);
  assert.ok(scratch.includes(`![Cell 2 plot](assets/${PLOT_NAME})`));
  // Every assets/ reference resolves to a file in the ZIP.
  for (const mdName of ['export-me/notes.md', 'export-me/intro.md', 'export-me/scratch.md']) {
    const md = entries.get(mdName).toString('utf8');
    for (const [, ref] of md.matchAll(/!\[.*?\]\((assets\/[^)]+)\)/g)) {
      assert.ok(entries.has(`export-me/${ref}`), `${mdName} references missing ${ref}`);
    }
  }
  // Plot bytes are the notebook's PNG; pasted bytes are the uploaded PNG.
  assert.deepEqual(entries.get(`export-me/assets/${PLOT_NAME}`), Buffer.from(PNG_1X1, 'base64'));
  assert.deepEqual(entries.get(`export-me/assets/${pastedName}`), Buffer.from(PNG_1X1, 'base64'));
});
