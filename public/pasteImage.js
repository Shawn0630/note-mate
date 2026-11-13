/* Screenshot-in-markdown helpers for pasting images into a note.
   Pure functions — no DOM — so they are unit-testable in node.
   - imageMarkdownRef(fileName): the `![...](assets/...)` reference the
     note stores (relative, portable — it resolves when the file lives in
     notes/ and the app rewrites it to the asset API at render time).
   - appendImageEdit(text, ref): the edit that appends the reference at
     the END of the note — {start, end, text} to replace in the editor so
     the reference lands on its own line with a blank line before it
     (trailing blank lines of the note collapse into that one blank line).
   - embedAssetsInMarkdown(text, fetchAsset): the export step — every
     local `assets/<file>` reference in the text is replaced by the
     base64 data URI fetchAsset(file) returns, so the exported .md shows
     the image when opened elsewhere. External URLs and data: URIs are
     left as-is; a file that cannot be fetched keeps its original
     reference instead of breaking the export. fetchAsset is called at
     most once per distinct file. */

export function imageMarkdownRef(fileName) {
  return `![screenshot](assets/${fileName})`;
}

export function appendImageEdit(text, ref) {
  const body = text || '';
  if (!body.trim()) return { start: 0, end: 0, text: `${ref}\n` };
  const trimmedEnd = body.replace(/\n+$/, '').length;
  return { start: trimmedEnd, end: body.length, text: `\n\n${ref}\n` };
}

const ASSET_REF_RE = /!\[([^\]]*)\]\(assets\/([A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g))\)/g;

export async function embedAssetsInMarkdown(text, fetchAsset) {
  const files = [...new Set([...(text.matchAll(ASSET_REF_RE))].map((m) => m[2]))];
  if (!files.length) return text;
  const dataUrls = new Map();
  for (const file of files) {
    try {
      const url = await fetchAsset(file);
      if (typeof url === 'string' && url.startsWith('data:image/')) dataUrls.set(file, url);
    } catch {
      // Unfetchable — keep the original reference, never break the export.
    }
  }
  if (!dataUrls.size) return text;
  return text.replace(ASSET_REF_RE, (m, alt, file) => {
    const url = dataUrls.get(file);
    return url ? `![${alt}](${url})` : m;
  });
}
