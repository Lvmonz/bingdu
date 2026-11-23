(() => {
  if (!/(^|\.)youtube(?:-nocookie|education)?\.com$/.test(location.hostname)) return;

  // Use the source clock for cue starts. A short automatic caption may share
  // its neighbour's card when there is continuous speech and no speaker marker.
  function makeCards(cues, automaticSentences) {
    const cards = [];
    for (let i = 0; i < cues.length; i++) {
      const cue = { ...cues[i] };
      const next = cues[i + 1];
      if (automaticSentences && next && cue.end - cue.start < 1.5 &&
          next.start >= cue.end && next.start - cue.end <= 0.25 && next.end - cue.start <= 6 &&
          cue.text.length + next.text.length <= 100 && !/^(?:>>|[-–—]|\[|\p{Lu}[\p{L} ]{0,20}:)/u.test(next.text)) {
        cue.text += ' ' + next.text;
        cue.end = next.end;
        i++;
      }
      cards.push(cue);
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
      card.budget = chinese ? Math.max(1, Math.min(32, Math.floor(seconds * 7))) : null;
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
  }

  globalThis.bingduYoutubeCaptionPlan = { makeCards, configureWindows, prepare, atTime };
})();
