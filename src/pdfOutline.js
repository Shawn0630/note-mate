// Read a PDF's outline (bookmarks) with pdfjs-dist — the same source the
// reader uses client-side. Seeded and file-uploaded projects store NO
// outline in project.json (only AI import does), so the on-demand AI-note
// route falls back to this when the project has none stored.
// Returns [{title, page, depth}] in document order (flattened, children
// after their parent), page = 1-based or null when the destination cannot
// be resolved. Returns [] when the PDF has no outline.
export async function extractPdfOutline(pdfBuffer) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (err) {
    throw new Error(`pdfjs-dist could not be loaded: ${err.message}`);
  }
  let pdf;
  try {
    // pdfjs-dist v5 rejects Buffer explicitly — it wants a plain Uint8Array.
    const data = new Uint8Array(pdfBuffer);
    pdf = await pdfjs.getDocument({ data }).promise;
  } catch (err) {
    const e = new Error(`Not a readable PDF: ${err.message}`);
    e.status = 400;
    throw e;
  }
  try {
    const outline = await pdf.getOutline();
    if (!outline?.length) return [];
    const out = [];
    const walk = async (items, depth) => {
      for (const item of items ?? []) {
        const title = String(item.title || '').trim();
        let page = null;
        try {
          let dest = item.dest;
          if (typeof dest === 'string') dest = await pdf.getDestination(dest);
          if (dest && typeof dest === 'object' && !Array.isArray(dest) && dest.D) dest = dest.D;
          if (Array.isArray(dest) && dest[0]) page = (await pdf.getPageIndex(dest[0])) + 1;
        } catch { /* page stays null — best effort */ }
        if (title) out.push({ title, page, depth });
        if (Array.isArray(item.items) && item.items.length) await walk(item.items, depth + 1);
      }
    };
    await walk(outline, 0);
    return out;
  } finally {
    try { await pdf.destroy(); } catch { /* ignore */ }
  }
}
