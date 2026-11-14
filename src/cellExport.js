// Export selected notebook code cells to Markdown — DETERMINISTIC, no LLM.
//
// The user picks code cells in an ipynb notebook (checkbox per cell); the
// export renders them as markdown: a `### Cell N` heading, the source as a
// fenced code block, stdout/stderr as output blocks, and plot images as
// relative `![...](assets/...)` links. Plot PNGs are saved as FILES under
// notes/assets/ (never base64 blobs in the note), named
// `<notebook>-cell-<n>-<hash8>.png` where hash8 is the first 8 hex chars of
// the SHA-256 of the PNG bytes — re-exporting unchanged content reuses the
// same file instead of duplicating it.
//
// The export is a proposal: the client shows a preview with [Insert into
// note] (appends under the current chapter's ## heading in notes.md, via
// the existing notes PUT path) and [Download .md]. Nothing is inserted
// into his notes until he presses Insert. Pure functions here; the route
// in server.js does the file writes. Unit-tested in tests/cellExport.test.js.
import crypto from 'node:crypto';

export const MAX_EXPORT_CELLS = 200;

/** Language for the fenced code block, from notebook metadata or request. */
export function fenceLanguage(notebook, fallback = 'python') {
  const lang = notebook?.metadata?.language_info?.name
    || notebook?.metadata?.kernelspec?.language
    || fallback;
  return String(lang).toLowerCase();
}

export function cellSource(cell) {
  return Array.isArray(cell?.source) ? cell.source.join('') : String(cell?.source ?? '');
}

/** SHA-256 hex of PNG bytes (base64 input). */
export function pngHash(base64) {
  return crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
}

/** Asset file name for a plot from cell `index` of `notebookBase`. */
export function assetFileName(notebookBase, index, hash) {
  const safe = String(notebookBase ?? 'notebook')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe || 'notebook'}-cell-${index + 1}-${String(hash).slice(0, 8)}.png`;
}

/** Pull image/png outputs (base64) out of a cell, in order. */
export function cellImages(cell) {
  const out = [];
  for (const o of cell?.outputs ?? []) {
    const data = o?.data?.['image/png'];
    if (!data) continue;
    out.push(typeof data === 'string' ? data : String(data));
  }
  return out;
}

/** Stream outputs of a cell: {stdout, stderr} as plain text. */
export function cellStreams(cell) {
  let stdout = '';
  let stderr = '';
  for (const o of cell?.outputs ?? []) {
    if (o?.output_type !== 'stream') continue;
    const text = Array.isArray(o.text) ? o.text.join('') : String(o.text ?? '');
    if (o.name === 'stderr') stderr += text;
    else stdout += text;
  }
  return { stdout, stderr };
}

/**
 * Render selected code cells as markdown.
 * @param {{notebook: object, name?: string, indices: number[]}} input —
 *   `name` is the notebook file name (asset names derive from it);
 *   indices are 0-based notebook cell indexes; only code cells are
 *   exported (others are skipped).
 * @returns {{markdown: string, images: {cellIndex: number, base64: string, fileName: string}[]}}
 *   `images` lists every plot in order, with the asset file name the route
 *   should write it to (content-hash deduped). The markdown references the
 *   files as `assets/<fileName>` — relative to notes/notes.md.
 */
/** Render one code cell as markdown: a `### Cell N` heading, the source
 * as a fenced block, stdout/stderr as output blocks, and plot images as
 * relative `![...](assets/...)` links. Returns {text, images}. */
export function renderCodeCellMarkdown({ cell, idx, lang, base }) {
  const images = [];
  const parts = [`### Cell ${idx + 1}`, '', `\`\`\`${lang}`, cellSource(cell).trimEnd(), '```'];
  const { stdout, stderr } = cellStreams(cell);
  if (stdout.trim()) parts.push('', '```', stdout.trimEnd(), '```');
  if (stderr.trim()) parts.push('', '**stderr:**', '', '```', stderr.trimEnd(), '```');
  for (const base64 of cellImages(cell)) {
    const hash = pngHash(base64);
    const fileName = assetFileName(base, idx, hash);
    images.push({ cellIndex: idx, base64, fileName });
    parts.push('', `![Cell ${idx + 1} plot](assets/${fileName})`);
  }
  return { text: parts.join('\n'), images };
}

export function cellsToMarkdown({ notebook, name, indices }) {
  if (!notebook || !Array.isArray(notebook.cells)) {
    const err = new Error('notebook must be a parsed notebook object with a cells array');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(indices) || indices.length === 0) {
    const err = new Error('select at least one cell to export');
    err.status = 400;
    throw err;
  }
  if (indices.length > MAX_EXPORT_CELLS) {
    const err = new Error(`at most ${MAX_EXPORT_CELLS} cells per export`);
    err.status = 400;
    throw err;
  }
  const lang = fenceLanguage(notebook);
  const base = String(name || notebook?.metadata?.exportName || 'notebook').replace(/\.ipynb$/i, '');
  const blocks = [];
  const images = [];
  for (const idx of indices) {
    const cell = notebook.cells[idx];
    if (!cell) {
      const err = new Error(`no cell at index ${idx}`);
      err.status = 400;
      throw err;
    }
    if (cell.cell_type !== 'code') continue; // markdown/raw cells are skipped
    const { text, images: cellImagesOut } = renderCodeCellMarkdown({ cell, idx, lang, base });
    images.push(...cellImagesOut);
    blocks.push(text);
  }
  if (!blocks.length) {
    const err = new Error('no code cells among the selected cells');
    err.status = 400;
    throw err;
  }
  return { markdown: blocks.join('\n\n'), images };
}

/**
 * Convert a WHOLE notebook to markdown, cells in order — the project
 * export's notebook rendering (cellsToMarkdown only covers selected code
 * cells). Markdown cells go in verbatim; code cells render like the cell
 * export; raw cells go in verbatim. A `# <title>` heading leads. An empty
 * notebook yields just the heading. Returns {markdown, images} with the
 * same assets/... references as cellsToMarkdown.
 */
export function notebookToMarkdown({ notebook, name }) {
  if (!notebook || !Array.isArray(notebook.cells)) {
    const err = new Error('notebook must be a parsed notebook object with a cells array');
    err.status = 400;
    throw err;
  }
  if (notebook.cells.length > MAX_EXPORT_CELLS) {
    const err = new Error(`at most ${MAX_EXPORT_CELLS} cells per export`);
    err.status = 400;
    throw err;
  }
  const lang = fenceLanguage(notebook);
  const base = String(name || notebook?.metadata?.exportName || 'notebook').replace(/\.ipynb$/i, '');
  const title = base || 'notebook';
  const blocks = [`# ${title}`];
  const images = [];
  notebook.cells.forEach((cell, idx) => {
    if (cell?.cell_type === 'markdown') {
      const src = cellSource(cell).trim();
      if (src) blocks.push(src);
    } else if (cell?.cell_type === 'code') {
      const { text, images: cellImagesOut } = renderCodeCellMarkdown({ cell, idx, lang, base });
      images.push(...cellImagesOut);
      blocks.push(text);
    } else if (cell?.cell_type === 'raw') {
      const src = cellSource(cell).trim();
      if (src) blocks.push(src);
    }
    // Unknown cell types are skipped, never invented.
  });
  return { markdown: `${blocks.join('\n\n')}\n`, images };
}
