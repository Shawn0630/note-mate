import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTinyPdf } from './pdftext.test.js';
import { makePdfWithOutline } from './pdfOutline.test.js';

process.env.NODE_ENV = 'test';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nm-ai-note-'));
process.env.DATA_DIR = tmp;
process.env.LLM_ENV_FILE = path.join(tmp, 'no-such.env');

const { default: app } = await import('../src/server.js');

let server;
let base;
const projectDir = path.join(tmp, 'projects', 'fixture-book');

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';

function fixtureNotebook() {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { language: 'python' }, language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', metadata: {}, source: '# Lab' },
      {
        cell_type: 'code', execution_count: 1, metadata: {}, source: 'import numpy as np\nprint(np.arange(3))',
        outputs: [{ output_type: 'stream', name: 'stdout', text: '[0 1 2]\n' }],
      },
      {
        cell_type: 'code', execution_count: 2, metadata: {}, source: 'plt.plot([1,2]); plt.show()',
        outputs: [
          { output_type: 'stream', name: 'stderr', text: 'UserWarning: x\n' },
          { output_type: 'display_data', data: { 'image/png': PNG_1X1 }, metadata: {} },
        ],
      },
    ],
  };
}

async function withLlmEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  const savedFile = process.env.LLM_ENV_FILE;
  process.env.LLM_ENV_FILE = '/nonexistent/none.env';
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (savedFile === undefined) delete process.env.LLM_ENV_FILE; else process.env.LLM_ENV_FILE = savedFile;
  }
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
    outline: [
      { title: 'Introduction', page: 1 },
      { title: 'Methods', page: null },
    ],
    chapterMap: {},
  }));
  await fs.writeFile(path.join(projectDir, 'notes', 'notes.md'),
    '# Fixture Book\n\n## 1. Introduction\n\nMy intro notes.\n');
  const noOutlineDir = path.join(tmp, 'projects', 'no-outline');
  await fs.mkdir(path.join(noOutlineDir, 'notes'), { recursive: true });
  await fs.writeFile(path.join(noOutlineDir, 'source.pdf'), makeTinyPdf('No Outline'));
  await fs.writeFile(path.join(noOutlineDir, 'project.json'), JSON.stringify({
    slug: 'no-outline', title: 'No Outline', kind: 'pdf', sourceType: 'file',
    file: 'source.pdf', outline: [], chapterMap: {},
  }));
  // No STORED outline, but the PDF itself has one — the ai-note route must
  // fall back to reading the PDF's outline (the seeded / file-uploaded case).
  const noStoredDir = path.join(tmp, 'projects', 'no-stored-outline');
  await fs.mkdir(path.join(noStoredDir, 'notes'), { recursive: true });
  await fs.writeFile(path.join(noStoredDir, 'source.pdf'), makePdfWithOutline());
  await fs.writeFile(path.join(noStoredDir, 'project.json'), JSON.stringify({
    slug: 'no-stored-outline', title: 'No Stored Outline', kind: 'pdf',
    sourceType: 'file', file: 'source.pdf', chapterMap: {},
  }));
  await fs.writeFile(path.join(noStoredDir, 'notes', 'notes.md'),
    '# No Stored Outline\n\n## 1. Introduction\n\nMy intro notes.\n');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
});

