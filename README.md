# Note Mate

Reading + notebook app: a bookshelf of reading projects, with a PDF / video /
slides reader on the left and an executable notebook on the right.

Backend: Node ESM + Express, file-based storage under `data/` (no database).
Frontend lives in `public/` (separate owner). Port **9300**.

## Quick start

```bash
npm install
npm run seed     # downloads the example book (Understanding Deep Learning)
npm start        # -> http://localhost:9300
```

Environment:

| Variable   | Default | Meaning                              |
| ---------- | ------- | ------------------------------------ |
| `PORT`     | `9300`  | HTTP port                            |
| `DATA_DIR` | `./data`| Where projects live (see Data layout)|

## Docker

```bash
docker compose up --build -d
# -> http://localhost:9300
```

The image (`Dockerfile`) is `node:22-bookworm-slim` plus the runtimes the
`/api/execute` endpoint needs: `python3` + `python3-matplotlib` (plots),
PyTorch (CPU) + `torchvision` + `scipy` via pip (the UDL labs import them;
costs roughly +800MB–1GB on the image), and `openjdk-17-jdk-headless`
(`javac`/`java`). LibreOffice (`libreoffice-impress`)
is also installed so PPTX slide decks can be converted to PDF inside the
container; it costs roughly +500MB on the image, traded for renderable slides.

### iCloud sync (Mac)

`docker-compose.yml` bind-mounts `./data` into the container at `/app/data`.
To keep that data in iCloud Drive instead, create
**`docker-compose.override.yml`** next to `docker-compose.yml` (Compose
auto-loads it — no `-f` flag needed):

```yaml
services:
  note-mate:
    volumes:
      - ${HOME}/Library/Mobile Documents/com~apple~CloudDocs/NoteMate/data:/app/data
```

First create the folder in Finder (or `mkdir -p`) at
`~/Library/Mobile Documents/com~apple~CloudDocs/NoteMate/data` — that is the
iCloud Drive folder `NoteMate/data`. Then `docker compose up -d` as usual;
the override replaces the `./data` mount. The `data/` directory in this repo
is git-ignored, so either location stays out of the repo.

## Data layout

```
data/
  projects/
    <slug>/
      project.json        # {slug, title, author, kind, sourceType, file?, sourceUrl?,
                          #  cover, materials[], outline?, chapterMap, links,
                          #  createdAt, updatedAt}
      source.pdf          # or source.mp4, source.pptx, ... (file projects)
      cover.png           # optional, set via POST .../cover
      slides/             # lecture decks: <name>.pptx (source) + <name>.pdf (renderable)
      notes/
        notes.md          # starter note, created with every project
        *.ipynb           # Jupyter notebooks (Python kernel; see below)
        labs/             # Python lab notebooks, fetched as-is from the book's repo
          Chap01/
            1_1_....ipynb
          ...
```

`kind` is `pdf | video | slides | ppt`; `sourceType` is `file | url`.
URL projects store no file — `GET .../file` 302-redirects to `sourceUrl`.

### Materials

`project.json` `materials[]` lists secondary reading material for a project
— currently the lecture-slide decks. Each entry is
`{id, label, kind: 'pdf'|'slides'|'video'|'url', file?, sourceFile?, sourceUrl?}`:

- `file` — path (relative to the project dir) of the renderable PDF, e.g.
  `slides/UDLChap2.pdf`. Absent/null when no renderable PDF exists yet —
  the reader then shows the deck as a download card instead of faking a render.
- `sourceFile` — the original file kept alongside, e.g. `slides/UDLChap2.pptx`.
- `sourceUrl` — where the material came from.

The main source stays the top-level `file`/`sourceUrl` field; materials are
the extra readers. `GET /api/projects/:slug/materials` reports each entry
with `hasFile` (whether the PDF is actually on disk).

### Labs

`notes/labs/<Chapter>/*.ipynb` holds Python lab notebooks fetched as-is from
the reading material's own repo — they are existing material, never AI-written
and never edited by the seed. The notebook editor reads/writes them through
the labs API; each lab opens in the same executable notebook pane as
`notes/*.ipynb`.

