import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeProjectData, parseEnvFile, unwrapJsonText } from '../src/llm.js';

const STUB_PROPOSAL = {
  outline: [{ title: 'Introduction', page: 1 }],
  noteSkeleton: '# Stub Book\n\n## 1. Introduction\n\n',
  chapterMap: { introduction: 0 },
};

test('parseEnvFile: KEY=VALUE lines, comments, quotes', () => {
  const vars = parseEnvFile('# comment\nLLM_API_KEY=abc123\nLLM_MODEL="gemini-2.5-flash"\nEMPTY=\n');
  assert.equal(vars.LLM_API_KEY, 'abc123');
  assert.equal(vars.LLM_MODEL, 'gemini-2.5-flash');
  assert.equal(vars.EMPTY, '');
});

test('unwrapJsonText: strips ```json fences', () => {
  assert.equal(unwrapJsonText('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unwrapJsonText('{"a":1}'), '{"a":1}');
});

test('proposeProjectData: LLM_STUB_RESPONSE is returned parsed (no network, no key)', async () => {
  const prev = process.env.LLM_STUB_RESPONSE;
  const prevFile = process.env.LLM_ENV_FILE;
  process.env.LLM_STUB_RESPONSE = JSON.stringify(STUB_PROPOSAL);
  process.env.LLM_ENV_FILE = '/nonexistent/none.env';
  try {
    const out = await proposeProjectData({ kind: 'pdf', title: 'Stub Book', text: '--- page 1 ---\nhello' });
    assert.deepEqual(out, STUB_PROPOSAL);
  } finally {
    if (prev === undefined) delete process.env.LLM_STUB_RESPONSE; else process.env.LLM_STUB_RESPONSE = prev;
    if (prevFile === undefined) delete process.env.LLM_ENV_FILE; else process.env.LLM_ENV_FILE = prevFile;
  }
});

test('proposeProjectData: no stub and no key/model -> LLM_NOT_CONFIGURED', async () => {
  const saved = {
    stub: process.env.LLM_STUB_RESPONSE,
    key: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
    file: process.env.LLM_ENV_FILE,
  };
  delete process.env.LLM_STUB_RESPONSE;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  process.env.LLM_ENV_FILE = '/nonexistent/none.env';
  try {
    await assert.rejects(
      proposeProjectData({ kind: 'pdf', title: 'X', text: 'text' }),
      (err) => err.code === 'LLM_NOT_CONFIGURED' && err.status === 503,
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      const envKey = { stub: 'LLM_STUB_RESPONSE', key: 'LLM_API_KEY', model: 'LLM_MODEL', file: 'LLM_ENV_FILE' }[k];
      if (v === undefined) delete process.env[envKey]; else process.env[envKey] = v;
    }
  }
});

test('proposeProjectData: stub that is not JSON -> LLM_BAD_RESPONSE with raw text', async () => {
  const prev = process.env.LLM_STUB_RESPONSE;
  const prevFile = process.env.LLM_ENV_FILE;
  process.env.LLM_STUB_RESPONSE = 'not json at all';
  process.env.LLM_ENV_FILE = '/nonexistent/none.env';
  try {
    await assert.rejects(
      proposeProjectData({ kind: 'pdf', title: 'X', text: 'text' }),
      (err) => err.code === 'LLM_BAD_RESPONSE' && err.rawText === 'not json at all',
    );
  } finally {
    if (prev === undefined) delete process.env.LLM_STUB_RESPONSE; else process.env.LLM_STUB_RESPONSE = prev;
    if (prevFile === undefined) delete process.env.LLM_ENV_FILE; else process.env.LLM_ENV_FILE = prevFile;
  }
});

test('listModels: stub mode offers LLM_STUB_MODELS, configured first', async () => {
  const { listModels, clearModelsCache } = await import('../src/llm.js');
  const saved = {
    stub: process.env.LLM_STUB_RESPONSE,
    models: process.env.LLM_STUB_MODELS,
    model: process.env.LLM_MODEL,
    file: process.env.LLM_ENV_FILE,
  };
  process.env.LLM_STUB_RESPONSE = 'stub';
  process.env.LLM_STUB_MODELS = 'gemini-2.5-pro,gemini-2.0-flash';
  process.env.LLM_MODEL = 'gemini-2.5-flash';
  process.env.LLM_ENV_FILE = '/nonexistent/none.env';
  clearModelsCache();
  try {
    const out = await listModels();
    assert.equal(out.configured, true);
    assert.equal(out.model, 'gemini-2.5-flash');
    assert.deepEqual(out.models, ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro']);
  } finally {
    clearModelsCache();
    for (const [k, v] of Object.entries(saved)) {
      const envKey = { stub: 'LLM_STUB_RESPONSE', models: 'LLM_STUB_MODELS', model: 'LLM_MODEL', file: 'LLM_ENV_FILE' }[k];
      if (v === undefined) delete process.env[envKey]; else process.env[envKey] = v;
    }
  }
});

test('listModels: no stub, no key -> unconfigured, no models', async () => {
  const { listModels, clearModelsCache } = await import('../src/llm.js');
  const saved = {
    stub: process.env.LLM_STUB_RESPONSE,
    key: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
    file: process.env.LLM_ENV_FILE,
  };
  delete process.env.LLM_STUB_RESPONSE;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  process.env.LLM_ENV_FILE = '/nonexistent/none.env';
  clearModelsCache();
  try {
    const out = await listModels();
    assert.equal(out.configured, false);
    assert.equal(out.model, null);
    assert.deepEqual(out.models, []);
  } finally {
    clearModelsCache();
    for (const [k, v] of Object.entries(saved)) {
      const envKey = { stub: 'LLM_STUB_RESPONSE', key: 'LLM_API_KEY', model: 'LLM_MODEL', file: 'LLM_ENV_FILE' }[k];
      if (v === undefined) delete process.env[envKey]; else process.env[envKey] = v;
    }
  }
});

test('generateText: model override is used in the Gemini URL', async () => {
  const { generateText } = await import('../src/llm.js');
  const saved = {
    stub: process.env.LLM_STUB_RESPONSE,
    key: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
    file: process.env.LLM_ENV_FILE,
  };
  delete process.env.LLM_STUB_RESPONSE;
  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_MODEL = 'gemini-2.5-flash';
  process.env.LLM_ENV_FILE = '/nonexistent/none.env';
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push(String(url));
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }),
    };
  };
  try {
    const out = await generateText('hi', { model: 'gemini-2.5-pro' });
    assert.equal(out, 'hello');
    assert.equal(seen.length, 1);
    assert.ok(seen[0].includes('/models/gemini-2.5-pro:generateContent'), seen[0]);
    assert.ok(!seen[0].includes('gemini-2.5-flash'), seen[0]);
    // No override -> the configured model.
    const out2 = await generateText('hi');
    assert.equal(out2, 'hello');
    assert.ok(seen[1].includes('/models/gemini-2.5-flash:generateContent'), seen[1]);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      const envKey = { stub: 'LLM_STUB_RESPONSE', key: 'LLM_API_KEY', model: 'LLM_MODEL', file: 'LLM_ENV_FILE' }[k];
      if (v === undefined) delete process.env[envKey]; else process.env[envKey] = v;
    }
  }
});

