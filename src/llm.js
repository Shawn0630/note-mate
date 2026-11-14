// LLM access for Note Mate.
//
// Two uses, one client:
// 1. AI import — STRUCTURE ONLY (proposeProjectData): derive an outline,
//    a note skeleton (## headings with EMPTY bodies) and the chapter→note
//    mapping from extracted text. It NEVER writes note content.
// 2. On-demand AI notes (generateText): the user asks in plain language
//    for markdown notes based on the current PDF chapter; the model returns
//    markdown which is shown as a proposal and only written on Apply.
//    Markdown notes are the user's own writing — this runs only when he
//    explicitly asks, and only the Apply writes.
//
// Configuration lives in `server/.env` (never committed):
//   LLM_API_KEY        Gemini API key
//   LLM_MODEL          e.g. gemini-2.5-flash
//   LLM_STUB_RESPONSE  tests/verification only: a string returned
//                      instead of calling the API (no key needed) — for
//                      proposeProjectData it must be JSON; for generateText
//                      it is returned verbatim as the markdown.
//   LLM_STUB_MODELS    tests/verification only: comma-separated models the
//                      models endpoint offers while a stub is configured.
// The key is never logged. `LLM_ENV_FILE` overrides the .env path (tests).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendAiCall } from './aiCallLog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV_FILE = path.resolve(__dirname, '..', 'server', '.env');

export const LLM_NOT_CONFIGURED = 'LLM_NOT_CONFIGURED';

/** Error type for LLM failures; `code` is LLM_NOT_CONFIGURED or LLM_BAD_RESPONSE. */
export class LlmError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Parse a simple KEY=VALUE .env file (no interpolation, no export prefix handling beyond stripping it). */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Resolve LLM config: process.env wins, then the .env file (default
 * `server/.env`, overridable with `LLM_ENV_FILE`).
 * Returns `{ apiKey, model, stub }` — all possibly undefined.
 */
export function getLlmConfig() {
  const envFile = process.env.LLM_ENV_FILE || DEFAULT_ENV_FILE;
  let fileVars = {};
  try {
    fileVars = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
  } catch {
    // No .env file — process env alone.
  }
  return {
    apiKey: process.env.LLM_API_KEY || fileVars.LLM_API_KEY || undefined,
    model: process.env.LLM_MODEL || fileVars.LLM_MODEL || undefined,
    stub: process.env.LLM_STUB_RESPONSE || fileVars.LLM_STUB_RESPONSE || undefined,
  };
}

export function isLlmConfigured() {
  const { apiKey, model, stub } = getLlmConfig();
  return Boolean(stub || (apiKey && model));
}

// The STRUCTURE-ONLY prompt. The hard rules are repeated in the prompt
// itself because the model only sees this text, not our code comments.
export const STRUCTURE_ONLY_PROMPT = `You are structuring a reading project from the extracted text of a document.
Return ONLY a JSON object with this exact shape (no markdown fences, no commentary):

{
  "outline": [{"title": "<chapter/section title>", "page": <page number or null>}],
  "noteSkeleton": "<markdown string>",
  "chapterMap": {"<normalized title>": <0-based index of its ## heading in noteSkeleton>}
}

HARD RULES — violating any of them makes the output unusable:
1. noteSkeleton contains ONLY a single top-level "# <title>" line and one "## <chapter title>" heading per outline entry, each followed by an empty line. NO summaries, NO key points, NO bullet points, NO prose of any kind under any heading. The bodies of the headings must be EMPTY — the user writes their own notes.
2. NEVER invent page numbers. Use ONLY page numbers that appear in the extracted text (pages are marked "--- page N ---"). If a chapter's page is uncertain, use null.
3. NEVER invent quotes, facts, or content that is not in the extracted text.
4. chapterMap keys are the outline titles lowercased with punctuation stripped; values are the 0-based index of the matching "##" heading in noteSkeleton.
5. Keep the outline to the document's real top-level chapters/sections only — no sub-sections, no front/back matter (preface, contents, index, bibliography).`;

