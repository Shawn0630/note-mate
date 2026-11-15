import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openTabsKey, restoreOpenTabs, serializeOpenTabs,
  restoreWorkTabs, serializeWorkTabs,
} from '../public/openTabs.js';

const NOTES = [
  { name: 'notes.md', kind: 'md' },
  { name: 'a.md', kind: 'md' },
  { name: 'b.ipynb', kind: 'ipynb' },
  { name: 'c.md', kind: 'md' },
];

const LABS = [
  { chapter: 'Chap01', files: [{ name: '1_1_Intro.ipynb' }] },
  { chapter: 'Chap02', files: [{ name: '2_1_Supervised.ipynb' }] },
];

const SECTIONS = [
  { id: 'micrograd', name: 'Micrograd', notebooks: [{ name: 'micrograd.ipynb' }] },
  { id: 'makemore', name: 'Makemore', notebooks: [{ name: 'bigrams.ipynb' }] },
];

const AVAIL = { notes: NOTES, labs: LABS, sections: SECTIONS };

test('openTabsKey: one entry per project slug', () => {
  assert.equal(openTabsKey('understanding-deep-learning'), 'nm-open-tabs:understanding-deep-learning');
});

test('restoreOpenTabs: nothing stored → every editable note open', () => {
  assert.deepEqual([...restoreOpenTabs(null, NOTES)], ['a.md', 'b.ipynb', 'c.md']);
  assert.deepEqual([...restoreOpenTabs(undefined, NOTES)], ['a.md', 'b.ipynb', 'c.md']);
});

test('restoreOpenTabs: stored names win, stale names dropped, notes.md never stored', () => {
  assert.deepEqual(
    [...restoreOpenTabs('["b.ipynb","notes.md","gone.md"]', NOTES)],
    ['b.ipynb'],
  );
});

test('restoreOpenTabs: an empty stored array is a real choice, not corruption', () => {
  assert.deepEqual([...restoreOpenTabs('[]', NOTES)], []);
  assert.deepEqual([...restoreOpenTabs([], NOTES)], []);
});

test('restoreOpenTabs: malformed or wrong-typed stores fall back to all', () => {
  assert.deepEqual([...restoreOpenTabs('not json{', NOTES)], ['a.md', 'b.ipynb', 'c.md']);
  assert.deepEqual([...restoreOpenTabs({ a: 1 }, NOTES)], ['a.md', 'b.ipynb', 'c.md']);
  assert.deepEqual([...restoreOpenTabs('a.md', NOTES)], ['a.md', 'b.ipynb', 'c.md']);
});

test('restoreOpenTabs: plain string names also accepted', () => {
  assert.deepEqual([...restoreOpenTabs(null, ['x.md', 'notes.md'])], ['x.md']);
});

test('serializeOpenTabs: sorted JSON array', () => {
  assert.equal(serializeOpenTabs(new Set(['c.md', 'a.md'])), '["a.md","c.md"]');
  assert.equal(serializeOpenTabs(new Set()), '[]');
});

test('restoreWorkTabs: new object store restores notes + labs + sections + active', () => {
  const raw = JSON.stringify({
    notes: ['a.md', 'b.ipynb'],
    labs: [{ chapter: 'Chap01', name: '1_1_Intro.ipynb' }],
    sections: [{ sectionId: 'micrograd', name: 'micrograd.ipynb' }],
    active: { kind: 'lab', chapter: 'Chap01', name: '1_1_Intro.ipynb' },
  });
  const out = restoreWorkTabs(raw, AVAIL);
  assert.deepEqual([...out.notes], ['a.md', 'b.ipynb']);
  assert.deepEqual(out.labs, [{ chapter: 'Chap01', name: '1_1_Intro.ipynb' }]);
  assert.deepEqual(out.sections, [{ sectionId: 'micrograd', name: 'micrograd.ipynb' }]);
  assert.deepEqual(out.active, { kind: 'lab', chapter: 'Chap01', name: '1_1_Intro.ipynb' });
});

