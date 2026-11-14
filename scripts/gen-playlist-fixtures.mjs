// One-off generator for tests/fixtures/playlist-page.html + playlist-rss.xml.
// Run: node scripts/gen-playlist-fixtures.mjs (then delete this file? No —
// keep it: the fixtures are generated from here so the embedded JSON is
// guaranteed valid. Re-run after editing the video list below.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
fs.mkdirSync(dir, { recursive: true });

const videoList = [
  { playlistVideoRenderer: { videoId: 'dQw4w9WgXcQ', title: { simpleText: 'Lecture 1: Introduction' }, isPlayable: true } },
  { playlistVideoRenderer: { videoId: '9bZkp7q19f0', title: { runs: [{ text: 'Lecture 2: ' }, { text: 'Supervised Learning' }] }, isPlayable: true } },
  { playlistVideoRenderer: { videoId: 'aqz-KE-bpKQ', title: { simpleText: 'Lecture 3: Shallow Networks' } } },
  // Unplayable + duplicate entries: the parser must skip both.
  { playlistVideoRenderer: { videoId: 'Lec04AbC456', title: { simpleText: 'Private video' }, isPlayable: false } },
  { playlistVideoRenderer: { videoId: 'dQw4w9WgXcQ', title: { simpleText: 'Lecture 1: Introduction' } } },
  // A continuation item: the playlist is longer than this first page.
  { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'Eg0SC3BU...' } } } },
];

const data = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  { itemSectionRenderer: { contents: [{ playlistVideoListRenderer: { contents: videoList } }] } },
                ],
              },
            },
          },
        },
      ],
      secondary: {
        playlistSidebarRenderer: {
          items: [
            { playlistSidebarPrimaryInfoRenderer: { stats: [{ runs: [{ text: '12 videos' }] }] } },
          ],
        },
      },
    },
  },
};

const html = '<!DOCTYPE html><html><head><title>Lecture Playlist - YouTube</title></head><body>'
  + `<script>var ytInitialData = ${JSON.stringify(data)};</script>`
  + '<div>playlist page</div></body></html>';
fs.writeFileSync(path.join(dir, 'playlist-page.html'), html);

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <title>Lecture Playlist</title>
  <entry>
    <id>yt:video:dQw4w9WgXcQ</id>
    <yt:videoId>dQw4w9WgXcQ</yt:videoId>
    <title>Lecture 1: Introduction</title>
  </entry>
  <entry>
    <id>yt:video:9bZkp7q19f0</id>
    <yt:videoId>9bZkp7q19f0</yt:videoId>
    <title>Lecture 2: Supervised &amp; Learning</title>
  </entry>
  <entry>
    <id>yt:video:aqz-KE-bpKQ</id>
    <yt:videoId>aqz-KE-bpKQ</yt:videoId>
    <title>Lecture 3: Shallow Networks</title>
  </entry>
