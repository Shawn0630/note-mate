import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  slugify,
  normalizeHeading,
  matchOutlineToHeadings,
  parseNotebook,
  cellsOf,
  applyCellOutput,
  resolveProjectPath,
  extractYoutubeVideoId,
} from '../src/util.js';

test('slugify: lowercase, dashes, trims, fallback', () => {
  assert.equal(slugify('Understanding Deep Learning'), 'understanding-deep-learning');
  assert.equal(slugify('  Hello, World!  '), 'hello-world');
  assert.equal(slugify('C++ & Java: 101'), 'c-java-101');
  assert.equal(slugify('---'), 'project');
  assert.equal(slugify(''), 'project');
  assert.equal(slugify('a  b   c'), 'a-b-c');
});

test('normalizeHeading: strips numbering, chapter prefixes, punctuation', () => {
  assert.equal(normalizeHeading('1.2 Supervised Learning'), 'supervised learning');
  assert.equal(normalizeHeading('Chapter 1: Introduction'), 'introduction');
  assert.equal(normalizeHeading('Chapter 12 - Transformers'), 'transformers');
  assert.equal(normalizeHeading('1 - Introduction.'), 'introduction');
  assert.equal(normalizeHeading('21. Deep Learning and Ethics'), 'deep learning and ethics');
  assert.equal(normalizeHeading('Appendix A: Notation'), 'notation');
  assert.equal(normalizeHeading('  Why Does Deep Learning Work?  '), 'why does deep learning work');
  assert.equal(normalizeHeading(''), '');
});

test('matchOutlineToHeadings: exact first, then startsWith/contains, null on miss', () => {
  const headings = [
    'Introduction',
    'Supervised learning',
    'Shallow neural networks',
    'Deep neural networks',
  ];
  assert.deepEqual(
    matchOutlineToHeadings(
      ['Chapter 1: Introduction', '2. Supervised Learning', 'Transformers', 'Deep neural networks'],
      headings,
    ),
    [0, 1, null, 3],
  );
  // startsWith: outline shorter than the heading
  assert.deepEqual(
    matchOutlineToHeadings(['Deep neural'], ['Deep neural networks and depth']),
    [0],
  );
  // contains: outline longer than the heading
  assert.deepEqual(
    matchOutlineToHeadings(['Introduction to deep learning'], ['Introduction']),
    [0],
  );
  // empty outline title -> null
  assert.deepEqual(matchOutlineToHeadings(['', '  '], headings), [null, null]);
});

test('parseNotebook / cellsOf: valid and invalid', () => {
  const nb = parseNotebook(JSON.stringify({
    nbformat: 4, nbformat_minor: 5,
    cells: [{ cell_type: 'code', source: ['x=1'], metadata: {}, outputs: [] }],
  }));
  assert.equal(cellsOf(nb).length, 1);
  assert.throws(() => parseNotebook('not json'), /Invalid notebook JSON/);
  assert.throws(() => parseNotebook('{"cells":[]}'), /nbformat/);
  assert.throws(() => parseNotebook('{"nbformat":4}'), /cells/);
  assert.throws(() => parseNotebook('[]'), /top level/);
});

