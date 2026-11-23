(() => {
  if (!/(^|\.)youtube(?:-nocookie|education)?\.com$/.test(location.hostname)) return;
  const byteLimit = 2 * 1024 * 1024;

  async function readTrack(response) {
    if (!response.ok || !response.body || Number(response.headers.get('Content-Length')) > byteLimit) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > byteLimit) {
          await reader.cancel();
          return '';
        }
        parts.push(decoder.decode(value, { stream: true }));
      }
      return parts.join('') + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }

  function timestamp(value) {
    return value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  }

  function parseTrack(raw) {
    const cues = [];
    function add(start, duration, source) {
      const text = source.replace(/\s+/gu, ' ').trim();
      if (Number.isFinite(start) && start >= 0 && duration > 0 && duration <= 120 && text && text.length <= 1000) {
        cues.push({ start, end: start + duration, text });
      }
    }
    const data = raw.trim();
    if (data.startsWith('{')) {
      const events = JSON.parse(data).events;
      if (!Array.isArray(events) || events.length > 20000) return [];
      for (const event of events) {
        if (Array.isArray(event?.segs) && Number.isFinite(event.tStartMs) && !event.aAppend) {
          add(event.tStartMs / 1000, event.dDurationMs / 1000,
            event.segs.map(seg => typeof seg?.utf8 === 'string' ? seg.utf8 : '').join(''));
        }
      }
    } else if (data.startsWith('<') && !/<!DOCTYPE/i.test(data)) {
      const doc = new DOMParser().parseFromString(data, 'application/xml');
      const format = doc.documentElement.localName;
      if (format !== 'timedtext' && format !== 'transcript') return [];
      const rows = doc.querySelectorAll(format === 'timedtext' ? 'body > p[t][d]' : 'transcript > text[start][dur]');
      if (rows.length > 20000) return [];
      for (const row of rows) {
        for (const br of row.querySelectorAll('br')) br.replaceWith('\n');
        if (format === 'timedtext') add(Number(row.getAttribute('t')) / 1000, Number(row.getAttribute('d')) / 1000, row.textContent);
        else add(Number(row.getAttribute('start')), Number(row.getAttribute('dur')), row.textContent);
      }
    } else if (/^WEBVTT(?:\s|$)/.test(data)) {
      for (const block of data.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
        const lines = block.split('\n');
        const timingIndex = lines[0].includes('-->') ? 0 : 1;
        const times = lines[timingIndex]?.match(/^((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})(?:\s|$)/);
        if (!times) continue;
        const start = timestamp(times[1]);
        const end = timestamp(times[2]);
        const text = new VTTCue(start, end, lines.slice(timingIndex + 1).join('\n')).getCueAsHTML().textContent;
        add(start, end - start, text);
        if (cues.length > 20000) return [];
      }
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  globalThis.bingduYoutubeTrackHints = function (videoId, onCues) {
    if (!videoId || typeof PerformanceObserver === 'undefined') return () => {};
    let track = '';
    let latestStart = -1;
    let lastUrl = '';
    let attempts = 0;
    let loaded = false;
    let stopped = false;
    let pending;
    // Ignore resource timings produced by this reader, including when a late
    // completion from the previous language lands after the user switches.
    const ownReads = new Map();

    async function load(url, controller) {
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const before = performance.now();
        const sameOrigin = url.origin === location.origin;
        const request = fetch(url.href, { mode: sameOrigin ? 'same-origin' : 'cors',
          credentials: sameOrigin ? 'same-origin' : 'omit', cache: 'force-cache', redirect: 'error', signal: controller.signal });
        ownReads.set(url.href, [before - 1, performance.now() + 1]);
        const cues = parseTrack(await readTrack(await request));
        if (cues.length && !stopped && pending === controller && !controller.signal.aborted) {
          loaded = true;
          onCues(cues, trackInfo(url));
        }
      } catch {
        // Optional lookahead. Transient, empty or unsupported responses use visible captions.
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    }

    function trackInfo(url) {
      return { language: url.searchParams.get('lang') || '', translated: url.searchParams.get('tlang') || '' };
    }

    function observe(entries) {
      if (stopped) return;
      let latest;
      for (const entry of entries) {
        if (entry.startTime <= latestStart || !entry.name.includes('/api/timedtext')) continue;
        const own = ownReads.get(entry.name);
        if (own && entry.startTime >= own[0] && entry.startTime <= own[1]) continue;
        let url;
        try { url = new URL(entry.name); } catch { continue; }
        // Privacy-enhanced and education embeds may load their actual caption track
        // from www.youtube.com. Reuse only the observed URL if CORS permits it.
        const allowed = url.origin === location.origin || /^\/embed(?:\/|$)/.test(location.pathname) &&
          url.origin === 'https://www.youtube.com';
        if (!allowed || url.pathname !== '/api/timedtext' || url.searchParams.get('v') !== videoId) continue;
        if (!latest || entry.startTime >= latest.startTime) latest = { startTime: entry.startTime, url };
      }
      if (!latest) return;
      latestStart = latest.startTime;
      const { url } = latest;
      const params = url.searchParams;
      const key = JSON.stringify(['lang', 'tlang', 'kind', 'name', 'vssId'].map(field => params.get(field)));
      if (key !== track) {
        pending?.abort();
        track = key;
        loaded = false;
        attempts = 0;
        lastUrl = '';
        onCues([], trackInfo(url));
      }
      if (loaded || attempts >= 2 || url.href === lastUrl || params.has('sq') || params.has('seq') || params.has('live')) return;
      attempts++;
      lastUrl = url.href;
      pending?.abort();
      pending = new AbortController();
      if (ownReads.size >= 16) ownReads.delete(ownReads.keys().next().value);
      void load(url, pending);
    }

    const observer = new PerformanceObserver(list => observe(list.getEntries()));
    observer.observe({ type: 'resource', buffered: true });
    return () => {
      stopped = true;
      observer.disconnect();
      pending?.abort();
      ownReads.clear();
    };
  };
})();
