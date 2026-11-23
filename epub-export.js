const EPUB_MIME = 'application/epub+zip';
const XHTML = 'http://www.w3.org/1999/xhtml';
const DC = 'http://purl.org/dc/elements/1.1/';
const ARCHIVE_ORIGIN = 'https://epub.invalid';
const SKIP = new Set(['audio', 'canvas', 'code', 'kbd', 'math', 'noscript', 'pre', 'rp', 'rt', 'samp', 'script', 'style', 'svg', 'template', 'video']);
const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'center', 'dd', 'details', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'
]);
const KNOWN_LANGUAGES = new Map([
  ['简体中文', 'zh-Hans'], ['中文', 'zh-Hans'], ['繁體中文', 'zh-Hant'], ['繁体中文', 'zh-Hant'],
  ['英语', 'en'], ['英文', 'en'], ['english', 'en'], ['日语', 'ja'], ['日本語', 'ja'],
  ['韩语', 'ko'], ['法语', 'fr'], ['德语', 'de'], ['西班牙语', 'es'], ['葡萄牙语', 'pt'],
  ['俄语', 'ru'], ['阿拉伯语', 'ar'], ['希伯来语', 'he'], ['波斯语', 'fa'], ['泰语', 'th'], ['越南语', 'vi']
]);

function elements(root, name) {
  return [...root.getElementsByTagNameNS('*', name)];
}

function readXML(archive, path) {
  if (!Object.hasOwn(archive, path)) throw new Error(`EPUB 缺少文件 ${path}`);
  const bytes = archive[path];
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const parser = new DOMParser();
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  let xml = parser.parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror') && /&(?!amp;|lt;|gt;|apos;|quot;)[a-z][a-z0-9]+;/i.test(text)) {
    // Some EPUB 2 books rely on HTML entity names from an external XHTML DTD.
    const normalized = text.replace(/&(?!amp;|lt;|gt;|apos;|quot;)[a-z][a-z0-9]+;/gi, entity => {
      const decoded = parser.parseFromString(`<textarea>${entity}</textarea>`, 'text/html').querySelector('textarea').value;
      return decoded === entity ? entity : Array.from(decoded, char => `&#${char.codePointAt(0)};`).join('');
    });
    xml = parser.parseFromString(normalized, 'application/xml');
  }
  if (xml.querySelector('parsererror')) throw new Error(`EPUB 文件格式无效 · ${path}`);
  return xml;
}

function archivePath(base, href) {
  if (!href) throw new Error('EPUB 章节路径为空');
  const path = base.split('/').map(encodeURIComponent).join('/');
  const url = new URL(href, `${ARCHIVE_ORIGIN}/${path}`);
  if (url.origin !== ARCHIVE_ORIGIN) throw new Error('EPUB 引用了外部章节');
  return decodeURIComponent(url.pathname.slice(1));
}

function collectGroups(root, groups) {
  let text = '';
  let last;
  const consider = node => {
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE || node.namespaceURI !== XHTML ||
        SKIP.has(node.localName) || node.hasAttribute('hidden') ||
        node.classList.contains('pt-epub-translation') || node.getAttribute('translate') === 'no') return '';
    if (node.localName === 'br') return '\n';
    return Array.from(node.childNodes, consider).join('');
  };
  function flush() {
    const value = text.replace(/[\t\r\f ]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    if (last && /\p{L}/u.test(value)) {
      const pieces = value.match(/[\s\S]{1,3500}/gu);
      groups.push({ value, pieces, last });
    }
    text = '';
    last = undefined;
  }
  for (const node of root.childNodes) {
    // XHTML block containers have their own bilingual blocks; inline runs keep their nested markup.
    if (node.nodeType === Node.ELEMENT_NODE && node.namespaceURI === XHTML && BLOCKS.has(node.localName)) {
      flush();
      if (!node.hasAttribute('hidden') && node.getAttribute('translate') !== 'no') collectGroups(node, groups);
      continue;
    }
    const part = consider(node);
    if (part.trim()) last = node;
    text += part;
  }
  flush();
}

function stripInvalidXML(text) {
  return text.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '');
}

function addTranslation(xml, last, value, language) {
  const translation = xml.createElementNS(XHTML, 'span');
  translation.setAttribute('class', 'pt-epub-translation');
  translation.setAttribute('style', 'font-size: 0.92em');
  if (language) {
    translation.setAttribute('lang', language);
    translation.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', language);
    if (/^(ar|fa|he|ur)(-|$)/.test(language)) translation.setAttribute('dir', 'rtl');
  }
  translation.textContent = stripInvalidXML(value);
  last.after(xml.createElementNS(XHTML, 'br'), translation);
}

