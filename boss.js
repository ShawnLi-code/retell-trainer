// BOSS直聘岗位监测：数据接收（本地抓取端推送）+ 网页展示。
// 架构：真正的抓取跑在你本机 Windows（依赖已过滑块验证的常驻 Chrome，auto_boss_daily/），
// 每天抓完 POST 推送到这里；服务器只负责存储、统计与展示，不直接访问 Boss（机房 IP 必被验证墙拦）。
// 数据目录 data/boss/（已被 .gitignore 排除）：
//   config.json    抓取参数（站长在网页改 → 本地抓取端每次运行前拉取生效）
//   trigger.json   「立即抓取」标志（网页点击 → 本地 5 分钟轮询器消费后触发一次抓取）
//   status.json    最近一次推送状态（网页状态条展示）
//   days/YYYY-MM-DD.json  每日快照（zp_daily.js 推上来的 summary 原样保存）
const path = require('node:path');
const fs = require('node:fs');

const DIR = path.join(__dirname, 'data', 'boss');
const DAYS_DIR = path.join(DIR, 'days');

// 默认抓取参数：与 README 记录的当前生效值一致（1-3年 + 8-13K档 + 关键词"测试"）
const DEFAULT_CONFIG = {
  query: '测试',
  cities: [
    { name: '西安', code: '101110100' },
    { name: '广州', code: '101280100' },
    { name: '成都', code: '101270100' },
  ],
  experience: '104',
  salary: '404',
  pages: 1,
};

