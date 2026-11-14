// Fill with AI for Materials — the Manage page's "✨ Fill with AI".
// A conversation proposes URL-based materials (YouTube videos + plain
// web links) and, when the thread names a YouTube playlist and/or a
// GitHub repo, section notebooks from the repo; nothing is written
// until the user presses Apply in the preview. Mirrors the AI import
// propose/apply split: propose writes nothing (503 when the LLM is
// unconfigured); apply validates strictly and dedupes against
// existing materials by URL and against existing section notebooks by
// repo path.
//
// Playlist URLs and GitHub repo URLs are expanded server-side BEFORE
// the model is asked (src/playlist.js, src/repoIngest.js), so the
// model selects from real videos / real notebook paths instead of
// inventing URLs. The proposal also lists the Python packages the
// imported notebooks need but the container lacks (src/pyPackages.js);
// Apply pip-installs them and records the install durably.
//
// Pure helpers (no I/O, no Express) plus proposeMaterials, which calls
// the LLM. Unit-tested in tests/aiMaterials.test.js.
import { generateText, unwrapJsonText, LlmError } from './llm.js';
import { extractYoutubeVideoId, parseNotebook } from './util.js';
import {
  expandPlaylist, extractPlaylistUrls,
} from './playlist.js';
import {
  extractGithubRepoUrls, fetchRepoTree, selectRepoFiles,
  extractPackageNames, rawUrlFor, validateSectionNotebookUrl,
  fetchTextCapped, repoIdFor,
  MAX_NOTEBOOK_BYTES, MAX_SUPPORT_FILE_BYTES,
} from './repoIngest.js';
import {
  scanNotebookImports, classifyImports, localModuleNames,
  checkImportable, packageForImport,
} from './pyPackages.js';

/** A proposal holds at most this many materials; extras are dropped.
    A playlist "add them all" must fit, so this is 100, not 20. */
export const MAX_MATERIALS_PROPOSAL = 100;

/** A proposal holds at most this many section notebooks in total. */
export const MAX_SECTION_NOTEBOOKS_PROPOSAL = 100;

/** Thread turns sent per propose call — same cap as ai-note history. */
export const MAX_MATERIALS_MESSAGES = 6;

/** Per-message characters sent per propose call. */
export const MAX_MATERIALS_MESSAGE_CHARS = 2000;

export const MATERIALS_AI_PROMPT = `You help add reading materials to a note-taking project.
The user describes materials they want added — YouTube videos, articles, web pages — and may also give a YouTube playlist URL and/or a GitHub repository URL. Playlist videos and repo notebooks have ALREADY been expanded by the server and are listed below with their real titles and URLs.
Reply with ONLY a JSON object with this exact shape (no markdown fences, no commentary):

{"materials": [{"title": "<short title>", "kind": "video"|"link", "url": "<URL>"}], "sections": [{"name": "<section name>", "notebooks": [{"name": "<file>.ipynb", "url": "<raw.githubusercontent.com URL>"}]}], "note": "<one short line>"}

HARD RULES — violating any of them makes the output unusable:
1. "kind" is "video" ONLY for YouTube video URLs (youtube.com/watch, youtu.be, /shorts/, /live/, /embed/); every other URL is kind "link".
2. Use the URLs the user gave, verbatim, when they gave any. Never change a URL the user pasted.
3. NEVER invent a URL. Playlist videos are expandable: select ONLY from the expanded videos listed below, using their watch URLs verbatim. Repo notebooks are expandable: a section notebook's "url" must be one of the listed raw.githubusercontent.com URLs, verbatim. If the user asks for something by name without giving a URL and you cannot determine its real URL, OMIT that item and say so in "note".
4. Titles are short (under 80 characters) and specific.
5. At most 100 materials. Never propose anything already in the project (listed below).
6. "sections" groups the repo's notebooks the way the user asked — e.g. one section per lecture/folder matching the videos, each holding its notebook(s). A section "name" is short (under 80 characters). A notebook "name" is its file name (ends .ipynb). Omit "sections" (or leave it []) when no repo was given.
7. "note" is one short line: what you proposed, or what you could not find.`;

/** Canonical watch URL for a YouTube video id. */
export function youtubeWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** The dedupe key for a material entry: a video keys on its video id
    (so watch / youtu.be / shorts forms of the same video collide), a
    link on its exact URL string. Null when the entry has no usable key. */
