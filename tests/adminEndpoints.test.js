import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDataArchive } from '../src/dataExport.js';
import { readZip } from '../src/zipStore.js';

process.env.NODE_ENV = 'test';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nm-admin-'));
process.env.DATA_DIR = tmp;
process.env.LLM_ENV_FILE = path.join(tmp, 'no-such.env');

const { default: app } = await import('../src/server.js');

let server;
let base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
});

async function req(p, opts = {}) {
  const res = await fetch(`${base}${p}`, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { res, json, text };
}

function withLlmEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

test('admin: ai-calls starts empty; a stubbed Note AI call appears with time/feature/model', async () => {
  let r = await req('/api/admin/ai-calls');
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json, { total: 0, calls: [] });

  // One project, then one stubbed Note AI call against it.
  r = await req('/api/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Admin Book', url: 'https://example.com/book.pdf' }),
  });
  assert.equal(r.res.status, 201);
  assert.equal(r.json.slug, 'admin-book');

  await withLlmEnv({ LLM_STUB_RESPONSE: '# Stub note\n\nA short paragraph.\n', LLM_MODEL: 'stub-model' }, async () => {
    r = await req('/api/projects/admin-book/ai-note', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Summarize this chapter' }),
    });
    assert.equal(r.res.status, 200);
    assert.match(r.json.markdown, /Stub note/);
  });

  r = await req('/api/admin/ai-calls');
  assert.equal(r.json.total, 1);
  const call = r.json.calls[0];
  assert.equal(call.feature, 'ai-note');
  assert.equal(call.status, 'ok');
  assert.equal(call.model, 'stub-model');
  assert.equal(call.instruction, 'Summarize this chapter');
  assert.ok(call.ts);
  assert.match(call.prompt, /Summarize this chapter/);
  assert.equal(call.rawResponse, '# Stub note\n\nA short paragraph.\n');

  // Paging: offset past the end -> empty page, total unchanged.
  r = await req('/api/admin/ai-calls?limit=10&offset=5');
  assert.deepEqual(r.json, { total: 1, calls: [] });
});

test('admin: export downloads a valid archive (no AI log inside); import collides and keeps the existing project', async () => {
  const exp = await fetch(`${base}/api/admin/data/export`);
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-type'), /application\/zip/);
  assert.match(exp.headers.get('content-disposition'), /note-mate-export-.*\.zip/);
  const buf = Buffer.from(await exp.arrayBuffer());
  const { manifest } = validateDataArchive(buf);
  assert.deepEqual(manifest.projects, ['admin-book']);
  const names = readZip(buf).map((e) => e.name);
  assert.ok(names.includes('projects/admin-book/project.json'));
  assert.ok(names.includes('projects/admin-book/notes/notes.md'));
  assert.ok(!names.some((n) => n.startsWith('admin/')), 'AI call log is not exported');

  // Re-import the same archive: the slug collides — kept, reported.
  const before = await fs.readFile(path.join(tmp, 'projects', 'admin-book', 'notes', 'notes.md'), 'utf8');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/zip' }), 'note-mate-export.zip');
  let r = await req('/api/admin/data/import', { method: 'POST', body: form });
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json.imported, []);
  assert.equal(r.json.skipped.length, 1);
  assert.equal(r.json.skipped[0].slug, 'admin-book');
  assert.equal(r.json.skipped[0].reason, 'already exists — kept, not overwritten');
  assert.equal(await fs.readFile(path.join(tmp, 'projects', 'admin-book', 'notes', 'notes.md'), 'utf8'), before);

  // A corrupt archive: 400, nothing written.
  const bad = new FormData();
  bad.append('file', new Blob([Buffer.from('not a zip')], { type: 'application/zip' }), 'bad.zip');
  r = await req('/api/admin/data/import', { method: 'POST', body: bad });
  assert.equal(r.res.status, 400);
  assert.deepEqual(await fs.readdir(path.join(tmp, 'projects')), ['admin-book']);
});

test('admin: sync log records entries; invalid entries are rejected', async () => {
  let r = await req('/api/admin/data/sync/log');
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.json.log, []);

  r = await req('/api/admin/data/sync/log', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ direction: 'upload', status: 'ok', bytes: 1234, detail: 'Uploaded to the sync folder.' }),
  });
  assert.equal(r.res.status, 200);
  assert.equal(r.json.direction, 'upload');
  assert.equal(r.json.status, 'ok');

  r = await req('/api/admin/data/sync/log');
  assert.equal(r.json.log.length, 1);
  assert.equal(r.json.log[0].detail, 'Uploaded to the sync folder.');

  r = await req('/api/admin/data/sync/log', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ direction: 'sideways', status: 'ok' }),
  });
  assert.equal(r.res.status, 400);
});

test('admin: import with a sync field records a download log entry', async () => {
  const exp = await fetch(`${base}/api/admin/data/export`);
  const buf = Buffer.from(await exp.arrayBuffer());
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/zip' }), 'note-mate-export.zip');
  form.append('sync', JSON.stringify({ direction: 'download', bytes: buf.length, exported_at: new Date().toISOString() }));
  const r = await req('/api/admin/data/import', { method: 'POST', body: form });
  assert.equal(r.res.status, 200);
  const log = await req('/api/admin/data/sync/log');
  const downloads = log.json.log.filter((e) => e.direction === 'download');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].status, 'ok');
});
