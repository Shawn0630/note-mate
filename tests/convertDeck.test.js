// Unit tests for src/convertDeck.js — deck conversion: host soffice fast
// path, container fallback (docker compose run), clear failure when
// neither exists. All exec/docker calls are stubbed; nothing here shells
// out to real soffice, brew, or Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  toContainerPath,
  hostConvertArgv,
  containerConvertArgv,
  composeBuildArgv,
  composeRunArgv,
  hasHostSoffice,
  hasDockerCompose,
  hasBrew,
  isYesAnswer,
  askInstallLibreOffice,
  convertDeck,
  CONVERT_TIMEOUT_MS,
  BUILD_TIMEOUT_MS,
  BREW_INSTALL_TIMEOUT_MS,
} from '../src/convertDeck.js';

const ROOT = '/Users/shawn/Files/Project/note-mate';
const DATA_DIR = path.join(ROOT, 'data');
const SCRATCH = '/Users/shawn/Files/Project/note-mate/tmp-scratch';
const DECK = { id: 'slides-chap2', title: 'Supervised Learning', file: 'UDLChap2.pptx' };
const MINIMAL_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

// A stub execFile: records calls, answers from a script keyed by
// `${cmd} ${args[0]}` (or a default). A step is { ok: true } or
// { ok: false, message } (throws) or { ok: true, writePdf: <dir> }
// (simulates a conversion producing the PDF on disk).
function stubExec(script = {}) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts });
    const key = `${cmd} ${args[0]}`;
    const step = script[key] ?? script['*'] ?? { ok: true };
    if (!step.ok) {
      const err = new Error(step.message || 'stub failure');
      err.code = step.code;
      throw err;
    }
    if (step.writePdf) {
      await fsp.mkdir(step.writePdf, { recursive: true });
      await fsp.writeFile(path.join(step.writePdf, 'UDLChap2.pdf'), MINIMAL_PDF);
    }
    return { stdout: '', stderr: '' };
  };
  exec.calls = calls;
  return exec;
}

async function makeSlidesDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-convert-'));
  const slidesDir = path.join(dir, 'data', 'projects', 'understanding-deep-learning', 'slides');
  await fsp.mkdir(slidesDir, { recursive: true });
  await fsp.writeFile(path.join(slidesDir, 'UDLChap2.pptx'), Buffer.from('PK\x03\x04fake-pptx'));
  return { dir, slidesDir };
}

// Full mirrored layout: <root>/data/projects/.../slides, so the slides
// dir really lives under the data dir the fallback would mount.
async function makeProjectLayout(dataDirName = 'data') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-convert-'));
  const dataDir = path.join(root, dataDirName);
  const slidesDir = path.join(dataDir, 'projects', 'understanding-deep-learning', 'slides');
  await fsp.mkdir(slidesDir, { recursive: true });
  await fsp.writeFile(path.join(slidesDir, 'UDLChap2.pptx'), Buffer.from('PK\x03\x04fake-pptx'));
  return { root, dataDir, slidesDir };
}

test('toContainerPath maps the host data dir to /app/data', () => {
  assert.equal(
    toContainerPath(DATA_DIR, path.join(DATA_DIR, 'projects', 'understanding-deep-learning', 'slides')),
    '/app/data/projects/understanding-deep-learning/slides',
  );
  assert.equal(toContainerPath(DATA_DIR, DATA_DIR), null);
  assert.equal(toContainerPath(DATA_DIR, '/etc/passwd'), null);
  assert.equal(toContainerPath(DATA_DIR, path.join(ROOT, 'other', 'x')), null);
});

