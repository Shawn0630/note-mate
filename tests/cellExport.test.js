import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fenceLanguage, cellSource, pngHash, assetFileName, cellImages, cellStreams,
  cellsToMarkdown, notebookToMarkdown,
} from '../src/cellExport.js';

// A 1x1 transparent PNG (valid PNG bytes, 68 bytes when decoded).
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const PNG_1X1_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function nb(cells, lang = 'python') {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { language: lang }, language_info: { name: lang } },
    cells,
  };
}

const codeCell = (source, outputs = []) => ({
  cell_type: 'code', execution_count: 1, metadata: {}, outputs, source,
});
const mdCell = (source) => ({ cell_type: 'markdown', metadata: {}, source });

test('fenceLanguage: language_info wins, then kernelspec, then python', () => {
  assert.equal(fenceLanguage(nb([], 'javascript')), 'javascript');
  assert.equal(fenceLanguage({ metadata: { kernelspec: { language: 'Java' } }, cells: [] }), 'java');
  assert.equal(fenceLanguage({ metadata: {}, cells: [] }), 'python');
  assert.equal(fenceLanguage(null), 'python');
});

test('cellStreams / cellImages: streams split by name, images in order', () => {
  const cell = codeCell('x', [
    { output_type: 'stream', name: 'stdout', text: 'hello\n' },
    { output_type: 'stream', name: 'stderr', text: 'warn\n' },
    { output_type: 'display_data', data: { 'image/png': PNG_1X1 }, metadata: {} },
    { output_type: 'execute_result', data: { 'text/plain': '3' }, metadata: {}, execution_count: 1 },
  ]);
  assert.deepEqual(cellStreams(cell), { stdout: 'hello\n', stderr: 'warn\n' });
  assert.deepEqual(cellImages(cell), [PNG_1X1]);
  assert.deepEqual(cellStreams(codeCell('x', [])), { stdout: '', stderr: '' });
  assert.deepEqual(cellImages(codeCell('x', [])), []);
});

test('pngHash + assetFileName: content hash, stable name', () => {
  const h = pngHash(PNG_1X1);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(pngHash(PNG_1X1), h);
  assert.notEqual(pngHash(PNG_1X1_B), h);
  assert.equal(assetFileName('1_1_BackgroundMathematics', 4, h), `1_1_BackgroundMathematics-cell-5-${h.slice(0, 8)}.png`);
  assert.equal(assetFileName('my lab!', 0, h), 'my-lab-cell-1-' + `${h.slice(0, 8)}.png`);
});

