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
    const timeline = globalThis.bingduCaptionTimeline;
    const cards = [];
    let byCue = new WeakMap();
    let snapshot = {};
    let active = true;
    let session;
    const textOf = cue => (cue.getCueAsHTML?.().textContent ?? String(cue.text || '')).trim();
    function draw() {
      const visible = video.ended ? [] : timeline.atTime(cards, video.currentTime);
      const original = visible.map(card => card.text).join('\n');
      const translation = visible.every(card => card.translation) ? visible.map(card => card.translation).join('\n') : '';
      const lines = mode === 'dual' && original !== translation ? [original, translation] : [translation];
      const text = lines.filter(Boolean).join('\n');
      if (output.textContent !== text) output.textContent = text;
      output.hidden = !text;
    }
    function readTrack() {
      const cues = track.cues?.length ? track.cues : track.activeCues;
      const length = cues?.length || 0;
      const first = cues?.[0], last = cues?.[length - 1];
      // Streaming players may edit a cue in place while it is being spoken.
      const changed = Array.from(track.activeCues || []).some(cue => {
        const card = byCue.get(cue);
        return !card || card.start !== cue.startTime || card.end !== cue.endTime || card.raw !== cue.text;
      });
      if (!changed && snapshot.length === length && snapshot.first === first && snapshot.last === last) return;
      snapshot = {length, first, last};
      cards.length = 0;
      for (const cue of cues || []) {
        let card = byCue.get(cue);
        if (!card || card.start !== cue.startTime || card.end !== cue.endTime || card.raw !== cue.text) {
          card = {start:cue.startTime, end:cue.endTime, raw:cue.text, text:textOf(cue)};
          byCue.set(cue, card);
        }
        if (card.text && card.end > card.start) cards.push(card);
      }
      cards.sort((a, b) => a.start - b.start);
      timeline.indexCards(cards);
    }
    function update() {
      if (!active) return;
      readTrack();
      draw();
      if (!video.ended) session.update(video.currentTime);
    }
    function refresh() {
      session?.close();
      snapshot = {};
      byCue = new WeakMap();
      session = timeline.createSession(cards, translate, {title:document.title.slice(0, 180), repaint:draw,
        onError:error => notice(error.message)});
      update();
    }
    const observer = new MutationObserver(() => { if (!video.isConnected) stop(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    function checkTrack() { if (!tracks(video).includes(track)) stop(); }
    const events = new AbortController();
    for (const event of ['timeupdate','seeked','seeking','loadedmetadata','ended']) {
      video.addEventListener(event, update, {signal:events.signal});
    }
    video.addEventListener('load', update, {capture:true, signal:events.signal});
    track.addEventListener('cuechange', update, {signal:events.signal});
    video.textTracks.addEventListener('removetrack', checkTrack, {signal:events.signal});
    refresh();
    function stop() {
      if (!active) return;
      active = false;
      session.close();
      observer.disconnect();
      events.abort();
      for (const [t, previous] of originalModes) if (t.mode === 'hidden') t.mode = previous;
      output.remove();
      onStop();
    }
    return { stop, refresh, setMode(next) { mode = next; draw(); }, get mode() { return mode; } };
  }
  globalThis.bingduHtml5Captions = { candidate, start };
})();
