// Python packages for repo-imported notebooks — runtime install,
// not a Dockerfile change.
//
// When Fill with AI imports notebooks from a GitHub repo, their
// third-party imports may not exist in the execution python (the
// container ships python3 + matplotlib + torch/torchvision/scipy).
// The flow is:
//   - propose: scan the downloaded notebooks for third-party imports
//     and check each one against the execution python in ONE
//     subprocess; the proposal lists what is missing.
//   - apply: pip-install the still-missing packages into the running
//     container (per-package results; one failure never fails the
//     apply) and record every success durably under data/
//     (`data/python-packages.json`).
//   - startup: best-effort reinstall any recorded package that is no
//     longer importable (a plain pip install vanishes on the next
//     `docker compose up -d --build`; the record is what survives).
//     Startup never fails over this — a failed reinstall is logged
//     and retried next startup.
//
// The import check and the pip install both run against `python3` on
// PATH — the same interpreter the executor uses. Test hooks accept
// injected `{pythonCmd, runImpl}` so unit tests never spawn pip.
//
// Pure helpers + the subprocess/store functions. Unit-tested in
// tests/pyPackages.test.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The durable record of packages installed at runtime. */
export const RECORDED_PACKAGES_FILE = 'python-packages.json';

/** One import check gets 30s; one pip install 5 minutes. */
export const IMPORT_CHECK_TIMEOUT_MS = 30000;
export const PIP_INSTALL_TIMEOUT_MS = 300000;

/**
 * A pragmatic Python 3.12 stdlib top-level module list — the names a
 * notebook `import` would use. Anything not here and not a repo-local
 * module is third-party. (The full stdlib is ~200 names; this list
 * covers what notebooks actually import. An unknown stdlib name
 * misclassified as third-party is harmless: the import check finds
 * it importable and no install is attempted.)
 */
export const STDLIB_MODULES = new Set([
  'abc', 'argparse', 'array', 'ast', 'asyncio', 'atexit', 'base64',
  'binascii', 'bisect', 'builtins', 'bz2', 'calendar', 'cmath', 'cmd',
  'code', 'codecs', 'codeop', 'collections', 'colorsys', 'compileall',
  'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy',
  'copyreg', 'cProfile', 'csv', 'ctypes', 'curses', 'dataclasses',
  'datetime', 'dbm', 'decimal', 'difflib', 'dis', 'distutils', 'doctest',
  'email', 'encodings', 'enum', 'errno', 'faulthandler', 'fcntl',
  'filecmp', 'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools',
  'gc', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'gzip',
  'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib',
  'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json',
  'keyword', 'lib2to3', 'linecache', 'locale', 'logging', 'lzma',
  'mailbox', 'marshal', 'math', 'mimetypes', 'mmap', 'modulefinder',
  'multiprocessing', 'netrc', 'numbers', 'operator', 'optparse', 'os',
  'ossaudiodev', 'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes',
  'pkgutil', 'platform', 'plistlib', 'poplib', 'posix', 'pprint',
  'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'pyclbr',
  'pydoc', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib',
  'resource', 'rlcompleter', 'runpy', 'sched', 'secrets', 'select',
  'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site',
  'smtpd', 'smtplib', 'sndhdr', 'socket', 'socketserver', 'sqlite3',
  'sre_compile', 'sre_constants', 'sre_parse', 'ssl', 'stat',
  'statistics', 'string', 'stringprep', 'struct', 'subprocess',
  'sunau', 'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny',
  'tarfile', 'telnetlib', 'tempfile', 'termios', 'test', 'textwrap',
  'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize',
  'trace', 'traceback', 'tracemalloc', 'tty', 'turtle', 'types',
  'typing', 'unicodedata', 'unittest', 'urllib', 'uu', 'uuid',
  'venv', 'warnings', 'wave', 'weakref', 'webbrowser', 'winreg',
  'winsound', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc', 'zipapp',
  'zipfile', 'zipimport', 'zlib', '_thread', '__future__',
]);

/**
 * Import name → PyPI package name for the cases where they differ.
 * Anything unlisted installs under its own import name.
 */
