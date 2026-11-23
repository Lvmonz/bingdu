const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const extension = path.resolve(__dirname, '..');
const watch = 'https://www.youtube.com/watch?v=fixture';
const words = {
  'A walk along the river': '沿河漫步',
  'Watch from the bridge.': '从桥上观看。',
  'Forest paths': '林间小径',
  'Listen to the birds.': '听听鸟鸣。',
  'Coastal walks': '海滨漫步',
  'Island trails': '海岛小径',
  'An original cue': '一条原声字幕',
  'We study the river basin.': '我们研究流域。',
  'It feeds the lake.': '它为湖泊供水。',
};

// An offline watch page with nested application components, a clipped card title,
// and a comment loaded below the fold. The sample prose and markup are synthetic.
const fixture = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>Video</title>
<style>
  body { margin: 0; font: 18px/1.3 system-ui; }
  ytd-app, ytd-watch-flexy, ytd-watch-metadata, yt-lockup-view-model,
  ytd-comments, ytd-comment-view-model, ytd-search, ytd-video-renderer,
  yt-formatted-string, ytd-text-inline-expander { display: block; }
  ytd-app { position: absolute; inset: 0; }
  #related { width: 230px; }
  .ytLockupMetadataViewModelTitle { display: -webkit-box; -webkit-box-orient: vertical;
    -webkit-line-clamp: 1; overflow: hidden; }
  #gap { height: 3500px; }
</style>
<body><ytd-app><ytd-watch-flexy>
  <ytd-guide-entry-renderer><a id="endpoint" href="/"><span id="title">首页</span></a></ytd-guide-entry-renderer>
  <div id="movie_player" class="html5-video-player">
    <video width="240" height="90"></video>
    <button class="ytp-subtitles-button" aria-pressed="true">CC</button>
    <div class="ytp-caption-window-container"><span class="ytp-caption-segment">An original cue</span></div>
    <button class="ytp-play-button">Resume playback</button>
  </div>
  <ytd-watch-metadata>
    <div id="title"><h1><yt-formatted-string>A walk along the river</yt-formatted-string></h1></div>
    <div id="description"><ytd-text-inline-expander id="description-inline-expander"><span id="snippet-text"><yt-attributed-string><span class="yt-core-attributed-string">Watch from the bridge.</span></yt-attributed-string></span></ytd-text-inline-expander></div>
  </ytd-watch-metadata>
  <div id="related"><yt-lockup-view-model><h3><a href="/watch?v=next" class="ytLockupMetadataViewModelTitle"><span class="yt-core-attributed-string">Forest paths</span></a></h3></yt-lockup-view-model></div>
  <div id="gap"></div><ytd-comments></ytd-comments>