const post = async (slug, path, body) => {
  const res = await fetch(`${base}/api/projects/${slug}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

// --- ai-note ---------------------------------------------------------------

test('POST ai-note: stub returns demoted markdown + chapter range + context chars', async () => {
  await withLlmEnv({ LLM_STUB_RESPONSE: '## Summary\n\n- attention' }, async () => {
    const { status, json } = await post('fixture-book', '/ai-note', {
      chapter: 'Introduction', prompt: 'Summarize in 5 bullets.', includeNote: true,
    });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.markdown, '### Summary\n\n- attention');
    assert.deepEqual(json.chapter, { title: 'Introduction', startPage: 1, endPage: 1 });
    assert.ok(json.contextChars > 0);
  });
});

test('POST ai-note: no chapter is allowed (prompt only)', async () => {
  await withLlmEnv({ LLM_STUB_RESPONSE: '- a' }, async () => {
    const { status, json } = await post('fixture-book', '/ai-note', { prompt: 'List the key ideas.' });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.markdown, '- a');
    assert.equal(json.chapter, null);
  });
});

test('POST ai-note: 503 with the clear not-configured message when the LLM is off', async () => {
  await withLlmEnv({ LLM_STUB_RESPONSE: undefined, LLM_API_KEY: undefined, LLM_MODEL: undefined }, async () => {
    const { status, json } = await post('fixture-book', '/ai-note', { prompt: 'Summarize.' });
    assert.equal(status, 503);
    assert.equal(json.error, 'LLM not configured');
    assert.match(json.hint, /LLM_API_KEY/);
  });
});

test('POST ai-note: 400s — empty prompt, over-long prompt, unknown chapter, null-page chapter, no outline, bad history', async () => {
  const cases = [
    [{ prompt: '   ' }, /prompt.*required/],
    [{ prompt: 'x'.repeat(2001) }, /exceeds/],
    [{ chapter: 'No Such Chapter', prompt: 'hi' }, /chapter not found/],
    [{ chapter: 'Methods', prompt: 'hi' }, /chapter not found/],
    [{ prompt: 'hi', history: [{ role: 'bogus', content: 'x' }] }, /history entries/],
    [{ prompt: 'hi', history: 'not an array' }, /history must be an array/],
  ];
  for (const [body, re] of cases) {
    const { status, json } = await post('fixture-book', '/ai-note', body);
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(json.error, re);
  }
  const { status, json } = await post('no-outline', '/ai-note', { chapter: 'Introduction', prompt: 'hi' });
  assert.equal(status, 400);
  assert.match(json.error, /no chapter outline/);
});

test('POST ai-note: chapter range from the PDF outline when none is stored', async () => {
  await withLlmEnv({ LLM_STUB_RESPONSE: '- a' }, async () => {
    const intro = await post('no-stored-outline', '/ai-note', {
      chapter: 'Introduction', prompt: 'Summarize.', includeNote: true,
    });
    assert.equal(intro.status, 200, JSON.stringify(intro.json));
    assert.deepEqual(intro.json.chapter, { title: 'Introduction', startPage: 1, endPage: 1 });
    assert.ok(intro.json.contextChars > 0);
    // A subsection does not end its parent chapter: Methods (depth 0) runs
    // to the end of the document, since no later depth-0 entry follows.
    const methods = await post('no-stored-outline', '/ai-note', { chapter: 'Methods', prompt: 'Summarize.' });
    assert.equal(methods.status, 200, JSON.stringify(methods.json));
    assert.deepEqual(methods.json.chapter, { title: 'Methods', startPage: 2, endPage: 3 });
    const details = await post('no-stored-outline', '/ai-note', { chapter: 'Method details', prompt: 'Summarize.' });
    assert.equal(details.status, 200, JSON.stringify(details.json));
    assert.deepEqual(details.json.chapter, { title: 'Method details', startPage: 3, endPage: 3 });
    const unknown = await post('no-stored-outline', '/ai-note', { chapter: 'No Such Chapter', prompt: 'hi' });
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.error, /chapter not found/);
  });
});

test('POST ai-note: unknown project is a 404', async () => {
  const { status } = await post('missing-project', '/ai-note', { prompt: 'hi' });
  assert.equal(status, 404);
});

// --- export-cells ----------------------------------------------------------

test('POST export-cells: markdown + plot file written under notes/assets', async () => {
  const { status, json } = await post('fixture-book', '/export-cells', {
    notebook: fixtureNotebook(), name: '1_1_Test.ipynb', cells: [1, 2],
  });
  assert.equal(status, 200, JSON.stringify(json));
  assert.match(json.markdown, /```python\nimport numpy as np/);
  assert.match(json.markdown, /```\n\[0 1 2\]\n```/);
  assert.match(json.markdown, /\*\*stderr:\*\*/);
  assert.equal(json.images.length, 1);
  const fileName = json.images[0].fileName;
  assert.match(fileName, /^1_1_Test-cell-3-[0-9a-f]{8}\.png$/);
  assert.match(json.markdown, new RegExp(`!\\[Cell 3 plot\\]\\(assets/${fileName}\\)`));
  const buf = await fs.readFile(path.join(projectDir, 'notes', 'assets', fileName));
  assert.equal(buf.toString('base64'), PNG_1X1);
  assert.equal(json.cells, 2);
});

