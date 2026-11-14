import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildDataExport, validateDataArchive, applyDataImport } from '../src/dataExport.js';
import { readZip } from '../src/zipStore.js';
import { appendAiCall } from '../src/aiCallLog.js';
import { recordSyncLog } from '../src/syncLog.js';

async function tmpDir(prefix = 'nm-dataexport-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// Two fixture projects: alpha has a note + a section notebook + an asset
// + annotations; beta is a name-only project (project.json + notes.md).
async function fixtureData(dir) {
  const alpha = path.join(dir, 'projects', 'alpha');
  await fs.mkdir(path.join(alpha, 'notes', 'assets'), { recursive: true });
  await fs.mkdir(path.join(alpha, 'notes', 'sections', 'labs'), { recursive: true });
  await fs.writeFile(path.join(alpha, 'project.json'), JSON.stringify({
    slug: 'alpha', title: 'Alpha', kind: 'pdf', sourceType: 'file', file: 'book.pdf',
    noteFiles: ['notes.md', 'scratch.md'],
    sections: [{ id: 'labs', name: 'Labs', notebooks: [{ name: 'lab-01.ipynb', chapter: 'Ch 1' }] }],
  }, null, 2));
  await fs.writeFile(path.join(alpha, 'book.pdf'), Buffer.from('%PDF-1.4 fake'));
  await fs.writeFile(path.join(alpha, 'notes', 'notes.md'), '# Alpha notes\n\nMy own words.\n');
  await fs.writeFile(path.join(alpha, 'notes', 'scratch.md'), '# Scratch\n');
  await fs.writeFile(path.join(alpha, 'notes', 'sections', 'labs', 'lab-01.ipynb'),
    JSON.stringify({ nbformat: 4, cells: [] }));
  await fs.writeFile(path.join(alpha, 'notes', 'assets', 'plot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(alpha, 'annotations.json'), JSON.stringify({ version: 1, annotations: [] }));
  const beta = path.join(dir, 'projects', 'beta');
  await fs.mkdir(path.join(beta, 'notes'), { recursive: true });
  await fs.writeFile(path.join(beta, 'project.json'), JSON.stringify({
    slug: 'beta', title: 'Beta', kind: 'video', sourceType: 'url', url: 'https://example.com/x',
    noteFiles: ['notes.md'], sections: [],
  }, null, 2));
  await fs.writeFile(path.join(beta, 'notes', 'notes.md'), '# Beta\n');
  // A stray dir without project.json is NOT a project.
  await fs.mkdir(path.join(dir, 'projects', 'stray'), { recursive: true });
  await fs.writeFile(path.join(dir, 'projects', 'stray', 'junk.txt'), 'junk');
  // Logs live under data/admin/ and must never be exported.
  appendAiCall({ ts: new Date().toISOString(), feature: 'ai-note', status: 'ok', model: 'm', instruction: 'hi', prompt: 'p', rawResponse: 'r', durationMs: 1 }, dir);
  recordSyncLog({ direction: 'upload', status: 'ok', bytes: 10 }, dir);
  return dir;
}

function manifestOf(buf) {
  const entries = readZip(buf);
  const m = entries.find((e) => e.name === 'note-mate-export.json');
  assert.ok(m, 'manifest present');
  return { entries, manifest: JSON.parse(m.data.toString('utf8')) };
}

test('export: whole data, manifest checksum verifies, no admin logs, stray dirs excluded', async () => {
  const dir = await tmpDir();
  await fixtureData(dir);
  const { buffer } = await buildDataExport(dir);
  const { entries, manifest } = manifestOf(buffer);
  assert.equal(manifest.format, 'note-mate-export');
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.projects, ['alpha', 'beta']);
  assert.ok(!entries.some((e) => e.name.startsWith('admin/')), 'no AI call log or sync log in the archive');
  assert.ok(!entries.some((e) => e.name.includes('stray')), 'stray dir excluded');
  for (const name of [
    'projects/alpha/project.json', 'projects/alpha/book.pdf', 'projects/alpha/notes/notes.md',
    'projects/alpha/notes/scratch.md', 'projects/alpha/notes/sections/labs/lab-01.ipynb',
    'projects/alpha/notes/assets/plot.png', 'projects/alpha/annotations.json',
    'projects/beta/project.json', 'projects/beta/notes/notes.md',
  ]) assert.ok(entries.some((e) => e.name === name), `${name} in archive`);
  // Manifest checksum: recompute over the manifest sans checksum.
  const { checksum, ...rest } = manifest;
  const expect = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  assert.equal(checksum, expect);
  for (const f of manifest.files) {
    const e = entries.find((x) => x.name === f.path);
    assert.ok(e, f.path);
    assert.equal(createHash('sha256').update(e.data).digest('hex'), f.sha256);
    assert.equal(e.data.length, f.size);
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('validate: tampered file fails; traversal names fail; nothing is written', async () => {
  const dir = await tmpDir();
  await fixtureData(dir);
  const { buffer } = await buildDataExport(dir);
  // Tamper one byte of a note inside the archive (stored entries: the
  // bytes sit in the local header region; flip a byte of notes.md).
  const tampered = Buffer.from(buffer);
  const idx = tampered.indexOf('My own words.');
  assert.ok(idx > 0);
  tampered[idx] = 'X'.charCodeAt(0);
  assert.throws(() => validateDataArchive(tampered), (e) => e.status === 400);
  // Traversal: rebuild the archive with a hostile entry name.
  const { createZip } = await import('../src/zipStore.js');
  const evil = createZip([
    { name: 'note-mate-export.json', data: Buffer.from(JSON.stringify({ format: 'note-mate-export', version: 1, exported_at: 'x', projects: ['alpha'], files: [], checksum: '0'.repeat(64) })) },
    { name: 'projects/alpha/project.json', data: Buffer.from('{}') },
    { name: '../escape.txt', data: Buffer.from('x') },
  ]).toBuffer();
  assert.throws(() => validateDataArchive(evil), (e) => e.status === 400);
  // Nothing was written to the data dir by validation.
  assert.deepEqual(await fs.readdir(path.join(dir, 'projects')), ['alpha', 'beta', 'stray']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('import: restores projects into a fresh dir; collision keeps existing and reports it', async () => {
  const src = await tmpDir();
  await fixtureData(src);
  const { buffer } = await buildDataExport(src);

  const fresh = await tmpDir('nm-dataimport-');
  const summary = await applyDataImport(fresh, buffer);
  assert.deepEqual(summary.imported, ['alpha', 'beta']);
  assert.deepEqual(summary.skipped, []);
  assert.equal(await fs.readFile(path.join(fresh, 'projects', 'alpha', 'notes', 'notes.md'), 'utf8'), '# Alpha notes\n\nMy own words.\n');
  const alphaJson = JSON.parse(await fs.readFile(path.join(fresh, 'projects', 'alpha', 'project.json'), 'utf8'));
  assert.equal(alphaJson.sections[0].notebooks[0].name, 'lab-01.ipynb');

  // Import again into the same dir: both slugs collide — existing kept.
  await fs.writeFile(path.join(fresh, 'projects', 'alpha', 'notes', 'notes.md'), '# Alpha notes\n\nCHANGED BY ME.\n');
  const second = await applyDataImport(fresh, buffer);
  assert.deepEqual(second.imported, []);
  assert.equal(second.skipped.length, 2);
  assert.ok(second.skipped.every((s) => s.reason === 'already exists — kept, not overwritten'));
  assert.equal(await fs.readFile(path.join(fresh, 'projects', 'alpha', 'notes', 'notes.md'), 'utf8'), '# Alpha notes\n\nCHANGED BY ME.\n');
  await fs.rm(src, { recursive: true, force: true });
  await fs.rm(fresh, { recursive: true, force: true });
});

test('import: a corrupt archive writes nothing', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'marker.txt'), 'keep me');
  await assert.rejects(() => applyDataImport(dir, Buffer.from('not a zip at all')), (e) => e.status === 400);
  assert.deepEqual(await fs.readdir(dir), ['marker.txt']);
  await fs.rm(dir, { recursive: true, force: true });
});