export const IMPORT_TO_PACKAGE = {
  PIL: 'pillow',
  sklearn: 'scikit-learn',
  cv2: 'opencv-python',
  yaml: 'PyYAML',
  IPython: 'ipython',
  ipywidgets: 'ipywidgets',
  graphviz: 'graphviz',
  seaborn: 'seaborn',
  nltk: 'nltk',
  regex: 'regex',
  sentencepiece: 'sentencepiece',
  tiktoken: 'tiktoken',
  transformers: 'transformers',
  datasets: 'datasets',
  tqdm: 'tqdm',
  wandb: 'wandb',
  pandas: 'pandas',
  torch: 'torch',
  torchvision: 'torchvision',
  scipy: 'scipy',
  numpy: 'numpy',
  matplotlib: 'matplotlib',
  requests: 'requests',
  bs4: 'beautifulsoup4',
  dotenv: 'python-dotenv',
  dateutil: 'python-dateutil',
  git: 'GitPython',
  lxml: 'lxml',
  Crypto: 'pycryptodome',
  serial: 'pyserial',
  usb: 'pyusb',
};

/** The PyPI package name for an import name (the name itself when
    unmapped). */
export function packageForImport(importName) {
  return IMPORT_TO_PACKAGE[importName] ?? importName;
}

const IMPORT_RE = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
const FROM_IMPORT_RE = /^\s*from\s+([\w.]+)\s+import\b/gm;

/**
 * Scan a parsed notebook object for the top-level modules its code
 * cells import. Returns a Set of first-segment names (`os.path` →
 * `os`, `from sklearn.model_selection import …` → `sklearn`).
 * Best effort: magic commands (`%pip`, `!pip`) and dynamic imports
 * (`__import__`, importlib) are not scanned.
 */
export function scanNotebookImports(nb) {
  const found = new Set();
  const cells = Array.isArray(nb?.cells) ? nb.cells : [];
  for (const cell of cells) {
    if (cell?.cell_type !== 'code') continue;
    const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
    for (const m of src.matchAll(IMPORT_RE)) {
      for (const name of m[1].split(',')) {
        const top = name.trim().split('.')[0];
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(top)) found.add(top);
      }
    }
    for (const m of src.matchAll(FROM_IMPORT_RE)) {
      const top = m[1].split('.')[0];
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(top)) found.add(top);
    }
  }
  return found;
}

/**
 * Split import names into stdlib / repo-local / third-party. Local
 * modules are the importable names of the repo's fetched `.py` files:
 * each file's basename and its dotted path relative to the notebook
 * folder (e.g. `_src/bigram.py` in folder `007_GPT` gives `bigram`
 * and `_src.bigram`).
 */
export function classifyImports(importNames, localModules = []) {
  const local = new Set(localModules ?? []);
  const stdlib = [];
  const localFound = [];
  const thirdParty = [];
  for (const name of importNames ?? []) {
    if (STDLIB_MODULES.has(name)) stdlib.push(name);
    else if (local.has(name)) localFound.push(name);
    else thirdParty.push(name);
  }
  return { stdlib, local: localFound, thirdParty };
}

/** Importable module names for fetched `.py` files, given their
    repo-relative paths and the notebook folders they sit under. */
export function localModuleNames(pyPaths) {
  const out = new Set();
  for (const p of pyPaths ?? []) {
    const base = p.split('/').pop() || '';
    if (!base.toLowerCase().endsWith('.py')) continue;
    const stem = base.slice(0, -3);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(stem)) out.add(stem);
    const dotted = p.slice(0, -3).split('/').join('.');
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(dotted)) out.add(dotted);
    // The path relative to the notebook's own folder: everything
    // after the first segment.
    const parts = p.split('/');
    if (parts.length > 2) {
      const rel = parts.slice(1, -1).concat(stem).join('.');
      if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(rel)) out.add(rel);
    }
  }
  return [...out];
}

const IMPORT_CHECK_SCRIPT = `
import importlib.util, json, sys
out = {}
for name in sys.argv[1:]:
    try:
        out[name] = importlib.util.find_spec(name) is not None
    except Exception:
        out[name] = False
print(json.dumps(out))
`.trim();

