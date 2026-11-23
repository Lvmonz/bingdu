function textPlan(text, name) {
  const pieces = text.replaceAll('\r\n', '\n').split(/\n\s*\n/).flatMap(paragraph =>
    paragraph.match(/[\s\S]{1,3500}/gu) || []).map(value => value.trim()).filter(Boolean);
  if (!pieces.length) throw new Error('未找到可翻译的文字');
  return {
    texts: pieces,
    finish: values => ({
      name, type: 'text/plain;charset=utf-8',
      content: pieces.map((value, index) => `${value}\n${values[index]}`).join('\n\n')
    })
  };
}

export function prepareText(text) {
  return textPlan(text, '双语译文.txt');
}

function subtitlePlan(text, name) {
  const groups = text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').trimEnd().split(/\n[ \t]*\n/);
  const cues = groups.map(group => {
    const lines = group.split('\n');
    const timing = lines.findIndex(line => /^\s*(?:\d+:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+/.test(line));
    const content = timing < 0 ? '' : lines.slice(timing + 1).join('\n').trim();
    return { group, content };
  });
  const texts = cues.filter(cue => cue.content).map(cue => cue.content);
  if (!texts.length) throw new Error('未找到包含时间轴的字幕');
  return {
    texts,
    finish(values) {
      let index = 0;
      return {
        name, type: 'text/plain;charset=utf-8',
        content: cues.map(({ group, content }) =>
          content ? `${group}\n${values[index++].replaceAll('&', '&amp;').replaceAll('<', '&lt;').replace(/\n\s*\n/g, '\n')}` : group
        ).join('\n\n') + '\n'
      };
    }
  };
}

function assPlan(text, name) {
  let inEvents = false;
  let fields = 0;
  let textLast = false;
  const rows = text.replaceAll('\r\n', '\n').split('\n').map(line => {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) inEvents = section[1].toLowerCase() === 'events';
    const format = inEvents && line.match(/^\s*Format:\s*(.+)/i);
    if (format) {
      const columns = format[1].split(',').map(value => value.trim().toLowerCase());
      fields = columns.length;
      textLast = columns.at(-1) === 'text';
    }
    const dialogue = inEvents && line.match(/^\s*Dialogue:\s*(.*)/i);
    if (!dialogue || !textLast || fields < 2) return { line };
    const original = dialogue[1].split(',').slice(fields - 1).join(',')
      .replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').trim();
    return { line, original };
  });
  const texts = rows.filter(row => row.original).map(row => row.original);
  if (!texts.length) throw new Error('未找到可翻译的 ASS 字幕');
  return {
    texts,
    finish(values) {
      let index = 0;
      return {
        name, type: 'text/plain;charset=utf-8',
        content: rows.map(({ line, original }) => original
          ? line + '\\N' + values[index++].replace(/[{}\\]/g, '').replace(/\r?\n/g, '\\N')
          : line).join('\n')
      };
    }
  };
}

export async function translateFile(file, options) {
  if (file.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MB');
  const dot = file.name.lastIndexOf('.');
  const extension = dot < 0 ? '' : file.name.slice(dot + 1).toLowerCase();
  const base = dot < 0 ? file.name : file.name.slice(0, dot);
  if (extension === 'pdf') {
    const { translatePdf } = await import('./pdf-export.js');
    return translatePdf(file, base, options);
  }
  if (extension === 'epub') {
    const { translateEpub } = await import('./epub-export.js');
    return translateEpub(file, base, options);
  }
  const source = await prepareFile(file, extension, base);
  return source.finish(await options.translateBatch(source.texts, '', source.picture));
}

async function prepareFile(file, extension, base) {
  if (['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    const picture = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('无法读取图片'));
      reader.readAsDataURL(file);
    });
    return {
      picture, texts: [''],
      finish: ([content]) => ({ name: `${base}-译文.txt`, content, type: 'text/plain;charset=utf-8' })
    };
  }
  const name = `${base}-双语.txt`;
  if (extension === 'txt') return textPlan(await file.text(), name);
  if (extension === 'ass') return assPlan(await file.text(), `${base}-双语.ass`);
  if (['srt', 'vtt'].includes(extension)) {
    return subtitlePlan(await file.text(), `${base}-双语.${extension}`);
  }
  throw new Error('不支持此文件格式');
}
