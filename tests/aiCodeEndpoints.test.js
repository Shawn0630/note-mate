import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTinyPdf } from './pdftext.test.js';

process.env.NODE_ENV = 'test';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nm-ai-code-'));
process.env.DATA_DIR = tmp;
process.env.LLM_ENV_FILE = path.join(tmp, 'no-such.env');

const { default: app } = await import('../src/server.js');

let server;
let base;
const projectDir = path.join(tmp, 'projects', 'fixture-code');

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
  await fs.mkdir(path.join(projectDir, 'slides'), { recursive: true });
  await fs.writeFile(path.join(projectDir, 'source.pdf'), makeTinyPdf('Fixture Book'));
  await fs.writeFile(path.join(projectDir, 'slides', 'deck-intro.pdf'), makeTinyPdf('Intro Deck'));
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: 'fixture-code',
    title: 'Fixture Book',
    kind: 'pdf',
    sourceType: 'file',
    file: 'source.pdf',
    outline: [{ title: 'Introduction', page: 1 }],
    chapterMap: {},
    materials: [
      { id: 'slides-introduction', label: 'Introduction', kind: 'slides', file: 'slides/deck-intro.pdf' },
    ],
  }));
  await fs.writeFile(path.join(projectDir, 'notes', 'notes.md'),
    '# Fixture Book\n\n## 1. Introduction\n\nMy intro notes.\n');
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

const STUB_CODE = '```python\nx = np.arange(3)\n```\nBuilds an array of 0, 1, 2.';
const STUB_JAVA = '```java\npublic class Main {\n  public static void main(String[] args) {\n    System.out.println("Hello, World!");\n  }\n}\n```\nPrints Hello, World!.';
const STUB_JS = '```javascript\nconsole.log("Hello, World!");\n```\nLogs Hello, World!.';

// --- ai-code ---------------------------------------------------------------

test('POST ai-code: stub returns code + explanation + chapter range + context', async () => {
  await withLlmEnv({ LLM_STUB_RESPONSE: STUB_CODE }, async () => {
    const { status, json } = await post('fixture-code', '/ai-code', {
      chapter: 'Introduction',
      prompt: 'Plot the first three integers.',
      notebook: 'notes/labs/Chap01/1_1_Test.ipynb',
      cells: ['import numpy as np'],
    });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.code, 'x = np.arange(3)');
    assert.equal(json.language, 'python');
    assert.equal(json.explanation, 'Builds an array of 0, 1, 2.');
    assert.deepEqual(json.chapter, { title: 'Introduction', startPage: 1, endPage: 1 });
    assert.equal(json.source, null);
    assert.ok(json.contextChars > 0);
  });
});

test('POST ai-code: language java / javascript return code in that language', async () => {
  await withLlmEnv({ LLM_STUB_RESPONSE: STUB_JAVA }, async () => {
    const { status, json } = await post('fixture-code', '/ai-code', {
      chapter: 'Introduction',
      prompt: 'Print hello.',
      notebook: 'notes/java-scratch.ipynb',
      language: 'java',
      cells: [],
    });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.language, 'java');
    assert.match(json.code, /public class Main/);
    assert.equal(json.explanation, 'Prints Hello, World!.');
  });
  await withLlmEnv({ LLM_STUB_RESPONSE: STUB_JS }, async () => {
    const { status, json } = await post('fixture-code', '/ai-code', {
      chapter: 'Introduction',
      prompt: 'Log hello.',
      notebook: 'notes/js-scratch.ipynb',
      language: 'javascript',
      cells: [],
    });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.language, 'javascript');
    assert.equal(json.code, 'console.log("Hello, World!");');
  });
});

test('POST ai-code: 400 for an unknown language', async () => {
  const { status, json } = await post('fixture-code', '/ai-code', {
    prompt: 'hi', notebook: 'notes/java-scratch.ipynb', language: 'ruby',
  });
  assert.equal(status, 400, JSON.stringify(json));
  assert.match(json.error, /language must be python, java, or javascript/);
});

test('POST ai-code: deck source + page resolves the slide range (window fallback, no outline)', async () => {
  await withLlmEnv({ LLM_STUB_RESPONSE: STUB_CODE }, async () => {
    const { status, json } = await post('fixture-code', '/ai-code', {
      chapter: 'Introduction',
      prompt: 'Write a loss function.',
      notebook: 'notes/labs/Chap01/1_1_Test.ipynb',
      source: 'slides-introduction',
      page: 1,
      cells: [],
    });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.code, 'x = np.arange(3)');
    assert.equal(json.source, 'slides-introduction');
    assert.equal(json.page, 1);
    // The tiny deck PDF has no outline, so the range is the window around
    // the slide, clamped by the extracted pages (1 page here).
    assert.deepEqual(json.chapter, { title: null, startPage: 1, endPage: 1 });
    assert.ok(json.contextChars > 0);
  });
});

