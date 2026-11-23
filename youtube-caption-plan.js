(() => {
  if (!/(^|\.)youtube(?:-nocookie|education)?\.com$/.test(location.hostname)) return;

  const screenChars = 72;
  function splitEnglish(cue) {
    if (cue.text.length <= screenChars || cue.end - cue.start < 3.6) return [cue];
    const tokens = cue.words || cue.text.trim().split(/\s+/).map(text => ({ text }));
    if (tokens.length < 6) return [cue];
    const offsets = [0];
    for (const token of tokens) offsets.push(offsets.at(-1) + token.text.length + 1);
    const starts = tokens.map((token, i) => token.start ??
      cue.start + (cue.end - cue.start) * offsets[i] / offsets.at(-1));
    starts.push(cue.end);
    // Choose all breaks together so a pleasant first card cannot orphan the last word.
    const costs = Array(tokens.length + 1).fill(Infinity), back = [];
    costs[0] = 0;
    for (let end = 1; end <= tokens.length; end++) {
      const left = tokens[end - 1].text, right = tokens[end]?.text || '';
      let breakCost = 0;
      if (right) {
        breakCost = 65;
        if (/^(and|but|because|while|although|which|where|when|that|so)$/i.test(right)) breakCost = 0;
        if (/[,;:.!?][)"’”]*$/.test(left)) breakCost = -65;
        if (/^(?:for|with|without|instead|about)$/i.test(right)) breakCost = 12;
        if (/^(a|an|the|to|of|for|and|or|my|your|our|this|that|is|are|not)$/i.test(left) ||
            (/^\p{Lu}/u.test(left) && /^\p{Lu}/u.test(right)) || (/\d$/.test(left) && /^\w/.test(right))) breakCost += 250;
        if (/^(?:treat|make|keep|using|doing|have|feel|include)$/i.test(left)) breakCost += 100;
        if (/^(?:so that|not just|not only|as well|such as|rather than|even though)$/i.test(left + ' ' + right) ||
            /^(?:not just|not only)$/i.test((tokens[end - 2]?.text || '') + ' ' + left)) breakCost += 500;
      }
      for (let start = end - 1; start >= 0; start--) {
        const length = offsets[end] - offsets[start] - 1;
        if (length > 2 * screenChars && start < end - 1) break;
        if (!Number.isFinite(costs[start]) || starts[end] - starts[start] < 1.8 || end - start < 3) continue;
        const cost = costs[start] + 70 + breakCost + (length - 54) ** 2 * 0.09 +
          Math.max(0, length - screenChars) ** 2 * 5;
        if (cost < costs[end]) { costs[end] = cost; back[end] = start; }
      }
    }
    if (!Number.isFinite(costs.at(-1)) || back[tokens.length] === 0) return [cue];
    const parts = [];
    for (let end = tokens.length; end > 0;) {
      const start = back[end];
      parts.push({ start:starts[start], end:starts[end], text:tokens.slice(start, end).map(t => t.text).join(' ') });
      end = start;
    }
    return parts.reverse();
  }

  function makeCards(cues, automaticSentences, english = automaticSentences) {
    const cards = [];
    for (let i = 0; i < cues.length; i++) {
      const cue = { ...cues[i] };
      // Recover a continuous utterance when the parser's safety limit made
      // an intermediate cut. Its internal word onsets are still authoritative.
      while (automaticSentences && cue.continues && !/[,;:.!?][)"’”]*$/.test(cue.text) && cue.words && cues[i+1]?.words &&
          cues[i+1].start >= cue.end && cues[i+1].start - cue.end < 0.05 &&
          cue.text.length + cues[i+1].text.length < 360) {
        const tail = cues[++i];
        cue.words = cue.words.concat(tail.words);
        cue.text += ' ' + tail.text;
        cue.end = tail.end;
        cue.continues = tail.continues;
      }
      const next = cues[i + 1];
      if (automaticSentences && next && cue.end - cue.start < 1.5 &&
          next.start >= cue.end && next.start - cue.end <= 0.25 && next.end - cue.start <= 6 &&
          cue.text.length + next.text.length + 1 <= screenChars && !/^(?:>>|[-–—]|\[|\p{Lu}[\p{L} ]{0,20}:)/u.test(next.text)) {
        cue.text += ' ' + next.text;
        cue.end = next.end;
        if (cue.words && next.words) cue.words = cue.words.concat(next.words);
        cue.continues = next.continues;
        i++;
      }
      if (english) cards.push(...splitEnglish(cue));
      else cards.push(cue);
    }
    return cards;
  }

  function configureWindows(cards, chinese, rate, videoDuration) {
    let latestEnd = 0;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const limit = Math.min(card.end + 0.5, cards[i + 1]?.start ?? Infinity,
        Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : Infinity);
      const windowEnd = Math.max(card.end, limit);
      const seconds = (windowEnd - card.start) / rate;
      card.budget = chinese ? Math.max(1, Math.min(26, Math.floor(seconds * 7))) : null;
      const characters = [...(card.translation || '').replace(/\s/g, '')].length;
      const readingSeconds = Math.max(1.5, chinese ? characters / 7 : 0);
      card.displayEnd = Math.max(card.end, Math.min(windowEnd, card.start + readingSeconds * rate));
      latestEnd = Math.max(latestEnd, card.displayEnd);
      card.latestEnd = latestEnd;
    }
  }

  function atTime(cards, time) {
    let low = 0, high = cards.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (cards[middle].start <= time) low = middle + 1;
      else high = middle;
    }
    const visible = [];
    for (let i = low - 1; i >= 0 && cards[i].latestEnd > time; i--) {
      if (cards[i].displayEnd > time) visible.push(cards[i]);
    }
    return visible.reverse();
  }

  const chineseWords = new Intl.Segmenter('zh', { granularity:'word' });
  function lineCount(text, measure, available) {
    let count = 0;
    for (const paragraph of text.split('\n')) {
      count++;
      if (measure(paragraph) <= available) continue;
      const pieces = /\p{Script=Han}/u.test(paragraph)
        ? Array.from(chineseWords.segment(paragraph), part => part.segment)
        : paragraph.match(/\S+|\s+/gu) || [];
      let line = '';
      for (const piece of pieces) {
        if (line.trim() && piece.trim() && measure((line + piece).trimEnd()) > available) {
          count++;
          line = '';
        }
        if (measure(piece) > available) {
          for (const char of piece) {
            if (line && measure(line + char) > available) { count++; line = ''; }
            line += char;
          }
        } else line += piece;
      }
    }
    return count;
  }

  function chineseLines(value, measure, available, preferred) {
    const lines = value.trim().split(/\s*\n\s*/u);
    const text = lines.reduce((joined, line) =>
      joined + (/[a-z0-9]$/i.test(joined) && /^[a-z0-9]/i.test(line) ? ' ' : '') + line, '');
    if (!text || measure(text) <= Math.min(available, preferred)) return text;
    const hints = new Set();
    let from = 0;
    for (const line of lines.slice(1)) {
      from = text.indexOf(line, from + 1);
      if (from >= 0) hints.add(from);
    }
    let best = text, bestScore = Infinity;
    for (const {index} of chineseWords.segment(text)) {
      const a = text.slice(0, index).trimEnd(), b = text.slice(index).trimStart();
      if (!a || !b || /[「『（《【“(]$/.test(a) || /^[，。？！：；、）》】”」』.,!?]/.test(b)) continue;
      if (/\d(?:\.\d+)?$/.test(a) && /^(?:[%％‰年月日时分秒倍次个项公里厘米千克]|cm\b|kg\b)/i.test(b)) continue;
      const w1 = measure(a), w2 = measure(b);
      if (Math.max(w1,w2) > available) continue;
      let score = Math.abs(w1-w2) / Math.max(1, preferred);
      if (hints.has(index)) score -= 1.8;
      if (/[，。？！；：、,.!?]$/.test(a) || /^(?:因为|所以|但是|如果|而且|同时|才能|也就|以及)/.test(b)) score -= 1.1;
      if (/^(?:的|了|着|吗|呢|们|地|得)/.test(b) || /(?:的|与|把|在|将|向|不|第|每|为)$/.test(a)) score += 2;
      if (Math.min(w1,w2) < Math.max(w1,w2) * 0.28) score += 2;
      if (score < bestScore) { bestScore = score; best = a + '\n' + b; }
    }
    return best;
  }

  async function prepare(cards, translate, { title, currentTime, cancelled, progress, semantic = false, rate = 1 }) {
    const languagePlan = globalThis.bingduSubtitleSemantics;
    const mapped = new Map();
    const batches = [];
    const maxItems = semantic ? 8 : 16;
    const maxChars = semantic ? 1000 : 2400;
    for (let i = 0; i < cards.length;) {
      const from = i;
      let chars = 0;
      while (i < cards.length && i - from < maxItems && (i === from || chars + cards[i].text.length <= maxChars)) {
        chars += cards[i++].text.length;
      }
      batches.push([from, i]);
    }
    // Feed the current part first. Browsers can run two translation requests
    // concurrently while each contiguous batch supplies its own context.
    const first = batches.findIndex(([, end]) => cards[end - 1].end >= currentTime);
    const ordered = batches.slice(Math.max(first, 0)).concat(batches.slice(0, Math.max(first, 0)));
    let cursor = 0, done = 0, failed = false;
    async function run() {
      while (!failed && !cancelled() && cursor < ordered.length) {
        const [from, to] = ordered[cursor++];
        const slice = cards.slice(from, to);
        const options = { purpose: 'subtitle', budgets: slice.map(card => card.budget),
          context: { title, before: cards[from - 1]?.text || '', after: cards[to]?.text || '' } };
        try {
          const texts = slice.map(card => card.text);
          if (semantic) {
            options.purpose = 'subtitle-semantics';
            options.wordTiming = slice.map(languagePlan.encode);
            options.playbackRate = rate;
          }
          let response;
          try { response = await translate(texts, options); }
          catch (error) {
            if (!/429|5\d\d|timeout|timed out|failed to fetch|network/i.test(error.message)) throw error;
            await new Promise(resolve => setTimeout(resolve, 1500));
            if (cancelled() || failed) return;
            response = await translate(texts, options);
          }
          if (cancelled() || failed) return;
          if (semantic) {
            const fallback = [];
            for (const [j,unit] of slice.entries()) {
              const screens = response?.[j];
              if (languagePlan.validScreens(options.wordTiming[j], screens)) {
                mapped.set(unit, languagePlan.mapScreens(unit, screens));
              } else {
                // Keep a readable utterance intact if the service gave unusable indices.
                const parts = unit.text.length <= 145 && unit.end-unit.start <= 10 ? [{...unit}] : splitEnglish(unit);
                mapped.set(unit, parts);
                fallback.push(...parts);
              }
            }
            if (fallback.length) {
              configureWindows(fallback, true, rate, Infinity);
              await prepare(fallback, translate, {title,currentTime,cancelled:()=>failed || cancelled(),progress:()=>{}});
              if (cancelled() || failed) return;
            }
          } else {
            if (!Array.isArray(response) || response.length !== slice.length ||
              response.some(value => typeof value !== 'string' || !value.trim())) throw Error('部分字幕缺少译文');
            slice.forEach((card, j) => { card.translation = response[j]; });
          }
          done += slice.length;
          progress(done);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }
    await Promise.all([run(), run()]);
    if (!cancelled()) return semantic ? cards.flatMap(unit => mapped.get(unit)) : cards;
  }

  globalThis.bingduYoutubeCaptionPlan = { makeCards, configureWindows, prepare, atTime, chineseLines, lineCount };
})();
