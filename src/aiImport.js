// Proposal validation for the AI import flow (POST /api/import/ai/apply).
// Pure functions — no I/O, no Express. Unit-tested in tests/aiImport.test.js.
//
// The core rule: the AI proposes STRUCTURE ONLY. The note skeleton may
// contain a single top-level `#` title line and `##` headings with EMPTY
// bodies — any other prose (summaries, key points, bullet points) is
// rejected with a 400 before anything is written to data/.

/**
 * True when `skeleton` contains non-heading prose: strip `##`/`#` heading
 * lines and HTML comments; if any non-whitespace remains (beyond a single
 * top-level `#` title line, which is allowed), the skeleton has prose.
 */
export function noteSkeletonHasProse(skeleton) {
  if (typeof skeleton !== 'string') return true;
  const withoutComments = skeleton.replace(/<!--[\s\S]*?-->/g, '');
  const lines = withoutComments.split('\n');
  let titleLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s/.test(trimmed)) {
      if (/^#\s/.test(trimmed) && !/^##/.test(trimmed)) titleLines += 1;
      continue;
    }
    return true; // a non-heading, non-empty line = prose
  }
  return titleLines > 1; // at most one top-level title line
}

/**
 * Strictly validate a proposal object. Returns the normalized proposal
 * `{outline, noteSkeleton, chapterMap}` or throws an Error with `status=400`.
 */
export function validateProposal(proposal) {
  const fail = (msg) => {
    const err = new Error(msg);
    err.status = 400;
    throw err;
  };
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    fail('proposal must be a JSON object');
  }
  const { outline, noteSkeleton, chapterMap } = proposal;
  if (!Array.isArray(outline)) fail('proposal.outline must be an array');
  for (const [i, item] of outline.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail(`proposal.outline[${i}] must be an object`);
    }
    if (typeof item.title !== 'string' || !item.title.trim()) {
      fail(`proposal.outline[${i}].title must be a non-empty string`);
    }
    if (item.page !== undefined && item.page !== null
      && (!Number.isInteger(item.page) || item.page < 1)) {
      fail(`proposal.outline[${i}].page must be a positive integer or null`);
    }
  }
  if (typeof noteSkeleton !== 'string' || !noteSkeleton.trim()) {
    fail('proposal.noteSkeleton must be a non-empty string');
  }
  if (noteSkeletonHasProse(noteSkeleton)) {
    fail('proposal.noteSkeleton must contain only headings with empty bodies — no summaries, key points, or prose');
  }
  if (!chapterMap || typeof chapterMap !== 'object' || Array.isArray(chapterMap)) {
    fail('proposal.chapterMap must be an object');
  }
  for (const [key, value] of Object.entries(chapterMap)) {
    if (!Number.isInteger(value) || value < 0) {
      fail(`proposal.chapterMap[${JSON.stringify(key)}] must be a non-negative integer`);
    }
  }
  return {
    outline: outline.map((item) => ({
      title: item.title.trim(),
      page: item.page ?? null,
    })),
    noteSkeleton,
    chapterMap: { ...chapterMap },
  };
}
