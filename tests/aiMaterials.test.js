// Unit tests for Fill with AI for Materials (src/aiMaterials.js):
// proposal normalization/validation, dedupe keys, and the prompt shape.
// The LLM call itself is covered by the endpoint tests (stubbed) and the
// browser probe; no live key is needed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMaterialEntry, normalizeMaterialsProposal, validateMaterialsProposal,
  dedupeMaterials, materialDedupeKey, buildMaterialsPrompt,
  MAX_MATERIALS_PROPOSAL, youtubeWatchUrl,
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

test('normalizeMaterialsProposal: drops invalid entries and caps at 20', () => {
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
  assert.equal(out.dropped, 2 + 4); // 2 invalid + 4 over the cap ('Good' takes one of the 20 slots)
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