export function materialDedupeKey(entry) {
  const kind = String(entry?.kind || '').toLowerCase();
  if (kind === 'video') {
    const videoId = extractYoutubeVideoId(entry?.url || '');
    return videoId ? `video:${videoId}` : null;
  }
  if (kind === 'link') {
    const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
    return url ? `link:${url}` : null;
  }
  return null;
}

/** Normalize one proposed entry to {title, kind, url}, or null when it
    is not a usable material. A link whose URL is a YouTube video URL is
    coerced to kind 'video' (with the canonical watch URL); a video whose
    URL is not YouTube is invalid. Titles are trimmed and capped. */
export function normalizeMaterialEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const title = typeof entry.title === 'string' ? entry.title.trim() : '';
  if (!title) return null;
  const kind = String(entry.kind || '').toLowerCase();
  const rawUrl = typeof entry.url === 'string' ? entry.url.trim() : '';
  if (!rawUrl) return null;
  if (kind === 'video') {
    const videoId = extractYoutubeVideoId(rawUrl);
    if (!videoId) return null;
    return { title: title.slice(0, 200), kind: 'video', url: youtubeWatchUrl(videoId) };
  }
  if (kind === 'link') {
    const videoId = extractYoutubeVideoId(rawUrl);
    if (videoId) return { title: title.slice(0, 200), kind: 'video', url: youtubeWatchUrl(videoId) };
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return { title: title.slice(0, 200), kind: 'link', url: rawUrl };
  }
  return null;
}

/** Split a raw proposal into usable materials + a count of entries that
    were dropped as invalid. Caps at MAX_MATERIALS_PROPOSAL; extras count
    as dropped. Never throws. */
export function normalizeMaterialsProposal(proposal) {
  const raw = Array.isArray(proposal?.materials) ? proposal.materials : [];
  const materials = [];
  let dropped = 0;
  for (const entry of raw) {
    if (materials.length >= MAX_MATERIALS_PROPOSAL) {
      dropped += 1;
      continue;
    }
    const norm = normalizeMaterialEntry(entry);
    if (!norm) {
      dropped += 1;
      continue;
    }
    materials.push(norm);
  }
  const note = typeof proposal?.note === 'string' ? proposal.note.trim().slice(0, 500) : '';
  return { materials, dropped, note };
}

/** Strict validation for Apply: every entry must normalize; anything
    invalid fails the whole apply with a 400 (the client only sends
    proposals the propose step already validated, so a failure here means
    a stale or tampered proposal). Returns {materials, note}. */
export function validateMaterialsProposal(proposal) {
  const fail = (msg) => {
    const err = new Error(msg);
    err.status = 400;
    throw err;
  };
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    fail('proposal must be a JSON object');
  }
  if (!Array.isArray(proposal.materials)) fail('proposal.materials must be an array');
  if (!proposal.materials.length) fail('proposal.materials must not be empty');
  if (proposal.materials.length > MAX_MATERIALS_PROPOSAL) {
    fail(`proposal.materials holds at most ${MAX_MATERIALS_PROPOSAL} entries`);
  }
  const materials = [];
  for (const [i, entry] of proposal.materials.entries()) {
    const norm = normalizeMaterialEntry(entry);
    if (!norm) {
      fail(`proposal.materials[${i}] is not a valid material (title + kind video|link + URL required)`);
    }
    materials.push(norm);
  }
  const note = typeof proposal?.note === 'string' ? proposal.note.trim().slice(0, 500) : '';
  return { materials, note };
}

/** Split entries into new ones and duplicates of the existing materials.
    A duplicate (same video id, or same link URL) is skipped with reason
    'duplicate'; an entry with no usable key is skipped as 'invalid'.
    Duplicates within the batch itself are skipped too. */
export function dedupeMaterials(existing, entries) {
  const seen = new Set();
  for (const m of existing ?? []) {
    const key = materialDedupeKey(m);
    if (key) seen.add(key);
  }
  const added = [];
  const skipped = [];
  for (const entry of entries ?? []) {
    const key = materialDedupeKey(entry);
    if (!key) {
      skipped.push({ ...entry, reason: 'invalid' });
    } else if (seen.has(key)) {
      skipped.push({ ...entry, reason: 'duplicate' });
    } else {
      seen.add(key);
      added.push(entry);
    }
  }
  return { added, skipped };
}

/** Render the thread for the model: "User: ...\nAssistant: ..." lines.
    Assistant turns carry their proposal inline (the client augments
    them), so follow-ups like "only the first 6" have the previous
    proposal in context. */