</ytd-watch-flexy></ytd-app></body></html>`;

async function installOfflineTranslator(context) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(async dictionary => {
    await chrome.storage.local.set({ apiKey: 'offline-fixture', language: '简体中文' });
    globalThis.fetch = async (url, options) => {
      if (String(url) !== 'https://api.deepseek.com/chat/completions') throw Error('Unexpected endpoint');
      const request = JSON.parse(options.body);
      const input = request.messages.at(-1).content;
      if (request.messages.length === 3) {
        globalThis.subtitleRequests ||= [];
        globalThis.subtitleRequests.push({ input, context:JSON.parse(request.messages[1].content).subtitleContext });
      }
      const translate = text => {
        if (text === 'It feeds the lake.' && request.messages.length === 3 &&
            JSON.parse(request.messages[1].content).subtitleContext.before === text) return '它为这座湖泊供水。';
        return dictionary[text.trim()] || '其他测试译文';
      };
      let content;
      if (request.response_format) {
        const translations = Object.fromEntries(JSON.parse(input).map(row => [row.id, translate(row.text)]));
        content = JSON.stringify({ translations });
      } else {
        content = translate(input);
      }
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
    };
  }, words);
}

async function expectText(page, selector, source, mode = 'dual') {
  const target = words[source];
  await page.waitForFunction(({ selector, source, target, mode }) => {
    const host = document.querySelector(selector);
    if (!host) return false;
    const text = host.textContent.trim();
    if (mode === 'original') return text === source;
    if (mode === 'only') return text === target;
    return text.includes(source) && text.split(target).length === 2;
  }, { selector, source, target, mode }, { timeout: 10000 }).catch(error => {
    throw new Error(`${mode}: expected "${source}" in ${selector}`, { cause: error });
  });
}

// Exercise the extension's normal controls while YouTube rebuilds the CC layer.
async function checkSingleCaptionBox(page) {
  await page.locator('#movie_player').evaluate(player => {
    const track = { languageCode: 'en', vssId: '.en' };
    player.getVideoData = () => ({ video_id: 'fixture' });
    player.getPlayerResponse = () => ({ videoDetails: { videoId: 'fixture', defaultAudioLanguage: 'en' } });
    player.getOption = (_module, setting) => setting === 'tracklist' ? [track] : track;
  });
  async function choose(label) {
    const button = page.getByRole('button', { name: label, exact: true });
    if (!await button.isVisible()) await page.getByRole('button', { name: '并读 · 更多操作', exact: true }).click();
    await button.click();
  }
  await choose('双语字幕');
  await expectText(page, '.pt-youtube-caption', 'An original cue');
  const samples = await page.evaluate(async () => {
    const player = document.querySelector('#movie_player');
    const observations = [];
    for (let i = 0; i < 12; i++) {
      const native = player.querySelector('.ytp-caption-window-container');
      native.replaceWith(native.cloneNode(true));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const style = getComputedStyle(player.querySelector('.ytp-caption-window-container'));
      observations.push(style.visibility === 'hidden' && player.querySelectorAll('.pt-youtube-caption:not([hidden])').length === 1);
    }
    return observations;
  });
  assert.ok(samples.every(Boolean), 'A rebuilt native caption layer must stay hidden on every sampled frame');
  await choose('仅译文字幕');
  await page.waitForFunction(() => document.querySelector('.pt-caption-source').hidden &&
    document.querySelector('.pt-caption-target').textContent === '一条原声字幕');
  await choose('关闭字幕翻译');
  await page.waitForFunction(() => !document.querySelector('.pt-youtube-caption') &&
    getComputedStyle(document.querySelector('.ytp-caption-window-container')).visibility === 'visible');

  // Each ASR window stays painted into the next. The second window ends
  // one sentence and begins another. Preload it before the reader enables CC.
  const trackUrl = 'https://www.youtube.com/api/timedtext?v=fixture&kind=asr&lang=en&fmt=json3';
  const events = [
    {tStartMs:22000,dDurationMs:4500,segs:[{utf8:'We'},{utf8:' study',tOffsetMs:240},{utf8:' the',tOffsetMs:920}]},
    {tStartMs:23000,dDurationMs:4000,segs:[{utf8:'river'},{utf8:' basin.',tOffsetMs:500},
      {utf8:' It',tOffsetMs:1600},{utf8:' feeds',tOffsetMs:1800}]},
    {tStartMs:25000,dDurationMs:4000,segs:[{utf8:'the'},{utf8:' lake.',tOffsetMs:400}]},
    {tStartMs:26100,dDurationMs:2000,segs:[{utf8:'It'},{utf8:' feeds',tOffsetMs:200},{utf8:' the lake.',tOffsetMs:500}]}
  ];
  await page.route(trackUrl, route => route.fulfill({contentType:'application/json',body:JSON.stringify({events})}));
  await page.evaluate(async url => { await (await fetch(url)).text(); }, trackUrl);
  async function seek(seconds) {
    await page.locator('video').evaluate((video, t) => {
      video.currentTime = t;
      video.dispatchEvent(new Event('timeupdate'));
    }, seconds);
  }
  await seek(22.2);
  await choose('双语字幕');
  await expectText(page, '.pt-youtube-caption', 'We study the river basin.');
  await seek(23.8);
  assert.equal(await page.locator('.pt-caption-source').textContent(), 'We study the river basin.');
  await seek(24.7);
  await expectText(page, '.pt-youtube-caption', 'It feeds the lake.');
  await seek(26.4);
  await page.waitForFunction(() => document.querySelector('.pt-caption-target')?.textContent === '它为这座湖泊供水。');
  await seek(32);
  await page.locator('.pt-youtube-caption').waitFor({state:'hidden'});
  await seek(22.4);
  await choose('仅译文字幕');
  await expectText(page, '.pt-caption-target', 'We study the river basin.', 'only');
  assert.ok(await page.locator('.pt-caption-source').isHidden());
  const [worker] = page.context().serviceWorkers();
  const requests = await worker.evaluate(() => globalThis.subtitleRequests);
  assert.ok(requests.some(({input, context}) => input.includes('We study the river basin.') && context.after === 'It feeds the lake.'));
  await choose('关闭字幕翻译');
}

async function run() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'bingdu-youtube-test-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', executablePath: process.env.CHROME_PATH, headless: true,
      viewport: { width: 1000, height: 720 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await installOfflineTranslator(context);
    await context.route('**/*', route => route.request().url() === watch
      ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture })
      : route.abort());
    const page = await context.newPage();
    await page.goto(watch);
    const title = 'ytd-watch-metadata h1';
    const description = '#description';
    const card = '#related h3';
    await page.evaluate(() => {
      window.originalLink = document.querySelector('#related a');
      window.originalLink.addEventListener('click', event => {
        event.preventDefault();
        window.followedLink = window.originalLink.getAttribute('href');
      });
    });
    await page.getByRole('button', { name: '并读 · 翻译网页', exact: true }).click();
    await expectText(page, title, 'A walk along the river');
    await expectText(page, description, 'Watch from the bridge.');
    await expectText(page, card, 'Forest paths');
    // Both the second line and the card's original click handler must work.
    const targetPoint = await page.locator('#related a').evaluate((link, translated) => {
      if (link !== window.originalLink) return null;
      const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.data.trim() !== translated) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const line = range.getBoundingClientRect();
        const card = link.getBoundingClientRect();
        if (line.height && line.bottom <= card.bottom + 1) return { x: line.x + 2, y: line.y + line.height / 2 };
      }
      return null;
    }, words['Forest paths']);
    assert.ok(targetPoint, 'The translated recommendation must fit inside the original clickable card title');
    await page.mouse.click(targetPoint.x, targetPoint.y);
    assert.equal(await page.evaluate(() => window.followedLink), '/watch?v=next');
    assert.equal(await page.locator('.ytp-caption-segment').innerText(), 'An original cue');
    assert.equal(await page.locator('.ytp-play-button').innerText(), 'Resume playback');
    assert.equal(await page.locator('ytd-guide-entry-renderer').innerText(), '首页');
    await checkSingleCaptionBox(page);

    await page.evaluate(() => {
      const comment = document.createElement('ytd-comment-view-model');
      comment.innerHTML = '<ytd-expander><div id="content"><yt-attributed-string id="content-text"><span class="yt-core-attributed-string">Listen to the birds.</span></yt-attributed-string></div></ytd-expander>';
      document.querySelector('ytd-comments').append(comment);
    });
    await page.locator('#content-text').scrollIntoViewIfNeeded();
    await expectText(page, 'ytd-comment-view-model', 'Listen to the birds.');

    await page.evaluate(() => {
      history.pushState({}, '', '/results?search_query=walking');
      const search = document.createElement('ytd-search');
      search.innerHTML = '<ytd-video-renderer><h3><a id="video-title" href="/watch?v=coastal">Coastal walks</a></h3></ytd-video-renderer>';
      document.querySelector('ytd-watch-flexy').replaceWith(search);
      document.dispatchEvent(new Event('yt-navigate-finish', { bubbles: true }));
      scrollTo(0, 0);
    });
    const result = 'ytd-video-renderer h3';
    await expectText(page, result, 'Coastal walks');

    // The renderer survives the next results update. Replace just its source text.
    await page.locator('#video-title').evaluate(el => {
      el.firstChild.data = 'Island trails';
      el.href = '/watch?v=island';
    });
    await expectText(page, result, 'Island trails');
    assert.equal((await page.locator(result).textContent()).includes(words['Coastal walks']), false);
    const onlyMode = page.getByRole('button', { name: '仅看译文', exact: true });
    if (!await onlyMode.isVisible()) await page.getByRole('button', { name: '并读 · 更多操作', exact: true }).click();
    await onlyMode.click();
    await expectText(page, result, 'Island trails', 'only');
    await page.getByRole('button', { name: '并读 · 恢复原文', exact: true }).click();
    await expectText(page, result, 'Island trails', 'original');
    assert.equal(await page.locator('#video-title').getAttribute('href'), '/watch?v=island');
    assert.equal(await page.locator('.pt-translation').count(), 0);
    console.log('YouTube webpage checks passed (watch, lazy comment, navigation, reused result, display modes, player isolation).');
  } finally {
    try { await context?.close(); } finally { await fs.rm(profile, { recursive: true, force: true }); }
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
