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
};

// An offline watch page with nested application components, a clipped card title,
// and a comment loaded below the fold. The sample prose and markup are synthetic.
const fixture = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Video</title>
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
  <div id="movie_player" class="html5-video-player">
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
      const translate = text => dictionary[text.trim()] || '其他测试译文';
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
    await page.getByRole('button', { name: '并读 · 更多操作', exact: true }).click();
    await page.getByRole('button', { name: '仅看译文', exact: true }).click();
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