</feed>
`;
fs.writeFileSync(path.join(dir, 'playlist-rss.xml'), rss);

// --- Lockup-format playlist page (the live format, 2026-11) --------
// Same nesting as the old page, but each video is a lockupViewModel
// (contentId + metadata.lockupMetadataViewModel.title.content) and the
// continuation is a continuationItemViewModel in contents[1]. No
// sidebar "N videos" total — total is the parsed count, truncated is
// true because of the continuation item. Includes one non-video lockup
// (a playlist) and one duplicate, both skipped by the parser.
const lockupItems = [
  { lockupViewModel: { contentId: 'VMj-3S1tku0', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: 'The spelled-out intro to neural networks' } } } } },
  { lockupViewModel: { contentId: 'PaCmpygFfXo', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: 'The spelled-out intro to language modeling' } } } } },
  { lockupViewModel: { contentId: 'TCH_1BHY58I', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: 'Building makemore Part 2: MLP' } } } } },
  { lockupViewModel: { contentId: 'PLAQhlrjkxbuWI23v9cThsA9GvCAUhRvKZ', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', metadata: { lockupMetadataViewModel: { title: { content: 'A playlist, not a video' } } } } },
  { lockupViewModel: { contentId: 'VMj-3S1tku0', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: 'The spelled-out intro to neural networks' } } } } },
];
const lockupData = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  { itemSectionRenderer: { contents: lockupItems } },
                  { continuationItemViewModel: { continuationEndpoint: { continuationCommand: { token: 'Eg0SC3BU...' } } } },
                ],
              },
            },
          },
        },
      ],
    },
  },
};
const lockupHtml = '<!DOCTYPE html><html><head><title>Neural Networks: Zero to Hero - YouTube</title></head><body>'
  + `<script>var ytInitialData = ${JSON.stringify(lockupData)};</script>`
  + '<div>playlist page</div></body></html>';
fs.writeFileSync(path.join(dir, 'playlist-page-lockup.html'), lockupHtml);

// --- Fixture GitHub repo (tests/fixtures/repo-*) -------------------
// A small stand-in for chizkidd/Karpathy-Neural-Networks-Zero-to-Hero:
// two lecture folders, four notebooks, data files, one sibling .py
// module, two dependency manifests, and one huge binary checkpoint
// that must be skipped, never fetched.
const repoDir = path.join(dir, 'repo-notebooks');
fs.mkdirSync(repoDir, { recursive: true });

function tinyNotebook(cells) {
  return JSON.stringify({
    cells: cells.map((source) => ({
      cell_type: 'code', execution_count: null, metadata: {}, outputs: [],
      source: Array.isArray(source) ? source : [source],
    })),
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } },
    nbformat: 4, nbformat_minor: 5,
  }, null, 2);
}

const repoFiles = {
  '001_intro/micrograd.ipynb': tinyNotebook([
    'import graphviz\nimport matplotlib.pyplot as plt\n',
    "names = open('../data/names.txt').read().splitlines()\nprint(len(names), 'names')\n",
  ]),
  '001_intro/micrograd_exercises.ipynb': tinyNotebook([
    'import torch\nprint(torch.__version__)\n',
  ]),
  '002_makemore/bigram.ipynb': tinyNotebook([
    // A fictional import on purpose: missing-package detection must
    // not depend on what happens to be installed in the test python
    // (the browser probe really installs cowsay into it, which broke
    // the old `cowsay` assertion). Unknown imports fall back to the
    // import name as the package name.
    'import notarealmodule\nimport numpy as np\nprint(notarealmodule.hello())\n',
  ]),
  '002_makemore/makemore.ipynb': tinyNotebook([
    'import pandas as pd\nimport tqdm\nprint(pd.__version__)\n',
  ]),
  '007_gpt/_src/bigram.py': 'def hello():\n    return "bigram"\n',
  'data/names.txt': 'alice\nbob\ncarol\ndave\n',
  'data/input.txt': 'Tiny Shakespeare stand-in.\nTo be, or not to be.\n',
  'README.md': '# Fixture course repo\n',
  'requirements.txt': 'numpy\ntorch\nmatplotlib\ncowsay\npandas\n',
  'environment.yml': 'name: fixture-course\nchannels:\n  - defaults\ndependencies:\n  - python=3.9\n  - numpy\n  - pip:\n    - cowsay\n    - tqdm\n',
};
for (const [rel, content] of Object.entries(repoFiles)) {
  const file = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
// The tree JSON the stub API serves: sizes from the files above, plus
// a 52MB checkpoint that exists in the tree but is never fetched.
const treeEntries = Object.keys(repoFiles).map((p) => ({
  path: p,
  mode: '100644',
  type: 'blob',
  size: Buffer.byteLength(repoFiles[p], 'utf8'),
  sha: '0000000000000000000000000000000000000000',
  url: `https://api.github.com/repos/fixture/course-repo/git/blobs/0000000000000000000000000000000000000000`,
}));
treeEntries.push({
  path: '007_gpt/model.pth', mode: '100644', type: 'blob', size: 52700258,
  sha: '1111111111111111111111111111111111111111',
  url: 'https://api.github.com/repos/fixture/course-repo/git/blobs/1111111111111111111111111111111111111111',
});
fs.writeFileSync(path.join(dir, 'repo-tree.json'), JSON.stringify({
  sha: '2222222222222222222222222222222222222222',
  url: 'https://api.github.com/repos/fixture/course-repo/git/trees/main',
  tree: treeEntries,
  truncated: false,
}, null, 2));

console.log('fixtures written to', dir);
