import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTabsKey, restoreOpenTabs, serializeOpenTabs } from '../public/openTabs.js';

const NOTES = [
  { name: 'notes.md', kind: 'md' },
  { name: 'a.md', kind: 'md' },
  { name: 'b.ipynb', kind: 'ipynb' },
  { name: 'c.md', kind: 'md' },
];

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