test('argv builders: host, container, compose build/run', () => {
  const slidesDir = path.join(DATA_DIR, 'projects', 'understanding-deep-learning', 'slides');
  assert.deepEqual(hostConvertArgv({ slidesDir, pptx: path.join(slidesDir, 'UDLChap2.pptx') }), [
    '--headless', '--convert-to', 'pdf', '--outdir', slidesDir, path.join(slidesDir, 'UDLChap2.pptx'),
  ]);
  assert.deepEqual(hostConvertArgv({ slidesDir, pptx: 'x.pptx', profileDir: '/tmp/p' }), [
    '--env:UserInstallation=file:///tmp/p',
    '--headless', '--convert-to', 'pdf', '--outdir', slidesDir, 'x.pptx',
  ]);
  assert.deepEqual(containerConvertArgv({
    containerSlidesDir: '/app/data/projects/understanding-deep-learning/slides',
    containerPptx: '/app/data/projects/understanding-deep-learning/slides/UDLChap2.pptx',
  }), [
    '--headless', '--convert-to', 'pdf', '--outdir',
    '/app/data/projects/understanding-deep-learning/slides',
    '/app/data/projects/understanding-deep-learning/slides/UDLChap2.pptx',
  ]);
  assert.deepEqual(composeBuildArgv({ root: ROOT }), [
    'compose', '-f', path.join(ROOT, 'docker-compose.yml'), 'build', 'note-mate',
  ]);
  assert.deepEqual(composeRunArgv({ root: ROOT, sofficeArgs: ['--headless', 'x'] }), [
    'compose', '-f', path.join(ROOT, 'docker-compose.yml'), 'run', '--rm', 'note-mate', 'soffice', '--headless', 'x',
  ]);
  assert.equal(CONVERT_TIMEOUT_MS, 300_000);
  assert.equal(BUILD_TIMEOUT_MS, 900_000);
});

test('detection: soffice --version exit 0 vs ENOENT; docker compose version', async () => {
  const present = stubExec({ '*': { ok: true } });
  assert.equal(await hasHostSoffice(present), true);
  assert.equal(await hasDockerCompose(present), true);

  const missing = stubExec({ '*': { ok: false, code: 'ENOENT', message: 'spawn soffice ENOENT' } });
  assert.equal(await hasHostSoffice(missing), false);
  assert.equal(await hasDockerCompose(missing), false);
});

