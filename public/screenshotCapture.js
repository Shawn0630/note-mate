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
