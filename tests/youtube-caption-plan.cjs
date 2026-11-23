const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const env = { location: {hostname:'www.youtube.com'}, setTimeout };
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
  console.log('Caption preparation, timing bounds, speaker boundaries and cancellation passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
