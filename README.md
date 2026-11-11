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
`/api/execute` endpoint needs: `python3` + `python3-matplotlib` (plots) and
`openjdk-21-jdk-headless` (`javac`/`java`). LibreOffice (`libreoffice-impress`)
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
outline when present, an empty skeleton otherwise.

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
| POST | `/api/execute` | `{language: python\|java\|javascript, code}` → `{stdout, stderr, exitCode, images:[{data, mime:"image/png"}]}` |

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
LibreOffice must be installed for the PPTX→PDF conversion
(`soffice --headless --convert-to pdf`); the Dockerfile installs it.

## Tests

```bash
npm test   # node --test tests/  (util + API integration tests)
```

## v1 limits

- **No KaTeX / math rendering yet.**
- **`/api/execute` has a timeout but no network sandbox.** Code runs as the
  server user with network access. Do not expose the server to untrusted
  users; sandboxing (no-network, resource limits) is future work.
- **Docker build not verified on this VM** (no Docker installed here):
  the `Dockerfile` change (LibreOffice) is untested as a build; the
  `docker-compose.yml` was validated by YAML parsing only.
