/* Open tabs: which owned notes are on the right pane's tab bar.
   Pure functions — no DOM — so they are unit-testable in node.
   The set is one localStorage entry per project slug:
     JSON array of note names (notes.md never has a tab, so it is never
     stored). A stored name that no longer exists is dropped; when
     nothing is stored (first run) every editable note starts open, so
     opening a project looks exactly as it did before tabs could hide.
   Hiding a tab only hides it — the file stays on disk and re-opens
   from the Files directory.

   Work tabs (v1.2): the same entry also carries the lab and section
   notebook tabs, plus which tab was active — labs and section
   notebooks open as tabs exactly like owned notes, so a refresh must
   bring them back too. The stored shape is
     { notes: [name], labs: [{chapter, name}],
       sections: [{sectionId, name}], active: {kind, ...} | null }
   `active` is {kind:'note', name} | {kind:'lab', chapter, name} |
   {kind:'section', sectionId, name}. An old store (a bare JSON array
   of note names) still restores as notes-only, active null. */
export const OPEN_TABS_KEY_PREFIX = 'nm-open-tabs:';

export function openTabsKey(slug) {
  return `${OPEN_TABS_KEY_PREFIX}${slug}`;
}

/* Restore the open set from a stored value (JSON string, or an
   already-parsed array) against the notes that exist now. Anything
   malformed, wrong-typed or stale falls back to all of them — a
   corrupt entry must never hide a file. `notes` are the {name} entries
   from GET /notes; notes.md is excluded (it never has a tab). */
export function restoreOpenTabs(raw, notes) {
  const existing = (Array.isArray(notes) ? notes : [])
    .map((n) => (typeof n === 'string' ? n : n?.name))
    .filter((name) => typeof name === 'string' && name && name !== 'notes.md');
  let stored = raw;
  if (typeof raw === 'string') {
    try {
      stored = JSON.parse(raw);
    } catch {
      return new Set(existing);
    }
  }
  if (!Array.isArray(stored)) return new Set(existing);
  const wanted = new Set(stored.filter((name) => typeof name === 'string'));
  const open = new Set(existing.filter((name) => wanted.has(name)));
  // An empty stored array is a real choice (he closed every tab), not
  // corruption — keep it empty.
  return open;
}

/* Serialize the open set for storage (sorted, for a stable value). */
export function serializeOpenTabs(open) {
  return JSON.stringify([...(open || [])].sort());
}

/* A lab tab reference, validated against the labs that exist now
   (the [{chapter, files: [{name}]}] shape of GET .../labs). */
function cleanLabTab(tab, labs) {
  if (!tab || typeof tab !== 'object') return null;
  const chapter = typeof tab.chapter === 'string' ? tab.chapter : null;
  const name = typeof tab.name === 'string' ? tab.name : null;
  if (!chapter || !name) return null;
  const group = (Array.isArray(labs) ? labs : []).find((g) => g && g.chapter === chapter);
  const files = Array.isArray(group?.files) ? group.files : [];
  if (!files.some((f) => (typeof f === 'string' ? f : f?.name) === name)) return null;
  return { chapter, name };
}

/* A section tab reference, validated against the sections that exist
   now (project.json `sections[]` with notebooks [{name}]). */
function cleanSectionTab(tab, sections) {
  if (!tab || typeof tab !== 'object') return null;
  const sectionId = typeof tab.sectionId === 'string' ? tab.sectionId : null;
  const name = typeof tab.name === 'string' ? tab.name : null;
  if (!sectionId || !name) return null;
  const section = (Array.isArray(sections) ? sections : []).find((s) => s && s.id === sectionId);
  const notebooks = Array.isArray(section?.notebooks) ? section.notebooks : [];
  if (!notebooks.some((n) => (typeof n === 'string' ? n : n?.name) === name)) return null;
  return { sectionId, name };
}

/* The active tab, validated against the tabs that were restored —
   it must name one of them, or it is dropped (a closed file is never
   re-opened behind his back). `labs`/`sections` are the restored tab
   arrays ([{chapter, name}] / [{sectionId, name}]). */
function cleanActiveTab(active, { notes, labs, sections }) {
  if (!active || typeof active !== 'object') return null;
  if (active.kind === 'note' && typeof active.name === 'string' && notes.has(active.name)) {
    return { kind: 'note', name: active.name };
  }
  if (active.kind === 'lab' && typeof active.chapter === 'string' && typeof active.name === 'string'
    && (labs || []).some((t) => t.chapter === active.chapter && t.name === active.name)) {
    return { kind: 'lab', chapter: active.chapter, name: active.name };
  }
  if (active.kind === 'section' && typeof active.sectionId === 'string' && typeof active.name === 'string'
    && (sections || []).some((t) => t.sectionId === active.sectionId && t.name === active.name)) {
    return { kind: 'section', sectionId: active.sectionId, name: active.name };
  }
  return null;
}

/* Restore the whole working set — owned notes, lab tabs, section tabs,
   and the active tab — from a stored value against what exists now.
   `available` is {notes, labs, sections} in the shapes above. An old
   bare-array store restores as notes-only (see restoreOpenTabs).
   Anything malformed falls back the same way as restoreOpenTabs:
   every editable note open, no lab/section tabs, no active tab. */
export function restoreWorkTabs(raw, available = {}) {
  let stored = raw;
  if (typeof raw === 'string') {
    try {
      stored = JSON.parse(raw);
    } catch {
      return { notes: restoreOpenTabs(raw, available.notes), labs: [], sections: [], active: null };
    }
  }
  // Bare-array store (or malformed): notes-only, as before.
  if (Array.isArray(stored)) {
    return { notes: restoreOpenTabs(stored, available.notes), labs: [], sections: [], active: null };
  }
  if (!stored || typeof stored !== 'object') {
    return { notes: restoreOpenTabs(raw, available.notes), labs: [], sections: [], active: null };
  }
  const notes = restoreOpenTabs(stored.notes, available.notes);
  const labs = (Array.isArray(stored.labs) ? stored.labs : [])
    .map((t) => cleanLabTab(t, available.labs))
    .filter(Boolean);
  const sections = (Array.isArray(stored.sections) ? stored.sections : [])
    .map((t) => cleanSectionTab(t, available.sections))
    .filter(Boolean);
  const active = cleanActiveTab(stored.active, { notes, labs, sections });
  return { notes, labs, sections, active };
}

/* Serialize the working set for storage (sorted, for a stable value).
   `notes` is a Set of names; `labs`/`sections` are tab arrays;
   `active` is the active-tab reference or null. */
export function serializeWorkTabs({ notes, labs, sections, active } = {}) {
  const cleanLabs = (Array.isArray(labs) ? labs : [])
    .filter((t) => t && typeof t.chapter === 'string' && typeof t.name === 'string')
    .map((t) => ({ chapter: t.chapter, name: t.name }))
    .sort((a, b) => (a.chapter === b.chapter
      ? a.name.localeCompare(b.name) : a.chapter.localeCompare(b.chapter)));
  const cleanSections = (Array.isArray(sections) ? sections : [])
    .filter((t) => t && typeof t.sectionId === 'string' && typeof t.name === 'string')
    .map((t) => ({ sectionId: t.sectionId, name: t.name }))
    .sort((a, b) => (a.sectionId === b.sectionId
      ? a.name.localeCompare(b.name) : a.sectionId.localeCompare(b.sectionId)));
  const cleanActive = active && typeof active === 'object' && typeof active.kind === 'string'
    ? active : null;
  return JSON.stringify({
    notes: [...(notes || [])].sort(),
    labs: cleanLabs,
    sections: cleanSections,
    active: cleanActive,
  });
}