## AI import (structure only)

`POST /api/import/ai/propose` (multipart: `file` = PDF, optional `title`)
extracts the PDF's text (first 40 pages, see `src/pdftext.js`) and asks the
LLM to propose **structure only**:

```json
{ "outline": [{"title": "...", "page": 12}],
  "noteSkeleton": "# Title\n\n## 1. ...\n\n...",
  "chapterMap": {"introduction": 0} }
```

The endpoint returns these fields spread at the top level (plus `title`,
`pagesExtracted`, `numPages`) — there is no `proposal` wrapper; that
top-level shape is the canonical one.

The hard rules, enforced both in the prompt (`src/llm.js`) and by a
server-side guard (`src/aiImport.js`, also applied on apply):

- **The note skeleton contains ONLY `##` headings with EMPTY bodies.** No
  summaries, no key points, no prose of any kind. The server rejects any
  proposal whose skeleton has a non-heading line (400).
- Never invent page numbers (only pages present in the extracted text;
  `null` when uncertain). Never invent quotes.
- `propose` writes nothing to `data/` — it only returns the proposal.
  `POST /api/import/ai/apply` (multipart: `file` = the same PDF,
  `proposal` = JSON string, `title`) validates the proposal strictly and
  creates the project: `project.json` with `outline` + `chapterMap`,
  `source.pdf`, and `notes.md` = the skeleton. Slug collision → 409.

**Why structure only:** markdown notes are the user's own writing. The AI
builds the empty shelves — chapter outline, blank per-chapter headings, the
chapter→note mapping, project metadata — and the user writes the notes.
(AI import is the one explicit path that pre-writes skeleton headings, and
only when the user applies a proposal they previewed; the app itself never
pre-writes chapter headings — they are created on demand when a note lands
under a chapter.)
Python labs are separate again: they are existing material fetched as-is,
not AI-written. The three things stay separate by design: AI structure,
fetched labs, the user's own markdown.

LLM configuration lives in `server/.env` (copy `server/.env.example` —
never commit the real file; it is git-ignored):

| Variable | Meaning |
| -------- | ------- |
| `LLM_API_KEY` | Gemini API key |
| `LLM_MODEL` | e.g. `gemini-2.5-flash` |
| `LLM_STUB_RESPONSE` | Tests/verification only: a JSON string returned instead of calling the API |

Without a stub and without key+model, `propose` answers
`503 {error: 'LLM not configured', hint: 'Add LLM_API_KEY and LLM_MODEL to server/.env'}`.
The key is never logged.

Extension point: the AI step is kind-agnostic — `proposeProjectData({kind,
title, text})` in `src/llm.js` takes extracted text and returns the same
proposal shape whatever the kind. Slides and video imports reuse it later;
only the extractor differs per kind (slides: LibreOffice-converted PDF text
via `src/pdftext.js`; video: transcript text). The deterministic import path
is unchanged: `POST /api/projects` with a file upload uses the PDF's own
outline when present, an empty master otherwise.

## Reader layout

The reader fills the viewport edge-to-edge (the app header hides while a
project is open). Three layout modes, switched in the top bar — per-session,
no persistence; switching modes never changes the chapter, page, active
tabs, or selection:

| Mode | Layout |
| ---- | ------ |
| **Navigation** | Chapters nav + the reading pane (notebook and AI hidden) — for navigating and reading. |
| **Focus** (default) | Nav hidden; left reading tabs + right notebook tabs, 50/50 — for working side by side. |
| **AI** | Focus + the AI panel as the rightmost column (340px); left/right split the rest 50/50. |

The **Chapters** button is a manual nav toggle inside the current mode (it
does not change the mode label); the mode buttons set the canonical
arrangement. The **✨ Ask AI** toggle (top bar, and in the notebook toolbar)
and the **AI** mode button are the same action: opening AI switches to AI
mode, closing the panel (its ×) returns to Focus — the panel lives in AI
mode only.

