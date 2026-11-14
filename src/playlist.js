// Expand a YouTube playlist into its videos, server-side, with no new
// dependencies (built-in fetch only).
//
// Primary source: the playlist watch page's `ytInitialData`. Two list
// formats are supported: the older `playlistVideoListRenderer` entries
// and the current (2026-11) `lockupViewModel` entries (contentId =
// video id, title at
// metadata.lockupMetadataViewModel.title.content), which is what the
// live page now serves — the old renderer is gone from the live page,
// kept here as a fallback. Fallback: the playlist RSS feed
// (`https://www.youtube.com/feeds/videos.xml?playlist_id=...`), which
// only carries the latest 15 videos — and 404s for some playlists
// (verified live 2026-11-13 for the user's playlist). Never invents
// videos: if neither source yields a video list, `expandPlaylist`
// throws with a clear message, and the caller reports the failure
// instead of adding anything.
//
// Continuation is deliberately NOT implemented: the first page covers
// the playlists this app is used for (the UDL lecture list has 12
// videos), and `truncated` says so when the playlist is longer.
//
// Test hooks: `expandPlaylist` accepts `{fetchImpl, pageBase, rssBase}`;
// the server passes `process.env.NM_YT_PAGE_BASE` / `NM_YT_RSS_BASE`
// when set (used by the browser probe's local stub server, since
// youtube.com is blocked in the sandbox). In production these are unset
// and the defaults below are used.
//
// Pure helpers + the fetch-backed expansion. Unit-tested in
// tests/playlist.test.js against fixture page/RSS files.


/** Playlist IDs start with PL and are long; reject junk like `list=abc`. */
const PLAYLIST_ID_RE = /^PL[A-Za-z0-9_-]{10,}$/;

/** A playlist page fetch gets 15s; the RSS feed 10s. */
const PAGE_TIMEOUT_MS = 15000;
const RSS_TIMEOUT_MS = 10000;

const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
};

/**
 * Extract the playlist ID from a URL, or null when the URL is not a
 * YouTube playlist link. A playlist URL is `youtube.com/playlist?list=…`
 * or a `watch` URL with a `list` param but NO `v` param — a watch URL
 * that names a video (`?v=…&list=…`) is a single video, not the
 * playlist, and returns null.
 */
export function extractPlaylistId(rawUrl) {
  let s = String(rawUrl ?? '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const isYoutube = host === 'youtube.com' || host.endsWith('.youtube.com')
    || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com');
  if (!isYoutube) return null;
  const list = u.searchParams.get('list') || '';
  if (!PLAYLIST_ID_RE.test(list)) return null;
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments[0] === 'playlist') return list;
  if (segments[0] === 'watch' && !u.searchParams.get('v')) return list;
  return null;
}

/** Find every playlist URL inside free text, in order, deduped by id. */
export function extractPlaylistUrls(text) {
  const found = new Map(); // playlistId -> url (first seen)
  for (const token of String(text ?? '').match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    const id = extractPlaylistId(token);
    if (id && !found.has(id)) found.set(id, token);
  }
  return [...found.entries()].map(([playlistId, url]) => ({ playlistId, url }));
}

/** Extract the JSON object starting at the `{` at `start`, or null when
    the braces never balance (truncated page). String-aware: braces
    inside quoted strings do not count. */
export function extractJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Recursively find the first value stored under `key` anywhere in a
    parsed JSON value. */
