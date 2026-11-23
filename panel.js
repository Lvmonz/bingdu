import { translateFile, prepareText } from './files.js';
import { unavailablePageMessage } from './page-access.js';

const byId = id => document.getElementById(id);
const { id: panelWindow } = await chrome.windows.getCurrent();
const sectionKey = 'panel-section-' + panelWindow;
function navigateTo(sectionRequest) {
  if (!sectionRequest) return;
  const destination = sectionRequest.section === 'language' ? byId('language') :
    byId(sectionRequest.section === 'settings' ? 'settings-title' : 'file-title');
  destination.focus({ preventScroll: true });
  destination.scrollIntoView({ block: 'start' });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[sectionKey]) navigateTo(changes[sectionKey].newValue);
});
const pendingSection = (await chrome.storage.session.get(sectionKey))[sectionKey];
if (pendingSection && Date.now() - pendingSection.time < 10000) navigateTo(pendingSection);
async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function currentSite(tab) {
  tab ??= await currentTab();
  if (!tab?.id) return '';
  return chrome.tabs.sendMessage(tab.id, { action: 'hostname' }, { frameId: 0 })
    .then(response => response?.site ?? response?.hostname, () => '');
}
const defaults = { apiKey: '', language: '简体中文', inputLanguage: '英语', glossary: '', autoSites: [] };
const { apiKey, language, inputLanguage, glossary } = await chrome.storage.local.get(defaults);
const displayStatus = message => { byId('status').textContent = message; };

byId('secret').value = apiKey;
byId('language').value = language;
byId('input-language').value = inputLanguage;
byId('glossary').value = glossary;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.language && byId('language').value === (changes.language.oldValue || defaults.language)) {
    byId('language').value = changes.language.newValue || defaults.language;
  }
  if (changes.autoSites) void refreshAuto();
});
let refreshNumber = 0;
async function refreshAuto() {
  const serial = ++refreshNumber;
  const tab = await currentTab();
  const [site, { autoSites }, captions] = await Promise.all([
    currentSite(tab), chrome.storage.local.get({ autoSites: [] }),
    tab?.id && chrome.runtime.sendMessage({ action: 'caption-tab-state', tabId: tab.id }).catch(() => null)
  ]);
  if (serial !== refreshNumber) return;
  const supportsCaptionModes = !!captions?.available;
  document.querySelector('[data-action="captions"]').hidden = supportsCaptionModes;
  for (const button of document.querySelectorAll('[data-action^="captions-"]')) button.hidden = !supportsCaptionModes;
  byId('auto-label').textContent = site?.startsWith('file:') ? '自动翻译此文件' : '自动翻译此网站';
  byId('auto').disabled = !site;
  byId('auto').checked = autoSites.includes(site);
}
chrome.tabs.onActivated.addListener(() => void refreshAuto());
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.status === 'complete') void refreshAuto();
});
chrome.runtime.onMessage.addListener(message => {
  if (message.action === 'caption-context-changed') {
    currentTab().then(tab => { if (message.tabId === tab?.id) void refreshAuto(); });
  }
});
void refreshAuto();

async function translate(texts, options = {}) {
  const response = await chrome.runtime.sendMessage({ action: 'translate', texts, ...options });
  if (response.error) throw new Error(response.error);
  return response.result;
}

async function perform(button, task) {
  button.disabled = true;
  try {
    await task();
  } catch (error) {
    displayStatus(error.message);
  } finally {
    button.disabled = false;
  }
}

for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => perform(button, async () => {
    const action = button.dataset.action;
    // Broadcast to also handle content inside embedded frames.
    let response;
    const tab = await currentTab();
    try {
      response = action.startsWith('captions')
        ? await chrome.runtime.sendMessage({ action: 'caption-tab-command', tabId: tab.id, command: action })
        : await chrome.tabs.sendMessage(tab.id, { action });
    } catch {
      throw new Error(await unavailablePageMessage(tab?.url));
    }
    if (response.error) throw new Error(response.error);
    if (action.startsWith('captions')) {
      displayStatus(response.captions ? (response.captionMode === 'only' ? '仅显示目标语言字幕' : '双语字幕已开启') : '字幕翻译已关闭');
      return;
    }
    displayStatus(action === 'original' ? '已恢复原文' : '已切换当前网页的翻译模式');
  }));
}

