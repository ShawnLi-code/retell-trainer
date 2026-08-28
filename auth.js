// 认证层（多用户）：邀请码进站 + httpOnly cookie 会话 + owner 引导 + 管理接口所需查询。
// 数据放在 shared.db（users / invite_codes / sessions 三张表）。
const crypto = require('node:crypto');
const db = require('./db');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const COOKIE = 'rt_uid';

// ---------- 表 ----------
db.sharedConn().exec(`
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_uid ON sessions(uid);
`);

// ---------- 小工具 ----------
const newUid = () => 'u' + crypto.randomBytes(5).toString('hex'); // u1a2b3c4d5
const newCode = () => {
  // 去掉易混字符（0/O/1/I）的 8 位大写码，方便微信里手输
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += abc[crypto.randomBytes(1)[0] % abc.length];
  return s.slice(0, 4) + '-' + s.slice(4);
};
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);

// ---------- owner 引导（全站第一个账号） ----------
// .env 里设了 OWNER_CODE 就必须用它建管理员；没设则第一个进站的人自动成为管理员。
function canBootstrap(code) {
  const hasOwner = !!db.sharedConn().prepare(`SELECT 1 FROM users WHERE is_owner=1 LIMIT 1`).get();
  if (hasOwner) return false;
  const envCode = process.env.OWNER_CODE;
  return envCode ? String(code || '').trim().toUpperCase() === String(envCode).trim().toUpperCase() : true;
}

function isBootstrapNeeded() {
  // 只要还没有站长，就处于"引导期"（提示语用）。有站长后一律走邀请码。
  return !db.sharedConn().prepare(`SELECT 1 FROM users WHERE is_owner=1 LIMIT 1`).get();
}

// ---------- 邀请码 ----------
function createInviteCode(label = '', createdBy = null) {
  const code = newCode();
  db.sharedConn().prepare(`INSERT INTO invite_codes (code, label, created_by) VALUES (?, ?, ?)`).run(code, String(label || '').slice(0, 30), createdBy);
  return code;
}
function revokeInviteCode(code) {
  return db.sharedConn().prepare(`UPDATE invite_codes SET revoked=1 WHERE code=?`).run(String(code || '').trim().toUpperCase()).changes > 0;
}
function listInviteCodes() {
  return db.sharedConn().prepare(`SELECT code, label, used_by, used_at, revoked, created_at FROM invite_codes ORDER BY created_at DESC, rowid DESC LIMIT 100`).all();
}
function consumeInviteCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)) return { ok: false, error: '邀请码格式不对（形如 ABCD-1234）' };
  const row = db.sharedConn().prepare(`SELECT * FROM invite_codes WHERE code=?`).get(c);
  if (!row || row.revoked) return { ok: false, error: '邀请码无效或已被停用' };
  if (row.used_by) return { ok: false, error: '这个邀请码已经被用过了，请找站长再生成一个' };
  return { ok: true, row };
}

// ---------- 进站 / 会话 ----------
function join(code, name) {
  const c = String(code || '').trim().toUpperCase();
  // 站长找回：迁移建了 uid='owner' 的账号后，用 .env 的 OWNER_CODE 直接登回那个账号（不新建用户）
  const envCode = String(process.env.OWNER_CODE || '').trim().toUpperCase();
  if (envCode && c === envCode) {
    const o = db.sharedConn().prepare(`SELECT * FROM users WHERE uid='owner'`).get();
    if (o) return { ok: true, uid: o.uid, isOwner: true };
  }
  const boot = canBootstrap(code);
  let codeRow = null;
  if (!boot) {
    const r = consumeInviteCode(code);
    if (!r.ok) return r;
    codeRow = r.row;
  } else if (String(code || '').trim()) {
    const r = consumeInviteCode(code); // 引导期也接受合法邀请码（用完记归属）
    if (r.ok) codeRow = r.row;
  }
  const uid = newUid();
  const hasOwner = !!db.sharedConn().prepare(`SELECT 1 FROM users WHERE is_owner=1 LIMIT 1`).get();
  const isOwner = !hasOwner; // 第一个账号 = 站长（引导码建的，或没设引导码时第一个进来的人）
  db.createUser({ uid, name: cleanName(name) || (isOwner ? '站长' : '朋友'), isOwner });
  if (codeRow) {
    db.sharedConn().prepare(`UPDATE invite_codes SET used_by=?, used_at=datetime('now','localtime') WHERE code=?`).run(uid, codeRow.code);
  }
  db.openUser(uid); // 立即建好该用户的库文件
  return { ok: true, uid, isOwner };
}

function createSession(uid) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sharedConn().prepare(`INSERT INTO sessions (token_hash, uid, expires_at) VALUES (?, ?, ?)`)
    .run(hash(token), uid, Date.now() + SESSION_TTL_MS);
  return token;
}
function lookupSession(token) {
  if (!token) return null;
  const row = db.sharedConn().prepare(`SELECT uid, expires_at FROM sessions WHERE token_hash=?`).get(hash(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.sharedConn().prepare(`DELETE FROM sessions WHERE token_hash=?`).run(hash(token));
    return null;
  }
  const u = db.sharedConn().prepare(`SELECT uid, name, is_owner FROM users WHERE uid=?`).get(row.uid);
  if (!u) return null;
  db.updateUserSeen(row.uid);
  return u;
}
function dropSessions(uid) {
  db.sharedConn().prepare(`DELETE FROM sessions WHERE uid=?`).run(uid);
}
function gcSessions() {
  try { db.sharedConn().prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now()); } catch { /* */ }
}

// ---------- 用户查询（管理页用） ----------
function getUser(uid) {
  return db.sharedConn().prepare(`SELECT uid, name, created_at, last_seen, is_owner FROM users WHERE uid=?`).get(uid) || null;
}
function listUsersWithStats() {
  const users = db.listUsers();
  return users.map((u) => {
    const stats = { sessions: 0, streak: 0 };
    try {
      const c = db.openUser(u.uid);
      stats.sessions = Number(c.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n);
      stats.words = Number(c.prepare(`SELECT COUNT(*) AS n FROM words`).get().n);
    } catch { /* 库还没建就是 0 */ }
    return { ...u, ...stats };
  });
}

// ---------- cookie ----------
function setSessionCookie(res, token, secure) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`);
}
function clearSessionCookie(res, secure) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}
function readAuth(req) {
  const raw = String(req.headers.cookie || '');
  const m = raw.match(/(?:^|;\s*)rt_uid=([0-9a-f]{24,})/);
  return m ? lookupSession(m[1]) : null;
}

module.exports = {
  COOKIE, SESSION_TTL_MS,
  canBootstrap, isBootstrapNeeded,
  createInviteCode, revokeInviteCode, listInviteCodes, consumeInviteCode,
  join, createSession, lookupSession, dropSessions, gcSessions,
  getUser, listUsersWithStats,
  setSessionCookie, clearSessionCookie, readAuth,
};
