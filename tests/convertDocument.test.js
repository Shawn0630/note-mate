// Unit tests for src/convertDocument.js — document -> PDF conversion:
// cached reuse, soffice argv, clear failure when soffice is missing or the
// conversion fails. Exec calls are stubbed except for the one live test,
// which converts a real .docx with the real soffice (skipped when soffice
// is not installed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  isConvertibleDoc, convertedPdfPath, sofficeConvertArgv, hasSoffice, ensurePdf,
} from '../src/convertDocument.js';

const execFileAsync = promisify(execFile);
const MINIMAL_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const log = () => {};

// A stub execFile: records calls; steps keyed by `${cmd} ${args[0]}`.
// { ok: true, writePdf: <dir> } simulates a conversion producing the PDF.
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
      await fsp.writeFile(path.join(step.writePdf, 'doc.pdf'), MINIMAL_PDF);
    }
    return { stdout: '', stderr: '' };
  };
  exec.calls = calls;
  return exec;
}

async function makeDocDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-convert-doc-'));
  await fsp.writeFile(path.join(dir, 'doc.docx'), Buffer.from('PK fake docx bytes'));
  return dir;
}

test('isConvertibleDoc / convertedPdfPath', () => {
  assert.equal(isConvertibleDoc('a.docx'), true);
  assert.equal(isConvertibleDoc('a.DOC'), true);
  assert.equal(isConvertibleDoc('a.pptx'), true);
  assert.equal(isConvertibleDoc('a.ppt'), true);
  assert.equal(isConvertibleDoc('a.pdf'), false);
  assert.equal(isConvertibleDoc('a.txt'), false);
  assert.equal(convertedPdfPath('/x/y/doc.docx'), '/x/y/doc.pdf');
  assert.equal(convertedPdfPath('/x/y/deck.pptx'), '/x/y/deck.pdf');
});

test('sofficeConvertArgv: headless convert-to pdf, outdir, optional profile', () => {
  assert.deepEqual(
    sofficeConvertArgv({ outDir: '/out', input: '/in/doc.docx' }),
    ['--headless', '--convert-to', 'pdf', '--outdir', '/out', '/in/doc.docx'],
  );
  assert.deepEqual(
    sofficeConvertArgv({ outDir: '/out', input: '/in/doc.docx', profileDir: '/p' }),
    ['--env:UserInstallation=file:///p', '--headless', '--convert-to', 'pdf', '--outdir', '/out', '/in/doc.docx'],
  );
});

test('ensurePdf: missing input is an error, not a throw', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-convert-doc-'));
  const r = await ensurePdf(path.join(dir, 'gone.docx'), { exec: stubExec(), log });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('ensurePdf: no soffice is a clear error (no prompt, no hang)', async () => {
  const dir = await makeDocDir();
  const exec = stubExec({ 'soffice --version': { ok: false, message: 'spawn soffice ENOENT' } });
  const r = await ensurePdf(path.join(dir, 'doc.docx'), { exec, scratch: path.join(dir, 'scratch'), log });
  assert.equal(r.ok, false);
  assert.match(r.error, /LibreOffice.*not available/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('ensurePdf: converts with host soffice, caches while newer than the input', async () => {
  const dir = await makeDocDir();
  const exec = stubExec({ '*': { ok: true, writePdf: dir } });
  const first = await ensurePdf(path.join(dir, 'doc.docx'), { exec, scratch: path.join(dir, 'scratch'), log });
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(first.bytes, MINIMAL_PDF.length);
  assert.equal(exec.calls.filter((c) => c.cmd === 'soffice' && c.args.includes('--convert-to')).length, 1);
  // Second call reuses the cache: no conversion runs at all.
  const second = await ensurePdf(path.join(dir, 'doc.docx'), { exec, scratch: path.join(dir, 'scratch'), log });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(exec.calls.filter((c) => c.cmd === 'soffice' && c.args.includes('--convert-to')).length, 1);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('ensurePdf: a failed conversion retries once with a scratch profile, then errors', async () => {
  const dir = await makeDocDir();
  const exec = stubExec({
    'soffice --version': { ok: true },
    '*': { ok: false, message: 'soffice crashed' },
  });
  const r = await ensurePdf(path.join(dir, 'doc.docx'), { exec, scratch: path.join(dir, 'scratch'), log });
  assert.equal(r.ok, false);
  assert.match(r.error, /soffice crashed/);
  const converts = exec.calls.filter((c) => c.cmd === 'soffice' && c.args.includes('--convert-to'));
  assert.equal(converts.length, 2);
  assert.ok(converts[1].args.some((a) => String(a).includes('UserInstallation')));
  await fsp.rm(dir, { recursive: true, force: true });
});

const hasRealSoffice = await (async () => {
  try { await execFileAsync('soffice', ['--version'], { timeout: 10_000 }); return true; }
  catch { return false; }
})();

test('ensurePdf (live): real soffice converts a real .docx to a real PDF', { skip: !hasRealSoffice }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-convert-live-'));
  try {
    // A real minimal .docx, built with python3's zipfile (soffice here
    // cannot EXPORT docx — no Writer export filter — but it imports and
    // converts docx -> pdf fine).
    const buildDocx = `
import zipfile
ct = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'''
rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'''
doc = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Live doc first page.</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/><w:t>Second page.</w:t></w:r></w:p></w:body></w:document>'''
with zipfile.ZipFile(${JSON.stringify(path.join(dir, 'doc.docx'))}, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', ct)
    z.writestr('_rels/.rels', rels)
    z.writestr('word/document.xml', doc)
`;
    await execFileAsync('python3', ['-c', buildDocx], { timeout: 30_000 });
    const docx = path.join(dir, 'doc.docx');
    const st = await fsp.stat(docx);
    assert.ok(st.size > 0);
    const r = await ensurePdf(docx, { scratch: path.join(dir, 'scratch'), log });
    assert.equal(r.ok, true);
    assert.equal(r.cached, false);
    const head = Buffer.alloc(5);
    const fd = await fsp.open(r.path, 'r');
    try { await fd.read(head, 0, 5, 0); } finally { await fd.close(); }
    assert.equal(head.toString(), '%PDF-');
    // Second call: cached.
    const again = await ensurePdf(docx, { scratch: path.join(dir, 'scratch'), log });
    assert.equal(again.cached, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
