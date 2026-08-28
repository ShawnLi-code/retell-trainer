// 一次性迁移：单用户 trainer.db → 多用户结构（跑一次，跑前自动备份）
//   data/shared.db          公共素材（owner_uid=NULL）+ 自动抓的 ted/rmrb/short/story
//   data/users/owner.db     站长的 sessions/words/speech_logs/book_marks/link_tasks + 私有卡入 shared
//   data/books/owner/ 等    书架 / 图片缓存 / epub 转换缓存 / 面试记录 按用户分目录
// 用法：node migrate-multiuser.js [--dry-run]   （--dry-run 全程只读，不落盘）
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DRY = process.argv.includes('--dry-run');
const DATA = path.join(__dirname, 'data');
const OLD_DB = path.join(DATA, 'trainer.db');
const SHARED_DB = path.join(DATA, 'shared.db');
const USERS_DIR = path.join(DATA, 'users');
const OWNER = 'owner';
const log = (m) => console.log((DRY ? '[dry] ' : '') + m);
const done = (m) => console.log((DRY ? '[dry] (跳过写入) ' : '') + m);

if (!fs.existsSync(OLD_DB)) {
  console.error('没找到 data/trainer.db——本脚本只用于把旧单用户库迁到多用户结构');
  process.exit(1);
}
// 幂等保护：真跑时若 shared.db 已存在则检查——只要里面已有用户就拒绝（防重复搬错）；
// 若是服务启动自动建的"空库"（users 表无数据）则继续迁移。
if (!DRY && fs.existsSync(SHARED_DB)) {
  try {
    const probe = new DatabaseSync(SHARED_DB, { readOnly: true });
    const hasUsers = probe.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`).get();
    const nUsers = hasUsers ? probe.prepare(`SELECT COUNT(*) n FROM users`).get().n : 0;
    probe.close();
    if (nUsers > 0) {
      console.error(`data/shared.db 里已有 ${nUsers} 个用户——看起来迁移已经跑过了（拒绝重复跑，防止搬错）`);
      process.exit(1);
    }
    console.log('检测到服务启动时建的空 shared.db，继续迁移（会把旧库数据搬入）');
  } catch (e) {
    console.error('无法读取已存在的 shared.db：' + e.message);
    process.exit(1);
  }
}

// ---------- 只读：从旧库统计拆分结果 ----------
const old = new DatabaseSync(OLD_DB, { readOnly: true });
// 卡片归属：自动抓的板块 = 公共；抖音/小红书解析、读书复述卡 = 站长私有
const isPrivateCard = `(category = 'video' OR source LIKE '抖音%' OR source LIKE '小红书%' OR source LIKE '网页%' OR source LIKE '读书复述%')`;
const nOld = old.prepare(`SELECT COUNT(*) n FROM cards`).get().n;
const nPriv = old.prepare(`SELECT COUNT(*) n FROM cards WHERE ${isPrivateCard}`).get().n;
const nPublic = nOld - nPriv;
const cSessions = old.prepare(`SELECT COUNT(*) n FROM sessions`).get().n;
const cWords = old.prepare(`SELECT COUNT(*) n FROM words`).get().n;
const cSpeech = old.prepare(`SELECT COUNT(*) n FROM speech_logs`).get().n;
const cMarks = old.prepare(`SELECT COUNT(*) n FROM book_marks`).get().n;
const cTasks = old.prepare(`SELECT COUNT(*) n FROM link_tasks`).get().n;
log(`cards：原 ${nOld} 张 → 公共 ${nPublic} 张 · 站长私有 ${nPriv} 张`);
log(`owner.db：sessions=${cSessions} words=${cWords} speech=${cSpeech} marks=${cMarks} link_tasks=${cTasks}`);

// 目录搬迁计划
function planMove(base) {
  if (!fs.existsSync(base)) return { base, items: [] };
  const items = fs.readdirSync(base).filter((n) => n !== OWNER);
  return { base, items };
}
const bookDir = path.join(DATA, 'books');
const imgDir = path.join(DATA, 'imgs');
const epubDir = path.join(DATA, 'epubs');
const moves = [bookDir, imgDir, epubDir].map(planMove);
for (const m of moves) if (m.items.length) log(`目录：${path.relative(__dirname, m.base)}/ 下 ${m.items.length} 项 → 归入 ${OWNER}/`);

if (DRY) {
  console.log('\n（dry-run 结束，未做任何写入）');
  old.close();
  process.exit(0);
}
old.close();

// ---------- 建库并搬数据 ----------
const shared = new DatabaseSync(SHARED_DB);
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

fs.mkdirSync(USERS_DIR, { recursive: true });
const ownerDb = new DatabaseSync(path.join(USERS_DIR, OWNER + '.db'));
ownerDb.exec(`
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
`);

const attach = `ATTACH DATABASE '${OLD_DB.replace(/'/g, "''")}' AS old`;
shared.exec(attach);
shared.exec(`
INSERT INTO cards (id, title, content, source, category, published_at, created_at, used_at, owner_uid)
SELECT id, title, content, source, category, published_at, created_at, used_at,
       CASE WHEN ${isPrivateCard} THEN '${OWNER}' ELSE NULL END
FROM old.cards`);
shared.exec(`INSERT INTO users (uid, name, is_owner) VALUES ('${OWNER}', '站长', 1)`);
shared.exec(`DETACH DATABASE old`);

