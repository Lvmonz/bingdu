const DEVICE_SCALE = 3;
const MAX_CANVAS_SIDE = 2800;
const FONT = 'system-ui, sans-serif';

function splitText(text) {
  return text.match(/[\s\S]{1,3500}/gu)?.map(part => part.trim()).filter(Boolean) || [];
}

function nativeRegions(pdf, viewport, { items, styles }) {
  const regions = [];
  let line;
  let previousRegion;
  for (const item of items) {
    if (!item.str?.trim()) {
      if (line && item.hasEOL) line.closed = true;
      else if (line && item.str) line.spaceAfter = true;
      continue;
    }
    const [a, b, c, d, x, baseline] = pdf.Util.transform(viewport.transform, item.transform);
    const size = Math.hypot(c, d);
    const style = styles[item.fontName];
    const ascent = style?.ascent ?? (style?.descent ? 1 + style.descent : .82);
    const left = Math.max(0, x - .4);
    const top = Math.max(0, baseline - size * ascent - .6);
    const right = Math.min(viewport.width, x + item.width * viewport.scale * (viewport.userUnit || 1) + .4);
    const bottom = Math.min(viewport.height, Math.max(baseline + size * .22, top + size) + .6);
    const bounds = [left, top, right, bottom];
    const horizontal = !style?.vertical && a > 0 && Math.abs(b) < Math.abs(a) * .1;
    const positioned = horizontal && size > 2 && right > left && bottom > top && bounds.every(Number.isFinite);
    const text = item.str.trim();
    if (!positioned) {
      regions.push({ text });
      line = null;
      previousRegion = null;
      continue;
    }
    const gap = line ? left - line.bounds[2] : Infinity;
    if (line && !line.closed && Math.abs(baseline - line.baseline) < size * .22 &&
        gap >= -1 && gap < size * .75 && Math.abs(line.size - size) < size * .2) {
      const separator = line.spaceAfter || /^\s/.test(item.str) || gap > size * .17 ? ' ' : '';
      line.text += separator + text;
      line.bounds[2] = right;
      line.bounds[3] = Math.max(line.bounds[3], bottom);
      if (previousRegion !== line) {
        previousRegion.text += separator + text;
        previousRegion.bounds[2] = Math.max(previousRegion.bounds[2], right);
        previousRegion.bounds[3] = Math.max(previousRegion.bounds[3], bottom);
      }
    } else {
      const priorLine = line;
      line = { text, bounds, size, baseline };
      const aligned = priorLine && Math.abs(left - priorLine.bounds[0]) < size * .35;
      const closeBelow = priorLine && baseline - priorLine.baseline >= size * .85 &&
        baseline - priorLine.baseline <= size * 1.45;
      const sameFont = priorLine && priorLine.font === item.fontName && Math.abs(priorLine.size - size) < size * .1;
      // Merge closely spaced lines within a paragraph, leaving columns and table cells separate.
      if (previousRegion && aligned && closeBelow && sameFont && priorLine.text.length > 22 &&
          !/[.!?。！？:]$/.test(priorLine.text) && previousRegion.text.length < 2800) {
        previousRegion.text += ' ' + text;
        previousRegion.bounds[2] = Math.max(previousRegion.bounds[2], right);
        previousRegion.bounds[3] = bottom;
      } else {
        previousRegion = line;
        regions.push(line);
      }
    }
    line.font = item.fontName;
    line.closed = item.hasEOL;
    line.spaceAfter = /\s$/.test(item.str);
  }
  return regions;
}

function cleanOcrText(value) {
  return value.replace(/<\/?[|｜][^>]*>/g, '')
    .replace(/<\/(?:td|th)>/gi, '  ')
    .replace(/<\/(?:tr|p|div)>/gi, '\n')
    .replace(/<\/?(?:html|body|table|thead|tbody|tr|td|th|p|div|span|br)\b[^>]*>/gi, '')
    .trim();
}

function ocrRegions(raw, width, height) {
  const tags = /<[|｜]ref[|｜]>([^<]*)<[|｜]\/ref[|｜]>\s*<[|｜]box[|｜]>([\s\S]*?)<[|｜]\/box[|｜]>/g;
  const markers = [...raw.matchAll(tags)];
  if (!markers.length) {
    const text = cleanOcrText(raw);
    return text ? [{ text }] : [];
  }
  const regions = [];
  const leading = cleanOcrText(raw.slice(0, markers[0].index));
  if (leading) regions.push({ text: leading });
  for (const [index, match] of markers.entries()) {
    if (/^(image|figure|illustration|photo|logo)$/i.test(match[1].trim())) continue;
    const text = cleanOcrText(raw.slice(match.index + match[0].length, markers[index + 1]?.index));
    if (!text) continue;
    const numbers = match[2].match(/-?\d+(?:\.\d+)?/g)?.map(Number);
    let bounds;
    if (numbers?.length === 4 && numbers.every(n => n >= 0 && n <= 1000) && !/table|equation|formula/i.test(match[1])) {
      const [l, t, r, b] = numbers;
      if (r > l && b > t) bounds = [l * width / 1000, t * height / 1000, r * width / 1000, b * height / 1000];
    }
    regions.push({ text, bounds, size: bounds && Math.min(36, (bounds[3] - bounds[1]) * .68) });
  }
  return regions;
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

async function canvasBytes(canvas, type = 'image/png') {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, type, .92));
  if (!blob) throw new Error('无法生成页面图像');
  return new Uint8Array(await blob.arrayBuffer());
}

