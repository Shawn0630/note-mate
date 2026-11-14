// Reader left tabs: the tabbed pane gating + the default tab a project
// opens on (see public/readingTabs.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasTabbedPaneForKind, defaultLeftTab, resolveVideoId } from '../public/readingTabs.js';

test('hasTabbedPaneForKind: pdf + sourceless/unknown kinds get tabs; single-source kinds do not', () => {
  assert.equal(hasTabbedPaneForKind('pdf'), true);
  assert.equal(hasTabbedPaneForKind(null), true);
  assert.equal(hasTabbedPaneForKind(''), true);
  assert.equal(hasTabbedPaneForKind(undefined), true);
  assert.equal(hasTabbedPaneForKind('weird'), true);
  assert.equal(hasTabbedPaneForKind('PDF'), true);
  assert.equal(hasTabbedPaneForKind('video'), false);
  assert.equal(hasTabbedPaneForKind('slides'), false);
  assert.equal(hasTabbedPaneForKind('ppt'), false);
  assert.equal(hasTabbedPaneForKind('Video'), false);
});

test('defaultLeftTab: pdf projects keep pdf; sourceless opens on video when it has any, else preview', () => {
  assert.equal(defaultLeftTab('pdf', true), 'pdf');
  assert.equal(defaultLeftTab('pdf', false), 'pdf');
  assert.equal(defaultLeftTab(null, true), 'video');
  assert.equal(defaultLeftTab('', true), 'video');
  assert.equal(defaultLeftTab(null, false), 'preview');
  assert.equal(defaultLeftTab('', false), 'preview');
  assert.equal(defaultLeftTab('weird', true), 'video');
  assert.equal(defaultLeftTab('weird', false), 'preview');
});

test('resolveVideoId: requested video when it exists; first remaining when deleted; null when none', () => {
  assert.equal(resolveVideoId('lecture-1', ['lecture-1', 'lecture-2']), 'lecture-1');
  // lecture-1 was deleted from Manage while the reader still named it.
  assert.equal(resolveVideoId('lecture-1', ['lecture-2']), 'lecture-2');
  assert.equal(resolveVideoId(null, ['lecture-2']), 'lecture-2');
  assert.equal(resolveVideoId(undefined, ['lecture-2']), 'lecture-2');
  assert.equal(resolveVideoId('lecture-1', []), null);
  assert.equal(resolveVideoId(null, []), null);
  assert.equal(resolveVideoId('lecture-1', null), null);
});
