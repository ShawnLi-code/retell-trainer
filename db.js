// 数据库层：node:sqlite（Node ≥ 22.5 内置，无需额外依赖）
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'trainer.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT DEFAULT '',
  category TEXT DEFAULT 'story',
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER,
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
`);

// 兼容旧库：补 category 列
try { db.exec(`ALTER TABLE cards ADD COLUMN category TEXT DEFAULT 'story'`); } catch { /* 已存在 */ }
try { db.exec(`ALTER TABLE cards ADD COLUMN published_at TEXT`); } catch { /* 已存在 */ }

// ---------- 本地日期工具 ----------
// 注意：SQLite 的 date() 按 UTC 解析字符串，跨时区会算错日期，
// 所以日期一律在 JS 里用 substr(started_at,1,10) 取本地日。
function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------- cards ----------
const addCard = db.prepare(`INSERT INTO cards (title, content, source, category, published_at) VALUES (?, ?, ?, ?, ?)`);
const listCardsStmt = db.prepare(`SELECT id, title, content, source, category, published_at, created_at, used_at FROM cards ORDER BY id DESC`);
const listCardsByCatStmt = db.prepare(`SELECT id, title, content, source, category, published_at, created_at, used_at FROM cards WHERE category = ? ORDER BY id DESC`);
const getCardStmt = db.prepare(`SELECT * FROM cards WHERE id = ?`);
const touchCard = db.prepare(`UPDATE cards SET used_at = datetime('now','localtime') WHERE id = ?`);
const updateCardStmt = db.prepare(`UPDATE cards SET title = ?, content = ? WHERE id = ?`);
const updateCardDateStmt = db.prepare(`UPDATE cards SET published_at = ? WHERE id = ?`);

function createCard({ title, content, source = '', category = 'story', publishedAt = localDayKey() }) {
  const r = addCard.run(title, content, source, category, publishedAt || null);
  return Number(r.lastInsertRowid);
}

function listCards() {
  return listCardsStmt.all();
}

function listCardsByCategory(category) {
  return listCardsByCatStmt.all(category);
}

function getCard(id) {
  return getCardStmt.get(id);
}

function updateCard(id, { title, content }) {
  return updateCardStmt.run(title, content, id).changes > 0;
}

function updateCardPublishedAt(id, publishedAt) {
  return updateCardDateStmt.run(publishedAt || null, id).changes > 0;
}

const deleteCardStmt = db.prepare(`DELETE FROM cards WHERE id = ?`);
const deleteCardByTitleStmt = db.prepare(`DELETE FROM cards WHERE title = ?`);

function deleteCard(id) {
  deleteCardStmt.run(id);
}

function deleteCardByTitle(title) {
  deleteCardByTitleStmt.run(title);
}

function getTodayCard(dayKey) {
  // 优先从未练过的卡，其次最久没练的卡
  return db.prepare(`
    SELECT * FROM cards
    WHERE id NOT IN (SELECT card_id FROM sessions WHERE substr(started_at,1,10) = ?)
    ORDER BY used_at IS NULL DESC, used_at ASC, id ASC
    LIMIT 1
  `).get(dayKey) || null;
}

// ---------- sessions ----------
const createSession = db.prepare(`INSERT INTO sessions (card_id) VALUES (?)`);
const getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
const saveTurnsStmt = db.prepare(`UPDATE sessions SET turns = ? WHERE id = ?`);
const finishSessionStmt = db.prepare(`UPDATE sessions SET ended_at = datetime('now','localtime'), turns = ?, report = ? WHERE id = ?`);

function newSession(cardId) {
  const r = createSession.run(cardId);
  touchCard.run(cardId);
  return Number(r.lastInsertRowid);
}

function getSession(id) {
  return getSessionStmt.get(id);
}

function saveTurns(id, turns) {
  saveTurnsStmt.run(JSON.stringify(turns), id);
}

function finishSession(id, turns, report) {
  finishSessionStmt.run(JSON.stringify(turns), JSON.stringify(report), id);
}

function calcStreak() {
  const rows = db.prepare(`SELECT DISTINCT substr(started_at,1,10) AS d FROM sessions`).all();
  const days = new Set(rows.map((r) => r.d));
  let streak = 0;
  let cur = new Date();
  if (!days.has(localDayKey(cur))) cur.setDate(cur.getDate() - 1); // 今天没练就从昨天算
  while (days.has(localDayKey(cur))) {
    streak += 1;
    cur.setDate(cur.getDate() - 1);
  }
  return streak;
}

function practicedOn(dayKey) {
  return !!db.prepare(`SELECT 1 FROM sessions WHERE substr(started_at,1,10) = ? LIMIT 1`).get(dayKey);
}

function listHistory(limit = 30) {
  return db.prepare(`
    SELECT s.id, s.card_id, s.started_at, s.turns, s.report,
           c.title AS cardTitle
    FROM sessions s JOIN cards c ON c.id = s.card_id
    ORDER BY s.id DESC LIMIT ?
  `).all(limit).map((row) => {
    let turns = [];
    let report = {};
    try { turns = JSON.parse(row.turns || '[]'); } catch {}
    try { report = JSON.parse(row.report || '{}'); } catch {}
    return {
      id: row.id,
      cardId: row.card_id,
      date: String(row.started_at).slice(0, 10),
      cardTitle: row.cardTitle,
      turnsCount: turns.filter((t) => t.role === 'user').length,
      summary: report.summary || '',
      turns,
      report,
    };
  });
}

// ---------- words ----------
const addWordStmt = db.prepare(`INSERT INTO words (word, better, context) VALUES (?, ?, ?)`);
const listWordsStmt = db.prepare(`SELECT * FROM words ORDER BY id DESC`);

function addWord(word, better, context = '') {
  addWordStmt.run(word, better, context);
}

function listWords() {
  return listWordsStmt.all();
}

// ---------- 一分钟演讲挑战 ----------
const addSpeechStmt = db.prepare(`INSERT INTO speech_logs (topic, kind, spoken, score, feedback) VALUES (?, ?, ?, ?, ?)`);
const listSpeechStmt = db.prepare(`SELECT * FROM speech_logs ORDER BY id DESC LIMIT 20`);

function createSpeechLog({ topic, kind = 'concept', spoken, score = null, feedback = null }) {
  const r = addSpeechStmt.run(topic, kind, spoken, score, feedback ? JSON.stringify(feedback) : null);
  return Number(r.lastInsertRowid);
}

function listSpeechLogs() {
  return listSpeechStmt.all().map((row) => {
    let fb = null;
    try { fb = JSON.parse(row.feedback || 'null'); } catch {}
    return { ...row, feedback: fb };
  });
}

// ---------- 读书标记 ----------
const addMarkStmt = db.prepare(`INSERT INTO book_marks (book_id, chapter, text, kind, note) VALUES (?, ?, ?, ?, ?)`);
const delMarkStmt = db.prepare(`DELETE FROM book_marks WHERE id = ? AND book_id = ?`);
const listMarksStmt = db.prepare(`SELECT * FROM book_marks WHERE book_id = ? ORDER BY id ASC`);

function addBookMark({ bookId, chapter = 0, text, kind = 'mark', note = '' }) {
  const r = addMarkStmt.run(bookId, chapter, text, kind, note);
  return Number(r.lastInsertRowid);
}

function deleteBookMark(id, bookId) {
  return delMarkStmt.run(id, bookId).changes > 0;
}

function listBookMarks(bookId) {
  return listMarksStmt.all(bookId);
}

// ---------- stats ----------
function totalSessions() {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n);
}

module.exports = {
  localDayKey,
  createCard,
  getTodayCard,
  listCards,
  listCardsByCategory,
  getCard,
  updateCard,
  updateCardPublishedAt,
  deleteCard,
  deleteCardByTitle,
  newSession,
  getSession,
  saveTurns,
  finishSession,
  calcStreak,
  practicedOn,
  listHistory,
  addWord,
  listWords,
  createSpeechLog,
  listSpeechLogs,
  addBookMark,
  deleteBookMark,
  listBookMarks,
  totalSessions,
};
