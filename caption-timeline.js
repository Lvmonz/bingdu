(() => {
  function indexCards(cards) {
    let latestEnd = 0;
    for (const card of cards) {
      latestEnd = Math.max(latestEnd, card.end);
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
      if (cards[i].end > time) visible.push(cards[i]);
    }
    return visible.reverse();
  }

  const chineseWords = new Intl.Segmenter('zh', { granularity:'word' });
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

  // At most two DeepSeek batches are in flight. On completion inspect the
  // current playhead again, so a seek never queues the rest of the old scene.
  function createSession(cards, translate, {title, repaint, onError, batchSize = 8, parallel = 2}) {
    indexCards(cards);
    let active = true, running = 0, currentTime = 0, retryTimer;
    function update(time) {
      currentTime = time;
      if (!active || !Number.isFinite(time) || running >= parallel) return;
      let low = 0, high = cards.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (cards[mid].latestEnd <= time) low = mid + 1;
        else high = mid;
      }
      // A long speaker or sound cue may overlap many expired dialogue cues.
      // Count only still-visible and upcoming cues against the lookahead window.
      let limit = low, remaining = parallel * batchSize;
      while (limit < cards.length && remaining > 0) {
        if (cards[limit++].end > time) remaining--;
      }
      for (let from = low; from < limit && running < parallel;) {
        const batch = [];
        let chars = 0;
        while (from < limit && batch.length < batchSize) {
          const c = cards[from];
          if (c.translation || c.pending || c.failed || c.retryAt > Date.now() || c.end <= time) {
            if (batch.length) break;
            from++;
            continue;
          }
          if (batch.length && chars + c.text.length > 2400) break;
          batch.push(c); chars += c.text.length; from++;
        }
        if (batch.length) void request(batch, from);
      }
    }
    async function request(batch, end) {
      running++;
      batch.forEach(card => { card.pending = true; });
      try {
        const values = await translate(batch.map(card => card.text), {purpose:'subtitle',
          context:{title, before:cards[end-batch.length-1]?.text || '', after:cards[end]?.text || ''}});
        if (!active) return;
        if (!Array.isArray(values) || values.length !== batch.length ||
            values.some(v => typeof v !== 'string' || !v.trim())) throw Error('字幕译文未能逐条配对');
        batch.forEach((card, i) => { card.translation = values[i]; });
        repaint();
      } catch (error) {
        if (!active) return;
        const transient = /429|5\d\d|timeout|timed out|failed to fetch|network/i.test(error.message);
        for (const card of batch) {
          if (transient && !card.retryAt) card.retryAt = Date.now() + 1800;
          else card.failed = true;
        }
        if (transient && batch.some(c => !c.failed)) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => update(currentTime), 1850);
        } else onError(error);
      } finally {
        running--;
        batch.forEach(card => { card.pending = false; });
        if (active) update(currentTime);
      }
    }
    return {update, close() { active = false; clearTimeout(retryTimer); }};
  }
  globalThis.bingduCaptionTimeline = {indexCards, createSession, atTime, chineseLines};
})();
