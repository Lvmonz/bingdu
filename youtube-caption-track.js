(() => {
  if (!/(^|\.)youtube(?:-nocookie|education)?\.com$/.test(location.hostname)) return;
  if (typeof PerformanceObserver === 'undefined') return;
  const byteLimit = 2 * 1024 * 1024;
  // YouTube can clear resource timings before the reader opens the subtitle
  // menu. Remember only recent caption requests; fetch only in an active session.
  const recentTracks = new Map();
  const subscribers = new Set();
  const authoredReads = new Map();
  const timings = new PerformanceObserver(list => {
    const entries = list.getEntries().filter(entry => entry.name.includes('/api/timedtext') &&
      !(authoredReads.has(entry.name) && Math.abs(entry.startTime - authoredReads.get(entry.name)) < 50));
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

  const punctuation = /[.?!。？！]/u;
  const abbreviation = /(?:\b(?:etc|mr|mrs|ms|dr|prof|sr|jr|co|inc|ltd|st)\.|u\.s\.|u\.k\.|p\.a\.|\d+\.)/i;
  const markers = new Set(['mhm', 'um', '>>', '-']);
  const turns = new Set([...markers, 'in fact', 'such as', 'or even', 'get me', "well i'm", "i didn't", 'i know', 'i need', 'i will', "i'll", 'i mean', 'you are', 'what does', 'no problem', 'as we', 'if you', 'hello', 'okay', 'oh', 'yep', 'yes', 'hey', 'hi', 'yeah', 'essentially', 'because', 'and', 'but', 'which', 'so', 'where', 'what', 'now', 'or', 'how', 'after']);
  const continueAfter = new Set('in is and are not an a some the but our for of if his her my come mean why this has make p.m a.m'.split(' '));
  const continueBefore = new Set('or to in has of are is with'.split(' '));

  const joined = group => group.map(word => word.text).join('');
  const wordCount = group => joined(group).split(/\s+/u).length;

  function cutAtPauses(group, threshold, breaks, omitFillers) {
    const parts = [];
    let current = [];
    let previous = group[0].time;
    for (let i = 0; i < group.length; i++) {
      const word = group[i], next = group[i + 1];
      const gap = word.time - previous;
      const single = gap > 300 && breaks.has(word.text.trim().toLowerCase());
      const double = !single && gap > 300 && next && breaks.has((word.text + next.text).trim().toLowerCase());
      const previousEnd = current.at(-1)?.windowEnd;
      if (single || double || gap > threshold || previousEnd < word.time) {
        if (current.length) parts.push(current);
        current = [];
      }
      if (single || double) word.explicitBreak = true;
      if (omitFillers && word.text.trim().toLowerCase() === 'uh' && next && !single && !double) {
        current.push(word, next);
        previous = next.time;
        i++;
      } else {
        current.push(word);
        if (double) { current.push(next); i++; }
        previous = word.time;
      }
    }
    if (current.length) parts.push(current);
    return parts;
  }

  function fitLongGroups(group, pause, breaks, omitFillers) {
    const result = [];
    let singletons = [];
    const flush = () => { if (singletons.length) result.push(singletons); singletons = []; };
    for (const part of cutAtPauses(group, pause, breaks, omitFillers)) {
      if (part.length > 1 && wordCount(part) > 17 && pause >= 0) {
        flush();
        result.push(...fitLongGroups(part, pause - 100, breaks, omitFillers));
      } else if (part.length === 1 && wordCount(part) <= 1) {
        singletons.push(part[0]);
      } else {
        flush();
        result.push(part);
      }
    }
    flush();
    return result;
  }

  function joinShortTails(groups) {
    const joinedGroups = [];
    for (const group of groups) {
      const prev = joinedGroups.at(-1), first = group[0];
      if (prev && !first.explicitBreak && first.time - prev.at(-1).time <= 1500 &&
          (continueAfter.has(prev.at(-1).text.trim().toLowerCase()) || continueBefore.has(first.text.trim().toLowerCase())) &&
          wordCount([...prev, ...group]) <= 19) prev.push(...group);
      else joinedGroups.push(group);
    }
    for (const [maxGap, maxTail] of [[1000, 3], [1500, 1]]) {
      for (let i = joinedGroups.length - 1; i > 0; i--) {
        const tail = joinedGroups[i], prev = joinedGroups[i - 1];
        if (tail.length <= maxTail && tail.length + prev.length < 20 && !tail[0].explicitBreak &&
            tail[0].time - prev.at(-1).time <= maxGap) {
          prev.push(...tail);
          joinedGroups.splice(i, 1);
        }
      }
    }
    return joinedGroups;
  }

  // Word offsets are the smallest reliable time unit. Map locale-aware sentence
  // boundaries back to those offsets, and cap continuous unpunctuated speech.
  function localizedGroups(words, language) {
    let segmenter;
    try { segmenter = new Intl.Segmenter(language || undefined, {granularity:'sentence'}); }
    catch { segmenter = new Intl.Segmenter(undefined, {granularity:'sentence'}); }
    const text = joined(words);
    const ends = Array.from(segmenter.segment(text), s => s.index + s.segment.trimEnd().length);
    const groups = [];
    let first = 0, offset = 0, sentence = 0;
    for (let i = 0; i < words.length; i++) {
      const word = words[i], next = words[i + 1];
      offset += word.text.length;
      const boundary = ends[sentence] <= offset;
      while (ends[sentence] <= offset) sentence++;
      if (!next || boundary || next.time - word.time >= 1000 || word.windowEnd < next.time ||
          next.time - words[first].time >= 5500) {
        groups.push(words.slice(first, i + 1));
        first = i + 1;
      }
    }
    return groups;
  }

  function speechCues(events, language) {
    const english = /^en(?:-|$)/i.test(language);
    const words = [];
    for (const {start, duration, segments} of events) {
      if (!Number.isFinite(start) || start < 0 || !(duration > 0 && duration <= 120000)) continue;
      const firstIndex = words.length;
      for (const segment of segments) {
        if (typeof segment.text !== 'string' || !segment.text.trim()) continue;
        const time = start + (segment.offset ?? 0);
        if (!Number.isFinite(time) || time < start || time > start + duration ||
            (words.length && time < words.at(-1).time)) return [];
        // A new rolling window often begins without a leading space.
        const text = firstIndex === words.length && words.length && !/^\s|^[\p{P}]/u.test(segment.text) &&
          !/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u.test(words.at(-1).text.slice(-1) + segment.text[0])
          ? ' ' + segment.text : segment.text;
        words.push({time, text});
      }
      if (words.length > firstIndex) words.at(-1).windowEnd = start + duration;
    }
    if (!words.length) return [];
    // Phrase-timed ASR can carry offsets, too. Splitting these records as words
    // would discard the original phrase boundaries and invent timing precision.
    if (english && words.slice(0, 20).some(w => w.text.trim().split(/\s+/u).length >= 3)) return [];
    const punctuated = words.filter(w => punctuation.test(w.text)).length >= 10;
    let groups;
    if (!english) {
      groups = localizedGroups(words, language);
    } else if (punctuated) {
      const sentences = [];
      let from = 0;
      for (let i = 0; i < words.length; i++) {
        const token = words[i].text.trim();
        if (i === words.length - 1 || (punctuation.test(token.slice(-1)) && !abbreviation.test(token))) {
          sentences.push(words.slice(from, i + 1));
          from = i + 1;
        }
      }
      groups = sentences.flatMap(sentence => fitLongGroups(sentence, 5000, markers, false));
    } else {
      groups = joinShortTails(fitLongGroups(words, 1000, turns, true));
    }
    // Fast speech can have no punctuation or useful pauses. Bound the visual
    // length at a real timestamp; tokens sharing an instant stay together.
    groups = groups.flatMap(group => {
      const parts = [];
      let from = 0, length = 0;
      for (let i = 0; i < group.length; i++) {
        if (i > from && group[i].time > group[i-1].time &&
            (i - from >= 19 || length + group[i].text.length > 115)) {
          parts.push(group.slice(from, i));
          from = i;
          length = 0;
        }
        length += group[i].text.length;
      }
      parts.push(group.slice(from));
      return parts;
    });
    return groups.map((group, i) => {
      const last = group.at(-1);
      const next = groups[i+1]?.[0].time ?? (english ? last.time : last.windowEnd ?? last.time);
      // The final single-word cue also needs a positive display interval.
      const end = Math.min(last.windowEnd ?? next, next);
      return {start:group[0].time / 1000,
        end:(end > group[0].time ? end : last.windowEnd ?? last.time + 250) / 1000,
        text:joined(group).replace(/\s+/gu, ' ').trim(),
        words:group.map(word => ({text:word.text, start:word.time / 1000}))};
    });
  }

  function parseTrack(raw, info) {
    const cues = [];
    const speech = [];
    const sourceTrack = !info.translated;
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
      // Some player URLs omit kind=asr; the confidence field belongs to recognition results.
      info.automatic ||= events.some(event => event?.segs?.some?.(seg => Number.isFinite(seg?.acAsrConf)));
      for (const event of events) {
        if (!Array.isArray(event?.segs) || !Number.isFinite(event.tStartMs)) continue;
        const text = event.segs.map(seg => typeof seg?.utf8 === 'string' ? seg.utf8 : '').join('');
        if (!text.trim()) continue;
        add(event.tStartMs / 1000, event.dDurationMs / 1000, text);
        if (!sourceTrack || !info.automatic) continue;
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
          if (sourceTrack && info.automatic && row.textContent.trim()) {
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
      const sentences = speechCues(speech, info.language);
      if (sentences.length) { info.segmented = true; return sentences; }
    }
    cues.sort((a, b) => a.start - b.start);
    if (info.automatic && !info.translated) {
      // Untimed ASR formats can still contain overlapping display windows.
      // Retire the previous window when a later one starts.
      for (let i = 1; i < cues.length; i++) cues[i-1].end = Math.min(cues[i-1].end, cues[i].start);
      return cues.filter(cue => cue.end > cue.start);
    }
    return cues;
  }

  function allowedTrack(url, videoId) {
    return (url.origin === location.origin ||
      /^\/embed(?:\/|$)/.test(location.pathname) && url.origin === 'https://www.youtube.com') &&
      !url.username && !url.password && url.pathname === '/api/timedtext' && url.searchParams.get('v') === videoId;
  }

  globalThis.bingduReadAuthoredCaption = async function (address, videoId, target, signal) {
    try {
      const url = new URL(address);
      const lang = url.searchParams.get('lang') || '';
      if (!allowedTrack(url, videoId) || new Intl.Locale(lang).language !== new Intl.Locale(target).language ||
          new Intl.Locale(target).script && new Intl.Locale(lang).maximize().script !== new Intl.Locale(target).script ||
          ['tlang','sq','seq','live'].some(field => url.searchParams.has(field)) ||
          ['asr','forced'].includes(url.searchParams.get('kind')) || /^a\./.test(url.searchParams.get('vssId') || '')) return [];
      if (authoredReads.size >= 16) authoredReads.delete(authoredReads.keys().next().value);
      authoredReads.set(url.href, performance.now());
      const same = url.origin === location.origin;
      const response = await fetch(url, {mode:same ? 'same-origin' : 'cors', credentials:same ? 'same-origin' : 'omit',
        redirect:'error', cache:'force-cache', signal:AbortSignal.any([signal,AbortSignal.timeout(4500)])});
      return parseTrack(await readTrack(response), {language:lang});
    } catch { return []; }
  };

  globalThis.bingduYoutubeTrackHints = function (videoId, onCues, currentSession) {
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

    const trackKey = url => JSON.stringify(['lang','tlang','kind','name','vssId'].map(k => url.searchParams.get(k)));
    function received(event) {
      if (!currentSession || typeof event.detail !== 'string' || event.detail.length > 3 * byteLimit) return;
      try {
        const {session, address, started, text} = JSON.parse(event.detail);
        if (session !== currentSession() || typeof text !== 'string' || text.length > byteLimit || !Number.isFinite(started)) return;
        const url = new URL(address);
        if (!allowedTrack(url, videoId)) return;
        const key = trackKey(url);
        if ((loaded && key === track) || (track && key !== track && started < latestStart)) return;
        const info = trackInfo(url), cues = parseTrack(text,info);
        if (!cues.length) return;
        pending?.abort();
        track = key;
        loaded = true;
        latestStart = Math.max(latestStart, started);
        onCues(cues,info);
      } catch { /* The normal track reader still handles empty or unsupported bodies. */ }
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
        if (!allowedTrack(url, videoId)) continue;
        if (!latest || entry.startTime >= latest.startTime) latest = { startTime: entry.startTime, url };
      }
      if (!latest) return;
      latestStart = latest.startTime;
      const { url } = latest;
      const params = url.searchParams;
      const key = trackKey(url);
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

    globalThis.document?.addEventListener('bingdu-youtube-track-body',received);
    subscribers.add(observe);
    observe(recentTracks.values());
    return () => {
      stopped = true;
      globalThis.document?.removeEventListener('bingdu-youtube-track-body',received);
      subscribers.delete(observe);
      pending?.abort();
      ownReads.clear();
    };
  };
})();
