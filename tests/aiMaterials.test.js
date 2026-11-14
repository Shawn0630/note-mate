// Unit tests for Fill with AI for Materials (src/aiMaterials.js):
// proposal normalization/validation, dedupe keys, and the prompt shape.
// The LLM call itself is covered by the endpoint tests (stubbed) and the
// browser probe; no live key is needed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeMaterialEntry, normalizeMaterialsProposal, validateMaterialsProposal,
  dedupeMaterials, materialDedupeKey, buildMaterialsPrompt,
  normalizeSectionsProposal, validateSectionsProposal, dedupeSectionsByRepoPath,
  gatherExpandedSources, proposeMaterials,
  MAX_MATERIALS_PROPOSAL, MAX_SECTION_NOTEBOOKS_PROPOSAL, youtubeWatchUrl,
} from '../src/aiMaterials.js';

test('normalizeMaterialEntry: YouTube forms normalize to the canonical watch URL', () => {
  assert.deepEqual(
    normalizeMaterialEntry({ title: 'L1', kind: 'video', url: 'https://youtu.be/dQw4w9WgXcQ' }),
    { title: 'L1', kind: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  );
  assert.deepEqual(
    normalizeMaterialEntry({ title: 'Short', kind: 'video', url: 'https://www.youtube.com/shorts/aqz-KE-bpKQ' }),
    { title: 'Short', kind: 'video', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' },
  );
  assert.equal(youtubeWatchUrl('9bZkp7q19f0'), 'https://www.youtube.com/watch?v=9bZkp7q19f0');
});

test('normalizeMaterialEntry: a video with a non-YouTube URL is invalid', () => {
  assert.equal(
    normalizeMaterialEntry({ title: 'Nope', kind: 'video', url: 'https://vimeo.com/123456789' }),
    null,
  );
  assert.equal(
    normalizeMaterialEntry({ title: 'Nope', kind: 'video', url: 'https://www.youtube.com/watch' }),
    null,
  );
});

test('normalizeMaterialEntry: links need http(s); a YouTube URL as a link coerces to video', () => {
  assert.deepEqual(
    normalizeMaterialEntry({ title: 'Doc', kind: 'link', url: 'https://example.com/guide' }),
    { title: 'Doc', kind: 'link', url: 'https://example.com/guide' },
  );
  assert.deepEqual(
    normalizeMaterialEntry({ title: 'Vid', kind: 'link', url: 'https://youtu.be/dQw4w9WgXcQ' }),
    { title: 'Vid', kind: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  );
  assert.equal(normalizeMaterialEntry({ title: 'FTP', kind: 'link', url: 'ftp://example.com/x' }), null);
  assert.equal(normalizeMaterialEntry({ title: 'JS', kind: 'link', url: 'javascript:alert(1)' }), null);
  assert.equal(normalizeMaterialEntry({ title: 'Bad', kind: 'link', url: 'not a url' }), null);
});

test('normalizeMaterialEntry: title and kind are required', () => {
  assert.equal(normalizeMaterialEntry({ title: '  ', kind: 'video', url: 'https://youtu.be/dQw4w9WgXcQ' }), null);
  assert.equal(normalizeMaterialEntry({ kind: 'video', url: 'https://youtu.be/dQw4w9WgXcQ' }), null);
  assert.equal(normalizeMaterialEntry({ title: 'X', kind: 'file', url: 'https://example.com/x.pdf' }), null);
  assert.equal(normalizeMaterialEntry({ title: 'X', kind: 'video' }), null);
  assert.equal(normalizeMaterialEntry(null), null);
  assert.equal(normalizeMaterialEntry('https://youtu.be/dQw4w9WgXcQ'), null);
});

test('normalizeMaterialsProposal: drops invalid entries and caps at MAX_MATERIALS_PROPOSAL', () => {
  const many = Array.from({ length: MAX_MATERIALS_PROPOSAL + 3 }, (_, i) => ({
    title: `Video ${i + 1}`, kind: 'video', url: `https://youtu.be/${String(i).padStart(11, 'a')}`,
  }));
  const out = normalizeMaterialsProposal({
    materials: [
      { title: 'Good', kind: 'video', url: 'https://youtu.be/dQw4w9WgXcQ' },
      { title: 'Bad', kind: 'video', url: 'https://vimeo.com/1' },
      { title: '', kind: 'link', url: 'https://example.com/x' },
      ...many,
    ],
    note: '  hello  ',
  });
  assert.equal(out.materials.length, MAX_MATERIALS_PROPOSAL);
  assert.equal(out.materials[0].title, 'Good');
  assert.equal(out.dropped, 2 + 4); // 2 invalid + 4 over the cap ('Good' takes one of the MAX slots)
  assert.equal(out.note, 'hello');
  assert.deepEqual(normalizeMaterialsProposal(null), { materials: [], dropped: 0, note: '' });
  assert.deepEqual(normalizeMaterialsProposal({ materials: 'nope' }), { materials: [], dropped: 0, note: '' });
});

test('validateMaterialsProposal: strict — any invalid entry fails the whole apply', () => {
  assert.deepEqual(
    validateMaterialsProposal({
      materials: [{ title: 'L1', kind: 'video', url: 'https://youtu.be/dQw4w9WgXcQ' }],
    }),
    {
      materials: [{ title: 'L1', kind: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }],
      note: '',
    },
  );
  assert.throws(
    () => validateMaterialsProposal({ materials: [
      { title: 'L1', kind: 'video', url: 'https://youtu.be/dQw4w9WgXcQ' },
      { title: 'Bad', kind: 'video', url: 'https://vimeo.com/1' },
    ] }),
    (err) => err.status === 400 && /materials\[1\]/.test(err.message),
  );
  assert.throws(() => validateMaterialsProposal({ materials: [] }), (err) => err.status === 400);
  assert.throws(() => validateMaterialsProposal({}), (err) => err.status === 400);
  assert.throws(() => validateMaterialsProposal(null), (err) => err.status === 400);
});

test('materialDedupeKey: a video keys on its id, a link on its URL', () => {
  assert.equal(materialDedupeKey({ kind: 'video', url: 'https://youtu.be/dQw4w9WgXcQ' }), 'video:dQw4w9WgXcQ');
  assert.equal(
    materialDedupeKey({ kind: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10' }),
    'video:dQw4w9WgXcQ',
  );
  assert.equal(materialDedupeKey({ kind: 'link', url: 'https://example.com/a' }), 'link:https://example.com/a');
  assert.equal(materialDedupeKey({ kind: 'video', url: 'https://vimeo.com/1' }), null);
  assert.equal(materialDedupeKey({ kind: 'pdf' }), null);
});

test('dedupeMaterials: same video in another URL form and same link are duplicates', () => {
  const existing = [
    { id: 'lecture-1', kind: 'video', videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    { id: 'doc', kind: 'link', url: 'https://example.com/a' },
  ];
  const { added, skipped } = dedupeMaterials(existing, [
    { title: 'Same video, shorts form', kind: 'video', url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' },
    { title: 'Same link', kind: 'link', url: 'https://example.com/a' },
    { title: 'New video', kind: 'video', url: 'https://youtu.be/9bZkp7q19f0' },
    { title: 'New video again', kind: 'video', url: 'https://www.youtube.com/watch?v=9bZkp7q19f0' },
    { title: 'New link', kind: 'link', url: 'https://example.com/b' },
  ]);
  assert.deepEqual(added.map((a) => a.title), ['New video', 'New link']);
  assert.deepEqual(skipped.map((s) => [s.title, s.reason]), [
    ['Same video, shorts form', 'duplicate'],
    ['Same link', 'duplicate'],
    ['New video again', 'duplicate'],
  ]);
  assert.deepEqual(dedupeMaterials([], []), { added: [], skipped: [] });
});

test('buildMaterialsPrompt: carries the project, the existing list and the thread', () => {
  const prompt = buildMaterialsPrompt({
    projectTitle: 'Deep Learning',
    existing: [{ label: 'Lecture 1', kind: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }],
    messages: [
      { role: 'user', content: 'Add the lecture videos for chapters 1–12' },
      { role: 'assistant', content: 'Two lecture videos.\nMaterials proposed:\n- Lecture 1 (video): https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      { role: 'user', content: 'only the first 6' },
    ],
  });
  assert.match(prompt, /Deep Learning/);
  assert.match(prompt, /Lecture 1 \(video\): https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ/);
  assert.match(prompt, /User: Add the lecture videos for chapters 1–12/);
  assert.match(prompt, /Assistant: Two lecture videos\./);
  assert.match(prompt, /User: only the first 6/);
  assert.match(prompt, /NEVER invent a URL/);
  const empty = buildMaterialsPrompt({ projectTitle: 'T', existing: [], messages: [{ role: 'user', content: 'hi' }] });
  assert.match(empty, /None yet\./);
});

// --- Playlist + repo ingest (sections) ---

const REPOS = [{ owner: 'fixture', repo: 'course-repo', branch: 'main' }];
const RAW = 'https://raw.githubusercontent.com/fixture/course-repo/main';

test('normalizeSectionsProposal: keeps valid sections, drops bad URLs and non-notebooks', () => {
  const out = normalizeSectionsProposal({
    sections: [
      {
        name: '001 Intro',
        notebooks: [
          { name: 'micrograd.ipynb', url: `${RAW}/001_intro/micrograd.ipynb` },
          { name: 'micrograd.ipynb', url: `${RAW}/001_intro/micrograd.ipynb` },
          { name: 'not-a-notebook.txt', url: `${RAW}/data/names.txt` },
          { name: 'elsewhere.ipynb', url: 'https://raw.githubusercontent.com/other/repo/main/x.ipynb' },
        ],
      },
      { name: '  ', notebooks: [{ name: 'x.ipynb', url: `${RAW}/x.ipynb` }] },
      { name: 'Empty', notebooks: [] },
    ],
  }, REPOS);
  assert.equal(out.sections.length, 1);
  assert.equal(out.sections[0].name, '001 Intro');
  assert.deepEqual(out.sections[0].notebooks.map((n) => n.name), ['micrograd.ipynb']);
  assert.equal(out.sections[0].notebooks[0].repoPath, '001_intro/micrograd.ipynb');
  assert.equal(out.sections[0].notebooks[0].repoId, 'fixture-course-repo');
  assert.equal(out.dropped, 2);
  assert.deepEqual(normalizeSectionsProposal({}, REPOS), { sections: [], dropped: 0 });
});

test('validateSectionsProposal: strict — any invalid section fails the whole apply', () => {
  assert.deepEqual(
    validateSectionsProposal({
      sections: [{ name: 'S', notebooks: [{ name: 'x.ipynb', url: `${RAW}/x.ipynb` }] }],
    }, REPOS),
    [{ name: 'S', notebooks: [{ name: 'x.ipynb', url: `${RAW}/x.ipynb`, repoPath: 'x.ipynb', repoId: 'fixture-course-repo' }] }],
  );
  assert.throws(
    () => validateSectionsProposal({ sections: [{ name: 'S', notebooks: [{ name: 'x.ipynb', url: 'https://example.com/x.ipynb' }] }] }, REPOS),
    (err) => err.status === 400,
  );
  assert.deepEqual(validateSectionsProposal({ sections: [] }, REPOS), []);
});

test('dedupeSectionsByRepoPath: a repo file already in any section is a duplicate', () => {
  const existing = [
    { id: 's1', name: 'Old', notebooks: [{ name: 'micrograd.ipynb', path: 'notes/sections/s1/micrograd.ipynb', repoPath: '001_intro/micrograd.ipynb' }] },
  ];
  const { sections, skipped } = dedupeSectionsByRepoPath(existing, [
    {
      name: '001 Intro',
      notebooks: [
        { name: 'micrograd.ipynb', url: `${RAW}/001_intro/micrograd.ipynb`, repoPath: '001_intro/micrograd.ipynb', repoId: 'fixture-course-repo' },
        { name: 'micrograd_exercises.ipynb', url: `${RAW}/001_intro/micrograd_exercises.ipynb`, repoPath: '001_intro/micrograd_exercises.ipynb', repoId: 'fixture-course-repo' },
      ],
    },
    {
      name: 'Empty after dedupe',
      notebooks: [
        { name: 'micrograd.ipynb', url: `${RAW}/001_intro/micrograd.ipynb`, repoPath: '001_intro/micrograd.ipynb', repoId: 'fixture-course-repo' },
      ],
    },
  ]);
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0].notebooks.map((n) => n.name), ['micrograd_exercises.ipynb']);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((s) => s.reason === 'duplicate'));
});

// A stub fetch serving the fixture playlist page + fixture repo (tree,
// metadata, raw files) under test-controlled bases.
function makeStubFetch() {
  const fixtures = new URL('./fixtures/', import.meta.url);
  const read = (rel) => fs.readFileSync(new URL(rel, fixtures), 'utf8');
  const treeJson = JSON.parse(read('repo-tree.json'));
  return async (url) => {
    const s = String(url);
    if (s.includes('/playlist?')) {
      return { ok: true, status: 200, text: async () => read('playlist-page-lockup.html') };
    }
    if (s.includes('/feeds/videos.xml')) {
      return { ok: true, status: 200, text: async () => read('playlist-rss.xml') };
    }
    if (s === 'http://stub/api/repos/fixture/course-repo') {
      return { ok: true, status: 200, json: async () => ({ default_branch: 'main' }) };
    }
    if (s.includes('/repos/fixture/course-repo/git/trees/main')) {
      return { ok: true, status: 200, json: async () => treeJson };
    }
    if (s.startsWith('http://stub/raw/fixture/course-repo/main/')) {
      const rel = s.slice('http://stub/raw/fixture/course-repo/main/'.length);
      const file = new URL(`repo-notebooks/${rel}`, fixtures);
      try {
        const buf = fs.readFileSync(file);
        return {
          ok: true, status: 200,
          body: null,
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        };
      } catch {
        return { ok: false, status: 404, text: async () => '' };
      }
    }
    return { ok: false, status: 404, text: async () => '' };
  };
}

// The import check, stubbed: numpy/matplotlib/torch present, the rest missing.
function makeStubRun() {
  return async (cmd, args) => {
    if (args[0] === '-c') {
      const names = args.slice(2);
      const out = {};
      for (const n of names) out[n] = ['numpy', 'matplotlib', 'torch'].includes(n);
      return { stdout: JSON.stringify(out), stderr: '' };
    }
    return { stdout: 'ok', stderr: '' };
  };
}

const GATHER_MESSAGES = [
  { role: 'user', content: 'Feed the AI (1) https://github.com/fixture/course-repo (2) https://www.youtube.com/playlist?list=PLAQhlrjkxbuWI23v9cThsA9GvCAUhRvKZ — left youtube, right section labs, use all the ipynb' },
];

test('gatherExpandedSources: playlist + repo expand, manifests list packages, missing packages found', async () => {
  const sources = await gatherExpandedSources(GATHER_MESSAGES, {
    fetchImpl: makeStubFetch(),
    apiBase: 'http://stub/api',
    rawBase: 'http://stub/raw',
    runImpl: makeStubRun(),
  });
  assert.equal(sources.playlists.length, 1);
  assert.equal(sources.playlists[0].videos.length, 3);
  assert.equal(sources.playlists[0].videos[0].title, 'The spelled-out intro to neural networks');
  assert.equal(sources.repos.length, 1);
  const repo = sources.repos[0];
  assert.equal(repo.branch, 'main');
  assert.equal(repo.notebooks.length, 4);
  assert.equal(repo.manifests.length, 2);
  assert.deepEqual(repo.packages, ['numpy', 'torch', 'matplotlib', 'cowsay', 'pandas', 'tqdm']);
  assert.deepEqual(repo.supportFiles.map((f) => f.path), [
    '007_gpt/_src/bigram.py', 'data/names.txt', 'data/input.txt', 'README.md',
  ]);
  assert.equal(repo.skippedCount, 1); // the 52MB .pth
  assert.deepEqual(repo.notebookErrors, []);
  assert.deepEqual(
    sources.missingPackages.map((m) => `${m.importName}→${m.package}`),
    ['graphviz→graphviz', 'notarealmodule→notarealmodule', 'pandas→pandas', 'tqdm→tqdm'],
  );
});

test('gatherExpandedSources: a failed playlist/repo is captured, not thrown', async () => {
  const deadFetch = async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) });
  const sources = await gatherExpandedSources(GATHER_MESSAGES, {
    fetchImpl: deadFetch, runImpl: makeStubRun(),
  });
  assert.equal(sources.playlists[0].error && typeof sources.playlists[0].error, 'string');
  assert.match(sources.playlists[0].error, /could not load playlist/);
  assert.match(sources.repos[0].error, /not found/);
  assert.deepEqual(sources.missingPackages, []);
});

test('buildMaterialsPrompt with sources: lists real videos + notebooks, keeps the no-invent rule', async () => {
  const sources = await gatherExpandedSources(GATHER_MESSAGES, {
    fetchImpl: makeStubFetch(),
    apiBase: 'http://stub/api',
    rawBase: 'http://stub/raw',
    runImpl: makeStubRun(),
  });
  const prompt = buildMaterialsPrompt({
    projectTitle: 'Course', existing: [], messages: GATHER_MESSAGES, sources,
  });
  assert.match(prompt, /The spelled-out intro to neural networks/);
  assert.match(prompt, /https:\/\/www\.youtube\.com\/watch\?v=VMj-3S1tku0/);
  assert.match(prompt, /001_intro\/micrograd\.ipynb — http:\/\/stub\/raw\/fixture\/course-repo\/main\/001_intro\/micrograd\.ipynb/);
  assert.match(prompt, /needs \(from requirements\.txt, environment\.yml\): numpy, torch, matplotlib, cowsay, pandas, tqdm/);
  assert.match(prompt, /support files \(fetched at Apply/);
  assert.match(prompt, /skipped, not fetched: 1 file/);
  assert.match(prompt, /NEVER invent a URL/);
  assert.match(prompt, /Playlist videos are expandable/);
});

test('proposeMaterials: stubbed LLM returns sections; sources ride along', async () => {
  const stub = JSON.stringify({
    materials: [
      { title: 'Intro to NN', kind: 'video', url: 'https://www.youtube.com/watch?v=VMj-3S1tku0' },
      { title: 'Language modeling', kind: 'video', url: 'https://www.youtube.com/watch?v=PaCmpygFfXo' },
    ],
    sections: [
      { name: '001 Intro', notebooks: [{ name: 'micrograd.ipynb', url: 'http://stub/raw/fixture/course-repo/main/001_intro/micrograd.ipynb' }] },
      { name: '002 Makemore', notebooks: [{ name: 'bigram.ipynb', url: 'http://stub/raw/fixture/course-repo/main/002_makemore/bigram.ipynb' }] },
    ],
    note: 'Two videos, two sections.',
  });
  const savedStub = process.env.LLM_STUB_RESPONSE;
  const savedFile = process.env.LLM_ENV_FILE;
  process.env.LLM_STUB_RESPONSE = stub;
  process.env.LLM_ENV_FILE = '/nonexistent/none.env';
  try {
    const { proposal, sources } = await proposeMaterials({
      projectTitle: 'Course', existing: [], messages: GATHER_MESSAGES,
      fetchImpl: makeStubFetch(),
      apiBase: 'http://stub/api',
      rawBase: 'http://stub/raw',
      runImpl: makeStubRun(),
    });
    assert.equal(proposal.materials.length, 2);
    assert.equal(proposal.sections.length, 2);
    assert.equal(proposal.note, 'Two videos, two sections.');
    assert.equal(sources.repos[0].notebooks.length, 4);
    assert.ok(sources.missingPackages.some((m) => m.package === 'notarealmodule'));
  } finally {
    if (savedStub === undefined) delete process.env.LLM_STUB_RESPONSE;
    else process.env.LLM_STUB_RESPONSE = savedStub;
    if (savedFile === undefined) delete process.env.LLM_ENV_FILE;
    else process.env.LLM_ENV_FILE = savedFile;
  }
});
