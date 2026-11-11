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
// The key is never logged. `LLM_ENV_FILE` overrides the .env path (tests).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * @throws {LlmError} LLM_NOT_CONFIGURED (status 503) when no stub and no
 *   key+model; LLM_BAD_RESPONSE (status 502) on an API error.
 */
export async function generateText(prompt) {
  const { apiKey, model, stub } = getLlmConfig();
  if (stub) return stub;
  if (apiKey && model) return callGemini({ apiKey, model }, prompt);
  throw new LlmError(
    LLM_NOT_CONFIGURED,
    'LLM not configured',
    { status: 503, hint: 'Add LLM_API_KEY and LLM_MODEL to server/.env' },
  );
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
export async function proposeProjectData({ kind, title, text }) {
  const { apiKey, model, stub } = getLlmConfig();
  let rawText;
  if (stub) {
    rawText = stub;
  } else if (apiKey && model) {
    rawText = await callGemini({ apiKey, model }, buildPrompt({ kind, title, text }), { json: true });
  } else {
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
    throw new LlmError('LLM_BAD_RESPONSE', 'Model output was not valid JSON', { status: 400, rawText });
  }
  return parsed;
}
