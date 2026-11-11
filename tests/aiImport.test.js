import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProposal, noteSkeletonHasProse } from '../src/aiImport.js';

const GOOD_SKELETON = '# Test Book\n\n## 1. Introduction\n\n## 2. Methods\n\n';

test('noteSkeletonHasProse: headings-only skeleton is clean', () => {
  assert.equal(noteSkeletonHasProse(GOOD_SKELETON), false);
  assert.equal(noteSkeletonHasProse('# Title\n\n## A\n<!-- p. 3 -->\n\n## B\n'), false);
});

test('noteSkeletonHasProse: any prose line is rejected', () => {
  assert.equal(noteSkeletonHasProse('# T\n\n## A\n\nSome summary here.\n'), true);
  assert.equal(noteSkeletonHasProse('# T\n\n## A\n\n- key point one\n'), true);
  assert.equal(noteSkeletonHasProse('# T\n\n## A\n\n1. first step\n'), true);
  assert.equal(noteSkeletonHasProse('# T\n\n## A\n\nA stray paragraph.\n'), true);
  // Two top-level title lines is not a skeleton.
  assert.equal(noteSkeletonHasProse('# T\n\n# Another title\n\n## A\n'), true);
});

test('validateProposal: accepts a valid structure-only proposal', () => {
  const out = validateProposal({
    outline: [{ title: 'Introduction', page: 1 }, { title: 'Methods', page: null }],
    noteSkeleton: GOOD_SKELETON,
    chapterMap: { introduction: 0, methods: 1 },
  });
  assert.equal(out.outline.length, 2);
  assert.equal(out.outline[1].page, null);
  assert.equal(out.chapterMap.methods, 1);
});

test('validateProposal: rejects prose in the skeleton', () => {
  assert.throws(
    () => validateProposal({
      outline: [{ title: 'Introduction', page: 1 }],
      noteSkeleton: '# T\n\n## 1. Introduction\n\nThis chapter introduces the topic.\n',
      chapterMap: { introduction: 0 },
    }),
    /only headings with empty bodies/,
  );
});

test('validateProposal: rejects bad shapes', () => {
  const base = {
    outline: [{ title: 'A', page: 1 }],
    noteSkeleton: GOOD_SKELETON,
    chapterMap: {},
  };
  assert.throws(() => validateProposal(null), /must be a JSON object/);
  assert.throws(() => validateProposal({ ...base, outline: 'nope' }), /outline must be an array/);
  assert.throws(() => validateProposal({ ...base, outline: [{ title: ' ' }] }), /title must be a non-empty string/);
  assert.throws(() => validateProposal({ ...base, outline: [{ title: 'A', page: 0 }] }), /page must be a positive integer/);
  assert.throws(() => validateProposal({ ...base, outline: [{ title: 'A', page: 1.5 }] }), /page must be a positive integer/);
  assert.throws(() => validateProposal({ ...base, noteSkeleton: 42 }), /noteSkeleton must be a non-empty string/);
  assert.throws(() => validateProposal({ ...base, chapterMap: [] }), /chapterMap must be an object/);
  assert.throws(() => validateProposal({ ...base, chapterMap: { a: -1 } }), /non-negative integer/);
  assert.throws(() => validateProposal({ ...base, chapterMap: { a: 'x' } }), /non-negative integer/);
});
