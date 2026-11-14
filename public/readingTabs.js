/* Reader left tabs: which tab the reader opens on, and when the tabbed
   reading pane (PDF | Slides | Video | Markdown preview) renders at all.
   Pure functions — no DOM — so they are unit-testable in node.

   The tabbed pane is the reader for PDF projects AND for projects with
   no readable main source at all (a title-only project whose materials
   are videos + notebooks): the PDF panel then shows the "no reader yet"
   note, and the Video tab is how the course is watched. Single-source
   video / slides / ppt projects render their source directly instead,
   so they have no tabbed pane. */

export const LEFT_TABS = ['pdf', 'slides', 'preview', 'video'];

/** True when the project's kind gets the tabbed reading pane. */
export function hasTabbedPaneForKind(kind) {
  const k = String(kind || '').toLowerCase();
  return k !== 'video' && k !== 'slides' && k !== 'ppt';
}

/** The tab the reader opens on, for a project shown in the tabbed pane:
    'pdf' for PDF projects (unchanged); 'video' when a project with no
    PDF main source has videos; 'preview' when it has neither. */
export function defaultLeftTab(kind, hasVideos) {
  const k = String(kind || '').toLowerCase();
  if (k === 'pdf') return 'pdf';
  if (hasVideos) return 'video';
  return 'preview';
}

/** The video material to show: the requested one when it still exists,
    else the first remaining video, else null. A video may have been
    deleted from Manage while the reader still names it (a stored
    position, or the tab it was on) — the reader falls back instead of
    showing nothing. */
export function resolveVideoId(requestedId, videoIds) {
  const ids = (videoIds || []).map((id) => String(id));
  if (requestedId != null && ids.includes(String(requestedId))) return String(requestedId);
  return ids[0] ?? null;
}