async function renderPage(page, viewport) {
  const scale = Math.min(DEVICE_SCALE, 2500 / Math.max(viewport.width, viewport.height));
  const renderViewport = page.getViewport({ scale });
  const canvas = createCanvas(renderViewport.width, renderViewport.height);
  try {
    await page.render({ canvas, viewport: renderViewport }).promise;
    return canvas;
  } catch (error) {
    canvas.width = canvas.height = 0;
    throw error;
  }
}

async function recognizePage(canvas, viewport, apiKey) {
  const form = new FormData();
  form.append('purpose', 'rich_layout_recognition');
  form.append('file', new Blob([await canvasBytes(canvas, 'image/jpeg')], { type: 'image/jpeg' }), 'page.jpg');
  const response = await fetch('https://api.deepseek.com/v1/tools/ocr', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    signal: AbortSignal.timeout(185000)
  });
  if (!response.ok) {
    const hints = { 401: 'API Key 无效', 402: '账户余额不足', 429: '请求过于频繁，请稍后重试' };
    throw new Error(`文字识别 HTTP ${response.status} · ${hints[response.status] || '请重试或拆分文件'}`);
  }
  const result = await response.json();
  const recognized = result.pages?.[0];
  if (result.error || result.pages?.length !== 1 || typeof recognized?.text !== 'string') {
    throw new Error('文字识别服务未返回有效页面');
  }
  if (recognized.finish_reason !== 'stop') throw new Error('文字识别结果不完整，请检查页面或拆分文件');
  return ocrRegions(recognized.text, viewport.width, viewport.height);
}

function linesFor(context, text, size, width) {
  context.font = `${size}px ${FONT}`;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const lines = [];
  let line = '';
  for (const paragraph of text.split(/\r?\n/)) {
    for (const { segment } of segmenter.segment(paragraph)) {
      const joined = line + segment;
      if (context.measureText(joined.trimEnd()).width <= width) {
        line = joined;
        continue;
      }
      if (line.trim()) lines.push(line.trim());
      line = segment.trimStart();
      if (context.measureText(line).width <= width) continue;
      // Long unbroken tokens (including some CJK word segments) may wrap between graphemes.
      const token = line;
      line = '';
      for (const { segment: grapheme } of new Intl.Segmenter().segment(token)) {
        if (line && context.measureText(line + grapheme).width > width) {
          lines.push(line);
          line = '';
        }
        line += grapheme;
      }
    }
    lines.push(line.trim());
    line = '';
  }
  return lines;
}

function paintLines(context, lines, x, y, width, size, step) {
  context.font = `${size}px ${FONT}`;
  context.textBaseline = 'middle';
  for (const [i, line] of lines.entries()) {
    const firstLetter = line.match(/\p{Letter}/u)?.[0] || '';
    const rtl = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}]/u.test(firstLetter);
    context.direction = rtl ? 'rtl' : 'ltr';
    context.textAlign = rtl ? 'right' : 'left';
    context.fillText(line, rtl ? x + width : x, y + (i + .5) * step, width);
  }
}

function backgroundSampler(canvas, viewport) {
  const { width, height } = canvas;
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  return ([left, top, right, bottom]) => {
    const colors = [[], [], []];
    function sample(x, y) {
      const px = Math.max(0, Math.min(width - 1, Math.floor(x * width / viewport.width)));
      const py = Math.max(0, Math.min(height - 1, Math.floor(y * height / viewport.height)));
      const offset = 4 * (py * width + px);
      colors.forEach((channel, i) => channel.push(rgba[offset + i]));
    }
    for (let step = 0; step <= 8; step++) {
      const x = left + (right - left) * step / 8;
      const y = top + (bottom - top) * step / 8;
      sample(x, top - 1);
      sample(x, bottom + 1);
      sample(left - 1, y);
      sample(right + 1, y);
    }
    for (const channel of colors) channel.sort((a, b) => a - b);
    if (colors.some(channel => channel[28] - channel[7] > 42)) return null;
    return colors.map(channel => channel[18]);
  };
}

