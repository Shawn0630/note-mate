/* Open tabs: which owned notes are on the right pane's tab bar.
   Pure functions — no DOM — so they are unit-testable in node.
   The set is one localStorage entry per project slug:
     JSON array of note names (notes.md never has a tab, so it is never
     stored). A stored name that no longer exists is dropped; when
     nothing is stored (first run) every editable note starts open, so
     opening a project looks exactly as it did before tabs could hide.
   Hiding a tab only hides it — the file stays on disk and re-opens
   from the Files directory. */
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
