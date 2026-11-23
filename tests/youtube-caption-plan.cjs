const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const env = { location: {hostname:'www.youtube.com'}, setTimeout };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'subtitle-semantics.js'), 'utf8'), env);
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'youtube-caption-plan.js'), 'utf8'), env);
const { configureWindows, prepare, atTime, chineseLines } = env.bingduYoutubeCaptionPlan;

async function readTimedWords(words) {
  let observe;
  const location = new URL('https://www.youtube.com/watch?v=fixture');
  const events = [{tStartMs:0,dDurationMs:words.at(-1).at + 900,
    segs:words.map(({text,at})=>({utf8:' ' + text,tOffsetMs:at}))}];
  const track = {location,URL,AbortController,TextDecoder,performance,setTimeout,clearTimeout,
    fetch:async()=>new Response(JSON.stringify({events})),
    PerformanceObserver:class { constructor(callback) { observe=callback; } observe(){} }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'youtube-caption-track.js'), 'utf8'),track);
  const result = new Promise(resolve=>track.bingduYoutubeTrackHints('fixture',(cues,info)=>{
    if (cues.length) {assert.ok(info.segmented);resolve(cues);}
  }));
  observe({getEntries:()=>[{name:location.origin+'/api/timedtext?v=fixture&kind=asr&lang=en',startTime:1}]});
  return result;
}

async function run() {
  const first = 'We want to change how we think about tools';
  const second = 'so that we can learn how to think with them.';
  const speech = (first+' '+second).split(' ').map((text,i) => ({text,at:i*220 + (i>=9?680:0) + (i>=18?680:0)}));
  const fixed = await readTimedWords(speech);
  assert.deepEqual(Array.from(fixed,c=>c.text),[first,second], 'A brief final word stays with its phrase');
  assert.equal(fixed[1].start,speech[9].at/1000);
  const before = JSON.stringify(fixed.map(({start,end,text})=>[start,end,text]));
  const translations = await prepare(fixed, async (texts, options)=>{
    assert.equal(options.purpose,'subtitle');
    assert.deepEqual(Array.from(texts),[first,second]);
    return ['先换个角度看工具，','才能学会借助工具思考。'];
  },{title:'',currentTime:0,cancelled:()=>false,progress(){}});
  assert.equal(JSON.stringify(translations.map(({start,end,text})=>[start,end,text])),before);
  const unpunctuated = await readTimedWords([
    {text:'Come',at:0},{text:'closer',at:250},{text:'>>',at:600},{text:'What',at:720},
    {text:'happened',at:880},{text:'Wait',at:2900},{text:'here',at:3200}]);
  assert.deepEqual(Array.from(unpunctuated,c=>c.text),['Come closer','>> What happened','Wait here']);
  const zh = '先了解第一种方法，再练习第二种方法。';
  assert.equal(chineseLines(zh, text=>text.length, 13, 10), '先了解第一种方法，\n再练习第二种方法。');
  assert.ok(!chineseLines('这个过程预计需要12分钟才能完成。', text=>text.length, 12, 8).includes('12\n分钟'));
  const cards = [
    {start:0, end:1, text:'Hi.'}, {start:1.2, end:3.4, text:'>> Welcome.'},
    {start:4, end:4.4, text:'Ready?'}, {start:10, end:16, text:'Continue.'}
  ];
  cards[2].translation = '这句有很多字需要时间读完';
  configureWindows(cards, true, 1, 20);
  assert.equal(cards[0].displayEnd, 1.2, 'Never borrow the start of the next line');
  assert.equal(cards[2].displayEnd, 4.9, 'A long pause permits at most half a second of extension');
  assert.equal(atTime(cards, 1.2)[0].text, '>> Welcome.');
  assert.equal(atTime(cards, 5).length, 0);

  const overlapping = [{start:0,end:4,text:'A'},{start:1,end:2,text:'B'}];
  configureWindows(overlapping, false, 1, 4);
  assert.equal(atTime(overlapping, 1.3).length, 2, 'Keep simultaneous authored cues');
  assert.equal(atTime(overlapping, 3.5)[0].text, 'A');

  const longTrack = Array.from({length:70}, (_, i) => ({start:i, end:i+1, text:String(i)}));
  let cancelled = false, calls = 0;
  const gates = [];
  const preparing = prepare(longTrack, texts => {
    calls++;
    return new Promise(resolve => gates.push(() => resolve(texts)));
  }, {title:'', currentTime:0, cancelled:()=>cancelled, progress:()=>assert.fail('Cancelled results must not be published')});
  assert.equal(calls, 2);
  cancelled = true;
  gates.forEach(release => release());
  await preparing;
  assert.equal(calls, 2, 'Closing the session stops all further batches');
  assert.ok(longTrack.every(cue => cue.translation === undefined));
  const {alignHuman} = env.bingduSubtitleSemantics;
  const timed = speech.map(w=>({text:w.text,start:w.at/1000}));
  const full = [{start:timed[0].start,end:fixed.at(-1).end,text:first+' '+second,words:timed}];
  const paired = alignHuman(full,[
    {start:0,end:timed[9].start,text:'我们想改变看待 AI 的方式。'},
    {start:timed[9].start,end:full[0].end,text:'这样才能和 AI 一起思考。'}]);
  assert.equal(paired.length,2); assert.equal(paired[1].start,timed[9].start);
  assert.equal(alignHuman(full,[{start:0,end:.5,text:'缺少后半段'}]),null);
  const one = alignHuman([{start:1,end:4,text:'First and second.'}],
    [{start:1,end:2.5,text:'第一项。'},{start:2.5,end:4,text:'第二项。'}]);
  assert.equal(one.length,1); assert.equal(one[0].translation,'第一项。\n第二项。');
  console.log('Caption preparation, timing bounds, speaker boundaries and cancellation passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
