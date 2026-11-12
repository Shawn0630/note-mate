// On-demand AI notes — propose markdown notes for the current PDF chapter.
//
// This is the OTHER AI surface, distinct from AI import (src/aiImport.js):
// - AI import generates STRUCTURE ONLY (outline + headings-only skeleton +
//   chapterMap) when a project is created. It never writes note content.
// - AI notes generate CONTENT, but ONLY when the user explicitly asks in
//   the notebook pane's Ask AI panel, and ONLY as a proposal: the markdown
//   is shown as a preview and written into notes.md only when the user
//   presses Apply (client-side, through the existing notes PUT path).
//   Markdown notes are the user's own writing — this never writes by itself.
//
// Pure helpers (no I/O, no Express) plus generateAiNote, which calls the
// LLM through src/llm.js generateText. Unit-tested in tests/aiNote.test.js.
import { normalizeHeading, matchOutlineToHeadings } from './util.js';
import { generateText } from './llm.js';

export const MAX_AI_NOTE_PROMPT_CHARS = 2000;
export const MAX_AI_NOTE_CONTEXT_CHARS = 30000;
export const MAX_AI_NOTE_NOTE_CHARS = 4000;
export const MAX_AI_NOTE_RESPONSE_CHARS = 20000;
export const MAX_AI_NOTE_HISTORY_MESSAGES = 6;
export const MAX_AI_NOTE_HISTORY_CHARS = 2000;
export const MAX_CHAPTER_PAGES = 40;

/** Parse `##` / `###` headings from markdown text → [{text, norm, line}]. */
export function headingsFromMarkdownText(text) {
  const out = [];
  String(text || '').split('\n').forEach((line, i) => {
    const m = line.match(/^#{2,3}\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ text: m[1].trim(), norm: normalizeHeading(m[1]), line: i });
  });
  return out;
}

/**
 * Resolve a chapter title against a stored outline [{title, page, depth?}]
 * to a page range. Returns `{title, startPage, endPage}` where endPage is
 * the page before the next outline entry AT THE SAME OR A LOWER DEPTH
 * (a subsection does not end its parent chapter — Transformers runs to
 * the next chapter, not to its first subsection), or numPages for the
 * last such entry (or null when numPages is unknown), or null when the
 * chapter has no match or no page number. Entries without a depth count
 * as depth 0 (the stored-outline shape from AI import).
 */
export function resolveChapterRange(outline, chapterTitle, numPages) {
  if (!Array.isArray(outline) || !outline.length) return null;
  const idx = matchOutlineToHeadings([chapterTitle], outline.map((o) => o.title ?? ''))[0];
  if (idx === null || idx === undefined) return null;
  const entry = outline[idx];
  const startPage = entry.page;
  if (!Number.isInteger(startPage) || startPage < 1) return null;
  const depth = entry.depth ?? 0;
  let endPage = Number.isInteger(numPages) ? numPages : null;
  for (let j = idx + 1; j < outline.length; j++) {
    const next = outline[j];
    if (Number.isInteger(next.page) && next.page > startPage && (next.depth ?? 0) <= depth) {
      endPage = next.page - 1;
      break;
    }
  }
  if (endPage !== null) endPage = Math.max(startPage, endPage);
  return { title: entry.title, startPage, endPage };
}

/**
 * Range around a single page of a PDF — the slide-deck case: the outline
 * section containing the page (the greatest entry at or before it) through
 * the next entry's page minus one. When the outline has no entry at or
 * before the page (e.g. a title page ahead of the first bookmark), falls
 * back to a small window around the page. numPages is optional; when it is
 * unknown and there is no next entry, endPage is null (open-ended — the
 * extractor caps the page count itself).
 */
export function resolvePageRange(outline, page, numPages, { before = 2, after = 5 } = {}) {
  const p = Number(page);
  if (!Number.isInteger(p) || p < 1) return null;
  const entries = (Array.isArray(outline) ? outline : [])
    .filter((e) => Number.isInteger(e?.page) && e.page >= 1);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].page <= p) {
      const startPage = entries[i].page;
      let endPage = null;
      if (i + 1 < entries.length && Number.isInteger(entries[i + 1].page)) {
        endPage = entries[i + 1].page - 1;
      } else if (Number.isInteger(numPages)) {
        endPage = numPages;
      }
      if (endPage !== null) endPage = Math.max(startPage, endPage);
      return { title: entries[i].title ?? null, startPage, endPage };
    }
  }
  const startPage = Math.max(1, p - before);
  const endPage = Number.isInteger(numPages) ? Math.max(startPage, Math.min(numPages, p + after)) : p + after;
  return { title: null, startPage, endPage };
}

