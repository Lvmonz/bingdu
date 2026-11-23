(() => {
  const localFile = location.protocol === 'file:';
  if (localFile && (!['text/html', 'application/xhtml+xml'].includes(document.contentType) || location.pathname.endsWith('/'))) return;
  const blocks = 'body,main,article,section,div,p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,dt,dd,td,th,caption,summary,address,aside,figure,header';
  const documentHint = '[translate="no" i]';
  const hardExclusions = 'script,style,noscript,template,pre,textarea,select,input,[contenteditable]:not([contenteditable="false"]),:not(:root)[translate="no" i],.notranslate,.pt-translation,#pt-notice,pt-reading-tools';
  const generalExclusions = hardExclusions + ',button,[role="button"],[role="toolbar"],nav,[role="navigation"],footer';
  const navigation = [
    ':is(nav,[role="navigation"],[role="menubar"],[role="menu"],[role="tablist"]) :is(a[href],button,[role="link"],[role="button"])',
    '.sj-page-lesson :is(#header,#lp-footer) :is(a,button,[role="link"],[role="button"],.header-link)',
    ':root[translate="no" i] button',
    '[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]'
  ].join(',');
  // Skilljar positions the lesson's own scrollport outside normal document flow.
  const readingRoots = navigation + ',#lesson-body #lesson-main-content';
  // Keep site-specific chrome outside the document's reading flow.
  const siteExclusions = [
    ['youtube.com', '.ytp-caption-window-container,.caption-window,.ytp-caption-segment'],
    ['youtube-nocookie.com', '.ytp-caption-window-container,.caption-window,.ytp-caption-segment'],
    ['wikipedia.org', '.mw-editsection,.mw-jump-link,.mw-cite-backlink,.vector-menu,.vector-sticky-header'],
    ['github.com', '.blob-code,.blob-num,[role="tree"],.js-line-number'],
    ['stackoverflow.com', '.js-voting-container,.post-menu,.s-navigation,.js-post-menu']
  ];
  const extra = siteExclusions.find(([domain]) => location.hostname === domain || location.hostname.endsWith('.' + domain));
  const offLimits = extra ? generalExclusions + ',' + extra[1] : generalExclusions;
  const temporarilyHidden = '[aria-hidden="true"],[hidden],[inert]';
  const excluded = offLimits + ',' + temporarilyHidden;
  const protectedText = 'code,kbd,samp,sup,sub,time,rt,rp';
  const media = 'svg,math,img,picture,video,audio,canvas,iframe,object,hr,.katex,.MathJax,mjx-container';
  const youtubePage = /^(?:(?:www|m)\.)?youtube(?:-nocookie)?\.com$/.test(location.hostname);
  // YouTube's entire application is absolutely positioned. Its reading units can
  // be discovered directly even when the surrounding cards and route are reused.
  const youtubeUnits = [
    'ytd-watch-metadata h1', 'ytd-video-primary-info-renderer h1', '#video-title', '#video-title-link',
    ':is(yt-lockup-metadata-view-model,yt-lockup-view-model,ytm-shorts-lockup-view-model,shorts-lockup-view-model) h3 a',
    '.ytLockupMetadataViewModelTitle', '.yt-lockup-metadata-view-model__title',
    'ytd-text-inline-expander #snippet-text', 'ytd-text-inline-expander #expanded > :is(yt-attributed-string,yt-formatted-string)',
    '#description-text', '#description-inline-expander #attributed-description', '.metadata-snippet-text',
    'yt-content-metadata-view-model .ytContentMetadataViewModelMetadataTextMaxLines2',
    'ytd-comment-view-model ytd-expander #content', '#content-text',
    'ytd-transcript-segment-renderer .segment-text', '.ytTranscriptSegmentViewModelSegmentText',
    'ytd-guide-entry-renderer #endpoint :is(#title,yt-formatted-string.title)', 'ytd-mini-guide-entry-renderer #label',
    'yt-chip-cloud-chip-renderer #text', 'yt-tab-shape .yt-tab-shape-wiz__tab', 'yt-tab-shape [role="tab"]',
    'ytd-shelf-renderer #title', 'ytd-rich-shelf-renderer #title', '.ytShelfHeaderLayoutTitle',
    'ytm-slim-video-metadata-renderer h1',
    'ytm-slim-video-information-renderer .slim-video-information-title',
    ':is(ytm-video-with-context-renderer,ytm-compact-video-renderer,ytm-video-renderer,ytm-playlist-renderer) :is(h3,h4)',
    'ytm-expandable-video-description-body-renderer .yt-core-attributed-string',
    'ytm-comment-renderer .comment-text', 'ytm-comment-view-model .yt-core-attributed-string[id="content-text"]'
  ].join(',');
  const youtubeWidgets = '#movie_player,ytd-player,ytm-player,.html5-video-player,.caption-window,.ytp-caption-window-container,.pt-youtube-caption,' +
    'ytd-live-chat-frame,yt-live-chat-app,ytd-ad-slot-renderer,ytd-promoted-sparkles-web-renderer,ad-slot-renderer,' +
    'ytd-comment-simplebox-renderer,[role="textbox"],.ytp-tooltip,.ytp-caption-segment';
  const youtubeExcluded = [hardExclusions, media, protectedText, youtubeWidgets].join(',');
  const youtubeLocales = { '简体中文': 'zh-Hans', '繁體中文': 'zh-Hant', '繁体中文': 'zh-Hant',
    '英语': 'en', '日语': 'ja', '韩语': 'ko', '法语': 'fr', '德语': 'de', '西班牙语': 'es' };
  let youtubeTarget;
  const outputs = new Map();
  const seen = new Set();
  const queue = new Set();
  const waiting = new Set();
  const closeToView = new Set();
  const prepared = new Map();
  const manualBounds = new Map();
  let prefetchObserver;
  let revealObserver;
  let hiddenNavigationObserver;
  let viewFrame = 0;
  const edited = new WeakMap();
  const dirty = new Set();
  const additions = new Set();
  const restyle = new Set();
  const changedSubtrees = new Set();
  let reuse = new WeakMap();
  const structuralHosts = new Set();
  const removedRoots = new Map();
  const insertedRoots = new Map();
  let prune = false;
  let resizeTimer;
  let viewWidth = window.innerWidth;
  let viewHeight = window.innerHeight;
  let mode = '';
  let receivedReadingCommand = false;
  let whole = false;
  let generation = 0;
  const runningBatches = new Map();
  let paused = false;
  let resumeOnVisible = false;
  const incomplete = new Set();
  let scanTimer;
  let noticeTimer;
  let imageTarget;

  function notice(text) {
    const box = document.getElementById('pt-notice') || document.createElement('aside');
    box.id = 'pt-notice';
    box.setAttribute('role', 'status');
    box.textContent = text;
    document.body.append(box);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => box.remove(), 12000);
  }

  async function translate(texts, options = {}) {
    const response = await chrome.runtime.sendMessage({ action: 'translate', texts, ...options });
    if (response.error) throw new Error(response.error);
    return response.result;
  }

  const isLayout = display => /flex|grid|contents/.test(display);
  const observerOptions = { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['href', 'hidden', 'aria-hidden', 'inert', 'translate', 'contenteditable', 'open', 'role', 'class', 'style', 'slot', 'name',
      ...(youtubePage ? ['id', 'expanded', 'is-expanded'] : [])] };
  let observedShadows = new WeakSet();

  function treeParent(node) {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode();
    // A detached anchor is its own root and its .host is a URL hostname.
    return root instanceof ShadowRoot ? root.host : null;
  }

  function excludedAcrossRoots(element, selector) {
    for (let current = element; current;) {
      if (current.closest(selector)) return true;
      const root = current.getRootNode();
      current = root instanceof ShadowRoot ? root.host : null;
    }
    return false;
  }

  // Navigation controls own their label even when a fixed header or sidebar is outside the article flow.
  function navigationRuns(host) {
    if (!host.getClientRects().length || getComputedStyle(host).visibility !== 'visible') return [];
    const parts = [];
    const skip = hardExclusions + ',' + temporarilyHidden + ',' + media + ',' + protectedText + ',.sr-only,.visually-hidden';
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent.closest(skip) || parent.closest(navigation) !== host) continue;
      if (!parent.getClientRects().length && getComputedStyle(parent).display !== 'contents') continue;
      if (getComputedStyle(parent).visibility !== 'visible') continue;
      const edit = edited.get(node);
      const source = edit?.value === node.data ? edit.source : node.data;
      if (/\p{L}/u.test(source)) parts.push({ node, source, translate: true });
    }
    return parts.length ? [{ parts, last: parts.at(-1).node, host, layout: true, navigation: true }] : [];
  }

  function excludedHost(host) {
    if (respectDocumentHint()) return true;
    if (youtubePage) return excludedAcrossRoots(host, youtubeExcluded + ',' + temporarilyHidden);
    return excludedAcrossRoots(host, (host.matches(navigation) ? hardExclusions + ',' + temporarilyHidden : excluded) + ',' + media + ',' + protectedText);
  }

  function readYoutubeUnit(host) {
    if (!host.matches(youtubeUnits) || host.parentElement?.closest(youtubeUnits)) return [];
    const style = getComputedStyle(host);
    if (style.visibility !== 'visible' || !host.getClientRects().length && style.display !== 'contents') return [];
    const parts = [];
    const skip = hardExclusions + ',' + media + ',' + temporarilyHidden + ',button,[role="button"],.yt-icon-shape';
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (node.matches(skip) || getComputedStyle(node).display === 'none') return NodeFilter.FILTER_REJECT;
        return node.localName === 'br' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const prior = edited.get(node);
      const source = node.nodeType === Node.ELEMENT_NODE ? '\n' : prior?.value === node.data ? prior.source : node.data;
      const translatable = /\p{L}/u.test(source) && !node.parentElement.closest(protectedText) &&
        !/^(?:https?:\/\/\S+|[@#][\p{L}\p{N}_.-]+)$/u.test(source.trim());
      parts.push({ node, source, translate: translatable });
    }
    if (!parts.some(part => part.translate)) return [];
    let last = parts.at(-1).node;
    while (last.parentNode !== host) last = last.parentNode;
    // The preview is capped outside its text span. Keep the native More button
    // and its hit target intact; show the translated preview below the expander.
    const preview = host.id === 'snippet-text' && host.closest('ytd-text-inline-expander');
    const comment = host.matches('ytd-expander #content,#content-text') && host.closest('ytd-expander');
    const anchor = preview || (comment && host.closest('#content')) || last;
    return [{ parts, last, host, layout: false, youtube: true, anchor, preview: !!preview, comment: !!comment }];
  }

  function localizedYoutubeGuide(host, target) {
    // YouTube localizes its built-in guide routes. The page locale says nothing
    // about video titles, subscriptions, comments or the user's own playlists.
    const guide = host.closest('ytd-guide-entry-renderer,ytd-mini-guide-entry-renderer');
    const link = guide?.querySelector('a[href]');
    if (!link || !/^\/(?:$|shorts\/?$|feed\/)/.test(link.pathname)) return false;
    try {
      const source = new Intl.Locale(document.documentElement.lang).maximize();
      const wanted = new Intl.Locale(youtubeLocales[target] || target).maximize();
      return source.language === wanted.language && source.script === wanted.script;
    } catch { return false; }
  }

  // Read contiguous inline content inside its existing layout item. Nested blocks and
  // flex/grid children have independent geometry and are translated in their own box.
  function readRuns(host, discoverChildren = true) {
    if (excludedHost(host)) return [];
    if (youtubePage) return readYoutubeUnit(host);
    if (host.matches(navigation) && !host.shadowRoot) return navigationRuns(host);
    if (!host.getClientRects().length && getComputedStyle(host).display !== 'contents') return [];
    const runs = [];
    const style = getComputedStyle(host);
    const layout = isLayout(style.display);
    if (style.visibility !== 'visible') return runs;
    let parts = [];
    let last;
    function finish() {
      // A sibling inserted beside projected text can land in a different slot.
      if (parts.some(part => part.translate)) runs.push({ parts, last, layout: layout || !!host.shadowRoot, host });
      parts = [];
      last = undefined;
    }
    function visit(node, direct, literal = false) {
      if (node.nodeType === Node.TEXT_NODE) {
        const applied = edited.get(node);
        const source = applied && applied.value === node.data ? applied.source : node.data;
        if (source) {
          parts.push({ node, source, translate: !literal && /\p{L}/u.test(source) });
          last = direct;
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches('.pt-dual')) return;
      if (node.matches(excluded + ',' + media + ',' + navigation)) { finish(); return; }
      if (node.shadowRoot) {
        finish();
        if (discoverChildren) watch(node);
        return;
      }
      if (node instanceof HTMLSlotElement && node.assignedNodes().length) { finish(); return; }
      const appearance = getComputedStyle(node);
      if (appearance.display === 'none' || appearance.visibility !== 'visible') { finish(); return; }
      if (appearance.position === 'absolute' || appearance.position === 'fixed') {
        finish();
        // Embedded readers often put their entire visible document in a
        // positioned scrollport. Let it own its runs and its viewport.
        if (discoverChildren && window !== window.top && receivedReadingCommand && node.matches(blocks)) watch(node);
        return;
      }
      if (node.tagName === 'BR' || node.tagName === 'WBR') {
        parts.push({ node, source: node.tagName === 'BR' ? '\n' : '', translate: false });
        last = direct;
        return;
      }
      if (layout || node.matches(blocks) || node.querySelector('button,input,select,textarea,svg,math,img,picture,video,iframe,[contenteditable="true"]') ||
          !['inline', 'contents', 'ruby', 'ruby-text', 'inline-block'].includes(appearance.display)) {
        finish();
        if (discoverChildren) watch(node);
        return;
      }
      // A widget nested within an inline element must not cause a block to be inserted after that element twice.
      const keep = literal || node.matches(protectedText);
      for (const child of node.childNodes) visit(child, direct, keep);
    }
    const shadow = host.shadowRoot;
    if (shadow) {
      if (discoverChildren && !observedShadows.has(shadow)) {
        observedShadows.add(shadow);
        mutations.observe(shadow, observerOptions);
        for (const unit of shadow.querySelectorAll(readingRoots)) watch(unit);
      }
      for (const child of shadow.childNodes) visit(child, child);
      finish();
    }
    if (!(host instanceof HTMLSlotElement && host.assignedNodes().length)) {
      for (const child of host.childNodes) {
        if (shadow && (!child.assignedSlot || excludedAcrossRoots(child.assignedSlot, excluded))) continue;
        visit(child, child);
      }
    }
    finish();
    return runs;
  }

  const typography = ['font-family', 'font-size', 'font-weight', 'font-style', 'font-variant-caps',
    'line-height', 'letter-spacing', 'text-transform', 'color', 'text-decoration-line',
    'text-decoration-color', 'vertical-align', 'white-space', 'background-color'];
  const inlineNames = new Set(['A', 'ABBR', 'B', 'CITE', 'CODE', 'DEL', 'EM', 'I', 'INS', 'KBD',
    'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR']);

  function syncInline(element, copy) {
    if (copy.tagName === 'A' && element.hasAttribute('href') && /^(https?:|mailto:|tel:|file:)/i.test(element.href)) {
      if (copy.href !== element.href) copy.href = element.href;
      if (element.target === '_blank') {
        copy.target = '_blank';
        copy.rel = 'noopener noreferrer';
      } else if (copy.hasAttribute('target')) {
        copy.removeAttribute('target');
        copy.removeAttribute('rel');
      }
    } else if (copy.hasAttribute('href')) {
      copy.removeAttribute('href');
      copy.removeAttribute('target');
      copy.removeAttribute('rel');
    }
    const original = getComputedStyle(element);
    const parent = getComputedStyle(treeParent(element));
    for (const key of typography) {
      const value = original.getPropertyValue(key);
      const override = value === parent.getPropertyValue(key) ? '' : value;
      if (copy.style.getPropertyValue(key) !== override) copy.style.setProperty(key, override);
    }
  }

  let textMeasure;
  const mirrorsFor = new WeakMap();
  const copyOwners = new WeakMap();

  function compactRun(run) {
    const source = run.parts.map(part => part.source).join('').trim();
    const style = getComputedStyle(run.host);
    const short = source.length <= 24 && source.split(/\s+/).length <= 4;
    let compact = short || style.whiteSpace === 'nowrap' || style.display.startsWith('inline') ||
      (style.webkitLineClamp && style.webkitLineClamp !== 'none');
    if (short && style.whiteSpace !== 'nowrap' && run.host.clientWidth &&
        (run.host.matches('td,th') || isLayout(getComputedStyle(treeParent(run.host)).display))) {
      // An extra inline label can widen a table column or push adjacent flex items away.
      textMeasure ||= document.createElement('canvas').getContext('2d');
      textMeasure.font = style.font || `${style.fontSize} ${style.fontFamily}`;
      const combined = source + '\u2002' + run.parts.map(part => part.value ?? part.source).join('').trim();
      const space = run.host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      compact = textMeasure.measureText(combined).width <= space;
    }
    return compact;
  }

  function prefix(run) {
    return compactRun(run) ? document.createTextNode('\u2002') : document.createElement('br');
  }

  function bilingualRun(run) {
    const output = document.createElement('pt-dual');
    output.className = 'pt-dual pt-translation';
    output.setAttribute('translate', 'no');
    if (run.youtube) {
      output.classList.add('pt-yt-dual');
      if (run.preview) output.classList.add('pt-yt-preview');
      if (run.comment) output.classList.add('pt-yt-comment');
    } else output.append(prefix(run));
    const mirrors = new Map([[run.host, output]]);
    mirrorsFor.set(output, mirrors);
    copyOwners.set(output, run.host);
    function mirror(parent) {
      if (mirrors.has(parent)) return mirrors.get(parent);
      const container = mirror(treeParent(parent));
      const copy = document.createElement(inlineNames.has(parent.tagName) ? parent.localName : 'span');
      syncInline(parent, copy);
      container.append(copy);
      mirrors.set(parent, copy);
      return copy;
    }
    for (const part of run.parts) {
      const container = mirror(treeParent(part.node));
      if (part.node.nodeType === Node.TEXT_NODE) container.append(part.value ?? part.source);
      else container.append(document.createElement(part.node.localName));
    }
    (run.anchor || run.last).after(output);
    return output;
  }

  function refreshCopies(record) {
    // A page-wide class or scroll-lock change should preserve translated links,
    // text selection and all wrappers already occupying their correct position.
    let index = 0;
    for (const run of record.runs) {
      if (mode !== 'dual' || run.layout) continue;
      if (run.unchanged) continue;
      const copy = record.copies[index++];
      const anchor = run.anchor || run.last;
      if (anchor.nextSibling !== copy) anchor.after(copy);
      if (!run.youtube && compactRun(run) !== (copy.firstChild?.nodeType === Node.TEXT_NODE)) {
        const node = prefix(run);
        if (copy.firstChild) copy.firstChild.replaceWith(node);
        else copy.prepend(node);
      }
      for (const [source, mirror] of mirrorsFor.get(copy)) {
        if (source !== run.host && source.parentElement) syncInline(source, mirror);
      }
    }
  }

  function apply(host, runs) {
    const record = { copies: [], edits: [], runs };
    outputs.set(host, record);
    for (const run of runs) {
      if (mode === 'dual' && !run.layout) {
        if (run.unchanged) continue;
        record.copies.push(bilingualRun(run));
        continue;
      }
      for (const part of run.parts) {
        if (!part.translate) continue;
        let value = part.value;
        if (mode === 'dual' && !run.navigation) value = part.source.trimEnd() + '\u2002' + value.trimStart();
        const change = { node: part.node, source: part.source, value };
        record.edits.push(change);
        edited.set(part.node, change);
        part.node.data = value;
      }
    }
  }

  function restore(host) {
    const record = outputs.get(host);
    if (!record) return;
    for (const copy of record.copies) copy.remove();
    for (const change of record.edits) {
      if (change.node.data === change.value) change.node.data = change.source;
      edited.delete(change.node);
    }
    outputs.delete(host);
  }

  function stopWatching(host) {
    hiddenNavigationObserver?.unobserve(host);
    prefetchObserver?.unobserve(host);
    revealObserver?.unobserve(host);
    closeToView.delete(host);
    manualBounds.delete(host);
    waiting.delete(host);
    queue.delete(host);
  }

  function commit(host) {
    const runs = prepared.get(host);
    if (!runs || !whole && !closeToView.has(host)) return;
    prepared.delete(host);
    stopWatching(host);
    if (!host.isConnected) return;
    if (sameRuns(runs, readRuns(host, false))) apply(host, runs);
    else {
      seen.delete(host);
      watch(host);
    }
  }

  function ready(host, runs) {
    prepared.set(host, runs);
    // A resize can replace both observers while this request is in flight.
    if (!whole && !manualBounds.has(host)) revealObserver.observe(host);
    commit(host);
  }

  function updateRange(host, nearby, reveal) {
    if (reveal) {
      if (nearby) {
        closeToView.add(host);
        commit(host);
      } else closeToView.delete(host);
    } else if (waiting.has(host)) {
      if (nearby) queue.add(host);
      else queue.delete(host);
    }
  }

  function scheduleView() {
    if (!mode || viewFrame) return;
    viewFrame = requestAnimationFrame(() => {
      viewFrame = 0;
      // A wrapper can be above the viewport while its overflowing article is still on screen.
      for (const [host, contentsOnly] of manualBounds) {
        let rect;
        if (contentsOnly) {
          const range = document.createRange();
          range.selectNodeContents(host.shadowRoot || host);
          rect = range.getBoundingClientRect();
        } else rect = host.getBoundingClientRect();
        const bottom = contentsOnly ? rect.bottom : Math.max(rect.bottom, rect.top + host.scrollHeight);
        const inColumn = (rect.width || rect.height) && rect.right > 0 && rect.left < innerWidth && bottom >= 0;
        updateRange(host, inColumn && rect.top <= innerHeight + innerWidth * 0.35, true);
        updateRange(host, inColumn && rect.top <= innerHeight * 3, false);
      }
      void flush();
    });
  }

  function setupObservers() {
    prefetchObserver?.disconnect();
    revealObserver?.disconnect();
    closeToView.clear();
    queue.clear();
    revealObserver = new IntersectionObserver((entries, observer) => {
      if (observer !== revealObserver) return;
      for (const entry of entries) {
        if (seen.has(entry.target)) updateRange(entry.target, entry.isIntersecting, true);
      }
      scheduleView();
    }, { rootMargin: '0% 0px 35% 0px' });
    prefetchObserver = new IntersectionObserver((entries, observer) => {
      if (observer !== prefetchObserver) return;
      for (const entry of entries) updateRange(entry.target, entry.isIntersecting, false);
      scheduleView();
    }, { rootMargin: `0px 0px ${innerHeight * 2}px 0px` });
    for (const host of waiting) observeHost(host);
    for (const host of prepared.keys()) if (!manualBounds.has(host)) revealObserver.observe(host);
  }

  function observeHost(host) {
    const style = getComputedStyle(host);
    const contentsOnly = style.display === 'contents';
    if (contentsOnly || (style.overflowY === 'visible' && host.scrollHeight > host.clientHeight + 1)) {
      manualBounds.set(host, contentsOnly);
      scheduleView();
    } else {
      manualBounds.delete(host);
      revealObserver.observe(host);
      prefetchObserver.observe(host);
    }
  }

  function enqueue(host) {
    waiting.add(host);
    if (whole) queue.add(host);
    else observeHost(host);
  }

  function watch(host) {
    if (!mode || seen.has(host) || excludedHost(host)) return;
    seen.add(host);
    enqueue(host);
  }

  function discover(root) {
    if (respectDocumentHint() || root.nodeType !== Node.ELEMENT_NODE || root.closest(hardExclusions)) return;
    if (youtubePage) {
      if (root.closest(youtubeExcluded)) return;
      // Both renderer generations can nest one label inside another (a legacy
      // #video-title inside #video-title-link). The outer label owns the run.
      const owner = root.closest(youtubeUnits);
      if (owner) { if (!owner.parentElement?.closest(youtubeUnits)) watch(owner); return; }
      for (const host of root.querySelectorAll(youtubeUnits)) {
        if (!host.parentElement?.closest(youtubeUnits)) watch(host);
      }
      return;
    }
    if (root.matches(readingRoots)) watch(root);
    for (const unit of root.querySelectorAll(readingRoots)) watch(unit);
    if (root.closest(excluded)) return;
    // Unpack nested blocks when their container reaches the reading range.
    // New inline nodes belong to their nearest existing reading unit.
    if (root.shadowRoot || root.matches(blocks)) watch(root);
    else if (!root.parentElement?.closest(blocks)) watch(root);
  }

  function forget(host) {
    structuralHosts.delete(host);
    incomplete.delete(host);
    prepared.delete(host);
    reuse.delete(host);
    restore(host);
    seen.delete(host);
    stopWatching(host);
  }

  // Keep adjacent inline fragments together in the provider request so a link label or
  // emphasized word can be translated in the context of the rest of the sentence.
  async function translateRuns(runs, current) {
    let texts = [], targets = [], groups = [];
    let size = 0;
    const targetLanguage = youtubePage ? await youtubeTarget : '';
    if (current !== generation) return;
    async function send() {
      if (!texts.length || current !== generation) return;
      const translated = await translate(texts, { purpose: 'page', groups });
      targets.forEach((part, i) => part.result.push(translated[i]));
      texts = []; targets = []; groups = []; size = 0;
    }
    for (const [index, run] of runs.entries()) {
      if (run.youtube && localizedYoutubeGuide(run.host, targetLanguage)) {
        for (const part of run.parts) if (part.translate) part.value = part.source;
        run.unchanged = true;
        continue;
      }
      for (const part of run.parts) {
        if (!part.translate) continue;
        part.result = [];
        for (const chunk of part.source.trim().match(/[\s\S]{1,3500}/gu)) {
          if (texts.length === 20 || size + chunk.length > 12000) await send();
          if (current !== generation) return;
          texts.push(chunk);
          targets.push(part);
          groups.push(index);
          size += chunk.length;
        }
      }
    }
    await send();
    if (current !== generation) return;
    for (const run of runs) {
      if (run.unchanged) continue;
      for (const part of run.parts) {
        if (!part.translate) continue;
        if (part.result.includes(null)) run.incomplete = true;
        else part.value = part.source.match(/^\s*/)[0] + part.result.join(' ') + part.source.match(/\s*$/)[0];
        delete part.result;
      }
      if (run.youtube) run.unchanged = run.parts.every(part => !part.translate || part.source === part.value);
    }
  }

  function sameRuns(source, fresh) {
    return fresh.length === source.length && source.every((run, i) =>
      fresh[i].last === run.last && fresh[i].anchor === run.anchor && fresh[i].navigation === run.navigation && fresh[i].layout === run.layout && fresh[i].parts.length === run.parts.length &&
      run.parts.every((part, j) => part.node === fresh[i].parts[j].node && part.source === fresh[i].parts[j].source &&
        part.translate === fresh[i].parts[j].translate));
  }

  function flush() {
    if (paused || !mode || !queue.size) return;
    void processQueue(true);
    if (!whole && runningBatches.get(true) !== generation) void processQueue(false);
  }

  async function processQueue(near) {
    const current = generation;
    if (runningBatches.get(near) === current) return;
    runningBatches.set(near, current);
    let missing = false;
    try {
      while (current === generation && mode && !paused && queue.size) {
        const jobs = [];
        // Keep a request slot available when the reader jumps while a prefetch
        // is in flight. Work that has already left the range stays out of the queue.
        const candidates = whole ? queue : [...queue].filter(host => closeToView.has(host) === near);
        if (!whole && !candidates.length) break;
        if (!near && runningBatches.get(true) === current) break;
        for (const host of candidates) {
          queue.delete(host);
          waiting.delete(host);
          prefetchObserver?.unobserve(host);
          if (!host.isConnected || outputs.has(host) || prepared.has(host)) continue;
          if (whole && (youtubePage || host.matches(navigation)) && !host.getClientRects().length && getComputedStyle(host).display !== 'contents') {
            hiddenNavigationObserver ||= new IntersectionObserver((entries, observer) => {
              if (observer !== hiddenNavigationObserver) return;
              for (const entry of entries) if (entry.isIntersecting) {
                observer.unobserve(entry.target);
                enqueue(entry.target);
              }
              void flush();
            });
            hiddenNavigationObserver.observe(host);
            continue;
          }
          const runs = readRuns(host);
          const previous = reuse.get(host);
          reuse.delete(host);
          if (runs.length && previous && sameRuns(previous, runs)) {
            ready(host, previous);
          } else if (runs.length) jobs.push({ host, runs });
          else {
            structuralHosts.add(host);
            stopWatching(host);
          }
          if (jobs.length === 6) break;
        }
        if (!jobs.length) continue;
        try {
          await translateRuns(jobs.flatMap(job => job.runs), current);
        } catch (error) {
          if (current !== generation) continue;
          paused = true;
          for (const { host } of jobs) if (host.isConnected) enqueue(host);
          signalState();
          notice(error.message + '。可在侧栏再次点击当前模式继续。');
          break;
        }
        if (current !== generation) continue;
        for (const { host, runs } of jobs) {
          if (!host.isConnected || !seen.has(host) || outputs.has(host)) continue;
          if (!sameRuns(runs, readRuns(host, false))) enqueue(host);
          else if (runs.some(run => run.incomplete)) {
            stopWatching(host);
            incomplete.add(host);
            missing = true;
            signalState();
          } else {
            ready(host, runs);
          }
        }
      }
      if (missing && current === generation && mode && !paused && incomplete.size) {
        notice(`还有 ${incomplete.size} 处未取得完整译文，已保留原文。可在侧栏再次点击当前模式补译。`);
      }
    } finally {
      if (runningBatches.get(near) === current) runningBatches.delete(near);
      if (near && current === generation && !paused && !whole && queue.size) void processQueue(false);
    }
  }

  function sourceKey(host, runs) {
    return JSON.stringify([host.localName, runs.map(run => run.parts.map(part =>
      [part.node.nodeName, part.translate, part.source]))]);
  }

  function reconnectParagraphs(root, previous) {
    // Some viewers remount the article from its source HTML. Only reattach
    // already displayed text from the same parent and the same DOM update.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const checked = new Set();
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const tags = previous.firstText.get(text.data);
      if (!tags || text.parentElement.closest(excluded)) continue;
      for (const tag of tags) {
        const host = text.parentElement.closest(tag);
        if (!host || !root.contains(host) || checked.has(host) || outputs.has(host)) continue;
        checked.add(host);
        const runs = readRuns(host, false);
        const prior = previous.bySource.get(sourceKey(host, runs));
        if (!prior) continue;
        for (const [i, run] of runs.entries()) {
          for (const [j, part] of run.parts.entries()) part.value = prior[i].parts[j].value;
          run.unchanged = prior[i].unchanged;
        }
        for (const run of runs) {
          const copy = (run.anchor || run.last).nextSibling;
          if (copy?.matches?.('pt-dual.pt-translation')) copy.remove();
        }
        seen.add(host);
        stopWatching(host);
        apply(host, runs);
      }
    }
  }

  function keepWhileHidden(host) {
    if (youtubePage) return host.isConnected && !excludedAcrossRoots(host, youtubeExcluded) &&
      (excludedAcrossRoots(host, temporarilyHidden) || !host.getClientRects().length && getComputedStyle(host).display !== 'contents');
    if (!host.isConnected || excludedAcrossRoots(host, (host.matches(navigation) ? hardExclusions : offLimits) + ',' + media + ',' + protectedText)) return false;
    if (excludedAcrossRoots(host, temporarilyHidden)) return true;
    const style = getComputedStyle(host);
    return style.visibility !== 'visible' || !host.getClientRects().length && style.display !== 'contents';
  }

  function refresh() {
    if (!mode) return;
    collectChanges(mutations.takeRecords());
    const replaced = new Map();
    if (prune) {
      const parents = new Set(insertedRoots.values());
      for (const host of seen) {
        if (host.isConnected) continue;
        const record = outputs.get(host);
        if (record && parents.size) {
          let ancestor = host;
          while (ancestor && !removedRoots.has(ancestor)) ancestor = treeParent(ancestor);
          const parent = removedRoots.get(ancestor);
          if (parents.has(parent)) {
            if (!replaced.has(parent)) replaced.set(parent, { bySource: new Map(), firstText: new Map() });
            const group = replaced.get(parent);
            const lead = record.runs[0].parts.find(part => part.translate).source;
            if (!group.firstText.has(lead)) group.firstText.set(lead, new Set());
            group.firstText.get(lead).add(host.localName);
            group.bySource.set(sourceKey(host, record.runs), record.runs);
          }
        }
        forget(host);
      }
      prune = false;
    }
    for (const [root, parent] of insertedRoots) {
      if (root.isConnected && replaced.has(parent)) reconnectParagraphs(root, replaced.get(parent));
    }
    insertedRoots.clear();
    removedRoots.clear();
    if (changedSubtrees.size) {
      for (const host of outputs.keys()) {
        for (let ancestor = host; ancestor; ancestor = treeParent(ancestor)) {
          if (!changedSubtrees.has(ancestor)) continue;
          dirty.add(host);
          restyle.add(host);
          break;
        }
      }
      changedSubtrees.clear();
    }
    for (const host of dirty) {
      const record = outputs.get(host);
      // An image dialog can temporarily hide the entire article from assistive
      // technology. Its existing translations still belong to that article.
      if (record && keepWhileHidden(host)) continue;
      if (record && sameRuns(record.runs, readRuns(host))) {
        if (restyle.has(host) || record.copies.some(copy => !copy.isConnected)) refreshCopies(record);
        continue;
      }
      forget(host);
      if (host.isConnected) watch(host);
    }
    dirty.clear();
    restyle.clear();
    mutations.takeRecords();
    for (const root of additions) if (root.isConnected) discover(root);
    additions.clear();
    void flush();
  }

  function collectChanges(records) {
    let changed = false;
    for (const record of records) {
      const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : treeParent(record.target);
      if (!element || element.closest('.pt-translation,.pt-youtube-caption,#pt-notice,pt-reading-tools')) continue;
      if (youtubePage && element.closest(youtubeWidgets)) continue;
      if (record.type === 'characterData' && edited.get(record.target)?.value === record.target.data) continue;
      if (record.type === 'attributes') {
        // A hidden or reclassified subtree may contain independent paragraph owners.
        additions.add(element);
        if (record.attributeName !== 'href') changedSubtrees.add(element);
      }
      if (record.type === 'childList') {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && !node.matches('.pt-translation,.pt-youtube-caption,#pt-notice,pt-reading-tools')) {
            additions.add(node);
            insertedRoots.set(node, element);
          }
        }
        if ([...record.addedNodes, ...record.removedNodes].every(node => node.nodeType === Node.ELEMENT_NODE && node.matches('.pt-translation,.pt-youtube-caption,#pt-notice,pt-reading-tools'))) {
          for (const copy of record.removedNodes) {
            const owner = copyOwners.get(copy);
            if (owner?.isConnected && outputs.has(owner) && !copy.isConnected) {
              dirty.add(owner);
              restyle.add(owner);
              changed = true;
            }
          }
          continue;
        }
      }
      if (record.type === 'childList') {
        for (const node of record.removedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && !node.matches('.pt-translation,.pt-youtube-caption,#pt-notice,pt-reading-tools')) {
            removedRoots.set(node, element);
            prune = true;
          }
        }
      }
      let host = element;
      while (host && !seen.has(host)) host = treeParent(host);
      if (host) {
        dirty.add(host);
        if (record.type === 'attributes') restyle.add(host);
      }
      changed = true;
    }
    return changed;
  }

  const mutations = new MutationObserver(records => {
    if (collectChanges(records) && !scanTimer) scanTimer = setTimeout(() => {
      scanTimer = undefined;
      refresh();
    }, 80);
  });

  if (youtubePage) document.addEventListener('yt-navigate-finish', () => {
    if (mode) { discover(document.body); scheduleView(); void flush(); }
  });

  function clear() {
    mode = '';
    paused = false;
    resumeOnVisible = false;
    clearTimeout(noticeTimer);
    document.getElementById('pt-notice')?.remove();
    changedSubtrees.clear();
    incomplete.clear();
    generation++;
    clearTimeout(scanTimer);
    clearTimeout(resizeTimer);
    scanTimer = undefined;
    restyle.clear();
    structuralHosts.clear();
    removedRoots.clear();
    insertedRoots.clear();
    reuse = new WeakMap();
    prune = false;
    prefetchObserver?.disconnect();
    revealObserver?.disconnect();
    hiddenNavigationObserver?.disconnect();
    hiddenNavigationObserver = undefined;
    prefetchObserver = revealObserver = undefined;
    cancelAnimationFrame(viewFrame);
    viewFrame = 0;
    manualBounds.clear();
    waiting.clear();
    closeToView.clear();
    prepared.clear();
    mutations.disconnect();
    observedShadows = new WeakSet();
    queue.clear();
    seen.clear();
    dirty.clear();
    additions.clear();
    for (const host of outputs.keys()) restore(host);
  }

  function start(next, entire = false, { initiallyPaused = false, reuseResults = true } = {}) {
    // A display-mode or breakpoint change can reuse translations and live links.
    const displayed = reuseResults ? [...outputs.keys()] : [];
    const previous = reuseResults ? new WeakMap(prepared) : new WeakMap();
    for (const host of displayed) previous.set(host, outputs.get(host).runs);
    clear();
    reuse = previous;
    viewWidth = window.innerWidth;
    viewHeight = window.innerHeight;
    mode = next;
    whole = entire;
    paused = initiallyPaused;
    if (youtubePage) youtubeTarget = chrome.runtime.sendMessage({ action: 'caption-language' })
      .then(settings => settings?.language || '').catch(() => '');
    if (!whole) setupObservers();
    mutations.observe(document.documentElement, observerOptions);
    for (const host of displayed) {
      if (!host.isConnected) continue;
      const runs = reuse.get(host);
      if (sameRuns(runs, readRuns(host))) {
        seen.add(host);
        stopWatching(host);
        apply(host, runs);
        reuse.delete(host);
      }
    }
    discover(document.body);
    void flush();
  }

  document.addEventListener('scroll', () => {
    if (manualBounds.size) scheduleView();
  }, { capture: true, passive: true });

  window.addEventListener('resize', () => {
    if (!mode || viewWidth === innerWidth && viewHeight === innerHeight) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!mode) return;
      const widthChanged = viewWidth !== innerWidth;
      viewWidth = innerWidth;
      viewHeight = innerHeight;
      if (!whole) setupObservers();
      if (widthChanged) {
        changedSubtrees.add(document.body);
        for (const host of structuralHosts) if (host.isConnected) enqueue(host);
        structuralHosts.clear();
        refresh();
      }
      if (!whole) scheduleView();
    }, 150);
  });

  async function input() {
    const field = document.activeElement;
    const editable = field?.isContentEditable;
    const plain = field instanceof HTMLTextAreaElement ||
      (field instanceof HTMLInputElement && ['text', 'search'].includes(field.type) && field.autocomplete !== 'one-time-code');
    if (!editable && !plain) throw new Error('请先聚焦文本输入框');
    const read = () => editable ? field.innerText : field.value;
    const original = read();
    if (!original.trim()) return;
    const [result] = await translate([original], { purpose: 'input' });
    if (!field.isConnected || read() !== original) throw new Error('输入内容已变化，请重试');
    if (editable) field.textContent = result;
    else Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value').set.call(field, result);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  document.addEventListener('contextmenu', event => {
    imageTarget = event.target instanceof HTMLImageElement ? event.target : null;
  }, true);

  async function image() {
    if (!imageTarget?.naturalWidth) throw new Error('图片尚未加载');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1400 / Math.max(imageTarget.naturalWidth, imageTarget.naturalHeight));
    canvas.width = Math.max(1, Math.round(imageTarget.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(imageTarget.naturalHeight * scale));
    canvas.getContext('2d').drawImage(imageTarget, 0, 0, canvas.width, canvas.height);
    let picture;
    try {
      picture = canvas.toDataURL('image/jpeg', 0.8);
    } catch {
      throw new Error('该图片禁止跨域读取，可以下载后在扩展面板上传');
    }
    notice((await translate([''], { picture }))[0]);
  }

  let htmlCaptions;
  let youtubeCaptions;

  let captionCommand = Promise.resolve();
  function captionLanguage() {
    return chrome.runtime.sendMessage({ action: 'caption-language' }).then(value => value?.language || '简体中文');
  }
  async function setCaptions(action) {
    const session = youtubeCaptions || htmlCaptions;
    const mode = action === 'captions' ? (session ? 'off' : 'dual') : action.slice('captions-'.length);
    if (mode === 'off') { session?.stop(); return; }
    if (session) { session.setMode(mode); return; }
    if (globalThis.bingduYoutubeCaptions?.isVideoPage()) {
      youtubeCaptions = globalThis.bingduYoutubeCaptions.start(translate, notice, () => {
        youtubeCaptions = null;
        signalState();
      }, mode, await captionLanguage());
      return;
    }
    const engine = globalThis.bingduHtml5Captions;
    const video = engine?.candidate();
    if (!video) throw new Error('此页面未提供可读取的 HTML5 视频字幕轨');
    htmlCaptions = engine.start(video, translate, mode, () => {
      htmlCaptions = null;
      signalState();
    }, notice);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && resumeOnVisible) {
      resumeOnVisible = paused = false;
      void flush();
      signalState();
    }
  });

  async function run(action) {
    const firstManualFrameCommand = window !== window.top && !receivedReadingCommand;
    if (['page', 'dual', 'only', 'all', 'original'].includes(action)) receivedReadingCommand = true;
    if (action === 'reader-settings-changed') htmlCaptions?.refresh();
    if (action === 'reader-settings-changed' && youtubeCaptions) {
      const language = await captionLanguage();
      youtubeCaptions?.refresh(language);
    }
    if (action === 'reader-settings-changed' && mode) {
      start(mode, whole, { initiallyPaused: document.hidden, reuseResults: false });
      resumeOnVisible = document.hidden;
    } else if (action === 'page') {
      if (mode) clear();
      else start('dual');
    } else if (action === 'dual' || action === 'only' || action === 'all') {
      const next = action === 'only' ? 'only' : 'dual';
      if (mode === next && whole === (action === 'all') && (paused || incomplete.size)) {
        paused = false;
        for (const host of incomplete) if (host.isConnected) enqueue(host);
        incomplete.clear();
        document.getElementById('pt-notice')?.remove();
        void flush();
      } else if (mode !== next || whole !== (action === 'all') || firstManualFrameCommand) start(next, action === 'all');
    } else if (action === 'original') {
      clear();
    } else if (action === 'input') {
      await input();
    } else if (action === 'selection') {
      const text = getSelection()?.toString().trim();
      if (text) notice((await translate([text]))[0]);
    } else if (['captions', 'captions-dual', 'captions-only', 'captions-off'].includes(action)) {
      captionCommand = captionCommand.catch(() => {}).then(() => setCaptions(action));
      await captionCommand;
    } else if (action === 'image') {
      await image();
    }
  }

  // An explicit reading command applies to the visible document, including a
  // frame mounted later. Automatic translation still follows the root hint.
  function respectDocumentHint() {
    return !receivedReadingCommand && document.documentElement.matches(documentHint);
  }

  document.addEventListener('pointerover', event => {
    if (!event.altKey || respectDocumentHint() || !(event.target instanceof Element)) return;
    const node = event.target.closest(blocks);
    if (!node || event.target.closest(excluded + ',' + media) || node === document.body) return;
    if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return;
    const text = readRuns(node, false).map(run => run.parts.map(part => part.source).join('')).join(' ').trim();
    if (!text || text.length > 9000) return;
    translate([text]).then(([value]) => notice(value)).catch(error => notice(error.message));
  });

  function getState() {
    return { mode: mode || 'original', whole: !!mode && whole, paused, incomplete: incomplete.size,
      youtube: !!globalThis.bingduYoutubeCaptions?.isVideoPage(), captions: !!(youtubeCaptions || htmlCaptions), captionMode: (youtubeCaptions || htmlCaptions)?.mode || 'off' };
  }

  let lastCaptionMode = 'off';
  function signalState() {
    globalThis.parallelReadingChanged?.();
    const next = (youtubeCaptions || htmlCaptions)?.mode || 'off';
    if (next !== lastCaptionMode) {
      lastCaptionMode = next;
      document.dispatchEvent(new Event('bingdu-caption-state-changed'));
    }
  }

  if (globalThis.bingduYoutubeCaptions) document.addEventListener('yt-navigate-finish', signalState);
  globalThis.parallelReading = { getState, async run(action) { await run(action); signalState(); } };

  chrome.runtime.onMessage.addListener(({ action }, _sender, reply) => {
    if (action === 'reading-mode-for-child' && window === window.top) {
      // A child can finish loading while the top document is still reading its preferences.
      initialReading.then(() => {
        if (mode) reply({ command: whole ? 'all' : mode, manual: receivedReadingCommand });
        else reply(receivedReadingCommand ? 'original' : null);
      });
      return true;
    }
    if (action === 'reading-state') {
      reply(getState());
      return;
    }
    if (action === 'hostname') {
      reply({ hostname: location.hostname, localFile, site: localFile ? location.href.split(/[?#]/, 1)[0] : location.hostname });
      return;
    }
    if (!['page', 'dual', 'only', 'original', 'all', 'input', 'selection', 'image', 'reader-settings-changed',
          'captions', 'captions-dual', 'captions-only', 'captions-off'].includes(action)) return;
    globalThis.parallelReading.run(action).then(() => reply(action?.startsWith('captions') ? { ok: true, captions: getState().captions, captionMode: getState().captionMode } : { ok: true }), error => {
      notice(error.message);
      reply({ error: error.message });
    });
    return true;
  });

  const initialReading = chrome.runtime.sendMessage({ action: 'preferences' })
    .then(preference => {
      const command = preference?.command ?? preference;
      if (receivedReadingCommand || !['dual', 'only', 'all'].includes(command)) return;
      receivedReadingCommand = preference?.manual === true;
      if (respectDocumentHint()) return;
      start(command === 'only' ? 'only' : 'dual', command === 'all');
      signalState();
    })
    .catch(() => {});
})();
