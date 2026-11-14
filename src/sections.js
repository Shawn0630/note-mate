// Static-notebook sections for the Management page — helpers, mostly
// pure; scanLabsOnDisk is the one fs-backed helper (shared by the seed
// and the server-side Labs backfill), and never throws.
// A section is { id, name, notebooks: [{ name, path, chapter?, language? }] }.
// `path` is project-relative: seeded labs live under notes/labs/<Chapter>/,
// user-added static notebooks under notes/sections/<section-id>/. `chapter`
// groups entries inside a section (the Labs section's entries carry it);
// entries without one render flat. `language` is the notebook language
// (python | java | javascript) for the tag, best-effort — null when unknown.
//
// The Labs section is ONE section among others, not a special case: the
// seed writes it through buildLabsSection + mergeSections, the same
// structure the UI reads and writes. The Manage page never scans
// notes/labs/ itself; the Files directory and the lab picker keep their
// own labs API untouched.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { slugify } from './util.js';

export const LABS_SECTION_ID = 'labs';
export const LABS_SECTION_NAME = 'Labs';
export const SECTION_NOTEBOOKS_DIR = 'notes/sections';
export const SECTION_ID_RE = /^[a-z0-9-]+$/;
export const SECTION_NOTEBOOK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ipynb$/;
export const SECTION_LANGUAGES = ['python', 'java', 'javascript'];

/** The seed's Labs section from [{chapter, name}] lab files on disk. */
export function buildLabsSection(labFiles) {
  const files = (Array.isArray(labFiles) ? labFiles : [])
    .filter((f) => f && typeof f.chapter === 'string' && typeof f.name === 'string')
    .sort((a, b) => (a.chapter === b.chapter
      ? a.name.localeCompare(b.name) : a.chapter.localeCompare(b.chapter)));
  return {
    id: LABS_SECTION_ID,
    name: LABS_SECTION_NAME,
    notebooks: files.map((f) => ({
      name: f.name,
      path: `notes/labs/${f.chapter}/${f.name}`,
      chapter: f.chapter,
      language: 'python',
    })),
  };
}

/** Labs actually on disk: [{chapter, name}] for .ipynb files under
    <labsDir>/<Chapter>/. The section lists what is really there, so a
    partial set of labs never advertises a missing file. Never throws —
    a missing labs dir reads as no labs. */
export async function scanLabsOnDisk(labsDir) {
  const entries = [];
  let chapters = [];
  try {
    chapters = (await fsp.readdir(labsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return entries;
  }
  for (const chapter of chapters) {
    let files = [];
    try {
      files = (await fsp.readdir(path.join(labsDir, chapter), { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.ipynb'))
        .map((e) => e.name).sort();
    } catch { /* no files in this chapter */ }
    for (const name of files) entries.push({ chapter, name });
  }
  return entries;
}

/** Normalize stored sections: drop malformed sections and entries, keep
    the rest verbatim. Never throws. */
export function normalizeSections(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.id !== 'string' || !SECTION_ID_RE.test(s.id)) continue;
    if (typeof s.name !== 'string' || !s.name.trim()) continue;
    const notebooks = [];
    for (const n of Array.isArray(s.notebooks) ? s.notebooks : []) {
      if (!n || typeof n !== 'object') continue;
      if (typeof n.name !== 'string' || !SECTION_NOTEBOOK_NAME_RE.test(n.name)) continue;
      if (typeof n.path !== 'string' || !n.path || n.path.startsWith('/') || n.path.split('/').includes('..')) continue;
      notebooks.push({
        name: n.name,
        path: n.path,
        ...(typeof n.chapter === 'string' && n.chapter ? { chapter: n.chapter } : {}),
        ...(typeof n.language === 'string' && n.language ? { language: n.language.toLowerCase() } : {}),
        // Repo-imported notebooks keep their origin: the repo's
        // on-disk id and the notebook's repo-relative path. The
        // execute stager needs both to lay out the repo's data files
        // (dropping them here would silently break `open()` calls).
        ...(typeof n.repoId === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(n.repoId) ? { repoId: n.repoId } : {}),
        ...(typeof n.repoPath === 'string' && n.repoPath.toLowerCase().endsWith('.ipynb')
          && !n.repoPath.startsWith('/') && !n.repoPath.split('/').includes('..')
          ? { repoPath: n.repoPath } : {}),
      });
    }
    out.push({ id: s.id, name: s.name, notebooks });
  }
  return out;
}

/** Find a section by id in a normalized list, or null. */
export function findSection(sections, id) {
  return (Array.isArray(sections) ? sections : []).find((s) => s.id === id) || null;
}

/** Merge the seed Labs section into stored sections: a section with the
    same id keeps its entries and gains any seed entries it lacks (by
    path); otherwise the seed section is appended. User-added sections
    and user-added entries inside Labs are never removed. Idempotent. */
export function mergeSections(existing, seedSection) {
  const sections = normalizeSections(existing);
  const seed = normalizeSections([seedSection])[0];
  if (!seed) return sections;
  const at = sections.findIndex((s) => s.id === seed.id);
  if (at === -1) return [...sections, seed];
  const have = new Set(sections[at].notebooks.map((n) => n.path));
  const merged = {
    ...sections[at],
    notebooks: [
      ...sections[at].notebooks,
      ...seed.notebooks.filter((n) => !have.has(n.path)),
    ],
  };
  // Keep the seeded name when the stored section is the seed's own;
  // a renamed Labs section keeps its name (identity is the id).
  return sections.map((s, i) => (i === at ? merged : s));
}

/** First-free default section name: "Section 1", "Section 2", … */
export function nextSectionName(sections) {
  const names = new Set((Array.isArray(sections) ? sections : []).map((s) => s.name));
  let n = 1;
  while (names.has(`Section ${n}`)) n += 1;
  return `Section ${n}`;
}

/** Unique id for a new section name: slugified, suffixed when taken. */
export function sectionIdFor(name, sections) {
  const taken = new Set((Array.isArray(sections) ? sections : []).map((s) => s.id));
  const base = slugify(name) || 'section';
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