test('cellsToMarkdown: code fence + stdout + stderr + plot link, in order', () => {
  const notebook = nb([
    mdCell('# Title'),
    codeCell('import numpy as np\nprint(np.arange(3))', [
      { output_type: 'stream', name: 'stdout', text: '[0 1 2]\n' },
    ]),
    codeCell('plt.plot([1,2]); plt.show()', [
      { output_type: 'stream', name: 'stderr', text: 'UserWarning: x\n' },
      { output_type: 'display_data', data: { 'image/png': PNG_1X1 }, metadata: {} },
    ]),
  ]);
  const { markdown, images } = cellsToMarkdown({ notebook, name: '1_1_Test.ipynb', indices: [1, 2] });
  assert.match(markdown, /### Cell 2/);
  assert.match(markdown, /```python\nimport numpy as np/);
  assert.match(markdown, /```\n\[0 1 2\]\n```/);
  assert.match(markdown, /\*\*stderr:\*\*\n\n```\nUserWarning: x\n```/);
  const h = pngHash(PNG_1X1).slice(0, 8);
  assert.match(markdown, new RegExp(`!\\[Cell 3 plot\\]\\(assets/1_1_Test-cell-3-${h}\\.png\\)`));
  assert.equal(images.length, 1);
  assert.equal(images[0].cellIndex, 2);
  assert.equal(images[0].fileName, `1_1_Test-cell-3-${h}.png`);
  assert.equal(images[0].base64, PNG_1X1);
});

test('cellsToMarkdown: markdown-only selection is a 400', () => {
  const notebook = nb([mdCell('# Title'), codeCell('print(1)')]);
  assert.throws(
    () => cellsToMarkdown({ notebook, name: 'x.ipynb', indices: [0] }),
    (err) => err.status === 400 && /no code cells/.test(err.message),
  );
});

test('cellsToMarkdown: empty-output cell exports just the fence; JS notebook fences javascript', () => {
  const notebook = nb([codeCell('print(1)', [])]);
  const { markdown, images } = cellsToMarkdown({ notebook, name: 'a.ipynb', indices: [0] });
  assert.equal(markdown, '### Cell 1\n\n```python\nprint(1)\n```');
  assert.deepEqual(images, []);

  const js = nb([codeCell('console.log(1)', [{ output_type: 'stream', name: 'stdout', text: '1\n' }])], 'javascript');
  const out = cellsToMarkdown({ notebook: js, name: 'a.ipynb', indices: [0] });
  assert.match(out.markdown, /```javascript\nconsole\.log\(1\)/);
});

test('cellsToMarkdown: validation — empty selection, out of range, bad notebook', () => {
  const notebook = nb([codeCell('print(1)')]);
  assert.throws(
    () => cellsToMarkdown({ notebook, name: 'a.ipynb', indices: [] }),
    (err) => err.status === 400 && /at least one cell/.test(err.message),
  );
  assert.throws(
    () => cellsToMarkdown({ notebook, name: 'a.ipynb', indices: [5] }),
    (err) => err.status === 400 && /no cell at index 5/.test(err.message),
  );
  assert.throws(
    () => cellsToMarkdown({ notebook: null, name: 'a.ipynb', indices: [0] }),
    (err) => err.status === 400,
  );
});

test('notebookToMarkdown: whole notebook in order — markdown verbatim, code fenced, outputs + plots', () => {
  const notebook = nb([
    mdCell('# Intro\n\nSome **text**.'),
    codeCell('x = 1', [
      { output_type: 'stream', name: 'stdout', text: '1\n' },
      { output_type: 'display_data', data: { 'image/png': PNG_1X1 }, metadata: {} },
    ]),
    mdCell(''),
    { cell_type: 'raw', metadata: {}, source: 'raw line' },
  ]);
  const { markdown, images } = notebookToMarkdown({ notebook, name: 'lab.ipynb' });
  assert.ok(markdown.startsWith('# lab\n\n# Intro\n\nSome **text**.\n\n### Cell 2\n\n```python\nx = 1\n```'));
  assert.match(markdown, /```\n1\n```/); // stdout block
  assert.match(markdown, /!\[Cell 2 plot\]\(assets\/lab-cell-2-[0-9a-f]{8}\.png\)/);
  assert.equal(markdown.trimEnd().endsWith('raw line'), true);
  assert.equal(images.length, 1);
  assert.equal(images[0].base64, PNG_1X1);
  assert.match(images[0].fileName, /^lab-cell-2-[0-9a-f]{8}\.png$/);
});

test('notebookToMarkdown: markdown-only notebook exports the text; empty notebook is just the title', () => {
  const mdOnly = notebookToMarkdown({ notebook: nb([mdCell('## Notes\n\nhello')]), name: 'a.ipynb' });
  assert.equal(mdOnly.markdown, '# a\n\n## Notes\n\nhello\n');
  assert.deepEqual(mdOnly.images, []);
  const empty = notebookToMarkdown({ notebook: nb([]), name: 'b.ipynb' });
  assert.equal(empty.markdown, '# b\n');
  assert.deepEqual(empty.images, []);
});

test('notebookToMarkdown: validation — bad notebook, too many cells', () => {
  assert.throws(
    () => notebookToMarkdown({ notebook: null, name: 'a.ipynb' }),
    (err) => err.status === 400,
  );
  const many = nb(Array.from({ length: 201 }, () => mdCell('x')));
  assert.throws(
    () => notebookToMarkdown({ notebook: many, name: 'a.ipynb' }),
    (err) => err.status === 400 && /at most 200/.test(err.message),
  );
});
