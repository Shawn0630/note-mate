// Pure helpers for Code AI cell targeting — no DOM, no imports.
// The client sends the WHOLE notebook as context (code + markdown cells,
// in order) with the pinned cell marked TARGET, and Apply replaces that
// cell in place. The server caps the joined text at the same budget
// (MAX_AI_CODE_CELLS_CHARS in src/aiCode.js).

export const AI_CODE_CONTEXT_CHARS = 32768;

/** Notebook cell source as a plain string (nbformat string or string[]). */
export function cellSourceText(cell) {
  const src = cell?.source;
  return Array.isArray(src) ? src.join('') : String(src ?? '');
}

/** First non-empty line of a cell's source, trimmed, capped at 80 chars.
 * For code cells, leading comment-only lines are skipped so the label is
 * the first real code line (e.g. the `def` line); a comment-only cell
 * falls back to its first comment. */
export function firstCodeLine(cell) {
  const lines = cellSourceText(cell).split('\n');
  const first = lines.find((l) => l.trim()) || '';
  if (cell?.cell_type === 'markdown') {
    const trimmed = first.trim();
    return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  }
  const codeLine = lines.find((l) => {
    const t = l.trim();
    return t && !t.startsWith('#');
  }) || first;
  const trimmed = codeLine.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

/** Label for the target chip / panel: the cell's first code line. */
export function targetCellLabel(cell) {
  return firstCodeLine(cell) || '(empty cell)';
}

/** Fingerprint for the Apply-time match check: the cell's first line. */
export function targetCellFingerprint(cell) {
  return firstCodeLine(cell);
}

/**
 * Format a notebook's cells as Code AI context strings, in notebook order.
 * Every cell gets a header line; the pinned cell (targetIndex) is marked
 * TARGET. The whole notebook is included when it fits the budget; when it
 * does not, cells are dropped from the end — except the target, which is
 * always kept. Returns { parts: string[], truncated: boolean }.
 */
export function formatNotebookCellsForCodeAi(cells, targetIndex, maxChars = AI_CODE_CONTEXT_CHARS) {
  const list = Array.isArray(cells) ? cells : [];
  const parts = [];
  let used = 0;
  let truncated = false;
  const format = (cell, idx) => {
    const kind = cell?.cell_type === 'markdown' ? 'markdown' : 'code';
    const marker = idx === targetIndex ? ' · TARGET — replace this cell' : '';
    return `--- cell ${idx} (${kind})${marker} ---\n${cellSourceText(cell)}`;
  };
  // First pass: cells in order until the budget runs out (the target is
  // always kept, even if it pushes slightly over).
  for (let i = 0; i < list.length; i++) {
    const part = format(list[i], i);
    if (i !== targetIndex && used + part.length > maxChars) {
      truncated = true;
      continue;
    }
    parts.push(part);
    used += part.length;
  }
  // The target must be present and in position: if it was skipped above
  // (it cannot be — the budget check exempts it), nothing to fix. If the
  // target index is out of range there is simply no TARGET marker.
  if (truncated) parts.push('[notebook context truncated]');
  return { parts, truncated };
}
