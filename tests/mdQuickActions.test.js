import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MD_QUICK_ACTIONS, mdQuickSnippet } from '../public/mdQuickActions.js';

test('action list: 10 actions, H3 first, no ## chapter heading', () => {
  assert.equal(MD_QUICK_ACTIONS.length, 10);
  assert.equal(MD_QUICK_ACTIONS[0].id, 'h3');
  assert.ok(!MD_QUICK_ACTIONS.some((a) => a.id === 'h2'));
  assert.deepEqual(MD_QUICK_ACTIONS.map((a) => a.id),
    ['h3', 'checklist', 'bullet', 'code', 'table', 'quote', 'divider', 'link', 'date', 'anchor']);
});

test('inline prefixes insert at the cursor, cursor after', () => {
  assert.deepEqual(mdQuickSnippet('h3', '', ''), { text: '### ', selStart: 4, selEnd: 4 });
  assert.deepEqual(mdQuickSnippet('checklist', '', ''), { text: '- [ ] ', selStart: 6, selEnd: 6 });
  assert.deepEqual(mdQuickSnippet('bullet', '', ''), { text: '- ', selStart: 2, selEnd: 2 });
  assert.deepEqual(mdQuickSnippet('quote', '', ''), { text: '> ', selStart: 2, selEnd: 2 });
});

test('code block: cursor lands on the empty line inside the fence', () => {
  const s = mdQuickSnippet('code', '', '');
  assert.equal(s.text, '```\n\n```');
  assert.equal(s.text.slice(s.selStart, s.selStart + 1), '\n');
  assert.equal(s.selStart, 4);
  assert.equal(s.selStart, s.selEnd);
});

test('code block mid-text is padded with newlines so it stays a block', () => {
  const s = mdQuickSnippet('code', 'some text', 'more text');
  assert.equal(s.text, '\n```\n\n```\n');
  assert.equal(s.selStart, 5);
});

test('table: 2 columns, cursor in the first empty data cell', () => {
  const s = mdQuickSnippet('table', '', '');
  assert.equal(s.text, '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |');
  assert.equal(s.text.slice(s.selStart), ' |  |');
});

test('divider and anchor pad against surrounding text, not at file edges', () => {
  assert.deepEqual(mdQuickSnippet('divider', '', ''), { text: '---', selStart: 3, selEnd: 3 });
  assert.deepEqual(mdQuickSnippet('divider', 'a', 'b'), { text: '\n---\n', selStart: 4, selEnd: 4 });
  const anchor = '<!-- @page 55 · source: book -->';
  assert.deepEqual(mdQuickSnippet('anchor', '', '', { anchor }),
    { text: anchor, selStart: anchor.length, selEnd: anchor.length });
  assert.equal(mdQuickSnippet('anchor', 'x', 'y', { anchor }).text, `\n${anchor}\n`);
});

test('link selects the word "text" so typing replaces it', () => {
  const s = mdQuickSnippet('link', '', '');
  assert.equal(s.text, '[text](url)');
  assert.equal(s.text.slice(s.selStart, s.selEnd), 'text');
});

test('date inserts the caller-supplied date verbatim', () => {
  assert.deepEqual(mdQuickSnippet('date', '', '', { date: '2026-11-12' }),
    { text: '2026-11-12', selStart: 10, selEnd: 10 });
});

test('date and anchor without their opts throw; unknown action throws', () => {
  assert.throws(() => mdQuickSnippet('date', '', ''), /opts\.date/);
  assert.throws(() => mdQuickSnippet('anchor', '', ''), /opts\.anchor/);
  assert.throws(() => mdQuickSnippet('nope', '', ''), /unknown action/);
});