/**
 * Extract the text under a ## heading in a markdown note (up to the next
 * ## heading or EOF). Returns '' when the heading is not found.
 */
export function extractChapterSection(notesText, headingTitle) {
  const lines = String(notesText || '').split('\n');
  const headings = headingsFromMarkdownText(notesText);
  const idx = matchOutlineToHeadings([headingTitle], headings.map((h) => h.text))[0];
  if (idx === null || idx === undefined) return '';
  const start = headings[idx].line + 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

/**
 * Insert `markdown` at the end of the section under the ## heading matching
 * `headingTitle` (the shared chapter <-> heading rule). When the heading
 * does not exist, append a new `## <headingTitle>` section at the end —
 * with `headingAnchor` (e.g. `<!-- p. 31 -->`) right under it when given,
 * so a heading created on demand carries its page anchor like the seeded
 * ones do. Returns `{text, inserted}` — `inserted` is false when the exact
 * block is already present in that section, so applying the same proposal
 * twice never duplicates it. The frontend ports this function verbatim (see
 * public/app.js insertMarkdownUnderHeading).
 */
export function insertMarkdownUnderHeading(notesText, headingTitle, markdown, headingAnchor = null) {
  const block = String(markdown || '').trim();
  if (!block) return { text: String(notesText ?? ''), inserted: false };
  const lines = String(notesText ?? '').split('\n');
  const headings = headingsFromMarkdownText(notesText);
  const idx = matchOutlineToHeadings([headingTitle], headings.map((h) => h.text))[0];
  if (idx === null || idx === undefined) {
    const base = String(notesText ?? '');
    const sep = base && !base.endsWith('\n') ? '\n' : '';
    const gap = base && !base.endsWith('\n\n') ? '\n' : '';
    const anchorLine = headingAnchor ? `${String(headingAnchor).trim()}\n\n` : '';
    return {
      text: `${base}${sep}${gap}## ${headingTitle}\n\n${anchorLine}${block}\n`,
      inserted: true,
    };
  }
  const start = headings[idx].line + 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  const section = lines.slice(start, end).join('\n');
  if (section.includes(block)) return { text: String(notesText ?? ''), inserted: false };
  // Insert at the end of the section, keeping a blank line around the block.
  const before = lines.slice(0, end);
  while (before.length && before[before.length - 1].trim() === '') before.pop();
  const after = lines.slice(end);
  const out = [...before, '', block, '', ...after];
  return { text: out.join('\n'), inserted: true };
}

/** Strip one wrapping ``` / ```markdown fence from model output. */
export function stripMarkdownFences(text) {
  const t = String(text ?? '').trim();
  const m = t.match(/^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return m ? m[1].trim() : t;
}

/**
 * Demote `#` / `##` headings inside a proposal to `###`. An AI note is
 * inserted UNDER a chapter's `##` heading, so a `##` inside the note would
 * split the chapter section on the next insert — the note keeps its own
 * subheadings one level down instead.
 */
export function demoteHeadings(markdown) {
  return String(markdown ?? '')
    .split('\n')
    .map((line) => line.replace(/^(#{1,2})\s+/, '### '))
    .join('\n');
}

/**
 * Validate model output as a markdown note proposal. Returns the normalized
 * markdown (fences stripped, headings demoted) or throws an Error with
 * `status = 400`.
 */
export function validateAiNoteMarkdown(raw) {
  const fail = (msg) => {
    const err = new Error(msg);
    err.status = 400;
    throw err;
  };
  if (typeof raw !== 'string') fail('model output must be markdown text');
  const markdown = demoteHeadings(stripMarkdownFences(raw)).trim();
  if (!markdown) fail('model returned no markdown');
  if (markdown.length > MAX_AI_NOTE_RESPONSE_CHARS) {
    fail(`model output exceeds the ${MAX_AI_NOTE_RESPONSE_CHARS}-character limit`);
  }
  // The model returning the JSON proposal shape is the wrong endpoint's
  // output — never treat it as a note.
  if (/^\{/.test(markdown)) {
    let parsed = null;
    try {
      parsed = JSON.parse(markdown);
    } catch {
      parsed = null; // Not JSON — it is markdown that happens to start with {.
    }
    if (parsed && typeof parsed === 'object' && ('outline' in parsed || 'noteSkeleton' in parsed)) {
      fail('model returned a project proposal, not markdown notes');
    }
  }
  return markdown;
}

const NOTE_PROMPT_RULES = `HARD RULES:
1. Base EVERYTHING on the chapter text below. NEVER invent page numbers, quotes, formulas, or facts that are not in it. If the chapter does not cover something the user asked for, say so in one line instead of inventing it.
2. Respond with ONLY the markdown note content — no preamble, no "Here is your summary", no code fences around the whole reply.
3. Use ### (or lower) for any subheadings inside your note — never # or ##.
4. Keep it focused on what the user asked for; do not pad it with unrelated chapter content.`;

/**
 * Build the prompt for an on-demand AI note.
 * @param {{bookTitle: string, chapter: {title: string, startPage: number, endPage: number}|null,
 *   chapterText: string, noteSection: string, prompt: string,
 *   history?: {role: 'user'|'assistant', content: string}[]}} input
 */
export function buildAiNotePrompt({ bookTitle, chapter, chapterText, noteSection, prompt, history = [] }) {
  const parts = [
    'You are a study-note assistant. Write markdown notes for the user, based on the reading material below.',
    '',
    `Book: ${bookTitle || 'Untitled'}`,
  ];
  if (chapter) {
    parts.push(`Chapter: ${chapter.title} (pages ${chapter.startPage}–${chapter.endPage})`);
  } else {
    parts.push('Chapter: none selected — no chapter text is attached; answer from the user\'s request and their notes only.');
  }
  parts.push('', NOTE_PROMPT_RULES, '');
  if (chapterText) {
    const truncated = chapterText.length > MAX_AI_NOTE_CONTEXT_CHARS;
    parts.push('--- Chapter text ---', truncated
      ? `${chapterText.slice(0, MAX_AI_NOTE_CONTEXT_CHARS)}\n[chapter text truncated]`
      : chapterText, '');
  }
  if (noteSection) {
    parts.push('--- The user\'s existing notes for this chapter (build on them; do not repeat them verbatim) ---',
      noteSection.slice(0, MAX_AI_NOTE_NOTE_CHARS), '');
  }
  const turns = (Array.isArray(history) ? history : [])
    .slice(-MAX_AI_NOTE_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '').slice(0, MAX_AI_NOTE_HISTORY_CHARS) }))
    .filter((m) => m.content.trim());
  if (turns.length) {
    parts.push('--- Earlier in this conversation ---');
    for (const t of turns) parts.push(`${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.content}`);
    parts.push('');
  }
  parts.push(`--- What the user wants ---\n${prompt}`);
  return parts.join('\n');
}

/**
 * Generate an AI note proposal via the LLM. `chapter` is the resolved range
 * from resolveChapterRange (or null); `chapterText`/`noteSection` are
 * already capped by the caller. Returns the validated markdown.
 */
export async function generateAiNote({ bookTitle, chapter, chapterText, noteSection, prompt, history = [] }) {
  const llmPrompt = buildAiNotePrompt({ bookTitle, chapter, chapterText, noteSection, prompt, history });
  const raw = await generateText(llmPrompt);
  return validateAiNoteMarkdown(raw);
}
