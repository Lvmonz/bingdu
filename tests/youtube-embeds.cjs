const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const extension = path.resolve(__dirname, '..');
const course = 'https://course.example.test/lessons/one';
const wrapper = 'https://player.example.org/lesson';
const regular = 'https://www.youtube.com/embed/abcdefghijk';
const privateEmbed = 'https://www.youtube-nocookie.com/embed/lmnopqrstuv';
const edu = 'https://www.youtubeeducation.com/embed/0123456789a';
const nativeLesson = 'https://video.example.net/course-player';
const regularCue = 'First lesson';
const privateCue = 'Second lesson';
const eduCue = 'Third lesson';

function playerPage(url, cue, ccOn = true) {
  const id = new URL(url).pathname.split('/').at(-1);
  // The desktop course embed can serve YouTube's mobile controls and return
  // the ASR track only on the player response rather than in getOption's list.
  const mobile = url === privateEmbed;
  const ccClass = mobile ? 'ytmClosedCaptioningButtonButton' : 'ytp-subtitles-button';
  const label = ccOn ? '已开启字幕' : '已关闭字幕';
  const button = `<button id="cc" class="${ccClass}" aria-pressed="${ccOn}" aria-label="${label}" title="${label}">CC</button>`;
  const controls = mobile
    ? `<div id="player-control-overlay"><div class="player-controls-top-right"><ytm-closed-captioning-button>${button}</ytm-closed-captioning-button></div></div>`
    : `<div class="ytp-chrome-controls"><div class="ytp-right-controls">${button}</div></div>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><style>
    body { margin:0 } #movie_player { position:relative; height:230px; background:#eee; }
    video { width:220px; height:100px } .ytp-right-controls { position:absolute; bottom:0; right:0; }
  </style><body><div id="movie_player" class="html5-video-player">
    <video></video><div class="ytp-caption-window-container" ${ccOn ? '' : 'hidden'}><span class="ytp-caption-segment">${cue}</span></div>
    ${mobile ? '' : controls}
    <button id="play">Play lesson</button>
  </div>${mobile ? controls : ''}<script>
    const player = document.querySelector('#movie_player');
    const video = player.querySelector('video');
    const cc = document.querySelector('#cc');
    cc.onclick = () => {
      const on = cc.getAttribute('aria-pressed') === 'false';
      cc.setAttribute('aria-pressed', String(on));
      cc.setAttribute('aria-label', on ? '已开启字幕' : '已关闭字幕');
      cc.title = cc.getAttribute('aria-label');
      player.querySelector('.ytp-caption-window-container').hidden = !on;
    };
    const english = {languageCode:'en', kind:'asr', vssId:'a.en'};
    player.getPlayerResponse = () => ({
      videoDetails: { videoId:'${id}', defaultAudioLanguage:'en' },
      captions: { playerCaptionsTracklistRenderer:{captionTracks:[english]} }
    });
    player.getVideoData = () => ({ video_id:'${id}' });
    player.getOption = (_module, option) => {
      if (option === 'tracklist') return ${mobile} ? [] : [english];
      return cc.getAttribute('aria-pressed') === 'true' ? english : {};
    };
    player.querySelector('#play').onclick = () => {
      Object.defineProperty(video, 'paused', {value:false, configurable:true});
      video.dispatchEvent(new Event('play'));
      video.dispatchEvent(new Event('playing'));
    };
  </script></body></html>`;
}

function embeddedFrame(id, url) {
  return `<iframe id="${id}" src="${url}" width="460" height="250" title="${id}" allowfullscreen></iframe>`;
}

async function mockModel(worker) {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ apiKey: 'local-test-value', language: '简体中文' });
    globalThis.fetch = async (url, options) => {
      if (String(url) !== 'https://api.deepseek.com/chat/completions') throw Error('Unexpected service');
      const request = JSON.parse(options.body);
      const original = request.messages.at(-1).content;
      if (original.endsWith('[[source_end]]')) (globalThis.captionBatches ||= []).push(original);
      if (original.includes('Delayed caption')) await globalThis.captionGate;
      const translated = text => text === 'Delayed caption' ? '这段译文会在原文出现后才返回，并且需要在较窄的播放器中显示为两行文字。' : '译：' + text;
      const content = request.response_format
        ? JSON.stringify({ translations: Object.fromEntries(JSON.parse(original).map(row => [row.id, translated(row.text)])) })
        : original.endsWith('[[source_end]]') ? [...original.matchAll(/^\[\[p(\d+)\]\]\n([^\n]+)/gm)]
          .map(([_,id,text])=>'[[p'+id+']]\n'+translated(text)).reverse().join('\n') : translated(original);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
    };
  });
}