export async function translateEpub(file, base, { translateBatch, status, language, format }) {
  const { unzipSync, zipSync, strToU8 } = await import('./vendor/fflate.mjs');
  const plain = format === 'text';
  const lang = KNOWN_LANGUAGES.get(language.toLowerCase()) ||
    (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language) ? language : '');
  let size = 0;
  const seen = new Set();
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter(entry) {
      if (entry.name.endsWith('/')) return false;
      if (Object.hasOwn(Object.prototype, entry.name) || seen.has(entry.name)) {
        throw new Error('EPUB 包含重复或异常的文件名');
      }
      seen.add(entry.name);
      size += entry.originalSize;
      if (size > 128 * 1024 * 1024) throw new Error('电子书解压后超过 128 MB');
      return true;
    }
  });
  if (archive['META-INF/encryption.xml']) {
    const encryption = readXML(archive, 'META-INF/encryption.xml');
    const obscuredFonts = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);
    if (elements(encryption, 'EncryptionMethod').some(node => !obscuredFonts.has(node.getAttribute('Algorithm')))) {
      throw new Error('此 EPUB 受加密保护，请选择可读取的版本');
    }
  }
  if (!plain && archive['META-INF/signatures.xml']) {
    throw new Error('修改内容会使此 EPUB 的数字签名失效，请选择未签名的版本');
  }
  const directory = readXML(archive, 'META-INF/container.xml');
  const root = elements(directory, 'rootfile')[0]?.getAttribute('full-path');
  const opf = readXML(archive, root);
  const metadata = elements(opf, 'metadata')[0];
  const spine = elements(opf, 'spine')[0];
  const manifest = elements(opf, 'manifest')[0];
  if (!metadata || !spine || !manifest) throw new Error('EPUB 目录缺少章节清单或元数据');
  if (!plain && elements(metadata, 'meta').some(node =>
    (node.getAttribute('property') === 'rendition:layout' && node.textContent.trim() === 'pre-paginated') ||
    (node.getAttribute('name') === 'fixed-layout' && node.getAttribute('content') === 'true'))) {
    throw new Error('固定版式 EPUB 请使用双语 TXT 导出');
  }
  const items = new Map(elements(manifest, 'item').map(node => [node.getAttribute('id'), node]));
  const chapters = new Set();
  for (const ref of elements(spine, 'itemref')) {
    if (!plain && /(?:^|\s)rendition:layout-pre-paginated(?:\s|$)/.test(ref.getAttribute('properties') || '')) {
      throw new Error('包含固定版式章节的 EPUB 请使用双语 TXT 导出');
    }
    const item = items.get(ref.getAttribute('idref'));
    if (!item) throw new Error('EPUB 章节清单缺少内容文件');
    if (!['application/xhtml+xml', 'text/html'].includes(item.getAttribute('media-type'))) continue;
    if ((item.getAttribute('properties') || '').split(/\s+/).includes('nav')) continue;
    chapters.add(archivePath(root, item.getAttribute('href')));
  }
  const serializer = new XMLSerializer();
  const sections = [];
  let count = 0, done = 0, translatedChapters = 0;
  for (const chapter of chapters) {
    const label = `第 ${++done} / ${chapters.size} 章`;
    status(`${label} · 读取章节`);
    const xml = readXML(archive, chapter);
    const body = elements(xml, 'body')[0];
    if (!body) continue;
    const groups = [];
    // Unnamespaced EPUB 2 chapters can still be parsed, but well-formed XHTML normally has a namespace.
    collectGroups(body, groups);
    if (!groups.length) continue;
    const translations = await translateBatch(groups.flatMap(group => group.pieces), label);
    let offset = 0;
    groups.forEach(({ value, last, pieces }) => {
      const translation = translations.slice(offset, offset + pieces.length).join(' ');
      offset += pieces.length;
      if (plain) sections.push(`${value}\n${translation}`);
      else addTranslation(xml, last, translation, lang);
    });
    if (!plain) archive[chapter] = strToU8(serializer.serializeToString(xml));
    count += groups.length;
    translatedChapters++;
  }
  if (!count) throw new Error('EPUB 中未找到可翻译的章节文字');
  if (plain) return {
    name: `${base}-双语.txt`, type: 'text/plain;charset=utf-8', content: sections.join('\n\n')
  };
  const title = metadata.getElementsByTagNameNS(DC, 'title')[0];
  if (title) title.textContent += ' · 双语';
  if (lang && ![...metadata.getElementsByTagNameNS(DC, 'language')].some(node => node.textContent.trim() === lang)) {
    const node = opf.createElementNS(DC, 'dc:language');
    node.textContent = lang;
    metadata.append(node);
  }
  if (opf.documentElement.getAttribute('version')?.startsWith('3')) {
    let modified = elements(metadata, 'meta').find(node => node.getAttribute('property') === 'dcterms:modified' && !node.hasAttribute('refines'));
    if (!modified) {
      modified = opf.createElementNS(metadata.namespaceURI, 'meta');
      modified.setAttribute('property', 'dcterms:modified');
      metadata.append(modified);
    }
    modified.textContent = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  archive[root] = strToU8(serializer.serializeToString(opf));
  status('正在封装 EPUB');
  // The mimetype entry must be first and stored without compression.
  const entries = new Map([['mimetype', [strToU8(EPUB_MIME), { level: 0 }]]]);
  for (const [path, data] of Object.entries(archive)) {
    if (path !== 'mimetype') entries.set(path, data);
  }
  return {
    name: `${base}-双语.epub`,
    type: EPUB_MIME,
    content: zipSync(Object.fromEntries(entries), { level: 4 }),
    preview: `双语 EPUB 已生成 · ${translatedChapters} 章 · ${count} 段译文`
  };
}
