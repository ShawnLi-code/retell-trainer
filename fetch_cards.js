// 抓料模块：从 RSS 源抓取文章 → 提取正文 → LLM 筛选 → 自动入库
//
// 两种用法：
//   1. CLI：  node --env-file-if-exists=.env fetch_cards.js [--dry-run] [--max=N]
//   2. 模块： require('./fetch_cards').fetchAndImport(...)  （server.js 手动/定时抓料用）
//
// 说明：
//   - 未配置 LLM_API_KEY 时跳过 AI 筛选，直接入库所有长度合格的条目（慎用）
//   - RSSHub 公共实例不稳定，长期使用建议自建：docker run -p 1200:1200 diygod/rsshub
//   - 在下方 FEEDS 里按需增删源，格式 { name, url }

const db = require('./db');
const { chat, parseJson, isConfigured } = require('./llm');

// ---------- RSS 源配置 ----------
const FEEDS = [
  { name: '故事FM', url: 'https://storyfm.cn/feed/' },
  { name: '少数派', url: 'https://sspai.com/feed' },
  { name: '阮一峰的网络日志', url: 'https://www.ruanyifeng.com/blog/atom.xml' },
  // 自建 RSSHub（http://localhost:1200）后可取消注释，示例路由：
  // { name: '人民日报评论', url: 'http://localhost:1200/people/opinion' },
  // { name: '知乎日报', url: 'http://localhost:1200/zhihu/daily' },
  // { name: '澎湃新闻·思想', url: 'http://localhost:1200/thepaper/featured' },
  // 更多路由查 https://docs.rsshub.app
];

// ---------- 工具 ----------
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripHtml(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// 解析 RSS/Atom XML（够用即可，不引第三方依赖）
function extractItems(xml) {
  const items = [];
  const itemRe = /<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const grab = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const mm = block.match(re);
      return mm ? mm[1].trim() : '';
    };
    const title = stripHtml(grab('title'));
    // 正文：content:encoded > content > description
    let content = grab('content:encoded') || grab('content') || grab('description');
    content = stripHtml(content);
    if (title && content) items.push({ title, content });
  }
  return items;
}

// 已存在检查（按标题去重）
function exists(title) {
  return !!db.listCards().find((c) => c.title === title);
}

// ---------- LLM 筛选 ----------
const filterSystem = `你是一位内容编辑，为"口头复述训练"挑选材料。给你一篇文章的标题和正文，判断它是否适合作为复述练习卡。

适合的标准（按优先级）：
- 语言通俗易懂：现代白话、口语化、普通人一看就懂；**不要**文言文、学术论文、深度技术文章、翻译腔
- 有故事性：完整的小故事、人物经历、生活场景、事件经过，适合讲给别人听
- 或者是有清晰观点的小短文（观点明确、结构清楚）
- 正文长度 300-1500 字
- 内容独立完整、积极有价值；不是广告、营销软文、纯新闻流水账

输出 JSON：{"pass": true或false, "reason": "一句话理由"}`;

async function filterCard(title, content) {
  if (!isConfigured()) return { pass: true, reason: '未配置 LLM，跳过筛选' };
  const raw = await chat(
    [{ role: 'system', content: filterSystem }, { role: 'user', content: `标题：${title}\n\n正文：${content.slice(0, 1500)}` }],
    { json: true, temperature: 0 }
  );
  const r = parseJson(raw);
  return { pass: !!r.pass, reason: String(r.reason || '') };
}

