import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NB_UNDO_CAP,
  pushUndoEntry, popUndoEntry, normalizeCellSource,
  editUndoEntry, addUndoEntry, deleteUndoEntry,
  replaceUndoEntry, appendUndoEntry, createEditBaselines,
} from '../public/nbUndo.js';

const cellA = { cell_type: 'code', source: 'x = 1\n' };
const cellB = { cell_type: 'code', source: 'y = 2\n' };
const repl = (over = {}) => replaceUndoEntry({
  msgIndex: 0, cell: cellA,
  prevSource: 'x = 1\n',
  prevOutputs: [{ output_type: 'stream', name: 'stdout', text: '1\n' }],
  prevExecutionCount: 3,
  prevTarget: { index: 2, label: 'x = 1', fingerprint: 'x = 1' },
  ...over,
});

test('push/pop is LIFO; empty pop is a null no-op', () => {
  const stack = [];
  assert.equal(popUndoEntry(stack), null);
  pushUndoEntry(stack, repl({ msgIndex: 0 }));
  pushUndoEntry(stack, repl({ msgIndex: 1 }));
  assert.equal(stack.length, 2);
  assert.equal(popUndoEntry(stack).msgIndex, 1);
  assert.equal(popUndoEntry(stack).msgIndex, 0);
  assert.equal(popUndoEntry(stack), null);
});

test('cap at 20: the oldest entry drops', () => {
  assert.equal(NB_UNDO_CAP, 20);
  const stack = [];
  for (let i = 0; i < 22; i++) pushUndoEntry(stack, repl({ msgIndex: i }));
  assert.equal(stack.length, 20);
  assert.equal(stack[0].msgIndex, 2);
  assert.equal(stack[19].msgIndex, 21);
});

test('replace entry snapshots cell/source/outputs/count/pin, deep-copied', () => {
  const outputs = [{ output_type: 'stream', name: 'stdout', text: '1\n' }];
  const entry = repl({ prevOutputs: outputs });
  assert.equal(entry.kind, 'replace');
  assert.equal(entry.cell, cellA);
  assert.equal(entry.prevSource, 'x = 1\n');
  assert.equal(entry.prevExecutionCount, 3);
  assert.deepEqual(entry.prevTarget, { index: 2, label: 'x = 1', fingerprint: 'x = 1' });
  outputs[0].text = 'MUTATED';
  assert.equal(entry.prevOutputs[0].text, '1\n');
});

test('edit/add/delete/append entries hold the cell object', () => {
  assert.deepEqual(editUndoEntry({ cell: cellA, prevSource: 'x = 1\n' }),
    { kind: 'edit', cell: cellA, prevSource: 'x = 1\n' });
  assert.deepEqual(addUndoEntry({ cell: cellB }), { kind: 'add', cell: cellB });
  assert.deepEqual(deleteUndoEntry({ cell: cellB, index: 3 }),
    { kind: 'delete', cell: cellB, index: 3 });
  assert.deepEqual(appendUndoEntry({ msgIndex: 1, cell: cellB }),
    { kind: 'append', msgIndex: 1, cell: cellB });
});

test('normalizeCellSource joins string[] sources', () => {
  assert.equal(normalizeCellSource(['a = 1\n', 'b = 2']), 'a = 1\nb = 2');
  assert.equal(normalizeCellSource('x'), 'x');
  assert.equal(normalizeCellSource(null), '');
});

test('edit baselines: one step per session, unchanged is a no-op', () => {
  const baselines = createEditBaselines();
  const cell = { cell_type: 'code', source: 'a = 1' };
  // Commit without begin: nothing.
  assert.equal(baselines.commit(cell, 'a = 1'), null);
  baselines.begin(cell, 'a = 1');
  // Unchanged session: no entry.
  assert.equal(baselines.commit(cell, 'a = 1'), null);
  // Changed session: the snapshot, once — a second commit is a no-op.
  baselines.begin(cell, 'a = 1');
  assert.equal(baselines.commit(cell, 'a = 1\nb = 2'), 'a = 1');
  assert.equal(baselines.commit(cell, 'a = 1\nb = 2'), null);
  // A new session snapshots the new source, not the old one.
  baselines.begin(cell, 'a = 1\nb = 2');
  assert.equal(baselines.commit(cell, 'a = 1\nb = 2\nc = 3'), 'a = 1\nb = 2');
});

test('hasUncommittedChange tracks open sessions against the live source', () => {
  const baselines = createEditBaselines();
  const cell = { cell_type: 'code', source: 'a = 1' };
  assert.equal(baselines.hasUncommittedChange(), false);
  baselines.begin(cell, 'a = 1');
  assert.equal(baselines.hasUncommittedChange(), false);
  cell.source = 'a = 1\nb = 2';
  assert.equal(baselines.hasUncommittedChange(), true);
  assert.equal(baselines.commit(cell, 'a = 1\nb = 2'), 'a = 1');
  assert.equal(baselines.hasUncommittedChange(), false);
});

test('commitAll drains open sessions in begin order, unchanged ones skipped', () => {
  const baselines = createEditBaselines();
  baselines.begin(cellA, 'x = 1\n');
  baselines.begin(cellB, 'y = 2\n');
  cellA.source = 'x = 9\n'; // changed; cellB unchanged
  const done = baselines.commitAll();
  assert.equal(done.length, 1);
  assert.equal(done[0].cell, cellA);
  assert.equal(done[0].prevSource, 'x = 1\n');
  // Consumed: a second commitAll finds nothing, and a later commit is a no-op.
  assert.deepEqual(baselines.commitAll(), []);
  assert.equal(baselines.commit(cellA, 'x = 9\n'), null);
  assert.equal(baselines.hasUncommittedChange(), false);
});

test('edit baselines are per cell object, never on the cell', () => {
  const baselines = createEditBaselines();
  baselines.begin(cellA, 'x = 1\n');
  baselines.begin(cellB, 'y = 2\n');
  assert.equal(baselines.commit(cellA, 'x = 9\n'), 'x = 1\n');
  assert.equal(baselines.commit(cellB, 'y = 2\n'), null);
  assert.ok(!('baseline' in cellA) && !Object.keys(cellA).some((k) => k.startsWith('_')));
});
