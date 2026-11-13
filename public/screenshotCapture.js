/* Screenshot button helpers for the markdown editor (right pane).
   Pure functions — no DOM — so they are unit-testable in node.
   - resolveScreenshotTarget({kind, leftTab, pdfPage, deckPage,
     hasPdfContainer, hasDeckContainer}): which rendered page canvas a
     Screenshot capture would use. The capture must use the canvas the
     reader already rendered (never re-render or re-fetch), so the target
     is only the page currently visible in the left pane: the book PDF on
     the PDF tab, a deck slide on the Slides tab. Anything else — video,
     YouTube, a Google Slides iframe, the Markdown preview tab, a page
     whose canvas has not rendered yet — has no canvas to capture and
     resolves to { error: 'no-canvas' }; the caller shows a status hint
     instead of uploading anything (never a blank image).
   - pageCanvasSelector(page): the selector for a page's canvas inside its
     viewer container (.pdf-page holders carry data-page; the canvas is
     inserted inside the holder by mountPdfViewer). */

export function resolveScreenshotTarget({ kind, leftTab, pdfPage, deckPage, hasPdfContainer, hasDeckContainer }) {
  if (String(kind || '').toLowerCase() !== 'pdf') return { error: 'no-canvas' };
  if (leftTab === 'pdf') {
    if (!hasPdfContainer) return { error: 'no-canvas' };
    return { container: 'pdf', page: pdfPage };
  }
  if (leftTab === 'slides') {
    if (!hasDeckContainer) return { error: 'no-canvas' };
    return { container: 'deck', page: deckPage };
  }
  return { error: 'no-canvas' };
}

export function pageCanvasSelector(page) {
  return `.pdf-page[data-page="${page}"] canvas`;
}

/** The page holder (not just the canvas): its `data-render-done` flag says
    pdf.js has finished painting the canvas. */
export function pageHolderSelector(page) {
  return `.pdf-page[data-page="${page}"]`;
}

/* Region-select capture (macOS-style drag-to-select): pure geometry, so
   it is unit-testable in node. The selection rect and the canvas rect
   are both in viewport (CSS) coordinates; the canvas itself is
   canvasWidth × canvasHeight device pixels. */

/** A drag shorter than this in both dimensions is a click, not a
    selection — Esc-equivalent, cancels silently. */
export const REGION_CLICK_PX = 4;

/** A cropped region smaller than this in either canvas dimension is too
    small to be useful — status hint, nothing uploaded. */
export const REGION_MIN_CANVAS_PX = 4;

/** Normalize a drag (start/end in either order) to { x, y, width, height }. */
export function normalizeSelectionRect(x0, y0, x1, y1) {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

/** True when the drag is really a click (below the threshold in both
    dimensions) — cancel, upload nothing. */
export function isClickSelection(sel) {
  return sel.width < REGION_CLICK_PX && sel.height < REGION_CLICK_PX;
}

/* Map a viewport selection rect onto canvas pixels: intersect with the
   canvas rect first (only the overlapping part is captured), then scale
   to device pixels. Returns { sx, sy, sw, sh } in canvas pixels, or
   { error: 'outside' } when the selection does not touch the canvas at
   all, { error: 'too-small' } when the overlap is below
   REGION_MIN_CANVAS_PX in either dimension. */
export function cropRegionToCanvas({ canvasRect, canvasWidth, canvasHeight, sel }) {
  if (!canvasRect || !canvasRect.width || !canvasRect.height || !canvasWidth || !canvasHeight) {
    return { error: 'outside' };
  }
  const scaleX = canvasWidth / canvasRect.width;
  const scaleY = canvasHeight / canvasRect.height;
  const x0 = Math.max(sel.x, canvasRect.x);
  const y0 = Math.max(sel.y, canvasRect.y);
  const x1 = Math.min(sel.x + sel.width, canvasRect.x + canvasRect.width);
  const y1 = Math.min(sel.y + sel.height, canvasRect.y + canvasRect.height);
  if (x1 <= x0 || y1 <= y0) return { error: 'outside' };
  const sx = Math.round((x0 - canvasRect.x) * scaleX);
  const sy = Math.round((y0 - canvasRect.y) * scaleY);
  const sw = Math.round((x1 - x0) * scaleX);
  const sh = Math.round((y1 - y0) * scaleY);
  if (sw < REGION_MIN_CANVAS_PX || sh < REGION_MIN_CANVAS_PX) return { error: 'too-small' };
  return { sx, sy, sw, sh };
}
