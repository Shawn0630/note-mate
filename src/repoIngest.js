// Ingest a public GitHub repo into Fill with AI — no auth, no new
// dependencies (built-in fetch only).
//
// From the repo tree (one `git/trees/<branch>?recursive=1` request,
// after a metadata fetch for the default branch) we select three
// disjoint file sets:
//   - notebooks: every `.ipynb` file (download cap 10MB each — the
//     Karpathy repo has a 5.5MB one).
//   - manifests: dependency files (requirements*.txt, environment.yml,
//     pyproject.toml, setup.py, Pipfile) — surfaced as link materials
//     pointing at their raw URLs, and their package names are listed
//     in the proposal so the user sees what the notebooks need.
//   - support files: small text/data files the notebooks read at run
//     time (`data/*.txt`, sibling `.py` modules, …), fetched alongside
//     the notebooks and stored preserving repo-relative paths, so a
//     notebook's relative `open('../data/names.txt')` resolves when it
//     runs. Size cap 2MB; anything else (binaries, huge files such as
//     a 52MB `.pth` checkpoint) is SKIPPED and reported — never fetched
//     silently, never installed.
// Nothing is written by this module: it only fetches and selects.
// The caller (aiMaterials apply) downloads the selected files and
// writes them.
//
// Test hooks: fetch functions accept `{fetchImpl, apiBase, rawBase}`;
// the server passes `NM_GITHUB_API_BASE` / `NM_GITHUB_RAW_BASE` when
// set (used by the browser probe's local stub server). In production
// these are unset and the defaults below are used.
//
// Pure helpers + the fetch-backed tree load. Unit-tested in
// tests/repoIngest.test.js against fixture tree JSON.

/** A notebook download gets 10MB; a support file 2MB. */
export const MAX_NOTEBOOK_BYTES = 10 * 1024 * 1024;
export const MAX_SUPPORT_FILE_BYTES = 2 * 1024 * 1024;

/** Text-ish extensions a notebook may read at run time. */
export const SUPPORT_FILE_EXTS = new Set([
  '.txt', '.csv', '.tsv', '.json', '.jsonl', '.md', '.py',
  '.yaml', '.yml', '.toml', '.cfg', '.ini',
]);

/** At most this many skipped entries are listed per repo (the count is
    always exact). */
export const MAX_SKIPPED_LISTED = 50;

/** A repo fetch gets 15s; a raw file download 30s. */
const API_TIMEOUT_MS = 15000;
const RAW_TIMEOUT_MS = 30000;

const BROWSER_HEADERS = {
  'user-agent': 'NoteMate/1.0 (repo ingest)',
  accept: 'application/vnd.github+json',
};

/**
 * Parse a GitHub repo URL into `{owner, repo, branch}` (branch null
 * when the URL names no tree path), or null when it is not a
 * github.com repo URL. Accepts `/tree/<branch>/…`, a trailing slash,
 * and a `.git` suffix.
 */
