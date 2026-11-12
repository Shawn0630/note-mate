// Single master markdown — the notes model after the 2026-11-11 reversal.
//
// The user adds notes freely while reading; the app files each note by the
// PAGE he was on and aggregates everything into ONE master file,
// `notes.md`, shown in the right pane. No per-chapter files, no
// app-maintained index, no pre-written skeleton headings: a chapter's `##`
// heading is created on demand the first time a note lands under it.
//
// This module is pure (no I/O, no Express): splitting a master into
// sections, dropping empty skeleton sections, stripping the generated
// `### Labs` blocks the old per-chapter model left behind, and folding
// per-chapter files back into one master (the revert migration). The
// I/O half lives in src/server.js (migrateNotesToMaster). Unit-tested in
// tests/masterNotes.test.js.

export const CHAPTER_FILE_RE = /^chapter-(\d+)-(.+)\.md$/i;
export const LABS_START = '<!-- labs:start -->';
export const LABS_END = '<!-- labs:end -->';
export const INDEX_FILE = 'index.md';
export const LEGACY_NOTES_FILE = 'notes.md';
export const MIGRATED_BACKUP_FILE = 'notes.md.migrated';
export const CHAPTER_BACKUP_DIR = '.chapter-backup';

/** `chapter-02-supervised-learning.md` -> 2, anything else -> null. */
export function chapterFileNumber(name) {
  const m = String(name ?? '').match(CHAPTER_FILE_RE);
  return m ? Number(m[1]) : null;
}

export function isChapterFile(name) {
  return CHAPTER_FILE_RE.test(String(name ?? ''));
}

/**
 * Split markdown into a header (lines before the first `##` heading) and
 * one section per `##` heading. A section keeps its exact raw lines
 * (heading line through the line before the next `##`), so dropping a
 * section removes exactly its bytes and keeping one preserves them.
 * Returns `{header, sections: [{heading, anchorPage, lines}]}` where
 * `anchorPage` is the `<!-- p. N -->` page under the heading, or null.
 */
export function splitSections(text) {
  const lines = String(text ?? '').split('\n');
  let firstHeading = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { firstHeading = i; break; }
  }
  const header = lines.slice(0, firstHeading).join('\n');
  const sections = [];
  let i = firstHeading;
  while (i < lines.length) {
    const start = i;
    i += 1;
    while (i < lines.length && !/^##\s+/.test(lines[i])) i += 1;
    const sectionLines = lines.slice(start, i);
    const anchor = sectionLines.join('\n').match(/<!--\s*p\.\s*(\d+)\s*-->/);
    sections.push({
      heading: sectionLines[0].replace(/^##\s+/, '').trim(),
      anchorPage: anchor ? Number(anchor[1]) : null,
      lines: sectionLines,
    });
  }
  return { header, sections };
}

/**
 * A section "has content" when any line past its heading is neither blank
 * nor an HTML comment — EXCEPT a `<!-- @page ... -->` note anchor, which
 * IS content: it is a note the user added with "+ Note here", even before
 * he types any text after it. The seeded skeleton sections hold only a
 * `<!-- p. N -->` chapter anchor, which never counts. (A bare `@page`
 * anchor must survive the prune-on-load, or a note added just before a
 * reload would silently vanish with its on-demand heading.)
 */
export function sectionHasContent(section) {
  return section.lines.slice(1).some((line) => {
    const t = line.trim();
    if (t === '') return false;
    if (/^<!--\s*@page\b/.test(t)) return true;
    return !/^<!--[\s\S]*-->$/.test(t);
  });
}

/**
 * Join a header + sections back into markdown. Sections keep their exact
 * lines; the joiner adds nothing between them (each section's raw lines
 * already end with the blank line that separates it from the next).
 */
export function joinSections(header, sections) {
  const parts = header ? [header] : [];
  for (const s of sections) parts.push(s.lines.join('\n'));
  return parts.join('\n');
}

/**
 * Drop skeleton sections with no user content (headings are created on
 * demand now, so an empty pre-written heading is noise). Byte-preserving
 * for everything kept; idempotent (a second run finds nothing to drop).
 */
export function dropEmptySections(text) {
  const { header, sections } = splitSections(text);
  const kept = sections.filter(sectionHasContent);
  if (kept.length === sections.length) return String(text ?? '');
  return joinSections(header, kept);
}

/**
 * Strip the generated `### Labs` block (`<!-- labs:start -->` …
 * `<!-- labs:end -->`, inclusive) the old per-chapter model wrote into
 * chapter files, plus the single blank line that separated it from the
 * user content above it, so no double blank is left behind. User content
 * lines are untouched. Returns the cleaned text.
 */
export function stripLabsBlock(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((l) => l.includes(LABS_START));
  if (start === -1) return String(text ?? '');
  let end = lines.findIndex((l, i) => i > start && l.includes(LABS_END));
  if (end === -1) end = lines.length - 1;
  const before = lines.slice(0, start);
  // The block was separated from the content above by one blank line;
  // drop that blank line with the block so the section does not end on
  // two blank lines. (When the block is at the very top, drop the blank
  // line after it instead.)
  if (before.length && before[before.length - 1].trim() === '') before.pop();
  let after = lines.slice(end + 1);
  if (!before.length || before[before.length - 1].trim() !== '') {
    while (after.length && after[0].trim() === '') after = after.slice(1);
  }
  return [...before, ...after].join('\n');
}

/**
 * Fold per-chapter files back into one master. `header` is the master's
 * header text (title + byline, from the legacy notes.md or the project).
 * `files` is [{name, content}] — sorted by chapter number (filename NN,
 * else the heading's leading number, else file order). Each file
 * contributes its `##` heading + page anchor + user content (Labs block
 * stripped); a file with no user content contributes nothing, so empty
 * skeleton chapters vanish. The folded master is the original content
 * minus Labs blocks and empty skeleton headings.
 */
export function foldChapterFiles(header, files) {
  const sorted = [...(files ?? [])].sort((a, b) => {
    const na = chapterFileNumber(a.name);
    const nb = chapterFileNumber(b.name);
    if (na != null && nb != null && na !== nb) return na - nb;
    return 0; // stable sort keeps the caller's order otherwise
  });
  const sections = [];
  for (const f of sorted) {
    const cleaned = stripLabsBlock(f.content);
    const { sections: parts } = splitSections(cleaned);
    for (const s of parts) {
      if (sectionHasContent(s)) sections.push(s);
    }
  }
  const head = String(header ?? '').replace(/\n+$/, '');
  const parts = head ? [head] : [];
  // Each section's raw lines end on the blank line that separated it from
  // the next section; trim that so the '\n\n' join below yields exactly
  // one blank line between sections (and one trailing newline overall).
  for (const s of sections) parts.push(s.lines.join('\n').replace(/\n+$/, ''));
  return parts.join('\n\n') + (parts.length ? '\n' : '');
}