test('applyCellOutput: streams + image, increments execution_count, does not mutate', () => {
  const nb = {
    nbformat: 4,
    cells: [{
      cell_type: 'code', source: ['print(1)'], metadata: {}, outputs: [], execution_count: 2,
    }],
  };
  const next = applyCellOutput(nb, 0, {
    stdout: 'hello\n', stderr: '', images: [{ data: 'iVBORw0=' }], exitCode: 0,
  });
  assert.equal(nb.cells[0].execution_count, 2, 'input must not be mutated');
  assert.equal(nb.cells[0].outputs.length, 0, 'input must not be mutated');
  const cell = next.cells[0];
  assert.equal(cell.execution_count, 3);
  assert.equal(cell.outputs[0].output_type, 'stream');
  assert.equal(cell.outputs[0].name, 'stdout');
  assert.equal(cell.outputs[0].text, 'hello\n');
  assert.equal(cell.outputs[1].output_type, 'display_data');
  assert.equal(cell.outputs[1].data['image/png'], 'iVBORw0=');
  assert.equal(cell.metadata.lastExitCode, 0);

  const withErr = applyCellOutput(nb, 0, { stdout: '', stderr: 'boom\n', exitCode: 1 });
  assert.equal(withErr.cells[0].outputs[0].name, 'stderr');
  assert.equal(withErr.cells[0].metadata.lastExitCode, 1);

  const withResult = applyCellOutput(nb, 0, { result: '42', exitCode: 0 });
  assert.equal(withResult.cells[0].outputs[0].output_type, 'execute_result');
  assert.equal(withResult.cells[0].outputs[0].data['text/plain'], '42');

  assert.throws(() => applyCellOutput(nb, 5, {}), /No cell at index/);
});

test('resolveProjectPath: resolves inside the project, throws on traversal', () => {
  const dataDir = path.join(os.tmpdir(), 'nm-util-test');
  const p = resolveProjectPath(dataDir, 'my-book', 'notes', 'notes.md');
  assert.equal(p, path.join(dataDir, 'projects', 'my-book', 'notes', 'notes.md'));
  assert.throws(() => resolveProjectPath(dataDir, '../escape', 'x'), /Invalid project slug/);
  assert.throws(() => resolveProjectPath(dataDir, 'My Book', 'x'), /Invalid project slug/);
  assert.throws(() => resolveProjectPath(dataDir, 'my-book', '..', '..', 'etc', 'passwd'), /escapes project/);
  assert.throws(() => resolveProjectPath(dataDir, 'my-book', 'notes', '../../secret'), /escapes project/);
});

test('extractYoutubeVideoId: watch, short, shorts, live, embed, v forms', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(extractYoutubeVideoId(`https://www.youtube.com/watch?v=${id}`), id);
  assert.equal(extractYoutubeVideoId(`https://youtube.com/watch?v=${id}&list=PL123&t=42s`), id);
  assert.equal(extractYoutubeVideoId(`https://music.youtube.com/watch?v=${id}`), id);
  assert.equal(extractYoutubeVideoId(`https://youtu.be/${id}`), id);
  assert.equal(extractYoutubeVideoId(`https://youtu.be/${id}?t=30`), id);
  assert.equal(extractYoutubeVideoId(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(extractYoutubeVideoId(`https://www.youtube.com/live/${id}`), id);
  assert.equal(extractYoutubeVideoId(`https://www.youtube.com/embed/${id}`), id);
  assert.equal(extractYoutubeVideoId(`https://www.youtube.com/v/${id}`), id);
  assert.equal(extractYoutubeVideoId(`https://www.youtube-nocookie.com/embed/${id}`), id);
  // Missing scheme is tolerated.
  assert.equal(extractYoutubeVideoId(`youtube.com/watch?v=${id}`), id);
  assert.equal(extractYoutubeVideoId(`youtu.be/${id}`), id);
});

test('extractYoutubeVideoId: rejects non-YouTube URLs and bad ids', () => {
  assert.equal(extractYoutubeVideoId('https://vimeo.com/123456789'), null);
  assert.equal(extractYoutubeVideoId('https://www.youtube.com/watch'), null);
  assert.equal(extractYoutubeVideoId('https://www.youtube.com/watch?v=short'), null);
  assert.equal(extractYoutubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=other'), 'dQw4w9WgXcQ');
  assert.equal(extractYoutubeVideoId('https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(extractYoutubeVideoId('https://www.youtube.com/playlist?list=PL123'), null);
  assert.equal(extractYoutubeVideoId('https://youtu.be/'), null);
  assert.equal(extractYoutubeVideoId(''), null);
  assert.equal(extractYoutubeVideoId(null), null);
  assert.equal(extractYoutubeVideoId('not a url'), null);
});
