import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampNavWidth, clampAiWidth, splitReadingNotebook, gridTemplate,
  sanitizeWidths, sanitizePanels, matchPreset, defaultPanels,
  migrateLayoutModeName,
  clampZoom, zoomStep, zoomFromWheel, zoomFromGesture, zoomPercent,
  fitScale, firstFreeName, PANE_DEFAULTS,
} from '../public/readerLayout.js';

test('clamps: nav 180–480, ai 280–560', () => {
  assert.equal(clampNavWidth(100), 180);
  assert.equal(clampNavWidth(248), 248);
  assert.equal(clampNavWidth(900), 480);
  assert.equal(clampAiWidth(100), 280);
  assert.equal(clampAiWidth(340), 340);
  assert.equal(clampAiWidth(900), 560);
});

test('splitReadingNotebook: drag clamps each side to its minimum', () => {
  // Total 1000px: reading dragged to 800 leaves notebook 200 < 300 → clamp.
  let s = splitReadingNotebook(800, 1000);
  assert.ok(Math.abs(s.readingFr - 0.7) < 1e-9);
  assert.ok(Math.abs(s.notebookFr - 0.3) < 1e-9);
  // Reading dragged to 100 leaves it < 300 → clamp to 300.
  s = splitReadingNotebook(100, 1000);
  assert.ok(Math.abs(s.readingFr - 0.3) < 1e-9);
  assert.ok(Math.abs(s.notebookFr - 0.7) < 1e-9);
  // Fractions sum to 1.
  s = splitReadingNotebook(555, 1000);
  assert.ok(Math.abs(s.readingFr + s.notebookFr - 1) < 1e-9);
  // Too-narrow total → even split.
  s = splitReadingNotebook(400, 500);
  assert.deepEqual(s, { readingFr: 0.5, notebookFr: 0.5 });
});

test('gridTemplate: 7 columns, hidden panes and dividers collapse to 0', () => {
  const notetaking = gridTemplate(
    { nav: false, reading: true, notebook: true, ai: false },
    { ...PANE_DEFAULTS },
  );
  assert.equal(notetaking, '0px 0px minmax(0, 0.5fr) 7px minmax(0, 0.5fr) 0px 0px');
  // Reading: the single reading track takes the full width (1fr — a lone
  // 0.5fr track would only take half the container, see gridTemplate).
  const reading = gridTemplate(
    { nav: false, reading: true, notebook: false, ai: false },
    { ...PANE_DEFAULTS },
  );
  assert.equal(reading, '0px 0px minmax(0, 1fr) 0px 0px 0px 0px');
  // Navigation: nav + reading alone also gives reading the full remainder.
  const navigation = gridTemplate(
    { nav: true, reading: true, notebook: false, ai: false },
    { ...PANE_DEFAULTS },
  );
  assert.equal(navigation, '248px 7px minmax(0, 1fr) 0px 0px 0px 0px');
  const ai = gridTemplate(
    { nav: false, reading: true, notebook: true, ai: true },
    { nav: 248, readingFr: 0.6, notebookFr: 0.4, ai: 340 },
  );
  assert.equal(ai, '0px 0px minmax(0, 0.6fr) 7px minmax(0, 0.4fr) 7px 340px');
  const nav = gridTemplate(
    { nav: true, reading: true, notebook: false, ai: false },
    { nav: 200, readingFr: 0.5, notebookFr: 0.5, ai: 340 },
  );
  assert.equal(nav, '200px 7px minmax(0, 1fr) 0px 0px 0px 0px');
  // Reading hidden but notebook shown: no divider between nav and notebook.
  const noRead = gridTemplate(
    { nav: true, reading: false, notebook: true, ai: false },
    { ...PANE_DEFAULTS },
  );
  assert.equal(noRead, '248px 0px 0px 0px minmax(0, 1fr) 0px 0px');
});

