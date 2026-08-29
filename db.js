// 数据库层（多用户版）：node:sqlite。
// 架构：
//   - data/shared.db      —— 公共素材 cards（带 owner_uid：NULL=公共、非空=某人私有）+ 用户/邀请码
//   - data/users/<uid>.db —— 每人的 sessions / words / speech_logs / book_marks / link_tasks（物理隔离）
// 卡片 id 仍是整数（前端无感知）；练习数据按当前请求作用域（ctx）自动落到对应文件。
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const ctx = require('./ctx');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
fs.mkdirSync(USERS_DIR, { recursive: true });

const shared = new DatabaseSync(path.join(DATA_DIR, 'shared.db'));

// ---------- 本地日期工具（与连接无关） ----------
function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------- shared.db：公共素材 + 用户表 ----------
shared.exec(`
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT DEFAULT '',
  category TEXT DEFAULT 'story',
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  used_at TEXT,
  owner_uid TEXT
);
CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  last_seen TEXT,
  is_owner INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  label TEXT DEFAULT '',
  created_by TEXT,
  used_by TEXT,
  used_at TEXT,
  revoked INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`);
try { shared.exec(`ALTER TABLE cards ADD COLUMN owner_uid TEXT`); } catch { /* 已存在 */ }

// ---------- 每个用户一个文件连接（懒开 + 缓存） ----------
const USER_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER,
  card_title TEXT DEFAULT '',
  started_at TEXT DEFAULT (datetime('now','localtime')),
  ended_at TEXT,
  turns TEXT DEFAULT '[]',
  report TEXT
);
CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL,
  better TEXT NOT NULL,
  context TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS speech_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  kind TEXT DEFAULT 'concept',
  spoken TEXT NOT NULL,
  score INTEGER,
  feedback TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS book_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL,
  chapter INTEGER DEFAULT 0,
  text TEXT NOT NULL,
  kind TEXT DEFAULT 'mark',
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS link_tasks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  host TEXT DEFAULT '',
  status TEXT DEFAULT 'queued',
  step TEXT DEFAULT '',
  pct INTEGER DEFAULT 3,
  meta TEXT,
  text TEXT DEFAULT '',
  error TEXT DEFAULT '',
  fmt TEXT DEFAULT '',
  saved INTEGER DEFAULT 0,
  card_id INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
`;

const userConns = new Map();
function openUser(uid) {
  if (!uid) throw new Error('无当前用户（共享作用域不能写练习数据）');
  let c = userConns.get(uid);
  if (c) return c;
  const safeUid = String(uid).replace(/[^a-zA-Z0-9_-]/g, '');
  c = new DatabaseSync(path.join(USERS_DIR, safeUid + '.db'));
  c.exec(USER_SCHEMA);
  try { c.exec(`ALTER TABLE sessions ADD COLUMN card_title TEXT DEFAULT ''`); } catch { /* 已存在 */ }
  // 该库残留的进行中任务标失败（服务重启）
  try {
    c.prepare(`UPDATE link_tasks SET status='failed', error='服务重启导致中断，请重新粘贴链接重试', pct=0, updated_at=datetime('now','localtime') WHERE status IN ('queued','running')`).run();
  } catch { /* 表可能刚建 */ }
  userConns.set(uid, c);
  return c;
}

// 当前用户连接（HTTP 用户作用域内）
function U() {
  const uid = ctx.currentUid();
  if (!uid) throw new Error('内部错误：用户作用域缺失');
  return openUser(uid);
}

// ============ 卡片（物理在 shared.db，按 owner_uid 做归属隔离） ============
// 作用域过滤 SQL：共享作用域只看公共；用户作用域看公共 + 自己私有
function cardScopeSql() {
  if (ctx.isSharedScope()) return { where: 'owner_uid IS NULL', params: [] };
  return { where: '(owner_uid IS NULL OR owner_uid = ?)', params: [ctx.currentUid()] };
}
const CARD_COLS = 'id, title, content, source, category, published_at, created_at, used_at, owner_uid';
function tagScope(row) {
  if (!row) return row;
  return { ...row, scope: row.owner_uid == null ? 'public' : 'mine' };
}

function createCard({ title, content, source = '', category = 'story', publishedAt = localDayKey() }) {
  const owner = ctx.isSharedScope() ? null : ctx.currentUid();
  const r = shared.prepare(`INSERT INTO cards (title, content, source, category, published_at, owner_uid) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(title, content, source, category, publishedAt || null, owner);
  return Number(r.lastInsertRowid);
}

