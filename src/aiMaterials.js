// Fill with AI for Materials — the Manage page's "✨ Fill with AI".
// A conversation proposes URL-based materials (YouTube videos + plain
// web links); nothing is written until the user presses Apply in the
// preview. Mirrors the AI import propose/apply split: propose writes
// nothing (503 when the LLM is unconfigured); apply validates strictly
// and dedupes against existing materials by URL.
//
// Pure helpers (no I/O, no Express) plus proposeMaterials, which calls
// the LLM. Unit-tested in tests/aiMaterials.test.js.
import { generateText, unwrapJsonText, LlmError } from './llm.js';
import { extractYoutubeVideoId } from './util.js';

/** A proposal holds at most this many materials; extras are dropped. */
export const MAX_MATERIALS_PROPOSAL = 20;

/** Thread turns sent per propose call — same cap as ai-note history. */
export const MAX_MATERIALS_MESSAGES = 6;

/** Per-message characters sent per propose call. */
export const MAX_MATERIALS_MESSAGE_CHARS = 2000;

export const MATERIALS_AI_PROMPT = `You help add reading materials to a note-taking project.
The user describes materials they want added — YouTube videos, articles, web pages.
Reply with ONLY a JSON object with this exact shape (no markdown fences, no commentary):

{"materials": [{"title": "<short title>", "kind": "video"|"link", "url": "<URL>"}], "note": "<one short line>"}

HARD RULES — violating any of them makes the output unusable:
1. "kind" is "video" ONLY for YouTube video URLs (youtube.com/watch, youtu.be, /shorts/, /live/, /embed/); every other URL is kind "link".
2. Use the URLs the user gave, verbatim, when they gave any. Never change a URL the user pasted.
3. NEVER invent a URL. If the user asks for something by name without giving a URL and you cannot determine its real URL, OMIT that item and say so in "note".
4. Titles are short (under 80 characters) and specific.
5. At most 20 materials. Never propose anything already in the project (listed below).
6. "note" is one short line: what you proposed, or what you could not find.`;

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

export function buildMaterialsPrompt({ projectTitle, existing, messages }) {
  const existingLines = (existing ?? []).length
    ? (existing ?? []).map((m) => `- ${m.label || m.id} (${m.kind}): ${m.url || m.id}`).join('\n')
    : 'None yet.';
  return `${MATERIALS_AI_PROMPT}\n\nProject: ${projectTitle || 'Untitled'}\n\nAlready in the project (do not propose again):\n${existingLines}\n\nConversation:\n${renderMaterialsThread(messages)}`;
}

/**
 * Ask the model for a materials proposal for this thread. Returns the
 * parsed proposal object as-is (the caller normalizes it).
 * @throws {LlmError} LLM_NOT_CONFIGURED (status 503) when no stub and no
 *   key+model; LLM_BAD_RESPONSE (status 400) when the model output is not
 *   parseable JSON — `err.rawText` carries the raw model text.
 */
export async function proposeMaterials({ projectTitle, existing, messages }) {
  const prompt = buildMaterialsPrompt({ projectTitle, existing, messages });
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
  return parsed;
}
