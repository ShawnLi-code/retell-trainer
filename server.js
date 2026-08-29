// 复述训练场 · 服务入口
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const db = require('./db');
const ctx = require('./ctx');
const auth = require('./auth');
const { chat, parseJson, isConfigured, healthCheck } = require('./llm');
const prompts = require('./prompts');
const { fetchAndImport, reprocessFeedCards, getFeedHealth, importTed, importRmrb, importDailyShort, importShort } = require('./fetch_cards');
const shelf = require('./bookshelf');
const interviewTrainer = require('./interview-trainer');
const { URL } = require('node:url');

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

// ---------- 鉴权：全站 /api 锁在登录门后（除 /api/auth/*）；请求作用域切到当前用户 ----------
const PUBLIC_API = new Set(['/api/auth/join', '/api/auth/logout', '/api/auth/status']);
app.use('/api', (req, res, next) => {
  const pathOnly = (req.originalUrl || req.url).split('?')[0];
  if (PUBLIC_API.has(pathOnly)) return next();
  const user = auth.readAuth(req);
  if (!user) return res.status(401).json({ error: '请先输入邀请码', needAuth: true });
  req.user = user;
  // 懒触发：用户首次访问某页面时，给该用户库灌入预置词库（seed-words.json），保证词库有深度
  try { db.seedWords(user.uid); } catch (e) { console.error('[seedWords]', e.message); }
  // 之后本请求内所有同步/异步的 db / bookshelf / interview 调用都自动落到这个用户的库
  return ctx.runWith({ scope: 'user', uid: user.uid, isOwner: Boolean(user.is_owner) }, next);
});

// ---------- 状态 ----------
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/auth/status', (_req, res) => {
  // 此路由在鉴权白名单内：返回"我是谁/要不要引导"，不泄露任何数据
  res.json({ needBootstrap: auth.isBootstrapNeeded() });
});

app.post('/api/auth/join', (req, res) => {
  const code = String((req.body || {}).code || '').trim();
  const name = String((req.body || {}).name || '').trim();
  const r = auth.join(code, name);
  if (!r.ok) return res.status(400).json({ error: r.error });
  const token = auth.createSession(r.uid);
  auth.setSessionCookie(res, token, isHttpsReq(req));
  const u = auth.getUser(r.uid);
  res.json({ ok: true, user: { uid: r.uid, name: u ? u.name : '', isOwner: r.isOwner } });
});

app.post('/api/auth/logout', (req, res) => {
  const u = auth.readAuth(req);
  if (u) auth.dropSessions(u.uid);
  auth.clearSessionCookie(res, isHttpsReq(req));
  res.json({ ok: true });
});

// ---------- 站长管理页 ----------
function isHttpsReq(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto === 'https') return true;
  return !/^(localhost|127\.|\[::1\]|.+:\d+$)/.test(String(req.headers.host || ''));
}

function requireOwner(req, res, next) {
  if (!req.user || !req.user.is_owner) return res.status(403).json({ error: '只有站长可以操作' });
  next();
}

app.get('/api/admin/overview', requireOwner, (_req, res) => {
  res.json({ users: auth.listUsersWithStats(), codes: auth.listInviteCodes() });
});

app.post('/api/admin/codes', requireOwner, (req, res) => {
  const code = auth.createInviteCode(String((req.body || {}).label || '').trim(), req.user.uid);
  res.json({ code });
});

app.post('/api/admin/codes/revoke', requireOwner, (req, res) => {
  const ok = auth.revokeInviteCode(String((req.body || {}).code || ''));
  res.json({ ok });
});

// 停用某用户：踢下线（删其全部登录令牌）。不删数据——文件都还在，想彻底清除站长手动删库文件。
app.post('/api/admin/users/:uid/revoke', requireOwner, (req, res) => {
  const u = auth.getUser(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.is_owner) return res.status(400).json({ error: '不能停用自己' });
  auth.dropSessions(u.uid);
  res.json({ ok: true, name: u.name });
});

