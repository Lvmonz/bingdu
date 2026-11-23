(() => {
  // Align authored target cues with source speech in chronological order. Use the
  // best overlap, or group multiple target cues if they share one indivisible source cue.
  function alignHuman(cues, target) {
    if (!target?.length || !cues.length || target.some((c,i) => !c.text || !(c.end > c.start) ||
        i && c.start < target[i-1].end - 0.005)) return null;
    const groups = [];
    let cursor = 0, lastTarget = -1;
    for (const cue of cues) {
      const tokens = cue.words?.length ? cue.words : [{text:cue.text, start:cue.start}];
      for (let i = 0; i < tokens.length; i++) {
        const {start,text} = tokens[i], end = tokens[i+1]?.start ?? cue.end;
        while (cursor < target.length && target[cursor].end <= start) cursor++;
        let best = -1, overlap = 0, first = -1, last = -1;
        for (let j=cursor; j<target.length && target[j].start < end; j++) {
          const shared = Math.min(end,target[j].end) - Math.max(start,target[j].start);
          if (shared > 0) { if (first < 0) first = j; last = j; }
          if (shared > overlap) { best=j; overlap=shared; }
        }
        if (best < 0 || overlap < Math.min(.15, (end-start)*.4)) return null;
        if (tokens.length > 1) first = last = best;
        if (first < lastTarget && last !== lastTarget || first > lastTarget + 1) return null;
        const g = groups.at(-1);
        if (g && first <= g.last) {
          g.text += ' ' + text;
          g.end = Math.max(end, g.end);
          g.last = Math.max(g.last,last);
        } else groups.push({first,last,start,end,text});
        lastTarget = last;
      }
    }
    if (lastTarget !== target.length-1) return null;
    const paired = groups.map(({first,last,start,end,text}) => ({start,end,text,
      translation:target.slice(first,last+1).map(c => c.text).join('\n')}));
    return paired.some(c => c.end-c.start > 12 || c.text.length > 160 || c.translation.length > 56) ? null : paired;
  }

  globalThis.bingduSubtitleSemantics = {alignHuman};
})();
