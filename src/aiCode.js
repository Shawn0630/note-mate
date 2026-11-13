// On-demand Code AI — the second tab of the AI panel. The user asks in
// plain language for Python code for the notebook they are working in; the
// model returns a PROPOSAL and nothing is written until the user presses
// Apply. With a cell pinned (its ✨ AI button beside the cell), Apply
// REPLACES that cell in place; with no cell pinned, Apply appends a new
// code cell at the end of the notebook. Python notebooks only — Java/JS
// notebooks are out of scope this round. Context: the material currently
// being read (book chapter or deck slides around the current page) + the
// WHOLE notebook (all cells, code and markdown, in order), so the model
// writes code that fits. Same rules as Note AI: proposal only, never
// auto-writes; 503 when the LLM is not configured.

import { generateText, LlmError } from './llm.js';
import { MAX_AI_NOTE_CONTEXT_CHARS, MAX_AI_NOTE_HISTORY_CHARS, MAX_AI_NOTE_HISTORY_MESSAGES } from './aiNote.js';

export const MAX_AI_CODE_PROMPT_CHARS = 2000;
export const MAX_AI_CODE_CELLS_CHARS = 32768;
export const MAX_AI_CODE_RESPONSE_CHARS = 20000;

/**
 * Build the prompt for a Code AI proposal.
 * @param {{bookTitle: string, chapter: {title: string, startPage: number, endPage: number}|null,
 *   sourceLabel: string, page: number|null, readingText: string,
 *   notebookCells: string, prompt: string, hasTargetCell?: boolean,
 *   history?: {role: 'user'|'assistant', content: string}[]}} input
 */
export function buildAiCodePrompt({ bookTitle, chapter, sourceLabel, page, readingText, notebookCells, prompt, hasTargetCell = false, history = [] }) {
  const parts = [
    'You are a coding assistant helping the user write Python code in a Jupyter notebook while they read a book.',
    '',
    `Book: ${bookTitle || 'Untitled'}`,
  ];
  if (chapter) {
    parts.push(`Reading: ${chapter.title} (pages ${chapter.startPage}–${chapter.endPage})`);
  } else if (sourceLabel) {
    parts.push(`Reading: ${sourceLabel}${page != null ? `, page ${page}` : ''}`);
  }
  if (page != null) parts.push(`The user is on page ${page}.`);
  parts.push('', 'HARD RULES:',
    '1. Base the code on the reading material and the notebook below. NEVER invent APIs, data, or facts that are not in them.',
    '2. Reply with ONE ```python fenced code block, then ONE line explaining what the code does. Nothing else — no preamble, no extra fences.',
    '3. The code runs in the notebook\'s shared session alongside the cells below; variables and imports from them are available — do not re-import what is already imported unless the cell needs it.',
    '');
  if (hasTargetCell) {
    parts.push('4. One cell below is marked TARGET — it is the cell the user wants changed. Return its COMPLETE new source: the whole cell, runnable as-is, keeping the same names unless the user asked to change them. Never return only the changed lines.',
      '');
  }
  if (readingText) {
    const truncated = readingText.length > MAX_AI_NOTE_CONTEXT_CHARS;
    parts.push('--- Reading material ---', truncated
      ? `${readingText.slice(0, MAX_AI_NOTE_CONTEXT_CHARS)}\n[reading material truncated]`
      : readingText, '');
  }
  if (notebookCells) {
    parts.push('--- The current notebook (all cells, in order; code and markdown) ---',
      String(notebookCells).slice(0, MAX_AI_CODE_CELLS_CHARS), '');
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
 * Parse a Code AI model reply: the first fenced code block (python or
 * unlabeled) is the code; the first non-empty line after it is the
 * one-line explanation. Returns {code, language: 'python', explanation}.
 * @throws {LlmError} LLM_BAD_RESPONSE when there is no usable code block.
 */
export function parseAiCodeResponse(raw) {
  const text = String(raw ?? '');
  const fail = (msg) => {
    const err = new LlmError('LLM_BAD_RESPONSE', msg);
    err.status = 502;
    throw err;
  };
  if (!text.trim()) fail('model returned no code');
  if (text.length > MAX_AI_CODE_RESPONSE_CHARS) {
    fail(`model output exceeds the ${MAX_AI_CODE_RESPONSE_CHARS}-character limit`);
  }
  const m = text.match(/```(?:python|py)?[ \t]*\n([\s\S]*?)```/);
  if (!m || !m[1].trim()) fail('the model did not return a code block');
  const code = m[1].replace(/\s+$/, '');
  const after = text.slice(m.index + m[0].length).trim();
  const explanation = (after.split('\n').find((l) => l.trim()) || '').trim().slice(0, 500);
  return { code, language: 'python', explanation };
}

/**
 * Generate a Code AI proposal via the LLM. `chapter` is the resolved range
 * from resolveChapterRange / resolvePageRange (or null); `readingText` and
 * `notebookCells` are already capped by the caller.
 */
export async function generateAiCode({ bookTitle, chapter, sourceLabel, page, readingText, notebookCells, prompt, hasTargetCell = false, history = [], model } = {}) {
  const llmPrompt = buildAiCodePrompt({ bookTitle, chapter, sourceLabel, page, readingText, notebookCells, prompt, hasTargetCell, history });
  const raw = await generateText(llmPrompt, { model });
  return parseAiCodeResponse(raw);
}