function buildPrompt({ kind, title, text }) {
  return `${STRUCTURE_ONLY_PROMPT}\n\nDocument kind: ${kind}\nDocument title: ${title}\n\nExtracted text (first pages only; page markers are authoritative):\n${text}`;
}

async function callGemini({ apiKey, model }, prompt, { json = false } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = { contents: [{ parts: [{ text: prompt }] }] };
  if (json) body.generationConfig = { responseMimeType: 'application/json' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new LlmError('LLM_BAD_RESPONSE', `Gemini API error: HTTP ${res.status}`, { status: 502, rawText: bodyText.slice(0, 2000) });
  }
  const jsonBody = await res.json();
  const text = jsonBody?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return text;
}

/**
 * Plain-text generation for on-demand AI notes. Returns the model's reply
 * verbatim (the caller validates it as markdown). With a stub configured,
 * the stub string is returned instead of calling the API.
 * `opts.model` overrides the configured model for this one call (the AI
 * panel's model picker); an unknown override is rejected by the caller —
 * see listModels / isAllowedModel.
 * `opts.log` ({feature, instruction, language?}) records the call in the
 * AI call log (src/aiCallLog.js): prompt sent, raw reply, model, status,
 * duration. Logging never breaks the call and never records credentials.
 * @throws {LlmError} LLM_NOT_CONFIGURED (status 503) when no stub and no
 *   key+model; LLM_BAD_RESPONSE (status 502) on an API error.
 */
export async function generateText(prompt, opts = {}) {
  const { apiKey, model, stub } = getLlmConfig();
  const useModel = typeof opts.model === 'string' && opts.model.trim()
    ? opts.model.trim() : model;
  const log = opts.log && typeof opts.log === 'object' ? opts.log : null;
  const t0 = Date.now();
  const record = (status, rawResponse, error) => {
    if (!log) return;
    try {
      appendAiCall({
        ts: new Date().toISOString(),
        feature: log.feature,
        status,
        model: useModel || null,
        instruction: typeof log.instruction === 'string' ? log.instruction : '',
        language: typeof log.language === 'string' ? log.language : null,
        prompt: String(prompt ?? ''),
        rawResponse: rawResponse ?? null,
        error: error ?? null,
        durationMs: Date.now() - t0,
      });
    } catch { /* logging never breaks the call */ }
  };
  if (stub) {
    record('ok', stub, null);
    return stub;
  }
  if (apiKey && useModel) {
    try {
      const text = await callGemini({ apiKey, model: useModel }, prompt);
      record('ok', text, null);
      return text;
    } catch (err) {
      record('error', err.rawText ?? null, err.message);
      throw err;
    }
  }
  record('not_configured', null, 'LLM not configured');
  throw new LlmError(
    LLM_NOT_CONFIGURED,
    'LLM not configured',
    { status: 503, hint: 'Add LLM_API_KEY and LLM_MODEL to server/.env' },
  );
}

// ---------------------------------------------------------------------------
// Model list — the AI panel's picker. The server reports which models the
// API key can actually use (Gemini models.list, filtered to models that
// support generateContent), with the configured model first. Cached 5 min
// in memory so every panel open is not a network call. When the list call
// fails (or there is no key), the answer degrades to just the configured
// model — the picker then offers only that. With a stub configured (tests
// / verification), LLM_STUB_MODELS (comma-separated) supplies the list so
// the picker can be exercised without a live key.
// ---------------------------------------------------------------------------

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
let modelsCache = null; // {at, result}

export function clearModelsCache() {
  modelsCache = null;
}