app.get('/api/state', (req, res) => {
  const day = db.localDayKey();
  res.json({
    me: { name: req.user.name, uid: req.user.uid, isOwner: Boolean(req.user.is_owner) },
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

app.delete('/api/cards/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: '参数不对' });
  const card = db.getCard(id);
  if (!card) return res.status(404).json({ error: '素材不存在' });
  if (card.owner_uid == null) return res.status(403).json({ error: '公共素材大家共用，删不了哦' });
  if (!db.deleteCard(id)) return res.status(403).json({ error: '只能删除自己导入的素材' });
  res.json({ ok: true });
});

// ---------- 练习选卡：板块 -> 完整素材（短素材优先，适配复述） ----------
app.post('/api/practice/pick', (req, res) => {
  const category = String((req.body || {}).category || '');
  if (!['ted', 'rmrb', 'short', 'story', 'video'].includes(category)) return res.status(400).json({ error: '板块必须是 ted / rmrb / short / story / video' });

  const all = db.listCardsByCategory(category);
  if (!all.length) return res.status(404).json({ error: '该板块还没有素材，先去素材库导入' });

  // 未练过的优先；其中字数升序——越短越适合复述，优先给短的
  const fresh = all.filter((c) => !c.used_at).sort((a, b) => a.content.length - b.content.length);
  const pool = fresh.length ? fresh : all.slice().sort((a, b) => a.content.length - b.content.length);
  const card = pool[0]; // 直接给当前最短的完整素材
  res.json({ card: { id: card.id, title: card.title, content: card.content, length: card.content.length } });
});

// ---------- 流式 ASR（sherpa-onnx 中文）real-time 边录边看字 ----------
// 浏览器通过 Web Audio 采 16k PCM16 → 每帧 POST 到 /api/asr/stream → 服务端转发给
// sherpa 常驻进程增量解码 → 即时返回 {final, interim}。
const ASR_STREAM_URL = process.env.ASR_STREAM_URL || 'http://127.0.0.1:3026';

async function streamAsr(pcmBase64, sid, reset) {
  const res = await fetch(ASR_STREAM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: pcmBase64, sid, reset: !!reset }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('流式识别服务返回 ' + res.status);
  const data = await res.json();
  // {final: 增量文字, all: 全量文字} —— 前端用 final 追加，避免重复
  return data;
}

app.post('/api/asr/stream',
  express.json({ limit: '2mb' }),
  async (req, res) => {
    try {
      const sid = String((req.body || {}).sid || '');
      const audio = String((req.body || {}).audio || ''); // base64 PCM16
      const reset = Boolean((req.body || {}).reset);
      if (!sid) return res.status(400).json({ error: '缺少会话 id' });
      if (!audio) return res.status(400).json({ error: '没有音频数据' });
      const out = await streamAsr(audio, sid, reset);
      res.json(out);
    } catch (err) {
      console.error('[stream asr]', err.message);
      res.status(502).json({ error: '流式识别出错：' + String(err.message || err).slice(0, 120) });
    }
  });

// ---------- 文本整理：口语去重 + AI 补标点（停录后对实时字幕加工） ----------
app.post('/api/text/format', async (req, res) => {
  try {
    const raw = String((req.body || {}).text || '').trim();
    if (!raw) return res.status(400).json({ error: 'text 不能为空' });
    // 先本地去重（快），再 AI 补标点（可失败，回退原文）
    const fmtInfo = {};
    const text = await formatTranscript(raw, fmtInfo);
    res.json({ text, formatted: Boolean(fmtInfo.ok) });
  } catch (err) {
    console.error('[text format]', err.message);
    res.status(502).json({ error: '整理失败：' + String(err.message || err).slice(0, 100) });
  }
});

// ---------- 练习录音 → 服务端 Whisper 转写（不再依赖浏览器 ASR） ----------
app.post('/api/practice/transcribe',
  express.raw({ type: (req) => String(req.headers['content-type'] || '').startsWith('audio/'), limit: '30mb' }),
  async (req, res) => {
    try {
      const buf = Buffer.isBuffer(req.body) ? req.body : null;
      if (!buf || !buf.length) return res.status(400).json({ error: '没有收到录音数据' });
      if (!fs.existsSync(ASR_SCRIPT) || !fs.existsSync(PY_BIN)) {
        return res.status(502).json({ error: '服务器没配置语音转写，请直接打字或稍后再试' });
      }
      const ct = String(req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
      const extMap = { 'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav', 'audio/x-wav': '.wav' };
      const dir = process.platform === 'win32' ? path.join(os.tmpdir(), 'retell-audio') : '/tmp';
      fs.mkdirSync(dir, { recursive: true });
      const audioPath = path.join(dir, 'practice-' + randomUUID().slice(0, 8) + (extMap[ct] || '.webm'));
      fs.writeFileSync(audioPath, buf);
      try {
        const asr = await pyRun(ASR_SCRIPT, audioPath, 10 * 60 * 1000);
        if (!asr.ok) return res.status(502).json({ error: asr.error || '语音转写失败' });
        const fmtInfo = {};
        const text = await formatTranscript(cleanTranscript(asr.text), fmtInfo);
        res.json({ text, formatted: Boolean(fmtInfo.ok) });
      } finally {
        try { fs.unlinkSync(audioPath); } catch { /* */ }
      }
    } catch (err) {
      console.error('[practice transcribe]', err.message);
      res.status(500).json({ error: '转写服务出错：' + String(err.message || err).slice(0, 100) });
    }
  });

// ---------- 语料抓取 ----------
// 刷新"公共池"的抓取（人民日报/每日短评/RSS/整理）会写共享素材并消耗站长 LLM 额度：
// 只允许站长触发，且跑在 shared 作用域（写成公共卡 owner_uid=NULL，大家都能练）。
// 个人粘贴导入（import-short / fetch-ted）走当前用户请求作用域 → 私有素材。
function sharedAdmin(fn) {
  return (req, res) => {
    if (!req.user || !req.user.is_owner) return res.status(403).json({ error: '公共素材刷新只有站长可以操作' });
    return ctx.runWith({ scope: 'shared', uid: null, isOwner: true }, () => fn(req, res));
  };
}

app.post('/api/cards/fetch-rmrb', sharedAdmin(async (req, res) => {
  try {
    const { added, skipped } = await importRmrb({ onLog: (s) => console.log('[rmrb]', s) });
    res.json({ added: added.length, skipped: skipped.length });
  } catch (err) {
    console.error('[rmrb error]', err.message);
    res.status(502).json({ error: err.message });
  }
}));

// 每日短评（人民网观点频道）
app.post('/api/cards/fetch-short', sharedAdmin(async (req, res) => {
  try {
    const { added, skipped } = await importDailyShort({ onLog: (s) => console.log('[short]', s) });
    res.json({ added: added.length, skipped: skipped.length });
  } catch (err) {
    console.error('[short error]', err.message);
    res.status(502).json({ error: err.message });
  }
}));

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
app.post('/api/cards/fetch-rss', sharedAdmin(async (req, res) => {
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
}));

app.post('/api/cards/reprocess-rss', sharedAdmin(async (_req, res) => {
  try {
    const result = await reprocessFeedCards({ onLog: (s) => console.log('[rss 整理]', s) });
    res.json({ updated: result.updated.length, skipped: result.skipped.length, details: result.skipped });
  } catch (err) {
    console.error('[rss reprocess error]', err.message);
    res.status(502).json({ error: err.message });
  }
}));

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
          db.addWord(String(w.original), String(w.better), card.title, String(w.reason || ''), 'learned');
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
      if (w && w.original && w.better) db.addWord(String(w.original), String(w.better), `演讲《${topic}》`, String(w.reason || ''), 'learned');
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
  res.json({ books, dir: shelf.rootDir() });
});

app.post('/api/bookshelf/upload', express.raw({
  type: ['application/epub+zip', 'application/octet-stream', 'application/pdf'],
  limit: '200mb',
}), (req, res) => {
  let filename = req.get('x-file-name') || '';
  try { filename = decodeURIComponent(filename); } catch { /* 使用原始文件名继续校验 */ }
  if (!filename) return res.status(400).json({ error: '缺少文件名' });
  try {
    const isPdf = filename.toLowerCase().endsWith('.pdf');
    const result = isPdf ? shelf.importPdf(req.body, filename) : shelf.importEpub(req.body, filename);
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

// 从书架删除图书（书文件 + 转换缓存 + 划线/书签）
app.delete('/api/bookshelf/:id', (req, res) => {
  if (!/^[a-f0-9]{12}$/.test(req.params.id)) return res.status(400).json({ error: '无效的书 ID' });
  try {
    const r = shelf.removeBook(req.params.id);
    if (!r.ok) return res.status(404).json(r);
    try { db.deleteBookMarksByBook(req.params.id); } catch { /* 书签清理失败不影响删除 */ }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ---------- 共享素材维护（写公共库 shared.db，仅站长） ----------
// 系统抓取来的素材是全站共用的，落 shared 作用域（owner_uid=NULL）；
// 用户自己粘贴/解析的素材走各自请求作用域（owner_uid=本人），天然私有。
function runShared(fn) {
  return (req, res) => ctx.runWith({ scope: 'shared', uid: null, isOwner: true }, () => fn(req, res));
}

// 每日自动抓 RSS 订阅源 + 人民日报评论版 + 每日短评（启动 5 分钟后 + 每 24 小时）
let autoFetchedDay = '';
let autoFetchRunning = false;
async function autoFetch() {
  const day = db.localDayKey();
  if (autoFetchedDay === day || autoFetchRunning) return; // 今天已抓过/正在抓
  autoFetchRunning = true;
  await ctx.runWith({ scope: 'shared', uid: null, isOwner: true }, async () => {
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
  });
}

const PORT = Number(process.env.PORT) || 3025;

// ---------- 链接 → 复述素材（抖音/小红书等） ----------
// 服务器依赖：/opt/dy-api/.venv/bin/python + /root/dy_parse.py（解析）+ /root/asr.py（转写）
const PY_BIN = process.env.DY_PY_BIN || (process.platform === 'win32'
  ? path.join(__dirname, '..', 'tools', 'dy-api', '.venv', 'Scripts', 'python.exe')
  : '/opt/dy-api/.venv/bin/python');
const DY_PARSE_SCRIPT = process.env.DY_PARSE_SCRIPT || (process.platform === 'win32'
  ? path.join(__dirname, '..', 'tools', 'dy-api', 'dy_parse.py')
  : '/root/dy_parse.py');
const ASR_SCRIPT = process.env.ASR_SCRIPT || (process.platform === 'win32'
  ? path.join(__dirname, '..', 'tools', 'dy-api', 'asr.py')
  : '/root/asr.py');
const DY_CACHE_DIR = process.env.DY_CACHE_DIR || '/opt/dy-cache';
const LINK_ALLOWED_HOSTS = ['v.douyin.com', 'www.douyin.com', 'douyin.com', 'iesdouyin.com', 'xhslink.com', 'xhslink.cn', 'www.xiaohongshu.com', 'xiaohongshu.com'];

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const linkQueue = []; // 待处理任务 {id,url}；任务本体持久化在 SQLite（重启不丢，列表实时可见）
let linkRunning = false;

const STEP_PCT = { '': 5, fetch: 20, audio: 50, transcribe: 75, format: 92 };
function taskPct(step, status) {
  if (status === 'done' || status === 'failed') return 100;
  return STEP_PCT[step] || 5;
}
function classifyPlatform(url) {
  if (/douyin|iesdouyin/i.test(url)) return '抖音';
  if (/xhslink|xiaohongshu/i.test(url)) return '小红书';
  return '网页';
}
function updTask(id, patch) {
  if (patch.pct === undefined) {
    if (patch.status === 'done' || patch.status === 'failed') patch.pct = 100;
    else if (patch.step !== undefined) patch.pct = taskPct(patch.step, patch.status);
  }
  db.updateLinkTask(id, patch);
}

function pyRun(script, arg, timeoutMs = 150000) {
  return new Promise((resolve) => {
    execFile(PY_BIN, [script, arg], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const raw = String(stderr || stdout || err.message || '').trim().split('\n').filter(Boolean).pop() || String(err.message || '失败');
        return resolve({ ok: false, error: String(raw).slice(0, 200) });
      }
      try {
        const j = JSON.parse(String(stdout).trim().split('\n').pop() || '{}');
        resolve(j);
      } catch {
        resolve({ ok: false, error: '解析脚本输出失败' });
      }
    });
  });
}

async function fetchJsonText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
    signal: AbortSignal.timeout(25000),
  });
  return { status: res.status, text: await res.text() };
}

// 小红书/通用：抓页面取 og:title / og:description
async function parseWebPage(url) {
  const { status, text } = await fetchJsonText(url);
  if (status !== 200) return { ok: false, error: `网页返回 ${status}` };
  const meta = (name) => {
    const m = text.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i'))
      || text.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["']${name}["']`, 'i'));
    return m ? decodeHtml(m[1]) : '';
  };
  const decodeHtml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  const title = meta('og:title') || meta('description') || '';
  const desc = meta('og:description') || '';
  if (!title && !desc) return { ok: false, error: '这个页面没能提取到文字（可能需要登录，或换一条链接）' };
  return { ok: true, title: cleanTitle(title), desc: desc, platform: /xiaohongshu|xhslink/i.test(url) ? '小红书' : '网页' };
}

function cleanTitle(t) {
  return String(t).replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[\u200b\u200c]/g, '').trim();
}

function titleFromDesc(desc) {
  const line = String(desc || '').split('\n')[0].replace(/#\S+/g, '').trim();
  return stripSuffix(line || '抖音视频').slice(0, 60);
}

function stripSuffix(t) {
  return t.replace(/[，。！？、：；\s]+$/g, '').trim();
}

// 小红书笔记页解析：视频笔记的 og:video 直接给 MP4 直链（无需登录），标题/文案在 og: meta 里
async function parseXhsPage(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA_DESKTOP }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) return { ok: false, error: `小红书页面返回 ${res.status}` };
  const html = await res.text();
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  const metaOf = (name) => {
    const m = html.match(new RegExp(`<meta[^>]*(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i'));
    return m ? decode(m[1]) : '';
  };
  let videoUrl = metaOf('og:video');
  if (!videoUrl) {
    const mv = html.match(/"masterUrl"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (mv) { try { videoUrl = JSON.parse('"' + mv[1] + '"'); } catch { videoUrl = mv[1].replace(/\\u002F/gi, '/'); } }
  }
  const title = cleanTitle(metaOf('og:title').replace(/\s*[-|]\s*小红书\s*$/, ''));
  const desc = metaOf('og:description');
  if (!title && !desc && !videoUrl) return { ok: false, error: '这个笔记没能提取到内容（可能需要登录，或链接已失效）' };
  const noteId = (String(res.url).match(/\/(?:discovery|explore)\/([0-9a-f]{16,32})/i) || [])[1] || '';
  return { ok: true, title, desc, videoUrl, noteId, finalUrl: res.url };
}

async function downloadMedia(url, savePath, timeoutMs = 300000) {
  const res = await fetch(url, { headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://www.xiaohongshu.com/' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('下载失败（HTTP ' + res.status + '）');
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(savePath, buf);
  return buf.length;
}

// 统一的"转写 → AI 格式化 → done"收尾；抛错由上层兜底记为失败
async function transcribeToTask(taskId, audioPath) {
  updTask(taskId, { status: 'running', step: 'transcribe' });
  const asr = await pyRun(ASR_SCRIPT, audioPath, 30 * 60 * 1000);
  if (!asr.ok) throw new Error(asr.error || '语音转写失败');
  updTask(taskId, { step: 'format' });
  const fmtInfo = {};
  const text = await formatTranscript(cleanTranscript(asr.text), fmtInfo);
  updTask(taskId, { text, fmt: fmtInfo.ok ? 'ai' : ('raw:' + (fmtInfo.skip || 'unknown')), status: 'done' });
}

async function runLinkTask(taskId, url) {
  const plat = classifyPlatform(url);
  // 任务可能已被用户删除/取消（进行中可删）→ 不再处理
  const fresh = db.getLinkTask(taskId);
  if (!fresh || (fresh.status !== 'queued' && fresh.status !== 'running')) return;
  try {
    updTask(taskId, { status: 'running', step: 'fetch' });
    if (plat === '抖音') {
      const meta = await pyRun(DY_PARSE_SCRIPT, url, 120000);
      if (!meta.ok) throw new Error(meta.error || '抖音解析失败');
      meta.platform = '抖音';
      if (!meta.music_url && !meta.video_url) throw new Error('没有找到音频/视频地址');
      updTask(taskId, { meta });
      const audioPath = path.join(DY_CACHE_DIR, meta.id + '.mp3');
      if (!fs.existsSync(audioPath)) {
        updTask(taskId, { step: 'audio' });
        await downloadMedia(meta.music_url || meta.video_url, audioPath, 180000);
      }
      await transcribeToTask(taskId, audioPath);
    } else if (plat === '小红书') {
      const page = await parseXhsPage(url);
      if (!page.ok) throw new Error(page.error);
      const meta = { title: page.title, desc: page.desc, platform: '小红书', finalUrl: page.finalUrl };
      updTask(taskId, { meta });
      if (page.videoUrl) {
        // 视频笔记：下载 MP4 → Whisper 转写文字稿
        const mediaPath = path.join(DY_CACHE_DIR, 'xhs-' + (page.noteId || randomUUID().slice(0, 8)) + '.mp4');
        if (!fs.existsSync(mediaPath)) {
          updTask(taskId, { step: 'audio' });
          await downloadMedia(page.videoUrl, mediaPath);
        }
        await transcribeToTask(taskId, mediaPath);
      } else {
        // 图文笔记：没有视频可转，直接拿标题+文案做素材
        updTask(taskId, { step: 'format' });
        const text = [page.title, page.desc].filter(Boolean).join('\n').trim();
        updTask(taskId, { text: text || '（未能提取到内容）', fmt: 'meta', status: 'done' });
      }
    } else {
      // 其他网页：退化为元数据文案
      const page = await parseWebPage(url);
      if (!page.ok) throw new Error(page.error);
      updTask(taskId, { meta: { title: page.title, desc: page.desc, platform: '网页' }, text: cleanTranscript(page.desc), fmt: 'meta', status: 'done' });
    }
  } catch (err) {
    updTask(taskId, { status: 'failed', error: String(err.message || err).slice(0, 200) });
  }
}

function cleanTranscript(t) {
  // 保留换行、不吞标点（whisper 偶尔会自带分句）；原始的一坨交给 AI 格式化
  return String(t || '').replace(/\r\n?/g, '\n').replace(/[ \t\u3000]+/g, ' ').trim();
}

// 口语去重（与前端 dedupSpeech 同款）：压连续重复字与常见口头禅叠词，供补标点前清理
function dedupSpeech(s) {
  if (!s) return s;
  let out = '';
  const REDUNDANT = new Set(['嗯', '呃', '啊', '哦']); // 语气词允许重复表示停顿
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (out.endsWith(ch) && ch !== ' ' && ch !== '\n' && !REDUNDANT.has(ch)) continue;
    out += ch;
  }
  const PHRASES = ['那个', '然后', '就是', '这个', '一个', '我们', '你们', '他们', '我觉得', '就是说', '什么', '还有', '是不是', '因为', '所以', '可以', '可能', '没有'];
  for (const p of PHRASES) out = out.replace(new RegExp('(?:' + p + '){2,}', 'g'), p);
  return out;
}

// 转写稿格式化：LLM 补标点、分段；失败静默回退原文，绝不因此让任务失败。
// 总时长上限 FORMAT_TIMEOUT_MS（默认 100 秒）：模型链逐渠道兜底可能拖到 5 分钟，
// 等太久体验差，超时直接回退原文（任务照样完成，走「✨ AI 整理格式」补救按钮即可）。
// info 参数回传诊断信息（info.ok = 是否经 AI 格式化；info.skip = 回退原因）
async function formatTranscript(raw, info) {
  const text = dedupSpeech(String(raw || '').trim());
  if (!text || !isConfigured()) {
    if (info) { info.ok = false; info.skip = !text ? '空' : 'LLM 未配置'; }
    return text;
  }
  try {
    const out = await Promise.race([
      chat(
        [{ role: 'system', content: prompts.transcriptFormatSystem(text.slice(0, 6000)) }],
        { temperature: 0.2 }
      ),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('格式化超时')), Number(process.env.FORMAT_TIMEOUT_MS) || 100000)),
    ]);
    const cleaned = String(out || '').replace(/^["'「『]+|["'」』]+$/g, '').trim();
    // 合理性检查：输出不能比原文缩水太多（防止模型偷懒概括）
    if (cleaned.length >= Math.max(text.length * 0.5, 20)) {
      if (info) info.ok = true;
      return cleaned;
    }
    console.error(`[转写格式化] 输出过短(${text.length} -> ${cleaned.length})，回退原文`);
    if (info) { info.ok = false; info.skip = `AI 输出过短 ${cleaned.length}/${text.length}`; }
  } catch (err) {
    console.error('[转写格式化]', err.message);
    if (info) { info.ok = false; info.skip = String(err.message || err).slice(0, 120); }
  }
  return text;
}

function pumpLinkQueue() {
  if (linkRunning) return;
  const job = linkQueue.shift();
  if (!job) { linkRunning = false; return; }
  linkRunning = true;
  // 任务是响应之后才跑的，请求作用域（AsyncLocalStorage）早已退出
  // → 必须显式把提交者的 uid 重新包进上下文，否则落库会落到别人/共享库里
  ctx.runWith({ scope: 'user', uid: job.uid, isOwner: Boolean(job.isOwner) }, () => {
    Promise.resolve()
      .then(() => runLinkTask(job.id, job.url))
      .catch((err) => console.error('[链接任务异常]', job.id, err.message))
      .finally(() => {
        linkRunning = false;
        pumpLinkQueue();
      });
  });
}

// 抖音 App 分享复制的是整段文案：「8.92 复制打开抖音，看看【…】… https://v.douyin.com/xxx/ D@U.LW MjP:/ :1pm 08/09」
// 用户常直接整段粘贴，所以从任意文本里把真正的链接抠出来；没写协议时兜底认短链域名。
function extractShareUrl(raw) {
  let m = raw.match(/https?:\/\/[^\s'"<>，。《》【】（）()]+/i);
  if (m) return m[0].replace(/[.,;:!?，。；：！？）】"'’”]+$/, '');
  // 没写协议的裸短链（v.douyin.com/xxx、xhslink.cn/xxx），自动补上 https://
  m = raw.match(/(?:v\.douyin\.com|xhslink\.(?:com|cn))\/[A-Za-z0-9_-]+\/?/i);
  return m ? 'https://' + m[0].replace(/[.,;:!?，。；：！？）】"'’”]+$/, '') : '';
}

app.post('/api/material/link', (req, res) => {
  const raw = String((req.body || {}).url || '').trim();
  const url = extractShareUrl(raw) || raw;
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return res.status(400).json({ error: '没找到有效链接——抖音/小红书分享的整段文案可以直接粘贴（内含 v.douyin.com 或 xhslink 链接即可）' }); }
  if (!LINK_ALLOWED_HOSTS.includes(host)) {
    return res.status(400).json({ error: '目前支持抖音和小红书的分享链接（v.douyin.com / xhslink.cn / xiaohongshu.com）' });
  }
  const cachedId = db.findDoneTaskByUrl(url);
  if (cachedId) return res.json({ taskId: cachedId, cached: true });
  // 同链接已有进行中任务：复用，避免重复提交产生两个任务（两个进度条）
  const activeId = db.findActiveTaskByUrl(url);
  if (activeId) return res.json({ taskId: activeId, cached: true, active: true });
  const task = { id: randomUUID().slice(0, 8), url, host: classifyPlatform(url), uid: req.user.uid, isOwner: Boolean(req.user.is_owner) };
  db.createLinkTask(task);
  linkQueue.push(task);
  pumpLinkQueue();
  res.json({ taskId: task.id });
});

// 任务列表（持久化）：前端"短视频解析"页实时渲染进度条
app.get('/api/material/link/tasks', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  // 兜底 watchdog：queued/running 超过 25 分钟视为卡死（正常单任务最多约 12 分钟：
  // 转写 30s~10min + 格式化 100s），标为失败让用户重试，避免"永远挂着"
  const cutoff = new Date(Date.now() - 25 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const cutoffStr = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())} ${pad(cutoff.getHours())}:${pad(cutoff.getMinutes())}:${pad(cutoff.getSeconds())}`;
  for (const t of db.listLinkTasks(100)) {
    if ((t.status === 'queued' || t.status === 'running') && String(t.updated_at || '') < cutoffStr) {
      db.updateLinkTask(t.id, { status: 'failed', error: '处理超时自动放弃（可能网络卡了），重新粘贴链接即可重试', pct: 100 });
    }
  }
  res.json({
    tasks: db.listLinkTasks(limit).map((t) => ({
      id: t.id, url: t.url, host: t.host, status: t.status, step: t.step, pct: t.pct,
      error: t.error, fmt: t.fmt, saved: Boolean(t.saved), created_at: t.created_at,
      meta: t.meta ? { title: t.meta.title, desc: t.meta.desc, author: t.meta.author, platform: t.meta.platform } : null,
    })),
  });
});

// 删除一条解析记录（只删任务日志，不影响已存入的素材卡）
app.delete('/api/material/link/:id', (req, res) => {
  const ok = db.deleteLinkTask(req.params.id);
  if (!ok) return res.status(404).json({ error: '记录不存在' });
  res.json({ ok: true });
});

app.get('/api/material/link/:id', (req, res) => {
  const t = db.getLinkTask(req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在' });
  res.json({
    id: t.id, url: t.url, host: t.host, status: t.status, step: t.step, pct: t.pct,
    meta: t.status === 'done' ? t.meta : null,
    text: t.status === 'done' ? t.text : '',
    error: t.error || '', saved: Boolean(t.saved),
    fmt: t.fmt || (t.status === 'done' ? 'ai' : ''),
    created_at: t.created_at,
  });
});

// 转写结果存入素材库（复述素材）
app.post('/api/material/link/:id/save', async (req, res) => {
  const task = db.getLinkTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.saved) return res.json({ id: task.card_id || null, already: true, category: 'video' });
  if (task.status !== 'done') return res.status(400).json({ error: '任务还没有完成，等列表里显示完成再存' });
  let text = String(task.text || '').trim();
  if (text.length < 30) return res.status(400).json({ error: '转写内容太短，不适合做素材' });
  // 自愈：入库前若当初没完成 AI 格式化（LLM 瞬时超时等），当场补一次
  if (task.fmt !== 'ai' && text.length >= 200) {
    const fmtInfo = {};
    const better = await formatTranscript(text, fmtInfo);
    if (fmtInfo.ok) {
      text = better;
      db.updateLinkTask(task.id, { text, fmt: 'ai' });
    }
  }
  const meta = task.meta || {};
  const title = cleanTitle(String((req.body || {}).title || '').trim() || meta.title || titleFromDesc(meta.desc || ''));
  const id = db.createCard({ title, content: text, source: (meta.platform || task.host || '网页') + (meta.author ? '@' + meta.author : ''), category: 'video' });
  db.updateLinkTask(task.id, { saved: 1, card_id: id });
  res.json({ id, title, category: 'video' });
});

// 补救：已入库但当年 AI 格式化失败的素材（LLM 瞬时故障），手动触发一次 AI 整理
app.post('/api/material/link/:id/reformat', async (req, res) => {
  const task = db.getLinkTask(req.params.id);
  if (!task || task.status !== 'done') return res.status(400).json({ error: '任务未完成' });
  if (!task.saved || !task.card_id) return res.status(400).json({ error: '这条还没存入素材库' });
  const card = db.getCard(task.card_id);
  if (!card) return res.status(404).json({ error: '素材卡不存在了' });
  const fmtInfo = {};
  const better = await formatTranscript(String(card.content || ''), fmtInfo);
  if (!fmtInfo.ok) return res.status(502).json({ error: 'AI 整理没成功：' + (fmtInfo.skip || '未知原因') + '，稍后再试' });
  db.updateCard(task.card_id, { title: card.title, content: better });
  db.updateLinkTask(task.id, { fmt: 'ai', text: better });
  res.json({ id: task.card_id, length: better.length });
});
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
// 登录令牌每小时清一次过期记录
setInterval(() => { try { auth.gcSessions(); } catch { /* */ } }, 60 * 60 * 1000);
