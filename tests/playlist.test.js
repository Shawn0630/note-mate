// Unit tests for the playlist expansion (src/playlist.js): ID
// extraction, the two page formats (playlistVideoRenderer + the
// current lockupViewModel), RSS parsing, and expandPlaylist with a
// stubbed fetch. No live youtube.com access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractPlaylistId, extractPlaylistUrls, extractJsonObject,
  parsePlaylistPage, parsePlaylistRss, expandPlaylist,
} from '../src/playlist.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const pageHtml = fs.readFileSync(path.join(fixtures, 'playlist-page.html'), 'utf8');
const lockupHtml = fs.readFileSync(path.join(fixtures, 'playlist-page-lockup.html'), 'utf8');
const rssXml = fs.readFileSync(path.join(fixtures, 'playlist-rss.xml'), 'utf8');

test('extractPlaylistId: playlist URLs only — a watch URL with v is a single video', () => {
  assert.equal(
    extractPlaylistId('https://www.youtube.com/playlist?list=PLAQhlrjkxbuWI23v9cThsA9GvCAUhRvKZ'),
    'PLAQhlrjkxbuWI23v9cThsA9GvCAUhRvKZ',
  );
  assert.equal(
    extractPlaylistId('https://www.youtube.com/watch?list=PLAQhlrjkxbuWI23v9cThsA9GvCAUhRvKZ'),
    'PLAQhlrjkxbuWI23v9cThsA9GvCAUhRvKZ',
  );
  assert.equal(extractPlaylistId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLAQhlrjkxbuWI23v9cThsA9GvCAUhRvKZ'), null);
  assert.equal(extractPlaylistId('https://youtu.be/dQw4w9WgXcQ'), null);
  assert.equal(extractPlaylistId('https://www.youtube.com/playlist?list=abc'), null);
  assert.equal(extractPlaylistId('https://example.com/playlist?list=PLAQhlrjkxbuWI23v9cThsA9GvCAUhRvKZ'), null);
  assert.equal(extractPlaylistId(''), null);
  assert.equal(extractPlaylistId(null), null);
});

test('extractPlaylistUrls: finds playlist URLs in free text, deduped by id', () => {
  const found = extractPlaylistUrls(
    'video list https://www.youtube.com/playlist?list=PLAQhlrjkxbuWI23v9cThsA9GvCAUhRvKZ '
    + 'and again https://www.youtube.com/playlist?list=PLAQhlrjkxbuWI23v9cThsA9GvCAUhRvKZ '
    + 'plus a video https://youtu.be/dQw4w9WgXcQ',
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].playlistId, 'PLAQhlrjkxbuWI23v9cThsA9GvCAUhRvKZ');
});

test('extractJsonObject: string-aware brace matching', () => {
  assert.equal(extractJsonObject('{"a": "} {"}', 0), '{"a": "} {"}');
  assert.equal(extractJsonObject('{"a": 1} trailing', 0), '{"a": 1}');
  assert.equal(extractJsonObject('{"a": ', 0), null);
});

test('parsePlaylistPage (old format): skips private + duplicate, reads the sidebar total', () => {
  const out = parsePlaylistPage(pageHtml);
  assert.deepEqual(out.videos, [
    { videoId: 'dQw4w9WgXcQ', title: 'Lecture 1: Introduction' },
    { videoId: '9bZkp7q19f0', title: 'Lecture 2: Supervised Learning' },
    { videoId: 'aqz-KE-bpKQ', title: 'Lecture 3: Shallow Networks' },
  ]);
  assert.equal(out.total, 12);
  assert.equal(out.truncated, true); // continuation item in the fixture
});

test('parsePlaylistPage (lockup format): skips non-video lockups + duplicates, no sidebar total', () => {
  const out = parsePlaylistPage(lockupHtml);
  assert.deepEqual(out.videos, [
    { videoId: 'VMj-3S1tku0', title: 'The spelled-out intro to neural networks' },
    { videoId: 'PaCmpygFfXo', title: 'The spelled-out intro to language modeling' },
    { videoId: 'TCH_1BHY58I', title: 'Building makemore Part 2: MLP' },
  ]);
  assert.equal(out.total, 3); // no total stated — the parsed count
  assert.equal(out.truncated, true); // continuationItemViewModel present
});

test('parsePlaylistPage: throws with no ytInitialData / no video list', () => {
  assert.throws(() => parsePlaylistPage('<html>no data</html>'), /no ytInitialData/);
  assert.throws(
    () => parsePlaylistPage('<script>var ytInitialData = {"contents": {}};</script>'),
    /no playable videos/,
  );
});

test('parsePlaylistRss: entries with unescaped titles, deduped', () => {
  const out = parsePlaylistRss(rssXml);
  assert.deepEqual(out.videos, [
    { videoId: 'dQw4w9WgXcQ', title: 'Lecture 1: Introduction' },
    { videoId: '9bZkp7q19f0', title: 'Lecture 2: Supervised & Learning' },
    { videoId: 'aqz-KE-bpKQ', title: 'Lecture 3: Shallow Networks' },
  ]);
  assert.deepEqual(parsePlaylistRss('<feed></feed>'), { videos: [] });
});

test('expandPlaylist: page first (lockup), RSS fallback, 502 when both fail', async () => {
  const stubFetch = async (url) => {
    if (String(url).includes('/playlist?')) {
      return { ok: true, text: async () => lockupHtml };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  const out = await expandPlaylist('PLAQhlrjkxbuWI23v9cThsA9GvCAUhRvKZ', { fetchImpl: stubFetch });
  assert.equal(out.source, 'page');
  assert.equal(out.videos.length, 3);
  assert.equal(out.videos[0].videoId, 'VMj-3S1tku0');

  const rssFetch = async (url) => {
    if (String(url).includes('/playlist?')) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, text: async () => rssXml };
  };
  const rssOut = await expandPlaylist('PLAQhlrjkxbuWI23v9cThsA9GvCAUhRvKZ', { fetchImpl: rssFetch });
  assert.equal(rssOut.source, 'rss');
  assert.equal(rssOut.videos.length, 3);

  const deadFetch = async () => ({ ok: false, status: 404, text: async () => '' });
  await assert.rejects(
    expandPlaylist('PLAQhlrjkxbuWI23v9cThsA9GvCAUhRvKZ', { fetchImpl: deadFetch }),
    (err) => err.status === 502 && /could not load playlist/.test(err.message),
  );
  await assert.rejects(
    expandPlaylist('not-a-playlist', { fetchImpl: stubFetch }),
    (err) => err.status === 400,
  );
});
