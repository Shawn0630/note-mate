import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendAiCall, readAiCalls } from '../src/aiCallLog.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nm-aicalllog-'));
}

function entry(i) {
  return {
    ts: new Date(Date.UTC(2026, 10, 13, 12, 0, i)).toISOString(),
    feature: i % 2 ? 'ai-code' : 'ai-note',
    status: 'ok',
    model: 'stub-model',
    instruction: `prompt ${i}`,
    language: i % 2 ? 'python' : null,
    prompt: `full prompt ${i}`,
    rawResponse: `response ${i}`,
    error: null,
    durationMs: 10 + i,
  };
}

test('append + read: newest-first, limit/offset paging', async () => {
  const dir = await tmpDir();
  for (let i = 0; i < 5; i++) appendAiCall(entry(i), dir);
  const all = readAiCalls({ limit: 10, offset: 0 }, dir);
  assert.equal(all.total, 5);
  assert.deepEqual(all.calls.map((c) => c.instruction), ['prompt 4', 'prompt 3', 'prompt 2', 'prompt 1', 'prompt 0']);
  const page = readAiCalls({ limit: 2, offset: 2 }, dir);
  assert.equal(page.total, 5);
  assert.deepEqual(page.calls.map((c) => c.instruction), ['prompt 2', 'prompt 1']);
  const capped = readAiCalls({ limit: 9999, offset: 0 }, dir);
  assert.equal(capped.calls.length, 5, 'limit is capped at 200');
  await fs.rm(dir, { recursive: true, force: true });
});

test('read: missing file -> empty; corrupt lines skipped', async () => {
  const dir = await tmpDir();
  assert.deepEqual(readAiCalls({}, dir), { total: 0, calls: [] });
  const file = path.join(dir, 'admin', 'ai-calls.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, [
    JSON.stringify(entry(0)),
    'this is not json',
    JSON.stringify({ ...entry(1), feature: 'ai-import' }),
    '{"feature": 42', // unclosed: unparseable, skipped
  ].join('\n') + '\n');
  const out = readAiCalls({}, dir);
  assert.equal(out.total, 2, 'only parseable object lines count');
  assert.equal(out.calls[0].feature, 'ai-import');
  await fs.rm(dir, { recursive: true, force: true });
});

test('append: never throws on an unwritable dir, and never writes a key', async () => {
  const dir = await tmpDir();
  // A file where the admin dir should be makes mkdir fail — must not throw.
  await fs.writeFile(path.join(dir, 'admin'), 'not a dir');
  assert.doesNotThrow(() => appendAiCall(entry(0), dir));
  await fs.rm(dir, { recursive: true, force: true });
});