test('isAllowedModel: configured or listed only', async () => {
  const { isAllowedModel, clearModelsCache } = await import('../src/llm.js');
  const saved = {
    stub: process.env.LLM_STUB_RESPONSE,
    models: process.env.LLM_STUB_MODELS,
    model: process.env.LLM_MODEL,
    file: process.env.LLM_ENV_FILE,
  };
  process.env.LLM_STUB_RESPONSE = 'stub';
  process.env.LLM_STUB_MODELS = 'gemini-2.5-pro';
  process.env.LLM_MODEL = 'gemini-2.5-flash';
  process.env.LLM_ENV_FILE = '/nonexistent/none.env';
  clearModelsCache();
  try {
    assert.equal(await isAllowedModel('gemini-2.5-flash'), true);
    assert.equal(await isAllowedModel('gemini-2.5-pro'), true);
    assert.equal(await isAllowedModel('gemini-1.0-ultra'), false);
    assert.equal(await isAllowedModel(''), false);
    assert.equal(await isAllowedModel(null), false);
  } finally {
    clearModelsCache();
    for (const [k, v] of Object.entries(saved)) {
      const envKey = { stub: 'LLM_STUB_RESPONSE', models: 'LLM_STUB_MODELS', model: 'LLM_MODEL', file: 'LLM_ENV_FILE' }[k];
      if (v === undefined) delete process.env[envKey]; else process.env[envKey] = v;
    }
  }
});
