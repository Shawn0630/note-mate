// Document conversion: any LibreOffice-readable document (Word .docx/.doc,
// PowerPoint .pptx/.ppt) -> PDF, cached beside the source.
//
// One conversion per (input, output): the cached PDF is reused while it is
// newer than the input, so a second read costs nothing. Runtime use only —
// the server cannot prompt, so when soffice is missing the call fails with
// a clear error instead of asking (seed's Homebrew-install prompt is a
// seed-only path; see src/convertDeck.js).
//
// The Docker image already ships libreoffice-impress, so on the user's Mac
// (server in the container) soffice is on PATH and this just works.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CONVERT_TIMEOUT_MS = 300_000;
export const CONVERTIBLE_DOC_EXTS = ['.docx', '.doc', '.pptx', '.ppt'];

export function isConvertibleDoc(filePath) {
  return CONVERTIBLE_DOC_EXTS.includes(path.extname(String(filePath || '')).toLowerCase());
}

/** The cached PDF path for a document: same dir, same base name, .pdf. */
export function convertedPdfPath(inputPath) {
  return String(inputPath).replace(/\.[^.]+$/, '.pdf');
}

/** soffice argv: convert one file to PDF in outDir. */
export function sofficeConvertArgv({ outDir, input, profileDir = null }) {
  const args = [];
  if (profileDir) args.push(`--env:UserInstallation=file://${profileDir}`);
  args.push('--headless', '--convert-to', 'pdf', '--outdir', outDir, input);
  return args;
}

async function commandOk(exec, cmd, args) {
  try {
    await exec(cmd, args, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** True when `soffice` runs on PATH (checked by spawning it, not by `which`). */
export function hasSoffice(exec) {
  return commandOk(exec, 'soffice', ['--version']);
}

async function fileIsPdf(file) {
  try {
    const st = await fsp.stat(file);
    if (st.size === 0) return false;
    const head = Buffer.alloc(5);
    const fd = await fsp.open(file, 'r');
    try { await fd.read(head, 0, 5, 0); } finally { await fd.close(); }
    return head.equals(Buffer.from('%PDF-'));
  } catch {
    return false;
  }
}

// Run soffice once; on failure retry once with a scratch UserInstallation
// profile — the first attempt can fail on a stale lock/profile (same
// pattern as src/convertDeck.js). Throws when the retry fails too.
async function runWithProfileRetry(exec, input, outDir, scratch, log) {
  const profileDir = path.join(scratch, 'lo-profile');
  await fsp.mkdir(profileDir, { recursive: true });
  const execOpts = { env: { ...process.env, TMPDIR: scratch }, timeout: CONVERT_TIMEOUT_MS };
  try {
    await exec('soffice', sofficeConvertArgv({ outDir, input }), execOpts);
  } catch (err) {
    log(`  conversion retry with scratch profile (${String(err.message).slice(0, 120)})`);
    await exec('soffice', sofficeConvertArgv({ outDir, input, profileDir }), execOpts);
  }
}

/**
 * Ensure a PDF exists for a document. Returns
 *   { ok: true, path, bytes, cached, via: 'soffice' }
 * or { ok: false, error }. Never throws for a missing soffice or a failed
 * conversion — the error is returned so the route can answer 422.
 *
 * opts: { exec, scratch, log } — scratch holds the LibreOffice profile
 * retry dir (defaults to os.tmpdir()/nm-convert).
 */
export async function ensurePdf(inputPath, opts = {}) {
  const {
    exec = execFileAsync,
    scratch = path.join(os.tmpdir(), 'nm-convert'),
    log = () => {},
  } = opts;
  const input = path.resolve(inputPath);
  const output = convertedPdfPath(input);
  let inputStat;
  try {
    inputStat = await fsp.stat(input);
  } catch {
    // A missing document is a not-found, not a conversion failure — the
    // route answers 404 for it.
    return { ok: false, error: `document not found: ${inputPath}`, code: 'ENOENT' };
  }
  // Cache: a PDF newer than its document is reused, never re-converted.
  if (await fileIsPdf(output)) {
    const outStat = await fsp.stat(output);
    if (outStat.mtimeMs >= inputStat.mtimeMs) {
      return { ok: true, path: output, bytes: outStat.size, cached: true, via: 'soffice' };
    }
  }
  if (!(await hasSoffice(exec))) {
    return {
      ok: false,
      error: 'LibreOffice (soffice) is not available, so this document cannot be converted to PDF. '
        + 'Install it with `brew install --cask libreoffice` and try again.',
    };
  }
  try {
    await fsp.mkdir(scratch, { recursive: true });
    await runWithProfileRetry(exec, input, path.dirname(output), scratch, log);
    if (!(await fileIsPdf(output))) throw new Error('converted PDF is empty or missing');
    const { size } = await fsp.stat(output);
    return { ok: true, path: output, bytes: size, cached: false, via: 'soffice' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
