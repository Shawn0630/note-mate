import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
const tmpData = await fsp.mkdtemp(path.join(os.tmpdir(), 'nm-labs-backfill-'));
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

async function reqJson(method, p, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

// Write a project straight to disk (a pre-sections project has no
// `sections` key in project.json). `labs` is [{chapter, name}]; the
// notebook files are minimal — the backfill only lists filenames.
async function writeProjectOnDisk(slug, { sections, labs = [], notesMd = '# Test\n\nSome body text.\n' } = {}) {
  const dir = path.join(tmpData, 'projects', slug);
  await fsp.mkdir(path.join(dir, 'notes'), { recursive: true });
  const project = {
    slug, title: `Project ${slug}`, kind: 'pdf', sourceType: 'none',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...(sections === undefined ? {} : { sections }),
  };
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(project, null, 2) + '\n', 'utf8');
  await fsp.writeFile(path.join(dir, 'notes', 'notes.md'), notesMd, 'utf8');
  for (const { chapter, name } of labs) {
    await fsp.mkdir(path.join(dir, 'notes', 'labs', chapter), { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'notes', 'labs', chapter, name),
      JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
      'utf8',
    );
  }
  return dir;
}

async function readProjectJson(slug) {
  return JSON.parse(await fsp.readFile(path.join(tmpData, 'projects', slug, 'project.json'), 'utf8'));
}

const LABS3 = [
  { chapter: 'Chap01', name: '1_1_A.ipynb' },
  { chapter: 'Chap01', name: '1_2_B.ipynb' },
  { chapter: 'Chap02', name: '2_1_X.ipynb' },
];

test('backfill: pre-sections project gains the Labs section on first GET, persisted', async () => {
  const slug = 'pre-sections';
  const dir = await writeProjectOnDisk(slug, { labs: LABS3 });
  const notesBefore = await fsp.readFile(path.join(dir, 'notes', 'notes.md'), 'utf8');
  const r = await reqJson('GET', `/api/projects/${slug}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.slug, slug);
  const labs = (r.json.sections ?? []).find((s) => s.id === 'labs');
  assert.ok(labs, 'Labs section present in the response');
  assert.equal(labs.name, 'Labs');
  assert.deepEqual(labs.notebooks.map((n) => n.name), ['1_1_A.ipynb', '1_2_B.ipynb', '2_1_X.ipynb']);
  assert.ok(labs.notebooks.every((n) => n.chapter && n.path.startsWith('notes/labs/') && n.language === 'python'));
  // Persisted to project.json; notes.md and the other fields untouched.
  const stored = await readProjectJson(slug);
  assert.equal(stored.title, `Project ${slug}`);
  assert.equal(stored.kind, 'pdf');
  assert.deepEqual(stored.sections, r.json.sections);
  assert.equal(await fsp.readFile(path.join(dir, 'notes', 'notes.md'), 'utf8'), notesBefore);
  assert.deepEqual(r.json.noteFiles, ['notes.md']);
});

test('backfill: second GET is a no-op (project.json content and mtime stable)', async () => {
  const slug = 'pre-sections';
  const file = path.join(tmpData, 'projects', slug, 'project.json');
  const before = await fsp.readFile(file, 'utf8');
  const mtimeBefore = (await fsp.stat(file)).mtimeMs;
  const r = await reqJson('GET', `/api/projects/${slug}`);
  assert.equal(r.status, 200);
  assert.equal(await fsp.readFile(file, 'utf8'), before);
  assert.equal((await fsp.stat(file)).mtimeMs, mtimeBefore);
});

test('backfill: partial Labs is topped up; user section and user-added Labs entries survive', async () => {
  const slug = 'partial-labs';
  await writeProjectOnDisk(slug, {
    labs: LABS3,
    sections: [
      {
        id: 'my-stuff', name: 'My Stuff',
        notebooks: [{ name: 'scratch.ipynb', path: 'notes/sections/my-stuff/scratch.ipynb', language: 'python' }],
      },
      {
        id: 'labs', name: 'Labs',
        notebooks: [
          { name: '1_1_A.ipynb', path: 'notes/labs/Chap01/1_1_A.ipynb', chapter: 'Chap01', language: 'python' },
          { name: 'custom.ipynb', path: 'notes/sections/labs/custom.ipynb', language: 'java' },
        ],
      },
    ],
  });
  const r = await reqJson('GET', `/api/projects/${slug}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.sections.length, 2);
  const mine = r.json.sections.find((s) => s.id === 'my-stuff');
  assert.deepEqual(mine.notebooks.map((n) => n.name), ['scratch.ipynb']); // user section untouched
  const labs = r.json.sections.find((s) => s.id === 'labs');
  // Stored entries first (in stored order), missing disk labs appended.
  assert.deepEqual(labs.notebooks.map((n) => n.name),
    ['1_1_A.ipynb', 'custom.ipynb', '1_2_B.ipynb', '2_1_X.ipynb']);
  const stored = await readProjectJson(slug);
  assert.deepEqual(stored.sections, r.json.sections);
  // And a second read is a no-op.
  const file = path.join(tmpData, 'projects', slug, 'project.json');
  const before = await fsp.readFile(file, 'utf8');
  const mtimeBefore = (await fsp.stat(file)).mtimeMs;
  await reqJson('GET', `/api/projects/${slug}`);
  assert.equal(await fsp.readFile(file, 'utf8'), before);
  assert.equal((await fsp.stat(file)).mtimeMs, mtimeBefore);
});

test('backfill: project with no labs on disk stays section-less', async () => {
  const slug = 'no-labs';
  await writeProjectOnDisk(slug, { labs: [] });
  const r = await reqJson('GET', `/api/projects/${slug}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.sections, undefined);
  const stored = await readProjectJson(slug);
  assert.equal('sections' in stored, false);
});

test('backfill: project with a complete Labs section is untouched', async () => {
  const slug = 'complete-labs';
  await writeProjectOnDisk(slug, {
    labs: LABS3,
    sections: [{
      id: 'labs', name: 'Labs',
      notebooks: LABS3.map(({ chapter, name }) => ({
        name, path: `notes/labs/${chapter}/${name}`, chapter, language: 'python',
      })),
    }],
  });
  const file = path.join(tmpData, 'projects', slug, 'project.json');
  const before = await fsp.readFile(file, 'utf8');
  const mtimeBefore = (await fsp.stat(file)).mtimeMs;
  const r = await reqJson('GET', `/api/projects/${slug}`);
  assert.equal(r.status, 200);
  assert.equal((r.json.sections ?? []).length, 1);
  assert.equal(await fsp.readFile(file, 'utf8'), before);
  assert.equal((await fsp.stat(file)).mtimeMs, mtimeBefore);
});
