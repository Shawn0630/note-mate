// On-demand Code AI — the second tab of the AI panel. The user asks in
// plain language for code for the notebook they are working in; the
// model returns a PROPOSAL and nothing is written until the user presses
// Apply. With a cell pinned (its ✨ AI button beside the cell), Apply
// REPLACES that cell in place; with no cell pinned, Apply appends a new
// code cell at the end of the notebook. Languages: Python, Java and
// JavaScript — Code AI follows the open notebook's language. Context:
// the material currently being read (book chapter or deck slides around
// the current page) + the WHOLE notebook (all cells, code and markdown,
// in order), so the model writes code that fits. Same rules as Note AI:
// proposal only, never auto-writes; 503 when the LLM is not configured.

import { generateText, LlmError } from './llm.js';
import { MAX_AI_NOTE_CONTEXT_CHARS, MAX_AI_NOTE_HISTORY_CHARS, MAX_AI_NOTE_HISTORY_MESSAGES } from './aiNote.js';

export const MAX_AI_CODE_PROMPT_CHARS = 2000;
export const MAX_AI_CODE_CELLS_CHARS = 32768;
export const MAX_AI_CODE_RESPONSE_CHARS = 20000;

export const AI_CODE_LANGUAGES = ['python', 'java', 'javascript'];

/* Per-language prompt facts: the fence label the model must use, the
   intro line, and the rule describing how the cell's code actually runs
   — the model must write code that fits the executor, not just the
   language. Python runs in the notebook's shared session; a Java cell
   is compiled on its own (Main.java → javac → java Main), so it must be
   a complete self-contained program; a JavaScript cell runs as a
   standalone Node script (.mjs). */
const AI_CODE_LANGUAGE_SPECS = {
  python: {
    label: 'Python',
    fence: 'python',
    intro: 'You are a coding assistant helping the user write Python code in a Jupyter notebook while they read a book.',
    runRule: "The code runs in the notebook's shared session alongside the cells below; variables and imports from them are available — do not re-import what is already imported unless the cell needs it.",
  },
  java: {
    label: 'Java',
    fence: 'java',
    intro: 'You are a coding assistant helping the user write Java code in a Jupyter notebook while they read a book.',
    runRule: 'Each cell is compiled and run on its own as a complete program: return a complete, compilable `public class Main` with a `public static void main(String[] args)` method — no package statement and no extra classes. Cells cannot share variables, so the cell must be self-contained.',
  },
  javascript: {
    label: 'JavaScript',
    fence: 'javascript',
    intro: 'You are a coding assistant helping the user write JavaScript code in a Jupyter notebook while they read a book.',
    runRule: 'The code runs as a standalone Node script (ES module, .mjs); top-level await is allowed. Cells run one at a time, so do not rely on variables from other cells.',
  },
};

/** Normalize a requested language to one Code AI supports ('python' when
 * absent or unknown — the route rejects unknown languages first). */
export function normalizeAiCodeLanguage(language) {
  const lang = String(language ?? 'python').toLowerCase();
  return AI_CODE_LANGUAGES.includes(lang) ? lang : 'python';
}

/**
 * Build the prompt for a Code AI proposal.
 * @param {{bookTitle: string, chapter: {title: string, startPage: number, endPage: number}|null,
 *   sourceLabel: string, page: number|null, readingText: string,
 *   notebookCells: string, prompt: string, hasTargetCell?: boolean,
 *   language?: string,
 *   history?: {role: 'user'|'assistant', content: string}[]}} input
 */
export function buildAiCodePrompt({ bookTitle, chapter, sourceLabel, page, readingText, notebookCells, prompt, hasTargetCell = false, language = 'python', history = [] }) {
  const spec = AI_CODE_LANGUAGE_SPECS[normalizeAiCodeLanguage(language)];
  const parts = [
    spec.intro,
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
    `2. Reply with ONE \`\`\`${spec.fence} fenced code block, then ONE line explaining what the code does. Nothing else — no preamble, no extra fences.`,
    `3. ${spec.runRule}`,
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

/* Fence labels accepted per language — the requested language's label,
 * or an unlabeled fence. A fence in another language does not match, so
 * a model that answers in the wrong language fails loudly instead of
 * having its code applied to a cell of the wrong kind. */
const AI_CODE_FENCE_LABELS = {
  python: '(?:python|py)?',
  java: '(?:java)?',
  javascript: '(?:javascript|js)?',
};

/**
 * Parse a Code AI model reply: the first fenced code block in the
 * requested language (or unlabeled) is the code; the first non-empty
 * line after it is the one-line explanation. Returns
 * {code, language, explanation}.
 * @throws {LlmError} LLM_BAD_RESPONSE when there is no usable code block.
 */
export function parseAiCodeResponse(raw, language = 'python') {
  const lang = normalizeAiCodeLanguage(language);
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
  const m = text.match(new RegExp('```' + AI_CODE_FENCE_LABELS[lang] + '[ \\t]*\\n([\\s\\S]*?)```'));
  if (!m || !m[1].trim()) fail('the model did not return a code block');
  const code = m[1].replace(/\s+$/, '');
  const after = text.slice(m.index + m[0].length).trim();
  const explanation = (after.split('\n').find((l) => l.trim()) || '').trim().slice(0, 500);
  return { code, language: lang, explanation };
}

/**
 * Generate a Code AI proposal via the LLM. `chapter` is the resolved range
 * from resolveChapterRange / resolvePageRange (or null); `readingText` and
 * `notebookCells` are already capped by the caller. `language` is the
 * notebook's language ('python' when absent — the old Python-only clients).
 */
export async function generateAiCode({ bookTitle, chapter, sourceLabel, page, readingText, notebookCells, prompt, hasTargetCell = false, language = 'python', history = [], model } = {}) {
  const lang = normalizeAiCodeLanguage(language);
  const llmPrompt = buildAiCodePrompt({ bookTitle, chapter, sourceLabel, page, readingText, notebookCells, prompt, hasTargetCell, language: lang, history });
  const raw = await generateText(llmPrompt, { model });
  return parseAiCodeResponse(raw, lang);
}
