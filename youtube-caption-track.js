(() => {
  if (!/(^|\.)youtube(?:-nocookie|education)?\.com$/.test(location.hostname)) return;
  if (typeof PerformanceObserver === 'undefined') return;
  const byteLimit = 2 * 1024 * 1024;
  // YouTube can clear resource timings before the reader opens the subtitle
  // menu. Remember only recent caption requests; fetch only in an active session.
  const recentTracks = new Map();
  const subscribers = new Set();
  const timings = new PerformanceObserver(list => {
    const entries = list.getEntries().filter(entry => entry.name.includes('/api/timedtext'));
    for (const { name, startTime } of entries) {
      recentTracks.delete(name);
      recentTracks.set(name, { name, startTime });
      if (recentTracks.size > 16) recentTracks.delete(recentTracks.keys().next().value);
    }
    if (entries.length) for (const notify of subscribers) notify(entries);
  });
  timings.observe({ type: 'resource', buffered: true });

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

  // ASR display windows overlap to keep earlier words on screen. Word offsets,
  // unlike window end times, describe when each part of the utterance begins.
  function speechCues(events) {
    const words = [];
    for (const { start, duration, segments } of events) {
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || duration > 120000) return [];
      for (const segment of segments) {
        const text = typeof segment.text === 'string' ? segment.text.trim() : '';
        if (!text) continue;
        const at = start + (segment.offset ?? 0);
        const previous = words.at(-1);
        if (!Number.isFinite(at) || at < start || at >= start + duration || at < (previous?.at ?? 0)) return [];
        const suffix = /^[.,!?;:%)\]]|^['’](?:s|re|ll|ve|d|t|m)\b/i.test(text);
        if (previous && (at === previous.at || suffix && at <= previous.end)) {
          previous.text += (suffix ? '' : ' ') + text;
          previous.end = Math.max(previous.end, start + duration);
          continue;
        }
        words.push({ text, at, end: start + duration });
      }
    }
    const cues = [];
    let begin = 0, clause = -1, length = 0;
    function emit(stop) {
      const last = words[stop - 1], next = words[stop];
      const end = Math.min(last.end, next?.at ?? Infinity, last.at + 1100);
      if (end > words[begin].at) cues.push({ start:words[begin].at / 1000, end:end / 1000,
        text:words.slice(begin, stop).map(word => word.text).join(' ') });
      begin = stop;
      clause = -1;
      length = 0;
    }
    for (let i = 0; i < words.length; i++) {
      const word = words[i], next = words[i + 1];
      length += word.text.length + 1;
      const abbreviation = /^(?:mr|mrs|ms|dr|prof|sr|jr|e\.g|i\.e|(?:[a-z]\.)*[a-z])\.$/i.test(word.text);
      const sentenceEnd = !abbreviation && /[.!?…][”"'’)]*$/.test(word.text);
      if (!next || sentenceEnd || next.at - word.at > 1250 || word.end < next.at || /^>>/.test(next.text)) {
        emit(i + 1);
      } else {
        if (i - begin >= 4 && (/[,;:][”"'’)]*$/.test(word.text) || /^(?:but|because|which|although|while)$/i.test(next.text))) clause = i + 1;
        if (length >= 120 || next.at - words[begin].at >= 7300) {
          const stop = clause > begin ? clause : i + 1;
          emit(stop);
          i = stop - 1;
        }
      }
    }
    return cues;
  }

  function parseTrack(raw, info) {
    const cues = [];
    const speech = [];
    const segmentEnglish = info.automatic && !info.translated && /^en(?:-|$)/i.test(info.language);
    let wordTimed = false;
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
        if (!Array.isArray(event?.segs) || !Number.isFinite(event.tStartMs)) continue;
        const text = event.segs.map(seg => typeof seg?.utf8 === 'string' ? seg.utf8 : '').join('');
        if (!text.trim()) continue;
        add(event.tStartMs / 1000, event.dDurationMs / 1000, text);
        if (!segmentEnglish) continue;
        wordTimed ||= event.segs.some(seg => Number.isFinite(seg?.tOffsetMs) && seg.tOffsetMs > 0);
        speech.push({ start:event.tStartMs, duration:event.dDurationMs,
          segments:event.segs.map(seg => ({text:seg?.utf8, offset:seg?.tOffsetMs})) });
      }
    } else if (data.startsWith('<') && !/<!DOCTYPE/i.test(data)) {
      const doc = new DOMParser().parseFromString(data, 'application/xml');
      const format = doc.documentElement.localName;
      if (format !== 'timedtext' && format !== 'transcript') return [];
      const rows = doc.querySelectorAll(format === 'timedtext' ? 'body > p[t][d]' : 'transcript > text[start][dur]');
      if (rows.length > 20000) return [];
      for (const row of rows) {
        for (const br of row.querySelectorAll('br')) br.replaceWith('\n');
        if (format === 'timedtext') {
          const start = Number(row.getAttribute('t')), duration = Number(row.getAttribute('d'));
          add(start / 1000, duration / 1000, row.textContent);
          if (segmentEnglish && row.textContent.trim()) {
            const spans = [...row.querySelectorAll('s')];
            wordTimed ||= spans.some(span => Number(span.getAttribute('t')) > 0);
            speech.push({ start, duration, segments:spans.length ? spans.map(span => ({
              text:span.textContent, offset:Number(span.getAttribute('t'))
            })) : [{text:row.textContent}] });
          }
        }
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
    if (wordTimed) {
      const sentences = speechCues(speech);
      if (sentences.length) { info.segmented = true; return sentences; }
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  globalThis.bingduYoutubeTrackHints = function (videoId, onCues) {
    if (!videoId) return () => {};
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
        const info = trackInfo(url);
        const cues = parseTrack(await readTrack(await request), info);
        if (cues.length && !stopped && pending === controller && !controller.signal.aborted) {
          loaded = true;
          onCues(cues, info);
        }
      } catch {
        // Optional lookahead. Transient, empty or unsupported responses use visible captions.
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    }

    function trackInfo(url) {
      return { language: url.searchParams.get('lang') || '', translated: url.searchParams.get('tlang') || '',
        automatic: url.searchParams.get('kind') === 'asr' || /^a\./.test(url.searchParams.get('vssId') || '') };
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

    subscribers.add(observe);
    observe(recentTracks.values());
    return () => {
      stopped = true;
      subscribers.delete(observe);
      pending?.abort();
      ownReads.clear();
    };
  };
})();