function defaultRun(cmd, args, opts) {
  return execFileAsync(cmd, args, { timeout: opts?.timeoutMs ?? IMPORT_CHECK_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
}

/**
 * Check which import names are importable in the execution python, in
 * ONE subprocess. Returns a Map<name, boolean>. Throws when the check
 * itself cannot run (python missing, timeout, unparseable output).
 */
export async function checkImportable(importNames, opts = {}) {
  const names = [...new Set(importNames ?? [])].filter(Boolean);
  if (!names.length) return new Map();
  const pythonCmd = opts.pythonCmd || process.env.NM_PYTHON_CMD || 'python3';
  const run = opts.runImpl || defaultRun;
  let stdout;
  try {
    ({ stdout } = await run(pythonCmd, ['-c', IMPORT_CHECK_SCRIPT, ...names], { timeoutMs: IMPORT_CHECK_TIMEOUT_MS }));
  } catch (err) {
    throw new Error(`could not check installed Python packages: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? '').trim());
  } catch {
    throw new Error('could not check installed Python packages: unexpected output');
  }
  const result = new Map();
  for (const name of names) result.set(name, parsed[name] === true);
  return result;
}

/**
 * pip-install packages into the running container, one at a time.
 * Returns per-package `{package, importName, ok, error}` — a failure
 * never throws, so the caller can report it and continue. Debian's
 * python3 is externally managed (PEP 668), so the install needs
 * --break-system-packages, as in the Dockerfile.
 */
export async function pipInstall(packages, opts = {}) {
  const pythonCmd = opts.pythonCmd || process.env.NM_PYTHON_CMD || 'python3';
  const run = opts.runImpl || defaultRun;
  const results = [];
  for (const pkg of packages ?? []) {
    const packageName = typeof pkg === 'string' ? pkg : pkg.package;
    const importName = typeof pkg === 'string' ? pkg : (pkg.importName || pkg.package);
    try {
      await run(
        pythonCmd,
        ['-m', 'pip', 'install', '--no-cache-dir', '--break-system-packages', packageName],
        { timeoutMs: PIP_INSTALL_TIMEOUT_MS },
      );
      results.push({ package: packageName, importName, ok: true });
    } catch (err) {
      const detail = String(err.stderr || err.stdout || err.message || 'install failed').slice(-500);
      results.push({ package: packageName, importName, ok: false, error: detail.trim() });
    }
  }
  return results;
}

/** Load the recorded-packages file (empty list when absent/corrupt). */
export async function loadRecordedPackages(dataDir) {
  try {
    const raw = await fs.readFile(path.join(dataDir, RECORDED_PACKAGES_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.packages)) return [];
    return parsed.packages.filter(
      (p) => p && typeof p.package === 'string' && p.package,
    ).map((p) => ({
      package: p.package,
      importName: p.importName || p.package,
      ...(typeof p.installedAt === 'string' ? { installedAt: p.installedAt } : {}),
    }));
  } catch {
    return [];
  }
}

/** Record successfully installed packages durably (dedupe by package
    name; atomic write via tmp + rename). */
export async function recordInstalledPackages(dataDir, pkgs) {
  const existing = await loadRecordedPackages(dataDir);
  const seen = new Set(existing.map((p) => p.package.toLowerCase()));
  const now = new Date().toISOString();
  let changed = false;
  for (const pkg of pkgs ?? []) {
    const packageName = typeof pkg === 'string' ? pkg : pkg.package;
    if (!packageName || seen.has(packageName.toLowerCase())) continue;
    seen.add(packageName.toLowerCase());
    existing.push({
      package: packageName,
      importName: (typeof pkg === 'string' ? pkg : pkg.importName) || packageName,
      installedAt: now,
    });
    changed = true;
  }
  if (!changed) return existing;
  const tmp = path.join(dataDir, `${RECORDED_PACKAGES_FILE}.tmp`);
  await fs.writeFile(tmp, JSON.stringify({ version: 1, packages: existing }, null, 2), 'utf8');
  await fs.rename(tmp, path.join(dataDir, RECORDED_PACKAGES_FILE));
  return existing;
}

/**
 * Startup ensure: reinstall any recorded package whose import is no
 * longer importable. Best effort — never throws; every outcome is
 * returned (and logged by the caller) so a failed reinstall is
 * retried next startup.
 */
export async function ensureRecordedPackages(dataDir, opts = {}) {
  const recorded = await loadRecordedPackages(dataDir);
  if (!recorded.length) return { checked: 0, installed: [], failed: [], alreadyPresent: [] };
  let present;
  try {
    present = await checkImportable(recorded.map((p) => p.importName), opts);
  } catch (err) {
    return { checked: recorded.length, installed: [], failed: [{ package: '(import check)', error: err.message }], alreadyPresent: [] };
  }
  const missing = recorded.filter((p) => present.get(p.importName) !== true);
  const alreadyPresent = recorded.filter((p) => present.get(p.importName) === true).map((p) => p.package);
  if (!missing.length) return { checked: recorded.length, installed: [], failed: [], alreadyPresent };
  const results = await pipInstall(missing, opts);
  return {
    checked: recorded.length,
    installed: results.filter((r) => r.ok).map((r) => r.package),
    failed: results.filter((r) => !r.ok).map((r) => ({ package: r.package, error: r.error || 'install failed' })),
    alreadyPresent,
  };
}