byId('settings').addEventListener('submit', async event => {
  event.preventDefault();
  await perform(event.submitter, async () => {
    await chrome.storage.local.set({
      apiKey: byId('secret').value.trim(),
      language: byId('language').value.trim() || defaults.language,
      inputLanguage: byId('input-language').value.trim() || defaults.inputLanguage,
      glossary: byId('glossary').value.trim()
    });
    displayStatus('已保存到此 Chrome 配置');
  });
});

byId('auto').addEventListener('change', event => perform(event.target, async () => {
  const site = await currentSite();
  if (!site) throw new Error('当前标签页不可用');
  const enabled = event.target.checked;
  const response = await chrome.runtime.sendMessage({ action: 'set-auto-site', site, enabled });
  if (!response?.ok) throw new Error('网站设置保存失败，请重试。');
  const scope = site.startsWith('file:') ? '此文件' : '此网站';
  displayStatus(enabled ? '下次打开' + scope + '时自动翻译' : '已关闭' + scope + '的自动翻译');
}));

byId('test').addEventListener('click', event => perform(event.target, async () => {
  displayStatus('正在测试已保存的 API Key');
  const [value] = await translate(['Translation is ready.'], { language: '简体中文' });
  displayStatus(`连接成功 · ${value}`);
}));

let artifact;
const formats = {
  pdf: [['bilingual', '双语 PDF · 原页与译页'], ['translated', '译文 PDF · 原位排版'], ['text', '双语 TXT']],
  epub: [['bilingual', '双语 EPUB · 段落对照'], ['text', '双语 TXT']]
};
const fileInput = byId('file');
const formatInput = byId('file-format');
const ocrInput = byId('force-ocr');
const resultField = byId('result');

function resetArtifact() {
  artifact = null;
  byId('download').disabled = true;
  byId('download').textContent = '导出';
  resultField.hidden = true;
}

fileInput.addEventListener('change', () => {
  const extension = fileInput.files[0]?.name.split('.').pop()?.toLowerCase();
  const choices = formats[extension] || [];
  formatInput.replaceChildren(...choices.map(([value, label]) => new Option(label, value)));
  byId('file-format-label').hidden = !choices.length;
  byId('force-ocr-label').hidden = extension !== 'pdf';
  ocrInput.checked = false;
  resetArtifact();
  displayStatus('');
});
formatInput.addEventListener('change', resetArtifact);
ocrInput.addEventListener('change', resetArtifact);

byId('translate').addEventListener('click', event => perform(event.target, async () => {
  resetArtifact();
  displayStatus('正在读取内容');
  const file = fileInput.files[0];
  const input = byId('source').value;
  const format = formatInput.value;
  const forceOcr = ocrInput.checked;
  const fields = [fileInput, formatInput, ocrInput, byId('source')];
  fields.forEach(field => { field.disabled = true; });
  try {
    const { apiKey, language } = await chrome.storage.local.get(defaults);
    if (!apiKey) throw new Error('请先在扩展面板保存 DeepSeek API Key');
    async function translateBatch(texts, label = '', picture) {
      const translations = [];
      for (let index = 0; index < texts.length; index += 8) {
        displayStatus(`${label ? label + ' · ' : ''}正在翻译 ${index + 1}–${Math.min(index + 8, texts.length)} / ${texts.length}`);
        translations.push(...await translate(texts.slice(index, index + 8), { language, picture }));
      }
      return translations;
    }
    if (file) {
      artifact = await translateFile(file, { translateBatch, status: displayStatus, apiKey, language, format, forceOcr });
    } else {
      const source = prepareText(input);
      artifact = source.finish(await translateBatch(source.texts));
    }
    resultField.textContent = artifact.preview || artifact.content;
    resultField.hidden = false;
    byId('download').textContent = `导出 ${artifact.name.split('.').pop().toUpperCase()}`;
    byId('download').disabled = false;
    displayStatus('翻译完成');
  } finally {
    fields.forEach(field => { field.disabled = false; });
  }
}));

byId('download').addEventListener('click', () => {
  if (!artifact) return;
  const url = URL.createObjectURL(new Blob([artifact.content], { type: artifact.type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = artifact.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});
