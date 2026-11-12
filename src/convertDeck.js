// Deck conversion: PPTX -> PDF with LibreOffice, in three tiers.
//
//   Tier 1 — host `soffice` when it is on PATH (fast path).
//   Tier 2 — one-off container from the app's own image when Docker is
//     available (the Dockerfile already ships `libreoffice-impress`, so
//     no host install is needed). The container sees the host data dir
//     through the compose mount (`./data` -> `/app/data`,
//     docker-compose.yml), so the converted PDF lands in the same host
//     slides dir the seed wrote the PPTX to.
//   Tier 3 — when neither is available, ASK the user whether seed may
//     install LibreOffice itself via Homebrew, then retry with the fresh
//     host install. Never silent, never automatic: a non-TTY stdin
//     answers No without reading, and `--install-libreoffice` pre-answers
//     yes for non-interactive runs.
//
// The compose invocation deliberately uses ONLY the base
// `docker-compose.yml` (`-f`, no override): a user's iCloud override
// replaces the `./data` mount, which would point the container at a
// different tree than the one seed is writing. Seed's contract is to
// populate the data dir it is given; the container must see exactly that
// dir. (If the data dir is not the repo's default `./data`, tier 2 cannot
// map it and the deck falls through to tier 3.)
//
// Seed never installs Homebrew itself, and never installs anything
// without the user's yes (or the explicit flag).
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CONTAINER_DATA_DIR = '/app/data';
export const CONVERT_TIMEOUT_MS = 300_000;
export const BUILD_TIMEOUT_MS = 900_000;
export const BREW_INSTALL_TIMEOUT_MS = 1_800_000;
const DETECT_TIMEOUT_MS = 10_000;
const COMPOSE_SERVICE = 'note-mate';
const PDF_MAGIC = Buffer.from('%PDF-');

export const INSTALL_PROMPT =
  'LibreOffice is not installed. Install it now via Homebrew (~500MB+, a few minutes)? [y/N] ';

/** 'y' / 'yes' (any case, surrounding whitespace ok) counts as yes. */
export function isYesAnswer(answer) {
  return /^\s*y(es)?\s*$/i.test(String(answer ?? ''));
}

/**
 * Default tier-3 prompt. A non-TTY stdin (piped / non-interactive run)
 * answers No immediately without reading — it never hangs waiting for
 * input that will never come. EOF on a TTY also answers No.
 */
export async function askInstallLibreOffice() {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => {
      rl.question(INSTALL_PROMPT, (ans) => resolve(ans));
      rl.on('close', () => resolve(''));
    });
    return isYesAnswer(answer);
  } finally {
    rl.close();
  }
}

/** Map a host path under the host data dir to its container path. Null when outside. */
export function toContainerPath(hostDataDir, hostPath) {
  const rel = path.relative(path.resolve(hostDataDir), path.resolve(hostPath));
  if (rel === '' || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) return null;
  return path.posix.join(CONTAINER_DATA_DIR, ...rel.split(path.sep));
}

/** soffice argv for a host conversion. profileDir adds the explicit UserInstallation retry form. */
export function hostConvertArgv({ slidesDir, pptx, profileDir = null }) {
  const args = [];
  if (profileDir) args.push(`--env:UserInstallation=file://${profileDir}`);
  args.push('--headless', '--convert-to', 'pdf', '--outdir', slidesDir, pptx);
  return args;
}

/** soffice argv for an in-container conversion (container paths, /tmp profile). */
export function containerConvertArgv({ containerSlidesDir, containerPptx, profileDir = null }) {
  const args = [];
  if (profileDir) args.push(`--env:UserInstallation=file://${profileDir}`);
  args.push('--headless', '--convert-to', 'pdf', '--outdir', containerSlidesDir, containerPptx);
  return args;
}

/** `docker compose -f <root>/docker-compose.yml build note-mate` */
export function composeBuildArgv({ root }) {
  return ['compose', '-f', path.join(root, 'docker-compose.yml'), 'build', COMPOSE_SERVICE];
}

/** `docker compose -f <root>/docker-compose.yml run --rm note-mate soffice ...` */
export function composeRunArgv({ root, sofficeArgs }) {
  return ['compose', '-f', path.join(root, 'docker-compose.yml'), 'run', '--rm', COMPOSE_SERVICE, 'soffice', ...sofficeArgs];
}

