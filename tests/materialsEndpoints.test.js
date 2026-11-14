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

const postYoutubeMaterial = async (slug, body) => {
  const r = await fetch(`${base}/api/projects/${slug}/materials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

test('POST /materials: a YouTube URL becomes a kind-video material with its video id', async () => {
  const created = await postYoutubeMaterial('fixture-book', {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    label: 'Lecture 1',
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.kind, 'video');
  assert.equal(created.json.label, 'Lecture 1');
  assert.equal(created.json.videoId, 'dQw4w9WgXcQ');
  assert.equal(created.json.hasFile, false);
  // A second video (youtu.be form, another id) is allowed alongside it.
  const second = await postYoutubeMaterial('fixture-book', {
    url: 'https://youtu.be/9bZkp7q19f0',
    label: 'Lecture 2',
  });
  assert.equal(second.status, 201);
  assert.equal(second.json.videoId, '9bZkp7q19f0');
  // GET /materials lists both, with their video ids and no file.
  const list = await getJson('/api/projects/fixture-book/materials');
  const videos = list.json.filter((m) => m.kind === 'video');
  assert.equal(videos.length, 2);
  assert.deepEqual(videos.map((m) => m.videoId), ['dQw4w9WgXcQ', '9bZkp7q19f0']);
  // The video has no file to serve.
  const file = await get('/api/projects/fixture-book/materials/lecture-1/file');
  assert.equal(file.status, 404);
});

test('POST /materials: a non-YouTube URL is 400 and writes nothing', async () => {
  const before = await getJson('/api/projects/fixture-book/materials');
  const bad = await postYoutubeMaterial('fixture-book', { url: 'https://vimeo.com/123456789', label: 'Nope' });
  assert.equal(bad.status, 400);
  const noId = await postYoutubeMaterial('fixture-book', { url: 'https://www.youtube.com/watch', label: 'Nope' });
  assert.equal(noId.status, 400);
  const gone = await postYoutubeMaterial('no-such-project', { url: 'https://youtu.be/dQw4w9WgXcQ', label: 'Nope' });
  assert.equal(gone.status, 404);
  const after = await getJson('/api/projects/fixture-book/materials');
  assert.equal(after.json.length, before.json.length);
});

// --- Fill with AI for Materials (propose/apply) + kind 'link' ---

function withLlmEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; }
  const savedFile = process.env.LLM_ENV_FILE;
  process.env.LLM_ENV_FILE = '/nonexistent/none.env';
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      if (savedFile === undefined) delete process.env.LLM_ENV_FILE; else process.env.LLM_ENV_FILE = savedFile;
    });
}

const postJson = async (p, body) => {
  const r = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const MATERIALS_STUB = JSON.stringify({
  materials: [
    { title: 'Lecture 1', kind: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    { title: 'Big Buck Bunny', kind: 'video', url: 'https://youtu.be/aqz-KE-bpKQ' },
    { title: 'Bad', kind: 'video', url: 'https://vimeo.com/1' },
    { title: 'Proposed Guide', kind: 'link', url: 'https://example.com/proposed-guide' },
  ],
  note: 'Four items.',
});

test('POST /materials: a plain link becomes a kind-link material and has no file', async () => {
  const created = await postYoutubeMaterial('fixture-book', {
    url: 'https://example.com/guide', label: 'Guide', kind: 'link',
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.kind, 'link');
  assert.equal(created.json.label, 'Guide');
  assert.equal(created.json.url, 'https://example.com/guide');
  assert.equal(created.json.hasFile, false);
  const list = await getJson('/api/projects/fixture-book/materials');
  const link = list.json.find((m) => m.kind === 'link');
  assert.equal(link.url, 'https://example.com/guide');
  const file = await get('/api/projects/fixture-book/materials/guide/file');
  assert.equal(file.status, 404);
});

test('POST /materials/ai/propose: stub proposal is normalized and deduped against existing materials', async () => {
  await withLlmEnv({ LLM_STUB_RESPONSE: MATERIALS_STUB }, async () => {
    const r = await postJson('/api/projects/fixture-book/materials/ai/propose', {
      messages: [{ role: 'user', content: 'Add the lecture videos and the guide' }],
    });
    assert.equal(r.status, 200);
    // Lecture 1 is already in fixture-book (the YouTube round added it) —
    // it is skipped, not proposed again. The bad video entry is dropped.
    assert.deepEqual(r.json.materials.map((m) => m.title), ['Big Buck Bunny', 'Proposed Guide']);
    assert.equal(r.json.materials[0].kind, 'video');
    assert.equal(r.json.materials[0].url, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
    assert.equal(r.json.materials[1].kind, 'link');
    assert.equal(r.json.dropped, 1);
    assert.equal(r.json.skipped.length, 1);
    assert.equal(r.json.skipped[0].title, 'Lecture 1');
    assert.equal(r.json.skipped[0].reason, 'duplicate');
    assert.equal(r.json.note, 'Four items.');
    // Nothing was written by propose.
    const list = await getJson('/api/projects/fixture-book/materials');
    assert.equal(list.json.some((m) => m.label === 'Big Buck Bunny'), false);
  });
});

test('POST /materials/ai/propose: 503 when the LLM is unconfigured; 400 on a bad thread; 404 on an unknown project', async () => {
  await withLlmEnv({ LLM_STUB_RESPONSE: undefined, LLM_API_KEY: undefined, LLM_MODEL: undefined }, async () => {
    const r = await postJson('/api/projects/fixture-book/materials/ai/propose', {
      messages: [{ role: 'user', content: 'Add videos' }],
    });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /not configured/i);
  });
  await withLlmEnv({ LLM_STUB_RESPONSE: MATERIALS_STUB }, async () => {
    const empty = await postJson('/api/projects/fixture-book/materials/ai/propose', { messages: [] });
    assert.equal(empty.status, 400);
    const noUser = await postJson('/api/projects/fixture-book/materials/ai/propose', {
      messages: [{ role: 'assistant', content: 'hi' }],
    });
    assert.equal(noUser.status, 400);
    const gone = await postJson('/api/projects/no-such-project/materials/ai/propose', {
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(gone.status, 404);
  });
});

test('POST /materials/ai/apply: adds new materials, dedupes on a second apply', async () => {
  const proposal = [
    { title: 'Apply Video', kind: 'video', url: 'https://youtu.be/M7lc1UVf-VE' },
    { title: 'Apply Doc', kind: 'link', url: 'https://example.com/apply-doc' },
  ];
  const first = await postJson('/api/projects/fixture-book/materials/ai/apply', { materials: proposal });
  assert.equal(first.status, 201);
  assert.equal(first.json.added.length, 2);
  assert.deepEqual(first.json.added.map((m) => m.kind), ['video', 'link']);
  assert.equal(first.json.added[0].videoId, 'M7lc1UVf-VE');
  assert.equal(first.json.skipped.length, 0);
  const list = await getJson('/api/projects/fixture-book/materials');
  assert.equal(list.json.some((m) => m.label === 'Apply Video'), true);
  assert.equal(list.json.some((m) => m.label === 'Apply Doc'), true);
  // Applying the same proposal again adds nothing — both are skipped.
  const second = await postJson('/api/projects/fixture-book/materials/ai/apply', { materials: proposal });
  assert.equal(second.status, 201);
  assert.equal(second.json.added.length, 0);
  assert.equal(second.json.skipped.length, 2);
  assert.ok(second.json.skipped.every((s) => s.reason === 'duplicate'));
});

test('POST /materials/ai/apply: a bad entry fails the whole apply and writes nothing', async () => {
  const before = await getJson('/api/projects/fixture-book/materials');
  const bad = await postJson('/api/projects/fixture-book/materials/ai/apply', {
    materials: [
      { title: 'Good', kind: 'video', url: 'https://youtu.be/dQw4w9WgXcQ' },
      { title: 'Bad', kind: 'video', url: 'https://vimeo.com/1' },
    ],
  });
  assert.equal(bad.status, 400);
  const after = await getJson('/api/projects/fixture-book/materials');
  assert.equal(after.json.length, before.json.length);
  const gone = await postJson('/api/projects/no-such-project/materials/ai/apply', {
    materials: [{ title: 'Good', kind: 'video', url: 'https://youtu.be/dQw4w9WgXcQ' }],
  });
  assert.equal(gone.status, 404);
});
