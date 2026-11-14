// Unit tests for GitHub repo ingestion (src/repoIngest.js): URL
// parsing, tree selection (notebooks / manifests / support files /
// skipped), manifest package extraction, and the raw-URL validation
// Apply relies on. The tree fetch is tested against a stub fetch
// serving the fixture tree JSON — no live api.github.com access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractGithubRepo, extractGithubRepoUrls, repoIdFor, rawUrlFor,
  fetchRepoTree, manifestKindFor, selectRepoFiles, extractPackageNames,
  fetchTextCapped, validateSectionNotebookUrl,
  MAX_NOTEBOOK_BYTES, MAX_SUPPORT_FILE_BYTES,
} from '../src/repoIngest.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const treeJson = JSON.parse(fs.readFileSync(path.join(fixtures, 'repo-tree.json'), 'utf8'));

test('extractGithubRepo: owner/repo + optional tree branch, .git and trailing slash tolerated', () => {
  assert.deepEqual(
    extractGithubRepo('https://github.com/chizkidd/Karpathy-Neural-Networks-Zero-to-Hero'),
    { owner: 'chizkidd', repo: 'Karpathy-Neural-Networks-Zero-to-Hero', branch: null },
  );
  assert.deepEqual(
    extractGithubRepo('https://github.com/chizkidd/Karpathy-Neural-Networks-Zero-to-Hero/tree/main/001_micrograd'),
    { owner: 'chizkidd', repo: 'Karpathy-Neural-Networks-Zero-to-Hero', branch: 'main/001_micrograd' },
  );
  assert.deepEqual(
    extractGithubRepo('https://github.com/chizkidd/Karpathy-Neural-Networks-Zero-to-Hero.git'),
    { owner: 'chizkidd', repo: 'Karpathy-Neural-Networks-Zero-to-Hero', branch: null },
  );
  assert.equal(extractGithubRepo('https://github.com/chizkidd'), null);
  assert.equal(extractGithubRepo('https://example.com/chizkidd/repo'), null);
  assert.equal(extractGithubRepo('https://raw.githubusercontent.com/chizkidd/repo/main/x.ipynb'), null);
  assert.equal(extractGithubRepo(''), null);
});

test('extractGithubRepoUrls: finds repo URLs in free text, deduped', () => {
  const found = extractGithubRepoUrls(
    '(1) https://github.com/chizkidd/Karpathy-Neural-Networks-Zero-to-Hero '
    + '(2) https://github.com/chizkidd/Karpathy-Neural-Networks-Zero-to-Hero '
    + 'and https://example.com/not-a-repo',
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].owner, 'chizkidd');
});

test('repoIdFor + rawUrlFor: stable ids and raw URLs', () => {
  assert.equal(repoIdFor({ owner: 'chizkidd', repo: 'Karpathy-Neural-Networks-Zero-to-Hero' }), 'chizkidd-karpathy-neural-networks-zero-to-hero');
  assert.equal(
    rawUrlFor({ owner: 'fixture', repo: 'course-repo', branch: 'main' }, '001_intro/micrograd.ipynb'),
    'https://raw.githubusercontent.com/fixture/course-repo/main/001_intro/micrograd.ipynb',
  );
  assert.equal(
    rawUrlFor({ owner: 'fixture', repo: 'course-repo', branch: 'main' }, 'data/names.txt', 'http://127.0.0.1:9999/raw'),
    'http://127.0.0.1:9999/raw/fixture/course-repo/main/data/names.txt',
  );
});

test('manifestKindFor: the dependency-manifest set', () => {
  assert.equal(manifestKindFor('requirements.txt'), 'requirements.txt');
  assert.equal(manifestKindFor('requirements-dev.txt'), 'requirements.txt');
  assert.equal(manifestKindFor('environment.yml'), 'environment.yml');
  assert.equal(manifestKindFor('environment.yaml'), 'environment.yml');
  assert.equal(manifestKindFor('pyproject.toml'), 'pyproject.toml');
  assert.equal(manifestKindFor('setup.py'), 'setup.py');
  assert.equal(manifestKindFor('Pipfile'), 'Pipfile');
  assert.equal(manifestKindFor('Pipfile.lock'), null);
  assert.equal(manifestKindFor('data/names.txt'), null);
  assert.equal(manifestKindFor('001_intro/micrograd.ipynb'), null);
});

