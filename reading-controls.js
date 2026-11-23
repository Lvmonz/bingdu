(() => {
  const popup = location.protocol === 'chrome-extension:';
  let localFile = location.protocol === 'file:';
  if (localFile && !globalThis.parallelReading) return;
  if (!popup && window !== window.top) return;
  const original = { mode: 'original', whole: false, paused: false, incomplete: 0 };
  let state = original;
  let available = false;
  let siteHidden = false;
  let siteAuto = false;
  let targetLanguage = '';
  let tab;
  let site;
  let hoverTimer;
  let submitting = false;

  const host = popup ? document.getElementById('popup') : document.createElement('pt-reading-tools');
  host.setAttribute('translate', 'no');
  host.lang = 'zh-CN';
  const shadow = host.attachShadow({ mode: 'open' });
  // Keep the toolbar out of the site's CSS cascade, including pages with strict style CSP.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { color-scheme:light; font:14px/1.45 'PingFang SC','Microsoft YaHei',system-ui,sans-serif; color:#1b3c33; text-align:left; direction:ltr; }
    :host(pt-reading-tools) { all:initial!important; position:fixed!important; inset:50% 0 auto auto!important; transform:translateY(-50%)!important; z-index:2147483646!important; width:auto!important; height:auto!important; margin:0!important; padding:0!important; border:0!important; pointer-events:auto!important; color-scheme:light!important; direction:ltr!important; }
    :host(pt-reading-tools[hidden]) { display:none!important }
    *, *::before, *::after { box-sizing:border-box; }
    .controls { display:flex; align-items:center; color:#1b3c33; font:14px/1.45 'PingFang SC','Microsoft YaHei',system-ui,sans-serif; text-align:left; direction:ltr; writing-mode:horizontal-tb; }
    button, input { font:inherit; }
    button { cursor:pointer; color:inherit; }
    :focus-visible { outline:2px solid #13735c; outline-offset:2px; }
    button:disabled { opacity:.55; cursor:default; }
    [hidden] { display:none!important; }
    .rail { display:flex; flex-direction:column; align-items:stretch; width:35px; margin-right:0; overflow:hidden; background:#183f34; color:#fff; border:1px solid #477564; border-right:0; border-radius:11px 0 0 11px; box-shadow:0 2px 8px #14251f26; }
    .rail:focus-within { outline:2px solid #68b09a; }
    .rail button { background:none; border:0; color:inherit; padding:0; min-width:32px; }
    .rail button:focus-visible { outline-offset:-3px; outline-color:#9fe4c8; }
    .toggle { height:38px; font-size:16px; font-weight:650; }
    .toggle[aria-pressed="true"] { color:#b3efd4; }
    .more { height:19px; line-height:12px; border-top:1px solid #ffffff3d!important; font:700 15px/10px system-ui; }
    .card { width:280px; padding:15px; background:#fcfcf6; border:1px solid #cad8ce; }
    .floating .card { width:min(270px,calc(100vw - 47px)); max-height:calc(100vh - 12px); max-height:calc(100dvh - 12px); overflow:auto; border-radius:13px; margin-right:6px; box-shadow:0 5px 24px #14251f29; }
    .popup .card { border:0; }
    header { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    h1, h2 { margin:0; font:inherit; font-size:20px; line-height:1.3; font-weight:650; }
    .mode { color:#426657; font-size:12px; font-weight:500; }
    .target { margin:4px 0 12px; color:#425a4d; font-size:12px; overflow-wrap:anywhere; }
    .target select { max-width:65%; margin-left:4px; padding:3px; font:inherit; color:inherit; border:1px solid #bbcdc0; border-radius:4px; background:#fffef8; }
    .actions { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
    .actions button,.retry { padding:9px 4px; border-radius:7px; border:1px solid #bbcdc0; background:#f6f8f1; }
    .actions .primary { background:#184d3e; color:white; border-color:#184d3e; }
    .captions { display:flex; align-items:stretch; gap:2px; margin-top:8px; }
    .captions button { flex:1; padding:5px 2px; border:1px solid #bbcdc0; border-radius:5px; font-size:12px; background:#fffef8; }
    .captions button[aria-pressed="true"] { background:#e1eee6; border-color:#62947d; color:#174b3b; }
    .links { display:flex; gap:9px; align-items:center; border-top:1px solid #d9e1d7; margin-top:12px; padding-top:5px; flex-wrap:wrap; }
    .links button { padding:3px 1px; border:0; color:#36594b; background:none; font-size:12px; }
    button:hover:enabled { filter:brightness(.93); }
    .links button:hover { text-decoration:underline; }
    .retry { width:100%; margin-top:6px; }
    label { display:flex; gap:6px; align-items:center; margin:8px 0 2px; color:#486154; font-size:12px; cursor:pointer; }
    input { accent-color:#184d3e; margin:0; }
    .feedback { color:#974a24; margin:8px 0 0; font-size:12px; overflow-wrap:anywhere; }
    .feedback:empty { display:none; }
    @media(max-width:420px) { .floating .card{padding:12px;} .rail{width:32px;} }
  `);
  shadow.adoptedStyleSheets = [sheet];

  function element(tag, parent, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    parent.append(node);
    return node;
  }
  function button(parent, label, handler, className) {
    const node = element('button', parent, label, className);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  }

  const controls = element('div', shadow, '', 'controls ' + (popup ? 'popup' : 'floating'));
  const card = element('div', controls, '', 'card');
  card.hidden = !popup;
  card.id = 'reader-menu';
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', '并读网页翻译');
  const header = element('header', card);
  element(popup ? 'h1' : 'h2', header, '并读');
  const mode = element('span', header, '', 'mode');
  const target = element('p', card, '', 'target');
  target.append('目标语言 ');
  const languages = element('select', target);
  {
    languages.setAttribute('aria-label', '目标语言');
    languages.addEventListener('change', async () => {
      const language = languages.value;
      if (!language) { languages.value = targetLanguage; await openPanel('language'); return; }
      try {
        if (popup) await chrome.storage.local.set({ language });
        else {
          const response = await chrome.runtime.sendMessage({ action:'set-reader-language', language });
          if (!response?.ok) throw new Error('language');
        }
        targetLanguage = language;
      } catch { feedback.textContent = '目标语言保存失败，请重试。'; }
      render();
    });
  }
  const actions = element('div', card, '', 'actions');
  const primaryAction = () => command(state.mode === 'original' ? 'dual' : 'original');
  const primary = button(actions, '翻译网页', primaryAction, 'primary');
  const secondary = button(actions, '仅看译文', () => command(state.mode === 'only' ? 'dual' : 'only'));
  const retry = button(card, '继续翻译', () => command(state.whole ? 'all' : state.mode), 'retry');
  const captionBar = element('div', card, '', 'captions');
  captionBar.setAttribute('role', 'group');
  captionBar.setAttribute('aria-label', '视频字幕');
  const captionModes = new Map();
  for (const [key, text] of [['dual','双语字幕'], ['only','仅译文字幕'], ['off','关闭字幕翻译']]) {
    captionModes.set(key, button(captionBar, text, () => command('captions-' + key)));
  }
  const links = element('div', card, '', 'links');
  button(links, '文件翻译', () => openPanel('file'));
  button(links, '翻译设置', () => openPanel('settings'));
  let indicator;
  let more;
  let showFloat;
  let auto;
  let autoText;
  let floatText;
  const feedback = element('p', card, '', 'feedback');
  feedback.setAttribute('role', 'status');
  if (popup) {
    const autoLabel = element('label', card);
    auto = element('input', autoLabel);
    auto.type = 'checkbox';
    autoText = document.createTextNode('自动翻译此网站');
    autoLabel.append(autoText);
    auto.addEventListener('change', async () => {
      if (!site) return;
      try {
        const enabled = auto.checked;
        const response = await chrome.runtime.sendMessage({ action:'set-auto-site', site, enabled });
        if (!response?.ok) throw new Error('auto');
        siteAuto = enabled;
      } catch { feedback.textContent = '网站设置保存失败，请重试。'; }
      render();
    });
    const label = element('label', card);
    showFloat = element('input', label);
    showFloat.type = 'checkbox';
    floatText = document.createTextNode('在此网站显示浮球');
    label.append(floatText);
    showFloat.addEventListener('change', async () => {
      if (!site || !tab) return;
      try {
        const hidden = !showFloat.checked;
        const key = 'hide-float:' + site;
        if (hidden) await chrome.storage.local.set({ [key]: true });
        else await chrome.storage.local.remove(key);
        siteHidden = hidden;
        await chrome.tabs.sendMessage(tab.id, { action: 'refresh-reader-float' }, { frameId: 0 });
      } catch { feedback.textContent = '请刷新当前网页后重试。'; }
      render();
    });
  } else {
    button(links, localFile ? '此文件隐藏浮球' : '此网站隐藏浮球', async () => {
      try {
        const reply = await chrome.runtime.sendMessage({ action: 'hide-reader-float' });
        if (reply?.error) throw new Error(reply.error);
        setOpen(false);
        siteHidden = true;
        render();
      } catch { feedback.textContent = '请刷新当前网页后重试。'; }
    });
    const rail = element('div', controls, '', 'rail');
    indicator = button(rail, '译', primaryAction, 'toggle');
    more = button(rail, '···', () => {
      setOpen(card.hidden);
      if (!card.hidden) primary.focus();
    }, 'more');
    more.title = '并读 · 更多操作';
    more.setAttribute('aria-label', '并读 · 更多操作');
    more.setAttribute('aria-controls', card.id);
    more.setAttribute('aria-expanded', 'false');
    controls.addEventListener('pointerenter', event => {
      if (event.pointerType === 'mouse') hoverTimer = setTimeout(() => setOpen(true), 500);
    });
    controls.addEventListener('pointerleave', () => {
      clearTimeout(hoverTimer);
      if (!shadow.activeElement || !card.contains(shadow.activeElement)) setOpen(false);
    });
    controls.addEventListener('focusout', event => {
      if (!controls.contains(event.relatedTarget)) setOpen(false);
    });
    controls.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !card.hidden) {
        event.stopPropagation();
        indicator.focus();
        setOpen(false);
      }
    });
    document.addEventListener('pointerdown', event => {
      if (!card.hidden && !event.composedPath().includes(host)) setOpen(false);
    }, true);
  }

  function setOpen(open) {
    clearTimeout(hoverTimer);
    card.hidden = !open;
    more?.setAttribute('aria-expanded', String(open));
  }
  function render() {
    const active = state.mode !== 'original';
    const label = active ? '恢复原文' : '翻译网页';
    mode.textContent = available ? ({ original:'原文', dual:'双语对照', only:'仅译文' })[state.mode] : '';
    if (targetLanguage && ![...languages.options].some(item => item.value === targetLanguage)) {
      const choices = [...new Set([targetLanguage,'简体中文','繁體中文','英语','日语','韩语','法语','德语','西班牙语'])];
      languages.replaceChildren(...choices.map(name => new Option(name, name)), new Option('自定义语言…', ''));
    }
    languages.value = targetLanguage;
    captionBar.hidden = !state.youtube;
    for (const [key, button] of captionModes) {
      button.disabled = !available || submitting;
      button.setAttribute('aria-pressed', String(key === (state.captionMode || 'off')));
    }
    primary.textContent = label;
    secondary.textContent = state.mode === 'only' ? '切换双语' : '仅看译文';
    primary.disabled = secondary.disabled = !available || submitting;
    retry.hidden = !available || (!state.paused && !state.incomplete);
    retry.disabled = submitting;
    retry.textContent = state.paused ? '继续翻译' : '补译遗漏段落';
    if (popup) {
      autoText.data = localFile ? '自动翻译此文件' : '自动翻译此网站';
      floatText.data = localFile ? '在此文件显示浮球' : '在此网站显示浮球';
      showFloat.checked = !!site && !siteHidden;
      showFloat.disabled = !site;
      auto.checked = !!site && siteAuto;
      auto.disabled = !site;
    } else {
      host.hidden = siteHidden || !available;
      indicator.setAttribute('aria-label', '并读 · ' + label);
      indicator.setAttribute('aria-pressed', String(active));
      indicator.title = '并读 · ' + label;
    }
  }
  function newState(next) {
    available = ['original', 'dual', 'only'].includes(next?.mode);
    state = available ? next : original;
    render();
  }
  async function command(action) {
    if (submitting || !available) return;
    submitting = true;
    feedback.textContent = '';
    render();
    try {
      const response = popup
        ? await chrome.tabs.sendMessage(tab.id, { action }, action.startsWith('captions') ? {frameId: 0} : {})
        : await chrome.runtime.sendMessage({ action:'reader-command', command:action });
      if (response?.error) throw new Error(response.error);
      newState(popup ? await chrome.tabs.sendMessage(tab.id, { action:'reading-state' }, { frameId:0 })
                     : globalThis.parallelReading?.getState());
    } catch (error) {
      feedback.textContent = action.startsWith('captions') ? error.message : '请刷新当前网页后重试。';
      if (!popup) setOpen(true);
    } finally {
      submitting = false;
      render();
    }
  }
  async function openPanel(section) {
    try {
      const response = await chrome.runtime.sendMessage({ action:'open-reader-panel', section, windowId:tab?.windowId });
      if (!response?.ok) throw new Error('open');
      if (popup) window.close();
      else setOpen(false);
    } catch {
      // A Chrome build may withhold user activation after forwarding a click.
      // The same file and settings interface is independently usable as an extension tab.
      const result = await chrome.runtime.sendMessage({ action:'open-reader-tab', section }).catch(() => null);
      if (result?.ok && popup) window.close();
      if (!result?.ok) feedback.textContent = '无法打开侧栏，请从扩展管理页打开「扩展程序选项」。';
    }
  }
  async function popupInit() {
    [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
    const prefs = await chrome.storage.local.get({ language:'简体中文', autoSites:[] });
    targetLanguage = prefs.language;
    if (!tab?.id) { render(); return; }
    try {
      const [page, origin] = await Promise.all([
        chrome.tabs.sendMessage(tab.id, { action:'reading-state' }, { frameId:0 }),
        chrome.tabs.sendMessage(tab.id, { action:'hostname' }, { frameId:0 })
      ]);
      site = origin?.site ?? origin?.hostname;
      localFile = !!origin?.localFile;
      siteAuto = prefs.autoSites.includes(site);
      if (site) {
        const key = 'hide-float:' + site;
        siteHidden = (await chrome.storage.local.get(key))[key] === true;
      }
      newState(page);
    } catch { render(); }
    if (!available) {
      const { unavailablePageMessage } = await import('./page-access.js');
      feedback.textContent = await unavailablePageMessage(tab.url);
    }
  }
  async function refreshFloat() {
    const prefs = await chrome.runtime.sendMessage({ action:'reading-controls-info' });
    if (!prefs) return;
    siteHidden = prefs.hidden;
    targetLanguage = prefs.language;
    newState(globalThis.parallelReading?.getState());
  }

  render();
  if (popup) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.language) targetLanguage = changes.language.newValue || '简体中文';
      if (changes.autoSites) siteAuto = (changes.autoSites.newValue || []).includes(site);
      if (changes.language || changes.autoSites) render();
    });
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (message.action === 'reading-changed' && sender.tab?.id === tab?.id && sender.frameId === 0) newState(message.state);
    });
    void popupInit().catch(() => { feedback.textContent = '请重新打开扩展。'; });
  } else {
    document.documentElement.append(host);
    let lastState;
    globalThis.parallelReadingChanged = () => {
      const next = globalThis.parallelReading?.getState();
      if (!next) return;
      newState(next);
      const signature = JSON.stringify(next);
      if (signature !== lastState) {
        lastState = signature;
        chrome.runtime.sendMessage({ action:'reading-changed', state:next }).catch(() => {});
      }
    };
    chrome.runtime.onMessage.addListener(message => {
      if (message.action === 'refresh-reader-float' || message.action === 'reader-settings-changed') void refreshFloat().catch(() => {});
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void refreshFloat().catch(() => {});
    });
    void refreshFloat().catch(() => {});
  }
})();
