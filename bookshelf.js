// 本地读书：扫描项目内上传书库（可用 BOOKS_DIR 覆盖），解析 epub / pdf / docx / txt / md → 章节
// 支持：epub（ZIP+OPF+spine）、pdf（pdf-parse）、docx（mammoth）、txt/md（标题切章）
// 每本书：{ id, title, author?, format, file, chapterFile? }，GET 时解析章节 + 封面
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { DOMParser } = require('@xmldom/xmldom');

const ctx = require('./ctx');
const DATA_BASE = path.join(__dirname, 'data');
const BOOKS_BASE = path.resolve(process.env.BOOKS_DIR || path.join(DATA_BASE, 'books'));
const IMG_BASE = path.join(DATA_BASE, 'imgs'); // 图片缓存：PDF 页面渲染 / epub 内嵌图（按用户分目录）
const EPUB_BASE = path.join(DATA_BASE, 'epubs'); // PDF→EPUB 转换缓存（按用户分目录）
const IGNORE_DIR = /node_modules|\.dsh|harness|video|model|\.git|\.omo|extract_books|assets?/i;
const BOOK_EXTS = ['.epub', '.pdf', '.docx', '.txt', '.md', '.mobi', '.azw3'];
const CHUNK = 2000; // 无章节结构的文本按此字数切章
const PDF_SCALE = 2; // PDF 页渲染倍率（页图 PNG 与透明文字层共用，改这里需清 data/imgs/pdf 缓存）
let mupdfDoc = null; // 当前打开的 PDF 文档（懒加载）

// ---------- 多用户：书库 / 缓存目录按当前请求用户自动分目录（一人一库物理隔离） ----------
const userSeg = () => { const uid = ctx.currentUid(); return uid ? String(uid).replace(/[^a-zA-Z0-9_-]/g, '') : '_shared'; };
const subDir = (base) => { const d = path.join(base, userSeg()); fs.mkdirSync(d, { recursive: true }); return d; };
const rootDir = () => subDir(BOOKS_BASE);
const imgDir = () => subDir(IMG_BASE);
const epubDir = () => subDir(EPUB_BASE);

// zip 内路径归一化（防穿越 + 统一斜杠）
const normPath = (p) => path.posix.normalize(('/' + String(p || '').replace(/\\/g, '/').replace(/^\/+/, '')).replace(/\/+/g, '/')).replace(/^\/+/, '');

const idOf = (name) => crypto.createHash('md5').update(name).digest('hex').slice(0, 12);

// 清洗书名：去掉 z-library 标记 / (1) / = 后半段
function cleanTitle(name) {
  let t = path.basename(name, path.extname(name));
  t = t.replace(/[（(][^）)]*(z[- ]?lib|1lib|z-lib)[^）)]*[）)]/gi, ''); // z-library 括号
  t = t.replace(/\s*[=（:：]\s*[A-Za-z][^\u4e00-\u9fa5]{0,300}$/, ''); // "= Scarcity…" 后段
  t = t.replace(/\s*\(1\)$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t || name;
}

// ---------- 扫描 ----------
function scanBooks() {
  const books = [];
  const ROOT = rootDir();
  const defs = [];

  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    const full = path.join(ROOT, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIR.test(entry.name)) continue;
      const d = bookFromDir(entry.name, full);
      if (Array.isArray(d)) defs.push(...d);
      else if (d) defs.push(d);
    } else if (BOOK_EXTS.includes(path.extname(entry.name).toLowerCase())) {
      defs.push({
        id: idOf(entry.name),
        title: cleanTitle(entry.name),
        author: '',
        format: path.extname(entry.name).slice(1).toLowerCase(),
        file: full,
        chapterFile: null,
      });
    }
  }

  for (const b of defs) {
    if (!b || !b.file) continue;
    books.push({
      id: b.id,
      title: b.title,
      author: b.author || '',
      format: b.format,
      sizeKB: Math.round(fs.statSync(b.file).size / 1024),
      chapterCount: b.chapterFile ? countFiles(b.chapterFile) : 0,
    });
  }
  books.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  return books;
}

// 浏览器上传 EPUB：只接受结构有效的 EPUB，重名且内容相同则跳过，内容不同则自动编号。
function importEpub(buffer, originalName) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('上传文件为空');

  const rawName = path.basename(String(originalName || 'book.epub').replace(/\\/g, '/'));
  if (path.extname(rawName).toLowerCase() !== '.epub') throw new Error('只支持上传 EPUB 文件');

  try {
    const zip = new AdmZip(buffer);
    if (!zip.getEntry('META-INF/container.xml')) throw new Error('缺少 META-INF/container.xml');
  } catch (err) {
    throw new Error(`不是有效的 EPUB 文件：${err.message}`);
  }

  const safeBase = path.basename(rawName, path.extname(rawName))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || '未命名图书';
  let filename = `${safeBase}.epub`;
  const ROOT = rootDir();
  let target = path.join(ROOT, filename);
  let copy = 2;

  while (fs.existsSync(target)) {
    const current = fs.readFileSync(target);
    if (current.length === buffer.length && current.equals(buffer)) {
      const book = scanBooks().find((item) => item.id === idOf(filename));
      return { added: false, book };
    }
    filename = `${safeBase} (${copy++}).epub`;
    target = path.join(ROOT, filename);
  }

  fs.writeFileSync(target, buffer, { flag: 'wx' });
  const book = scanBooks().find((item) => item.id === idOf(filename));
  return { added: true, book };
}

// PDF 上传：存到书库后立即后台转 EPUB（缓存）；转换失败不致命，打开时会重试/退化
function importPdf(buffer, originalName) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('上传文件为空');

  const rawName = path.basename(String(originalName || 'book.pdf').replace(/\\/g, '/'));
  if (path.extname(rawName).toLowerCase() !== '.pdf') throw new Error('只支持上传 PDF 文件');
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('不是有效的 PDF 文件');

  const safeBase = path.basename(rawName, path.extname(rawName))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || '未命名图书';
  let filename = `${safeBase}.pdf`;
  const ROOT = rootDir();
  let target = path.join(ROOT, filename);
  let copy = 2;

  while (fs.existsSync(target)) {
    const current = fs.readFileSync(target);
    if (current.length === buffer.length && current.equals(buffer)) {
      const book = scanBooks().find((item) => item.id === idOf(filename));
      return { added: false, book };
    }
    filename = `${safeBase} (${copy++}).pdf`;
    target = path.join(ROOT, filename);
  }

  fs.writeFileSync(target, buffer, { flag: 'wx' });
  const book = scanBooks().find((item) => item.id === idOf(filename));
  // 后台预转换：不阻塞上传响应；打开书时若未完成会自动兜底转换
  convertPdfToEpub(book).then(() => {
    console.log(`[PDF→EPUB 预转换完成] ${book.title} → data/epubs/${book.id}.epub`);
  }).catch((err) => {
    console.error('[PDF→EPUB 预转换失败（打开时会重试）]', book.title, err.message);
  });
  return { added: true, book };
}

function countFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => /\.(txt|md)$/i.test(f)).length; } catch { return 0; }
}

// 子目录 = 一本书：优先 epub > pdf > docx；_chapters/（已切好的章节）优先当正文；否则目录内笔记 md/txt
// 目录内有多本"书体"（epub/pdf/docx）→ 每本独立展示（目录名仅作书名不用）
function bookFromDir(dirName, dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
  const exts = (f) => path.extname(f).toLowerCase();
  const pick = (extsArr) => files.map((f) => f.name).find((f) => extsArr.includes(exts(f)));

  const chapterDir = fs.readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory() && /_?chapters/gi.test(e.name));
  const chFiles = chapterDir ? fs.readdirSync(path.join(dir, chapterDir.name)).filter((f) => /\.(txt|md)$/i.test(f)).sort(byNameNum) : [];

  const bookFiles = files.map((f) => f.name).filter((f) => ['.epub', '.pdf', '.docx'].includes(exts(f)));
  // 多书目录 → 每本独立成书
  if (bookFiles.length > 1) {
    return bookFiles.map((f) => ({
      id: idOf(dirName + '/' + f),
      title: cleanTitle(f),
      author: '',
      format: exts(f).slice(1),
      file: path.join(dir, f),
      chapterFile: null,
    }));
  }
  // 单书目录（或只有笔记）→ 目录名为书名
  const dirOfOne = bookFiles.length === 1 ? bookFiles[0] : null;
  if (dirOfOne) {
    if (chFiles.length) {
      return { id: idOf(dirName), title: cleanTitle(dirName), author: '', format: 'txt', file: path.join(dir, chapterDir.name, chFiles[0]), chapterFile: path.join(dir, chapterDir.name) };
    }
    return {
      id: idOf(dirName),
      title: cleanTitle(dirName),
      author: '',
      format: exts(dirOfOne).slice(1),
      file: path.join(dir, dirOfOne),
      chapterFile: null,
    };
  }
  if (chFiles.length) {
    return { id: idOf(dirName), title: cleanTitle(dirName), author: '', format: 'txt', file: path.join(dir, chapterDir.name, chFiles[0]), chapterFile: path.join(dir, chapterDir.name) };
  }
  // 无书体：用目录内笔记/文本（如"书名_读书笔记.md"）
  const noteFile = files.map((f) => f.name).find((f) => /\.(md|txt)$/i.test(f) && !/extracted/i.test(f));
  if (!noteFile) return null;
  return { id: idOf(dirName), title: cleanTitle(dirName), author: '', format: path.extname(noteFile).slice(1).toLowerCase(), file: path.join(dir, noteFile), chapterFile: null };
}

