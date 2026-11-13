import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAiCodePrompt, parseAiCodeResponse, generateAiCode,
  MAX_AI_CODE_PROMPT_CHARS, MAX_AI_CODE_CELLS_CHARS,
} from '../src/aiCode.js';

test('parseAiCodeResponse: fenced python block + one-line explanation', () => {
  const raw = '```python\nimport numpy as np\nx = np.arange(3)\n```\nBuilds an array of 0, 1, 2.';
  assert.deepEqual(parseAiCodeResponse(raw), {
    code: 'import numpy as np\nx = np.arange(3)',
    language: 'python',
    explanation: 'Builds an array of 0, 1, 2.',
  });
});

test('parseAiCodeResponse: unlabeled fence, explanation from the first line after', () => {
  const raw = '```\nplt.plot([1, 2])\n```\n\nPlots the points.\nExtra line stays out.';
  const out = parseAiCodeResponse(raw);
  assert.equal(out.code, 'plt.plot([1, 2])');
  assert.equal(out.language, 'python');
  assert.equal(out.explanation, 'Plots the points.');
});

test('parseAiCodeResponse: no code block / empty / over-long are LLM_BAD_RESPONSE', () => {
  assert.throws(() => parseAiCodeResponse('just prose, no code'), /did not return a code block/);
  assert.throws(() => parseAiCodeResponse('```python\n   \n```'), /did not return a code block/);
  assert.throws(() => parseAiCodeResponse(''), /no code/);
  assert.throws(() => parseAiCodeResponse('x'.repeat(20001)), /exceeds/);
});

test('parseAiCodeResponse: explanation is optional and capped', () => {
  const out = parseAiCodeResponse('```python\nx = 1\n```');
  assert.equal(out.code, 'x = 1');
  assert.equal(out.explanation, '');
  const long = parseAiCodeResponse(`\`\`\`python\nx = 1\n\`\`\`\n${'e'.repeat(600)}`);
  assert.equal(long.explanation.length, 500);
});

test('buildAiCodePrompt: chapter + page + reading text + notebook cells + rules', () => {
  const prompt = buildAiCodePrompt({
    bookTitle: 'Understanding Deep Learning',
    chapter: { title: 'Transformers', startPage: 221, endPage: 253 },
    sourceLabel: 'Understanding Deep Learning',
    page: 230,
    readingText: 'Attention is all you need.',
    notebookCells: 'import numpy as np',
    prompt: 'Plot the attention weights.',
  });
  assert.match(prompt, /Transformers \(pages 221–253\)/);
  assert.match(prompt, /on page 230/);
  assert.match(prompt, /Attention is all you need/);
  assert.match(prompt, /import numpy as np/);
  assert.match(prompt, /Plot the attention weights/);
  assert.match(prompt, /ONE ```python fenced code block/);
});

test('buildAiCodePrompt: deck source without a chapter names the deck + slide', () => {
  const prompt = buildAiCodePrompt({
    bookTitle: 'Understanding Deep Learning',
    chapter: null,
    sourceLabel: 'Supervised Learning',
    page: 12,
    readingText: 'Slide text.',
    notebookCells: '',
    prompt: 'Write a loss function.',
  });
  assert.match(prompt, /Supervised Learning, page 12/);
  assert.match(prompt, /Slide text/);
});

test('generateAiCode: stub returns code + explanation; no config -> 503', async () => {
  const savedStub = process.env.LLM_STUB_RESPONSE;
  const savedEnv = process.env.LLM_ENV_FILE;
  process.env.LLM_ENV_FILE = '/nonexistent/none.env';
  try {
    process.env.LLM_STUB_RESPONSE = '```python\nx = 1\n```\nSets x to 1.';
    const out = await generateAiCode({
      bookTitle: 'B', chapter: null, sourceLabel: 'B', page: 1,
      readingText: '', notebookCells: '', prompt: 'Set x to 1.',
    });
    assert.deepEqual(out, { code: 'x = 1', language: 'python', explanation: 'Sets x to 1.' });
  } finally {
    if (savedStub === undefined) delete process.env.LLM_STUB_RESPONSE; else process.env.LLM_STUB_RESPONSE = savedStub;
    if (savedEnv === undefined) delete process.env.LLM_ENV_FILE; else process.env.LLM_ENV_FILE = savedEnv;
  }
  const savedKey = process.env.LLM_API_KEY;
  const savedModel = process.env.LLM_MODEL;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_STUB_RESPONSE;
  process.env.LLM_ENV_FILE = '/nonexistent/none.env';
  try {
    await assert.rejects(
      () => generateAiCode({
        bookTitle: 'B', chapter: null, sourceLabel: 'B', page: 1,
        readingText: '', notebookCells: '', prompt: 'Set x to 1.',
      }),
      (err) => err.code === 'LLM_NOT_CONFIGURED' && err.status === 503,
    );
  } finally {
    if (savedKey !== undefined) process.env.LLM_API_KEY = savedKey;
    if (savedModel !== undefined) process.env.LLM_MODEL = savedModel;
    if (savedStub !== undefined) process.env.LLM_STUB_RESPONSE = savedStub;
    if (savedEnv === undefined) delete process.env.LLM_ENV_FILE; else process.env.LLM_ENV_FILE = savedEnv;
  }
});

test('caps: prompt and cell constants are sane (whole-notebook budget)', () => {
  assert.equal(MAX_AI_CODE_PROMPT_CHARS, 2000);
  assert.equal(MAX_AI_CODE_CELLS_CHARS, 32768);
});

test('buildAiCodePrompt: TARGET rule appears only with a pinned cell', () => {
  const base = {
    bookTitle: 'Understanding Deep Learning',
    chapter: null,
    sourceLabel: 'Understanding Deep Learning',
    page: 15,
    readingText: '',
    notebookCells: '--- cell 4 (code) · TARGET — replace this cell ---\ndef linear_function_1D(x,beta,omega):',
    prompt: 'implement the linear function',
  };
  const pinned = buildAiCodePrompt({ ...base, hasTargetCell: true });
  assert.match(pinned, /TARGET — it is the cell the user wants changed/);
  assert.match(pinned, /COMPLETE new source/);
  assert.match(pinned, /all cells, in order; code and markdown/);
  const unpinned = buildAiCodePrompt({
    ...base,
    notebookCells: '--- cell 4 (code) ---\ndef linear_function_1D(x,beta,omega):',
  });
  assert.doesNotMatch(unpinned, /TARGET/);
});