test('matchPreset: exact matches only, else null', () => {
  assert.equal(matchPreset({ nav: false, reading: true, notebook: false, ai: false }), 'reading');
  assert.equal(matchPreset({ nav: true, reading: true, notebook: false, ai: false }), 'navigation');
  assert.equal(matchPreset({ nav: false, reading: true, notebook: true, ai: false }), 'notetaking');
  assert.equal(matchPreset({ nav: false, reading: true, notebook: true, ai: true }), 'ai');
  assert.equal(matchPreset({ nav: true, reading: true, notebook: true, ai: false }), null);
  assert.equal(matchPreset(defaultPanels()), 'notetaking');
});

test('migrateLayoutModeName: stored focus migrates to notetaking', () => {
  assert.equal(migrateLayoutModeName('focus'), 'notetaking');
  assert.equal(migrateLayoutModeName('Focus'), 'notetaking');
  assert.equal(migrateLayoutModeName('notetaking'), 'notetaking');
  assert.equal(migrateLayoutModeName('reading'), 'reading');
  assert.equal(migrateLayoutModeName('navigation'), 'navigation');
  assert.equal(migrateLayoutModeName('ai'), 'ai');
  assert.equal(migrateLayoutModeName('custom'), null);
  assert.equal(migrateLayoutModeName('bogus'), null);
  assert.equal(migrateLayoutModeName(null), null);
});

test('sanitizeWidths / sanitizePanels: bad stored values fall back', () => {
  assert.deepEqual(sanitizeWidths(null), PANE_DEFAULTS);
  assert.deepEqual(sanitizeWidths({ nav: 5, ai: 9999, readingFr: 2, notebookFr: 2 }), {
    nav: 180, ai: 560, readingFr: 0.5, notebookFr: 0.5,
  });
  assert.deepEqual(sanitizePanels(null), defaultPanels());
  assert.deepEqual(
    sanitizePanels({ nav: true, reading: true, notebook: false, ai: true, bogus: 1 }),
    { nav: true, reading: true, notebook: false, ai: true },
  );
});

test('zoom: steps, wheel, gesture, clamps, percent', () => {
  assert.equal(zoomStep(1, 1), 1.25);
  assert.equal(zoomStep(1, -1), 0.8);
  assert.equal(zoomStep(3, 1), 3);
  assert.equal(zoomStep(0.5, -1), 0.5);
  assert.equal(zoomPercent(1.25), 125);
  assert.equal(zoomPercent(0.8), 80);
  // Wheel: negative deltaY zooms in, positive zooms out, smoothly.
  assert.ok(zoomFromWheel(1, -100) > 1 && zoomFromWheel(1, -100) < 1.3);
  assert.ok(zoomFromWheel(1, 100) < 1 && zoomFromWheel(1, 100) > 0.8);
  assert.equal(zoomFromWheel(3, -500), 3);
  assert.equal(zoomFromWheel(0.5, 500), 0.5);
  // Gesture scale is relative to the gesture start.
  assert.equal(zoomFromGesture(1, 2), 2);
  assert.equal(zoomFromGesture(1.5, 0.5), 0.75);
  assert.equal(clampZoom(NaN), 1);
});

test('fitScale: usable width over page width, clamped 0.5–2', () => {
  assert.equal(fitScale(612, 612), 1);
  assert.equal(fitScale(1224, 612), 2);
  assert.equal(fitScale(2000, 612), 2);
  assert.equal(fitScale(100, 612), 0.5);
  assert.equal(fitScale(0, 612), 0.5);
  assert.equal(fitScale(600, 0), 1);
});

test('firstFreeName: first free suffix wins', () => {
  assert.equal(firstFreeName([], 'note', '.md'), 'note.md');
  assert.equal(firstFreeName(['note.md'], 'note', '.md'), 'note-2.md');
  assert.equal(firstFreeName(['note.md', 'note-2.md'], 'note', '.md'), 'note-3.md');
  assert.equal(firstFreeName(['scratch.ipynb'], 'scratch', '.ipynb'), 'scratch-2.ipynb');
  assert.equal(firstFreeName([], '  ', '.md'), 'untitled.md');
});