function listCards() {
  const s = cardScopeSql();
  return shared.prepare(`SELECT ${CARD_COLS} FROM cards WHERE ${s.where} ORDER BY id DESC`).all(...s.params).map(tagScope);
}

function listCardsByCategory(category) {
  const s = cardScopeSql();
  return shared.prepare(`SELECT ${CARD_COLS} FROM cards WHERE category = ? AND ${s.where} ORDER BY id DESC`).all(category, ...s.params).map(tagScope);
}

function getCard(id) {
  const row = shared.prepare(`SELECT * FROM cards WHERE id = ?`).get(id);
  if (!row) return null;
  // 私有卡只有属主可见（用户作用域）；共享作用域（系统内部）不受限
  if (!ctx.isSharedScope() && row.owner_uid != null && row.owner_uid !== ctx.currentUid()) return null;
  return row;
}

function assertCanWriteCard(id) {
  const row = shared.prepare(`SELECT owner_uid FROM cards WHERE id = ?`).get(id);
  if (!row) return false;
  if (ctx.isSharedScope()) return true; // 系统导入/整理
  return row.owner_uid != null && row.owner_uid === ctx.currentUid(); // 用户只能改自己的私有卡
}

function updateCard(id, { title, content }) {
  if (!assertCanWriteCard(id)) return false;
  return shared.prepare(`UPDATE cards SET title = ?, content = ? WHERE id = ?`).run(title, content, id).changes > 0;
}

function updateCardPublishedAt(id, publishedAt) {
  if (!assertCanWriteCard(id)) return false;
  return shared.prepare(`UPDATE cards SET published_at = ? WHERE id = ?`).run(publishedAt || null, id).changes > 0;
}

function deleteCard(id) {
  // 系统（共享作用域）可删公共卡；用户只能删自己的私有卡
  if (!assertCanWriteCard(id)) return false;
  shared.prepare(`DELETE FROM cards WHERE id = ?`).run(id);
  return true;
}

function deleteCardByTitle(title) {
  // 供抓取去重：仅删公共卡（owner_uid IS NULL），不碰任何人的私有卡
  shared.prepare(`DELETE FROM cards WHERE title = ? AND owner_uid IS NULL`).run(title);
}

function touchCard(id) {
  shared.prepare(`UPDATE cards SET used_at = datetime('now','localtime') WHERE id = ?`).run(id);
}

function getTodayCard(dayKey) {
  // 排除"今天已练过的"卡（练过的记录在当前用户库），公共 + 自己私有，优先没练的、最久没练的
  const s = cardScopeSql();
  const done = new Set(U().prepare(`SELECT DISTINCT card_id AS cid FROM sessions WHERE substr(started_at,1,10) = ?`).all(dayKey).map((r) => r.cid));
  const rows = shared.prepare(`SELECT ${CARD_COLS} FROM cards WHERE ${s.where} ORDER BY used_at IS NULL DESC, used_at ASC, id ASC`).all(...s.params);
  const hit = rows.find((r) => !done.has(r.id));
  return hit ? tagScope(hit) : null;
}