// ---------- 主流程（可被 server.js 调用） ----------
async function fetchAndImport({ dryRun = false, maxPerFeed = 5, onLog = () => {} } = {}) {
  const added = [];
  const skipped = [];

  for (const feed of FEEDS) {
    onLog(`▶ 抓取 ${feed.name} …`);
    let items;
    try {
      const res = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      items = extractItems(await res.text());
    } catch (err) {
      onLog(`  ✗ 抓取失败：${err.message}`);
      continue;
    }
    onLog(`  共 ${items.length} 条，处理前 ${maxPerFeed} 条`);

    for (const item of items.slice(0, maxPerFeed)) {
      if (item.content.length < 300) { skipped.push(`[${feed.name}] 太短：${item.title}`); continue; }
      if (exists(item.title)) { skipped.push(`[${feed.name}] 已存在：${item.title}`); continue; }

      let verdict;
      try {
        verdict = await filterCard(item.title, item.content);
      } catch (err) {
        onLog(`  ✗ 筛选失败：${err.message}`);
        continue;
      }
      if (!verdict.pass) {
        skipped.push(`[${feed.name}] 筛掉：${item.title}（${verdict.reason}）`);
        continue;
      }

      const title = item.title.length > 60 ? item.title.slice(0, 60) + '…' : item.title;
      const content = item.content.slice(0, 1500);
      if (!dryRun) db.createCard({ title, content, source: feed.name });
      added.push(`[${feed.name}] ${title}（${content.length} 字）`);
    }
  }

  return { added, skipped };
}

// ---------- CLI ----------
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const maxPerFeed = Number(process.argv.find((a) => a.startsWith('--max='))?.split('=')[1] || 5);
  const log = (s) => console.log(s);
  const { added, skipped } = await fetchAndImport({ dryRun, maxPerFeed, onLog: log });

  console.log(`\n========== 结果 ==========`);
  console.log(dryRun ? `（dry-run 模式，未入库）\n筛选通过 ${added.length} 条：` : `已入库 ${added.length} 条：`);
  added.forEach((a) => console.log(`  ✓ ${a}`));
  if (skipped.length) {
    console.log(`\n跳过 ${skipped.length} 条：`);
    skipped.slice(0, 10).forEach((s) => console.log(`  - ${s}`));
    if (skipped.length > 10) console.log(`  … 还有 ${skipped.length - 10} 条`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('运行失败：', err.message);
    process.exit(1);
  });
}

// ---------- TED 演讲稿导入 ----------
// TED 官网 transcript 页（SSR HTML）内嵌多语言全文 JSON，无 API key、免登录：
//   https://www.ted.com/talks/<slug>/transcript?language=zh-cn
// 实测可拿到简体中文全文（含时间轴 cues）；无中文时回退英文。

