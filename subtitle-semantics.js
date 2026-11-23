// Word indices refer to timestamped source tokens; some ASR tokens contain a phrase.
(() => {
  function utterances(cues) {
    const units = [];
    for (const cue of cues) {
      const previous = units.at(-1);
      if (previous?.continues && previous.words && cue.words &&
          Math.abs(cue.start - previous.end) < 0.05 &&
          previous.words.length + cue.words.length <= 120 && previous.text.length + cue.text.length <= 720) {
        previous.words = previous.words.concat(cue.words);
        previous.text += ' ' + cue.text;
        previous.end = cue.end;
        previous.continues = cue.continues;
      } else units.push({ ...cue });
    }
    return units;
  }

  function encode(unit) {
    return { duration: Math.round((unit.end - unit.start) * 1000),
      words: unit.words.map(({text, start}, i) => [i + 1, text, Math.round((start - unit.start) * 1000)]) };
  }

  function validInput(text, spec) {
    return Number.isInteger(spec?.duration) && spec.duration > 0 && spec.duration <= 120000 &&
      Array.isArray(spec.words) && spec.words.length > 0 && spec.words.length <= 160 &&
      spec.words.every((word, i, words) => Array.isArray(word) && word.length === 3 && word[0] === i+1 &&
        typeof word[1] === 'string' && word[1].trim() && Number.isInteger(word[2]) &&
        (i ? word[2] > words[i-1][2] : word[2] === 0) && word[2] < spec.duration) &&
      spec.words.map(word => word[1]).join(' ') === text;
  }

  function unfinished(left, right) {
    if (/[.!?;:]$/.test(left)) return false;
    const tail = left.toLowerCase().replace(/[,–—]$/, '');
    if (/\b(?:a|an|the|of|with|between|for|to|and|or|because|not only)$/.test(tail)) return true;
    if (/^and\b/i.test(right) && /\bbetween\b(?:(?!\band\b).)*$/.test(tail)) return true;
    return /^for\b/i.test(right) && /\b(?:responsibility|responsible|accountability|accountable)$/.test(tail);
  }

  function validScreens(spec, screens) {
    if (!Array.isArray(screens) || !screens.length || screens.length > spec.words.length) return false;
    let from = 0;
    for (const screen of screens) {
      if (!screen || screen.first !== from+1 || !Number.isInteger(screen.last) ||
          screen.last <= from || screen.last > spec.words.length ||
          typeof screen.translation !== 'string' || !screen.translation.trim()) return false;
      const ms = (spec.words[screen.last]?.[2] ?? spec.duration) - spec.words[from][2];
      const count = [...screen.translation.replace(/\s/g, '')].length;
      // Prevent flashes and paragraphs. A whole, genuinely short utterance may stay short.
      const english = spec.words.slice(from, screen.last).map(w => w[1]).join(' ');
      const next = spec.words[screen.last]?.[1];
      if (next && unfinished(english,next)) return false;
      if (screens.length > 1 && (ms < 1500 || screen.last - from < 2) ||
          count > Math.max(12, Math.min(48, Math.ceil(ms * .010))) ||
          english.length > 145 && screen.last-from > 1) return false;
      from = screen.last;
    }
    return from === spec.words.length;
  }

  function mapScreens(unit, screens) {
    return screens.map(({first,last,translation}) => ({
      start: unit.words[first-1].start, end: unit.words[last]?.start ?? unit.end,
      text: unit.words.slice(first-1,last).map(w => w.text).join(' '), translation: translation.trim()
    }));
  }

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
    return groups.map(({first,last,start,end,text}) => ({start,end,text,
      translation:target.slice(first,last+1).map(c => c.text).join('\n')}));
  }

  globalThis.bingduSubtitleSemantics = {utterances,encode,validInput,validScreens,mapScreens,alignHuman};
})();
