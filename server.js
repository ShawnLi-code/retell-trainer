// 复述训练场 · 服务入口
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const db = require('./db');
const { chat, parseJson, isConfigured, healthCheck } = require('./llm');
const prompts = require('./prompts');
const { fetchAndImport, reprocessFeedCards, getFeedHealth, importTed, importRmrb, importDailyShort, importShort } = require('./fetch_cards');
const shelf = require('./bookshelf');
const interviewTrainer = require('./interview-trainer');

// 口语词词库：收尾报告时扫描命中（识别口语词/语气词/口头禅并给替换建议）
const WORD_BANK = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'wordbank.json'), 'utf8')).words || [];
  } catch {
    return [];
  }
})();

function spokenAuditOf(texts) {
  // 合并所有用户发言，统计命中词与次数；单字词需独立成词（避免"太行"命中"行"、"对着"命中"对"）
  const joined = texts.join('\n');
  const hits = [];
  for (const w of WORD_BANK) {
    let count = 0;
    if ([...w.word].length === 1) {
      const re = new RegExp(`(?<![\\u4e00-\\u9fa5])${w.word}(?![\\u4e00-\\u9fa5])`, 'g');
      count = (joined.match(re) || []).length;
    } else {
      count = joined.split(w.word).length - 1;
    }
    if (count > 0) hits.push({ ...w, count });
  }
  hits.sort((a, b) => b.count - a.count);
  return hits;
}

// 方法论语库：6 本表达类书籍蒸馏出的 skill 集（books/ 目录 *.json）
const BOOKS = (() => {
  const dir = path.join(__dirname, 'books');
  const out = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      } catch (e) {
        console.error('[books] 加载失败', f, e.message);
      }
    }
  }
  return out;
})();

function booksDigestOf() {
  return BOOKS.map((b) => {
    const skills = (b.skills || [])
      .map((s) => `  - ${s.name}：${s.model || ''}${s.when ? `（用于${s.when}）` : ''}`)
      .join('\n');
    return `《${b.book}》${b.author || ''}
精髓：${b.essence || ''}
适合场景：${(b.scenes || []).join('、')}
方法论维度：${(b.dimensions || []).join('、')}
可调用技能：
${skills}`;
  }).join('\n\n');
}

const app = express();
// verify 里留存原始 body：github webhook 的 HMAC 必须对原始字节计算
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

// 追问轮数上限（用户发言次数达到该值后强制收尾）
const MAX_TURNS = 6;

// ---------- 状态 ----------
app.get('/api/state', (req, res) => {
  const day = db.localDayKey();
  res.json({
    todayCard: db.getTodayCard(day),
    practicedToday: db.practicedOn(day),
    streak: db.calcStreak(),
    totalSessions: db.totalSessions(),
  });
});

// ---------- 卡片 ----------
app.get('/api/cards', (req, res) => {
  res.json(db.listCards());
});

app.post('/api/cards', (req, res) => {
  const { title, content, source, publishedAt } = req.body || {};
  if (!title || !title.trim() || !content || !content.trim()) {
    return res.status(400).json({ error: 'title 和 content 不能为空' });
  }
  const id = db.createCard({ title: title.trim(), content: content.trim(), source: (source || '').trim(), publishedAt });
  res.json({ id });
});

// ---------- 练习选卡：板块 -> 完整素材（短素材优先，适配复述） ----------
app.post('/api/practice/pick', (req, res) => {
  const category = String((req.body || {}).category || '');
  if (!['ted', 'rmrb', 'short', 'story'].includes(category)) return res.status(400).json({ error: '板块必须是 ted / rmrb / short / story' });

  const all = db.listCardsByCategory(category);
  if (!all.length) return res.status(404).json({ error: '该板块还没有素材，先去素材库导入' });

  // 未练过的优先；其中字数升序——越短越适合复述，优先给短的
  const fresh = all.filter((c) => !c.used_at).sort((a, b) => a.content.length - b.content.length);
  const pool = fresh.length ? fresh : all.slice().sort((a, b) => a.content.length - b.content.length);
  const card = pool[0]; // 直接给当前最短的完整素材
  res.json({ card: { id: card.id, title: card.title, content: card.content, length: card.content.length } });
});