function byNameNum(a, b) {
  const n = (s) => Number((s.match(/\d+/) || [0])[0]);
  return n(a) - n(b) || a.localeCompare(b);
}

// ---------- 解析缓存 ----------
const cache = new Map(); // uid::id -> { mtimeMs, book } —— key 带用户段，两人传同名书也不串

function cached(id, loader) {
  const key = userSeg() + '::' + id;
  const hit = cache.get(key);
  if (hit) {
    try {
      const m = fs.statSync(hit.file).mtimeMs;
      if (m === hit.mtimeMs) return hit.book;
    } catch { /* 文件没了，重新解析 */ }
  }
  const book = loader();
  cache.set(key, { file: hit?.file, mtimeMs: hit?.mtimeMs, book });
  return book;
}

// ---------- html → 文本 ----------
function decodeEntities(s) {
  return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n));
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// epub 正文提取：保留标题层级（#）、列表（•）、引用（>）、图片占位（［插图］）
// imgBase: (src) => token 字符串（提取图片时传），否则纯占位
function htmlToText(html, imgBase) {
  let s = String(html)
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  // 标题 → # 前缀（h1→# 、h2→## …）
  s = s.replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, lv, inner) => `\n${'#'.repeat(Number(lv))} ${stripTags(inner)}\n`);
  // 列表：ul/ol → • 项（每项独立段）
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (m, inner) => `\n\n• ${stripTags(inner)}`);
  // 引用
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, inner) => `\n> ${stripTags(inner)}\n`);
  // 图片占位（含 alt / svg href）→ 图片 token（imgBase 提供）或文本占位
  s = s.replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, (m, src) => `\n\n${imgBase ? imgBase(src) : '［插图］'}\n\n`);
  s = s.replace(/<img\b[^>]*>/gi, '\n\n［插图］\n\n');
  s = s.replace(/<image\b[^>]*href="([^"]+)"[^>]*>/gi, (m, src) => `\n\n${imgBase ? imgBase(src) : '［插图］'}\n\n`);
  s = s.replace(/<image\b[^>]*>/gi, '\n\n［插图］\n\n');
  // 段落/分页
  s = s.replace(/<\/(p|div|section|figure|tr|table)>/gi, '\n\n')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstHeading(html) {
  const m = String(html).match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>|^([^\n<]{2,30})/i);
  if (m) return stripTags(m[1] || m[2] || '').slice(0, 30);
  return '';
}

// 按标签名取元素（兼容带命名空间前缀的 OPF：<opf:itemref> / <dc:title> / <opf:item>）
function byTag(doc, name) {
  let out = [];
  try { out = Array.from(doc.getElementsByTagName(name)); } catch { /* */ }
  if (!out.length) {
    try { out = Array.from(doc.getElementsByTagNameNS('*', name)); } catch { /* */ }
  }
  return out;
}

// epub：ZIP + container.xml + OPF(metadata/manifest/spine) + 书自带目录(ncx/nav) + 封面提取
// 返回：spine（每个 spine 文件一条，排版模式 1:1 对应）、toc（书自带目录，含 spineIdx+anchor）、chapters（文字模式，合并短节）
function parseEpub(file, id) {
  const zip = new AdmZip(file);
  const container = zip.readAsText('META-INF/container.xml');
  const rootMatch = container.match(/<rootfile[^>]*full-path="([^"]+)"/i);
  if (!rootMatch) throw new Error('epub 缺少 container.xml');
  const opfPath = rootMatch[1];
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const resolve = (href) => normPath(opfDir ? opfDir + '/' + href : href);
  const read = (href) => { try { return zip.readAsText(resolve(href)); } catch { return ''; } };
  const opf = zip.readAsText(opfPath);
  const doc = new DOMParser().parseFromString(opf, 'text/xml');
  const title = (byTag(doc, 'title')[0]?.textContent || '').trim();
  const author = (byTag(doc, 'creator')[0]?.textContent || '').trim();
  // 内嵌图抽取：按章节文件目录解析 src → zip 读出 → 缓存 → 返回图片 token
  const imgToken = (chapterFull, src) => {
    try {
      const dir = chapterFull.includes('/') ? chapterFull.slice(0, chapterFull.lastIndexOf('/')) : '';
      const full = normPath(dir ? dir + '/' + src : src);
      const buf = zip.readFile(full);
      const ext = path.extname(full).slice(1).toLowerCase() || 'jpg';
      const key = idOf(full) + '_' + ext;
      const fp = path.join(imgDir(), 'epub', id, 'i' + key);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf);
      return `\u0002I:${key}\u0002`;
    } catch { return '［插图］'; }
  };
  // manifest: id -> {href, media-type, props}
  const manifest = {};
  const items = byTag(doc, 'item');
  for (const it of items) {
    manifest[it.getAttribute('id')] = { href: it.getAttribute('href'), type: it.getAttribute('media-type'), props: it.getAttribute('properties') || '' };
  }
  // 封面：meta[name=cover] 或 property=cover-image
  let coverPath = '';
  const metas = byTag(doc, 'meta');
  for (const m of metas) {
    if ((m.getAttribute('name') || '').toLowerCase() === 'cover' && manifest[m.getAttribute('content')]) {
      coverPath = manifest[m.getAttribute('content')].href; break;
    }
    if ((m.getAttribute('property') || '').toLowerCase() === 'cover-image') { coverPath = m.getAttribute('content'); break; }
  }
  let cover = null;
  if (coverPath) {
    try { cover = zip.readFile(resolve(coverPath)); } catch { /* 忽略 */ }
  }
  // spine 章节（兼容 opf 前缀）；空则用全部 xhtml 兜底
  let spine = byTag(doc, 'itemref').map((s) => manifest[s.getAttribute('idref')]).filter(Boolean);
  if (!spine.length) {
    spine = Object.values(manifest).filter((it) => /xhtml|html/i.test(it.type || '')).sort((a, b) => (a.href || '').localeCompare(b.href || ''));
  }
  // spineMeta：排版模式 1:1 对应 spine；chapters：文字模式（可合并，带 spineIdx/spineEnd）
  const spineMeta = [];
  const chapters = [];
  spine.forEach((item, i) => {
    const html = read(item.href);
    const text = htmlToText(html, (src) => imgToken(resolve(item.href), src));
    const chTitle = firstHeading(html) || `第 ${i + 1} 节`;
    spineMeta.push({ idx: i, href: item.href, title: chTitle });
    if (text.replace(/\u0002/g, '').trim()) chapters.push({ title: chTitle, text, spineIdx: i, spineEnd: i });
  });
  if (!chapters.length) throw new Error('epub spine 为空（无 xhtml 内容可读）');
  return { title: title || cleanTitle(file), author, spine: spineMeta, toc: parseEpubToc(zip, doc, manifest, opfPath, spineMeta), chapters: mergeSmallChapters(chapters), cover };
}