ownerDb.exec(attach);
ownerDb.exec(`
INSERT INTO sessions (id, card_id, card_title, started_at, ended_at, turns, report)
SELECT s.id, s.card_id, COALESCE(c.title, ''), s.started_at, s.ended_at, s.turns, s.report
FROM old.sessions s LEFT JOIN old.cards c ON c.id = s.card_id`);
ownerDb.exec(`INSERT INTO words SELECT * FROM old.words`);
ownerDb.exec(`INSERT INTO speech_logs SELECT * FROM old.speech_logs`);
ownerDb.exec(`INSERT INTO book_marks SELECT * FROM old.book_marks`);
ownerDb.exec(`INSERT INTO link_tasks SELECT * FROM old.link_tasks`);
ownerDb.exec(`DETACH DATABASE old`);

const nPub = shared.prepare(`SELECT COUNT(*) n FROM cards WHERE owner_uid IS NULL`).get().n;
const nPrv = shared.prepare(`SELECT COUNT(*) n FROM cards WHERE owner_uid='${OWNER}'`).get().n;
done(`shared.cards：公共 ${nPub} · 私有 ${nPrv}`);
done(`owner.db：sessions=${ownerDb.prepare(`SELECT COUNT(*) n FROM sessions`).get().n} words=${ownerDb.prepare(`SELECT COUNT(*) n FROM words`).get().n} speech=${ownerDb.prepare(`SELECT COUNT(*) n FROM speech_logs`).get().n}`);

// 收尾把 owner 库标记为已看过（last_seen 由登录更新）

// ---------- 文件目录：书架 / 缓存 / 面试记录 归到 owner 名下 ----------
function moveIntoUserSub(base) {
  if (!fs.existsSync(base)) return;
  const dest = path.join(base, OWNER);
  fs.mkdirSync(dest, { recursive: true });
  let moved = 0;
  for (const name of fs.readdirSync(base)) {
    if (name === OWNER) continue;
    fs.renameSync(path.join(base, name), path.join(dest, name));
    moved++;
  }
  done(`${path.relative(__dirname, base)}/ → ${path.relative(__dirname, dest)}/ （${moved} 项）`);
}
moveIntoUserSub(bookDir);
moveIntoUserSub(imgDir);
moveIntoUserSub(epubDir);

const rec = path.join(DATA, 'interview-records.json');
if (fs.existsSync(rec)) {
  fs.mkdirSync(path.join(DATA, 'interview-records'), { recursive: true });
  fs.renameSync(rec, path.join(DATA, 'interview-records', OWNER + '.json'));
  done('interview-records.json → interview-records/owner.json');
}

shared.close();
ownerDb.close();

const bak = OLD_DB + '.migrated.bak';
fs.renameSync(OLD_DB, bak);
done(`旧库已保留为 ${path.relative(__dirname, bak)}（确认没问题后可删）`);

console.log('\n✅ 迁移完成。');
console.log('上线前记得在服务器 .env 里配：OWNER_CODE=<你自定的强口令>（站长用这个码登回自己账号）');
console.log('登录后在「管理」页生成邀请码发给朋友。');