function renderMaterialsThread(messages) {
  return (messages ?? [])
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n');
}

/**
 * Normalize one proposed section to `{name, notebooks: [{name, url}]}`,
 * or null when it is not usable. Notebook URLs are validated against
 * the repos declared in the proposal — a URL under any other repo (or
 * anywhere else) is dropped, never downloaded. Caps at
 * MAX_SECTION_NOTEBOOKS_PROPOSAL notebooks across the whole proposal
 * (the running count is passed in and updated).
 */
export function normalizeSectionEntry(entry, repos, budget, opts = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (!name || name.length > 120) return null;
  if (!Array.isArray(entry.notebooks) || !entry.notebooks.length) return null;
  const notebooks = [];
  for (const nb of entry.notebooks) {
    if (budget.remaining <= 0) break;
    if (!nb || typeof nb !== 'object') continue;
    const nbName = typeof nb.name === 'string' ? nb.name.trim() : '';
    if (!nbName || !nbName.toLowerCase().endsWith('.ipynb') || nbName.includes('/')) continue;
    let checked;
    try {
      checked = validateSectionNotebookUrl(nb.url, repos, opts);
    } catch {
      continue;
    }
    if (notebooks.some((n) => n.name === nbName)) continue;
    notebooks.push({ name: nbName, url: nb.url, repoPath: checked.path, repoId: checked.repoId });
    budget.remaining -= 1;
  }
  if (!notebooks.length) return null;
  return { name: name.slice(0, 120), notebooks };
}

/** Split a raw proposal's sections into usable ones + a count of
    entries dropped as invalid (bad name, no usable notebooks, URL
    outside the declared repos, over the notebook cap). Never throws. */
export function normalizeSectionsProposal(proposal, repos, opts = {}) {
  const raw = Array.isArray(proposal?.sections) ? proposal.sections : [];
  const budget = { remaining: MAX_SECTION_NOTEBOOKS_PROPOSAL };
  const sections = [];
  let dropped = 0;
  for (const entry of raw) {
    const norm = normalizeSectionEntry(entry, repos, budget, opts);
    if (!norm) {
      dropped += 1;
      continue;
    }
    sections.push(norm);
  }
  return { sections, dropped };
}

/** Strict validation for Apply: every section + notebook must
    normalize; anything invalid fails the whole apply with a 400.
    Returns the normalized sections. */
export function validateSectionsProposal(proposal, repos, opts = {}) {
  const fail = (msg) => {
    const err = new Error(msg);
    err.status = 400;
    throw err;
  };
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    fail('proposal must be a JSON object');
  }
  const raw = proposal.sections ?? [];
  if (!Array.isArray(raw)) fail('proposal.sections must be an array');
  const budget = { remaining: MAX_SECTION_NOTEBOOKS_PROPOSAL };
  const sections = [];
  for (const [i, entry] of raw.entries()) {
    const norm = normalizeSectionEntry(entry, repos, budget, opts);
    if (!norm) fail(`proposal.sections[${i}] is not a valid section (name + .ipynb notebooks under a declared repo required)`);
    sections.push(norm);
  }
  return sections;
}

/** Split proposed sections against the project's existing sections:
    a notebook whose repoPath is already in ANY section is a duplicate
    (same repo file, wherever it lives); a section that ends up empty
    is dropped. Returns `{sections, skipped}` where each kept section
    is `{name, notebooks}` and each skipped entry carries
    reason 'duplicate'. */
export function dedupeSectionsByRepoPath(existingSections, sections) {
  const havePaths = new Set();
  for (const s of existingSections ?? []) {
    for (const n of s?.notebooks ?? []) {
      if (typeof n?.repoPath === 'string' && n.repoPath) havePaths.add(n.repoPath);
    }
  }
  const kept = [];
  const skipped = [];
  for (const section of sections ?? []) {
    const notebooks = [];
    for (const nb of section.notebooks ?? []) {
      if (havePaths.has(nb.repoPath)) {
        skipped.push({ ...nb, section: section.name, reason: 'duplicate' });
      } else {
        havePaths.add(nb.repoPath);
        notebooks.push(nb);
      }
    }
    if (notebooks.length) kept.push({ name: section.name, notebooks });
  }
  return { sections: kept, skipped };
}

/** Render the expanded sources (playlists + repos) for the model
    prompt: real videos with real titles/URLs, real notebook paths
    with real raw URLs, manifest packages, support files, and any
    fetch failures — so the model selects from facts, never invents. */
