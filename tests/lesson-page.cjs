const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const extension = path.resolve(__dirname, '..');
const url = 'https://course.example.test/lesson';
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><style>
  body { margin:0; font:18px/1.5 system-ui }
  #header, #lp-footer { position:fixed; left:0; right:0; height:46px }
  #header { top:0 } #lp-footer { bottom:0 }
  #lp-wrapper { margin-top:46px }
  #lesson-main-inner { position:relative; height:65vh }
  #lesson-main-content { position:absolute; inset:50px 0 0; overflow:auto }
  #gap { height:2400px }
</style><body class="sj-page-lesson"><header id="header">
  <button id="lessons"><i aria-hidden="true">★</i>Lessons</button>
  <a href="/guides">Exam Guides</a><a href="/framework">Framework</a><a href="/retake">Retake Process</a><a href="/help">Help</a>
</header><div id="lp-wrapper"><div id="lesson-body"><div id="lesson-main"><div id="lesson-main-inner">
  <h1>Pre-Exam Notes</h1><div id="lesson-main-content"><h2>Please note</h2>
  <p><strong>Supported Browsers</strong> — <span>Read the instructions.</span></p>
  <div id="gap"></div><p id="tail">More information</p></div>
</div></div></div></div><div id="lp-footer"><a class="next-lesson-button" href="/next"><span>Next</span></a></div></body></html>`;

async function run() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bingdu-lesson-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(dir, {channel:'chromium', executablePath:process.env.CHROME_PATH,
      headless:true, args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(async () => {
      await chrome.storage.local.set({apiKey:'offline-fixture'});
      globalThis.fetch = async (url, options) => {
        if (String(url) !== 'https://api.deepseek.com/chat/completions') throw Error('Unexpected service');
        const request = JSON.parse(options.body), input = request.messages.at(-1).content;
        const translated = s => '译' + s.trim();
        const content = request.response_format
          ? JSON.stringify({translations:Object.fromEntries(JSON.parse(input).map(row => [row.id, translated(row.text)]))})
          : translated(input);
        return Response.json({choices:[{finish_reason:'stop',message:{content}}]});
      };
    });
    const page = await context.newPage();
    await page.route(url, route => route.fulfill({contentType:'text/html', body:html}));
    await page.goto(url);
    const original = await page.locator('#lesson-main-content').innerHTML();
    const rects = () => page.locator('#header,#lp-footer,#lesson-main-content').evaluateAll(nodes =>
      nodes.map(node => [node.offsetTop, node.clientHeight, node.clientWidth]));
    const before = await rects();
    const command = async name => {
      const control = page.getByRole('button', {name,exact:true});
      if (!await control.isVisible()) await page.getByRole('button', {name:'并读 · 更多操作',exact:true}).click();
      await control.click();
    };
    await command('仅看译文');
    const labels = '#lesson-main h1,#lesson-main-content h2,p strong,p span,#lessons,#header a,#lp-footer a span';
    await page.waitForFunction(selector => [...document.querySelectorAll(selector)].every(node =>
      node.textContent.includes('译')), labels, {timeout:8000}).catch(async error => {
      const missing = await page.locator(labels).evaluateAll(nodes =>
        nodes.filter(node => !node.textContent.includes('译')).map(node => node.textContent));
      throw new Error('Untranslated lesson text: ' + missing.join(', '), {cause:error});
    });
    assert.deepEqual(await rects(), before);
    assert.equal(await page.locator('#lessons i').textContent(), '★');
    assert.equal(await page.locator('#lp-footer a').getAttribute('href'), '/next');
    assert.equal(await page.locator('#tail').textContent(), 'More information');
    // A lesson may mount its separate text document after the reader chose a mode.
    await page.route('https://materials.example.test/notes', route => route.fulfill({
      contentType:'text/html', body:'<!doctype html><p>Document notes</p>'
    }));
    await page.locator('#lesson-main-content').evaluate(el => {
      const frame = document.createElement('iframe');
      frame.src = 'https://materials.example.test/notes';
      el.prepend(frame);
    });
    const embedded = page.frameLocator('#lesson-main-content iframe').locator('p');
    await embedded.filter({hasText:/^译Document notes$/}).waitFor({timeout:5000});
    await page.locator('#lesson-main-content iframe').evaluate(frame => {
      frame.srcdoc = '<p>Inline notes</p>';
    });
    await embedded.filter({hasText:/^译Inline notes$/}).waitFor({timeout:5000});
    await page.locator('#tail').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('#tail').textContent === '译More information');
    await page.locator('#lesson-main-content h2').scrollIntoViewIfNeeded();
    await command('切换双语');
    await page.waitForFunction(() => document.querySelector('h2').textContent.includes('Please note') &&
      document.querySelector('h2 pt-dual')?.textContent.includes('译Please note'));
    assert.equal(await page.locator('#header a').first().textContent(), '译Exam Guides');
    await command('恢复原文');
    await embedded.filter({hasText:/^Inline notes$/}).waitFor();
    await page.locator('#lesson-main-content iframe').evaluate(frame => frame.remove());
    assert.equal(await page.locator('#lesson-main-content').innerHTML(), original);
    assert.equal(await page.locator('#lp-footer a span').textContent(), 'Next');
    console.log('Lesson content, fixed navigation, scrolling, bilingual mode and restoration passed.');
  } finally {
    await context?.close();
    await fs.rm(dir, {recursive:true, force:true});
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