// ============ sessions（当前用户库） ============
function newSession(cardId) {
  const c = U();
  const card = shared.prepare(`SELECT title FROM cards WHERE id = ?`).get(cardId);
  const r = c.prepare(`INSERT INTO sessions (card_id, card_title) VALUES (?, ?)`).run(cardId, card ? card.title : '');
  touchCard(cardId);
  return Number(r.lastInsertRowid);
}

function getSession(id) {
  return U().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) || null;
}

function saveTurns(id, turns) {
  U().prepare(`UPDATE sessions SET turns = ? WHERE id = ?`).run(JSON.stringify(turns), id);
}

function finishSession(id, turns, report) {
  U().prepare(`UPDATE sessions SET ended_at = datetime('now','localtime'), turns = ?, report = ? WHERE id = ?`).run(JSON.stringify(turns), JSON.stringify(report), id);
}

function calcStreak() {
  const rows = U().prepare(`SELECT DISTINCT substr(started_at,1,10) AS d FROM sessions`).all();
  const days = new Set(rows.map((r) => r.d));
  let streak = 0;
  let cur = new Date();
  if (!days.has(localDayKey(cur))) cur.setDate(cur.getDate() - 1);
  while (days.has(localDayKey(cur))) {
    streak += 1;
    cur.setDate(cur.getDate() - 1);
  }
  return streak;
}

function practicedOn(dayKey) {
  return !!U().prepare(`SELECT 1 FROM sessions WHERE substr(started_at,1,10) = ? LIMIT 1`).get(dayKey);
}

function listHistory(limit = 30) {
  return U().prepare(`SELECT id, card_id, started_at, turns, report, card_title FROM sessions ORDER BY id DESC LIMIT ?`).all(limit).map((row) => {
    let turns = [];
    let report = {};
    try { turns = JSON.parse(row.turns || '[]'); } catch {}
    try { report = JSON.parse(row.report || '{}'); } catch {}
    const usrTurns = turns.filter((t) => t.role === 'user');
    const hasReport = !!(report && (report.summary || report.demo));
    return {
      id: row.id,
      cardId: row.card_id,
      date: String(row.started_at).slice(0, 10),
      cardTitle: row.card_title || '',
      turnsCount: usrTurns.length,
      summary: report.summary || '',
      status: hasReport ? 'done' : 'summarizing', // 无报告=AI 总结中/未完成
      lastRetell: usrTurns.length ? usrTurns[usrTurns.length - 1].text : '',
      turns,
      report,
    };
  });
}

// ============ words（当前用户库） ============
function addWord(word, better, context = '') {
  U().prepare(`INSERT INTO words (word, better, context) VALUES (?, ?, ?)`).run(word, better, context);
}
function listWords() {
  return U().prepare(`SELECT * FROM words ORDER BY id DESC`).all();
}

// ============ 一分钟演讲（当前用户库） ============
function createSpeechLog({ topic, kind = 'concept', spoken, score = null, feedback = null }) {
  const r = U().prepare(`INSERT INTO speech_logs (topic, kind, spoken, score, feedback) VALUES (?, ?, ?, ?, ?)`)
    .run(topic, kind, spoken, score, feedback ? JSON.stringify(feedback) : null);
  return Number(r.lastInsertRowid);
}
function listSpeechLogs() {
  return U().prepare(`SELECT * FROM speech_logs ORDER BY id DESC LIMIT 20`).all().map((row) => {
    let fb = null;
    try { fb = JSON.parse(row.feedback || 'null'); } catch {}
    return { ...row, feedback: fb };
  });
}

// ============ 读书标记（当前用户库） ============
function addBookMark({ bookId, chapter = 0, text, kind = 'mark', note = '' }) {
  const r = U().prepare(`INSERT INTO book_marks (book_id, chapter, text, kind, note) VALUES (?, ?, ?, ?, ?)`).run(bookId, chapter, text, kind, note);
  return Number(r.lastInsertRowid);
}
function deleteBookMark(id, bookId) {
  return U().prepare(`DELETE FROM book_marks WHERE id = ? AND book_id = ?`).run(id, bookId).changes > 0;
}
function deleteBookMarksByBook(bookId) {
  return U().prepare(`DELETE FROM book_marks WHERE book_id = ?`).run(bookId).changes > 0;
}
function listBookMarks(bookId) {
  return U().prepare(`SELECT * FROM book_marks WHERE book_id = ? ORDER BY id ASC`).all(bookId);
}

