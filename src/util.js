// Pure helpers for Note Mate — no I/O, no Express. Unit-tested in tests/util.test.js.
import path from 'node:path';

/** Lowercase, map every run of non-alphanumerics to a single dash, trim dashes. */
export function slugify(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

/**
 * Normalize a heading/outline title for comparison:
 * lowercase; strip leading numbering ("1.2 ", "Chapter 1:", "1 - ") and
 * trailing dots; strip punctuation; collapse whitespace.
 */
export function normalizeHeading(text) {
  let s = String(text ?? '').toLowerCase().trim();
  // Leading "chapter 1:", "appendix a -", "part 2." etc.
  s = s.replace(/^(chapter|appendix|part)\s+[a-z0-9]+(?:\.[0-9]+)?\s*[:.\-–—]?\s*/u, '');
  // Leading numbering: "1.2 ", "1.2.3 - ", "1: ", "21 "
  s = s.replace(/^\d+(?:\.\d+)*\s*[:.\-–—]?\s+/u, '');
  // Trailing dots (e.g. contents-page leaders)
  s = s.replace(/[.]+$/u, '');
  // Strip punctuation to spaces, collapse whitespace.
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Match each outline title to the best note heading.
 * Returns an array aligned with `outlineTitles`: the index of the best
 * matching heading, or null when nothing matches.
 * Priority: exact normalized match, then startsWith, then contains
 * (in either direction). Earliest heading wins ties.
 */
export function matchOutlineToHeadings(outlineTitles, noteHeadings) {
  const normalized = noteHeadings.map((h) => normalizeHeading(h));
  return outlineTitles.map((title) => {
    const o = normalizeHeading(title);
    if (!o) return null;
    let best = null;
    let bestScore = 0;
    normalized.forEach((h, i) => {
      if (!h) return;
      let score = 0;
      if (h === o) score = 3;
      else if (h.startsWith(o) || o.startsWith(h)) score = 2;
      else if (h.includes(o) || o.includes(h)) score = 1;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best;
  });
}

/** Parse notebook JSON text; throws on invalid JSON or bad structure. */
export function parseNotebook(text) {
  let nb;
  try {
    nb = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid notebook JSON: ${err.message}`);
  }
  if (!nb || typeof nb !== 'object' || Array.isArray(nb)) {
    throw new Error('Invalid notebook: top level must be an object');
  }
  if (typeof nb.nbformat !== 'number' || !Array.isArray(nb.cells)) {
    throw new Error('Invalid notebook: missing nbformat or cells array');
  }
  return nb;
}

/** The cells array of a parsed notebook. */
export function cellsOf(nb) {
  if (!nb || !Array.isArray(nb.cells)) throw new Error('Invalid notebook: missing cells array');
  return nb.cells;
}

/**
 * Return a NEW notebook object with the given cell's outputs replaced by the
 * execution result. Does not mutate the input.
 * - stdout/stderr become stream outputs
 * - `result` (when provided) becomes an execute_result with text/plain
 * - each image becomes a display_data output with image/png
 * - execution_count is incremented (from 1 when absent)
 */
export function applyCellOutput(nb, cellIndex, { stdout = '', stderr = '', images = [], result, exitCode = 0 } = {}) {
  const next = JSON.parse(JSON.stringify(nb));
  const cell = next.cells[cellIndex];
  if (!cell) throw new Error(`No cell at index ${cellIndex}`);
  const outputs = [];
  if (stdout) outputs.push({ output_type: 'stream', name: 'stdout', text: stdout });
  if (stderr) outputs.push({ output_type: 'stream', name: 'stderr', text: stderr });
  if (result !== undefined && result !== null && result !== '') {
    outputs.push({
      output_type: 'execute_result',
      execution_count: (cell.execution_count ?? 0) + 1,
      data: { 'text/plain': String(result) },
      metadata: {},
    });
  }
  for (const img of images) {
    outputs.push({
      output_type: 'display_data',
      data: { 'image/png': img.data ?? img },
      metadata: {},
    });
  }
  cell.outputs = outputs;
  cell.execution_count = (cell.execution_count ?? 0) + 1;
  cell.metadata = { ...(cell.metadata ?? {}), lastExitCode: exitCode };
  return next;
}

const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Resolve a path inside a project's directory, throwing on traversal.
 * `slug` must match /^[a-z0-9-]+$/; every part must stay under the project dir.
 */
export function resolveProjectPath(dataDir, slug, ...parts) {
  if (!SLUG_RE.test(slug)) throw new Error(`Invalid project slug: ${slug}`);
  const base = path.resolve(dataDir, 'projects', slug);
  const target = path.resolve(base, ...parts);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Path escapes project directory: ${parts.join('/')}`);
  }
  return target;
}
