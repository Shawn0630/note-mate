// Note-link entries in notes.md — the link between a note file and its
// place in the master note (user 2026-11-13: "master note anchor → note").
//
// A linked anchor is a page anchor with a note part:
//
//   <!-- @page 18 · source: book · note: my-note.md -->
//
// It lives under a `##` heading in notes.md, exactly like the bare page
// anchors "+ Note here" used to write. The note file itself holds NO
// anchor data — notes.md is the single source of truth (the note's editor
// shows an anchor control that reads/writes these entries through the
// note-links API). Several entries under different headings may point at
// the same note file (many-to-one).
//
// This module is pure (no I/O, no Express): the text transforms. The
// endpoints live in src/server.js; the frontend calls them and syncs its
// notes.md cache from the returned text.

import { normalizeHeading } from './util.js';
import { splitSections, joinSections, sectionHasContent } from './masterNotes.js';
import { formatPageAnchor, parsePageAnchors } from './pageAnchor.js';

/** All anchors in the text that carry a note part, in document order. */
export function parseNoteLinkEntries(text) {
  return parsePageAnchors(text).filter((a) => a.note);
}

/**
 * Add a linked entry under `heading` (created on demand, with
 * `headingAnchor` — the `<!-- p. N -->` chapter-start line — when given).
 * The exact line already present anywhere → no-op ({added: false}).
 * Returns {text, added}.
 */
export function addNoteLinkEntry(text, { heading, headingAnchor = null, page, sourceId, note }) {
  const line = formatPageAnchor({ page, sourceId, note });
  const base = String(text ?? '');
  if (base.includes(line)) return { text: base, added: false };
  const title = String(heading || '').trim();
  if (!title) throw new Error('heading is required');
  const lines = base.split('\n');
  // A title that normalizes to nothing ("Chapter One" — the "Chapter N"
  // prefix rule eats it whole) matches no existing heading, same as the
  // client's matchHeading: it always creates its own heading instead of
  // colliding with another empty-normalized one.
  const want = normalizeHeading(title);
  let hit = -1;
  if (want) {
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/^##\s+(.+?)\s*$/);
      if (m && normalizeHeading(m[1]) === want) { hit = i; break; }
    }
  }
  if (hit === -1) {
    const sep = base && !base.endsWith('\n') ? '\n' : '';
    const gap = base && !base.endsWith('\n\n') ? '\n' : '';
    const anchorLine = headingAnchor ? `${String(headingAnchor).trim()}\n\n` : '';
    return { text: `${base}${sep}${gap}## ${title}\n\n${anchorLine}${line}\n`, added: true };
  }
  let end = lines.length;
  for (let i = hit + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  const before = lines.slice(0, end);
  while (before.length && before[before.length - 1].trim() === '') before.pop();
  const after = lines.slice(end);
  return { text: [...before, '', line, '', ...after].join('\n'), added: true };
}

/**
 * Remove link entries for `note` (narrowed to one {page, sourceId} when
 * given). A `##` heading that LOST an entry here and is left with nothing
 * under it — no content lines, only blank lines and/or the `<!-- p. N -->`
 * chapter anchor — is dropped with its section. Headings that keep a bare
 * `@page` anchor or any other content survive (sectionHasContent counts a
 * bare anchor as content, so an old "+ Note here" slot is never pruned by
 * a cascade aimed at another note). Returns {text, removed}.
 */
export function removeNoteLinkEntries(text, note, { page = null, sourceId = null } = {}) {
  const base = String(text ?? '');
  const lines = base.split('\n');
  const anchorRe = /<!--\s*@page\s+(\d+)\s*·\s*source:\s*([^\s>]+)(?:\s*·\s*note:\s*([^\s>]+))?\s*-->/;
  const removedSections = new Set();
  const kept = [];
  // Which `##` section each kept/removed line belongs to, by raw heading
  // text (NOT the normalized form — "Chapter One" normalizes to '' and
  // would never be tracked, so the heading would survive the removal).
  let currentHeading = null;
  for (const line of lines) {
    const hm = line.match(/^##\s+(.+?)\s*$/);
    if (hm) currentHeading = hm[1].trim();
    const m = line.match(anchorRe);
    if (m && m[3] === note
      && (page == null || Number(m[1]) === Number(page))
      && (sourceId == null || m[2] === sourceId)) {
      if (currentHeading) removedSections.add(currentHeading);
      continue;
    }
    kept.push(line);
  }
  const removed = lines.length - kept.length;
  if (removed === 0) return { text: base, removed: 0 };
  let out = kept.join('\n');
  if (removedSections.size) {
    const { header, sections } = splitSections(out);
    const keptSections = sections.filter((s) => {
      if (!removedSections.has(s.heading)) return true;
      return sectionHasContent(s); // drop only when truly empty now
    });
    if (keptSections.length !== sections.length) out = joinSections(header, keptSections);
  }
  return { text: out, removed };
}

/**
 * Retarget every link entry for `from` to `to` (a rename keeping the
 * entries attached to the file). Returns {text, renamed}.
 */
export function renameNoteLinkEntries(text, from, to) {
  const base = String(text ?? '');
  const anchors = parsePageAnchors(base).filter((a) => a.note === from);
  if (!anchors.length) return { text: base, renamed: 0 };
  let out = base;
  for (const a of [...anchors].reverse()) {
    const end = out.indexOf('-->', a.index) + 3;
    const comment = out.slice(a.index, end);
    out = out.slice(0, a.index) + comment.replace(`· note: ${from}`, `· note: ${to}`) + out.slice(end);
  }
  return { text: out, renamed: anchors.length };
}