// 解析书自带目录：EPUB2 ncx（spine toc=）→ EPUB3 nav（properties="nav"）→ 空
// 每项：{title, level, spineIdx, anchor}；href 相对目录文件解析后与 spine 归一化匹配
function parseEpubToc(zip, opfDoc, manifest, opfPath, spine) {
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const toc = [];
  const push = (title, baseHref, anchor, level) => {
    const clean = String(title || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 60) return;
    let si = -1;
    const bn = normPath(baseHref);
    for (let i = 0; i < spine.length; i++) {
      if (normPath(spine[i].href) === bn) { si = i; break; }
    }
    toc.push({ title: clean, level: Math.min(3, level), spineIdx: si, anchor: anchor || '' });
  };
  // 1) EPUB2 ncx
  const spineEl = byTag(opfDoc, 'spine')[0];
  const ncxId = spineEl ? spineEl.getAttribute('toc') : '';
  if (ncxId && manifest[ncxId]) {
    const ncxHref = manifest[ncxId].href;
    const ncxDir = ncxHref.includes('/') ? ncxHref.slice(0, ncxHref.lastIndexOf('/')) : '';
    let ncx = '';
    try { ncx = zip.readAsText(normPath(opfDir ? opfDir + '/' + ncxHref : ncxHref)); } catch { /* */ }
    if (ncx) {
      const ncxDoc = new DOMParser().parseFromString(ncx, 'text/xml');
      const navMap = byTag(ncxDoc, 'navMap')[0];
      if (navMap) {
        (function walkNav(el, level) {
          for (const np of Array.from(el.childNodes || [])) {
            if (np.nodeType !== 1 || np.localName !== 'navPoint') continue;
            // 只取当前 navPoint 自己的 navLabel，避免把嵌套小节的标题拼进章标题。
            const navLabel = Array.from(np.childNodes || []).find((n) => n.nodeType === 1 && n.localName === 'navLabel');
            const labelNode = navLabel && Array.from(navLabel.childNodes || []).find((n) => n.nodeType === 1 && n.localName === 'text');
            const label = (labelNode?.textContent || '').trim();
            const content = Array.from(np.childNodes || []).find((n) => n.nodeType === 1 && n.localName === 'content');
            const src = content ? content.getAttribute('src') || '' : '';
            const [base, anchor] = src.split('#');
            // src 规范上相对 ncx 所在目录；个别书相对 OPF 目录 → 两个都试
            const cand1 = normPath(ncxDir ? ncxDir + '/' + base : base);
            const cand2 = normPath(opfDir ? opfDir + '/' + base : base);
            const hit1 = spine.some((s) => normPath(s.href) === cand1);
            push(label, hit1 ? cand1 : cand2, anchor, level);
            const kids = Array.from(np.childNodes || []).filter((k) => k.nodeType === 1 && k.localName === 'navPoint');
            if (kids.length) walkNav(np, level + 1);
          }
        })(navMap, 1);
        if (toc.length) return toc;
      }
    }
  }
  // 2) EPUB3 nav
  const navItem = Object.entries(manifest).find(([, v]) => (v.props || '').includes('nav'));
  if (navItem) {
    const navHref = navItem[1].href;
    const navDir = navHref.includes('/') ? navHref.slice(0, navHref.lastIndexOf('/')) : '';
    let html = '';
    try { html = zip.readAsText(normPath(opfDir ? opfDir + '/' + navHref : navHref)); } catch { /* */ }
    if (html) {
      const navDoc = new DOMParser().parseFromString(html, 'text/html');
      const navs = byTag(navDoc, 'nav');
      const nav = navs.find((n) => ((n.getAttribute('epub:type') || '') + ' ' + (n.getAttribute('type') || '')).includes('toc')) || navs[0];
      if (nav) {
        // 标准 EPUB3 目录结构为 nav > ol > li（li 下可再嵌套 ol）
        (function walkNav(el, level) {
          for (const nd of Array.from(el.childNodes || [])) {
            if (nd.nodeType !== 1) continue;
            if (nd.localName === 'ol') { walkNav(nd, level); continue; }
            if (nd.localName !== 'li') continue;
            const a = byTag(nd, 'a')[0];
            if (a) {
              const href = a.getAttribute('href') || '';
              const [base, anchor] = href.split('#');
              push(a.textContent, normPath(navDir ? navDir + '/' + base : base), anchor, level);
            }
            const ol = Array.from(nd.childNodes || []).find((k) => k.nodeType === 1 && k.localName === 'ol');
            if (ol) walkNav(ol, level + 1);
          }
        })(nav, 1);
        if (toc.length) return toc;
      }
    }
  }
  return [];
}

function mergeSmallChapters(chapters, min = 260) {
  const out = [];
  for (const ch of chapters) {
    const last = out[out.length - 1];
    if (last && last.text.length < min) { last.text += '\n\n' + ch.text; last.spineEnd = ch.spineIdx; }
    else out.push({ ...ch });
  }
  return out;
}