function findKey(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findKey(item, key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const item of Object.values(value)) {
    const hit = findKey(item, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** A title is `{simpleText}` or `{runs: [{text}]}`; anything else is ''. */
function titleText(title) {
  if (!title || typeof title !== 'object') return '';
  if (typeof title.simpleText === 'string') return title.simpleText.trim();
  if (Array.isArray(title.runs)) {
    return title.runs.map((r) => (typeof r?.text === 'string' ? r.text : '')).join('').trim();
  }
  return '';
}

/** The playlist's video count as shown in the sidebar ("12 videos"),
    or null when the page does not state one. */
function findPlaylistTotal(data) {
  let total = null;
  const walk = (value) => {
    if (total !== null || !value || typeof value !== 'object') return;
    if (typeof value === 'string') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const item of Object.values(value)) {
      if (typeof item === 'string') {
        const m = /^\s*([\d,]+)\s+videos?\s*$/.exec(item);
        if (m) {
          total = Number(m[1].replace(/,/g, ''));
          return;
        }
      } else {
        walk(item);
      }
    }
  };
  walk(data);
  return total;
}

/**
 * Parse a playlist watch page's HTML into `{videos, total, truncated}`.
 * `videos` are `{videoId, title}` in playlist order, deduped; private /
 * deleted / unplayable entries are skipped (no video id, `isPlayable`
 * false, or an empty title). `total` is the sidebar's video count when
 * stated; `truncated` is true when the list is longer than the parsed
 * page (a continuation item, or a stated total above the count).
 * Two list formats are supported: the older `playlistVideoListRenderer`
 * entries and the current `lockupViewModel` entries (found by a
 * recursive scan, so their nesting can move). Throws when the page
 * carries no parseable video list (consent wall, changed markup,
 * truncated fetch) — the caller falls back to RSS.
 */
export function parsePlaylistPage(html) {
  const text = String(html ?? '');
  const marker = /ytInitialData\s*=\s*\{/.exec(text);
  if (!marker) throw new Error('playlist page has no ytInitialData');
  const jsonText = extractJsonObject(text, marker.index + marker[0].length - 1);
  if (!jsonText) throw new Error('playlist page data is truncated');
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error('playlist page data is not valid JSON');
  }
  const videos = [];
  const seen = new Set();
  let hasContinuation = false;

  // Format 1 (older): playlistVideoListRenderer.contents holds
  // {playlistVideoRenderer} entries (+ a continuationItemRenderer).
  const list = findKey(data, 'playlistVideoListRenderer');
  const contents = list && Array.isArray(list.contents) ? list.contents : null;
  if (contents) {
    for (const item of contents) {
      if (item && typeof item === 'object' && 'continuationItemRenderer' in item) {
        hasContinuation = true;
        continue;
      }
      const entry = item?.playlistVideoRenderer;
      if (!entry || typeof entry !== 'object') continue;
      const videoId = typeof entry.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(entry.videoId)
        ? entry.videoId
        : null;
      if (!videoId || seen.has(videoId)) continue;
      if (entry.isPlayable === false) continue;
      const title = titleText(entry.title);
      if (!title) continue;
      seen.add(videoId);
      videos.push({ videoId, title });
    }
  }

  // Format 2 (current, live 2026-11): lockupViewModel entries anywhere
  // in the page data. contentType must be VIDEO (a playlist page can
  // also lock up playlists/channels); the title is a plain string at
  // metadata.lockupMetadataViewModel.title.content. A
  // continuationItemViewModel anywhere marks the list truncated.
  if (!videos.length) {
    const walk = (value) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if ('continuationItemViewModel' in value) hasContinuation = true;
      const lockup = value.lockupViewModel;
      if (lockup && typeof lockup === 'object') {
        if (lockup.contentType && lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return;
        const videoId = typeof lockup.contentId === 'string'
          && /^[A-Za-z0-9_-]{11}$/.test(lockup.contentId) ? lockup.contentId : null;
        if (!videoId || seen.has(videoId)) return;
        const titleNode = lockup.metadata?.lockupMetadataViewModel?.title;
        let title = '';
        if (typeof titleNode === 'string') title = titleNode.trim();
        else if (titleNode && typeof titleNode === 'object') {
          title = typeof titleNode.content === 'string'
            ? titleNode.content.trim()
            : titleText(titleNode);
        }
        if (!title) return;
        seen.add(videoId);
        videos.push({ videoId, title });
        return;
      }
      for (const item of Object.values(value)) walk(item);
    };
    walk(data);
  }
  if (!videos.length) throw new Error('playlist page has no playable videos');
  const total = findPlaylistTotal(data);
  return {
    videos,
    total: total ?? videos.length,
    truncated: hasContinuation || (total !== null && total > videos.length),
  };
}

/** Unescape the XML entities a feed title may carry. */
function unescapeXml(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * Parse a playlist RSS feed (`feeds/videos.xml?playlist_id=…`) into
 * `{videos}`. Each `<entry>` carries `<yt:videoId>` + `<title>`. The
 * feed only ever holds the latest 15 videos — a partial source, used
 * only when the page cannot be parsed.
 */
export function parsePlaylistRss(xml) {
  const text = String(xml ?? '');
  const videos = [];
  const seen = new Set();
  for (const match of text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = match[1];
    const idMatch = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(entry);
    const titleMatch = /<title>([^<]*)<\/title>/.exec(entry);
    const videoId = idMatch ? idMatch[1].trim() : '';
    const title = titleMatch ? unescapeXml(titleMatch[1]).trim() : '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !title || seen.has(videoId)) continue;
    seen.add(videoId);
    videos.push({ videoId, title });
  }
  return { videos };
}

async function fetchWithTimeout(fetchImpl, url, ms, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Expand a playlist id into its videos: `{playlistId, videos, total,
 * truncated, source}` where `source` is 'page' or 'rss'. Page first,
 * RSS on any page failure (non-OK status, unparseable page, empty
 * list). Throws (status 502) when both sources fail or yield nothing,
 * and (status 400) for a malformed playlist id. Never returns a partial
 * list silently as complete: `truncated` is true whenever the playlist
 * is longer than the returned page.
 */
export async function expandPlaylist(playlistId, opts = {}) {
  const fail = (status, msg) => {
    const err = new Error(msg);
    err.status = status;
    throw err;
  };
  if (!PLAYLIST_ID_RE.test(String(playlistId ?? ''))) {
    fail(400, 'not a valid YouTube playlist id');
  }
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const pageBase = opts.pageBase || 'https://www.youtube.com/playlist';
  const rssBase = opts.rssBase || 'https://www.youtube.com/feeds/videos.xml';
  const id = encodeURIComponent(playlistId);
  let lastError = null;
  try {
    const res = await fetchWithTimeout(fetchImpl, `${pageBase}?list=${id}`, PAGE_TIMEOUT_MS, BROWSER_HEADERS);
    if (res.ok) {
      const parsed = parsePlaylistPage(await res.text());
      return { playlistId, videos: parsed.videos, total: parsed.total, truncated: parsed.truncated, source: 'page' };
    }
    lastError = new Error(`playlist page returned HTTP ${res.status}`);
  } catch (err) {
    lastError = err;
  }
  try {
    const res = await fetchWithTimeout(fetchImpl, `${rssBase}?playlist_id=${id}`, RSS_TIMEOUT_MS, BROWSER_HEADERS);
    if (res.ok) {
      const parsed = parsePlaylistRss(await res.text());
      if (parsed.videos.length) {
        return { playlistId, videos: parsed.videos, total: parsed.videos.length, truncated: false, source: 'rss' };
      }
      lastError = new Error('playlist RSS feed has no videos');
    } else {
      lastError = new Error(`playlist RSS feed returned HTTP ${res.status}`);
    }
  } catch (err) {
    lastError = err;
  }
  fail(502, `could not load playlist ${playlistId}: ${lastError ? lastError.message : 'unknown error'}`);
}
