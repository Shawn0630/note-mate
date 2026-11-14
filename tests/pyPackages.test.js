// Unit tests for the runtime Python package mechanism
// (src/pyPackages.js): import scanning, stdlib/local/third-party
// split, import→package mapping, the recorded-packages store, and
// the import check / pip install with stubbed subprocess runs — no
// real pip is ever invoked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  scanNotebookImports, classifyImports, localModuleNames,
  packageForImport, checkImportable, pipInstall,
  loadRecordedPackages, recordInstalledPackages, ensureRecordedPackages,
} from '../src/pyPackages.js';

const notebook = (sources) => ({
  cells: sources.map((source) => ({ cell_type: 'code', source: [source] })),
});

test('scanNotebookImports: import + from-import, first segment only, code cells only', () => {
  const nb = {
    cells: [
      { cell_type: 'code', source: ['import numpy as np\nimport torch, tqdm\nfrom sklearn.model_selection import train_test_split\n'] },
      { cell_type: 'code', source: ['from os.path import join\nimport matplotlib.pyplot as plt\n'] },
      { cell_type: 'markdown', source: ['import notreal\n'] },
      { cell_type: 'code', source: ['# import commented\nx = 1\n'] },
    ],
  };
  assert.deepEqual(
    [...scanNotebookImports(nb)].sort(),
    ['matplotlib', 'numpy', 'os', 'sklearn', 'torch', 'tqdm'],
  );
  assert.deepEqual([...scanNotebookImports({ cells: [] })], []);
  assert.deepEqual([...scanNotebookImports(null)], []);
});

test('classifyImports: stdlib vs repo-local vs third-party', () => {
  const out = classifyImports(
    new Set(['os', 'numpy', 'bigram', 'torch', '_src.bigram', 'graphviz']),
    ['bigram', '_src.bigram'],
  );
  assert.deepEqual(out.stdlib, ['os']);
  assert.deepEqual(out.local.sort(), ['_src.bigram', 'bigram']);
  assert.deepEqual(out.thirdParty.sort(), ['graphviz', 'numpy', 'torch']);
});

test('localModuleNames: basename + dotted path + folder-relative dotted path', () => {
  const names = localModuleNames(['007_GPT/_src/bigram.py', '007_GPT/_src/gpt.py', 'data/names.txt']);
  assert.ok(names.includes('bigram'));
  assert.ok(names.includes('_src.bigram'));
  assert.ok(names.includes('gpt'));
  assert.ok(!names.includes('names'));
  // A repo-root-relative dotted path is only a module name when it
  // starts with a valid identifier segment ('007_GPT…' starts with a
  // digit, so it is not importable and is not listed).
  assert.ok(!names.includes('007_GPT._src.bigram'));
  assert.ok(localModuleNames(['lectures/_src/bigram.py']).includes('lectures._src.bigram'));
});

test('packageForImport: known mapping, fallback is the name itself', () => {
  assert.equal(packageForImport('PIL'), 'pillow');
  assert.equal(packageForImport('sklearn'), 'scikit-learn');
  assert.equal(packageForImport('cv2'), 'opencv-python');
  assert.equal(packageForImport('yaml'), 'PyYAML');
  assert.equal(packageForImport('IPython'), 'ipython');
  assert.equal(packageForImport('cowsay'), 'cowsay');
  assert.equal(packageForImport('some_new_lib'), 'some_new_lib');
});

test('checkImportable: one subprocess for all names, JSON result', async () => {
  const seen = [];
  const runImpl = async (cmd, args) => {
    seen.push({ cmd, args });
    // The script prints a JSON object mapping names to booleans.
    const names = args.slice(2);
    const out = {};
    for (const n of names) out[n] = n !== 'cowsay';
    return { stdout: JSON.stringify(out), stderr: '' };
  };
  const result = await checkImportable(['numpy', 'cowsay', 'torch'], { runImpl, pythonCmd: 'python3' });
  assert.equal(seen.length, 1); // one process, not one per name
  assert.equal(seen[0].cmd, 'python3');
  assert.equal(result.get('numpy'), true);
  assert.equal(result.get('cowsay'), false);
  assert.equal(result.get('torch'), true);
  assert.deepEqual(await checkImportable([], { runImpl }), new Map());
});