// Keep the lesson active, just as Chrome does when the toolbar or side panel opens.
// These are the extension's real HTML entry points and use its normal tab messaging.
async function openExtensionControl(context, worker, file) {
  const pending = context.waitForEvent('page');
  await worker.evaluate(name => chrome.tabs.create({ url: chrome.runtime.getURL(name), active: false }), file);
  const control = await pending;
  await control.waitForURL('**/' + file);
  await control.waitForLoadState('domcontentloaded');
  return control;
}

async function getEmbedFrame(page, url) {
  const frame = page.frames().find(candidate => candidate.url() === url) ||
    await page.waitForEvent('framenavigated', frame => frame.url() === url);
  await frame.locator('#cc').waitFor();
  return frame;
}

async function captionState(frame, mode, cue) {
  const initialCC = frame.url() === regular;
  await frame.waitForFunction(({ mode, cue, initialCC }) => {
    const boxes = document.querySelectorAll('.pt-youtube-caption');
    const native = document.querySelector('.ytp-caption-window-container');
    if (!native) return false;
    const nativeVisible = !native.hidden && getComputedStyle(native).visibility === 'visible';
    if (mode === 'off') {
      return boxes.length === 0 && nativeVisible === initialCC &&
        document.querySelector('#cc').getAttribute('aria-pressed') === String(initialCC);
    }
    if (boxes.length !== 1 || boxes[0].hidden || nativeVisible) return false;
    const source = boxes[0].querySelector('.pt-caption-source');
    const target = boxes[0].querySelector('.pt-caption-target');
    return !target.hidden && target.textContent === '译：' + cue && (mode === 'only'
      ? source.hidden : !source.hidden && source.textContent === cue);
  }, { mode, cue, initialCC }, { timeout: 8000 }).catch(async error => {
    console.log(await frame.evaluate(()=>({rows:document.querySelector('.pt-youtube-caption')?.innerText, cc:document.querySelector('#cc')?.getAttribute('aria-pressed'),native:document.querySelector('.ytp-caption-window-container')?.textContent,notice:document.querySelector('#pt-notice')?.textContent})));
    throw new Error(`Expected ${mode} captions in ${frame.url()}`, { cause:error });
  });
}

async function checkCaptionPosition(frame, worker) {
  const box = frame.locator('.pt-youtube-caption');
  const native = frame.locator('.ytp-caption-window-container');
  const metrics = () => box.evaluate(el => {
    const player = document.querySelector('#movie_player').getBoundingClientRect();
    const bounds = el.getBoundingClientRect();
    const source = el.querySelector('.pt-caption-source').getBoundingClientRect();
    return { bottom: player.bottom - bounds.bottom, center: (bounds.left + bounds.right - player.left - player.right) / 2,
      sourceY: source.bottom - player.top };
  });
  const stable = (a, b, label) => assert.ok(Math.abs(a - b) < 1, label + ': ' + a + ' → ' + b);
  await worker.evaluate(() => { globalThis.captionGate = new Promise(resolve => { globalThis.finishCaption = resolve; }); });
  const before = await metrics();
  await native.evaluate(el => {
    el.style.cssText = 'position:absolute;bottom:70%;left:5%';
    el.querySelector('span').textContent = 'Delayed caption';
    document.querySelector('#movie_player').classList.toggle('ytp-autohide');
  });
  await frame.waitForFunction(() => document.querySelector('.pt-caption-source').textContent === 'Delayed caption');
  const pending = await metrics();
  stable(before.bottom, pending.bottom, 'Native captions moved');
  stable(before.center, pending.center, 'Caption center moved');
  await worker.evaluate(() => { globalThis.finishCaption(); delete globalThis.captionGate; delete globalThis.finishCaption; });
  await frame.waitForFunction(() => document.querySelector('.pt-caption-target').textContent.startsWith('这段译文'));
  const wrapped = await box.locator('.pt-caption-target').evaluate(row => {
    const range = document.createRange();
    range.selectNodeContents(row);
    // An explicit semantic line break produces an additional zero-width rect.
    return new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => rect.top)).size;
  });
  assert.equal(wrapped, 2, 'The delayed target must wrap onto a second line');
  const translated = await metrics();
  stable(pending.bottom, translated.bottom, 'Translation moved the anchor');
  stable(pending.center, translated.center, 'Late translation moved the horizontal center');
  await native.evaluate(el => {
    el.removeAttribute('style');
    el.replaceWith(el.cloneNode(true));
    document.querySelector('.ytp-caption-segment').textContent = 'First lesson';
  });
  await captionState(frame, 'dual', regularCue);
  stable(before.bottom, (await metrics()).bottom, 'Rebuilt captions moved the anchor');
  await frame.locator('#movie_player').evaluate(player => { player.style.height = '330px'; });
  const resized = await metrics();
  assert.ok(resized.bottom > before.bottom && resized.bottom < 45, 'The inset should adapt to player size');
  stable(0, resized.center, 'Resized player lost horizontal centering');
  await frame.locator('#movie_player').evaluate(player => player.style.removeProperty('height'));
  stable(before.bottom, (await metrics()).bottom, 'Returning to the original size changed the inset');
}

