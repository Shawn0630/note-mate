import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  imageMarkdownRef, appendImageEdit, embedAssetsInMarkdown,
} from '../public/pasteImage.js';

const REF = '![screenshot](assets/pasted-abc12345.png)';

test('imageMarkdownRef: relative assets/ reference', () => {
  assert.equal(imageMarkdownRef('pasted-abc12345.png'), REF);
});

test('appendImageEdit: empty note gets just the reference', () => {
  assert.deepEqual(appendImageEdit('', REF), { start: 0, end: 0, text: `${REF}\n` });
  assert.deepEqual(appendImageEdit('  \n\n', REF), { start: 0, end: 0, text: `${REF}\n` });
});

test('appendImageEdit: no trailing newline gets a blank line before the reference', () => {
  assert.deepEqual(appendImageEdit('# Note\n\nhello', REF),
    { start: 13, end: 13, text: `\n\n${REF}\n` });
});

test('appendImageEdit: trailing blank lines collapse into the one blank line', () => {
  assert.deepEqual(appendImageEdit('# Note\n\nhello\n\n\n', REF),
    { start: 13, end: 16, text: `\n\n${REF}\n` });
});

const PNG_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const JPG_DATA = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

test('embedAssetsInMarkdown: local refs embed as data URIs, each file fetched once', async () => {
  const seen = [];
  const fetchAsset = async (file) => { seen.push(file); return file.endsWith('.png') ? PNG_DATA : JPG_DATA; };
  const text = `# N\n\n![a](assets/pasted-aa11.png) and ![b](assets/pasted-bb22.jpg)\n\nagain ![a](assets/pasted-aa11.png)\n`;
  const out = await embedAssetsInMarkdown(text, fetchAsset);
  assert.deepEqual(seen, ['pasted-aa11.png', 'pasted-bb22.jpg']);
  assert.equal(out.includes('](assets/'), false);
  assert.equal(out.includes(PNG_DATA), true);
  assert.equal(out.includes(JPG_DATA), true);
  assert.equal(out.split(PNG_DATA).length - 1, 2); // both occurrences embedded
});

test('embedAssetsInMarkdown: external URLs and data URIs stay as-is, no fetch', async () => {
  let calls = 0;
  const fetchAsset = async () => { calls += 1; return PNG_DATA; };
  const text = '![web](https://example.com/x.png)\n![in](data:image/png;base64,AAAA)\n';
  assert.equal(await embedAssetsInMarkdown(text, fetchAsset), text);
  assert.equal(calls, 0);
});

test('embedAssetsInMarkdown: un-fetchable file keeps its original reference', async () => {
  const fetchAsset = async (file) => (file === 'pasted-ok.png' ? PNG_DATA : null);
  const text = '![ok](assets/pasted-ok.png)\n![gone](assets/pasted-nope.png)\n';
  const out = await embedAssetsInMarkdown(text, fetchAsset);
  assert.equal(out.includes(PNG_DATA), true);
  assert.equal(out.includes('![gone](assets/pasted-nope.png)'), true);
});

test('embedAssetsInMarkdown: no refs returns the text unchanged', async () => {
  let calls = 0;
  const fetchAsset = async () => { calls += 1; return PNG_DATA; };
  assert.equal(await embedAssetsInMarkdown('# plain\n', fetchAsset), '# plain\n');
  assert.equal(calls, 0);
});

test('embedAssetsInMarkdown: traversal-looking refs are not treated as local assets', async () => {
  let calls = 0;
  const fetchAsset = async () => { calls += 1; return PNG_DATA; };
  const text = '![x](assets/../secret.png)\n![y](assets/%2e%2e/secret.png)\n';
  assert.equal(await embedAssetsInMarkdown(text, fetchAsset), text);
  assert.equal(calls, 0);
});
