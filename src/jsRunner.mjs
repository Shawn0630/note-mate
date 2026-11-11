// Run notebook cells 0..N in ONE node process with a shared scope.
//
// Usage: node jsRunner.mjs <cells.json> <results.json>
//   cells.json:   [{"source": "..."}, ...]
//   results.json: {"results": [...]}
// One result per input cell, in order:
//   {"stdout", "stderr", "exitCode", "images": [], "skipped"}
//
// Mechanism: the cells are concatenated into a single .mjs module with a
// per-cell boundary marker printed (console.log AND console.error) before
// each cell. The module runs as a child process; stdout/stderr are split
// back on the markers, so each cell's output is attributed to it. A cell
// that throws stops the run: markers for later cells never print, and
// those cells are marked skipped. The failing cell is the last one whose
// marker printed; its stderr carries the exception + stack.
//
// Caveats (documented in README):
// - Top-level `const`/`let` redeclaration across cells is a SyntaxError
//   in the concatenated module (use plain assignment or `var` for names
//   shared across cells). A syntax error is attributed to the offending
//   cell via its line number in the concatenated file.
// - `process.exit()` ends the whole run; later cells are skipped.
// - On SIGTERM/SIGINT the runner kills the child first, so a timed-out
//   run cannot orphan the user-code process.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const [cellsPath, resultsPath] = process.argv.slice(2);
const cells = JSON.parse(fs.readFileSync(cellsPath, 'utf8'));

const marker = (i) => `\u0000NM-CELL-BOUNDARY-${i}\u0000`;

// Build the concatenated module, tracking the 1-based line where each
// cell's source starts (for syntax-error attribution).
const parts = [];
const lineOffsets = []; // lineOffsets[i] = first line of cell i's source
let line = 1;
cells.forEach((cell, i) => {
  const src = typeof cell === 'object' ? (cell.source ?? '') : String(cell);
  parts.push(`console.log(${JSON.stringify(marker(i))});`);
  parts.push(`console.error(${JSON.stringify(marker(i))});`);
  line += 2;
  lineOffsets.push(line);
  parts.push(src);
  line += src.split('\n').length;
});
fs.writeFileSync('solution.mjs', parts.join('\n'), 'utf8');

const child = spawn('node', ['solution.mjs'], { cwd: process.cwd() });
const killChild = () => {
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
};
process.on('SIGTERM', () => { killChild(); process.exit(143); });
process.on('SIGINT', () => { killChild(); process.exit(130); });

let stdout = '';
let stderr = '';
const MAX_STREAM_BYTES = 10 * 1024 * 1024;
child.stdout.on('data', (d) => { if (stdout.length < MAX_STREAM_BYTES) stdout += d; });
child.stderr.on('data', (d) => { if (stderr.length < MAX_STREAM_BYTES) stderr += d; });
const exitCode = await new Promise((resolve) => child.on('close', resolve));

// Split a stream on marker lines. Text between marker i and marker i+1
// belongs to cell i (the newline terminating the marker line itself is
// not cell output). Text before the first marker is attributed to cell 0.
function splitByMarkers(text) {
  const segments = new Map();
  const re = /\u0000NM-CELL-BOUNDARY-(\d+)\u0000/g;
  let lastIdx = 0;
  let current = 0;
  let seen = false;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (seen) {
      segments.set(current, (segments.get(current) ?? '') + text.slice(lastIdx, m.index));
    } else if (m.index > 0) {
      segments.set(0, text.slice(0, m.index));
    }
    current = Number(m[1]);
    seen = true;
    lastIdx = re.lastIndex;
    if (text[lastIdx] === '\n') lastIdx += 1;
  }
  if (seen) {
    segments.set(current, (segments.get(current) ?? '') + text.slice(lastIdx));
  }
  // No markers at all → return empty: nothing ran. The caller attributes
  // a process-level failure (e.g. a syntax error) by line number instead.
  return segments;
}

// Map a `solution.mjs:LINE` in a stack trace to the cell containing it.
function cellForLine(lineNo) {
  let found = 0;
  for (let i = 0; i < lineOffsets.length; i++) {
    if (lineOffsets[i] <= lineNo) found = i;
    else break;
  }
  return found;
}

const outSegs = splitByMarkers(stdout);
const errSegs = splitByMarkers(stderr);
const results = cells.map((_, i) => {
  const ran = outSegs.has(i) || errSegs.has(i);
  if (!ran) return { stdout: '', stderr: '', exitCode: null, images: [], skipped: true };
  return {
    stdout: outSegs.get(i) ?? '',
    stderr: errSegs.get(i) ?? '',
    exitCode: 0, // corrected below for the failing cell
    images: [],
    skipped: false,
  };
});

if (exitCode !== 0) {
  const ranIdx = results.map((r, i) => (r.skipped ? -1 : i)).filter((i) => i >= 0);
  if (ranIdx.length > 0) {
    // The failing cell is the last one that started.
    results[ranIdx[ranIdx.length - 1]].exitCode = exitCode;
  } else {
    // Nothing ran: a syntax error in the concatenated module. Attribute
    // the whole stderr to the offending cell by line number.
    const m = stderr.match(/solution\.mjs:(\d+)/);
    const idx = m ? cellForLine(Number(m[1])) : 0;
    results[idx] = { stdout: '', stderr, exitCode, images: [], skipped: false };
  }
}

fs.writeFileSync(resultsPath, JSON.stringify({ results }), 'utf8');