test('POST ai-code: 503 with the clear not-configured message when the LLM is off', async () => {
  await withLlmEnv({ LLM_STUB_RESPONSE: undefined, LLM_API_KEY: undefined, LLM_MODEL: undefined }, async () => {
    const { status, json } = await post('fixture-code', '/ai-code', {
      prompt: 'Write code.', notebook: 'notes/labs/Chap01/1_1_Test.ipynb',
    });
    assert.equal(status, 503);
    assert.equal(json.error, 'LLM not configured');
    assert.match(json.hint, /LLM_API_KEY/);
  });
});

test('POST ai-code: 400s — empty/over-long prompt, bad notebook, bad page, unknown source, bad cells/history', async () => {
  const cases = [
    [{ prompt: '   ', notebook: 'notes/labs/Chap01/1_1_Test.ipynb' }, /prompt.*required/],
    [{ prompt: 'x'.repeat(2001), notebook: 'notes/labs/Chap01/1_1_Test.ipynb' }, /exceeds/],
    [{ prompt: 'hi' }, /notebook/],
    [{ prompt: 'hi', notebook: 'notes.md' }, /notebook/],
    [{ prompt: 'hi', notebook: '../escape.ipynb' }, /inside the project/],
    [{ prompt: 'hi', notebook: 'notes/labs/Chap01/1_1_Test.ipynb', page: 0 }, /page must be a positive integer/],
    [{ prompt: 'hi', notebook: 'notes/labs/Chap01/1_1_Test.ipynb', source: 'no-such-deck', page: 1 }, /unknown source/],
    [{ prompt: 'hi', notebook: 'notes/labs/Chap01/1_1_Test.ipynb', cells: 'not an array' }, /cells must be an array/],
    [{ prompt: 'hi', notebook: 'notes/labs/Chap01/1_1_Test.ipynb', history: [{ role: 'bogus', content: 'x' }] }, /history entries/],
  ];
  for (const [body, re] of cases) {
    const { status, json } = await post('fixture-code', '/ai-code', body);
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(json.error, re);
  }
});

test('POST ai-code: whole-notebook cells + targetCell are accepted (32k budget)', async () => {
  await withLlmEnv({ LLM_STUB_RESPONSE: STUB_CODE }, async () => {
    // A whole UDL-sized notebook: 21 formatted cells, ~9k chars, with the
    // TARGET marker on the cell to change — well inside the 32k budget.
    const cells = Array.from({ length: 21 }, (_, i) => (
      i === 4
        ? '--- cell 4 (code) · TARGET — replace this cell ---\ndef linear_function_1D(x,beta,omega):\n  y = x\n\n  return y'
        : `--- cell ${i} (code) ---\n# cell ${i}\nx = ${i}`
    ));
    const { status, json } = await post('fixture-code', '/ai-code', {
      chapter: 'Introduction',
      prompt: 'implement the linear function',
      notebook: 'notes/labs/Chap01/1_1_Test.ipynb',
      cells,
      targetCell: 4,
    });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.code, 'x = np.arange(3)');
  });
});

test('POST ai-code: 400 for a bad targetCell', async () => {
  for (const targetCell of [-1, 1.5, '4']) {
    const { status, json } = await post('fixture-code', '/ai-code', {
      prompt: 'hi', notebook: 'notes/labs/Chap01/1_1_Test.ipynb', targetCell,
    });
    assert.equal(status, 400, JSON.stringify(json));
    assert.match(json.error, /targetCell must be a non-negative integer/);
  }
});

test('POST ai-code: unknown project is a 404', async () => {
  const { status } = await post('missing-project', '/ai-code', {
    prompt: 'hi', notebook: 'notes/labs/Chap01/1_1_Test.ipynb',
  });
  assert.equal(status, 404);
});

// --- ai-note with a deck source -------------------------------------------

test('POST ai-note: deck source + page builds context from the deck', async () => {
  await withLlmEnv({ LLM_STUB_RESPONSE: '- a' }, async () => {
    const { status, json } = await post('fixture-code', '/ai-note', {
      chapter: 'Introduction', prompt: 'Summarize.', source: 'slides-introduction', page: 1,
    });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.markdown, '- a');
    assert.equal(json.source, 'slides-introduction');
    assert.equal(json.page, 1);
    assert.ok(json.contextChars > 0);
  });
});

test('POST ai-note: unknown source is a 400', async () => {
  const { status, json } = await post('fixture-code', '/ai-note', {
    prompt: 'hi', source: 'no-such-deck', page: 1,
  });
  assert.equal(status, 400);
  assert.match(json.error, /unknown source/);
});
