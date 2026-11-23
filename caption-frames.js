// Keep only Chrome document IDs across service-worker sleep. Probe the actual
// player before routing, so a reused frame ID cannot target a different lesson.
const keyPrefix = tabId => 'caption-frame:' + tabId + ':';
const actions = new Set(['captions', 'captions-dual', 'captions-only', 'captions-off']);

function notifyControls(tabId) {
  const message = { action: 'caption-context-changed', tabId };
  chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => {});
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function frameKeys(tabId) {
  const keys = chrome.storage.session.getKeys ? await chrome.storage.session.getKeys() :
    Object.keys(await chrome.storage.session.get(null));
  return keys.filter(key => key.startsWith(keyPrefix(tabId)));
}

async function probe(tabId, address) {
  try {
    return await chrome.tabs.sendMessage(tabId, { action: 'probe-caption-player' }, address);
  } catch {
    return null;
  }
}

async function players(tabId) {
  const keys = await frameKeys(tabId);
  const candidates = [{ frameId: 0 }, ...keys.map(key => ({ documentId: key.slice(keyPrefix(tabId).length) }))];
  const states = await Promise.all(candidates.map(async address => {
    const state = await probe(tabId, address);
    if (!state && address.documentId) await chrome.storage.session.remove(keyPrefix(tabId) + address.documentId);
    return state?.available ? { address, ...state } : null;
  }));
  return states.filter(Boolean).sort((a, b) =>
    Number(b.playing) - Number(a.playing) || (a.playing && b.activity - a.activity) ||
    Number(b.active) - Number(a.active) || Number(b.ready) - Number(a.ready) ||
    Number(b.visible) - Number(a.visible) || b.activity - a.activity || b.area - a.area);
}

async function route(tabId, command) {
  const list = await players(tabId);
  const current = list[0];
  if (!command) return { available: Boolean(current), youtube: !!current?.youtube, captionMode: current?.mode || 'off' };
  if (!current) {
    if (command === 'captions-off') return { ok: true, captions: false, captionMode: 'off' };
    throw new Error('请先播放视频并确认它提供字幕。当前页面未发现可用的 YouTube 播放器或 HTML5 字幕轨。');
  }
  if (command === 'captions-off' || (command === 'captions' && current.active)) {
    const results = await Promise.all(list.filter(p => p.active).map(p =>
      chrome.tabs.sendMessage(tabId, { action: 'captions-off' }, p.address)));
    const failed = results.find(result => result?.error);
    return failed || { ok: true, captions: false, captionMode: 'off' };
  }
  return chrome.tabs.sendMessage(tabId, { action: command === 'captions' ? 'captions-dual' : command }, current.address);
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'bingdu-media-frame') return;
  const { tab, frameId, documentId, url } = port.sender;
  if (!tab || !frameId || !documentId || !url || !/^(https?:|file:)$/.test(new URL(url).protocol)) return;
  const key = keyPrefix(tab.id) + documentId;
  const registered = chrome.storage.session.set({ [key]: true });
  registered.then(() => notifyControls(tab.id));
  port.onDisconnect.addListener(async () => {
    await registered;
    // A sleeping worker can lose its connection while the document stays alive.
    if (await probe(tab.id, { documentId })) return;
    await chrome.storage.session.remove(key);
    notifyControls(tab.id);
  });
});

chrome.tabs.onRemoved.addListener(tabId => {
  frameKeys(tabId).then(keys => chrome.storage.session.remove(keys)).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.action === 'caption-frame-left' && sender.tab && sender.frameId && sender.documentId) {
    chrome.storage.session.remove(keyPrefix(sender.tab.id) + sender.documentId).then(() => notifyControls(sender.tab.id));
    return;
  }
  if (message.action === 'caption-player-changed' && sender.tab) {
    notifyControls(sender.tab.id);
    return;
  }
  if (message.action !== 'caption-tab-state' && message.action !== 'caption-tab-command') return;
  const fromExtension = sender.url?.startsWith(chrome.runtime.getURL(''));
  const tabId = fromExtension ? message.tabId : sender.frameId === 0 ? sender.tab?.id : undefined;
  const command = message.action === 'caption-tab-command' ? message.command : null;
  if (!Number.isInteger(tabId) || (message.action === 'caption-tab-command' && !actions.has(command))) return;
  route(tabId, command).then(reply, error => reply({ error: error.message }));
  return true;
});