test('skip: existing valid PDF converts nothing (no exec at all)', async () => {
  const { dir, slidesDir } = await makeSlidesDir();
  try {
    await fsp.writeFile(path.join(slidesDir, 'UDLChap2.pdf'), MINIMAL_PDF);
    const exec = stubExec();
    const r = await convertDeck(DECK, slidesDir, { exec, root: ROOT, dataDir: DATA_DIR, scratch: SCRATCH });
    assert.deepEqual(r, { ok: true, bytes: MINIMAL_PDF.length, skipped: true });
    assert.equal(exec.calls.length, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('force: existing PDF is re-converted, not skipped', async () => {
  const { dir, slidesDir } = await makeSlidesDir();
  try {
    await fsp.writeFile(path.join(slidesDir, 'UDLChap2.pdf'), MINIMAL_PDF);
    const exec = stubExec({ 'soffice --version': { ok: true }, 'soffice --headless': { ok: true, writePdf: slidesDir } });
    const r = await convertDeck(DECK, slidesDir, { exec, root: ROOT, dataDir: DATA_DIR, scratch: SCRATCH, force: true });
    assert.equal(r.ok, true);
    assert.equal(r.via, 'host');
    assert.ok(exec.calls.some((c) => c.cmd === 'soffice' && c.args.includes('--headless')));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('host path: soffice present, no docker calls, 300s timeout, TMPDIR=scratch', async () => {
  const { dir, slidesDir } = await makeSlidesDir();
  try {
    const exec = stubExec({ 'soffice --version': { ok: true }, 'soffice --headless': { ok: true, writePdf: slidesDir } });
    const r = await convertDeck(DECK, slidesDir, { exec, root: ROOT, dataDir: DATA_DIR, scratch: SCRATCH });
    assert.equal(r.ok, true);
    assert.equal(r.via, 'host');
    assert.equal(r.bytes, MINIMAL_PDF.length);
    assert.equal(exec.calls.filter((c) => c.cmd === 'docker').length, 0);
    const conv = exec.calls.find((c) => c.cmd === 'soffice' && c.args.includes('--headless'));
    assert.equal(conv.opts.timeout, 300_000);
    assert.equal(conv.opts.env.TMPDIR, SCRATCH);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('host retry: first soffice fails, retry carries the scratch profile', async () => {
  const { dir, slidesDir } = await makeSlidesDir();
  try {
    let n = 0;
    const exec = async (cmd, args, opts) => {
      if (cmd === 'soffice' && args[0] === '--version') return { stdout: '', stderr: '' };
      n += 1;
      if (n === 1) throw new Error('stale profile lock');
      await fsp.writeFile(path.join(slidesDir, 'UDLChap2.pdf'), MINIMAL_PDF);
      return { stdout: '', stderr: '' };
    };
    const r = await convertDeck(DECK, slidesDir, { exec, root: ROOT, dataDir: DATA_DIR, scratch: SCRATCH });
    assert.equal(r.ok, true);
    assert.equal(r.via, 'host');
    assert.equal(n, 2);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('container fallback with the default data dir: build once, run, via container', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-convert-'));
  try {
    // Mirror the real layout: <root>/data/projects/.../slides, root = tmp.
    const root = dir;
    const hostDataDir = path.join(root, 'data');
    const slidesDir = path.join(hostDataDir, 'projects', 'understanding-deep-learning', 'slides');
    await fsp.mkdir(slidesDir, { recursive: true });
    await fsp.writeFile(path.join(slidesDir, 'UDLChap2.pptx'), Buffer.from('PK\x03\x04fake-pptx'));
    const exec = stubExec({
      'soffice --version': { ok: false, code: 'ENOENT', message: 'spawn soffice ENOENT' },
      'docker compose': { ok: true },
    });
    const recordingExec = async (cmd, args, opts) => {
      const out = await exec(cmd, args, opts);
      if (cmd === 'docker' && args.includes('run')) {
        const outdir = args[args.indexOf('--outdir') + 1];
        const hostOut = path.join(hostDataDir, path.relative('/app/data', outdir));
        await fsp.mkdir(hostOut, { recursive: true });
        await fsp.writeFile(path.join(hostOut, 'UDLChap2.pdf'), MINIMAL_PDF);
      }
      return out;
    };
    recordingExec.calls = exec.calls;
    const ctx = { imageBuilt: false };
    const r = await convertDeck(DECK, slidesDir, {
      exec: recordingExec, root, dataDir: hostDataDir, scratch: SCRATCH, ctx,
    });
    assert.equal(r.ok, true);
    assert.equal(r.via, 'container');
    assert.equal(r.bytes, MINIMAL_PDF.length);
    const builds = exec.calls.filter((c) => c.cmd === 'docker' && c.args.includes('build'));
    assert.equal(builds.length, 1);
    assert.equal(builds[0].opts.timeout, 900_000);
    assert.deepEqual(builds[0].args, ['compose', '-f', path.join(root, 'docker-compose.yml'), 'build', 'note-mate']);
    const runs = exec.calls.filter((c) => c.cmd === 'docker' && c.args.includes('run'));
    assert.equal(runs.length, 1);
    assert.equal(runs[0].opts.timeout, 300_000);
    const expectedOut = '/app/data/projects/understanding-deep-learning/slides';
    assert.ok(runs[0].args.includes('--outdir') && runs[0].args.includes(expectedOut));
    assert.ok(runs[0].args.includes(`${expectedOut}/UDLChap2.pptx`));
    assert.ok(runs[0].args.includes('--rm') && runs[0].args.includes('note-mate'));
    assert.equal(ctx.imageBuilt, true);

    // Second deck in the same ctx reuses the image (no second build).
    const deck2 = { id: 'slides-chap3', title: 'Shallow', file: 'UDLChap3.pptx' };
    await fsp.writeFile(path.join(slidesDir, 'UDLChap3.pptx'), Buffer.from('PK\x03\x04fake-pptx'));
    const recordingExec2 = async (cmd, args, opts) => {
      const out = await exec(cmd, args, opts);
      if (cmd === 'docker' && args.includes('run')) {
        const outdir = args[args.indexOf('--outdir') + 1];
        const hostOut = path.join(hostDataDir, path.relative('/app/data', outdir));
        await fsp.mkdir(hostOut, { recursive: true });
        await fsp.writeFile(path.join(hostOut, 'UDLChap3.pdf'), MINIMAL_PDF);
      }
      return out;
    };
    recordingExec2.calls = exec.calls;
    const r2 = await convertDeck(deck2, slidesDir, {
      exec: recordingExec2, root, dataDir: hostDataDir, scratch: SCRATCH, ctx,
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.via, 'container');
    assert.equal(exec.calls.filter((c) => c.cmd === 'docker' && c.args.includes('build')).length, 1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('container retry: first run fails, retry carries /tmp/lo-profile', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-convert-'));
  try {
    const root = dir;
    const hostDataDir = path.join(root, 'data');
    const slidesDir = path.join(hostDataDir, 'projects', 'understanding-deep-learning', 'slides');
    await fsp.mkdir(slidesDir, { recursive: true });
    await fsp.writeFile(path.join(slidesDir, 'UDLChap2.pptx'), Buffer.from('PK\x03\x04fake-pptx'));
    let runs = 0;
    const exec = async (cmd, args, opts) => {
      if (cmd === 'soffice') throw Object.assign(new Error('spawn soffice ENOENT'), { code: 'ENOENT' });
      if (cmd === 'docker' && args.includes('version')) return { stdout: 'Docker Compose version v2', stderr: '' };
      if (cmd === 'docker' && args.includes('build')) return { stdout: '', stderr: '' };
      if (cmd === 'docker' && args.includes('run')) {
        runs += 1;
        if (runs === 1) throw new Error('stale profile lock');
        await fsp.writeFile(path.join(slidesDir, 'UDLChap2.pdf'), MINIMAL_PDF);
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected call ${cmd} ${args[0]}`);
    };
    const ctx = { imageBuilt: false };
    const r = await convertDeck(DECK, slidesDir, {
      exec, root, dataDir: hostDataDir, scratch: SCRATCH, ctx,
    });
    assert.equal(r.ok, true);
    assert.equal(r.via, 'container');
    assert.equal(runs, 2);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('neither available, no brew: Homebrew guidance, no compose calls, no prompt', async () => {
  const { root, dataDir, slidesDir } = await makeProjectLayout();
  try {
    const exec = stubExec({ '*': { ok: false, code: 'ENOENT', message: 'spawn ENOENT' } });
    const r = await convertDeck(DECK, slidesDir, { exec, root, dataDir, scratch: SCRATCH });
    assert.equal(r.ok, false);
    assert.match(r.error, /Homebrew is not installed/);
    assert.match(r.error, /brew install --cask libreoffice/);
    assert.equal(exec.calls.filter((c) => c.cmd === 'docker' && c.args.includes('build')).length, 0);
    assert.equal(exec.calls.filter((c) => c.cmd === 'docker' && c.args.includes('run')).length, 0);
    // The `brew --version` detection call runs; no `brew install` does.
    assert.equal(exec.calls.filter((c) => c.cmd === 'brew' && c.args[0] === 'install').length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('custom DATA_DIR: container skipped, tier-3 prompt asked once, decline fails clearly', async () => {
  const { root, dataDir, slidesDir } = await makeProjectLayout('custom-data');
  try {
    const exec = stubExec({
      'soffice --version': { ok: false, code: 'ENOENT', message: 'spawn soffice ENOENT' },
      'docker compose': { ok: true },
      'brew --version': { ok: true },
    });
    let asks = 0;
    const ask = async () => { asks += 1; return false; };
    const ctx = { imageBuilt: false, installAsked: false, installDeclined: false, installAttempted: false };
    const r = await convertDeck(DECK, slidesDir, {
      exec, root, dataDir, scratch: SCRATCH, ask, ctx,
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /install declined/);
    assert.match(r.error, /brew install --cask libreoffice/);
    assert.equal(asks, 1);
    assert.equal(exec.calls.filter((c) => c.cmd === 'docker' && c.args.includes('build')).length, 0);
    assert.equal(exec.calls.filter((c) => c.cmd === 'brew' && c.args.includes('install')).length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('isYesAnswer: y/yes only', () => {
  for (const yes of ['y', 'Y', 'yes', 'YES', 'Yes', ' y ', '\tyes\n']) assert.equal(isYesAnswer(yes), true, yes);
  for (const no of ['n', 'N', 'no', '', 'maybe', 'yeah', 'yep', null, undefined]) assert.equal(isYesAnswer(no), false, String(no));
});

test('default prompt: non-TTY stdin answers No immediately (never hangs)', async () => {
  // node --test runs with piped stdin: isTTY is undefined (not true).
  assert.ok(!process.stdin.isTTY);
  const t0 = Date.now();
  assert.equal(await askInstallLibreOffice(), false);
  assert.ok(Date.now() - t0 < 1000, 'answered without waiting');
});

// --- Tier 3 ---

// Stateful stub for the tier-3 flow: soffice appears only after a
// successful `brew install --cask libreoffice`.
function tier3Exec({ brewInstallOk = true, sofficeAfterInstall = true } = {}) {
  const calls = [];
  let installed = false;
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts });
    if (cmd === 'soffice' && args[0] === '--version') {
      if (installed && sofficeAfterInstall) return { stdout: 'LibreOffice 25.2', stderr: '' };
      throw Object.assign(new Error('spawn soffice ENOENT'), { code: 'ENOENT' });
    }
    if (cmd === 'docker') throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    if (cmd === 'brew' && args[0] === '--version') return { stdout: 'Homebrew 4.0', stderr: '' };
    if (cmd === 'brew' && args[0] === 'install') {
      if (!brewInstallOk) throw new Error('brew: download failed (network)');
      installed = true;
      return { stdout: 'installed', stderr: '' };
    }
    if (cmd === 'soffice' && args.includes('--headless')) {
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected call ${cmd} ${args[0]}`);
  };
  exec.calls = calls;
  exec.wasInstalled = () => installed;
  return exec;
}

test('tier 3 happy path: yes -> brew install -> soffice appears -> host conversion', async () => {
  const { root, dataDir, slidesDir } = await makeProjectLayout();
  try {
    const exec = tier3Exec();
    const writingExec = async (cmd, args, opts) => {
      const out = await exec(cmd, args, opts);
      if (cmd === 'soffice' && args.includes('--headless')) {
        await fsp.writeFile(path.join(slidesDir, 'UDLChap2.pdf'), MINIMAL_PDF);
      }
      return out;
    };
    writingExec.calls = exec.calls;
    let asks = 0;
    const ask = async () => { asks += 1; return true; };
    const ctx = { imageBuilt: false, installAsked: false, installDeclined: false, installAttempted: false };
    const r = await convertDeck(DECK, slidesDir, {
      exec: writingExec, root, dataDir, scratch: SCRATCH, ask, ctx,
    });
    assert.equal(r.ok, true);
    assert.equal(r.via, 'host');
    assert.equal(r.bytes, MINIMAL_PDF.length);
    assert.equal(asks, 1);
    const installs = exec.calls.filter((c) => c.cmd === 'brew' && c.args[0] === 'install');
    assert.equal(installs.length, 1);
    assert.deepEqual(installs[0].args, ['install', '--cask', 'libreoffice']);
    assert.equal(installs[0].opts.timeout, BREW_INSTALL_TIMEOUT_MS);
    assert.equal(ctx.installAttempted, true);
    assert.equal(exec.wasInstalled(), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('tier 3: ask no -> no brew install, manual guidance', async () => {
  const { root, dataDir, slidesDir } = await makeProjectLayout();
  try {
    const exec = tier3Exec();
    let asks = 0;
    const ask = async () => { asks += 1; return false; };
    const r = await convertDeck(DECK, slidesDir, { exec, root, dataDir, scratch: SCRATCH, ask });
    assert.equal(r.ok, false);
    assert.match(r.error, /install declined/);
    assert.match(r.error, /brew install --cask libreoffice/);
    assert.equal(asks, 1);
    assert.equal(exec.calls.filter((c) => c.cmd === 'brew' && c.args[0] === 'install').length, 0);
    assert.equal(exec.wasInstalled(), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('tier 3: prompt asked once per run across decks', async () => {
  const { root, dataDir, slidesDir } = await makeProjectLayout();
  try {
    const exec = tier3Exec();
    let asks = 0;
    const ask = async () => { asks += 1; return false; };
    const ctx = { imageBuilt: false, installAsked: false, installDeclined: false, installAttempted: false };
    const opts = { exec, root, dataDir, scratch: SCRATCH, ask, ctx };
    const r1 = await convertDeck(DECK, slidesDir, opts);
    assert.equal(r1.ok, false);
    const deck2 = { id: 'slides-chap3', title: 'Shallow', file: 'UDLChap3.pptx' };
    await fsp.writeFile(path.join(slidesDir, 'UDLChap3.pptx'), Buffer.from('PK\x03\x04fake-pptx'));
    const r2 = await convertDeck(deck2, slidesDir, opts);
    assert.equal(r2.ok, false);
    assert.match(r2.error, /brew install --cask libreoffice/);
    assert.equal(asks, 1);
    assert.equal(exec.calls.filter((c) => c.cmd === 'brew' && c.args[0] === 'install').length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('tier 3: brew missing -> no prompt, Homebrew guidance', async () => {
  const { root, dataDir, slidesDir } = await makeProjectLayout();
  try {
    const exec = stubExec({ '*': { ok: false, code: 'ENOENT', message: 'spawn ENOENT' } });
    let asks = 0;
    const ask = async () => { asks += 1; return true; };
    const r = await convertDeck(DECK, slidesDir, { exec, root, dataDir, scratch: SCRATCH, ask });
    assert.equal(r.ok, false);
    assert.match(r.error, /Homebrew is not installed/);
    assert.equal(asks, 0);
    assert.equal(exec.calls.filter((c) => c.cmd === 'brew' && c.args[0] === 'install').length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('tier 3: brew install fails -> plain failure + manual guidance, once', async () => {
  const { root, dataDir, slidesDir } = await makeProjectLayout();
  try {
    const exec = tier3Exec({ brewInstallOk: false });
    const ask = async () => true;
    const ctx = { imageBuilt: false, installAsked: false, installDeclined: false, installAttempted: false };
    const r = await convertDeck(DECK, slidesDir, { exec, root, dataDir, scratch: SCRATCH, ask, ctx });
    assert.equal(r.ok, false);
    assert.match(r.error, /Homebrew install failed/);
    assert.match(r.error, /brew install --cask libreoffice/);
    assert.equal(exec.calls.filter((c) => c.cmd === 'brew' && c.args[0] === 'install').length, 1);
    // Second deck: no second install attempt.
    const deck2 = { id: 'slides-chap3', title: 'Shallow', file: 'UDLChap3.pptx' };
    await fsp.writeFile(path.join(slidesDir, 'UDLChap3.pptx'), Buffer.from('PK\x03\x04fake-pptx'));
    const r2 = await convertDeck(deck2, slidesDir, { exec, root, dataDir, scratch: SCRATCH, ask, ctx });
    assert.equal(r2.ok, false);
    assert.equal(exec.calls.filter((c) => c.cmd === 'brew' && c.args[0] === 'install').length, 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('tier 3: install succeeds but soffice still missing -> clear failure', async () => {
  const { root, dataDir, slidesDir } = await makeProjectLayout();
  try {
    const exec = tier3Exec({ sofficeAfterInstall: false });
    const ask = async () => true;
    const r = await convertDeck(DECK, slidesDir, { exec, root, dataDir, scratch: SCRATCH, ask });
    assert.equal(r.ok, false);
    assert.match(r.error, /still not on PATH/);
    assert.equal(exec.calls.filter((c) => c.cmd === 'brew' && c.args[0] === 'install').length, 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('tier 3: --install-libreoffice pre-answers yes (no prompt)', async () => {
  const { root, dataDir, slidesDir } = await makeProjectLayout();
  try {
    const exec = tier3Exec();
    const writingExec = async (cmd, args, opts) => {
      const out = await exec(cmd, args, opts);
      if (cmd === 'soffice' && args.includes('--headless')) {
        await fsp.writeFile(path.join(slidesDir, 'UDLChap2.pdf'), MINIMAL_PDF);
      }
      return out;
    };
    writingExec.calls = exec.calls;
    let asks = 0;
    const ask = async () => { asks += 1; return false; };
    const r = await convertDeck(DECK, slidesDir, {
      exec: writingExec, root, dataDir, scratch: SCRATCH, ask, autoInstall: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.via, 'host');
    assert.equal(asks, 0);
    assert.equal(exec.calls.filter((c) => c.cmd === 'brew' && c.args[0] === 'install').length, 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('hasBrew: brew --version exit 0 vs ENOENT', async () => {
  assert.equal(await hasBrew(stubExec({ '*': { ok: true } })), true);
  assert.equal(await hasBrew(stubExec({ '*': { ok: false, code: 'ENOENT' } })), false);
});