// ---------- 语料抓取 ----------
app.post('/api/cards/fetch-rmrb', async (req, res) => {
  try {
    const { added, skipped } = await importRmrb({ onLog: (s) => console.log('[rmrb]', s) });
    res.json({ added: added.length, skipped: skipped.length });
  } catch (err) {
    console.error('[rmrb error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// 每日短评（人民网观点频道）
app.post('/api/cards/fetch-short', async (req, res) => {
  try {
    const { added, skipped } = await importDailyShort({ onLog: (s) => console.log('[short]', s) });
    res.json({ added: added.length, skipped: skipped.length });
  } catch (err) {
    console.error('[short error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// 粘贴/URL 导入短评素材
app.post('/api/cards/import-short', async (req, res) => {
  try {
    const r = await importShort({ ...req.body, onLog: (s) => console.log('[import-short]', s) });
    res.json(r);
  } catch (err) {
    console.error('[import-short error]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// TED 演讲稿导入：{ url: "https://www.ted.com/talks/xxx" 或 slug }
app.post('/api/cards/fetch-ted', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: '缺少 URL' });
    const r = await importTed(url, { onLog: (s) => console.log('[TED]', s) });
    res.json({ added: r.added.length, skipped: r.skipped.length, title: r.talkTitle, lang: r.lang });
  } catch (err) {
    console.error('[ted error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// RSS/Atom 订阅源：手动立即抓取（自动任务每天也会调用同一流程）
app.post('/api/cards/fetch-rss', async (req, res) => {
  const maxPerFeed = Math.max(1, Math.min(5, Number(req.body?.maxPerFeed) || 1));
  const maxTotal = Math.max(1, Math.min(20, Number(req.body?.maxTotal) || 6));
  try {
    const result = await fetchAndImport({
      maxPerFeed,
      maxTotal,
      onLog: (s) => console.log('[rss]', s),
    });
    res.json({ added: result.added.length, skipped: result.skipped.length, feeds: result.feeds });
  } catch (err) {
    console.error('[rss error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/cards/reprocess-rss', async (_req, res) => {
  try {
    const result = await reprocessFeedCards({ onLog: (s) => console.log('[rss 整理]', s) });
    res.json({ updated: result.updated.length, skipped: result.skipped.length, details: result.skipped });
  } catch (err) {
    console.error('[rss reprocess error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// 订阅源健康状态（进程重启后会重新从 never 开始，下一次抓取会填充）
app.get('/api/feeds/health', (req, res) => {
  res.json({ feeds: getFeedHealth() });
});

// ---------- 练习会话 ----------
app.post('/api/sessions', (req, res) => {
  const cardId = Number((req.body || {}).cardId);
  const card = db.getCard(cardId);
  if (!card) return res.status(404).json({ error: '卡片不存在' });
  const id = db.newSession(cardId);
  res.json({ sessionId: id });
});

// 核心：提交一轮复述/回答。第一轮提交 → 直接出三板块完整报告（示范模板+差异总结+听众追问）；
// 报告生成后可继续回答听众追问（听众角色，看不到材料）
app.post('/api/sessions/:id/turn', async (req, res) => {
  const text = ((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'text 不能为空' });
  if (!isConfigured()) {
    return res.status(502).json({ error: '请检查 LLM 配置：在项目根目录 .env 中设置 LLM_API_KEY' });
  }

  const session = db.getSession(Number(req.params.id));
  if (!session) return res.status(404).json({ error: '会话不存在' });
  const card = db.getCard(session.card_id);
  if (!card) return res.status(404).json({ error: '卡片不存在' });

  const turns = JSON.parse(session.turns || '[]');
  turns.push({ role: 'user', text });
  const hasReport = !!(session.report && session.report !== '""' && session.report !== '');
  // 先落库再调 LLM：生成失败/超时也不丢用户这轮原文，重试时带上完整历史
  db.saveTurns(session.id, turns);

  try {
    if (!hasReport) {
      // —— 第一轮：复述 → 生成三板块完整报告（示范模板 / 差异总结 / 听众追问）——
      const userTexts = turns.filter((t) => t.role === 'user').map((t) => t.text);
      const audit = spokenAuditOf(userTexts);
      const auditLine = audit.length
        ? audit.map((h) => `- "${h.word}" 出现 ${h.count} 次（${h.type}）—— 建议替换：${h.better}`).join('\n')
        : '';
      const historyText = turns.map((t) => `对方：${t.text}`).join('\n');
      const rawReport = await chat(
        [{ role: 'system', content: prompts.reportSystem(card.content, historyText, auditLine, booksDigestOf()) }],
        { json: true, temperature: 0.3 }
      );
      const report = parseJson(rawReport);
      if (!report || typeof report !== 'object') throw new Error('报告解析失败');
      if (!report.summary) report.summary = '练习完成。';
      if (!Array.isArray(report.words)) report.words = [];
      report.audit = audit; // 口语词命中统计（含词库自带建议），前端展示用
      // 兜底：LLM 漏掉的高频命中词，用词库建议补进 words（保证每次报告都呈现）
      const covered = new Set(report.words.map((w) => String(w.original || '')));
      for (const h of audit) {
        if (covered.has(h.word)) continue;
        if (h.count >= 2 || h.type === '语气词' || h.type === '口头禅') {
          report.words.push({ original: h.word, better: h.better, reason: h.reason });
        }
      }
      report.words = report.words.slice(0, 6); // 最多展示 6 条
      for (const w of report.words) {
        if (w && w.original && w.better) {
          db.addWord(String(w.original), String(w.better), card.title);
        }
      }
      // 兜底字段
      if (!report.demo || typeof report.demo !== 'object') report.demo = null;
      if (!Array.isArray(report.comparison)) report.comparison = [];
      if (!report.question) report.question = '';

      db.finishSession(session.id, turns, report);
      return res.json({ type: 'report', report });
    }

    // —— 后续轮：回答听众追问（听众看不到材料，只基于对话继续）——
    const messages = [
      { role: 'system', content: prompts.audienceChatSystem() },
      ...turns.map((t) => ({ role: t.role, content: t.text })),
    ];
    const raw = await chat(messages, { temperature: 0.7 });
    const reply = String(raw || '').trim() || '嗯，我明白了。';
    turns.push({ role: 'assistant', text: reply });
    db.saveTurns(session.id, turns);
    return res.json({ type: 'reply', text: reply });
  } catch (err) {
    console.error('[turn error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

const { CONCEPTS, HOT } = require('./topics');

// ---------- 一分钟演讲挑战 ----------
app.get('/api/speech/topics', (req, res) => {
  res.json({ concepts: CONCEPTS, hot: HOT });
});

app.get('/api/speech/logs', (req, res) => {
  res.json({ logs: db.listSpeechLogs() });
});

// 提交 1 分钟演讲 → AI 教练点评 → 存记录
app.post('/api/speech/log', async (req, res) => {
  const topic = String((req.body || {}).topic || '').trim();
  const text = String((req.body || {}).text || '').trim();
  const kind = ['concept', 'hot'].includes((req.body || {}).kind) ? (req.body || {}).kind : 'concept';
  if (!topic || !text) return res.status(400).json({ error: '话题和讲稿不能为空' });
  if (!isConfigured()) {
    return res.status(502).json({ error: '请检查 LLM 配置：在项目根目录 .env 中设置 LLM_API_KEY' });
  }
  try {
    const audit = spokenAuditOf([text]);
    const auditLine = audit.length
      ? audit.map((h) => `- "${h.word}" 出现 ${h.count} 次（${h.type}）—— 建议替换：${h.better}`).join('\n')
      : '';
    const raw = await chat(
      [{ role: 'system', content: prompts.speechFeedbackSystem(topic, text, auditLine, booksDigestOf()) }],
      { json: true, temperature: 0.3 }
    );
    const fb = parseJson(raw);
    if (!fb || typeof fb !== 'object') throw new Error('点评解析失败');
    if (!Array.isArray(fb.fixes)) fb.fixes = [];
    if (!Array.isArray(fb.strong)) fb.strong = [];
    if (!Array.isArray(fb.words)) fb.words = [];
    if (!fb.model) fb.model = null;
    else if (typeof fb.model !== 'object') fb.model = { text: String(fb.model) };
    if (fb.model && !fb.model.text) fb.model = null;
    fb.score = Math.max(1, Math.min(5, Number(fb.score) || 3));
    // 口语词入库
    for (const w of fb.words.slice(0, 3)) {
      if (w && w.original && w.better) db.addWord(String(w.original), String(w.better), `演讲《${topic}》`);
    }
    const id = db.createSpeechLog({ topic, kind, spoken: text, score: fb.score, feedback: fb });
    res.json({ id, feedback: fb });
  } catch (err) {
    console.error('[speech error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------- 历史与词库 ----------
app.get('/api/books', (req, res) => {
  res.json({ books: BOOKS });
});

app.get('/api/history', (req, res) => {
  res.json(db.listHistory());
});

app.get('/api/words', (req, res) => {
  res.json(db.listWords());
});

// ---------- 读书（本地书架） ----------
app.get('/api/bookshelf', (req, res) => {
  let books = [];
  try { books = shelf.scanBooks(); } catch (err) { return res.status(500).json({ error: '书架扫描失败：' + err.message }); }
  res.json({ books, dir: shelf.ROOT });
});

app.post('/api/bookshelf/upload', express.raw({
  type: ['application/epub+zip', 'application/octet-stream'],
  limit: '200mb',
}), (req, res) => {
  let filename = req.get('x-file-name') || '';
  try { filename = decodeURIComponent(filename); } catch { /* 使用原始文件名继续校验 */ }
  if (!filename) return res.status(400).json({ error: '缺少文件名' });
  try {
    const result = shelf.importEpub(req.body, filename);
    res.status(result.added ? 201 : 200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/bookshelf/:id/cover', (req, res) => {
  try {
    const buf = shelf.getCover(req.params.id);
    if (!buf) return res.status(404).end();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch { res.status(404).end(); }
});

// PDF 原页渲染图（mupdf，懒生成 + 缓存）
app.get('/api/bookshelf/:id/pages/:n', async (req, res) => {
  if (!/^[a-f0-9]{12}$/.test(req.params.id)) return res.status(400).end();
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1 || n > 5000) return res.status(400).end();
  try {
    const buf = await shelf.pagePng(req.params.id, n);
    if (!buf) return res.status(404).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch { res.status(500).end(); }
});

// PDF 页透明文字层（mupdf 结构化文本 → 页图像素坐标，懒生成 + 缓存）
app.get('/api/bookshelf/:id/pages/:n/stext', async (req, res) => {
  if (!/^[a-f0-9]{12}$/.test(req.params.id)) return res.status(400).end();
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1 || n > 5000) return res.status(400).end();
  try {
    const data = await shelf.pageStructuredText(req.params.id, n);
    if (!data) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400');
    res.json(data);
  } catch { res.status(500).end(); }
});

// epub 内嵌插图
app.get('/api/bookshelf/:id/imgs/:key', (req, res) => {
  if (!/^[a-f0-9]{12}$/.test(req.params.id)) return res.status(400).end();
  const img = shelf.getBookImg(req.params.id, req.params.key);
  if (!img) return res.status(404).end();
  res.set('Content-Type', img.type);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(img.buf);
});

// EPUB 原章排版（消毒后的原始 XHTML，iframe 直渲）
app.get('/api/bookshelf/:id/chapter/:idx/raw', (req, res) => {
  if (!/^[a-f0-9]{12}$/.test(req.params.id)) return res.status(400).end();
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx < 0 || idx > 5000) return res.status(400).end();
  try {
    const r = shelf.getChapterRaw(req.params.id, idx);
    if (!r) return res.status(404).end();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(r.html);
  } catch { res.status(500).end(); }
});

// EPUB 单章正文（剥壳、消毒、资源已重写），供统一阅读器内联渲染
app.get('/api/bookshelf/:id/spine/:idx/content', (req, res) => {
  if (!/^[a-f0-9]{12}$/.test(req.params.id)) return res.status(400).end();
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx < 0 || idx > 5000) return res.status(400).end();
  try {
    const r = shelf.getSpineContent(req.params.id, idx);
    if (!r) return res.status(404).end();
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(r);
  } catch { res.status(500).end(); }
});

// EPUB 整本连续排版：全部 spine 拼接为单文档（目录锚点跳转 + 滚动同步）
app.get('/api/bookshelf/:id/rawall', (req, res) => {
  if (!/^[a-f0-9]{12}$/.test(req.params.id)) return res.status(400).end();
  try {
    const r = shelf.getRawAll(req.params.id);
    if (!r) return res.status(404).end();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(r.html);
  } catch { res.status(500).end(); }
});

// EPUB zip 内资源代理（图片/字体/CSS）
app.get('/api/bookshelf/:id/res', (req, res) => {
  if (!/^[a-f0-9]{12}$/.test(req.params.id)) return res.status(400).end();
  try {
    const r = shelf.getRes(req.params.id, req.query.path);
    if (!r) return res.status(404).end();
    res.set('Content-Type', r.type);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(r.buf);
  } catch { res.status(404).end(); }
});

app.get('/api/bookshelf/:id', async (req, res) => {
  if (!/^[a-f0-9]{12}$/.test(req.params.id)) return res.status(400).json({ error: '参数错误' });
  try {
    const book = await shelf.getBook(req.params.id);
    if (!book) return res.status(404).json({ error: '没找到这本书（检查目录文件是否被移动）' });
    if (book.unsupported) return res.status(406).json({ error: `暂不支持阅读 ${book.format} 格式，请先转成 txt/epub` });
    res.json({
      book: {
        id: req.params.id, title: book.title, author: book.author, format: book.format,
        chapters: book.chapters, // 文字模式章节（划线/复述）
        spine: book.spine, toc: book.toc, // EPUB：spine 1:1 + 书自带目录
        outline: book.outline, pageCount: book.pageCount, dims: book.dims, // PDF：书签目录 + 页数 + 每页渲染尺寸
      },
      marks: db.listBookMarks(req.params.id),
    });
  } catch (err) {
    res.status(500).json({ error: '解析失败：' + err.message.slice(0, 120) });
  }
});

app.post('/api/bookshelf/:id/marks', (req, res) => {
  const { chapter = 0, text, kind = 'mark', note = '' } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: '标记内容不能为空' });
  const id = db.addBookMark({ bookId: req.params.id, chapter: Number(chapter) || 0, text: String(text).trim().slice(0, 500), kind, note: String(note || '').slice(0, 500) });
  res.json({ id });
});

app.delete('/api/bookshelf/:id/marks/:mid', (req, res) => {
  res.json({ ok: db.deleteBookMark(Number(req.params.mid), req.params.id) });
});

// ---------- 面试刷题（北梦测题库） ----------
app.get('/api/interview/groups', (req, res) => {
  const type = String(req.query.type || '');
  if (type && !['real', 'interview'].includes(type)) return res.status(400).json({ error: '题目类型无效' });
  const groups = new Map();
  interviewTrainer.allQuestions().filter((item) => !type || item.type === type).forEach((item) => {
    const key = `${item.type}:${item.category}`;
    if (!groups.has(key)) groups.set(key, { type: item.type, name: item.category, count: 0 });
    groups.get(key).count += 1;
  });
  res.json({ groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')) });
});

app.get('/api/interview/questions', (req, res) => {
  const type = String(req.query.type || '');
  if (type && !['real', 'interview'].includes(type)) return res.status(400).json({ error: '题目类型无效' });
  const category = String(req.query.category || '');
  const all = interviewTrainer.allQuestions().filter((item) => (!type || item.type === type) && (!category || item.category === category));
  const categories = {};
  all.forEach((item) => { categories[item.category] = (categories[item.category] || 0) + 1; });
  res.json({ questions: all.map((item) => interviewTrainer.publicQuestion(item)), categories });
});

app.get('/api/interview/questions/random', (req, res) => {
  const type = String(req.query.type || '');
  if (type && !['real', 'interview'].includes(type)) return res.status(400).json({ error: '题目类型无效' });
  const category = String(req.query.category || '');
  const pool = interviewTrainer.allQuestions().filter((item) => (!type || item.type === type) && (!category || item.category === category));
  const question = pool[Math.floor(Math.random() * pool.length)];
  if (!question) return res.status(404).json({ error: '没有找到符合条件的题目' });
  res.json({ question: interviewTrainer.publicQuestion(question) });
});

app.get('/api/interview/records', (req, res) => {
  res.json({ records: interviewTrainer.listRecords().slice(0, 100) });
});

app.post('/api/interview/practice/start', async (req, res) => {
  try { res.status(201).json({ session: await interviewTrainer.start(String(req.body?.questionId || '')) }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/interview/practice/:id/answer', async (req, res) => {
  try { res.json({ session: await interviewTrainer.answer(req.params.id, req.body?.answer) }); }
  catch (error) { res.status(/不存在/.test(error.message) ? 404 : 409).json({ error: error.message }); }
});

app.post('/api/interview/practice/:id/restate', async (req, res) => {
  try { res.json({ session: await interviewTrainer.restate(req.params.id, req.body?.answer) }); }
  catch (error) { res.status(/不存在/.test(error.message) ? 404 : 409).json({ error: error.message }); }
});

// 每日自动抓 RSS 订阅源 + 人民日报评论版 + 每日短评（启动 5 分钟后 + 每 24 小时）
let autoFetchedDay = '';
let autoFetchRunning = false;
async function autoFetch() {
  const day = db.localDayKey();
  if (autoFetchedDay === day || autoFetchRunning) return; // 今天已抓过/正在抓
  autoFetchRunning = true;
  try {
    const jobs = [
      ['RSS 订阅源', () => fetchAndImport({ maxPerFeed: 1, maxTotal: 6, onLog: (s) => console.log('[自动抓RSS]', s) })],
      ['人民日报评论版', importRmrb],
      ['每日短评', importDailyShort],
    ];
    for (const [name, fn] of jobs) {
      try {
        const { added, skipped } = await fn({ onLog: (s) => console.log(`[自动抓${name}]`, s) });
        console.log(`[自动抓${name}] 新增 ${added.length} 条，跳过 ${skipped.length} 条`);
      } catch (err) {
        console.error(`[自动抓${name}失败]`, err.message);
      }
    }
    autoFetchedDay = day;
  } finally {
    autoFetchRunning = false;
  }
}

const PORT = Number(process.env.PORT) || 3025;
app.listen(PORT, () => {
  console.log(`复述训练场已启动：http://localhost:${PORT}`);
  console.log(isConfigured() ? 'LLM 已配置 ✅' : 'LLM 未配置 ⚠️  练习页会提示检查 .env');
  if (isConfigured()) healthCheck().catch(() => { /* 自检不影响服务 */ });
});

// ---------- GitHub 推送自动部署（配置 WEBHOOK_SECRET 后启用） ----------
if (process.env.WEBHOOK_SECRET) {
  const crypto = require('node:crypto');
  const { exec } = require('node:child_process');
  const DEPLOY_SCRIPT = process.env.DEPLOY_SCRIPT || '/home/Shawn/project/retell-trainer/deploy.sh';
  app.post('/github-webhook', (req, res) => {
    const sig = req.headers['x-hub-signature-256'] || '';
    const body = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const expect = 'sha256=' + crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(body).digest('hex');
    if (!sig || sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
      return res.status(401).json({ ok: false, error: 'bad signature' });
    }
    const ev = req.headers['x-github-event'] || '';
    if (ev !== 'push') return res.json({ ok: true, ignored: ev });
    // 后台 detached 执行：本进程随部署重启也不影响部署继续
    exec(`bash ${DEPLOY_SCRIPT} >> /var/log/retell-deploy.log 2>&1 &`, { detached: true, shell: '/bin/bash' }).unref();
    res.json({ ok: true, deploying: true });
  });
  console.log('GitHub Webhook 自动部署已启用 ✅ (POST /github-webhook)');
}
// 启动 5 分钟后再跑第一次自动抓料（给服务喘口气），之后每天一次
setTimeout(autoFetch, 5 * 60 * 1000);
setInterval(autoFetch, 24 * 60 * 60 * 1000);