// 文本按标题切章（md/txt/pdf）
function splitByHeadings(text) {
  const lines = text.split(/\r?\n/);
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEAD_RE.test(lines[i])) heads.push({ at: i, title: lines[i].replace(/^#+\s*/, '').trim() });
  }
  if (heads.length >= 2) {
    return heads.map((h, i) => ({
      title: h.title,
      text: lines.slice(h.at, i + 1 < heads.length ? heads[i + 1].at : undefined).join('\n').trim(),
    })).filter((c) => c.text.length > 40);
  }
  return null;
}

function chunkText(text) {
  const out = [];
  for (let i = 0; i < text.length; i += CHUNK) {
    const seg = text.slice(i, i + CHUNK);
    out.push({ title: `第 ${out.length + 1} 部分`, text: seg });
  }
  return out;
}

// _chapters/ 目录：文件即章节（ch01.txt / 01.md …）
function parseChapterDir(dir) {
  const files = fs.readdirSync(dir).filter((f) => /\.(txt|md)$/i.test(f)).sort(byNameNum);
  const chapters = files.map((f, i) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').trim();
    const first = text.split(/\r?\n/)[0].replace(/^#+\s*/, '').replace(/[“”"]/g, '').trim();
    return { title: first && first.length <= 30 ? first : `第 ${i + 1} 章`, text };
  }).filter((c) => c.text.length > 40);
  return chapters;
}

// ---------- PDF：目录页 → 两级章节（篇/Part → 课/章） ----------
// 清理页眉页脚：-- 1 of 141 -- / - 12 - / 独立数字行 / 横线
function cleanPdfText(t) {
  return String(t)
    .replace(/^\s*[-–—·•]?\s*\d{1,4}\s*(of|\/)\s*\d{1,4}\s*[-–—·•]?\s*$/gim, '')
    .replace(/^\s*[-–—·•]{1,3}\s*\d{1,4}\s*[-–—·•]{1,3}\s*$|^\s*\d{1,4}\s*$/gm, '')
    .replace(/^\s*[-–—·•\u2500\u2015]{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

// 标题行模式（章节切分用）：
const HEAD_RE = /^\s*(#{1,3}\s+)?(第\s*[一二三四五六七八九十百千0-9]+\s*[章节回部篇卷讲]\s*[^\n]{0,26}|[一二三四五六七八九十百千]+、[^\n]{0,30}|(Part|Chapter|Lesson|Section)\s*[0-9IVX]+\s*[^\n]{0,26}|(前言|序言?|自序|后记|尾声|引言|导语|附录)[\s:：]?[^\n]{0,20})\s*$/i;

// 去除每页重复出现的页眉/页脚/版权行（出现 ≥30% 页数的短行）
function stripRepeatedHeaders(pageTexts) {
  const freq = new Map();
  const rows = pageTexts.map((p) => p.split(/\r?\n/));
  for (const rs of rows) {
    for (const r of rs) {
      const t = r.trim();
      if (t && t.length <= 60) freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  const thresh = Math.max(3, Math.floor(rows.length * 0.3));
  const repeated = new Set([...freq].filter(([, n]) => n >= thresh).map(([t]) => t));
  if (!repeated.size) return pageTexts;
  return rows.map((rs) => rs.filter((r) => !repeated.has(r.trim())).join('\n'));
}

// 目录行形如："第一课 学习社会化的底层逻辑 ....... 8" 或 "Part1 基础认知篇 ....... 8"
function parseToc(pages) {
  const raw = pages.slice(0, 15).join('\n');
  const lines = raw.split(/\r?\n/);
  const entries = [];
  for (const line of lines) {
    const m = line.match(/^(\s*)(.{2,44}?)[.…·—\s]{4,}(\d{1,3})\s*$/);
    if (!m || !m[2]) continue;
    const page = Number(m[3]);
    if (page < 3 || page > 600) continue; // 目录页自身/异常页码剔除
    const title = m[2].trim();
    if (!title || /^目录$/.test(title) || /[\u4e00-\u9fa5]{4,}$/ && title.length < 2) continue;
    entries.push({ title, page, indent: m[1].length });
  }
  if (entries.length < 5) return null; // 目录太少，视为无目录
  // 层级：缩进差 ≥2 空格 → 两级；否则用标题形态判定
  const hasIndent = entries.filter((e) => e.indent >= 2).length >= 3 && Math.min(...entries.map((e) => e.indent)) === 0;
  const levelOf = (e) => {
    if (hasIndent) return e.indent >= 2 ? 2 : 1;
    return /^(Part|Chapter|前言|序|后记|附|第[一二三四五六七八九十百0-9]+[部分篇])/i.test(e.title) ? 1 : 2;
  };
  return entries.map((e, i) => ({ ...e, level: levelOf(e, i) }));
}

function pdfChapters(pages, title) {
  const toc = parseToc(pages);
  if (toc) {
    const out = [];
    let curParent = ''; // 最近的一个一级条目（Part/篇）——所有子条目回填它
    for (let i = 0; i < toc.length; i++) {
      const e = toc[i];
      if (e.level === 1) curParent = e.title;
      const pi = Math.max(0, Math.min(e.page - 1, pages.length - 1));
      const next = toc[i + 1];
      const endPage = next ? Math.max(0, Math.min(next.page - 1, pages.length - 1)) : pages.length - 1;
      // 逐页收集：每页文本后放该页图 token（\u0002P{n}:{len}\u0002，n 为 1-based 页码，len=该页纯文本字数）
      const parts = [];
      for (let pg = pi; pg <= endPage; pg++) {
        let t = pages[pg] || '';
        if (pg === pi) {
          const at = t.indexOf(e.title);
          if (at >= 0) t = t.slice(at + e.title.length);
        }
        if (pg === endPage && next) {
          const cut = t.indexOf(next.title);
          if (cut > 0) t = t.slice(0, cut);
        }
        if (t.trim()) {
          parts.push(t.trim());
          parts.push(`\u0002P${pg + 1}:${String(t).replace(/\u0002/g, '').length}\u0002`);
        }
      }
      const clean = cleanChapterText(parts.join('\n\n'));
      if (!clean && e.level !== 1) continue;
      out.push({
        title: e.title,
        parent: e.level === 2 ? curParent : '',
        text: clean,
      });
    }
    // 至少要有可读内容
    if (out.filter((c) => c.text.length > 100).length >= 3) return out;
  }
  // 无目录：标题行切分（第X课/章、Part、一二三、）
  const joined = pages.map((p, i) => `${p}\n\n\u0002P${i + 1}:${String(p).replace(/\u0002/g, '').length}\u0002`).join('\n\n');
  const byHead = splitByHeadings(cleanPdfText(joined));
  if (byHead && byHead.length >= 3) return byHead.map((c) => ({ ...c, text: cleanChapterText(c.text) }));
  return chunkText(joined);
}

// 章内文本：去页码残行 + 断行合并 + 按句分段（还原段落感）+ 顶部标题尾巴清理
function cleanChapterText(t) {
  const raw = cleanPdfText(t.replace(/^\s*\d{1,3}\s*$/gm, '')).trim();
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) { if (out[out.length - 1] !== '') out.push(''); continue; }
    const last = out[out.length - 1];
    const isTitle = HEAD_RE.test(s) && s.length <= 40;
    const isNum = /^\d+[.、）]/.test(s) && s.length <= 60; // 编号小标题行（如"2.能量守恒是铁律"）
    // 上一行没以句末标点收尾，且当前行不是标题/编号/数字行/新段落 ⇒ 合并（还原被硬断的句子）
    if (last && last !== '' && !/[。！？；：”、」』）)】…]$/.test(last) && !isTitle && !isNum && !/^\d{1,4}\s*$/.test(s) && !/^\u0002/.test(s)) {
      out[out.length - 1] = last + s;
    } else {
      out.push(s);
    }
  }
  // 章节首行的"标题尾巴"清理：如"一、认知基础 第 0 课 对于社会化的正确认知 所谓社会化…"→ 去掉已知标题样式前缀
  let merged = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  merged = merged.replace(/^\s*(第\s*[0-9一二三四五六七八九十]+课\s*[^\n]{0,30}?)\s*(?=[\u4e00-\u9fa5])/m, '');
  return reflowParagraphs(merged);
}

// 按句分段：句末标点累计 3-4 句成一段（标题/列表/引用/图片 token 独立成段）
function reflowParagraphs(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let buf = [];
  let sent = 0;
  const flush = () => { if (buf.length) { out.push(buf.join('')); buf = []; } sent = 0; };
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) { flush(); continue; }
    if (/^\u0002/.test(s)) { flush(); out.push(s); continue; }                    // 图片 token
    if (/^>/.test(s) || /^[•·]/.test(s)) { flush(); out.push(s); continue; }      // 引用/列表
    if (HEAD_RE.test(s) && s.length <= 40) { flush(); out.push(s); continue; }    // 标题
    if (/^\d+[.、）]/.test(s) && s.length <= 60) { flush(); out.push(s); continue; } // 编号小标题行
    buf.push(s);
    if (/[。！？；…]$/.test(s)) sent++;
    if (sent >= 3 || buf.length >= 5) flush();
  }
  flush();
  return out.join('\n\n');
}

// 统一入口
async function parseBook(def) {
  const ext = path.extname(def.file).toLowerCase();
  if (def.chapterFile) {
    return { title: def.title, author: '', chapters: parseChapterDir(def.chapterFile), cover: null };
  }
  if (ext === '.epub') return parseEpub(def.file, def.id);
  if (ext === '.pdf') {
    // 统一管线：PDF 先自动转成 EPUB（磁盘缓存，按 mtime+size 失效），之后与真 EPUB 一套解析/渲染
    try {
      const epubFile = await convertPdfToEpub(def);
      const parsed = parseEpub(epubFile, def.id);
      parsed.converted = true; // 书架角标仍显示原格式 pdf
      return parsed;
    } catch (err) {
      console.error('[PDF→EPUB 转换失败，退回文字提取]', def.title, err.stack || err.message);
    }
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: fs.readFileSync(def.file) });
    const result = await parser.getText();
    await parser.destroy();
    const pages = Array.isArray(result?.pages) && result.pages.length
      ? stripRepeatedHeaders(result.pages.map((p) => cleanPdfText(typeof p === 'string' ? p : (p && p.text) || '')))
      : [cleanPdfText(result?.text || '')];
    const chapters = pdfChapters(pages, def.title);
    return { title: def.title, author: '', chapters, cover: null };
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: fs.readFileSync(def.file) });
    const byHead = splitByHeadings(value || '');
    return { title: def.title, author: '', chapters: byHead || chunkText(value || ''), cover: null };
  }
  if (ext === '.mobi' || ext === '.azw3') {
    return { title: def.title, author: '', chapters: [], unsupported: true, cover: null };
  }
  // txt / md
  const text = fs.readFileSync(def.file, 'utf8');
  return { title: def.title, author: '', chapters: splitByHeadings(text) || chunkText(text), cover: null };
}

function findBook(id) {
  const book = scanBooks().find((b) => b.id === id);
  return book ? findDef(id) : null;
}

function findDef(id) {
  const ROOT = rootDir();
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    const full = path.join(ROOT, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIR.test(entry.name)) continue;
      const d = bookFromDir(entry.name, full);
      const arr = Array.isArray(d) ? d : d ? [d] : [];
      const hit = arr.find((x) => x.id === id);
      if (hit) return hit;
    } else if (BOOK_EXTS.includes(path.extname(entry.name).toLowerCase())) {
      if (idOf(entry.name) === id) return { id, title: cleanTitle(entry.name), format: path.extname(entry.name).slice(1).toLowerCase(), file: full, chapterFile: null };
    }
  }
  return null;
}

async function getBook(id) {
  const def = findDef(id);
  if (!def) return null;
  const book = await parseBook(def);
  return { ...book, id, format: def.format || path.extname(def.file).slice(1).toLowerCase() };
}

