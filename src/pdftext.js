// Extract text from a PDF buffer with pdfjs-dist (legacy build, Node).
// Used by the AI import flow to feed the LLM extracted text — never the
// raw PDF bytes. Caps extraction at the first MAX_PAGES pages so a
// 400-page book does not blow up the prompt (or the bill).
import fsp from 'node:fs/promises';

export const MAX_PAGES = 40;

/**
 * Extract text per page from a PDF buffer.
 * @param {Buffer|Uint8Array} buffer PDF bytes.
 * @param {{maxPages?: number, startPage?: number, endPage?: number}} [opts]
 *   `startPage`/`endPage` (1-based, inclusive) select a window of the
 *   document — used for chapter context; `maxPages` caps how many pages
 *   are read from the window (default 40). Defaults extract from page 1.
 * @returns {Promise<{pages: {page: number, text: string}[], text: string, numPages: number}>}
 *   `text` is the pages joined with a per-page marker (`\n--- page N ---\n`)
 *   so the LLM can cite page numbers that actually exist.
 * @throws {Error} with `status = 400` when the bytes are not a readable PDF.
 */
export async function extractPdfText(buffer, { maxPages = MAX_PAGES, startPage = 1, endPage = Infinity } = {}) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (err) {
    throw new Error(`pdfjs-dist could not be loaded: ${err.message}`);
  }
  let pdf;
  try {
    // pdfjs-dist v5 rejects Buffer explicitly — it wants a plain Uint8Array.
    // `new Uint8Array(buffer)` copies Buffer bytes into a plain Uint8Array.
    const data = new Uint8Array(buffer);
    pdf = await pdfjs.getDocument({ data }).promise;
  } catch (err) {
    const e = new Error(`Not a readable PDF: ${err.message}`);
    e.status = 400;
    throw e;
  }
  try {
    const numPages = pdf.numPages;
    const pages = [];
    const first = Math.max(1, Math.floor(startPage) || 1);
    const last = Math.min(numPages, Math.floor(endPage) || numPages, first + Math.max(0, maxPages) - 1);
    for (let n = first; n <= last; n++) {
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => it.str ?? '').join(' ').replace(/\s+/g, ' ').trim();
      pages.push({ page: n, text });
    }
    const text = pages.map((p) => `--- page ${p.page} ---\n${p.text}`).join('\n');
    return { pages, text, numPages };
  } catch (err) {
    const e = new Error(`Could not extract text from PDF: ${err.message}`);
    e.status = 400;
    throw e;
  } finally {
    try { await pdf.destroy(); } catch { /* already gone */ }
  }
}

/** Convenience: extract text from a PDF file on disk. */
export async function extractPdfFileText(filePath, opts) {
  const buf = await fsp.readFile(filePath);
  return extractPdfText(buf, opts);
}
