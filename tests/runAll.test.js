import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
const tmpData = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-runall-test-'));
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

function runAll(language, cells) {
  return req('/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language, cells: cells.map((source) => ({ source })) }),
  });
}

test('run-all python: state persists across cells (the UDL Chap01 case)', async () => {
  const r = await runAll('python', [
    '# Imports math library\nimport numpy as np\n# Imports plotting library\nimport matplotlib.pyplot as plt',
    'def linear_function_1D(x, beta, omega):\n  y = x\n  return y',
    'x = np.arange(0.0, 10.0, 0.01)\nbeta = 0.0; omega = 1.0\ny = linear_function_1D(x, beta, omega)\nprint("y sum", int(y.sum()))',
  ]);
  assert.equal(r.res.status, 200);
  assert.equal(r.json.results.length, 3);
  // Imports cell: ran clean, no output.
  assert.equal(r.json.results[0].exitCode, 0);
  assert.equal(r.json.results[0].stdout, '');
  assert.equal(r.json.results[0].skipped, false);
  // Plot-free def cell: no output either.
  assert.equal(r.json.results[1].exitCode, 0);
  // The third cell uses np (cell 0) and linear_function_1D (cell 1):
  // in the old isolated mode this was NameError: name 'np' is not defined.
  assert.equal(r.json.results[2].exitCode, 0);
  assert.match(r.json.results[2].stdout, /y sum 4995/);
  assert.equal(r.json.results[2].stderr, '');
});

test('run-all python: plt.show() produces an image (no savefig)', async () => {
  const r = await runAll('python', [
    'import numpy as np\nimport matplotlib.pyplot as plt',
    'x = np.arange(0.0, 10.0, 0.01)\ny = x\nfig, ax = plt.subplots()\nax.plot(x, y, "r-")\nplt.show()\nprint("plotted")',
  ]);
  assert.equal(r.res.status, 200);
  assert.equal(r.json.results[1].exitCode, 0);
  assert.equal(r.json.results[1].stdout, 'plotted\n');
  assert.equal(r.json.results[1].images.length, 1);
  assert.equal(r.json.results[1].images[0].mime, 'image/png');
  const buf = Buffer.from(r.json.results[1].images[0].data, 'base64');
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
  assert.ok(buf.length > 1000);
});

test('run-all python: show() of an already-savefig\'d figure is not duplicated', async () => {
  const r = await runAll('python', [
    'import matplotlib.pyplot as plt',
    'fig, ax = plt.subplots()\nax.plot([0, 1], [0, 1])\nplt.savefig("plot.png")\nplt.show()\nprint("done")',
  ]);
  assert.equal(r.res.status, 200);
  assert.equal(r.json.results[1].exitCode, 0);
  assert.equal(r.json.results[1].images.length, 1);
});

test('run-all python: error stops the run, later cells are skipped', async () => {
  const r = await runAll('python', [
    'print("first")',
    'raise ValueError("boom")',
    'print("never")',
  ]);
  assert.equal(r.res.status, 200);
  assert.equal(r.json.results[0].stdout, 'first\n');
  assert.equal(r.json.results[0].exitCode, 0);
  assert.equal(r.json.results[1].exitCode, 1);
  assert.match(r.json.results[1].stderr, /ValueError: boom/);
  assert.equal(r.json.results[2].skipped, true);
  assert.equal(r.json.results[2].exitCode, null);
  assert.equal(r.json.results[2].stdout, '');
});

test('run-all python: a draw helper defined in one cell and shown in another', async () => {
  const r = await runAll('python', [
    'import numpy as np\nimport matplotlib.pyplot as plt',
    'def draw(x, y):\n    fig, ax = plt.subplots()\n    ax.plot(x, y)\n    plt.show()',
    'x = np.arange(0.0, 5.0, 0.1)\ndraw(x, x * 2)',
  ]);
  assert.equal(r.res.status, 200);
  assert.equal(r.json.results[2].exitCode, 0);
  assert.equal(r.json.results[2].images.length, 1);
});

test('run-all javascript: shared scope across cells, error attribution, skip', async () => {
  const r = await runAll('javascript', [
    'const a = 40;',
    'const b = 2;\nconsole.log(a + b);',
    'throw new Error("kaboom")',
    'console.log("never");',
  ]);
  assert.equal(r.res.status, 200);
  assert.equal(r.json.results.length, 4);
  assert.equal(r.json.results[0].exitCode, 0);
  assert.equal(r.json.results[1].stdout, '42\n');
  assert.equal(r.json.results[1].exitCode, 0);
  assert.equal(r.json.results[2].exitCode, 1);
  assert.match(r.json.results[2].stderr, /kaboom/);
  assert.equal(r.json.results[3].skipped, true);
  assert.equal(r.json.results[3].exitCode, null);
});

test('run-all javascript: stderr goes to the cell that wrote it', async () => {
  const r = await runAll('javascript', [
    'console.error("warn one");',
    'console.log("two");',
  ]);
  assert.equal(r.res.status, 200);
  assert.equal(r.json.results[0].stderr, 'warn one\n');
  assert.equal(r.json.results[0].stdout, '');
  assert.equal(r.json.results[1].stdout, 'two\n');
  assert.equal(r.json.results[1].stderr, '');
});

test('run-all javascript: const redeclaration is a syntax error on the offending cell', async () => {
  const r = await runAll('javascript', [
    'const a = 1;',
    'const a = 2;',
    'console.log(a);',
  ]);
  assert.equal(r.res.status, 200);
  // The redeclaration is in cell 1; cell 0 and cell 2 never ran.
  assert.equal(r.json.results[1].skipped, false);
  assert.equal(r.json.results[1].exitCode, 1);
  assert.match(r.json.results[1].stderr, /already been declared|SyntaxError/);
  assert.equal(r.json.results[0].skipped, true);
  assert.equal(r.json.results[2].skipped, true);
});

test('run-all: java is rejected, validation holds', async () => {
  let r = await runAll('java', ['public class Main {}']);
  assert.equal(r.res.status, 400);
  assert.match(r.json.error, /not supported for java/);

  r = await req('/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'python', cells: [] }),
  });
  assert.equal(r.res.status, 400);

  r = await req('/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'python', cells: [{ source: '   ' }] }),
  });
  assert.equal(r.res.status, 400);

  r = await req('/api/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      language: 'python',
      cells: Array.from({ length: 201 }, () => ({ source: 'x = 1' })),
    }),
  });
  assert.equal(r.res.status, 400);
});