- **LEFT pane (reading, tabbed — PDF projects)**: **PDF** (the book at the
  current chapter/page), **Slides** (the current chapter's slide deck — the
  deck picker inside the tab defaults to the chapter's deck; decks are
  matched to chapters by label), **Markdown preview** (the rendered
  `notes.md`, following the current chapter like note-follow). The book and
  the deck live in separate containers, so each tab keeps its scroll
  position. The old top-bar source switcher is gone for PDF projects — the
  left tabs are the switcher now (other project kinds keep it).
- **RIGHT pane (working, tabbed)**: the runnable notebooks (the Labs
  index lists the Python/Java labs by chapter — the user opens the one
  they choose by clicking it; nothing ever auto-opens a lab) and the
  markdown **editor** tab (`notes.md` in Edit mode; the preview lives on
  the left). Editing on the right updates the left preview live. "+ Notebook"
  and the page-anchored-note action live here.
- **Chapter ↔ labs / slides correspondence**: clicking a chapter shows that
  chapter's PDF location, its slide deck, and its markdown section. The
  Labs index does NOT follow the chapter — the user picks a lab from it.
  The mapping comes from the seeded data (deck labels, `ChapNN` lab
  groups, numbered `##` headings), never invented.

### The notes model: one master markdown

`notes.md` is the only notes file. It lives in the RIGHT pane (editor);
the left Markdown preview renders it. There are no per-chapter files, no
app-maintained index, and no pre-written skeleton headings.

- **Filing by page**: when the user adds a note, the app files it by the
  page he was on — it finds the chapter containing that page (from the PDF
  outline / deck mapping) and inserts the note under that chapter's `##`
  heading in the master, creating the heading (with its `<!-- p. N -->`
  anchor) if it does not exist yet. A created heading uses the outline
  title verbatim (e.g. `## Shallow neural networks` — the old seed's
  `## 3. …` numbering is legacy; existing numbered headings still match
  by title). Headings appear on demand, never pre-written. "+ Note here",
  Ask AI Apply, and cell-export "Insert into note" all file this way;
  Save writes the master.
- **Labs index**: the Labs section in the notebook pane lists the labs by
  chapter group; the user chooses which notebook to open. Clicking a
  chapter never opens, switches, or expands a lab.
- **Export notes**: one click downloads the master as `<slug>-notes.md`
  (the master already is a single file).
- **chapterMap** (`project.json`) stays as the manual override for
  chapter↔heading linking (the chapter panel's "Link to a note heading…"
  select, or POST `/chapter-map`); filing itself uses page ranges plus
  title matching, and creates headings on demand.
- **Upgrade note**: a project that still carries the old per-chapter
  model (`notes/chapter-*.md` + `notes/index.md`) folds back
  automatically on first load after this lands (also via
  `POST .../notes/migrate`): each chapter file's user content returns to
  the master under its `##` heading, in chapter order, minus the
  generated `### Labs` blocks; chapters with no user content vanish.
  The old files are moved (not deleted) to `notes/.chapter-backup/`.
  A legacy single `notes.md` keeps its content, minus empty skeleton
  headings. AI import is the one explicit path that may still pre-write
  skeleton headings — only on the user's own preview → Apply.

### Page-anchored notes

Notes attach to chapters by default, but a note can be added at **any**
PDF page or slide: the **+ Note here** button in the notebook toolbar
inserts an anchor comment under the current chapter's `##` heading in
`notes.md` (end of the section; the heading is created if missing — the
same rule as Ask AI Apply) and opens the editor at the line after it:

```
<!-- @page 100 · source: book -->
<!-- @page 12 · source: slides-chap2 -->
```

