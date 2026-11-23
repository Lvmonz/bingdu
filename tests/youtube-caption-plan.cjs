const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const env = { location: {hostname:'www.youtube.com'}, setTimeout };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'subtitle-semantics.js'), 'utf8'), env);
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'youtube-caption-plan.js'), 'utf8'), env);
const { makeCards, configureWindows, prepare, atTime, chineseLines } = env.bingduYoutubeCaptionPlan;

async function run() {
  const sentence = 'We now understand the first approach, but the second approach needs a little more practice.';
  const words = sentence.split(' ').map((text, i) => ({ text, start:5+i*0.4 }));
  const parts = makeCards([{start:5, end:12, text:sentence, words}], true);
  assert.ok(parts.length > 1);
  assert.equal(Array.from(parts, cue => cue.text).join(' '), sentence);
  for (const [i, cue] of parts.entries()) {
    assert.ok(words.some(word => word.start === cue.start));
    assert.ok(cue.end - cue.start >= 1.8);
    if (i) assert.equal(cue.start, parts[i-1].end);
  }
  const zh = '先了解第一种方法，再练习第二种方法。';
  assert.equal(chineseLines(zh, text=>text.length, 13, 10), '先了解第一种方法，\n再练习第二种方法。');
  assert.ok(!chineseLines('这个过程预计需要12分钟才能完成。', text=>text.length, 12, 8).includes('12\n分钟'));
  const original = [
    {start:0, end:1, text:'Hi.'}, {start:1.2, end:3.4, text:'>> Welcome.'},
    {start:4, end:4.4, text:'Ready?'}, {start:10, end:16, text:'Continue.'}
  ];
  const cards = makeCards(original, true);
  assert.equal(cards.length, 4, 'Do not combine speaker changes or a long pause');
  cards[2].translation = '这句有很多字需要时间读完';
  configureWindows(cards, true, 1, 20);
  assert.equal(cards[0].displayEnd, 1.2, 'Never borrow the start of the next line');
  assert.equal(cards[2].displayEnd, 4.9, 'A long pause permits at most half a second of extension');
  assert.equal(atTime(cards, 1.2)[0].text, '>> Welcome.');
  assert.equal(atTime(cards, 5).length, 0);

  const overlapping = makeCards([{start:0,end:4,text:'A'},{start:1,end:2,text:'B'}], false);
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
  const {utterances,encode,validInput,validScreens,alignHuman} = env.bingduSubtitleSemantics;
  const terms = 'We want to change how we think about AI so that we can learn how to think with AI.'.split(' ');
  const timed = terms.map((text,i) => ({text,start:101+i*.38}));
  const unit = (words,end,continues) => ({start:words[0].start,end,text:words.map(w=>w.text).join(' '),words,continues});
  const full = utterances([unit(timed.slice(0,9),timed[9].start,true),unit(timed.slice(9),108,false)]);
  assert.equal(full.length,1);
  const spec = encode(full[0]);
  assert.ok(validInput(full[0].text,spec));
  const good = [{first:1,last:9,translation:'我们想改变看待 AI 的方式。'},{first:10,last:19,translation:'这样才能学会和 AI 一起思考。'}];
  assert.ok(validScreens(spec,good));
  for (const bad of [
    [good[1]], [{...good[0],last:8},good[1]], [good[0],{...good[1],first:9}],
    [good[0],{...good[1],last:18}], [{...good[0],last:18},{...good[1],first:19}],
    [good[0],{...good[1],translation:' '}]
  ]) assert.equal(validScreens(spec,bad),false);
  const comparison = 'There is a gap between what tools can do and what people feel comfortable doing.'.split(' ');
  const pair = encode(unit(comparison.map((text,i) => ({text,start:i*.5})),8,false));
  assert.equal(validScreens(pair,[{first:1,last:5,translation:'有一道差距。'},
    {first:6,last:15,translation:'工具的能力和人能熟练使用的功能之间。'}]),false);
  assert.ok(validScreens(pair,[{first:1,last:15,translation:'工具能做到的事和人能熟练使用的功能之间有差距。'}]));
  const opts = {title:'',currentTime:104,semantic:true,cancelled:()=>false,progress(){}};
  const actual = await prepare(full,async (texts,options) => {
    assert.equal(options.purpose,'subtitle-semantics');
    assert.equal(texts[0],terms.join(' ')); return [good];
  },opts);
  assert.equal(actual[1].start,timed[9].start);
  assert.equal(actual[1].end,108);
  assert.equal(Array.from(actual,c=>c.text).join(' '),terms.join(' '));
  let callsForFallback = 0;
  const recovered = await prepare(full,async (texts,options) => {
    callsForFallback++; return options.purpose === 'subtitle' ? texts.map(()=> '整句译文') : [null];
  },opts);
  assert.equal(callsForFallback,2);
  assert.equal(recovered[0].text,terms.join(' '));
  const paired = alignHuman(full,[
    {start:101,end:timed[9].start,text:'我们想改变看待 AI 的方式。'},
    {start:timed[9].start,end:108,text:'这样才能和 AI 一起思考。'}]);
  assert.equal(paired.length,2); assert.equal(paired[1].start,timed[9].start);
  assert.equal(alignHuman(full,[{start:101,end:103,text:'缺少后半段'}]),null);
  const one = alignHuman([{start:1,end:4,text:'First and second.'}],
    [{start:1,end:2.5,text:'第一项。'},{start:2.5,end:4,text:'第二项。'}]);
  assert.equal(one.length,1); assert.equal(one[0].translation,'第一项。\n第二项。');
  console.log('Caption preparation, timing bounds, speaker boundaries and cancellation passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
