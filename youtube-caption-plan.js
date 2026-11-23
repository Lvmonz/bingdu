(() => {
  if (!/(^|\.)youtube(?:-nocookie|education)?\.com$/.test(location.hostname)) return;

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

  async function prepare(cards, translate, { title, currentTime, cancelled, progress }) {
    const batches = [];
    for (let i = 0; i < cards.length;) {
      const from = i;
      let chars = 0;
      while (i < cards.length && i - from < 16 && (i === from || chars + cards[i].text.length <= 2400)) {
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
          let response;
          try { response = await translate(texts, options); }
          catch (error) {
            if (!/429|5\d\d|timeout|timed out|failed to fetch|network/i.test(error.message)) throw error;
            await new Promise(resolve => setTimeout(resolve, 1500));
            if (cancelled() || failed) return;
            response = await translate(texts, options);
          }
          if (cancelled() || failed) return;
          if (!Array.isArray(response) || response.length !== slice.length ||
              response.some(value => typeof value !== 'string' || !value.trim())) throw Error('部分字幕缺少译文');
          slice.forEach((card, j) => { card.translation = response[j]; });
          done += slice.length;
          progress(done);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }
    await Promise.all([run(), run()]);
    return cards;
  }

  globalThis.bingduYoutubeCaptionPlan = { configureWindows, prepare, atTime, chineseLines, lineCount };
})();