// 从书架删除：删书文件（顶层文件直接删；单书目录整目录删；多书目录只删本文件）+ 转换缓存
function removeBook(id) {
  const ROOT = rootDir();
  const def = findDef(id);
  if (!def || !def.file) return { ok: false, error: '没找到这本书' };
  const parent = path.dirname(def.file);
  if (parent === ROOT) {
    try { fs.unlinkSync(def.file); } catch (err) { if (err.code !== 'ENOENT') return { ok: false, error: '删除文件失败：' + err.message }; }
  } else {
    const bookFiles = fs.readdirSync(parent).filter((f) => BOOK_EXTS.includes(path.extname(f).toLowerCase()));
    if (bookFiles.length <= 1) {
      fs.rmSync(parent, { recursive: true, force: true });
    } else {
      try { fs.unlinkSync(def.file); } catch (err) { if (err.code !== 'ENOENT') return { ok: false, error: '删除文件失败：' + err.message }; }
    }
  }
  const cacheDir = epubDir();
  if (fs.existsSync(cacheDir)) {
    for (const f of fs.readdirSync(cacheDir)) {
      if (f.startsWith(id + '.')) { try { fs.unlinkSync(path.join(cacheDir, f)); } catch { /* 缓存删除失败无碍 */ } }
    }
  }
  return { ok: true };
}

function getCover(id) {
  const def = findDef(id);
  const file = epubFileOf(def); // 转换过的 PDF 也能取封面（若转换产物带封面则生效）
  if (!file) return null;
  try {
    const zip = new AdmZip(file);
    const container = zip.readAsText('META-INF/container.xml');
    const opfPath = (container.match(/<rootfile[^>]*full-path="([^"]+)"/i) || [])[1];
    if (!opfPath) return null;
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
    const normalize = (p) => path.posix.normalize(('/' + String(p).replace(/\\/g, '/').replace(/^\/+/, '')).replace(/\/+/g, '/')).replace(/^\/+/, '');
    const resolve = (href) => normalize(opfDir ? opfDir + '/' + href : href);
    const doc = new DOMParser().parseFromString(zip.readAsText(opfPath), 'text/xml');
    const manifest = {};
    for (const it of byTag(doc, 'item')) {
      manifest[it.getAttribute('id')] = it.getAttribute('href');
    }
    let coverPath = '';
    for (const m of byTag(doc, 'meta')) {
      if ((m.getAttribute('name') || '').toLowerCase() === 'cover' && manifest[m.getAttribute('content')]) { coverPath = manifest[m.getAttribute('content')]; break; }
      if ((m.getAttribute('property') || '').toLowerCase() === 'cover-image') { coverPath = m.getAttribute('content'); break; }
    }
    if (!coverPath) return null;
    return zip.readFile(resolve(coverPath));
  } catch { return null; }
}

// ---------- mupdf 懒打开（PDF 页图 / 书签 / 文字层共用） ----------
async function openMupdf(file) {
  if (!mupdfDoc || mupdfDoc.file !== file) {
    const mupdf = (await import('mupdf')).default;
    mupdfDoc = { file, mupdf, doc: mupdf.Document.openDocument(file, 'application/pdf') };
  }
  return mupdfDoc;
}

// PDF 页数 + 每页渲染像素尺寸（磁盘缓存，前端滚动容器用 aspect-ratio 预占位，避免布局跳动）
async function pdfInfo(def) {
  const fp = path.join(imgDir(), 'pdf', def.id, 'info.json');
  try {
    const st = fs.statSync(def.file);
    if (fs.existsSync(fp)) {
      const saved = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (saved.mtimeMs === st.mtimeMs && saved.size === st.size && saved.pageCount) return saved;
    }
  } catch { /* 重新生成 */ }
  const { doc } = await openMupdf(def.file);
  const pageCount = doc.countPages();
  const dims = [];
  for (let i = 0; i < pageCount; i++) {
    const b = doc.loadPage(i).getBounds();
    dims.push({ w: Math.round((b[2] - b[0]) * PDF_SCALE), h: Math.round((b[3] - b[1]) * PDF_SCALE) });
  }
  const info = { mtimeMs: fs.statSync(def.file).mtimeMs, size: fs.statSync(def.file).size, pageCount, dims };
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(info));
  return info;
}

// PDF 自带书签树 → 目录（页码转 1-based 显示页）；无书签返回 null
async function pdfOutline(def) {
  try {
    const { doc } = await openMupdf(def.file);
    const raw = doc.loadOutline();
    if (!raw || !raw.length) return null;
    const out = [];
    (function walk(items, arr) {
      for (const it of items) {
        const node = { title: String(it.title || '').trim().slice(0, 60), page: (it.page ?? 0) + 1 };
        if (it.down && it.down.length) { node.children = []; walk(it.down, node.children); }
        arr.push(node);
      }
    })(raw, out);
    return out.length ? out : null;
  } catch { return null; }
}

// 目录页解析出的章节 → 目录项（页号取自每章第一个页图 token）
function outlineFromChapters(chapters) {
  const items = [];
  for (const c of chapters) {
    if (!c.text) continue;
    const m = String(c.text).match(/\u0002P(\d+):/);
    if (!m) continue;
    items.push({ title: c.title, page: Number(m[1]), level: c.parent ? 2 : 1 });
  }
  return items;
}

// 印刷页码 → 真实页码偏移校正：取前几条标题在真实页面上搜索，用中位偏移统一修正
async function correctOutlinePages(def, items) {
  try {
    const { doc } = await openMupdf(def.file);
    const count = doc.countPages();
    const deltas = [];
    for (const it of items.slice(0, 4)) {
      const t = String(it.title).replace(/\s+/g, '').slice(0, 10);
      if (t.length < 3) continue;
      for (let i = Math.max(0, it.page - 6); i < Math.min(count, it.page + 8); i++) {
        let hits;
        try { hits = doc.loadPage(i).search(t); } catch { continue; }
        if (hits && hits.length) { deltas.push(i + 1 - it.page); break; }
      }
    }
    if (!deltas.length) return items;
    deltas.sort((a, b) => a - b);
    const delta = deltas[Math.floor(deltas.length / 2)];
    if (!delta) return items;
    return items.map((it) => ({ ...it, page: Math.max(1, Math.min(count, it.page + delta)) }));
  } catch { return items; }
}

// ---------- 图片输出：PDF 页面渲染（mupdf WASM，懒渲染+磁盘缓存）/ epub 内嵌图 ----------
async function pagePng(id, n1) { // n1: 1-based 页码
  const def = findDef(id);
  if (!def || !def.file.toLowerCase().endsWith('.pdf')) return null;
  const fp = path.join(imgDir(), 'pdf', id, `p${n1}.png`);
  if (fs.existsSync(fp)) return fs.readFileSync(fp);
  const { mupdf, doc } = await openMupdf(def.file);
  const page = doc.loadPage(n1 - 1);
  const pix = page.toPixmap(mupdf.Matrix.scale(PDF_SCALE, PDF_SCALE), mupdf.ColorSpace.DeviceRGB, false, true);
  const buf = Buffer.from(pix.asPNG());
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, buf);
  return buf;
}

// PDF 页透明文字层：mupdf 结构化文本（字符级坐标）→ 页图像素坐标的行级 JSON（磁盘缓存）
// 坐标约定：getBounds()/stext 均为 PDF 空间（y 向上），PNG 像素 y 向下 → py = (pageH - pdfY) * S
async function pageStructuredText(id, n1) {
  const def = findDef(id);
  if (!def || !def.file.toLowerCase().endsWith('.pdf')) return null;
  const fp = path.join(imgDir(), 'pdf', id, `p${n1}.json`);
  if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  const { doc } = await openMupdf(def.file);
  const page = doc.loadPage(n1 - 1);
  const b = page.getBounds();
  const st = page.toStructuredText();
  const lines = [];
  let cur = null;
  st.walk({
    beginLine(bbox) { cur = { x0: bbox[0], y0: bbox[1], x1: bbox[2], y1: bbox[3], size: 0, chars: [] }; },
    onChar(c, origin, font, size) {
      if (!cur) return;
      cur.chars.push(c);
      if (size > cur.size) cur.size = size;
    },
    endLine() {
      if (cur && cur.chars.length) lines.push(cur);
      cur = null;
    },
  });
  const out = {
    w: Math.round((b[2] - b[0]) * PDF_SCALE),
    h: Math.round((b[3] - b[1]) * PDF_SCALE),
    lines: lines.filter((l) => l.chars.some((c) => /\S/.test(c))).map((l) => ({
      x: +((l.x0 - b[0]) * PDF_SCALE).toFixed(1),
      y: +((b[3] - l.y1) * PDF_SCALE).toFixed(1),
      w: +((l.x1 - l.x0) * PDF_SCALE).toFixed(1),
      h: +((l.y1 - l.y0) * PDF_SCALE).toFixed(1),
      s: +(l.size * PDF_SCALE).toFixed(1),
      t: l.chars.join(''),
    })),
  };
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(out));
  return out;
}

