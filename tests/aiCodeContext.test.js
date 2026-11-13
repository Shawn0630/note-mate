import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_CODE_CONTEXT_CHARS,
  cellSourceText,
  targetCellLabel,
  targetCellFingerprint,
  formatNotebookCellsForCodeAi,
} from '../public/aiCodeContext.js';

const todoCell = {
  cell_type: 'code',
  source: [
    '# Define a linear function with just one input, x\n',
    'def linear_function_1D(x,beta,omega):\n',
    '  # TODO -- replace the code line below with formula for 1D linear equation\n',
    '  y = x\n',
    '\n',
    '  return y',
  ],
};
const mdCell = { cell_type: 'markdown', source: '**Linear functions**\n\nWe will be using the term *linear equation*...' };
const importCell = { cell_type: 'code', source: '# Imports math library\nimport numpy as np' };

test('cellSourceText joins string[] sources and passes strings through', () => {
  assert.equal(cellSourceText(todoCell), '# Define a linear function with just one input, x\ndef linear_function_1D(x,beta,omega):\n  # TODO -- replace the code line below with formula for 1D linear equation\n  y = x\n\n  return y');
  assert.equal(cellSourceText({ source: 'x = 1' }), 'x = 1');
  assert.equal(cellSourceText({}), '');
});

test('targetCellLabel is the first code line (the def line for the TODO cell)', () => {
  assert.equal(targetCellLabel(todoCell), 'def linear_function_1D(x,beta,omega):');
  assert.equal(targetCellLabel(mdCell), '**Linear functions**');
  assert.equal(targetCellLabel({ cell_type: 'code', source: '' }), '(empty cell)');
});

test('formatNotebookCellsForCodeAi marks the target and keeps notebook order', () => {
  const { parts, truncated } = formatNotebookCellsForCodeAi(
    [mdCell, importCell, todoCell], 2);
  assert.equal(truncated, false);
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^--- cell 0 \(markdown\) ---\n\*\*Linear functions\*\*/);
  assert.match(parts[1], /^--- cell 1 \(code\) ---\n# Imports math library/);
  assert.match(parts[2], /^--- cell 2 \(code\) · TARGET — replace this cell ---\n# Define a linear function/);
  assert.match(parts[2], /def linear_function_1D\(x,beta,omega\):/);
  assert.doesNotMatch(parts.join('\n'), /cell 0 \(markdown\) · TARGET/);
});

test('formatNotebookCellsForCodeAi includes markdown cells as context', () => {
  const { parts } = formatNotebookCellsForCodeAi([mdCell, todoCell], null);
  assert.equal(parts.length, 2);
  assert.match(parts.join('\n'), /Linear functions/);
  assert.doesNotMatch(parts.join('\n'), /TARGET/);
});

test('formatNotebookCellsForCodeAi always keeps the target under a tight budget', () => {
  const big = { cell_type: 'code', source: `x = 1\n${'#'.repeat(500)}\n` };
  const { parts, truncated } = formatNotebookCellsForCodeAi(
    [big, big, todoCell], 2, 600);
  assert.equal(truncated, true);
  const joined = parts.join('\n');
  assert.match(joined, /TARGET — replace this cell/);
  assert.match(joined, /def linear_function_1D/);
  assert.match(joined, /notebook context truncated/);
});

test('targetCellFingerprint matches the label first line', () => {
  assert.equal(targetCellFingerprint(todoCell), 'def linear_function_1D(x,beta,omega):');
});

test('context budget fits a whole UDL lab', () => {
  assert.ok(AI_CODE_CONTEXT_CHARS >= 32768);
});