export function extractGithubRepo(rawUrl) {
  let s = String(rawUrl ?? '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0];
  let repo = segments[1];
  if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
  if (!owner || !repo) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  let branch = null;
  if (segments[2] === 'tree' && segments[3]) branch = segments.slice(3).join('/');
  return { owner, repo, branch };
}

/** Find every GitHub repo URL inside free text, in order, deduped by
    owner/repo/branch. */
export function extractGithubRepoUrls(text) {
  const found = new Map();
  for (const token of String(text ?? '').match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    const repo = extractGithubRepo(token);
    if (!repo) continue;
    const key = `${repo.owner}/${repo.repo}@${repo.branch || ''}`;
    if (!found.has(key)) found.set(key, { ...repo, url: token });
  }
  return [...found.values()];
}

/** The stable on-disk id for a repo's fetched files: owner-repo. */
export function repoIdFor({ owner, repo }) {
  return `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The raw.githubusercontent.com URL for a file in a repo. */
export function rawUrlFor({ owner, repo, branch }, repoPath, rawBase) {
  const base = (rawBase || 'https://raw.githubusercontent.com').replace(/\/+$/, '');
  return `${base}/${owner}/${repo}/${encodeURIComponent(branch)}/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
}

async function fetchWithTimeout(fetchImpl, url, ms, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function githubError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Load a repo's file tree: `{owner, repo, branch, defaultBranch,
 * tree: [{path, size, type}]}`. When no branch is given, the repo
 * metadata is fetched first for its default branch. Throws with
 * status 404 (repo/branch not found or private), 502 (rate-limited,
 * or any other API failure).
 */
export async function fetchRepoTree({ owner, repo, branch }, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const apiBase = (opts.apiBase || 'https://api.github.com').replace(/\/+$/, '');
  const fail = (status, msg) => { throw githubError(status, msg); };
  let resolvedBranch = branch || null;
  let defaultBranch = null;
  if (!resolvedBranch) {
    const metaRes = await fetchWithTimeout(
      fetchImpl, `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      API_TIMEOUT_MS, BROWSER_HEADERS,
    ).catch((err) => fail(502, `could not reach the GitHub API: ${err.message}`));
    if (metaRes.status === 404) fail(404, `GitHub repository ${owner}/${repo} was not found (or is private)`);
    if (metaRes.status === 403) {
      fail(502, 'GitHub API rate limit reached — try again later');
    }
    if (!metaRes.ok) fail(502, `GitHub API returned HTTP ${metaRes.status}`);
    const meta = await metaRes.json().catch(() => ({}));
    defaultBranch = typeof meta.default_branch === 'string' && meta.default_branch ? meta.default_branch : 'main';
    resolvedBranch = defaultBranch;
  }
  const treeRes = await fetchWithTimeout(
    fetchImpl,
    `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(resolvedBranch)}?recursive=1`,
    API_TIMEOUT_MS, BROWSER_HEADERS,
  ).catch((err) => fail(502, `could not reach the GitHub API: ${err.message}`));
  if (treeRes.status === 404) fail(404, `GitHub repository ${owner}/${repo} (branch ${resolvedBranch}) was not found (or is private)`);
  if (treeRes.status === 403) fail(502, 'GitHub API rate limit reached — try again later');
  if (!treeRes.ok) fail(502, `GitHub API returned HTTP ${treeRes.status}`);
  const body = await treeRes.json().catch(() => null);
  if (!body || !Array.isArray(body.tree)) fail(502, 'GitHub API returned an unexpected tree response');
  if (body.truncated) fail(502, `GitHub repository ${owner}/${repo} is too large to list`);
  const tree = body.tree
    .filter((e) => e && e.type === 'blob' && typeof e.path === 'string')
    .map((e) => ({ path: e.path, size: typeof e.size === 'number' ? e.size : 0 }));
  return { owner, repo, branch: resolvedBranch, defaultBranch, tree };
}

/** The dependency-manifest kind for a repo path, or null. */
export function manifestKindFor(repoPath) {
  const base = repoPath.split('/').pop() || '';
  if (/^requirements[^/]*\.txt$/i.test(base)) return 'requirements.txt';
  if (/^environment\.ya?ml$/i.test(base)) return 'environment.yml';
  if (base === 'pyproject.toml') return 'pyproject.toml';
  if (base === 'setup.py') return 'setup.py';
  if (base === 'Pipfile') return 'Pipfile';
  return null;
}

