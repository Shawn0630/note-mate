/* Notebook undo — pure helpers, unit-testable in node.
   One shared undo stack per open .ipynb notebook (LIFO, cap 20,
   in-memory, session-only — a page reload clears it). It covers every
   notebook mutation EXCEPT runs (Run / Run all above / Run all change
   outputs and execution_count, but are not undoable steps):
   - edit: typing in a cell (one step per edit session, never per keystroke);
   - add / delete: cell added or removed;
   - replace / append: a Code AI Apply (pinned in-place replace, or an
     appended cell). Undoing an Apply also restores the proposal card.
   Entries hold the CELL OBJECT (identity), not an index — indexes shift
   when cells are added or deleted between the mutation and the undo.
   Markdown notes are out of scope (textareas have native undo). */

export const NB_UNDO_CAP = 20;

/** Push an entry, dropping the oldest past the cap (LIFO, 20 deep). */
export function pushUndoEntry(stack, entry) {
  stack.push(entry);
  while (stack.length > NB_UNDO_CAP) stack.shift();
  return stack;
}

/** Pop the most recent entry, or null when the stack is empty. */
export function popUndoEntry(stack) {
  return stack.length ? stack.pop() : null;
}

/** A cell source as one string (nbformat allows string or string[]). */
export function normalizeCellSource(source) {
  return Array.isArray(source) ? source.join('') : String(source ?? '');
}

/** A typing session in one cell: the source before the session started. */
export function editUndoEntry({ cell, prevSource }) {
  return { kind: 'edit', cell, prevSource: normalizeCellSource(prevSource) };
}

/** A cell added (by hand, or by an unpinned Code AI Apply). */
export function addUndoEntry({ cell }) {
  return { kind: 'add', cell };
}

/** A cell deleted, with the index to put it back at. */
export function deleteUndoEntry({ cell, index }) {
  return { kind: 'delete', cell, index };
}

/** A Code AI pinned Apply: snapshot the cell (and the pin) before it is
    replaced in place. `msgIndex` is the proposal's index in its thread,
    so undo can return the card to its pre-Apply state. */
export function replaceUndoEntry({ msgIndex, cell, prevSource, prevOutputs, prevExecutionCount, prevTarget }) {
  return {
    kind: 'replace', msgIndex, cell,
    prevSource: normalizeCellSource(prevSource),
    // Deep copy: the live outputs array is cleared by Apply, so the
    // record must own its copy.
    prevOutputs: JSON.parse(JSON.stringify(prevOutputs ?? [])),
    prevExecutionCount: prevExecutionCount ?? null,
    prevTarget: prevTarget ? { ...prevTarget } : null,
  };
}

/** A Code AI unpinned Apply: the appended cell, plus its proposal index. */
export function appendUndoEntry({ msgIndex, cell }) {
  return { kind: 'append', msgIndex, cell };
}

/** Typing coalescing: one undo step per edit session, never per keystroke.
    `begin` snapshots the source when editing starts (focus / Edit);
    `commit` returns the snapshot when the source moved, else null, and
    always ends the session. A WeakMap keeps the baseline off the cell
    objects — baselines must never leak into the saved .ipynb file.
    `hasUncommittedChange` is true while an open session has changes the
    stack does not hold yet: the toolbar Undo button follows it too, so
    it enables while typing (a disabled button cannot take focus, so
    clicking it could never commit the session). */
export function createEditBaselines() {
  const baselines = new WeakMap();
  const live = new Set();
  function commitOne(cell, source) {
    const prev = baselines.get(cell);
    baselines.delete(cell);
    live.delete(cell);
    if (prev === undefined) return null;
    return prev !== normalizeCellSource(source) ? prev : null;
  }
  return {
    begin(cell, source) {
      baselines.set(cell, normalizeCellSource(source));
      live.add(cell);
    },
    commit(cell, source) {
      return commitOne(cell, source);
    },
    /** Commit every open session (e.g. before a mutation that will
        re-render the notebook and blur the focused editor): returns the
        changed sessions in the order they were begun, so the caller can
        push them onto the stack BEFORE its own entry — the blur that
        fires during the re-render would otherwise land on top. */
    commitAll() {
      const out = [];
      for (const cell of [...live]) {
        const prev = commitOne(cell, normalizeCellSource(cell.source));
        if (prev !== null) out.push({ cell, prevSource: prev });
      }
      return out;
    },
    hasUncommittedChange() {
      for (const cell of live) {
        if (baselines.get(cell) !== normalizeCellSource(cell.source)) return true;
      }
      return false;
    },
  };
}
