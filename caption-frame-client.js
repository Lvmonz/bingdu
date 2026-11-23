(() => {
  if (!globalThis.parallelReading) return;
  const youtube = globalThis.bingduYoutubeCaptions;
  const native = globalThis.bingduHtml5Captions;
  const watchedVideos = new WeakSet();
  let activity = 0;
  let observedVideo;
  let intersection;
  let port;
  let lastState;
  let suspended = false;
  const embedded = window !== window.top;
  const intersectionObserver = new IntersectionObserver(entries => {
    const entry = entries.find(e => e.target === observedVideo);
    if (entry) intersection = entry.isIntersecting;
  });

  function snapshot() {
    const mode = globalThis.parallelReading?.getState().captionMode || 'off';
    const isYoutube = !!youtube?.isVideoPage();
    const player = isYoutube && [...document.querySelectorAll('#movie_player,.html5-video-player')].find(
      node => node.querySelector('video') && node.getClientRects().length);
    const video = isYoutube ? player?.querySelector('video') : native?.candidate();
    if (video !== observedVideo) {
      intersectionObserver.disconnect();
      observedVideo = video;
      intersection = undefined;
      if (video) intersectionObserver.observe(video);
    }
    const rect = video?.getBoundingClientRect();
    const area = rect ? rect.width * rect.height : 0;
    return { available: !suspended && (isYoutube || !!video), youtube: isYoutube, mode, active: mode !== 'off',
      playing: !!video && !video.paused && !video.ended, ready: !!video, activity, area,
      visible: !!area && (intersection ?? (rect.top < innerHeight && rect.bottom > 0)) };
  }

  function announce() {
    if (suspended) return;
    const s = snapshot();
    if (embedded && !port && s.available) {
      const connection = chrome.runtime.connect({ name: 'bingdu-media-frame' });
      port = connection;
      connection.onDisconnect.addListener(() => { if (port === connection) port = null; });
    }
    const signature = [s.available, s.mode, s.ready, s.playing, s.activity].join('|');
    if (signature !== lastState && (s.available || lastState)) {
      lastState = signature;
      chrome.runtime.sendMessage({ action: 'caption-player-changed' }).catch(() => {});
    }
  }
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message.action === 'probe-caption-player' && !suspended) reply(snapshot());
  });
  for (const event of ['loadedmetadata', 'play', 'playing', 'pause', 'pointerdown']) document.addEventListener(event, e => {
    const el = e.target;
    if (el instanceof HTMLVideoElement) watchVideo(el);
    if (!(el instanceof HTMLVideoElement) && !el.closest?.('#movie_player,.html5-video-player')) return;
    if (event !== 'pause' && event !== 'loadedmetadata') activity = Date.now();
    announce();
  }, true);
  function watchVideo(video) {
    if (watchedVideos.has(video)) return;
    watchedVideos.add(video);
    video.textTracks.addEventListener('addtrack', announce);
    video.textTracks.addEventListener('removetrack', announce);
  }
  for (const video of document.querySelectorAll('video')) watchVideo(video);
  document.addEventListener('load', e => { if (e.target instanceof HTMLTrackElement) announce(); }, true);
  document.addEventListener('bingdu-caption-state-changed', announce);
  document.addEventListener('yt-navigate-finish', announce);
  window.addEventListener('pagehide', () => {
    suspended = true;
    if (embedded && lastState) chrome.runtime.sendMessage({ action: 'caption-frame-left' }).catch(() => {});
    port?.disconnect();
    port = null;
  });
  window.addEventListener('pageshow', () => { suspended = false; lastState = null; announce(); });
  announce();
})();