test('selectRepoFiles (fixture tree): notebooks + manifests + support files, huge binary skipped', () => {
  const out = selectRepoFiles(treeJson.tree);
  assert.deepEqual(out.notebooks.map((n) => n.path), [
    '001_intro/micrograd.ipynb',
    '001_intro/micrograd_exercises.ipynb',
    '002_makemore/bigram.ipynb',
    '002_makemore/makemore.ipynb',
  ]);
  assert.equal(out.notebooks[0].dir, '001_intro');
  assert.deepEqual(out.manifests.map((m) => `${m.path} (${m.kind})`), [
    'requirements.txt (requirements.txt)',
    'environment.yml (environment.yml)',
  ]);
  assert.deepEqual(out.supportFiles.map((f) => f.path), [
    '007_gpt/_src/bigram.py',
    'data/names.txt',
    'data/input.txt',
    'README.md',
  ]);
  assert.equal(out.skippedCount, 1);
  assert.deepEqual(out.skipped, [{ path: '007_gpt/model.pth', size: 52700258, reason: 'binary' }]);
});

test('selectRepoFiles: an over-cap notebook and an over-cap text file are skipped as too large', () => {
  const out = selectRepoFiles([
    { path: 'big.ipynb', size: MAX_NOTEBOOK_BYTES + 1 },
    { path: 'data/huge.txt', size: MAX_SUPPORT_FILE_BYTES + 1 },
    { path: 'ok.ipynb', size: 100 },
  ]);
  assert.deepEqual(out.notebooks.map((n) => n.path), ['ok.ipynb']);
  assert.equal(out.skippedCount, 2);
  assert.ok(out.skipped.every((s) => s.reason === 'too large'));
});

test('extractPackageNames: requirements, environment.yml, pyproject.toml, setup.py, Pipfile', () => {
  assert.deepEqual(
    extractPackageNames('requirements.txt', 'numpy\ntorch==2.15.0+cpu\npandas[excel]>=2.0  # comment\n-r other.txt\n'),
    ['numpy', 'torch', 'pandas'],
  );
  assert.deepEqual(
    extractPackageNames('environment.yml',
      'name: x\ndependencies:\n  - python=3.9\n  - numpy\n  - pip:\n    - cowsay\n    - tqdm>=4.0\n'),
    ['numpy', 'cowsay', 'tqdm'],
  );
  assert.deepEqual(
    extractPackageNames('pyproject.toml', '[project]\ndependencies = [\n  "requests>=2.0",\n  "pandas",\n]\n'),
    ['requests', 'pandas'],
  );
  assert.deepEqual(
    extractPackageNames('setup.py', 'install_requires=["flask", "gunicorn>=20.0"]\n'),
    ['flask', 'gunicorn'],
  );
  assert.deepEqual(
    extractPackageNames('Pipfile', '[packages]\nrequests = "*"\nflask = ">=2.0"\n[dev-packages]\npytest = "*"\n'),
    ['requests', 'flask'],
  );
  assert.deepEqual(extractPackageNames('requirements.txt', ''), []);
});

