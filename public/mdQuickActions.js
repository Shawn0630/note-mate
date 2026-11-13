/* Quick-action snippets for the markdown editor (right pane).
   Pure functions — no DOM — so they are unit-testable in node.
   mdQuickSnippet(action, before, after, opts) returns { text, selStart,
   selEnd }: the text to insert at the cursor (replacing any selection),
   and the selection offsets, relative to the insertion start, once it is
   in. `before`/`after` are the editor text on either side of the cursor;
   block-level snippets (code, table, divider, page anchor) are padded
   with a blank line when they would otherwise run into surrounding text.
   selStart === selEnd means "place the cursor there"; otherwise the
   range is selected so typing replaces it (link text).
   `opts.date` is today's date (YYYY-MM-DD, Vancouver day, computed by
   the caller); `opts.anchor` is the `<!-- @page N · source: <id> -->`
   string for the current reading position (same format as
   formatPageAnchor in app.js). */
export const MD_QUICK_ACTIONS = [
  { id: 'h3', label: 'H3', title: 'Insert subheading' },
  { id: 'checklist', label: 'Checklist', title: 'Insert checklist item' },
  { id: 'bullet', label: 'Bullet', title: 'Insert bullet' },
  { id: 'code', label: 'Code', title: 'Insert code block' },
  { id: 'table', label: 'Table', title: 'Insert table' },
  { id: 'quote', label: 'Quote', title: 'Insert quote' },
  { id: 'divider', label: 'Divider', title: 'Insert divider' },
  { id: 'link', label: 'Link', title: 'Insert link' },
  { id: 'date', label: 'Date', title: "Insert today's date" },
  { id: 'anchor', label: 'Page anchor', title: 'Insert anchor for the current page' },
  { id: 'screenshot', label: 'Screenshot', title: 'Capture the current page as an image' },
];

export function mdQuickSnippet(action, before = '', after = '', opts = {}) {
  const needBefore = before.length > 0 && !before.endsWith('\n');
  const needAfter = after.length > 0 && !after.startsWith('\n');
  const pre = needBefore ? '\n' : '';
  const post = needAfter ? '\n' : '';
  switch (action) {
    case 'h3': return { text: '### ', selStart: 4, selEnd: 4 };
    case 'checklist': return { text: '- [ ] ', selStart: 6, selEnd: 6 };
    case 'bullet': return { text: '- ', selStart: 2, selEnd: 2 };
    case 'quote': return { text: '> ', selStart: 2, selEnd: 2 };
    case 'code': {
      const text = `${pre}\`\`\`\n\n\`\`\`${post}`;
      const inside = pre.length + 4; // start of the empty line inside the fence
      return { text, selStart: inside, selEnd: inside };
    }
    case 'table': {
      const body = '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |';
      const text = `${pre}${body}${post}`;
      // Cursor in the first empty data cell: after the header row, the
      // separator row, and "| " of the data row.
      const cell = pre.length + '| Column 1 | Column 2 |\n'.length + '| --- | --- |\n'.length + '| '.length;
      return { text, selStart: cell, selEnd: cell };
    }
    case 'divider': {
      const text = `${pre}---${post}`;
      return { text, selStart: pre.length + 3, selEnd: pre.length + 3 };
    }
    case 'link': return { text: '[text](url)', selStart: 1, selEnd: 5 };
    case 'date': {
      if (!opts.date) throw new Error('mdQuickSnippet: date action needs opts.date');
      return { text: opts.date, selStart: opts.date.length, selEnd: opts.date.length };
    }
    case 'anchor': {
      if (!opts.anchor) throw new Error('mdQuickSnippet: anchor action needs opts.anchor');
      const text = `${pre}${opts.anchor}${post}`;
      return { text, selStart: pre.length + opts.anchor.length, selEnd: pre.length + opts.anchor.length };
    }
    default: throw new Error(`mdQuickSnippet: unknown action ${action}`);
  }
}
