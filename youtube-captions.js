(() => {
  if (!/(^|\.)youtube(?:-nocookie|education)?\.com$/.test(location.hostname)) return;

  const windows = '.ytp-caption-window-container, .caption-window';
  const cc = '.ytp-subtitles-button,.ytmClosedCaptioningButtonButton';
  const normalize = text => text.replace(/\s+/gu, ' ').trim();
  const embed = /^\/embed(?:\/|$)/.test(location.pathname);
  const videoId = () => embed ? 'embed' : new URLSearchParams(location.search).get('v') ||
    location.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1];

  function captionButton(player) {
    // YouTube's newer embedded layout renders controls next to the player.
    const separate = embed && document.querySelector(':is(#player-control-overlay,#player-controls) :is(' + cc + ')');
    return separate || player.querySelector(cc);
  }

  function languageCode(name) {
    const known = { '简体中文':'zh-Hans', '繁體中文':'zh-Hant', '中文':'zh', '英语':'en', '日语':'ja', '韩语':'ko', '法语':'fr', '德语':'de', '西班牙语':'es' };
    if (Object.hasOwn(known, name)) return known[name];
    try { return Intl.getCanonicalLocales(name)[0]; } catch { return ''; }
  }
  const base = code => typeof code === 'string' ? code.toLowerCase().split('-')[0] : '';
  function sameLanguage(a, b) {
    if (!base(a) || base(a) !== base(b)) return false;
    if (base(a) !== 'zh') return true;
    try { return new Intl.Locale(a).maximize().script === new Intl.Locale(b).maximize().script; } catch { return false; }
  }
  function targetScript(text, code) {
    if (base(code) === 'zh') return /\p{Script=Han}/u.test(text) && !/[\p{Script=Kana}\p{Script=Hiragana}\p{Script=Hangul}]/u.test(text);
    if (base(code) === 'ja') return /[\p{Script=Kana}\p{Script=Hiragana}]/u.test(text);
    if (base(code) === 'ko') return /\p{Script=Hangul}/u.test(text);
    return false;
  }
  const compare = text => normalize(text).normalize('NFKC').toLowerCase().replace(/[\p{P}\s]/gu, '');

  function dialogueSegments(player) {
    // YouTube paints its language/settings toast with the same segment
    // classes as speech. Its top window contains the inline settings icon.
    return [...player.querySelectorAll('.ytp-caption-segment')].filter(segment =>
      segment.closest(windows) && segment.getClientRects().length &&
      !segment.closest('[hidden],[aria-hidden="true"],.ytp-caption-window-top:has(.ytp-caption-segment svg)'));
  }
  function captionLines(player) {
    const groups = new Map();
    for (const segment of dialogueSegments(player)) {
      const window = segment.closest('.caption-window,.ytp-caption-window-container');
      if (!groups.has(window)) groups.set(window, new Map());
      const rows = groups.get(window);
      const row = segment.closest('.caption-visual-line') || window;
      rows.set(row, (rows.get(row) || '') + segment.textContent);
    }
    return [...new Set([...groups.values()].map(rows => normalize([...rows.values()].join(' ')))
      .filter(text => text && text.length <= 1200))];
  }

  function visiblePlayer() {
    return [...document.querySelectorAll('#movie_player,.html5-video-player')].find(p =>
      p.getClientRects().length && p.querySelector('video'));
  }
  function start(translate, notice, onStop, mode, language) {
    const id = videoId();
    let player = visiblePlayer();
    if (!player) throw new Error('请先打开 YouTube 视频并等待播放器加载。');
    let video = player.querySelector('video');
    let button = captionButton(player);
    const usableButton = control => control && !control.disabled && control.getAttribute('aria-disabled') !== 'true' &&
      (embed || control.getClientRects().length && getComputedStyle(control).visibility !== 'hidden');
    const hasButton = usableButton(button);
    let waitingForCC = embed && !hasButton && !captionLines(player).length &&
      (video.readyState === 0 || player.classList.contains('unstarted-mode'));
    if (!hasButton && !waitingForCC && !captionLines(player).length) {
      throw new Error('播放器当前没有可用的字幕（CC）。请确认视频提供字幕，并已开始播放。');
    }

    const output = document.createElement('div');
    output.className = 'pt-youtube-caption';
    output.setAttribute('translate', 'no');
    output.hidden = true;
    const sourceRow = document.createElement('div');
    sourceRow.className = 'pt-caption-source';
    const targetRow = document.createElement('div');
    targetRow.className = 'pt-caption-target';
    output.append(sourceRow, targetRow);
    player.append(output);
    player.setAttribute('data-bingdu-captions', '');

    let session = crypto.randomUUID();
    let target = languageCode(language);
    let trackState = { status: 'pending', language: '', displayLanguage: '' };
    let hint = {};
    let cueInfo = {};
    let waitingForChange = '';
    let nativeAtStart = captionLines(player).join(' ');
    let usingSource = false;
    let showNativeAsTarget = false;
    let sourceNotice = '';
    let handshakeTimer;
    function sendSource(action) {
      document.dispatchEvent(new CustomEvent('bingdu-youtube-source-request', {
        detail: JSON.stringify({ action, session, videoId: id, targetLanguage: target })
      }));
    }

    let active = true;
    let epoch = 0;
    let current = [];
    let currentCueStart;
    let cues = [];
    let timer;
    let blockedUntil = 0;
    let requestedCC = false;
    let shownError = '';
    let firstChange = 0;
    let running = 0;
    const cache = new Map();
    const pending = new Set();
    const events = new AbortController();
    const listen = (target, type, fn) => target.addEventListener(type, fn, { signal: events.signal });
    let stopHints = () => {};
    let mediaId;
    let peerRoot;
    const peerObserver = new MutationObserver(() => scan());
    function alternateSource() {
      const host = player.querySelector('#immersive-translate-caption-window');
      if (host?.shadowRoot !== peerRoot) {
        peerObserver.disconnect();
        peerRoot = host?.shadowRoot;
        if (peerRoot) peerObserver.observe(peerRoot, { childList:true, subtree:true, characterData:true });
      }
      if (!peerRoot || !host.getClientRects().length) return [];
      // This sibling overlay labels its original and translated spans separately.
      return [...peerRoot.querySelectorAll('.source-cue.imt-cue')].filter(el => el.getClientRects().length)
        .map(el => normalize(el.textContent)).filter(text => text && text.length <= 1200);
    }

    function suppressed() {
      return video.ended || player.matches('.ad-showing,.ad-interrupting') ||
        captionButton(player)?.getAttribute('aria-pressed') === 'false';
    }

    function renderRow(row, text) {
      if (row.textContent !== text) row.textContent = text;
      row.hidden = !text;
    }
    function draw() {
      const original = current.join(' ');
      const parts = current.map(line => {
        const key = captionKey(line);
        if (cache.has(key)) return cache.get(key);
        if (cueInfo.segmented) return '';
        for (let cut = line.lastIndexOf(' '); cut >= 4; cut = line.lastIndexOf(' ', cut - 1)) {
          const prefix = line.slice(0, cut);
          if (cache.has(prefix)) return cache.get(prefix);
        }
        return '';
      });
      const translation = showNativeAsTarget ? original : parts.filter(Boolean).join(' ');
      const showBoth = mode === 'dual' && usingSource && !showNativeAsTarget;
      output.toggleAttribute('data-bilingual', showBoth);
      renderRow(sourceRow, showBoth ? original : '');
      renderRow(targetRow, showBoth && compare(original) === compare(translation) ? '' : translation);
      output.hidden = sourceRow.hidden && targetRow.hidden;
    }
    function reset() {
      epoch++;
      current = [];
      currentCueStart = undefined;
      pending.clear();
      blockedUntil = 0;
      firstChange = 0;
      clearTimeout(timer);
      draw();
    }
    function schedule(delay = 160) {
      clearTimeout(timer);
      timer = setTimeout(pump, Math.max(delay, blockedUntil - Date.now()));
    }
    function scan() {
      if (!active) return;
      if (id !== videoId()) { stop(false); return; }
      if (!player.isConnected || !player.contains(video)) return;
      if (embed) {
        // Real embedded players create CC and their controls after the first play.
        const nextButton = captionButton(player);
        if ((waitingForCC || nextButton !== button) && usableButton(nextButton)) {
          button = nextButton;
          if (waitingForCC) requestedCC = button.getAttribute('aria-pressed') === 'false';
          waitingForCC = false;
          if (button.getAttribute('aria-pressed') === 'false') button.click();
        }
      }
      let rows = suppressed() ? [] : captionLines(player);
      const visible = rows.join(' ');
      const status = trackState.status;
      let source = status === 'ready' || status === 'same-language';
      let passthrough = source && sameLanguage(trackState.language, target);
      if (status === 'pending' || status === 'manual') rows = [];
      if (waitingForChange) {
        if (visible !== waitingForChange && visible) waitingForChange = '';
        else rows = [];
      }
      const trackChanged = status === 'alternate' || (!!hint.translated && base(hint.translated) !== base(trackState.language));
      if (status === 'unsupported' || status === 'unavailable' || trackChanged) {
        const language = hint.translated || trackState.displayLanguage || hint.language;
        passthrough = sameLanguage(language, target) || (!language && targetScript(visible, target));
        source = !passthrough && status === 'unsupported' && !hint.translated;
        // Where the player only offers a translated caption, show it once,
        // or translate it to the requested target without presenting it as original.
        if (!passthrough && !source && !language) rows = [];
      }
      // Keep the original transcript on a native language change. It is tied
      // to this video and remains usable even while YouTube repaints its CC.
      const originalTrack = cues.length && !cueInfo.translated && base(cueInfo.language) &&
        base(cueInfo.language) === base(trackState.language);
      let cueStart;
      if (!suppressed() && originalTrack) {
        const timed = cuesAt(video.currentTime);
        if (timed.length || cueInfo.segmented) {
          rows = [...new Set(timed.map(cue => cue.text))];
          if (cueInfo.segmented) cueStart = timed[0]?.start;
          waitingForChange = '';
          source = true;
          passthrough = sameLanguage(cueInfo.language, target);
        }
      }
      const peer = !suppressed() && alternateSource();
      if (peer?.length && !(originalTrack && cueInfo.segmented) && (!rows.length || status === 'unavailable' || status === 'unsupported')) {
        rows = peer;
        source = true;
        passthrough = sameLanguage(trackState.language, target) || (!trackState.language && targetScript(peer.join(' '), target));
      }
      if (source !== usingSource || passthrough !== showNativeAsTarget) {
        usingSource = source;
        showNativeAsTarget = passthrough;
        current = [];
        draw();
      }
      if (currentCueStart === cueStart && rows.length === current.length && rows.every((line, i) => line === current[i])) return;
      currentCueStart = cueStart;
      current = rows;
      draw();
      if (rows.length) {
        if (!firstChange) firstChange = Date.now();
        schedule(Math.max(0, Math.min(160, firstChange + 550 - Date.now())));
      } else firstChange = 0;
    }

    // Only use a recorded track when playback time AND visible text identify the same cue.
    function nextCue(t) {
      let low = 0, high = cues.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (cues[middle].start <= t) low = middle + 1;
        else high = middle;
      }
      return low;
    }
    function cuesAt(t) {
      const low = nextCue(t);
      return cues.slice(Math.max(0, low - 4), low).filter(cue => cue.end > t);
    }
    function upcoming() {
      const t = video.currentTime, low = nextCue(t);
      const visible = current.join(' ');
      const matched = cues.slice(Math.max(0, low - 4), low).some(cue =>
        cue.end > t && (visible === cue.text || current.includes(cue.text)));
      if (!matched) return [];
      return cues.slice(low, low + 4).filter(cue => cue.start <= t + 12).map(cue => cue.text);
    }

    function cueIndex(line, future) {
      const low = nextCue(video.currentTime);
      const from = future ? low : Math.max(0, low - 4);
      const to = future ? Math.min(cues.length, low + 4) : low;
      for (let i = from; i < to; i++) {
        if (cues[i].text === line && (future || cues[i].end > video.currentTime)) return i;
      }
      return -1;
    }
    function captionKey(line, future = false) {
      const index = cueInfo.segmented ? cueIndex(line, future) : -1;
      return index < 0 ? line : JSON.stringify([cues[index].start, line]);
    }
    async function request(lines, speculative) {
      const generation = epoch;
      const keys = lines.map(line => captionKey(line, speculative));
      const first = cueIndex(lines[0], speculative), last = cueIndex(lines.at(-1), speculative);
      const context = {
        title: document.title.replace(/\s*[-–]\s*YouTube\s*$/i, '').slice(0, 180),
        before: first > 0 ? cues[first - 1].text : '',
        after: last >= 0 ? cues[last + 1]?.text || '' : ''
      };
      running++;
      keys.forEach(key => pending.add(key));
      try {
        const values = await translate(lines, { purpose:'subtitle', context });
        if (!active || generation !== epoch) return;
        lines.forEach((line, i) => {
          if (!values[i]) return;
          if (cache.size >= 300) cache.delete(cache.keys().next().value);
          cache.set(keys[i], values[i]);
        });
        scan();
        if (active) draw();
      } catch (error) {
        if (active && generation === epoch) {
          if (/401|402|API Key/.test(error.message)) {
            notice(error.message);
            stop(true);
          } else {
            blockedUntil = Date.now() + 5000;
            if (!speculative && shownError !== error.message) { notice(error.message); shownError = error.message; }
          }
        }
      } finally {
        running--;
        if (generation === epoch) keys.forEach(key => pending.delete(key));
        if (active && current.length) schedule(Math.max(80, blockedUntil - Date.now()));
      }
    }
    function pump() {
      if (!active || !current.length || showNativeAsTarget || suppressed() || running >= 2 || Date.now() < blockedUntil) return;
      firstChange = 0;
      const missing = (lines, future = false) => [...new Set(lines)].filter(line => {
        const key = captionKey(line, future);
        return !cache.has(key) && !pending.has(key);
      });
      const needed = missing(current);
      if (needed.length) void request(needed.slice(0, 6), false);
      if (running < 2 && cues.length && usingSource && !cueInfo.translated && (!trackState.language || base(trackState.language) === base(cueInfo.language))) {
        const future = missing(upcoming(), true);
        if (future.length) void request(future, true);
      }
    }

    const observer = new MutationObserver(records => {
      if (!player.hasAttribute('data-bingdu-captions')) player.setAttribute('data-bingdu-captions', '');
      if (player.isConnected && output.parentElement !== player) player.append(output);
      for (const record of records) {
        const el = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        if (!el || output.contains(el)) continue;
        if (el === player || el.closest(windows + ',' + cc) ||
            [...record.addedNodes, ...record.removedNodes].some(n => n.nodeType === 1 &&
              (n.matches(windows + ',video,' + cc) || n.querySelector(windows + ',video,' + cc)))) {
          scan();
          return;
        }
      }
    });
    const playerTree = new MutationObserver(rebind);
    let videoEvents;
    const sourceChanges = { childList: true, characterData: true, subtree: true, attributes: true,
      attributeFilter: ['aria-pressed', 'aria-hidden', 'aria-disabled', 'disabled', 'class', 'hidden', 'data-bingdu-captions'] };
    let ancestry = [];
    function watchLocation() {
      const path = [];
      for (let n = video.parentNode; n; n = n.parentNode) path.push(n);
      if (path.length === ancestry.length && path.every((n, i) => n === ancestry[i])) return;
      ancestry = path;
      playerTree.disconnect();
      for (const n of path) playerTree.observe(n, { childList: true });
    }
    function bindVideo() {
      videoEvents?.abort();
      videoEvents = new AbortController();
      for (const type of ['seeking','ended','emptied','seeked','timeupdate']) {
        video.addEventListener(type, type === 'seeked' || type === 'timeupdate' ? scan : reset, { signal: videoEvents.signal });
      }
      watchLocation();
    }
    function rebind() {
      if (!active) return;
      if (id !== videoId()) { stop(false); return; }
      if (player.isConnected && player.contains(video)) { watchLocation(); return; }
      const next = player.isConnected && player.querySelector('video') ? player : visiblePlayer();
      if (!next) {
        if (current.length) reset();
        // Wait for the replacement even when YouTube builds it in a later task.
        if (ancestry.length) {
          ancestry = [];
          playerTree.disconnect();
          playerTree.observe(document.documentElement, { childList:true, subtree:true });
        }
        return;
      }
      if (next !== player) {
        sendSource('stop');
        player.removeAttribute('data-bingdu-captions');
        observer.disconnect();
        player = next;
        session = crypto.randomUUID();
        trackState = { status:'pending', language:'', displayLanguage:'' };
        nativeAtStart = captionLines(next).join(' ');
        waitingForChange = '';
        next.setAttribute('data-bingdu-captions', '');
        next.append(output);
        observer.observe(embed ? document.documentElement : next, sourceChanges);
        button = captionButton(next);
        requestedCC = button?.getAttribute('aria-pressed') === 'false';
        if (requestedCC) button.click();
        sendSource('start');
      }
      video = next.querySelector('video');
      bindVideo();
      reset();
      scan();
    }
    function stop(restoreCC = true) {
      if (!active) return;
      active = false;
      reset();
      observer.disconnect();
      playerTree.disconnect();
      videoEvents?.abort();
      peerObserver.disconnect();
      stopHints();
      clearTimeout(handshakeTimer);
      events.abort();
      sendSource('stop');
      player.removeAttribute('data-bingdu-captions');
      output.remove();
      const currentButton = captionButton(player);
      if (restoreCC && requestedCC && currentButton?.getAttribute('aria-pressed') === 'true') currentButton.click();
      onStop();
    }
    function refresh(name) {
      target = languageCode(name);
      reset(); cache.clear();
      sendSource('start');
      scan();
    }
    function setMode(next) { mode = next; draw(); }
    function onSourceState(event) {
      if (typeof event.detail !== 'string' || event.detail.length > 1500) return;
      let value;
      try { value = JSON.parse(event.detail); } catch { return; }
      if (value?.session !== session || value.videoId !== id || !active) return;
      if (!['pending','ready','same-language','unavailable','unsupported','alternate'].includes(value.status)) return;
      if (value.mediaId && /^[\w-]{1,64}$/.test(value.mediaId) && value.mediaId !== mediaId) {
        // A playlist can advance without navigating the iframe or replacing its player.
        if (mediaId) {
          waitingForChange = current.join(' ');
          cache.clear();
          sourceNotice = '';
        }
        followTimeline(value.mediaId);
      }
      // On a switch, player metadata can update before the previous subtitle disappears.
      if (trackState.status === 'pending' && (value.status === 'ready' || value.status === 'same-language') &&
          (value.switched || (trackState.displayLanguage && base(trackState.displayLanguage) !== base(value.language)))) {
        waitingForChange = nativeAtStart;
      }
      trackState = value;
      if (value.status !== 'pending') clearTimeout(handshakeTimer);
      if (value.status === 'unavailable' && sourceNotice !== value.status) {
        sourceNotice = value.status;
        notice('此视频暂时没有可确认的原声字幕。可用时只显示目标语言。');
      }
      reset(); scan();
    }
    listen(document, 'bingdu-youtube-source-state', onSourceState);
    observer.observe(embed ? document.documentElement : player, sourceChanges);
    bindVideo();
    listen(document, 'yt-navigate-finish', () => { if (id !== videoId()) stop(false); });
    listen(window, 'pagehide', () => stop(true));
    if (hasButton && button.getAttribute('aria-pressed') === 'false') {
      requestedCC = true;
      button.click();
    }
    handshakeTimer = setTimeout(() => {
      if (active && trackState.status === 'pending') { trackState.status = 'unsupported'; reset(); scan(); }
    }, 10500);
    function followTimeline(nextId) {
      stopHints();
      cues = [];
      hint = {};
      cueInfo = {};
      mediaId = nextId;
      stopHints = globalThis.bingduYoutubeTrackHints?.(mediaId, onTimeline) || (() => {});
    }
    function onTimeline(timeline, info) {
      if (!active) return;
      hint = info || {};
      const original = cues.length && !cueInfo.translated && base(cueInfo.language) === base(trackState.language);
      if (!original || (!hint.translated && base(hint.language) === base(cueInfo.language))) {
        cueInfo = hint;
        cues = timeline;
      }
      if (!timeline.length) reset();
      scan();
      if (current.length) schedule();
    }
    if (!embed) followTimeline(id);
    sendSource('start');
    scan();
    return { stop, refresh, setMode, get mode() { return mode; } };
  }
  globalThis.bingduYoutubeCaptions = { start, isVideoPage: () => !!videoId() };
})();
