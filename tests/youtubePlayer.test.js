// Unit tests for the YouTube IFrame API wrapper (public/youtubePlayer.js).
// The loader is driven with fake window/document objects; the player with
// a stub YT.Player — no network, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureYoutubeApi, createVideoPlayer, youtubeEmbedUrlWithStart,
  YOUTUBE_IFRAME_API_URL, YT_PLAYER_STATES, VIDEO_POSITION_SAVE_MS,
} from '../public/youtubePlayer.js';

test('youtubeEmbedUrlWithStart: embed URL with optional start', () => {
  assert.equal(youtubeEmbedUrlWithStart('dQw4w9WgXcQ'), 'https://www.youtube.com/embed/dQw4w9WgXcQ');
  assert.equal(youtubeEmbedUrlWithStart('dQw4w9WgXcQ', 320), 'https://www.youtube.com/embed/dQw4w9WgXcQ?start=320');
  assert.equal(youtubeEmbedUrlWithStart('dQw4w9WgXcQ', 0), 'https://www.youtube.com/embed/dQw4w9WgXcQ');
  assert.equal(youtubeEmbedUrlWithStart('dQw4w9WgXcQ', -5), 'https://www.youtube.com/embed/dQw4w9WgXcQ');
  assert.equal(youtubeEmbedUrlWithStart(''), null);
  assert.equal(youtubeEmbedUrlWithStart(null), null);
});

test('YT_PLAYER_STATES + VIDEO_POSITION_SAVE_MS', () => {
  assert.deepEqual(YT_PLAYER_STATES, { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 });
  assert.equal(VIDEO_POSITION_SAVE_MS, 5000);
});

test('ensureYoutubeApi: resolves immediately when YT.Player already exists', async () => {
  const fakeYt = { Player: class {} };
  const win = { YT: fakeYt };
  const doc = {
    createElement: () => { throw new Error('must not create a script'); },
    head: { appendChild: () => { throw new Error('must not append'); } },
  };
  assert.equal(await ensureYoutubeApi({ window: win, document: doc }), fakeYt);
});

test('ensureYoutubeApi: loads the script once and resolves on ready', async () => {
  const win = {};
  let scriptEl = null;
  let appended = 0;
  const doc = {
    createElement: (tag) => {
      assert.equal(tag, 'script');
      scriptEl = { src: '', async: false, onerror: null };
      return scriptEl;
    },
    head: { appendChild: (el) => { assert.equal(el, scriptEl); appended += 1; } },
  };
  const p = ensureYoutubeApi({ window: win, document: doc });
  assert.equal(scriptEl.src, YOUTUBE_IFRAME_API_URL);
  assert.equal(scriptEl.async, true);
  assert.equal(appended, 1);
  // A second call while loading returns the same promise, no second script.
  assert.equal(ensureYoutubeApi({ window: win, document: doc }), p);
  win.YT = { Player: class {} };
  win.onYouTubeIframeAPIReady();
  assert.equal(await p, win.YT);
});

test('ensureYoutubeApi: script error rejects and a later call retries', async () => {
  const win = {};
  const scripts = [];
  const doc = {
    createElement: () => {
      const s = { src: '', async: false, onerror: null };
      scripts.push(s);
      return s;
    },
    head: { appendChild: () => {} },
  };
  const p = ensureYoutubeApi({ window: win, document: doc }, { timeoutMs: 60000 });
  scripts[0].onerror();
  await assert.rejects(p, /did not load/);
  // A later call retries with a fresh script.
  const p2 = ensureYoutubeApi({ window: win, document: doc }, { timeoutMs: 60000 });
  assert.equal(scripts.length, 2);
  win.YT = { Player: class {} };
  win.onYouTubeIframeAPIReady();
  assert.equal(await p2, win.YT);
});

test('ensureYoutubeApi: rejects after the timeout when the API never arrives', async () => {
  const win = {};
  const doc = {
    createElement: () => ({ src: '', async: false, onerror: null }),
    head: { appendChild: () => {} },
  };
  await assert.rejects(
    ensureYoutubeApi({ window: win, document: doc }, { timeoutMs: 5 }),
    /did not load/,
  );
});

class StubPlayer {
  constructor(element, opts) {
    this.element = element;
    this.opts = opts;
    this.currentTime = 0;
    this.state = YT_PLAYER_STATES.CUED;
    this.destroyed = false;
    this.loaded = [];
    StubPlayer.instances.push(this);
  }

  loadVideoById({ videoId, startSeconds }) {
    this.loaded.push({ videoId, startSeconds });
    this.currentTime = startSeconds;
  }

  getCurrentTime() { return this.currentTime; }

  getPlayerState() { return this.state; }

  seekTo(seconds) { this.currentTime = seconds; }

  destroy() { this.destroyed = true; }

  fire(state) {
    this.state = state;
    this.opts.events.onStateChange({ data: state });
  }

  fireReady() { this.opts.events.onReady({ target: this }); }
}
StubPlayer.instances = [];

test('createVideoPlayer: creation carries the video id + start, load switches', () => {
  StubPlayer.instances = [];
  const states = [];
  let ready = 0;
  const el = {};
  const ctl = createVideoPlayer({
    element: el,
    yt: { Player: StubPlayer },
    videoId: 'dQw4w9WgXcQ',
    startSeconds: 320,
    onReady: () => { ready += 1; },
    onStateChange: (s) => { states.push(s); },
  });
  assert.equal(StubPlayer.instances.length, 1);
  const player = StubPlayer.instances[0];
  assert.equal(player.element, el);
  assert.equal(player.opts.videoId, 'dQw4w9WgXcQ');
  assert.equal(player.opts.playerVars.start, 320);
  assert.equal(ctl.getVideoId(), 'dQw4w9WgXcQ');
  player.fireReady();
  assert.equal(ready, 1);
  player.fire(YT_PLAYER_STATES.PLAYING);
  assert.deepEqual(states, [YT_PLAYER_STATES.PLAYING]);
  player.currentTime = 400;
  assert.equal(ctl.getCurrentTime(), 400);
  assert.equal(ctl.getPlayerState(), YT_PLAYER_STATES.PLAYING);
  ctl.load('9bZkp7q19f0', 45);
  assert.deepEqual(player.loaded, [{ videoId: '9bZkp7q19f0', startSeconds: 45 }]);
  assert.equal(ctl.getVideoId(), '9bZkp7q19f0');
  assert.equal(ctl.getCurrentTime(), 45);
  ctl.destroy();
  assert.equal(player.destroyed, true);
});

test('createVideoPlayer: startSeconds defaults to 0 and clamps bad values', () => {
  StubPlayer.instances = [];
  createVideoPlayer({ element: {}, yt: { Player: StubPlayer }, videoId: 'dQw4w9WgXcQ' });
  assert.equal(StubPlayer.instances[0].opts.playerVars.start, 0);
  const ctl = createVideoPlayer({ element: {}, yt: { Player: StubPlayer }, videoId: 'dQw4w9WgXcQ', startSeconds: -3 });
  assert.equal(StubPlayer.instances[1].opts.playerVars.start, 0);
  ctl.load('9bZkp7q19f0', -1);
  assert.deepEqual(StubPlayer.instances[1].loaded, [{ videoId: '9bZkp7q19f0', startSeconds: 0 }]);
});