// ============ 链接解析任务（当前用户库） ============
const LINK_TASK_FIELDS = ['status', 'step', 'pct', 'meta', 'text', 'error', 'fmt', 'saved', 'card_id'];

function createLinkTask({ id, url, host = '' }) {
  U().prepare(`INSERT INTO link_tasks (id, url, host) VALUES (?, ?, ?)`).run(id, url, host);
}
function updateLinkTask(id, patch) {
  const keys = Object.keys(patch).filter((k) => LINK_TASK_FIELDS.includes(k));
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const vals = keys.map((k) => (k === 'meta' && patch[k] && typeof patch[k] === 'object' ? JSON.stringify(patch[k]) : patch[k]));
  U().prepare(`UPDATE link_tasks SET ${sets}, updated_at = datetime('now','localtime') WHERE id = ?`).run(...vals, id);
}
function getLinkTask(id) {
  const row = U().prepare(`SELECT * FROM link_tasks WHERE id = ?`).get(id);
  if (!row) return null;
  try { row.meta = row.meta ? JSON.parse(row.meta) : null; } catch { row.meta = null; }
  return row;
}
function listLinkTasks(limit = 30) {
  return U().prepare(`SELECT * FROM link_tasks ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(limit).map((row) => {
    try { row.meta = row.meta ? JSON.parse(row.meta) : null; } catch { row.meta = null; }
    return row;
  });
}
function findDoneTaskByUrl(url) {
  const row = U().prepare(`SELECT id FROM link_tasks WHERE url = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1`).get(url);
  return row ? row.id : null;
}
function findActiveTaskByUrl(url) {
  const row = U().prepare(`SELECT id FROM link_tasks WHERE url = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`).get(url);
  return row ? row.id : null;
}
function deleteLinkTask(id) {
  return U().prepare(`DELETE FROM link_tasks WHERE id = ?`).run(id).changes > 0;
}

// ============ 用户 / 邀请码（shared.db，供 auth.js 使用） ============
function sharedConn() { return shared; }
function createUser({ uid, name, isOwner = false }) {
  shared.prepare(`INSERT INTO users (uid, name, is_owner) VALUES (?, ?, ?)`).run(uid, name, isOwner ? 1 : 0);
}
function listUsers() {
  return shared.prepare(`SELECT uid, name, created_at, last_seen, is_owner FROM users ORDER BY created_at ASC`).all();
}
function updateUserSeen(uid) {
  shared.prepare(`UPDATE users SET last_seen = datetime('now','localtime') WHERE uid = ?`).run(uid);
}

// ============ stats ============
function totalSessions() {
  return Number(U().prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n);
}

module.exports = {
  localDayKey,
  // cards
  createCard, getTodayCard, listCards, listCardsByCategory, getCard,
  updateCard, updateCardPublishedAt, deleteCard, deleteCardByTitle,
  // sessions
  newSession, getSession, saveTurns, finishSession, calcStreak, practicedOn, listHistory,
  // words
  addWord, listWords,
  // speech
  createSpeechLog, listSpeechLogs,
  // marks
  addBookMark, deleteBookMark, deleteBookMarksByBook, listBookMarks,
  // link tasks
  createLinkTask, updateLinkTask, getLinkTask, listLinkTasks, findDoneTaskByUrl, findActiveTaskByUrl, deleteLinkTask,
  // users/auth helpers
  sharedConn, createUser, listUsers, updateUserSeen, openUser,
  totalSessions,
};