test('fetchRepoTree: metadata for the default branch, then the recursive tree (stub fetch)', async () => {
  const seen = [];
  const stubFetch = async (url) => {
    seen.push(String(url));
    if (String(url).endsWith('/repos/fixture/course-repo')) {
      return { ok: true, status: 200, json: async () => ({ default_branch: 'main' }) };
    }
    if (String(url).includes('/git/trees/main?recursive=1')) {
      return { ok: true, status: 200, json: async () => treeJson };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const out = await fetchRepoTree({ owner: 'fixture', repo: 'course-repo', branch: null }, { fetchImpl: stubFetch });
  assert.equal(out.branch, 'main');
  assert.equal(out.defaultBranch, 'main');
  assert.equal(out.tree.length, treeJson.tree.length);
  assert.ok(seen.some((u) => u.includes('/repos/fixture/course-repo')));
  // An explicit branch skips the metadata fetch.
  const seen2 = [];
  const stubFetch2 = async (url) => {
    seen2.push(String(url));
    return { ok: true, status: 200, json: async () => treeJson };
  };
  const out2 = await fetchRepoTree({ owner: 'fixture', repo: 'course-repo', branch: 'dev' }, { fetchImpl: stubFetch2 });
  assert.equal(out2.branch, 'dev');
  assert.equal(seen2.length, 1);
});

test('fetchRepoTree: 404 → repo not found, 403 → rate limit', async () => {
  const notFound = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(
    fetchRepoTree({ owner: 'no', repo: 'such-repo', branch: null }, { fetchImpl: notFound }),
    (err) => err.status === 404 && /not found/.test(err.message),
  );
  const rateLimited = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(
    fetchRepoTree({ owner: 'fixture', repo: 'course-repo', branch: null }, { fetchImpl: rateLimited }),
    (err) => err.status === 502 && /rate limit/.test(err.message),
  );
});

test('fetchTextCapped: returns text, enforces the byte cap', async () => {
  const okFetch = async () => ({
    ok: true,
    body: null,
    arrayBuffer: async () => new TextEncoder().encode('hello').buffer,
  });
  assert.equal(await fetchTextCapped('https://example.com/x.txt', 100, { fetchImpl: okFetch }), 'hello');
  await assert.rejects(
    fetchTextCapped('https://example.com/x.txt', 3, { fetchImpl: okFetch }),
    (err) => err.status === 502 && /cap/.test(err.message),
  );
  const notFound = async () => ({ ok: false, status: 404 });
  await assert.rejects(
    fetchTextCapped('https://example.com/x.txt', 100, { fetchImpl: notFound }),
    (err) => err.status === 502 && /404/.test(err.message),
  );
});

test('validateSectionNotebookUrl: only raw.githubusercontent.com under a declared repo', () => {
  const repos = [{ owner: 'fixture', repo: 'course-repo', branch: 'main' }];
  assert.deepEqual(
    validateSectionNotebookUrl('https://raw.githubusercontent.com/fixture/course-repo/main/001_intro/micrograd.ipynb', repos),
    { owner: 'fixture', repo: 'course-repo', branch: 'main', path: '001_intro/micrograd.ipynb', repoId: 'fixture-course-repo' },
  );
  const bad = [
    'https://example.com/fixture/course-repo/main/x.ipynb',
    'https://raw.githubusercontent.com/other/course-repo/main/x.ipynb',
    'https://raw.githubusercontent.com/fixture/course-repo/dev/x.ipynb',
    'https://raw.githubusercontent.com/fixture/course-repo/main/data/names.txt',
    'not a url',
  ];
  for (const url of bad) {
    assert.throws(() => validateSectionNotebookUrl(url, repos), (err) => err.status === 400, url);
  }
  // The NM_GITHUB_RAW_BASE test hook changes the accepted host.
  assert.deepEqual(
    validateSectionNotebookUrl('http://127.0.0.1:9999/raw/fixture/course-repo/main/x.ipynb', repos, { rawBase: 'http://127.0.0.1:9999/raw' }),
    { owner: 'fixture', repo: 'course-repo', branch: 'main', path: 'x.ipynb', repoId: 'fixture-course-repo' },
  );
  assert.throws(
    () => validateSectionNotebookUrl('http://127.0.0.1:9999/raw/fixture/course-repo/main/x.ipynb', repos),
    (err) => err.status === 400,
  );
});