function renderExpandedSources(sources) {
  const lines = [];
  const playlists = sources?.playlists ?? [];
  if (playlists.length) {
    lines.push('Playlists (expanded by the server):');
    for (const p of playlists) {
      if (p.error) {
        lines.push(`- ${p.url}: could not be loaded (${p.error})`);
        continue;
      }
      const totalNote = p.truncated ? `first ${p.videos.length} shown, playlist is longer` : `${p.videos.length} videos`;
      lines.push(`- ${p.url}: ${totalNote}`);
      for (const v of p.videos ?? []) {
        lines.push(`  - ${v.title} — https://www.youtube.com/watch?v=${v.videoId}`);
      }
    }
  }
  const repos = sources?.repos ?? [];
  if (repos.length) {
    lines.push('GitHub repos (tree fetched by the server):');
    for (const r of repos) {
      if (r.error) {
        lines.push(`- ${r.url}: could not be loaded (${r.error})`);
        continue;
      }
      lines.push(`- ${r.owner}/${r.repo} (${r.branch}): ${r.notebooks.length} notebooks, ${r.manifests.length} dependency files, ${r.supportFiles.length} support files`);
      const unreadable = new Set((r.notebookErrors ?? []).map((e) => e.path));
      for (const nb of r.notebooks) {
        if (unreadable.has(nb.path)) continue; // offered nowhere: listed below as unreadable
        lines.push(`  - notebook ${nb.path} — ${nb.rawUrl}`);
      }
      if (r.packages?.length) {
        lines.push(`  - needs (from ${r.manifests.map((m) => m.path).join(', ')}): ${r.packages.join(', ')}`);
      }
      if (r.supportFiles.length) {
        lines.push(`  - support files (fetched at Apply, same relative paths): ${r.supportFiles.map((f) => f.path).join(', ')}`);
      }
      if (r.skippedCount) {
        const names = r.skipped.slice(0, 5).map((s) => `${s.path} (${s.reason})`).join(', ');
        lines.push(`  - skipped, not fetched: ${r.skippedCount} file(s)${names ? ` — ${names}` : ''}`);
      }
      if (r.notebookErrors?.length) {
        lines.push(`  - could not be read: ${r.notebookErrors.map((e) => `${e.path} (${e.error})`).join(', ')}`);
      }
    }
  }
  const missing = sources?.missingPackages ?? [];
  if (missing.length) {
    lines.push(`Python packages the notebooks import but this container lacks (installed at Apply): ${missing.map((m) => `${m.importName} → ${m.package}`).join(', ')}`);
  }
  return lines.length ? lines.join('\n') : 'None — no playlist or repo URLs were given.';
}

export function buildMaterialsPrompt({ projectTitle, existing, messages, sources }) {
  const existingLines = (existing ?? []).length
    ? (existing ?? []).map((m) => `- ${m.label || m.id} (${m.kind}): ${m.url || m.id}`).join('\n')
    : 'None yet.';
  return `${MATERIALS_AI_PROMPT}\n\nProject: ${projectTitle || 'Untitled'}\n\nAlready in the project (do not propose again):\n${existingLines}\n\nExpanded sources:\n${renderExpandedSources(sources)}\n\nConversation:\n${renderMaterialsThread(messages)}`;
}

/**
 * Expand every playlist URL and GitHub repo URL found in the thread,
 * server-side. Returns `{playlists, repos, missingPackages}`. A
 * failed expansion is captured per source (`error`) — it never throws
 * the whole gather, so the model is told what failed and the note can
 * say so. Notebook bytes ARE downloaded here (they are needed to
 * validate with parseNotebook and to scan imports); support files are
 * only listed, and are downloaded at Apply.
 *
 * `opts` carries test hooks: `{fetchImpl, ytPageBase, ytRssBase,
 * apiBase, rawBase, pythonCmd, runImpl}`.
 */