async function commandOk(exec, cmd, args) {
  try {
    await exec(cmd, args, { timeout: DETECT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** True when `soffice` runs on PATH (checked by spawning it, not by `which`). */
export function hasHostSoffice(exec) {
  return commandOk(exec, 'soffice', ['--version']);
}

/** True when the Docker Compose v2 plugin answers. */
export function hasDockerCompose(exec) {
  return commandOk(exec, 'docker', ['compose', 'version']);
}

/** True when Homebrew is on PATH. */
export function hasBrew(exec) {
  return commandOk(exec, 'brew', ['--version']);
}

async function fileExistsOk(file, magic) {
  try {
    const st = await fsp.stat(file);
    if (st.size === 0) return false;
    if (magic) {
      const head = Buffer.alloc(magic.length);
      const fd = await fsp.open(file, 'r');
      try { await fd.read(head, 0, magic.length, 0); } finally { await fd.close(); }
      return head.equals(magic);
    }
    return true;
  } catch {
    return false;
  }
}

// Run cmd once; on failure retry once with the retry args (explicit
// UserInstallation profile — the first attempt can fail on a stale
// lock/profile). Throws when the retry fails too.
async function runWithProfileRetry(exec, cmd, firstArgs, retryArgs, execOpts, log, deck) {
  try {
    await exec(cmd, firstArgs, execOpts);
  } catch (err) {
    log(`  ${deck.file}: conversion retry with scratch profile (${String(err.message).slice(0, 120)})`);
    await exec(cmd, retryArgs, execOpts);
  }
}

// Tier 1 (and the tier-3 retry): convert with host soffice. Throws on failure.
async function convertViaHost(exec, deck, slidesDir, pdfPath, pdfName, scratch, log) {
  const pptx = path.join(slidesDir, deck.file);
  const loProfile = path.join(scratch, 'lo-profile');
  await fsp.mkdir(loProfile, { recursive: true });
  const execOpts = { env: { ...process.env, TMPDIR: scratch }, timeout: CONVERT_TIMEOUT_MS };
  await runWithProfileRetry(
    exec, 'soffice',
    hostConvertArgv({ slidesDir, pptx }),
    hostConvertArgv({ slidesDir, pptx, profileDir: loProfile }),
    execOpts, log, deck,
  );
  const { size } = await fsp.stat(pdfPath);
  if (size === 0) throw new Error('converted PDF is empty');
  log(`  converted ${pdfName} (${size} bytes)`);
  return { ok: true, bytes: size, via: 'host' };
}

const MANUAL_INSTALL =
  'Install LibreOffice with `brew install --cask libreoffice` and re-run seed.';

// Tier 3: offer a Homebrew install of LibreOffice, then retry with the
// fresh host install. Asks at most once per seed run (ctx); a declined
// prompt or a failed install is not re-asked for later decks.
async function installAndConvert(exec, deck, slidesDir, pdfPath, pdfName, scratch, log, ctx, opts) {
  const { autoInstall = false, ask = askInstallLibreOffice } = opts;
  if (ctx.installDeclined || ctx.installAttempted) {
    const error = `No LibreOffice (soffice) on PATH and no container conversion available. ${MANUAL_INSTALL}`;
    log(`  FAILED conversion ${deck.file}: ${error}`);
    return { ok: false, error };
  }
  if (!(await hasBrew(exec))) {
    ctx.installDeclined = true; // nothing to ask — brew itself is missing
    const error = `Homebrew is not installed, so seed cannot install LibreOffice itself. Install Homebrew from https://brew.sh first, then run \`brew install --cask libreoffice\` and re-run seed.`;
    log(`  FAILED conversion ${deck.file}: ${error}`);
    return { ok: false, error };
  }
  let approved = autoInstall;
  if (!approved) {
    approved = await ask();
    ctx.installAsked = true;
  }
  if (!approved) {
    ctx.installDeclined = true;
    const error = `LibreOffice install declined. ${MANUAL_INSTALL}`;
    log(`  FAILED conversion ${deck.file}: ${error}`);
    return { ok: false, error };
  }
  ctx.installAttempted = true;
  log('  installing LibreOffice via Homebrew (downloads ~500MB, takes a few minutes) ...');
  try {
    await exec('brew', ['install', '--cask', 'libreoffice'], { timeout: BREW_INSTALL_TIMEOUT_MS });
  } catch (err) {
    const error = `Homebrew install failed (${err.message}). ${MANUAL_INSTALL}`;
    log(`  FAILED conversion ${deck.file}: ${error}`);
    return { ok: false, error };
  }
  if (!(await hasHostSoffice(exec))) {
    const error = `Homebrew install finished but \`soffice\` is still not on PATH. Check the install, then run \`brew install --cask libreoffice\` manually and re-run seed.`;
    log(`  FAILED conversion ${deck.file}: ${error}`);
    return { ok: false, error };
  }
  try {
    return await convertViaHost(exec, deck, slidesDir, pdfPath, pdfName, scratch, log);
  } catch (err) {
    log(`  FAILED conversion ${deck.file}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Convert one PPTX deck to PDF. Returns {ok, bytes} (plus `skipped` when
 * the PDF already exists, `via: 'host' | 'container'` on success).
 * Never throws for a conversion failure — the error is returned, so one
 * bad deck does not abort the seed.
 *
 * opts: { exec, root, dataDir, scratch, force, autoInstall, ask, log, ctx }
 * — ctx is a per-process object the caller creates once:
 *   { imageBuilt: false, installAsked: false, installDeclined: false,
 *     installAttempted: false }
 *   The container image is built at most once per seed run, and the
 *   install prompt is asked at most once. `autoInstall` (seed flag
 *   `--install-libreoffice`) pre-answers the prompt yes.
 */
export async function convertDeck(deck, slidesDir, opts = {}) {
  const {
    exec = execFileAsync,
    root = process.cwd(),
    dataDir = path.join(root, 'data'),
    scratch = path.join(process.env.HOME || '~', 'workspace', 'nm-seed-tmp'),
    force = false,
    log = console.log,
    ctx = { imageBuilt: false, installAsked: false, installDeclined: false, installAttempted: false },
  } = opts;
  const pptx = path.join(slidesDir, deck.file);
  const pdfName = deck.file.replace(/\.pptx$/i, '.pdf');
  const pdfPath = path.join(slidesDir, pdfName);
  if (!force && await fileExistsOk(pdfPath, PDF_MAGIC)) {
    const { size } = await fsp.stat(pdfPath);
    log(`  ${pdfName} already present (${size} bytes) — skipping conversion`);
    return { ok: true, bytes: size, skipped: true };
  }
  const hostDataDir = path.resolve(dataDir);

  // --- Tier 1: host LibreOffice ---
  if (await hasHostSoffice(exec)) {
    try {
      return await convertViaHost(exec, deck, slidesDir, pdfPath, pdfName, scratch, log);
    } catch (err) {
      log(`  FAILED conversion ${deck.file}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  // --- Tier 2: one-off container from the app's own image ---
  const defaultDataDir = path.resolve(root, 'data');
  const containerSlidesDir = toContainerPath(hostDataDir, slidesDir);
  const containerUsable = !!containerSlidesDir && hostDataDir === defaultDataDir
    && (await hasDockerCompose(exec));
  if (containerUsable) {
    log(`  ${deck.file}: no host LibreOffice — converting in container`);
    try {
      if (!ctx.imageBuilt) {
        log('  building the app image for conversion (first run only, takes a few minutes) ...');
        await exec('docker', composeBuildArgv({ root }), { timeout: BUILD_TIMEOUT_MS });
        ctx.imageBuilt = true;
      }
      const containerPptx = toContainerPath(hostDataDir, pptx);
      await runWithProfileRetry(
        exec, 'docker',
        composeRunArgv({ root, sofficeArgs: containerConvertArgv({ containerSlidesDir, containerPptx }) }),
        composeRunArgv({ root, sofficeArgs: containerConvertArgv({ containerSlidesDir, containerPptx, profileDir: '/tmp/lo-profile' }) }),
        { timeout: CONVERT_TIMEOUT_MS },
        log, deck,
      );
      const { size } = await fsp.stat(pdfPath);
      if (size === 0) throw new Error('converted PDF is empty');
      log(`  converted ${pdfName} (${size} bytes) [container]`);
      return { ok: true, bytes: size, via: 'container' };
    } catch (err) {
      log(`  FAILED conversion ${deck.file}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  // --- Tier 3: offer a Homebrew install, then retry ---
  return installAndConvert(exec, deck, slidesDir, pdfPath, pdfName, scratch, log, ctx, opts);
}