function extOf(repoPath) {
  const base = repoPath.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * Split a repo tree into `{notebooks, manifests, supportFiles,
 * skipped, skippedCount}`. The three file sets are disjoint: a
 * manifest is never also a support file, and a notebook is never
 * either. `skipped` lists up to MAX_SKIPPED_LISTED entries as
 * `{path, size, reason}` ('too large' when a notebook/support file
 * exceeds its cap, 'binary' otherwise); `skippedCount` is the exact
 * total. Notebook entries are `{path, name, dir, size}` (dir is the
 * repo-relative folder, '' at the root); manifests are
 * `{path, kind, size}`; support files are `{path, size}`.
 */
export function selectRepoFiles(tree) {
  const notebooks = [];
  const manifests = [];
  const supportFiles = [];
  const skipped = [];
  let skippedCount = 0;
  const skip = (path, size, reason) => {
    skippedCount += 1;
    if (skipped.length < MAX_SKIPPED_LISTED) skipped.push({ path, size, reason });
  };
  for (const entry of tree ?? []) {
    const repoPath = entry?.path;
    if (typeof repoPath !== 'string' || !repoPath) continue;
    const size = typeof entry.size === 'number' ? entry.size : 0;
    const base = repoPath.split('/').pop();
    if (repoPath.toLowerCase().endsWith('.ipynb')) {
      if (size > MAX_NOTEBOOK_BYTES) {
        skip(repoPath, size, 'too large');
        continue;
      }
      notebooks.push({
        path: repoPath,
        name: base,
        dir: repoPath.includes('/') ? repoPath.slice(0, repoPath.lastIndexOf('/')) : '',
        size,
      });
      continue;
    }
    const kind = manifestKindFor(repoPath);
    if (kind) {
      manifests.push({ path: repoPath, kind, size });
      continue;
    }
    if (SUPPORT_FILE_EXTS.has(extOf(repoPath))) {
      if (size > MAX_SUPPORT_FILE_BYTES) {
        skip(repoPath, size, 'too large');
        continue;
      }
      supportFiles.push({ path: repoPath, size });
      continue;
    }
    skip(repoPath, size, 'binary');
  }
  return { notebooks, manifests, supportFiles, skipped, skippedCount };
}

/** Strip a version/extra/marker tail from one requirement line:
    `name[extra]>=1.0; python_version>"3.8"` → `name`. */
function requirementName(line) {
  const clean = String(line ?? '').trim().replace(/\\$/, '').trim();
  if (!clean || clean.startsWith('#') || clean.startsWith('-')) return null;
  const name = clean.split(/[\s\[<>=!~;]/, 1)[0].trim();
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : null;
}

/**
 * Extract package names from a dependency manifest's text, best
 * effort, line-based. `kind` is one of the manifest kinds from
 * `manifestKindFor`. Returns deduped names in file order.
 */
export function extractPackageNames(kind, text) {
  const out = [];
  const seen = new Set();
  const push = (name) => {
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  };
  const src = String(text ?? '');
  if (kind === 'requirements.txt') {
    for (const line of src.split('\n')) push(requirementName(line));
    return out;
  }
  if (kind === 'environment.yml') {
    let inDeps = false;
    let inPip = false;
    for (const rawLine of src.split('\n')) {
      const line = rawLine.replace(/#.*$/, '');
      if (/^\s*dependencies\s*:/.test(line)) { inDeps = true; inPip = false; continue; }
      if (!inDeps) continue;
      if (/^\S/.test(line)) { inDeps = false; inPip = false; continue; }
      const item = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (!item) continue;
      const value = item[1].trim();
      if (value === 'pip:') { inPip = true; continue; }
      if (value.startsWith('{') || value.startsWith('pip:')) continue;
      // The interpreter pin (python=3.9) and the pip tool itself are
      // not packages the notebooks import — leave them out.
      const name = requirementName(value.startsWith('- ') ? value.slice(2) : value);
      if (name === 'python' || name === 'pip') continue;
      push(name);
    }
    return out;
  }
  if (kind === 'pyproject.toml' || kind === 'setup.py') {
    // dependencies = [ "name>=1.0", ... ] — take every quoted string
    // inside a dependencies/install_requires block.
    const blockRe = /(?:dependencies|install_requires)\s*=\s*\[([\s\S]*?)\]/g;
    for (const m of src.matchAll(blockRe)) {
      for (const q of m[1].matchAll(/["']([^"']+)["']/g)) push(requirementName(q[1]));
    }
    return out;
  }
  if (kind === 'Pipfile') {
    let inPackages = false;
    for (const rawLine of src.split('\n')) {
      const line = rawLine.trim();
      if (/^\[packages\]/.test(line)) { inPackages = true; continue; }
      if (/^\[/.test(line)) { inPackages = false; continue; }
      if (!inPackages || !line || line.startsWith('#')) continue;
      const name = /^["']?([A-Za-z0-9_.-]+)["']?\s*=/.exec(line)?.[1];
      push(name);
    }
    return out;
  }
  return out;
}

/**
 * Download a text/JSON file with a byte cap. Reads the body as a
 * stream and aborts past the cap, so a huge file cannot blow up
 * memory. Returns the body as a UTF-8 string. Throws with status 502
 * on a non-OK response or an over-cap body.
 */
export async function fetchTextCapped(url, maxBytes, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const res = await fetchWithTimeout(fetchImpl, url, RAW_TIMEOUT_MS, BROWSER_HEADERS)
    .catch((err) => {
      const e = new Error(`could not download ${url}: ${err.message}`);
      e.status = 502;
      throw e;
    });
  if (!res.ok) {
    const err = new Error(`download returned HTTP ${res.status}: ${url}`);
    err.status = 502;
    throw err;
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      const err = new Error(`download exceeds the ${maxBytes} byte cap: ${url}`);
      err.status = 502;
      throw err;
    }
    return buf.toString('utf8');
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        const err = new Error(`download exceeds the ${maxBytes} byte cap: ${url}`);
        err.status = 502;
        throw err;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Validate a proposed section-notebook URL against the repos declared
 * in the proposal: it must be a raw.githubusercontent.com URL under
 * one of them, naming a `.ipynb` path. Returns
 * `{owner, repo, branch, path, repoId}`. Throws a 400 otherwise —
 * Apply must never download an arbitrary URL. `opts.rawBase` (the
 * NM_GITHUB_RAW_BASE test hook) changes the accepted host, so stub
 * servers can serve the files in tests.
 */
export function validateSectionNotebookUrl(url, repos, opts = {}) {
  const fail = (msg) => {
    const err = new Error(msg);
    err.status = 400;
    throw err;
  };
  if (typeof url !== 'string' || !url) fail('notebook url is required');
  let u;
  try {
    u = new URL(url);
  } catch {
    fail(`notebook url is not a valid URL: ${url}`);
  }
  const host = u.hostname.toLowerCase();
  let rawHost = 'raw.githubusercontent.com';
  let rawPathPrefix = '';
  if (opts.rawBase) {
    try {
      const baseUrl = new URL(opts.rawBase);
      rawHost = baseUrl.hostname.toLowerCase();
      rawPathPrefix = baseUrl.pathname.replace(/\/+$/, '');
    } catch { /* keep the defaults */ }
  }
  if (host !== 'raw.githubusercontent.com' && host !== rawHost) {
    fail(`notebook url must point at raw.githubusercontent.com: ${url}`);
  }
  // A stub raw base may carry its own path prefix (/raw/…) — strip it
  // so the remaining path is <owner>/<repo>/<branch>/<file>.
  let pathname = u.pathname;
  if (rawPathPrefix && pathname.startsWith(`${rawPathPrefix}/`)) {
    pathname = pathname.slice(rawPathPrefix.length);
  }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 4) fail(`notebook url has no repo path: ${url}`);
  const [owner, repo, branch, ...rest] = segments;
  const repoPath = rest.map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  }).join('/');
  if (!repoPath.toLowerCase().endsWith('.ipynb')) fail(`notebook url must name a .ipynb file: ${url}`);
  const match = (repos ?? []).find(
    (r) => r.owner === owner && r.repo === repo && r.branch === branch,
  );
  if (!match) fail(`notebook url is not under a repo in this proposal: ${url}`);
  return { owner, repo, branch, path: repoPath, repoId: repoIdFor(match) };
}
