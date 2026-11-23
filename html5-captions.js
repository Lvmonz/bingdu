(() => {
  function tracks(video) {
    return [...video.textTracks].filter(track => track.kind === 'captions' || track.kind === 'subtitles');
  }

  function candidate() {
    const videos = [...document.querySelectorAll('video')].filter(video => tracks(video).length);
    return videos.find(video => !video.paused && !video.ended) ||
      videos.find(video => video.getClientRects().length) || videos[0];
  }

  function start(video, translate, mode, onStop, notice) {
    const available = tracks(video);
    const track = available.find(t => t.mode === 'showing') || available[0];
    const output = document.createElement('div');
    output.className = 'pt-translation pt-html5-caption';
    output.setAttribute('translate', 'no');
    output.setAttribute('aria-live', 'polite');
    video.after(output);
    const originalModes = new Map();
    for (const t of available) {
      if (t === track || t.mode === 'showing') {
        originalModes.set(t, t.mode);
        t.mode = 'hidden';
      }
    }
    let version = 0;
    let original = '';
    let translation = '';
    function draw() {
      const lines = mode === 'dual' && original !== translation ? [original, translation] : [translation];
      output.textContent = lines.filter(Boolean).join('\n');
      output.hidden = !output.textContent;
    }
    async function update() {
      const current = ++version;
      original = [...(track.activeCues || [])].map(cue => cue.getCueAsHTML?.().textContent ??
        String(cue.text || '').replace(/<[^>]*>/g, '')).join('\n').trim();
      translation = '';
      draw();
      if (!original) return;
      try {
        const [result] = await translate([original]);
        if (current === version) { translation = result; draw(); }
      } catch (error) {
        if (current === version) notice(error.message);
      }
    }
    const observer = new MutationObserver(() => { if (!video.isConnected) stop(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    function checkTrack() { if (!tracks(video).includes(track)) stop(); }
    track.addEventListener('cuechange', update);
    video.textTracks.addEventListener('removetrack', checkTrack);
    void update();
    function stop() {
      version++;
      observer.disconnect();
      video.textTracks.removeEventListener('removetrack', checkTrack);
      track.removeEventListener('cuechange', update);
      for (const [t, previous] of originalModes) if (t.mode === 'hidden') t.mode = previous;
      output.remove();
      onStop();
    }
    return { stop, refresh: update, setMode(next) { mode = next; draw(); }, get mode() { return mode; } };
  }
  globalThis.bingduHtml5Captions = { candidate, start };
})();