function getBookImg(id, key) { // key: md5_ext
  const fp = path.join(imgDir(), 'epub', id, 'i' + key);
  if (!fs.existsSync(fp)) return null;
  const ext = key.split('_').pop() || 'jpg';
  const type = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' })[ext] || 'image/jpeg';
  return { buf: fs.readFileSync(fp), type };
}

// ---------- PDF → EPUB 自动转换 ----------
// 思路来自 reader.zip 的 convert_social_guide.py 并泛化：
//   按行提取（字号/横坐标/纵坐标）→ 过滤页眉页脚水印 → 字号+模式识别标题层级
//   → 缩进判断段落起点 + 中英混排无缝拼段（消除断行与跨页断段）→ 组装章节 → 打包标准 EPUB3
function joinWrapped(left, right) {
  left = String(left).replace(/\s+$/, '');
  right = String(right).replace(/^\s+/, '');
  if (!left) return right;
  const a = left.slice(-1), b = right.slice(0, 1);
  if (/[A-Za-z0-9]/.test(a) && /[A-Za-z0-9]/.test(b)) return left + ' ' + right;
  return left + right;
}

async function pdfExtractLines(doc, pageCount) {
  const lines = [];
  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    const b = page.getBounds(); // [x0,y0,x1,y1] y 向上
    const ph = b[3] - b[1];
    const st = page.toStructuredText();
    let cur = null;
    st.walk({
      beginLine(bbox) { cur = { x0: bbox[0], y1: bbox[3], size: 0, chars: [] }; },
      onChar(c, origin, font, size) { if (!cur) return; cur.chars.push(c); if (size > cur.size) cur.size = size; },
      endLine() {
        if (cur && cur.chars.some((c) => /\S/.test(c))) {
          const text = cur.chars.join('').trim();
          if (text) lines.push({ page: i + 1, ph, x0: cur.x0, top: ph - (cur.y1 - b[1]), size: cur.size, text });
        }
        cur = null;
      },
    });
  }
  return lines;
}

// 组装段落块：kind ∈ h1|h2|bullet|num|para
function assembleBlocks(lines, opts = {}) {
  const { bodySize, leftEdge } = opts;
  const indentThresh = bodySize * 1.35;
  // 段内行距众数（同页相邻行 top 差，仅统计行级常规间隔）；段落间距明显加大 → 新段
  const gapHist = new Map();
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    if (a.page !== b.page) continue;
    const gap = b.top - a.top;
    if (gap <= 0 || gap > bodySize * 2.2) continue;
    const k = Math.round(gap);
    gapHist.set(k, (gapHist.get(k) || 0) + 1);
  }
  let gapMode = bodySize * 1.9, gb = -1;
  for (const [k, v] of gapHist) if (v > gb) { gb = v; gapMode = k; }
  const gapThresh = gapMode * 1.28;
  const blocks = [];
  let cur = null;
  let prev = null;
  const flush = () => { if (cur && cur.text.trim()) blocks.push(cur); cur = null; };
  const classify = (t, s) => {
    if (s >= bodySize * 1.42 && t.length <= 50) return 'h1';
    if (/^(Part\s*\d+|第[一二三四五六七八九十百千\d]+\s*[部分篇])([\s：:].*)?$/i.test(t) && t.length <= 40) return 'h1';
    if (s >= bodySize * 1.16 && t.length <= 50 && !/[，。；：,]$/.test(t)) return 'h2';
    if (/^第[一二三四五六七八九十百千\d]+\s*[课章节讲]/.test(t) && t.length <= 60 && !/[，。；：!?！？]$/.test(t)) return 'h2';
    if (/^[一二三四五六七八九十百]+[、.．]\S+/.test(t) && t.length <= 34) return 'h2';
    if (/^[·•●○◆▪]/.test(t)) return 'bullet';
    if (/^[①②③④⑤⑥⑦⑧⑨⑩]/.test(t) || /^[（(]\d+[）)]/.test(t) || /^\d{1,2}[、](?!\d)/.test(t)) return 'num';
    return 'para';
  };
  for (const ln of lines) {
    const kind = classify(ln.text, ln.size);
    if (kind === 'h1' || kind === 'h2') { flush(); blocks.push({ kind, text: ln.text }); prev = ln; continue; }
    // 同一物理行被切开的右半残片（同页、y 差 <1.5pt、x0 右移）：直接拼回当前块，不视为新段
    const residual = prev && prev.page === ln.page
      && Math.abs(ln.top - prev.top) < 1.5
      && ln.x0 >= leftEdge + indentThresh * 0.5;
    if (residual && cur) { cur.text = joinWrapped(cur.text, ln.text); prev = ln; continue; }
    // bullet / num 的无缩进续行归并回原列表项（x0 回落且无新的列表符号）
    const listCont = cur
      && (cur.kind === 'bullet' || cur.kind === 'num')
      && kind === 'para'
      && ln.x0 < leftEdge + indentThresh;
    // 行距突变（仅同页相邻行；跨页行距不可靠，不参与判定）
    const gapNew = cur && prev && prev.page === ln.page
      && ln.top - prev.top >= gapThresh;
    let newBlock = !cur;
    if (!listCont) {
      if (kind !== cur?.kind) newBlock = true;
      else newBlock = ln.x0 >= leftEdge + indentThresh || gapNew;
    }
    if (newBlock) {
      flush();
      cur = { kind, text: ln.text };
    } else {
      cur.text = joinWrapped(cur.text, ln.text);
    }
    prev = ln;
  }
  flush();
  return blocks;
}

// 块 → 章节（h1 开新部并作为自身章；h2 开新章挂到当前部下）
function chaptersFromBlocks(blocks, fallbackTitle) {
  const chapters = [];
  let curPartTitle = '';
  let cur = null;
  const close = () => { if (cur) chapters.push(cur); cur = null; };
  for (const b of blocks) {
    if (b.kind === 'h1') { close(); curPartTitle = b.text; cur = { title: b.text, level: 1, part: '', blocks: [] }; continue; }
    if (b.kind === 'h2') { close(); cur = { title: b.text, level: curPartTitle ? 2 : 1, part: curPartTitle, blocks: [] }; continue; }
    if (!cur) cur = { title: fallbackTitle, level: 1, part: '', blocks: [] };
    cur.blocks.push(b);
  }
  close();
  // 单章过长兜底切分
  const out = [];
  for (const ch of chapters) {
    const len = ch.blocks.reduce((s, b) => s + b.text.length, 0);
    if (len <= 6500) { out.push(ch); continue; }
    let piece = { title: ch.title, level: ch.level, part: ch.part, blocks: [] };
    let n = 0;
    for (const b of ch.blocks) {
      piece.blocks.push(b);
      if (piece.blocks.reduce((s, x) => s + x.text.length, 0) >= 3200) {
        n += 1;
        out.push({ ...piece, title: `${ch.title}（${n}）` });
        piece = { title: ch.title, level: ch.level, part: ch.part, blocks: [] };
      }
    }
    if (piece.blocks.length) out.push({ ...piece, title: n > 0 ? `${ch.title}（${n + 1}）` : ch.title });
  }
  if (!out.length) out.push({ title: fallbackTitle, level: 1, part: '', blocks });
  return out;
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// 极简 ZIP 写入器：首条目 mimetype 需 STORED（EPUB 规范），其余 deflate
function writeEpubZip(entries, outFile) {
  const zlib = require('node:zlib');
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    let method = 0, payload = data;
    if (!e.store && data.length) { method = 8; payload = zlib.deflateRawSync(data, { level: 9 }); }
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0x4800, 10); lh.writeUInt16LE(0x5A21, 12); // 固定 DOS 时间
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    chunks.push(lh, nameBuf, payload);
    central.push({ nameBuf, crc, method, csize: payload.length, usize: data.length, offset });
    offset += lh.length + nameBuf.length + payload.length;
  }
  const cdStart = offset;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(c.method, 10);
    ch.writeUInt16LE(0x4800, 12); ch.writeUInt16LE(0x5A21, 14);
    ch.writeUInt32LE(c.crc, 16);
    ch.writeUInt32LE(c.csize, 20);
    ch.writeUInt32LE(c.usize, 24);
    ch.writeUInt16LE(c.nameBuf.length, 28);
    ch.writeUInt32LE(c.offset, 42);
    chunks.push(ch, c.nameBuf);
    offset += ch.length + c.nameBuf.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  fs.writeFileSync(outFile, Buffer.concat([...chunks, eocd]));
}

