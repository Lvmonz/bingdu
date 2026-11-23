(() => {
  if (window === window.top || !globalThis.bingduYoutubeCaptions || !/^\/embed(?:\/|$)/.test(location.pathname)) return;

  const players = '#movie_player,.html5-video-player';
  const selector = document.createElement('select');
  selector.className = 'pt-embed-caption-control';
  selector.setAttribute('translate', 'no');
  selector.setAttribute('aria-label', '并读字幕');
  selector.title = '并读字幕';
  for (const [value, label] of [['off', '并读字幕 · 关'], ['dual', '双语字幕'], ['only', '仅译文字幕']]) {
    selector.add(new Option(label, value));
  }

  function update() {
    selector.value = globalThis.parallelReading?.getState().captionMode || 'off';
  }
  selector.addEventListener('change', async () => {
    const selected = selector.value;
    selector.disabled = true;
    try {
      await globalThis.parallelReading.run('captions-' + selected);
    } catch (error) {
      // The player can still be loading, or this video may have no CC.
      const message = document.getElementById('pt-notice') || document.createElement('aside');
      message.id = 'pt-notice';
      message.setAttribute('role', 'status');
      message.textContent = error.message;
      (selector.closest(players) || document.body).append(message);
      setTimeout(() => { if (message.textContent === error.message) message.remove(); }, 6000);
    } finally {
      selector.disabled = false;
      update();
    }
  });
  // Let the select handle arrows and pointer input without toggling playback.
  for (const event of ['click', 'pointerdown', 'mousedown', 'keydown', 'keyup']) {
    selector.addEventListener(event, e => e.stopPropagation());
  }
  document.addEventListener('bingdu-caption-state-changed', update);

  const controlTrees = 'video,.ytp-right-controls,#player-controls,#player-control-overlay,.player-controls-top-right,.ytmClosedCaptioningButtonButton,' + players;
  function mount() {
    const player = [...document.querySelectorAll(players)].find(el => el.querySelector('video') && el.getClientRects().length);
    if (!player) return;
    const fullscreen = document.fullscreenElement;
    const external = document.getElementById('player-controls') || document.getElementById('player-control-overlay');
    const overlay = external && (!fullscreen || fullscreen.contains(external)) ? external : null;
    const controls = overlay?.querySelector('.player-controls-top-right') || player.querySelector('.ytp-right-controls');
    const toolbar = controls && controls.getClientRects().length && new URLSearchParams(location.search).get('controls') !== '0' &&
      (!overlay || overlay.querySelector('.ytmClosedCaptioningButtonButton'));
    const parent = toolbar ? controls : overlay || player;
    selector.classList.toggle('pt-embed-caption-floating', !toolbar);
    if (selector.parentElement !== parent) {
      parent.prepend(selector);
      update();
    }
  }
  const observer = new MutationObserver(records => {
    if (selector.isConnected && records.every(record =>
      ![...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 &&
        (node.matches(controlTrees) || node.querySelector(controlTrees))))) return;
    mount();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('loadedmetadata', mount, true);
  document.addEventListener('fullscreenchange', mount);
  window.addEventListener('resize', mount);
  mount();
})();