/** Short model name: 'models/gemini-2.5-flash' → 'gemini-2.5-flash'. */
export function shortModelName(name) {
  return String(name ?? '').replace(/^models\//, '');
}

function sortModelsFirst(models, first) {
  const rest = models.filter((m) => m !== first).sort();
  return first ? [first, ...rest] : rest;
}

export async function listModels() {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS) {
    return modelsCache.result;
  }
  const { apiKey, model, stub } = getLlmConfig();
  const configured = Boolean(stub || (apiKey && model));
  let models = [];
  if (stub) {
    // Test/verification seam: the stub list is explicit, never invented.
    const stubList = (process.env.LLM_STUB_MODELS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    models = sortModelsFirst(stubList, model);
  } else if (apiKey) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`,
      );
      if (res.ok) {
        const body = await res.json();
        const usable = (Array.isArray(body?.models) ? body.models : [])
          .filter((m) => Array.isArray(m.supportedGenerationMethods)
            && m.supportedGenerationMethods.includes('generateContent'))
          .map((m) => shortModelName(m.name))
          .filter(Boolean);
        models = sortModelsFirst(usable, model);
      }
    } catch {
      // List fetch failed — fall through to the configured model only.
    }
  }
  if (!models.length && model) models = [model];
  const result = { configured, model: model || null, models };
  modelsCache = { at: Date.now(), result };
  return result;
}

/**
 * Whether a client-requested model override may be used: it must be the
 * configured model or one of the listed models. The list is fetched
 * (cached) first; on a list failure only the configured model is allowed.
 */
export async function isAllowedModel(name) {
  if (typeof name !== 'string' || !name.trim()) return false;
  const { models, model } = await listModels();
  return name.trim() === model || models.includes(name.trim());
}

/** Strip ```json / ``` fences if the model wrapped its JSON in them. */
export function unwrapJsonText(text) {
  const t = String(text ?? '').trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1].trim() : t;
}

/**
 * Kind-agnostic AI structure proposal.
 * `kind` is 'pdf' today; slides (LibreOffice-converted PDF text) and video
 * (transcript text) reuse this same function later — only the text extractor
 * differs per kind. See README.md "AI import (structure only)".
 *
 * @param {{kind: string, title: string, text: string}} input
 * @returns {Promise<{outline: {title: string, page: number|null}[], noteSkeleton: string, chapterMap: Record<string, number>}>}
 * @throws {LlmError} LLM_NOT_CONFIGURED (status 503) when no stub and no
 *   key+model; LLM_BAD_RESPONSE (status 400) when the model output is not
 *   parseable JSON — `err.rawText` carries the raw model text for debugging.
 */
export async function proposeProjectData({ kind, title, text }, opts = {}) {
  const { apiKey, model, stub } = getLlmConfig();
  const prompt = buildPrompt({ kind, title, text });
  const log = opts.log && typeof opts.log === 'object' ? opts.log : null;
  const t0 = Date.now();
  const record = (status, rawResponse, error) => {
    if (!log) return;
    try {
      appendAiCall({
        ts: new Date().toISOString(),
        feature: log.feature,
        status,
        model: model || null,
        instruction: typeof log.instruction === 'string' ? log.instruction : '',
        language: null,
        prompt,
        rawResponse: rawResponse ?? null,
        error: error ?? null,
        durationMs: Date.now() - t0,
      });
    } catch { /* logging never breaks the call */ }
  };
  let rawText;
  if (stub) {
    rawText = stub;
  } else if (apiKey && model) {
    try {
      rawText = await callGemini({ apiKey, model }, prompt, { json: true });
    } catch (err) {
      record('error', err.rawText ?? null, err.message);
      throw err;
    }
  } else {
    record('not_configured', null, 'LLM not configured');
    throw new LlmError(
      LLM_NOT_CONFIGURED,
      'LLM not configured',
      { status: 503, hint: 'Add LLM_API_KEY and LLM_MODEL to server/.env' },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(unwrapJsonText(rawText));
  } catch {
    record('error', rawText, 'Model output was not valid JSON');
    throw new LlmError('LLM_BAD_RESPONSE', 'Model output was not valid JSON', { status: 400, rawText });
  }
  record('ok', rawText, null);
  return parsed;
}