// ---------- 小工具 ----------
function ensureDirs() {
  fs.mkdirSync(DAYS_DIR, { recursive: true });
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  ensureDirs();
  fs.writeFileSync(file, JSON.stringify(obj, null, 1), 'utf8');
}
function pad(n) { return String(n).padStart(2, '0'); }
function todayKey(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------- 参数配置 ----------
function getConfig() {
  const c = readJson(path.join(DIR, 'config.json'), null);
  if (!c) return { ...DEFAULT_CONFIG };
  // 兜底补齐缺省字段（老配置升级不炸）
  return { ...DEFAULT_CONFIG, ...c, cities: Array.isArray(c.cities) && c.cities.length ? c.cities : DEFAULT_CONFIG.cities };
}
// 校验并规范化站长提交的参数；返回 { ok, config?, error? }
function normalizeConfig(input) {
  const out = {};
  const query = String((input || {}).query || '').trim();
  if (!query) return { ok: false, error: '关键词不能为空' };
  if (query.length > 40) return { ok: false, error: '关键词太长（最多 40 字）' };
  out.query = query;

  const cities = Array.isArray((input || {}).cities) ? input.cities : [];
  const cleaned = [];
  for (const c of cities) {
    const name = String((c || {}).name || '').trim().slice(0, 12);
    const code = String((c || {}).code || '').trim().replace(/\D/g, '');
    if (name && code && !cleaned.some((x) => x.code === code)) cleaned.push({ name, code });
  }
  if (!cleaned.length) return { ok: false, error: '至少要选一个城市' };
  if (cleaned.length > 8) return { ok: false, error: '城市最多 8 个（太多会拖长抓取时间）' };
  out.cities = cleaned;

  const exp = String((input || {}).experience || '').trim().replace(/\D/g, '');
  if (exp && !['101', '102', '103', '104', '105', '106', '107'].includes(exp)) return { ok: false, error: '经验档位不对' };
  out.experience = exp;

  const sal = String((input || {}).salary || '').trim().replace(/\D/g, '');
  if (sal && !['400', '401', '402', '403', '404', '405', '406'].includes(sal)) return { ok: false, error: '薪资档位不对' };
  out.salary = sal;

  const pages = Math.max(1, Math.min(3, Number((input || {}).pages) || 1));
  out.pages = pages;
  return { ok: true, config: out };
}
function saveConfig(cfg, updatedBy) {
  const full = { ...cfg, updatedAt: new Date().toISOString(), updatedBy: updatedBy || '' };
  writeJson(path.join(DIR, 'config.json'), full);
  return full;
}

// ---------- 「立即抓取」触发 ----------
function setTrigger(by) {
  writeJson(path.join(DIR, 'trigger.json'), { run: true, requestedAt: new Date().toISOString(), by: by || '' });
}
// 抓取端轮询：返回 { run, config } 并消费掉 run 标志
function consumeTrigger() {
  const t = readJson(path.join(DIR, 'trigger.json'), { run: false });
  const config = getConfig();
  if (t.run) writeJson(path.join(DIR, 'trigger.json'), { run: false, consumedAt: new Date().toISOString(), requestedAt: t.requestedAt || '', by: t.by || '' });
  return { run: Boolean(t.run), requestedAt: t.requestedAt || '', config };
}

// ---------- 每日数据 ----------
function dayPath(date) { return path.join(DAYS_DIR, date + '.json'); }
function saveDaily(summary) {
  const date = String(summary.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式不对');
  ensureDirs();
  writeJson(dayPath(date), summary);
  // 更新推送状态（保留最近 20 条历史）
  const st = readJson(path.join(DIR, 'status.json'), {});
  st.lastPushAt = new Date().toISOString();
  st.lastPushDate = date;
  st.needVerify = Boolean(summary.needVerify);
  st.lastPushTotal = (summary.cities || []).reduce((n, c) => n + (Number(c.total) || 0), 0);
  st.history = (st.history || []).filter((h) => h.date !== date).slice(-19);
  st.history.push({ at: st.lastPushAt, date, total: st.lastPushTotal, needVerify: st.needVerify });
  writeJson(path.join(DIR, 'status.json'), st);
  return true;
}
function getStatus() { return readJson(path.join(DIR, 'status.json'), {}); }
function listDays() {
  ensureDirs();
  return fs.readdirSync(DAYS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.replace('.json', '')).sort();
}
function getDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  return readJson(dayPath(date), null);
}
function latestDay() {
  const days = listDays();
  return days.length ? days[days.length - 1] : null;
}

// 跨天索引：每个职位 id 的 firstSeen / 最近 7 天是否在线（网页 🆕 与「本周活跃」徽章用）
function buildIndex() {
  const days = listDays();
  const last7 = new Set(days.slice(-7));
  const index = {}; // id -> { firstSeen, lastSeen, onlineDays:Set }
  for (const d of days) {
    const day = getDay(d);
    for (const c of (day && day.cities) || []) {
      for (const j of (c.jobs) || []) {
        if (!j.id) continue;
        if (!index[j.id]) index[j.id] = { firstSeen: d, lastSeen: d, onlineDays: new Set() };
        index[j.id].lastSeen = d;
        if (j.online) index[j.id].onlineDays.add(d);
      }
    }
  }
  // 序列化：给前端的紧凑形态
  const firstSeen = {}; const activeIds = [];
  for (const [id, v] of Object.entries(index)) {
    firstSeen[id] = v.firstSeen;
    if (v.onlineDays.size && [...v.onlineDays].some((d) => last7.has(d))) activeIds.push(id);
  }
  return { firstSeen, activeIds, last7: [...last7] };
}

// 网页总览：日期列表 + 每日各城市计数（画趋势用）
function overview() {
  const days = listDays();
  const byDate = days.map((d) => {
    const day = getDay(d) || {};
    const cities = {};
    let total = 0;
    for (const c of (day.cities) || []) {
      cities[c.city] = { total: Number(c.total) || 0, online: Number(c.bossOnline) || 0, needVerify: Boolean(c.risk) };
      total += Number(c.total) || 0;
    }
    return { date: d, total, cities, needVerify: Boolean(day.needVerify) };
  });
  return { dates: byDate, latest: days.length ? days[days.length - 1] : null, status: getStatus(), index: buildIndex() };
}

module.exports = {
  DEFAULT_CONFIG,
  getConfig, normalizeConfig, saveConfig,
  setTrigger, consumeTrigger,
  saveDaily, getStatus, listDays, getDay, latestDay, overview,
};