async function run() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'bingdu-embed-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', executablePath: process.env.CHROME_PATH, headless: true,
      viewport: { width:1200, height:880 },
      args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    context.setDefaultTimeout(8000);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await mockModel(worker);
    const pages = new Map([
      [course, '<!doctype html><meta charset="utf-8"><h1>A course with embedded videos</h1><main></main>'],
      [wrapper, '<!doctype html><style>body{margin:0}</style>' + embeddedFrame('nested', privateEmbed)],
      [regular, playerPage(regular, regularCue)], [privateEmbed, playerPage(privateEmbed, privateCue, false)],
      [edu, playerPage(edu, eduCue, false)],
      [nativeLesson, '<!doctype html><canvas width="64" height="36" hidden></canvas><video width="300" height="145" muted playsinline></video>'],
    ]);
    await context.route(/^https?:/, route => {
      const html = pages.get(route.request().url());
      return html ? route.fulfill({contentType:'text/html; charset=utf-8', body:html}) : route.abort();
    });
    const page = await context.newPage();
    await page.goto(course);
    const more = page.getByRole('button', { name:'并读 · 更多操作', exact:true });
    const float = page.getByRole('button', { name:'双语字幕', exact:true });
    await more.click();
    assert.equal(await float.isVisible(), false, 'The initial lesson has no YouTube player');
    const popup = await openExtensionControl(context, worker, 'popup.html');
    const panel = await openExtensionControl(context, worker, 'panel.html');
    await page.locator('main').evaluate((root, html) => root.insertAdjacentHTML('beforeend', html), embeddedFrame('regular', regular));
    const first = await getEmbedFrame(page, regular);
    if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
    await float.waitFor({ state:'visible' }).catch(error => {
      throw new Error('The host floating menu must recognize a lazily inserted cross-origin YouTube iframe', {cause:error});
    });
    await float.click();
    await captionState(first, 'dual', regularCue);
    await checkCaptionPosition(first, worker);

    await popup.getByRole('button', {name:'仅译文字幕', exact:true}).click();
    await captionState(first, 'only', regularCue);
    await panel.getByRole('button', {name:'关闭字幕翻译', exact:true}).click();
    await captionState(first, 'off', regularCue);
    assert.equal(await first.locator('.ytp-subtitles-button').getAttribute('aria-pressed'), 'true');

    await page.locator('main').evaluate((root, html) => root.insertAdjacentHTML('beforeend', html), embeddedFrame('wrapper', wrapper));
    const second = await getEmbedFrame(page, privateEmbed);
    assert.equal(second.parentFrame().url(), wrapper);
    // The course player builds its mobile CC button after streaming starts.
    // Hold that one DOM change until the extension has accepted the command.
    await second.locator('#cc').evaluate(button => {
      const parent = button.parentElement;
      button.remove();
      window.mountMobileControls = () => parent.append(button);
    });
    await second.getByRole('button', {name:'Play lesson'}).click();
    if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
    await float.click();
    await second.locator('.pt-youtube-caption').waitFor({state:'attached'});
    await second.evaluate(() => window.mountMobileControls());
    await captionState(second, 'dual', privateCue);
    await captionState(first, 'off', regularCue);

    const confined = second.getByRole('combobox', {name:'并读字幕', exact:true});
    await confined.selectOption('only');
    await captionState(second, 'only', privateCue);
    await captionState(first, 'off', regularCue);
    await second.locator('.ytp-caption-window-container').evaluate(native => native.replaceWith(native.cloneNode(true)));
    await captionState(second, 'only', privateCue);
    await confined.selectOption('off');
    await captionState(second, 'off', privateCue);

    // A second independent player can be enabled locally. The course-level off
    // action must then restore both native players, including the unfocused one.
    await first.getByRole('combobox', {name:'并读字幕', exact:true}).selectOption('dual');
    await confined.selectOption('dual');
    await captionState(first, 'dual', regularCue);
    await captionState(second, 'dual', privateCue);
    await panel.getByRole('button', {name:'关闭字幕翻译', exact:true}).click();
    await captionState(first, 'off', regularCue);
    await captionState(second, 'off', privateCue);
    await page.locator('#regular').evaluate(frame => frame.remove());
    await panel.getByRole('button', {name:'双语字幕', exact:true}).click();
    await captionState(second, 'dual', privateCue);
    await page.locator('#wrapper').evaluate(frame => frame.remove());
    if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
    await float.waitFor({state:'hidden'});
    await popup.getByRole('button', {name:'双语字幕', exact:true}).waitFor({state:'hidden'});
    await panel.getByRole('button', {name:'双语字幕', exact:true}).waitFor({state:'hidden'});
    await page.locator('main').evaluate((root, html) => root.insertAdjacentHTML('beforeend', html), embeddedFrame('education', edu));
    const third = await getEmbedFrame(page, edu);
    assert.equal(await third.locator('.ytp-subtitles-button').getAttribute('aria-pressed'), 'false');
    await popup.getByRole('button', {name:'双语字幕', exact:true}).click();
    await captionState(third, 'dual', eduCue);
    await panel.getByRole('button', {name:'关闭字幕翻译', exact:true}).click();
    await captionState(third, 'off', eduCue);
    await page.locator('#education').evaluate(frame => frame.remove());
    await popup.getByRole('button', {name:'双语字幕', exact:true}).waitFor({state:'hidden'});

    await page.locator('main').evaluate((root, html) => root.insertAdjacentHTML('beforeend', html), embeddedFrame('native', nativeLesson));
    const generic = page.frames().find(frame => frame.url() === nativeLesson) ||
      await page.waitForEvent('framenavigated', frame => frame.url() === nativeLesson);
    await generic.locator('video').waitFor();
    assert.equal(await popup.getByRole('button', {name:'双语字幕', exact:true}).isVisible(), false);
    // A local MediaStream advances actual Chromium TextTrack cues, without a
    // test video file or an overridden activeCues getter.
    const unseen = await generic.evaluate(async () => {
      const video = document.querySelector('video');
      const canvas = document.querySelector('canvas');
      const drawing = canvas.getContext('2d');
      video.srcObject = canvas.captureStream(10);
      let ticks = 0;
      const timer = setInterval(() => {
        drawing.fillStyle = ticks++ % 2 ? '#123' : '#345';
        drawing.fillRect(0, 0, canvas.width, canvas.height);
      }, 100);
      window.addEventListener('pagehide', () => clearInterval(timer), {once:true});
      const track = video.addTextTrack('subtitles', 'English', 'en');
      track.mode = 'showing';
      track.addCue(new VTTCue(0, 600, 'A native caption.'));
      const unseen = 'Une phrase ' + crypto.randomUUID();
      track.addCue(new VTTCue(600, 605, unseen));
      await video.play();
      return unseen;
    });
    await generic.waitForFunction(() => document.querySelector('video').textTracks[0].activeCues?.length === 1);
    await popup.getByRole('button', {name:'双语字幕', exact:true}).click();
    await generic.waitForFunction(() => document.querySelector('.pt-html5-caption')?.textContent === 'A native caption.\n译：A native caption.' &&
      document.querySelector('video').textTracks[0].mode === 'hidden');
    assert.ok(await worker.evaluate(text=>globalThis.captionBatches.some(batch=>
      batch.includes('A native caption.') && batch.includes(text)), unseen), 'A new native track uses the shared batch translator');
    await panel.getByRole('button', {name:'仅译文字幕', exact:true}).click();
    await generic.waitForFunction(() => document.querySelector('.pt-html5-caption')?.textContent === '译：A native caption.');
    await panel.getByRole('button', {name:'关闭字幕翻译', exact:true}).click();
    await generic.waitForFunction(() => !document.querySelector('.pt-html5-caption') &&
      document.querySelector('video').textTracks[0].mode === 'showing');
    console.log('Embedded captions passed (standard, privacy, education and native TextTrack players, host and local controls, isolation, removal and remount).');
  } finally {
    try { await context?.close(); } finally { await fs.rm(profile, {recursive:true, force:true}); }
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