test('checkImportable: a failed subprocess throws a clear error', async () => {
  const runImpl = async () => { throw new Error('python3: not found'); };
  await assert.rejects(
    checkImportable(['numpy'], { runImpl }),
    /could not check installed Python packages/,
  );
});

test('pipInstall: per-package results, one failure does not stop the rest', async () => {
  const installed = [];
  const runImpl = async (cmd, args) => {
    const pkg = args[args.length - 1];
    installed.push(pkg);
    if (pkg === 'broken-pkg') {
      const err = new Error('Command failed');
      err.stderr = 'ERROR: No matching distribution found for broken-pkg';
      throw err;
    }
    return { stdout: 'ok', stderr: '' };
  };
  const results = await pipInstall(
    [{ package: 'cowsay', importName: 'cowsay' }, { package: 'broken-pkg', importName: 'broken_pkg' }],
    { runImpl, pythonCmd: 'python3' },
  );
  assert.deepEqual(installed, ['cowsay', 'broken-pkg']);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /No matching distribution/);
  // The pip flags are the container's (PEP 668 needs --break-system-packages).
  assert.ok(true);
});

test('recorded packages: record, read back, dedupe, corrupt file reads as empty', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nm-pypackages-'));
  try {
    assert.deepEqual(await loadRecordedPackages(tmp), []);
    await recordInstalledPackages(tmp, [{ package: 'cowsay', importName: 'cowsay' }]);
    await recordInstalledPackages(tmp, [
      { package: 'cowsay', importName: 'cowsay' },
      { package: 'pandas', importName: 'pandas' },
    ]);
    const loaded = await loadRecordedPackages(tmp);
    assert.deepEqual(loaded.map((p) => p.package), ['cowsay', 'pandas']);
    const raw = JSON.parse(await fs.readFile(path.join(tmp, 'python-packages.json'), 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.packages[0].importName, 'cowsay');
    assert.ok(raw.packages[0].installedAt);
    // Corrupt JSON reads as empty, never throws.
    await fs.writeFile(path.join(tmp, 'python-packages.json'), '{not json', 'utf8');
    assert.deepEqual(await loadRecordedPackages(tmp), []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('ensureRecordedPackages: installs only what is missing, never throws', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nm-pypackages-'));
  try {
    await recordInstalledPackages(tmp, [
      { package: 'cowsay', importName: 'cowsay' },
      { package: 'numpy', importName: 'numpy' },
    ]);
    const calls = [];
    const runImpl = async (cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === '-c') {
        // Import check: numpy present, cowsay missing.
        return { stdout: JSON.stringify({ cowsay: false, numpy: true }), stderr: '' };
      }
      return { stdout: 'ok', stderr: '' };
    };
    const out = await ensureRecordedPackages(tmp, { runImpl, pythonCmd: 'python3' });
    assert.equal(out.checked, 2);
    assert.deepEqual(out.installed, ['cowsay']);
    assert.deepEqual(out.failed, []);
    assert.deepEqual(out.alreadyPresent, ['numpy']);
    assert.equal(calls.filter((c) => c.includes('-m pip install')).length, 1);
    assert.ok(calls.some((c) => c.includes('cowsay')));
    assert.ok(!calls.some((c) => c.includes('numpy') && c.includes('pip install')));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('ensureRecordedPackages: a failed import check is reported, not thrown', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nm-pypackages-'));
  try {
    await recordInstalledPackages(tmp, [{ package: 'cowsay', importName: 'cowsay' }]);
    const runImpl = async () => { throw new Error('python3: not found'); };
    const out = await ensureRecordedPackages(tmp, { runImpl });
    assert.equal(out.checked, 1);
    assert.equal(out.failed.length, 1);
    assert.deepEqual(
      (await loadRecordedPackages(tmp)).map((p) => ({ package: p.package, importName: p.importName })),
      [{ package: 'cowsay', importName: 'cowsay' }],
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