function paintRegion(context, region, translation, background) {
  const { bounds, size } = region;
  if (!bounds || !translation) return false;
  const [left, top, right, bottom] = bounds;
  const width = right - left;
  const height = bottom - top;
  if (width < 9 || height < 7) return false;
  const inset = Math.min(1, width * .04);
  const minSize = Math.max(6.5, size * .64);
  for (let fontSize = Math.max(minSize, Math.min(size, height)); fontSize >= minSize - .01; fontSize -= .5) {
    const lines = linesFor(context, translation, fontSize, width - 2 * inset);
    const step = fontSize * (lines.length > 1 ? 1.15 : 1);
    if (lines.length * step > height) continue;
    const color = background(bounds);
    if (!color) return false;
    const lightness = color[0] * .2126 + color[1] * .7152 + color[2] * .0722;
    context.fillStyle = lightness > 128 ? '#17231e' : '#ffffff';
    paintLines(context, lines, left + inset, top + (height - lines.length * step) / 2, width - 2 * inset, fontSize, step);
    return color;
  }
  return false;
}

function overlaps(left, right) {
  if (!left || !right) return false;
  // A small intersection can be ordinary line spacing or antialias padding.
  return Math.min(left[2], right[2]) - Math.max(left[0], right[0]) > 2 &&
    Math.min(left[3], right[3]) - Math.max(left[1], right[1]) > 2;
}

function pageOverlay(viewport, regions, translations, sourceCanvas) {
  const scale = Math.min(DEVICE_SCALE, MAX_CANVAS_SIDE / Math.max(viewport.width, viewport.height));
  const canvas = createCanvas(viewport.width * scale, viewport.height * scale);
  const context = canvas.getContext('2d');
  context.setTransform(canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0);
  const notes = [];
  const fills = [];
  const background = backgroundSampler(sourceCanvas, viewport);
  let placed = 0, marked = 0;
  regions.forEach((region, index) => {
    const intersects = regions.some((other, otherIndex) =>
      index !== otherIndex && overlaps(region.bounds, other.bounds));
    const color = !intersects && paintRegion(context, region, translations[index], background);
    if (color) {
      fills.push({ bounds: region.bounds, color });
      placed++;
      return;
    }
    const number = notes.length + 1;
    notes.push({ number, original: region.text, translation: translations[index] });
    // A compact marker on the translated copy helps match overflow with its source.
    if (!region.bounds || intersects) return;
    const [x, y] = region.bounds;
    const label = `[${number}]`;
    context.font = `7px ${FONT}`;
    const width = context.measureText(label).width + 4;
    const left = Math.max(0, x - width - 2);
    if (left + width > x || regions.some(other => overlaps([left, y, left + width, y + 10], other.bounds))) return;
    context.direction = 'ltr';
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.fillStyle = '#ffffff';
    context.fillRect(left, y, width, 10);
    context.fillStyle = '#185b4b';
    context.fillText(label, left + 2, y + 5);
    marked++;
  });
  return { canvas, notes, placed, marked, fills };
}

function pdfRegion(viewport, [left, top, right, bottom], degrees) {
  const [x, y] = viewport.convertToPdfPoint(left, bottom);
  const [rightX, rightY] = viewport.convertToPdfPoint(right, bottom);
  const [topX, topY] = viewport.convertToPdfPoint(left, top);
  return {
    x, y,
    width: Math.hypot(rightX - x, rightY - y),
    height: Math.hypot(topX - x, topY - y),
    rotate: degrees(Math.atan2(rightY - y, rightX - x) * 180 / Math.PI)
  };
}

async function drawOverlay(output, page, viewport, canvas, fills, { degrees, rgb }) {
  for (const { bounds: [left, top, right, bottom], color } of fills) {
    const bounds = [Math.max(0, left - .7), Math.max(0, top - .7),
      Math.min(viewport.width, right + .7), Math.min(viewport.height, bottom + .7)];
    page.drawRectangle({ ...pdfRegion(viewport, bounds, degrees), color: rgb(...color.map(value => value / 255)) });
  }
  const image = await output.embedPng(await canvasBytes(canvas));
  page.drawImage(image, pdfRegion(viewport, [0, 0, viewport.width, viewport.height], degrees));
}