async function convertPdfToEpub(def) {
  const CONV_VERSION = 5; // 启发式规则调整时递增，失效旧缓存
  const outDir = epubDir();
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, def.id + '.epub');
  const metaFile = outFile + '.json';
  const srcStat = fs.statSync(def.file);
  if (fs.existsSync(outFile) && fs.existsSync(metaFile)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (m.version === CONV_VERSION && m.mtimeMs === srcStat.mtimeMs && m.size === srcStat.size) return outFile;
    } catch { /* 重新生成 */ }
  }
  const t0 = Date.now();
  const { doc } = await openMupdf(def.file);
  const pageCount = doc.countPages();
  const allLines = await pdfExtractLines(doc, pageCount);

  // 正文统计：主字号（按字符数加权众数）+ 主左边距
  const sizeHist = new Map();
  for (const l of allLines) {
    const k = Math.round(l.size * 2) / 2;
    sizeHist.set(k, (sizeHist.get(k) || 0) + l.text.length);
  }
  let bodySize = 12, best = -1;
  for (const [k, v] of sizeHist) if (v > best) { best = v; bodySize = k; }
  const bodyLines = allLines.filter((l) => Math.abs(l.size - bodySize) < 1);
  const xHist = new Map();
  for (const l of bodyLines) {
    const k = Math.round(l.x0 / 2) * 2;
    xHist.set(k, (xHist.get(k) || 0) + 1);
  }
  // 正文左边距 = 首个占用 ≥4% 的最小 x0 簇（避免"段首缩进型排版"把众数带偏到缩进值）
  const xEntries = [...xHist.entries()].sort((a, b) => a[0] - b[0]);
  const xTotal = bodyLines.length || 1;
  let leftEdge = xEntries.length ? xEntries[0][0] : 80;
  for (const [k, v] of xEntries) {
    if (v >= xTotal * 0.04) { leftEdge = k; break; }
  }

  // 页眉/页脚/水印过滤：跨多数页面重复出现的短行；极端边距的纯数字行
  const pageCountByKey = new Map();
  for (const l of allLines) {
    if (l.text.length > 30) continue;
    const k = l.text.replace(/\s+/g, '');
    if (!pageCountByKey.has(k)) pageCountByKey.set(k, new Set());
    pageCountByKey.get(k).add(l.page);
  }
  const repeated = new Set();
  for (const [k, pages] of pageCountByKey) {
    if (pages.size >= Math.max(6, pageCount * 0.25)) repeated.add(k);
  }
  const lines = allLines.filter((l) => {
    if (l.size < bodySize * 0.85) return false; // 页眉/水印等小字行直接剔除
    if (repeated.has(l.text.replace(/\s+/g, ''))) return false;
    if (/^\d{1,4}$/.test(l.text) && (l.top < l.ph * 0.07 || l.top > l.ph * 0.93)) return false;
    return true;
  });

  // 封面页 + 书内目录页跳过：封面≈文字极少；目录页≈大量「标题…数字」短行
  const byPage = new Map();
  for (const l of lines) {
    if (!byPage.has(l.page)) byPage.set(l.page, []);
    byPage.get(l.page).push(l);
  }
  const skipPages = new Set();
  for (const [pn, ls] of byPage) {
    const total = ls.reduce((s, l) => s + l.text.length, 0);
    if (pn <= 3 && total < 120) { skipPages.add(pn); continue; }
    if (pn <= 12 && ls.length >= 8) {
      // 目录页特征：「短标题 +（点线/空白）+ 页码」的行占多数
      const tocLike = ls.filter((l) => /^.{2,36}[\u3000 .·…]{2,}\d{1,4}$/.test(l.text) && !/[。，；：？！、]$/.test(l.text)).length;
      if (tocLike >= ls.length * 0.5) skipPages.add(pn);
    }
  }
  const contentLines = lines.filter((l) => !skipPages.has(l.page));

  const blocks = assembleBlocks(contentLines, { bodySize, leftEdge });
  const title = cleanTitle(def.title || def.file);
  const chapters = chaptersFromBlocks(blocks, title);

  // 打包 EPUB3
  const esc = xmlEsc;
  const chapterFiles = chapters.map((ch, i) => {
    const body = [`<h1>${esc(ch.title)}</h1>`];
    for (const b of ch.blocks) {
      if (b.kind === 'h2') body.push(`<h2>${esc(b.text)}</h2>`);
      else if (b.kind === 'bullet') body.push(`<p class="bullet">${esc(b.text)}</p>`);
      else if (b.kind === 'num') body.push(`<p class="num">${esc(b.text)}</p>`);
      else if (b.text.trim()) body.push(`<p>${esc(b.text)}</p>`);
    }
    const xhtml = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN" xml:lang="zh-CN">\n<head><meta charset="utf-8"/><title>${esc(ch.title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>\n<body>\n${body.join('\n')}\n</body>\n</html>`;
    return { name: `OEBPS/ch${i + 1}.xhtml`, data: xhtml };
  });
  // nav 嵌套：level1 为父节点，后续连续 level2 归入其下
  const navItems = [];
  chapters.forEach((ch, i) => {
    const href = `ch${i + 1}.xhtml`;
    if (ch.level === 1 || !navItems.length) navItems.push({ title: ch.title, href, children: [] });
    else navItems[navItems.length - 1].children.push({ title: ch.title, href });
  });
  const navLi = (items) => items.map((it) => {
    const kids = it.children || [];
    return `    <li><a href="${esc(it.href)}">${esc(it.title)}</a>${kids.length ? `\n    <ol>\n${navLi(kids)}\n    </ol>\n    </li>` : '</li>'}`;
  }).join('\n');
  const navXhtml = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN" xml:lang="zh-CN">\n<head><meta charset="utf-8"/><title>目录</title></head>\n<body>\n  <nav epub:type="toc" id="toc">\n    <h2>目录</h2>\n    <ol>\n${navLi(navItems)}\n    </ol>\n  </nav>\n</body>\n</html>`;
  const opf = `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="zh-CN">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:identifier id="uid">urn:uuid:${def.id}</dc:identifier>\n    <dc:title>${esc(title)}</dc:title>\n    <dc:language>zh-CN</dc:language>\n    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>\n  </metadata>\n  <manifest>\n    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n    <item id="css" href="styles.css" media-type="text/css"/>\n${chapters.map((_, i) => `    <item id="c${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('\n')}\n  </manifest>\n  <spine>\n${chapters.map((_, i) => `    <itemref idref="c${i + 1}"/>`).join('\n')}\n  </spine>\n</package>`;
  const cssText = `body{margin:0;padding:1.4em 1.6em;line-height:1.9;font-family:Georgia,'Songti SC','Noto Serif SC',serif;color:#2b2924;background:#f8f4eb}\nh1{font-size:1.5em;line-height:1.4;margin:0 0 1em}\nh2{font-size:1.2em;margin:1.6em 0 .6em}\np{margin:.65em 0;text-indent:2em}\np.bullet,p.num{text-indent:0;margin-left:1.4em}\nimg{max-width:100%;height:auto}`;
  const entries = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: `<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>` },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: navXhtml },
    { name: 'OEBPS/styles.css', data: cssText },
    ...chapterFiles,
  ];
  writeEpubZip(entries, outFile);
  fs.writeFileSync(metaFile, JSON.stringify({ version: CONV_VERSION, mtimeMs: srcStat.mtimeMs, size: srcStat.size, chapters: chapters.length, pages: pageCount, skippedPages: [...skipPages], ms: Date.now() - t0 }));
  console.log(`[PDF→EPUB] ${title}: ${pageCount} 页 → ${chapters.length} 章（${Date.now() - t0}ms，跳过目录/封面页 ${[...skipPages].join(',') || '无'}）；导出 ${Math.round(fs.statSync(outFile).size / 1024)}KB`);
  console.log(`[PDF→EPUB] ${title}: ${pageCount} 页 → ${chapters.length} 章（${Date.now() - t0}ms）`);
  return outFile;
}