test('POST export-cells: re-exporting unchanged content reuses the same file', async () => {
  const first = await post('fixture-book', '/export-cells', {
    notebook: fixtureNotebook(), name: '1_1_Test.ipynb', cells: [2],
  });
  assert.equal(first.status, 200);
  const dirBefore = await fs.readdir(path.join(projectDir, 'notes', 'assets'));
  const second = await post('fixture-book', '/export-cells', {
    notebook: fixtureNotebook(), name: '1_1_Test.ipynb', cells: [2],
  });
  assert.equal(second.status, 200);
  assert.equal(second.json.images[0].fileName, first.json.images[0].fileName);
  const dirAfter = await fs.readdir(path.join(projectDir, 'notes', 'assets'));
  assert.deepEqual(dirAfter.sort(), dirBefore.sort());
});

test('POST export-cells: 400s — empty selection, out-of-range index, bad name, bad notebook', async () => {
  const cases = [
    [{ notebook: fixtureNotebook(), name: 'a.ipynb', cells: [] }, /at least one cell/],
    [{ notebook: fixtureNotebook(), name: 'a.ipynb', cells: [9] }, /out of range/],
    [{ notebook: fixtureNotebook(), name: '../evil.ipynb', cells: [1] }, /\.ipynb file name/],
    [{ notebook: { nbformat: 4 }, name: 'a.ipynb', cells: [0] }, /missing nbformat or cells array/],
    [{ notebook: null, name: 'a.ipynb', cells: [0] }, /notebook \(object\)/],
  ];
  for (const [body, re] of cases) {
    const { status, json } = await post('fixture-book', '/export-cells', body);
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(json.error, re);
  }
});

test('POST export-cells: unknown project is a 404 and writes nothing', async () => {
  const { status } = await post('missing-project', '/export-cells', {
    notebook: fixtureNotebook(), name: 'a.ipynb', cells: [1],
  });
  assert.equal(status, 404);
  await assert.rejects(fs.stat(path.join(tmp, 'projects', 'missing-project')));
});

// --- asset serving ---------------------------------------------------------

test('GET assets: serves an exported plot as PNG; 404s and 400s', async () => {
  const exported = await post('fixture-book', '/export-cells', {
    notebook: fixtureNotebook(), name: '1_1_Test.ipynb', cells: [2],
  });
  assert.equal(exported.status, 200);
  const fileName = exported.json.images[0].fileName;
  const res = await fetch(`${base}/api/projects/fixture-book/assets/${fileName}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /image\/png/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.toString('base64'), PNG_1X1);

  const missing = await fetch(`${base}/api/projects/fixture-book/assets/nope-12345678.png`);
  assert.equal(missing.status, 404);
  // JPEG is a served asset type too (pasted screenshots) — a missing .jpg
  // is a 404, while a non-image name is a 400.
  const missingJpg = await fetch(`${base}/api/projects/fixture-book/assets/plot.jpg`);
  assert.equal(missingJpg.status, 404);
  const bad = await fetch(`${base}/api/projects/fixture-book/assets/plot.gif`);
  assert.equal(bad.status, 400);
  const noProject = await fetch(`${base}/api/projects/missing-project/assets/${fileName}`);
  assert.equal(noProject.status, 404);
});