test('restoreWorkTabs: stale lab/section/active entries are dropped, notes kept', () => {
  const raw = JSON.stringify({
    notes: ['a.md', 'gone.md'],
    labs: [{ chapter: 'Chap01', name: 'gone.ipynb' }, { chapter: 'Chap02', name: '2_1_Supervised.ipynb' }],
    sections: [{ sectionId: 'gone', name: 'x.ipynb' }],
    active: { kind: 'section', sectionId: 'gone', name: 'x.ipynb' },
  });
  const out = restoreWorkTabs(raw, AVAIL);
  assert.deepEqual([...out.notes], ['a.md']);
  assert.deepEqual(out.labs, [{ chapter: 'Chap02', name: '2_1_Supervised.ipynb' }]);
  assert.deepEqual(out.sections, []);
  assert.equal(out.active, null);
});

test('restoreWorkTabs: active tab must be one of the restored tabs', () => {
  const raw = JSON.stringify({
    notes: ['a.md'],
    labs: [{ chapter: 'Chap01', name: '1_1_Intro.ipynb' }],
    sections: [],
    // Active names a lab that exists but is not in the stored labs list.
    active: { kind: 'lab', chapter: 'Chap02', name: '2_1_Supervised.ipynb' },
  });
  const out = restoreWorkTabs(raw, AVAIL);
  assert.equal(out.active, null);
  const raw2 = JSON.stringify({
    notes: ['a.md'],
    labs: [],
    sections: [],
    active: { kind: 'note', name: 'a.md' },
  });
  assert.deepEqual(restoreWorkTabs(raw2, AVAIL).active, { kind: 'note', name: 'a.md' });
});

test('restoreWorkTabs: old bare-array store restores as notes-only', () => {
  const out = restoreWorkTabs('["b.ipynb"]', AVAIL);
  assert.deepEqual([...out.notes], ['b.ipynb']);
  assert.deepEqual(out.labs, []);
  assert.deepEqual(out.sections, []);
  assert.equal(out.active, null);
});

test('restoreWorkTabs: nothing stored → every editable note open, no tabs', () => {
  const out = restoreWorkTabs(null, AVAIL);
  assert.deepEqual([...out.notes], ['a.md', 'b.ipynb', 'c.md']);
  assert.deepEqual(out.labs, []);
  assert.deepEqual(out.sections, []);
  assert.equal(out.active, null);
});

test('restoreWorkTabs: malformed store falls back like restoreOpenTabs', () => {
  const out = restoreWorkTabs('not json{', AVAIL);
  assert.deepEqual([...out.notes], ['a.md', 'b.ipynb', 'c.md']);
  assert.deepEqual(out.labs, []);
  assert.equal(out.active, null);
});

test('serializeWorkTabs: stable sorted object with active', () => {
  assert.equal(
    serializeWorkTabs({
      notes: new Set(['c.md', 'a.md']),
      labs: [{ chapter: 'Chap02', name: '2_1_Supervised.ipynb' }],
      sections: [{ sectionId: 'micrograd', name: 'micrograd.ipynb' }],
      active: { kind: 'section', sectionId: 'micrograd', name: 'micrograd.ipynb' },
    }),
    '{"notes":["a.md","c.md"],"labs":[{"chapter":"Chap02","name":"2_1_Supervised.ipynb"}],'
    + '"sections":[{"sectionId":"micrograd","name":"micrograd.ipynb"}],'
    + '"active":{"kind":"section","sectionId":"micrograd","name":"micrograd.ipynb"}}',
  );
  assert.equal(
    serializeWorkTabs({ notes: new Set(), labs: [], sections: [], active: null }),
    '{"notes":[],"labs":[],"sections":[],"active":null}',
  );
});

test('serializeWorkTabs + restoreWorkTabs round-trip', () => {
  const stored = serializeWorkTabs({
    notes: new Set(['b.ipynb']),
    labs: [{ chapter: 'Chap01', name: '1_1_Intro.ipynb' }],
    sections: [],
    active: { kind: 'note', name: 'b.ipynb' },
  });
  const out = restoreWorkTabs(stored, AVAIL);
  assert.deepEqual([...out.notes], ['b.ipynb']);
  assert.deepEqual(out.labs, [{ chapter: 'Chap01', name: '1_1_Intro.ipynb' }]);
  assert.deepEqual(out.active, { kind: 'note', name: 'b.ipynb' });
});
