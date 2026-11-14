/* YouTube IFrame Player API — loader + a small player controller.
   No DOM is touched at import time, so this is unit-testable in node:
   pass a fake `env` ({window, document}) to drive the loader, and a
   fake `yt` ({Player}) to drive the controller.
   The app loads the API script once (ensureYoutubeApi) and keeps one
   player for the session; switching videos reuses it via loadVideoById.
   When the API cannot load (offline, blocked network), the caller falls
   back to a plain embed iframe with ?start= — resume still works, only
   position saving needs the API. */

export const YOUTUBE_IFRAME_API_URL = 'https://www.youtube.com/iframe_api';
/* How often the app records the playback position while a video plays. */
export const VIDEO_POSITION_SAVE_MS = 5000;
/* YT.PlayerState numbers, for callers that do not have the YT global. */
export const YT_PLAYER_STATES = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

/* Plain embed URL for a video, optionally starting at `seconds` — the
   no-API fallback (and what a fresh player load seeks to). */
export function youtubeEmbedUrlWithStart(videoId, seconds = 0) {
  const id = String(videoId ?? '').trim();
  if (!id) return null;
  const s = Number.isInteger(seconds) && seconds > 0 ? seconds : 0;
  return `https://www.youtube.com/embed/${encodeURIComponent(id)}${s ? `?start=${s}` : ''}`;
}

/* Load the IFrame API script once per window and resolve with window.YT.
   Resolves immediately when YT.Player is already there (a test stub, or
   a second call after the first load). Rejects after `timeoutMs` or on a
   script error; a failed load clears the cached promise so a later call
   retries instead of returning the same rejection. */
export function ensureYoutubeApi(env = globalThis, { timeoutMs = 10000 } = {}) {
  const win = env.window ?? env;
  const doc = env.document ?? (typeof document !== 'undefined' ? document : undefined);
  if (win.YT?.Player) return Promise.resolve(win.YT);
  if (win.__nmYtApiPromise) return win.__nmYtApiPromise;
  const promise = new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(new Error('YouTube API did not load')), timeoutMs);
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else if (win.YT?.Player) resolve(win.YT);
      else reject(new Error('YouTube API did not load'));
    };
    const prev = win.onYouTubeIframeAPIReady;
    win.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') {
        try { prev(); } catch { /* ignore */ }
      }
      finish(null);
    };
    const script = doc.createElement('script');
    script.src = YOUTUBE_IFRAME_API_URL;
    script.async = true;
    script.onerror = () => finish(new Error('YouTube API did not load'));
    (doc.head || doc.documentElement).appendChild(script);
  });
  win.__nmYtApiPromise = promise;
  promise.catch(() => {
    if (win.__nmYtApiPromise === promise) delete win.__nmYtApiPromise;
  });
  return promise;
}

/* Create a YT.Player in `element` (a div — the API replaces it with an
   iframe) and return a controller. Playback begins at `startSeconds`
   (playerVars.start on creation, loadVideoById's startSeconds on a
   switch). onStateChange receives the numeric YT state; onReady fires
   once the player is ready. */
export function createVideoPlayer({ element, yt, videoId, startSeconds = 0, onReady, onStateChange } = {}) {
  const start = Number.isInteger(startSeconds) && startSeconds > 0 ? startSeconds : 0;
  let currentVideoId = videoId;
  const player = new yt.Player(element, {
    videoId,
    playerVars: { start, rel: 0, modestbranding: 1 },
    events: {
      onReady: (e) => { if (typeof onReady === 'function') onReady(e); },
      onStateChange: (e) => {
        if (typeof onStateChange === 'function') onStateChange(e?.data ?? e);
      },
    },
  });
  return {
    load(nextVideoId, nextStartSeconds = 0) {
      const s = Number.isInteger(nextStartSeconds) && nextStartSeconds > 0 ? nextStartSeconds : 0;
      currentVideoId = nextVideoId;
      player.loadVideoById({ videoId: nextVideoId, startSeconds: s });
    },
    getCurrentTime() {
      try { return player.getCurrentTime() ?? 0; } catch { return 0; }
    },
    getPlayerState() {
      try { return player.getPlayerState(); } catch { return -1; }
    },
    getVideoId() { return currentVideoId; },
    destroy() {
      try { player.destroy(); } catch { /* ignore */ }
    },
  };
}
