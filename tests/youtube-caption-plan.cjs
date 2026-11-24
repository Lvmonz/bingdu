const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const env = { setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'subtitle-semantics.js'), 'utf8'), env);
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'caption-timeline.js'), 'utf8'), env);
const { indexCards, createSession, atTime, chineseLines } = env.bingduCaptionTimeline;

async function readTimedWords(words, lang = 'en', spaced = true, expectSegmented = true) {
  let observe;
  const location = new URL('https://www.youtube.com/watch?v=fixture');
  const events = [{tStartMs:0,dDurationMs:words.at(-1).at + 900,
    segs:words.map(({text,at})=>({utf8:(spaced ? ' ' : '') + text,tOffsetMs:at,acAsrConf:0}))}];
  const track = {location,URL,AbortController,TextDecoder,performance,setTimeout,clearTimeout,
    fetch:async()=>new Response(JSON.stringify({events})),
    PerformanceObserver:class { constructor(callback) { observe=callback; } observe(){} }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'youtube-caption-track.js'), 'utf8'),track);
  const result = new Promise(resolve=>track.bingduYoutubeTrackHints('fixture',(cues,info)=>{
    if (cues.length) {assert.equal(!!info.segmented,expectSegmented);resolve(cues);}
  }));
  observe({getEntries:()=>[{name:location.origin+'/api/timedtext?v=fixture&lang='+lang,startTime:1}]});
  return result;
}

async function run() {
  const first = 'We want to change how we think about tools';
  const second = 'so that we can learn how to think with them.';
  const speech = (first+' '+second).split(' ').map((text,i) => ({text,at:i*220 + (i>=9?680:0) + (i>=18?680:0)}));
  const fixed = await readTimedWords(speech);
  assert.equal(Array.from(fixed,c=>c.text).join(' '), first+' '+second);
  assert.ok(fixed.every((c,i)=>c.end>c.start && (!i || fixed[i-1].end <= c.start)));
  const japanese = await readTimedWords([{text:'鳥が',at:0},{text:'飛んだ。',at:500},
    {text:'雨が',at:1200},{text:'降った。',at:1600}], 'ja', false);
  assert.deepEqual(Array.from(japanese,c=>c.text), ['鳥が飛んだ。','雨が降った。']);
  const spanish = await readTimedWords([{text:'¿Quién',at:0},{text:'viene?',at:400},
    {text:'Una',at:800},{text:'amiga.',at:1100}],'es');
  assert.deepEqual(Array.from(spanish,c=>c.text), ['¿Quién viene?','Una amiga.']);
  const unpunctuated = await readTimedWords([
    {text:'Come',at:0},{text:'closer',at:250},{text:'>>',at:600},{text:'What',at:720},
    {text:'happened',at:880},{text:'Wait',at:2900},{text:'here',at:3200}]);
  assert.deepEqual(Array.from(unpunctuated,c=>c.text),['Come closer','>> What happened','Wait here']);
  const fastWords = Array.from({length:75},(_,i)=>({text:'word'+i, at:i*110}));
  const fast = await readTimedWords(fastWords);
  assert.equal(Array.from(fast,c=>c.text).join(' '), fastWords.map(w=>w.text).join(' '));
  assert.ok(fast.every(c => c.words.length <= 19 && c.end > c.start));
  const phrases = await readTimedWords([{text:'Carry these boxes',at:0},{text:'over the bridge.',at:1800}], 'en', true, false);
  assert.deepEqual(Array.from(phrases, c=>[c.start,c.end,c.text]), [[0,2.7,'Carry these boxes over the bridge.']]);
  const zh = '先了解第一种方法，再练习第二种方法。';
  assert.equal(chineseLines(zh, text=>text.length, 13, 10), '先了解第一种方法，\n再练习第二种方法。');
  assert.ok(!chineseLines('这个过程预计需要12分钟才能完成。', text=>text.length, 12, 8).includes('12\n分钟'));
  const cards = [
    {start:0, end:1, text:'Hi.'}, {start:1.2, end:3.4, text:'>> Welcome.'},
    {start:4, end:4.4, text:'Ready?'}, {start:10, end:16, text:'Continue.'}
  ];
  cards[2].translation = '这句有很多字需要时间读完';
  indexCards(cards);
  assert.equal(atTime(cards, 1).length,0);
  assert.equal(atTime(cards, 1.2)[0].text, '>> Welcome.');
  assert.equal(atTime(cards, 5).length, 0);
  const overlapping = [{start:0,end:4,text:'A'},{start:1,end:2,text:'B'}];
  indexCards(overlapping);
  assert.equal(atTime(overlapping, 1.3).length, 2);
  assert.equal(atTime(overlapping, 3.5)[0].text, 'A');

  const longTrack = Array.from({length:70}, (_, i) => ({start:i, end:i+1, text:String(i)}));
  const gates = [], calls = [];
  let paints = 0;
  const session = createSession(longTrack, (texts, options) => {
    assert.equal(options.purpose, 'subtitle');
    calls.push(Array.from(texts,Number));
    return new Promise(resolve => gates.push(() => resolve(texts.map(t=>'訳'+t))));
  }, {title:'', repaint(){paints++;}, onError:assert.fail});
  session.update(0);
  assert.deepEqual(calls.map(batch=>[batch[0],batch.at(-1)]), [[0,7],[8,15]]);
  session.update(68.4);
  gates.shift()();
  await new Promise(setImmediate);
  assert.deepEqual(calls[2],[68,69]);
  gates.pop()();
  await new Promise(setImmediate);
  assert.equal(atTime(longTrack,68.4)[0].translation, '訳68');
  session.update(0);
  assert.equal(calls.length,3);
  session.close();
  gates.shift()();
  await new Promise(setImmediate);
  assert.equal(paints,2);
  assert.equal(longTrack[8].translation,undefined);
  const {alignHuman} = env.bingduSubtitleSemantics;
  const timed = speech.map(w=>({text:w.text,start:w.at/1000}));
  const full = [{start:timed[0].start,end:timed.at(-1).start + .9,text:first+' '+second,words:timed}];
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