// 转换产物的 epub 路径（真实 epub 返回原文件；转换过的 pdf 返回生成的 epub；否则 null）
function epubFileOf(def) {
  if (!def) return null;
  if (def.file.toLowerCase().endsWith('.epub')) return def.file;
  const f = path.join(epubDir(), def.id + '.epub');
  return fs.existsSync(f) ? f : null;
}


// ---------- EPUB 原章排版：原始 XHTML 消毒后直出（iframe 渲染），图片/CSS 走 /res 代理 ----------
const RES_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', css: 'text/css', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };

// openEpub(file) → { zip, entrySet, spine: [href...], resolve, manifest }
function openEpub(file) {
  const zip = new AdmZip(file);
  const container = zip.readAsText('META-INF/container.xml');
  const opfPath = (container.match(/<rootfile[^>]*full-path="([^"]+)"/i) || [])[1];
  if (!opfPath) return null;
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const resolve = (href) => normPath(opfDir ? opfDir + '/' + href : href);
  const doc = new DOMParser().parseFromString(zip.readAsText(opfPath), 'text/xml');
  const manifest = {};
  for (const it of byTag(doc, 'item')) manifest[it.getAttribute('id')] = it.getAttribute('href');
  const spine = byTag(doc, 'itemref').map((s) => manifest[s.getAttribute('idref')]).filter(Boolean);
  return { zip, entrySet: new Set(zip.getEntries().map((e) => e.entryName)), spine, resolve, manifest };
}

// 单章正文（剥 html/head/body 壳，资源已重写，适合直接内联到阅读器）
function getSpineContent(id, idx) {
  const def = findDef(id);
  const epub = epubFileOf(def);
  if (!epub) return null;
  try {
    const { zip, entrySet, spine, resolve } = openEpub(epub);
    const href = spine[idx];
    if (!href) return null;
    const chapterFull = resolve(href);
    let html = zip.readAsText(chapterFull);
    if (!html) return null;
    html = sanitizeXhtml(html);
    const dir = chapterFull.includes('/') ? chapterFull.slice(0, chapterFull.lastIndexOf('/')) : '';
    html = rewriteResUrls(html, dir, entrySet, id);
    html = html.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
    const title = firstHeadingOf(html) || '';
    return { title, html };
  } catch { return null; }
}

function firstHeadingOf(html) {
  const m = String(html).match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, '').trim().slice(0, 60);
}

function getChapterRaw(id, idx) {
  const def = findDef(id);
  const epub = epubFileOf(def);
  if (!epub) return null;
  try {
    const { zip, entrySet, spine, resolve } = openEpub(epub);
    const href = spine[idx];
    if (!href) return null;
    const chapterFull = resolve(href);
    let html;
    try { html = zip.readAsText(chapterFull); } catch { return null; }
    html = sanitizeXhtml(html);
    const dir = chapterFull.includes('/') ? chapterFull.slice(0, chapterFull.lastIndexOf('/')) : '';
    html = rewriteResUrls(html, dir, entrySet, id);
    html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, BASE_CSS + '</head>') : BASE_CSS + html;
    return { html };
  } catch { return null; }
}

// 消毒：剥脚本 / 内联事件 / javascript: 伪协议
function sanitizeXhtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

// 相对资源（src/href/xlink:href + 样式内 url()）→ 本地代理路由；dir 为该章所在目录
function rewriteResUrls(html, dir, entrySet, id) {
  return html.replace(/(src|xlink:href|href)\s*=\s*"([^"]*)"/gi, (m, attr, val) => {
    const base = val.trim().split('#')[0];
    if (!base || /^(https?:|data:|mailto:|#)/i.test(base)) return m;
    const norm = normPath(dir ? dir + '/' + base : base);
    return entrySet.has(norm) ? `${attr}="/api/bookshelf/${id}/res?path=${encodeURIComponent(norm)}"` : m;
  }).replace(/url\(\s*["']?([^)"']+)["']?\s*\)/gi, (m, val) => {
    const base = val.trim().split('#')[0];
    if (!base || /^(https?:|data:|#|\/)/i.test(base)) return m;
    const norm = normPath(dir ? dir + '/' + base : base);
    return entrySet.has(norm) ? `url("/api/bookshelf/${id}/res?path=${encodeURIComponent(norm)}")` : m;
  });
}

const BASE_CSS = `<style>
  body{margin:0;padding:28px 34px;background:#fdfbf7;color:#3c342b;font:17px/1.95 Georgia,'Noto Serif SC','Microsoft YaHei',serif;}
  img,svg{max-width:100%;height:auto;}
  h1,h2,h3,h4{line-height:1.45;color:#2f2820;}
  blockquote{border-left:3px solid #c9a86a;background:#f8f3e8;padding:8px 14px;margin:1em 0;color:#6b5b41;}
  p{margin:.7em 0;}
  ::selection{background:#fdec9e;}
  .spine-ch{padding-bottom:2.2em;margin-bottom:2.2em;border-bottom:1px dashed #e4d9c2;}
  .spine-ch:last-child{border-bottom:0;}
</style>`;

// 整本连续排版：全部 spine XHTML 消毒拼接为单文档（目录锚点对应、滚动同步的载体）
function getRawAll(id) {
  const def = findDef(id);
  const epub = epubFileOf(def);
  if (!epub) return null;
  try {
    const { zip, entrySet, spine, resolve } = openEpub(epub);
    const cssParts = [];
    const seenCss = new Set();
    const parts = [];
    spine.forEach((href, i) => {
      const chapterFull = resolve(href);
      let html;
      try { html = zip.readAsText(chapterFull); } catch { return; }
      html = sanitizeXhtml(html);
      const dir = chapterFull.includes('/') ? chapterFull.slice(0, chapterFull.lastIndexOf('/')) : '';
      // 收集样式（按内容去重）→ 统一放 <head>；样式内 url() 一并重写
      html = html.replace(/<style[\s\S]*?<\/style>/gi, (s) => {
        const rew = rewriteResUrls(s, dir, entrySet, id);
        const key = 's' + rew.length + '_' + rew.slice(0, 80);
        if (!seenCss.has(key)) { seenCss.add(key); cssParts.push(rew); }
        return '';
      });
      html = html.replace(/<link[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi, (s) => {
        const hm = s.match(/href\s*=\s*"([^"]*)"/i);
        if (hm && !/^(https?:|data:|#)/i.test(hm[1])) {
          const base = hm[1].trim().split('#')[0];
          const norm = normPath(dir ? dir + '/' + base : base);
          if (entrySet.has(norm)) s = s.replace(hm[0], `href="/api/bookshelf/${id}/res?path=${encodeURIComponent(norm)}"`);
        }
        const key = 'l' + s;
        if (!seenCss.has(key)) { seenCss.add(key); cssParts.push(s); }
        return '';
      });
      // 剥 html/head/body 壳，只留正文内容
      html = rewriteResUrls(html, dir, entrySet, id);
      html = html.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
      parts.push(`<section id="spine-${i}" data-spine="${i}" class="spine-ch">${html}</section>`);
    });
    return { html: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${cssParts.join('\n')}${BASE_CSS}</head><body>${parts.join('\n')}</body></html>` };
  } catch { return null; }
}

// zip 内资源代理（防路径穿越：normalize 后禁止 ..）
function getRes(id, p) {
  const def = findDef(id);
  const epub = epubFileOf(def);
  if (!epub) return null;
  const norm = path.posix.normalize('/' + String(p || '')).replace(/^\/+/g, '');
  if (!norm || norm.includes('..')) return null;
  try {
    const buf = new AdmZip(epub).readFile(norm);
    if (!buf) return null;
    const ext = path.extname(norm).slice(1).toLowerCase();
    return { buf, type: RES_TYPES[ext] || 'application/octet-stream' };
  } catch { return null; }
}

module.exports = { scanBooks, importEpub, importPdf, removeBook, getBook, getCover, pagePng, pageStructuredText, getBookImg, getChapterRaw, getRawAll, getSpineContent, getRes, rootDir };