async function addNotes(output, sourceIndex, notes, bilingual) {
  const width = 595, height = 842, margin = 46, size = 11, step = 16;
  const canvas = createCanvas(width * 2, height * 2);
  const context = canvas.getContext('2d');
  context.scale(2, 2);
  let pageNumber = 0;
  let cursor;
  function start() {
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#17483d';
    paintLines(context, [`第 ${sourceIndex + 1} 页 · 译文续页 ${++pageNumber}`], margin, 27, width - 2 * margin, 14, 24);
    cursor = 69;
  }
  async function save() {
    const page = output.addPage([width, height]);
    const image = await output.embedPng(await canvasBytes(canvas));
    page.drawImage(image, { x: 0, y: 0, width, height });
  }
  start();
  try {
    for (const { number, original, translation } of notes) {
      const text = bilingual ? `[${number}] ${original}\n${translation}` : `[${number}] ${translation}`;
      for (const line of linesFor(context, text, size, width - 2 * margin)) {
        if (cursor + step > height - margin) {
          await save();
          start();
        }
        context.fillStyle = '#17231e';
        paintLines(context, [line], margin, cursor, width - 2 * margin, size, step);
        cursor += step;
      }
      cursor += 9;
    }
    await save();
  } finally {
    canvas.width = canvas.height = 0;
  }
}

export async function translatePdf(file, base, { translateBatch, status, apiKey, format, forceOcr }) {
  const pdf = await import('./vendor/pdf.mjs');
  pdf.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const task = pdf.getDocument({ data: bytes.slice(), useWasm: false, isEvalSupported: false, useSystemFonts: true });
  let output, originalPages, translatedPages, library;
  const bilingual = format !== 'translated';
  const plain = format === 'text';
  let ocrCount = 0, overflowCount = 0, placedCount = 0, textCount = 0;
  const sections = [];
  try {
    const input = await task.promise;
    if (!plain) {
      await import('./vendor/pdf-lib.min.js');
      library = globalThis.PDFLib;
      const source = await library.PDFDocument.load(bytes, { updateMetadata: false });
      output = await library.PDFDocument.create();
      output.setTitle(`${base} · ${bilingual ? '双语' : '译文'}`);
      const indexes = source.getPageIndices();
      if (bilingual) originalPages = await output.copyPages(source, indexes);
      translatedPages = await output.copyPages(source, indexes);
    }
    for (let i = 0; i < input.numPages; i++) {
      const label = `第 ${i + 1} / ${input.numPages} 页`;
      status(`${label} · 读取页面`);
      const page = await input.getPage(i + 1);
      let sourceCanvas;
      try {
        const viewport = page.getViewport({ scale: 1 });
        let regions = forceOcr ? [] : nativeRegions(pdf, viewport, await page.getTextContent());
        if (forceOcr || !regions.some(region => /[\p{L}\p{N}]/u.test(region.text))) {
          status(`${label} · 识别扫描文字`);
          sourceCanvas = await renderPage(page, viewport);
          regions = await recognizePage(sourceCanvas, viewport, apiKey);
          ocrCount++;
        }
        const groups = regions.map(region => splitText(region.text));
        const values = await translateBatch(groups.flat(), label);
        let offset = 0;
        const translations = groups.map(group => {
          const value = values.slice(offset, offset + group.length).join(' ');
          offset += group.length;
          return value;
        });
        textCount += regions.length;
        if (plain) {
          if (regions.length) sections.push(`第 ${i + 1} 页\n\n` +
            regions.map((region, j) => `${region.text}\n${translations[j]}`).join('\n\n'));
          continue;
        }
        if (bilingual && regions.length) output.addPage(originalPages[i]);
        const target = output.addPage(translatedPages[i]);
        if (!regions.length) continue;
        status(`${label} · 生成译页`);
        sourceCanvas ||= await renderPage(page, viewport);
        const { canvas, notes, placed, marked, fills } = pageOverlay(viewport, regions, translations, sourceCanvas);
        try {
          if (placed || marked) {
            await drawOverlay(output, target, viewport, canvas, fills, library);
          }
        } finally {
          canvas.width = canvas.height = 0;
        }
        placedCount += placed;
        overflowCount += notes.length;
        if (notes.length) await addNotes(output, i, notes, bilingual);
      } catch (error) {
        throw new Error(`${label} · ${error.message}`, { cause: error });
      } finally {
        if (sourceCanvas) sourceCanvas.width = sourceCanvas.height = 0;
        page.cleanup();
      }
    }
    if (!textCount) throw new Error('PDF 中未识别到可翻译的文字');
    if (plain) return { name: `${base}-双语.txt`, type: 'text/plain;charset=utf-8', content: sections.join('\n\n') };
    status('正在封装 PDF');
    const outputPages = output.getPageCount();
    return {
      name: `${base}-${bilingual ? '双语' : '译文'}.pdf`,
      type: 'application/pdf',
      content: await output.save(),
      preview: `PDF 已生成 · 原文件 ${input.numPages} 页，导出 ${outputPages} 页\n文字识别 ${ocrCount} 页 · 原位译文 ${placedCount} 处` +
        (overflowCount ? ` · 续页译文 ${overflowCount} 处` : '')
    };
  } finally {
    await task.destroy();
  }
}