The anchor lives **in `notes.md` itself** — the single source of truth,
never a second copy in `project.json`. In any rendered preview (left
Preview tab or the right pane's Preview) the anchor shows as a chip
("p. 100" / "Supervised Learning · p. 12"); clicking it jumps the left
pane to that page/slide in the correct source tab. Anchors survive reload.
Page-based sources only (book PDF + slide decks) — on a video/YouTube
source the button is disabled with a note why. Pure helpers in
`src/pageAnchor.js`.

## On-demand AI notes (Ask AI)

The AI panel is the **rightmost column** of the reader (AI mode), with two
tabs. Both share one rule: the model returns a **proposal**; nothing is
written until you press **Apply**.

- **Note AI** — the **✨ Ask AI** button in the notebook pane opens a conversation panel
(one thread per notebook, kept in memory for the session — it resets on
reload, the same v1 limit as Finance Mate's Refine panel). This is the
**other** AI surface, and it works the opposite way from AI import:

| | AI import | Ask AI |
|---|---|---|
| When | Once, at project creation | Any time, only when you ask |
| The AI writes | Structure only: outline + headings-only skeleton + chapter map | Content: markdown notes, as a **proposal** |
| Writes to your files | The skeleton, on Apply | Nothing — until you press **Apply** on a proposal |

- **Context**: the material currently being read — the request carries the
  active left-pane source + page. Book PDF → the **current chapter**'s
  text (the page range comes from the project's outline, extracted
  server-side from the source PDF (`src/pdftext.js`, capped at 40 pages
  per chapter and 30,000 characters sent to the model). The outline is the
  stored one when the project has it (AI import); otherwise the server
  reads the PDF's own outline (`src/pdfOutline.js`) — seeded and
  file-uploaded projects store none, and the reader reads the same outline
  client-side. Slides tab → the **deck's text around the current slide**
  (the deck outline's section containing the slide, or a small window
  around it when the deck has no outline; same 30,000-character cap). An
  "Include my notes for this chapter" checkbox adds the current chapter's
  section from `notes.md` (up to 4,000 characters; book chapters only).
  With no chapter selected the AI works from your request only. The prompt
  is capped at 2,000 characters; the last 6 thread messages are included
  as conversation context.
- **Honesty rules** (same as import): the prompt forbids inventing page
  numbers, quotes, formulas, or facts not in the chapter text — if the
  chapter does not cover what you asked, the model says so instead.
- **Output = a proposal**: the reply is rendered as a preview with
  **Apply** and **Copy**. Apply inserts the markdown at the end of the
  section under the current chapter's `##` heading in `notes.md` (through
  the existing notes PUT path; a missing heading is created). A second
  Apply of the same proposal is a no-op — it never duplicates. `##`/`#`
  headings inside a proposal are demoted to `###`, so an inserted note
  never splits the chapter section.
- **API**: `POST /api/projects/:slug/ai-note`
  `{chapter?, prompt, includeNote?, history?}` →
  `{markdown, chapter: {title, startPage, endPage} | null, contextChars}`.
  `chapter` is the outline title (matched with the same normalization as
  the chapter map); omit it for a prompt-only note. `source` is a deck id
  (context then comes from the deck around `page`); omit both for the book
  chapter. 400 on an unknown chapter, a chapter with no page, an unknown
  source, or a non-PDF project. 503
  `{error: 'LLM not configured', hint: ...}` when the LLM is off, same as
  import. Pure helpers live in `src/aiNote.js`.

- **Code AI** (second tab) — writes Python code for the notebook you have
  open. Same proposal rule: prompt → a fenced `python` block plus a
  one-line explanation → **Apply** appends it as a **new code cell at the
  end** of the current notebook (there is no cell-selection UI in v1, so
  "after the selected cell" is always the end; existing cells are never
  edited, and `notes.md` is untouched). **Python notebooks only** — the
  tab explains itself when the active notebook is not Python (Java and
  JavaScript are out of scope for now). Context: the same reading material
  as Note AI, plus the current notebook's code cells (capped at 8,000
  characters) so the model writes code that fits. **API**:
  `POST /api/projects/:slug/ai-code`
  `{chapter?, prompt, notebook, source?, page?, cells?, history?}` →
  `{code, language: 'python', explanation?, chapter, source, page,
  contextChars}`. `notebook` is the current `.ipynb` path; `cells` is the
  array of code-cell sources (capped server-side). 400 on a missing
  prompt/notebook, a bad page, an unknown source, or non-string cells. 503
  when the LLM is off. Pure helpers in `src/aiCode.js`.

## Export cells to Markdown

In an ipynb notebook, each code cell has an **Export** checkbox. The
**Export to Markdown** button (above the cells) generates markdown from
the selected cells — deterministic, no LLM:

- Code as a fenced block (language from the notebook metadata — `python`,
  `javascript`, `java`), stdout/stderr as output blocks, one `### Cell N`
  heading per cell. Markdown cells are skipped; empty-output cells export
  just the fence.
- **Plots are files, not base64**: each `image/png` output is written to
  `notes/assets/<notebook>-cell-<n>-<hash8>.png` (SHA-256 of the PNG bytes,
  first 8 hex chars — re-exporting unchanged content reuses the same file)
  and referenced with a relative link `![Cell N plot](assets/...)`.
  `GET /api/projects/:slug/assets/:file` serves those PNGs, so the plots
  also render in the app's own markdown previews (the markdown itself
  keeps the relative link, which resolves when a downloaded file lives in
  `notes/`).