function tedSlugFromUrl(urlOrSlug) {
  const m = String(urlOrSlug).match(/ted\.com\/talks\/([^/?#]+)/);
  return m ? m[1] : String(urlOrSlug).trim();
}

async function fetchTedTranscript(slug, lang = 'zh-cn') {
  const res = await fetch(`https://www.ted.com/talks/${slug}/transcript?language=${lang}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`TED 页面 HTTP ${res.status}`);
  const html = await res.text();

  // 标题：og:title
  const ogTitle = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '';

  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('页面未找到演讲稿数据');
  const data = JSON.parse(m[1]);
  const t = data?.props?.pageProps?.transcriptData?.translation;
  if (!t) throw new Error('该演讲没有此语言的文稿（可能没有中文翻译）');

  const text = (t.paragraphs || [])
    .map((p) => (p.cues || []).map((c) => c.text || '').join('').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n'); // TED 官方段落结构，段落间空行
  const langLabel = t.language?.internalLanguageCode || lang;
  return { slug, text, lang: langLabel, title: ogTitle.replace(/ \| TED(Talk|x)?/i, '').trim() };
}

// 按段落把长稿切成若干张复述练习卡（每卡约 400-500 字，接近 1 分钟档）
function splitIntoCards(title, text, targetLen = 450) {
  const paras = text.split(/(?<=[。！？…])\s*/).map((s) => s.trim()).filter(Boolean);
  const cards = [];
  let buf = [];
  let bufLen = 0;
  for (const p of paras) {
    buf.push(p);
    bufLen += p.length;
    if (bufLen >= targetLen) {
      cards.push(buf.join('\n'));
      buf = [];
      bufLen = 0;
    }
  }
  if (buf.length) cards.push(buf.join('\n'));
  const n = cards.length;
  return cards.map((c, i) => ({
    title: n > 1 ? `${title} · 第${i + 1}/${n}片段` : title,
    content: c,
  }));
}

async function importTed(urlOrSlug, { lang = 'zh-cn', dryRun = false, onLog = () => {} } = {}) {
  const slug = tedSlugFromUrl(urlOrSlug);
  let t;
  try {
    t = await fetchTedTranscript(slug, lang);
    if (!t.text) throw new Error('空文本');
  } catch (err) {
    if (lang !== 'en') {
      onLog(`  ✗ 中文文稿不可用（${err.message}），尝试英文…`);
      t = await fetchTedTranscript(slug, 'en');
    } else {
      throw err;
    }
  }
  const cards = [{ title: t.title || t.slug, content: t.text }]; // 完整素材一张卡，不按时长切分
  onLog(`  《${t.title || t.slug}》${t.lang} 共 ${t.text.length} 字 → ${cards.length} 张卡`);
  const added = [];
  const skipped = [];
  for (const c of cards) {
    if (exists(c.title)) { skipped.push(`已存在：${c.title}`); continue; }
    if (!dryRun) db.createCard({ title: c.title, content: c.content, source: `TED ${t.title || t.slug}`, category: 'ted' });
    added.push(`${c.title}（${c.content.length} 字）`);
  }
  return { added, skipped, talkTitle: t.title || t.slug, lang: t.lang };
}

// ---------- 人民日报数字报 · 评论版导入 ----------
// 数字报（免登录、HTML 可抓）：https://paper.people.com.cn/rmrb/pc/layout/YYYYMM/DD/node_XX.html
// 评论版通常为"第XX版：评论"（工作日约 05 版；周六刊可能无评论版，回退最近 7 天）。
// 文章页：/rmrb/pc/content/YYYYMM/DD/content_xxxxx.html，正文为 <p> 段落。

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 在某一天里找评论版（版面名含"评论"），返回版次号与版面页 HTML
async function findCommentPageOfDay(dayKey /* YYYY-MM-DD */) {
  const [y, mo, dd] = dayKey.split('-');
  const ymd = `${y}${mo}/${dd}`;
  for (let i = 1; i <= 24; i++) {
    const url = `https://paper.people.com.cn/rmrb/pc/layout/${ymd}/node_${String(i).padStart(2, '0')}.html`;
    try {
      const h = await fetchHtml(url);
      const m = h.match(/第\s*(\d{2})\s*版[：: ]*([^<]{0,20})/);
      if (m && m[2].includes('评论')) return { page: i, ymd, layoutHtml: h };
    } catch { /* 该版不存在，跳过 */ }
  }
  return null;
}

function extractRmrbTitle(artHtml) {
  const t1 = (artHtml.match(/<title>([^<]*)<\/title>/) || [])[1];
  if (t1 && t1 !== '人民日报-人民网') return t1.trim();
  const t2 = (artHtml.match(/class="title"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
  if (t2) return t2.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return '';
}

function extractRmrbBody(artHtml) {
  // ① 先整体剥掉 HTML 注释（页面里常把旧模板/源信息藏在注释里）
  const noComments = artHtml.replace(/<!--[\s\S]*?-->/g, '');
  // ② 正文：>30 字、非 class="sec"（作者/来源/版次行）、无脚本、无 URL、无纯数字、无责编行
  const paras = [...noComments.matchAll(/<p([^>]*)>([\s\S]*?)<\/p>/g)]
    .map((m) => ({
      attrs: m[1],
      text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    }))
    .filter(({ attrs, text }) =>
      text.length > 30 &&
      !/class\s*=\s*"sec"/.test(attrs) &&        // 作者/来源/版次行
      !text.includes('http://') && !text.includes('https://') &&
      !text.includes('content +=') && !text.includes('document.') && !text.includes('function') &&
      !/^[\d\s]+$/.test(text) &&
      !text.includes('本版责编') &&
      !text.includes('《人民日报》') &&            // 兜底：来源标注
      !/\(20\d{2}年/.test(text)                    // 兜底：日期版次标注
    );
  return paras.map((p) => p.text).join('\n\n').trim();
}

async function importRmrb({ dryRun = false, onLog = () => {} } = {}) {
  // 1. 从今天往前找最近 7 天内出过评论版的日期
  let found = null;
  for (let back = 0; back < 7; back++) {
    const d = new Date(Date.now() - back * 86400000);
    const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    try {
      found = await findCommentPageOfDay(dayKey);
      if (found) { onLog(`▶ 评论版：${dayKey} 第${String(found.page).padStart(2, '0')}版`); break; }
    } catch (e) { /* 继续往前找 */ }
  }
  if (!found) { onLog('  ✗ 近 7 天未找到评论版'); return { added: [], skipped: [] }; }

  // 2. 提取文章链接（相对路径 -> 绝对）
  const rels = [...found.layoutHtml.matchAll(/href="([^"]*content_[^"]+\.html)"/g)]
    .map((m) => new URL(m[1], `https://paper.people.com.cn/rmrb/pc/layout/${found.ymd}/`).href)
    .filter((u, i, arr) => arr.indexOf(u) === i);
  onLog(`  共 ${rels.length} 篇文章`);

  const added = [];
  const skipped = [];
  const NOISE = ['本版责编', '图片报道', '示意图', '广告', '版面编辑', '致读者'];
  for (const url of rels) {
    try {
      const artHtml = await fetchHtml(url);
      const title = extractRmrbTitle(artHtml);
      const content = extractRmrbBody(artHtml);
      if (!title || content.length < 200) { skipped.push(`无正文：${url.split('/').pop()}`); continue; }
      if (NOISE.some((n) => title.includes(n))) { skipped.push(`噪声跳过：${title}`); continue; }
      if (exists(title)) { skipped.push(`已存在：${title}`); continue; }
      const t = title.length > 50 ? title.slice(0, 50) + '…' : title;
      // 完整评论一张卡，不按时长切分
      if (!dryRun) db.createCard({ title: t, content, source: `人民日报 ${found.ymd} 评论版`, category: 'rmrb' });
      added.push(`${t}（${content.length} 字）`);
    } catch (err) {
      skipped.push(`抓取失败：${url.split('/').pop()}（${err.message}）`);
    }
  }
  return { added, skipped };
}

// ---------- 每日短评：人民网观点频道（人民快评/壹时评等栏目） ----------
const SHORT_MIN = 300;   // 太短的不要（残稿）
const SHORT_MAX = 1400;  // 短评档上限（观点频道实际文章 1300-1900，短评优先收）
const SHORT_WINDOW_DAYS = 7;

async function fetchHtml(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// 页脚/元数据噪声段（人民网页面尾部固定出现）
const PEOPLE_NOISE = /举报|邮箱|许可证|京ICP|京公网安备|网安备|www\.people|Copyright|版权所有|人民日报社概况|广播电视节目制作|信息网络传播视听|网络文化经营|网站声明|广告服务|运营服务|合作加盟|招聘英才|报社招聘|数据服务|网站律师|信息保护|人民\s*网\s*股\s*份/;

function extractPeopleComment(artHtml) {
  // 页面标题为纯文本 h1（可能 HTML 里有多个 h1，取第一个非空文本标题）
  const title = [...artHtml.matchAll(/<h1[^>]*>([^<]{4,120})<\/h1>/g)].map((m) => m[1].trim()).find(Boolean) || '';
  const col = (artHtml.match(/&gt;&gt;<a[^>]*>([^<]{2,12})<\/a>\s*<\/div>/) || [])[1]?.trim() || '观点频道';
  // 正文：rm_txt 容器内的 <p>，先切断页脚区，再逐段过滤噪声
  const start = artHtml.indexOf('layout rm_txt');
  let seg = start >= 0 ? artHtml.slice(start) : artHtml;
  seg = seg.split('人民日报社概况')[0] || seg;
  const paras = [...seg.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .map((s) => s.replace(/[（(]\s*(?:执笔|作者|作者单位)[：:][\s\S]*?[）)]\s*$/g, '').trim())
    .filter((s) => s.length > 20 && s.length < 2000 && !PEOPLE_NOISE.test(s));
  return { title, column: col, content: paras.join('\n\n').trim() };
}

async function importDailyShort({ dryRun = false, onLog = () => {} } = {}) {
  const added = [];
  const skipped = [];
  const cutoff = Date.now() - SHORT_WINDOW_DAYS * 24 * 3600 * 1000;
  const indexHtml = await fetchHtml('http://opinion.people.com.cn/');
  // URL 形如 http://opinion.people.com.cn/n1/2026/0716/c223228-40762003.html（年月日 2026 + 月日 4 位）
  const links = [...new Set([...indexHtml.matchAll(/href="([^"]*n1\/2026\/\d{4}\/[^"]+\.html)"[^>]*/g)].map((m) => m[1]))];
  onLog(`观点频道候选 ${links.length} 篇`);

  for (const href of links) {
    const url = href.startsWith('http') ? href : 'http://opinion.people.com.cn' + href;
    const dm = url.match(/n1\/(\d{4})\/(\d{2})(\d{2})\//);
    if (dm) {
      const d = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
      if (d.getTime() < cutoff) { skipped.push(`超窗口：${url.slice(-30)}`); continue; }
    }
    try {
      const html = await fetchHtml(url);
      const { title, column, content } = extractPeopleComment(html);
      if (!title || content.length < SHORT_MIN) { skipped.push(`太短/无题：${title || url.slice(-28)}`); continue; }
      if (content.length > SHORT_MAX) { skipped.push(`超长短评：${title.slice(0, 24)}（${content.length}字）`); continue; }
      if (exists(title)) { skipped.push(`已存在：${title.slice(0, 24)}`); continue; }
      if (!dryRun) db.createCard({ title, content, source: `人民网观点频道·${column} ${url.slice(url.indexOf('n1/') + 3, url.indexOf('n1/') + 13)}`, category: 'short' });
      added.push(`${title.slice(0, 28)}（${content.length} 字）`);
    } catch (err) {
      skipped.push(`抓取失败：${url.slice(-26)}（${err.message}）`);
    }
  }
  onLog(`短评新增 ${added.length}，跳过 ${skipped.length}`);
  return { added, skipped };
}

/** 粘贴/URL 导入短评：{url} 自动提取标题正文，或 {title, content}（content 可为全文或正文）直接存卡 */
async function importShort({ url = '', title = '', content = '', source = '', onLog = () => {} } = {}) {
  let final = { title, content, source };
  if (url) {
    const html = await fetchHtml(url);
    const ex = extractPeopleComment(html); // 人民网模板提取
    if (ex.content.length < 100) {
      // 通用兜底：body 段落提取（含噪声过滤：链接/邮箱/版权/许可证行）
      const ps = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
        .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
        .filter((s) => s.length > 20 && !PEOPLE_NOISE.test(s) && !/https?:\/\/|www\.|@|[0-9A-Z]{4,}.*许可证/.test(s));
      final.content = ps.join('\n\n');
    } else {
      final.content = ex.content;
    }
    if (!final.title) final.title = ex.title || (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.split('-')[0].trim() || '未命名短评';
    if (!final.source) final.source = `粘贴导入 ${url}`;
  }
  const body = String(final.content || '').trim();
  if (body.length < 50) throw new Error('正文太短，无法保存');
  if (exists(final.title)) throw new Error(`《${final.title}》已在素材库中`);
  db.createCard({ title: final.title || '未命名短评', content: body, source: final.source || '手动导入', category: 'short' });
  onLog(`已保存《${final.title}》（${body.length} 字）`);
  return { title: final.title, len: body.length };
}

module.exports = { fetchAndImport, FEEDS, importTed, tedSlugFromUrl, importRmrb, extractRmrbBody, importDailyShort, importShort };
