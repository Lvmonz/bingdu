(() => {
  if (!/(^|\.)youtube(?:-nocookie)?\.com$/i.test(location.hostname)) return;

  const requestEvent = 'bingdu-youtube-source-request';
  const stateEvent = 'bingdu-youtube-source-state';
  let active;

  function language(value) {
    if (typeof value !== 'string' || value.length > 48) return '';
    try {
      const result = Intl.getCanonicalLocales(value)[0];
      return result && !/^(und|zxx|mul)(-|$)/i.test(result) ? result : '';
    } catch { return ''; }
  }
  const family = code => code.split('-')[0];
  const pageId = () => new URLSearchParams(location.search).get('v') ||
    location.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1];
  const playerId = p => p?.getVideoData?.()?.video_id || p?.getPlayerResponse?.()?.videoDetails?.videoId;
  const current = p => p.getOption?.('captions', 'track');
  const translated = t => language(t?.translationLanguage?.languageCode ?? t?.translation_language?.languageCode);
  const display = t => translated(t) || language(t?.languageCode);
  const auto = t => t?.kind === 'asr' || /^a\./.test(t?.vss_id || t?.vssId || '');
  const name = t => (typeof t?.name === 'string' ? t.name : t?.trackName) || '';

  function sameTrack(a, b) {
    if (!a || !b || !language(a.languageCode) || language(a.languageCode) !== language(b.languageCode) ||
        translated(a) !== translated(b) || auto(a) !== auto(b)) return false;
    const idA = a.vss_id || a.vssId;
    const idB = b.vss_id || b.vssId;
    return idA && idB ? idA === idB : name(a) === name(b);
  }

  function originalLanguage(response, tracks) {
    const explicit = language(response?.videoDetails?.defaultAudioLanguage) ||
      language(response?.microformat?.playerMicroformatRenderer?.defaultAudioLanguage);
    if (explicit) return explicit;

    const formats = response?.streamingData?.adaptiveFormats || [];
    const audio = new Map();
    for (const f of formats) {
      const t = f.audioTrack;
      const code = language(t?.id?.split('.')[0]);
      if (code) audio.set(t.id, { code, track: t });
    }
    const entries = [...audio.values()];
    // Some multi-audio releases play a localized dub by default. Only explicit
    // original-audio markers identify the original among multiple recordings.
    const original = entries.find(({ track }) => track.isOriginal === true ||
      /\boriginal\b|原始|原声|原聲/i.test(track.displayName || ''));
    if (original) return original.code;

    // YouTube ASR transcribes an audio language. Multiple distinct ASR
    // languages are ambiguous (e.g. a dubbed release).
    const asr = [...new Set(tracks.filter(t => auto(t) && !translated(t))
      .map(t => language(t.languageCode)).filter(Boolean))];
    const audioFamilies = new Set(entries.map(({ code }) => family(code)));
    if (asr.length && new Set(asr.map(family)).size === 1 &&
        (!audioFamilies.size || (audioFamilies.size === 1 && audioFamilies.has(family(asr[0]))))) return asr[0];
    if (entries.length === 1 && entries[0].track.audioIsDefault && !entries[0].track.isAutoDubbed) {
      return entries[0].code;
    }
    return '';
  }

  function state(s, status, track) {
    s.status = status;
    const detail = JSON.stringify({ session: s.session, videoId: s.videoId, status,
      language: s.source || '', displayLanguage: display(track), switched: !!s.switched });
    if (s.last === detail || active !== s) return;
    s.last = detail;
    document.dispatchEvent(new CustomEvent(stateEvent, { detail }));
  }

  let cancelRestoration;
  function restoreSelection(s) {
    let timer;
    const cancel = () => {
      clearTimeout(timer);
      if (cancelRestoration === cancel) cancelRestoration = undefined;
    };
    cancelRestoration = cancel;
    function check() {
      try {
        if (active || !s.player.isConnected || pageId() !== s.videoId || playerId(s.player) !== s.videoId) {
          cancel();
          return;
        }
        const selected = current(s.player);
        if (sameTrack(selected, s.wanted)) {
          cancel();
          s.player.setOption('captions', 'track', s.previous);
        } else if (!s.confirmed && Date.now() < s.switchDeadline && sameTrack(selected, s.previous) &&
            s.player.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') !== 'false') {
          // Stop may precede an asynchronous setOption. Restore only after
          // the requested track actually lands, and abandon any third choice.
          timer = setTimeout(check, 100);
        } else cancel();
      } catch { cancel(); }
    }
    check();
  }
  function finish(restore) {
    const s = active;
    active = undefined;
    if (!s) return;
    clearTimeout(s.timer);
    if (restore && s.previous && s.wanted && s.player) restoreSelection(s);
  }

  function selectOriginal(player, track) {
    player.setOption('captions', 'track', { languageCode: track.languageCode, kind: auto(track) ? 'asr' : '',
      name: name(track), vss_id: track.vss_id || track.vssId });
  }

  function inspect(s) {
    if (pageId() !== s.videoId) { finish(false); return; }
    const players = [...document.querySelectorAll('#movie_player,.html5-video-player')].filter(el =>
      !el.matches('.ad-showing,.ad-interrupting') && el.querySelector('video') && el.getClientRects().length);
    const p = players.find(el => typeof el.getOption === 'function' && playerId(el) === s.videoId);
    if (!p) {
      s.current = null;
      if (s.confirmed) return 'pending';
      s.domOnly = players.some(el => typeof el.getOption !== 'function' &&
        [...el.querySelectorAll('.ytp-caption-segment')].some(seg => seg.getClientRects().length && seg.textContent.trim()));
      return 'unsupported';
    }
    if (s.player && s.player !== p) {
      s.wanted = s.previous = null;
      s.switched = s.confirmed = s.retried = false;
      s.deadline = Date.now() + 8000;
    }
    s.player = p;
    const track = current(p);
    s.current = track;

    if (s.wanted) {
      if (sameTrack(track, s.wanted)) {
        if (s.previous) s.switched = true;
        s.confirmed = true;
        return s.target && family(s.source) === family(s.target) ? 'same-language' : 'ready';
      }
      // Selecting a different track changes the input, not who renders it.
      if (!display(track)) return 'pending';
      if (s.confirmed || !sameTrack(track, s.previous)) {
        if (Date.now() < (s.menuChoiceUntil || 0)) s.userSelected = true;
        if (s.confirmed && !s.retried && !s.userSelected && translated(track) && typeof p.setOption === 'function') {
          s.retried = true;
          selectOriginal(p, s.wanted);
        }
        if (s.userSelected) s.previous = null;
        return 'alternate';
      }
      return Date.now() >= s.switchDeadline ? 'unavailable' : 'pending';
    }

    const response = p.getPlayerResponse?.();
    const renderer = response?.captions?.playerCaptionsTracklistRenderer;
    const list = p.getOption('captions', 'tracklist', { includeAsr: true });
    const tracks = Array.isArray(list) && list.length ? list : renderer?.captionTracks || [];
    const originalTracks = tracks.filter(t => language(t?.languageCode) && !translated(t) && t.kind !== 'forced');
    s.source = originalLanguage(response, [...originalTracks, ...(renderer?.captionTracks || [])]);
    if (!s.source || !originalTracks.length || !display(track)) {
      return originalTracks.length || display(track) || Array.isArray(renderer?.captionTracks) ? 'unavailable' : 'unsupported';
    }
    const candidates = originalTracks.filter(t => family(language(t.languageCode)) === family(s.source));
    if (!candidates.length) {
      s.missing = Array.isArray(list) && list.length > 0 && Array.isArray(renderer?.captionTracks) &&
        !renderer.captionTracks.some(t => family(language(t.languageCode)) === family(s.source) && !translated(t));
      return 'unavailable';
    }
    const rank = t => Number(!auto(t)) * 2 + Number(language(t.languageCode) === s.source);
    candidates.sort((a, b) => rank(b) - rank(a));
    const selected = candidates.find(t => sameTrack(t, track)) || candidates[0];
    if (sameTrack(track, selected)) {
      s.wanted = selected;
      s.confirmed = true;
      return s.target && family(s.source) === family(s.target) ? 'same-language' : 'ready';
    }
    if (typeof p.setOption !== 'function') return 'unavailable';
    s.previous = track;
    s.wanted = selected;
    s.switchDeadline = Date.now() + 3000;
    selectOriginal(p, selected);
    return 'pending';
  }

  function tick(s) {
    if (s !== active) return;
    let status;
    try { status = inspect(s); } catch { status = 'unsupported'; }
    if (s !== active) return;
    if (!s.domOnly && !s.missing && !s.wanted && Date.now() < s.deadline &&
        (status === 'unavailable' || status === 'unsupported')) status = 'pending';
    state(s, status, s.current);
    if (s !== active || !['pending', 'ready', 'same-language', 'alternate'].includes(status)) return;
    s.timer = setTimeout(() => tick(s), status === 'pending' && !s.confirmed ? 200 : 350);
  }

  document.addEventListener(requestEvent, event => {
    if (typeof event.detail !== 'string' || event.detail.length > 600) return;
    let req;
    try { req = JSON.parse(event.detail); } catch { return; }
    if (!req || typeof req.videoId !== 'string' || !/^[\w-]{1,64}$/.test(req.videoId) ||
        typeof req.session !== 'string' || !/^[\w-]{1,80}$/.test(req.session)) return;
    if (req.action === 'stop') {
      if (active?.session === req.session && active.videoId === req.videoId) finish(true);
    } else if (req.action === 'start' && req.videoId === pageId()) {
      if (active?.session === req.session && active.videoId === req.videoId) {
        const target = language(req.targetLanguage);
        if (active.target !== target) {
          active.target = target;
          if (active.status === 'ready' || active.status === 'same-language') {
            clearTimeout(active.timer);
            tick(active);
          }
        }
        return;
      }
      finish(true);
      cancelRestoration?.();
      const s = { videoId: req.videoId, session: req.session, target: language(req.targetLanguage),
        deadline: Date.now() + 8000 };
      active = s;
      tick(s);
    }
  });
  function rememberMenuChoice(event) {
    if (active?.player?.contains(event.target) && event.isTrusted && event.composedPath().some(el =>
      el instanceof Element && el.matches('.ytp-settings-menu .ytp-menuitem, .ytp-settings-menu [role^="menuitem"]'))) {
      active.menuChoiceUntil = Date.now() + 2000;
    }
  }
  document.addEventListener('click', rememberMenuChoice, true);
  document.addEventListener('yt-navigate-finish', () => {
    if (active && pageId() !== active.videoId) finish(false);
  });
  window.addEventListener('pagehide', () => finish(true));
})();