- The preview shows the rendered markdown and the raw text, with two
  targets: **[Insert into note]** appends under the current chapter's
  `##` heading in `notes.md` (same insert rule as Ask AI — a second Insert
  of the same export is a no-op), and **[Download .md]** saves
  `<notebook>-cells.md`. Nothing is inserted into your notes until you
  press Insert. (Generating the preview does write the deduped plot files
  under `notes/assets/` — the preview's links have to point at real files.)
- **API**: `POST /api/projects/:slug/export-cells`
  `{notebook, name, cells: [indexes]}` →
  `{markdown, images: [{cellIndex, fileName, path}], cells}`. The notebook
  JSON comes from the client (exactly what you see, saved or not); at most
  200 cells per export. 400 on an empty selection, an out-of-range index,
  or a non-code-only selection. Pure generation in `src/cellExport.js`.

## API

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/health` | `{ok:true}` |
| GET | `/api/projects` | `[{slug,title,author,kind,sourceType,cover,createdAt,noteFiles}]` |
| POST | `/api/projects` | Multipart (`title`, `kind?`, `file`) **or** JSON `{title, kind?, url}`. URL kind is inferred: YouTube → `video`, `docs.google.com/presentation` → `slides`, `.pdf` URL → `pdf`. Slug from `slugify(title)`; collisions get `-2`, `-3`… Returns 201. |
| GET | `/api/projects/:slug` | `project.json` + `materials[]` + `noteFiles` |
| GET | `/api/projects/:slug/file` | Streams the source file (`Range` supported, for pdf.js); URL projects 302-redirect |
| GET | `/api/projects/:slug/materials` | `[{id,label,kind,hasFile,sourceUrl?}]` from `project.json` |
| GET | `/api/projects/:slug/materials/:id/file` | Streams the material's PDF (`Range` supported); 404 when the material has no file |
| GET | `/api/projects/:slug/labs` | `{chapters: [{chapter: 'Chap01', files: [{name, path}]}]}` — `.ipynb` only, sorted |
| GET | `/api/projects/:slug/labs/:chapter/:name` | `{name, content}` (notebook JSON text) |
| PUT | `/api/projects/:slug/labs/:chapter/:name` | `{content}` — saves a notebook (validated as notebook JSON, `.ipynb` only) |
| GET | `/api/projects/:slug/notes` | `[{name, kind: md\|ipynb}]` |
| GET | `/api/projects/:slug/notes/:name` | `{name, content}` (raw text) |
| PUT | `/api/projects/:slug/notes/:name` | `{content}` — saves, creates if new |
| POST | `/api/projects/:slug/cover` | `{dataUrl}` (base64 PNG/JPEG) → writes `cover.png`, returns `{cover:"cover.png"}` |
| POST | `/api/projects/:slug/chapter-map` | `{mapping}` merged into `project.json` `chapterMap` |
| POST | `/api/import/ai/propose` | Multipart (`file` = PDF, `title?`) → structure-only proposal; 503 when the LLM is not configured, 400 on a bad PDF or unparseable model output |
| POST | `/api/import/ai/apply` | Multipart (`file` = PDF, `proposal` = JSON string, `title`) → creates the project; 201 `{project}`, 409 on slug collision |
| POST | `/api/projects/:slug/ai-note` | `{chapter?, prompt, includeNote?, history?, source?, page?}` → `{markdown, chapter, source, page, contextChars}` — on-demand AI note proposal; 503 when the LLM is not configured (see "On-demand AI notes") |
| POST | `/api/projects/:slug/ai-code` | `{chapter?, prompt, notebook, source?, page?, cells?, history?}` → `{code, language: 'python', explanation, chapter, source, page, contextChars}` — on-demand Code AI proposal (Python notebooks only); 503 when the LLM is not configured (see "On-demand AI notes") |
| POST | `/api/projects/:slug/export-cells` | `{notebook, name, cells: [indexes]}` → `{markdown, images, cells}` — deterministic cell export; writes deduped PNGs under `notes/assets/` (see "Export cells to Markdown") |
| GET | `/api/projects/:slug/assets/:file` | Serves an exported plot PNG from `notes/assets/` (`.png` file names only) |
| POST | `/api/execute` | `{language: python\|java\|javascript, code}` → `{stdout, stderr, exitCode, images:[{data, mime:"image/png"}]}` |
| POST | `/api/execute` | `{language: python\|javascript, cells:[{source}]}` → `{results:[{stdout, stderr, exitCode, images, skipped}]}` — run-all in one shared session (see below) |

Notes: note names must be `.md`/`.ipynb` file names with no path separators
— traversal is rejected with 400. `chapterMap` maps a chapter number to the
index of its `##` heading in `notes.md` (0-based).

### /api/execute

Each run gets a fresh temp dir (deleted afterwards) and a 30s timeout.
Non-zero exits still return HTTP 200 with the `exitCode`.

- **python**: `python3 -u solution.py` (`MPLBACKEND=Agg`); any `*.png` the
  code writes (e.g. `plt.savefig("plot.png")`) is returned as base64 images.
- **java**: `javac Main.java && java Main`.
- **javascript**: `node solution.mjs`.

Code is capped at ~200KB and empty code is rejected.

### /api/execute — run-all (cells mode)

`{language: python|javascript, cells: [{source}, …]}` (max 200 cells,
2MB total) runs the cells in **one shared session** and returns one result
per cell, in order. This is what the notebook's **▶ Run all** button and
each cell's **▶ Run all above** use: earlier imports and definitions are
visible to later cells, so real multi-cell labs run as written.

- **python** (`src/pythonRunner.py`): one process, cells `exec`'d in
  sequence in a shared namespace (`__name__ == '__main__'`). stdout/stderr
  are captured per cell; a cell that raises stops the run and later cells
  are marked `skipped: true`. `plt.show()` is patched (once pyplot is
  imported) to save every open figure as a PNG, and any still-open figures
  are harvested after each cell that wrote no PNG itself — so labs that
  plot with `plt.show()` render images instead of nothing. New PNGs are
  attributed to the cell that created them, deduplicated by content hash.
- **javascript** (`src/jsRunner.mjs`): cells are concatenated into a
  single `.mjs` module with per-cell boundary markers on stdout/stderr,
  run as one node process, and split back per cell. Top-level
  `const`/`let` redeclaration across cells is a SyntaxError in the
  concatenated module — use plain assignment or `var` for names shared
  across cells. A syntax error is attributed to the offending cell.
- **java has no run-all**: cells cannot be concatenated into one program,
  so Java notebooks keep per-cell ▶ Run only.
- The single-cell path is unchanged and does **not** get the `plt.show()`
  hook: a lone cell that only calls `plt.show()` still renders no image —
  use ▶ Run all above for plot cells that depend on earlier cells.

## The seed project

`npm run seed` creates `data/projects/understanding-deep-learning/`:

- **Understanding Deep Learning**, Simon J.D. Prince, MIT Press, CC-BY-NC-ND —
  PDF v5.0.3 (2026-02-09), 22,344,992 bytes, downloaded from the
  [udlbook releases](https://github.com/udlbook/udlbook/releases/download/v5.0.3/UnderstandingDeepLearning_02_09_26_C.pdf).
- `notes.md` has one `##` heading per chapter, extracted from the PDF's own
  outline at seed time (pdfjs-dist legacy build), with the PDF page number as
  an HTML comment under each heading. If the outline cannot be read, the
  book's Contents list is used instead. The headings are EMPTY — the notes
  are the user's own writing; the seed never generates note content.
- `slides/` holds the 13 lecture decks: each `.pptx` (source) plus the
  LibreOffice-converted `.pdf` (renderable). 12 decks come from the
  [udlbook repo](https://github.com/udlbook/udlbook/tree/main/Slides)
  (`UDLChap2.pptx` … `UDLChap13.pptx`; there is no Chap 1 deck); the
  Introduction deck comes from Google Drive. `project.json` `materials[]`
  lists them with lecture titles. A deck whose conversion fails is still
  listed with its PPTX as the source and no `file` — the reader shows it as
  a download card rather than faking a render.
- `notes/labs/` holds the 69 Python lab notebooks from the
  [udlbook repo](https://github.com/udlbook/udlbook/tree/main/Notebooks)
  (the site lists 68; the repo has 69 — Chap20 has 5), in
  `ChapXX/<exact repo filename>.ipynb`. They are fetched as-is and never
  modified by the seed; the old placeholder `notes/exercises.ipynb` was
  removed when the real labs landed. Per-chapter counts: Chap01:1, Chap02:1,
  Chap03:4, Chap04:3, Chap05:3, Chap06:5, Chap07:3, Chap08:4, Chap09:5,
  Chap10:5, Chap11:3, Chap12:4, Chap13:4, Chap15:2, Chap16:3, Chap17:3,
  Chap18:4, Chap19:5, Chap20:5, Chap21:2 (no Chap14 notebooks exist).
- Links: book site & Python notebooks (`https://udlbook.github.io/udlbook/`),
  video lectures (YouTube playlist by Tamer Elsayed), lecture slides (PPTX,
  via the book site).

Re-running the seed skips files that already exist (the PDF is skipped when
its size matches; decks and labs are skipped when present and valid) and
only tops up `project.json` `materials[]` — it never overwrites an existing
`notes.md` or other `project.json` fields. Pass `--force` to re-download
source files; notes/project user edits are still preserved. All seed
downloads and LibreOffice scratch live under `~/workspace/nm-seed-tmp/`
(never `/tmp` — the payload is ~150–300MB and `/tmp` is a 512MB tmpfs).

The PPTX→PDF conversion needs LibreOffice, in three tiers (see
`src/convertDeck.js`): (1) host `soffice` when it is on PATH; (2) a one-off
container from the app's own image (`docker compose run --rm`, base
`docker-compose.yml` only) when Docker is available — the image already
ships `libreoffice-impress`, so no host install is needed; (3) when neither
is available, seed asks once in the terminal — "LibreOffice is not
installed. Install it now via Homebrew (~500MB+, a few minutes)? [y/N]"
(default No; a piped/non-interactive run answers No without hanging) — and
on yes runs `brew install --cask libreoffice`, then retries the conversion
with the fresh host install. Pass `--install-libreoffice` to pre-answer yes
for non-interactive runs. If Homebrew itself is missing, seed says so and
fails the deck with the manual command; seed never installs Homebrew and
never installs anything without the user's yes (or the flag).

## Tests

```bash
npm test   # node --test tests/  (util + API integration tests)
```

## v1 limits

- **No KaTeX / math rendering yet.**
- **Ask AI threads are in-memory only** — they reset on reload (same v1
  limit as Finance Mate's Refine panel). Proposals are never persisted
  until you press Apply.
- **`/api/execute` has a timeout but no network sandbox.** Code runs as the
  server user with network access. Do not expose the server to untrusted
  users; sandboxing (no-network, resource limits) is future work.
- **Docker build not verified on this VM** (no Docker installed here):
  the `Dockerfile` change (LibreOffice) is untested as a build; the
  `docker-compose.yml` was validated by YAML parsing only.
