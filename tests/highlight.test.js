import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const vendorDir = path.join(root, '..', 'public', 'vendor', 'highlight');
const bundlePath = path.join(vendorDir, 'highlight.min.js');
const cssPath = path.join(vendorDir, 'github-dark.css');
const indexPath = path.join(root, '..', 'public', 'index.html');

// The vendored file is the browser (global) build: load it in a vm
// context the way a <script> tag would, so the test exercises the exact
// bytes the browser runs — not the npm package's CJS entry.
function loadVendoredHljs() {
  const code = fs.readFileSync(bundlePath, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.hljs;
}

const hljs = loadVendoredHljs();

test('vendored highlight.js bundle exists and exposes python/java/javascript', () => {
  assert.ok(fs.existsSync(bundlePath), 'highlight.min.js vendored');
  assert.ok(fs.existsSync(cssPath), 'github-dark.css vendored');
  assert.equal(typeof hljs.highlight, 'function');
  for (const lang of ['python', 'java', 'javascript']) {
    assert.ok(hljs.getLanguage(lang), `${lang} grammar present`);
  }
});

test('python keywords are wrapped in hljs-keyword spans', () => {
  const html = hljs.highlight('def foo(x):\n    return x + 1', { language: 'python' }).value;
  assert.match(html, /<span class="hljs-keyword">def<\/span>/);
  assert.match(html, /<span class="hljs-keyword">return<\/span>/);
  assert.match(html, /<span class="hljs-number">1<\/span>/);
});

test('java keywords are wrapped in hljs-keyword spans', () => {
  const html = hljs.highlight('public class Foo {\n    private int x;\n}', { language: 'java' }).value;
  assert.match(html, /<span class="hljs-keyword">public<\/span>/);
  assert.match(html, /<span class="hljs-keyword">class<\/span>/);
  assert.match(html, /<span class="hljs-keyword">private<\/span>/);
});

test('javascript keywords are wrapped in hljs-keyword spans', () => {
  const html = hljs.highlight('function greet(name) {\n    return `hi ${name}`;\n}', { language: 'javascript' }).value;
  assert.match(html, /<span class="hljs-keyword">function<\/span>/);
  assert.match(html, /<span class="hljs-keyword">return<\/span>/);
});

test('highlighting is HTML-escaped: source text cannot inject markup', () => {
  const html = hljs.highlight('x = "<script>alert(1)</script>"', { language: 'python' }).value;
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test('index.html loads the vendored bundle and theme', () => {
  const index = fs.readFileSync(indexPath, 'utf8');
  assert.match(index, /vendor\/highlight\/highlight\.min\.js/);
  assert.match(index, /vendor\/highlight\/github-dark\.css/);
});

test('vendored theme is the dark palette (readable on the dark code surfaces)', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.match(css, /\.hljs-keyword/);
  assert.match(css, /#ff7b72/); // GitHub Dark keyword colour
  assert.match(css, /background: #0d1117/);
});