export async function gatherExpandedSources(messages, opts = {}) {
  const text = (messages ?? []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const playlistUrls = extractPlaylistUrls(text);
  const repoUrls = extractGithubRepoUrls(text);
  const playlists = [];
  for (const { playlistId, url } of playlistUrls) {
    try {
      const expanded = await expandPlaylist(playlistId, {
        fetchImpl: opts.fetchImpl,
        pageBase: opts.ytPageBase,
        rssBase: opts.ytRssBase,
      });
      playlists.push({ playlistId, url, ...expanded });
    } catch (err) {
      playlists.push({ playlistId, url, error: err.message });
    }
  }
  const repos = [];
  const allThirdParty = new Set();
  const localModules = new Set();
  for (const { owner, repo, branch, url } of repoUrls) {
    const record = { owner, repo, branch, url, notebooks: [], manifests: [], supportFiles: [], skipped: [], skippedCount: 0, packages: [], notebookErrors: [] };
    repos.push(record);
    try {
      const tree = await fetchRepoTree({ owner, repo, branch }, {
        fetchImpl: opts.fetchImpl, apiBase: opts.apiBase,
      });
      record.branch = tree.branch;
      const selected = selectRepoFiles(tree.tree);
      record.notebooks = selected.notebooks.map((nb) => ({
        ...nb,
        rawUrl: rawUrlFor(tree, nb.path, opts.rawBase),
      }));
      record.manifests = selected.manifests;
      record.supportFiles = selected.supportFiles;
      record.skipped = selected.skipped;
      record.skippedCount = selected.skippedCount;
      // Manifest contents → package names the notebooks need.
      const packageNames = [];
      const seenPkg = new Set();
      for (const manifest of selected.manifests) {
        try {
          const content = await fetchTextCapped(
            rawUrlFor(tree, manifest.path, opts.rawBase), MAX_SUPPORT_FILE_BYTES, { fetchImpl: opts.fetchImpl },
          );
          for (const name of extractPackageNames(manifest.kind, content)) {
            if (!seenPkg.has(name.toLowerCase())) {
              seenPkg.add(name.toLowerCase());
              packageNames.push(name);
            }
          }
        } catch {
          // A manifest that cannot be read contributes no packages;
          // the notebooks are unaffected.
        }
      }
      record.packages = packageNames;
      // Notebook bytes: validate + scan imports.
      for (const nb of record.notebooks) {
        try {
          const content = await fetchTextCapped(nb.rawUrl, MAX_NOTEBOOK_BYTES, { fetchImpl: opts.fetchImpl });
          const parsed = parseNotebook(content);
          for (const name of scanNotebookImports(parsed)) allThirdParty.add(name);
        } catch (err) {
          record.notebookErrors.push({ path: nb.path, error: err.message });
        }
      }
      for (const f of selected.supportFiles.filter((s) => s.path.toLowerCase().endsWith('.py'))) {
        for (const name of localModuleNames([f.path])) localModules.add(name);
      }
    } catch (err) {
      record.error = err.message;
    }
  }
  // Third-party imports vs the execution python — one subprocess.
  let missingPackages = [];
  const { thirdParty } = classifyImports(allThirdParty, [...localModules]);
  if (thirdParty.length) {
    try {
      const present = await checkImportable(thirdParty, opts);
      missingPackages = thirdParty
        .filter((name) => present.get(name) !== true)
        .map((importName) => ({ importName, package: packageForImport(importName) }));
    } catch (err) {
      // The check failing must not block the proposal: the imports
      // are listed as unknown, and Apply re-checks before installing.
      missingPackages = thirdParty.map((importName) => ({
        importName, package: packageForImport(importName), unchecked: true, checkError: err.message,
      }));
    }
  }
  return { playlists, repos, missingPackages };
}

/**
 * Ask the model for a materials (+ sections) proposal for this thread.
 * Returns `{proposal, sources}` where proposal is the parsed model
 * output as-is (the caller normalizes it) and sources is the gathered
 * expansion (playlists, repos, missing packages).
 * @throws {LlmError} LLM_NOT_CONFIGURED (status 503) when no stub and no
 *   key+model; LLM_BAD_RESPONSE (status 400) when the model output is not
 *   parseable JSON — `err.rawText` carries the raw model text.
 */
export async function proposeMaterials({ projectTitle, existing, messages, ...opts }) {
  const sources = await gatherExpandedSources(messages, opts);
  const prompt = buildMaterialsPrompt({ projectTitle, existing, messages, sources });
  const instruction = [...(messages ?? [])].reverse().find((m) => m.role === 'user')?.content || '';
  const rawText = await generateText(prompt, {
    log: { feature: 'ai-material', instruction: String(instruction).slice(0, 2000) },
  });
  let parsed;
  try {
    parsed = JSON.parse(unwrapJsonText(rawText));
  } catch {
    throw new LlmError('LLM_BAD_RESPONSE', 'Model output was not valid JSON', { status: 400, rawText });
  }
  return { proposal: parsed, sources };
}
