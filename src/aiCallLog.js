// AI call log — append-only JSONL, local only (the AV admin.html model).
// Stored under data/admin/ai-calls.jsonl (gitignored data/, never in the
// data export). Entries carry the prompt sent to the model and its raw
// response, never credentials: the API key lives in the request URL, not
// the prompt, and is never recorded here. Logging must never break the
// call itself — appends are best-effort and reads skip corrupt lines.
import fs from 'node:fs';
import path from 'node:path';

export const AI_CALLS_FILE = 'ai-calls.jsonl';
export const AI_CALL_FEATURES = ['ai-note', 'ai-code', 'ai-import'];
export const AI_CALL_STATUSES = ['ok', 'error', 'not_configured'];

export function adminDir(dataDir) {
  return path.join(dataDir || process.env.DATA_DIR || 'data', 'admin');
}

export function aiCallsPath(dataDir) {
  return path.join(adminDir(dataDir), AI_CALLS_FILE);
}

/**
 * One log entry. `feature` is which AI surface called the model;
 * `instruction` is the user's own request (the ai-note / ai-code prompt,
 * or the imported document's title); `prompt` is the full text sent to
 * the model; `rawResponse` is the model's verbatim reply (null when no
 * call was made, e.g. not_configured).
 */
export function appendAiCall(entry, dataDir) {
  try {
    const dir = adminDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const clean = {
      ts: typeof entry?.ts === 'string' ? entry.ts : new Date().toISOString(),
      feature: typeof entry?.feature === 'string' ? entry.feature : 'unknown',
      status: AI_CALL_STATUSES.includes(entry?.status) ? entry.status : 'error',
      model: typeof entry?.model === 'string' && entry.model ? entry.model : null,
      instruction: typeof entry?.instruction === 'string' ? entry.instruction : '',
      language: typeof entry?.language === 'string' && entry.language ? entry.language : null,
      prompt: typeof entry?.prompt === 'string' ? entry.prompt : '',
      rawResponse: typeof entry?.rawResponse === 'string' ? entry.rawResponse : null,
      error: typeof entry?.error === 'string' && entry.error ? entry.error : null,
      durationMs: Number.isInteger(entry?.durationMs) && entry.durationMs >= 0 ? entry.durationMs : 0,
    };
    fs.appendFileSync(aiCallsPath(dataDir), `${JSON.stringify(clean)}\n`, 'utf8');
    return clean;
  } catch (err) {
    // Logging must never break the assistant itself.
    console.error('Failed to write AI call log:', err.message);
    return null;
  }
}

/** Newest first, paged. Missing file or corrupt lines → empty / skipped. */
export function readAiCalls({ limit = 20, offset = 0 } = {}, dataDir) {
  try {
    const lines = fs.readFileSync(aiCallsPath(dataDir), 'utf8')
      .split('\n').filter((line) => line.trim());
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip a corrupt line */ }
    }
    const newestFirst = entries.reverse();
    const safeLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 20, 200));
    const safeOffset = Math.max(0, Number.isInteger(offset) ? offset : 0);
    return { calls: newestFirst.slice(safeOffset, safeOffset + safeLimit), total: newestFirst.length };
  } catch {
    return { calls: [], total: 0 };
  }
}
