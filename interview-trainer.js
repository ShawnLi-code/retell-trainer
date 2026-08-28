// 面试刷题：读取 interview-bank/ 下的北梦测 Markdown 题库，提供随机抽题、
// 三分钟回答、标准答案复盘、二次复述和本地记录。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chat, parseJson, isConfigured } = require('./llm');
const ctx = require('./ctx');

const SOURCE_ROOT = path.resolve(process.env.INTERVIEW_BANK_DIR || path.join(__dirname, 'interview-bank'));
// 面试记录按用户分文件（物理隔离）；无用户作用域（系统内部）落 _shared
const RECORDS_BASE = path.join(__dirname, 'data', 'interview-records');
const recordsFile = () => {
  const uid = ctx.currentUid();
  const seg = uid ? String(uid).replace(/[^a-zA-Z0-9_-]/g, '') : '_shared';
  return path.join(RECORDS_BASE, seg + '.json');
};
const QUESTION_DIRS = { interview: '面试题库', real: '企业真题' };
const recordsLock = { busy: false };
let questionCache = { signature: '', questions: [] };

function cleanMarkdown(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/^>.*$/gm, '')
    .replace(/^---+$/gm, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function makeId(type, source, number, question) {
  return crypto.createHash('sha1').update(`${type}|${source}|${number}|${question}`).digest('hex').slice(0, 16);
}

function parseInterviewFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const matches = [...text.matchAll(/^##\s+(\d+)\.\s*(.+?)\s*$/gm)];
  const category = path.basename(file, '.md');
  return matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? text.length;
    const body = text.slice(match.index + match[0].length, end);
    const answerMatch = body.match(/^###\s*参考答案\s*\n([\s\S]*?)(?=^###\s|^---\s*$|$)/m);
    const question = cleanMarkdown(match[2]);
    return {
      id: makeId('interview', path.basename(file), match[1], question),
      type: 'interview', typeName: '面试题库', category, source: path.basename(file),
      number: Number(match[1]), question,
      standardAnswer: answerMatch ? cleanMarkdown(answerMatch[1]) : '',
    };
  }).filter((item) => item.question);
}

function parseRealFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const matches = [...text.matchAll(/^##\s+(\d+)\s*$/gm)];
  const category = path.basename(file, '.md');
  return matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? text.length;
    let question = cleanMarkdown(text.slice(match.index + match[0].length, end));
    question = question.split(/\n\n---/, 1)[0].replace(/^[-*]\s*/, '').trim();
    return {
      id: makeId('real', path.basename(file), match[1], question),
      type: 'real', typeName: '企业真题', category, source: path.basename(file),
      number: Number(match[1]), question, standardAnswer: '',
    };
  }).filter((item) => item.question);
}

function sourceSignature() {
  const parts = [];
  for (const dir of Object.values(QUESTION_DIRS)) {
    const folder = path.join(SOURCE_ROOT, dir);
    if (!fs.existsSync(folder)) continue;
    for (const file of fs.readdirSync(folder).filter((name) => name.toLowerCase().endsWith('.md'))) {
      const full = path.join(folder, file);
      parts.push(`${full}:${fs.statSync(full).mtimeMs}`);
    }
  }
  return parts.sort().join('|');
}

function allQuestions() {
  const signature = sourceSignature();
  if (signature === questionCache.signature) return questionCache.questions;
  const questions = [];
  for (const [type, dir] of Object.entries(QUESTION_DIRS)) {
    const folder = path.join(SOURCE_ROOT, dir);
    if (!fs.existsSync(folder)) continue;
    for (const file of fs.readdirSync(folder).filter((name) => name.toLowerCase().endsWith('.md') && name.toLowerCase() !== 'readme.md').sort()) {
      questions.push(...(type === 'interview' ? parseInterviewFile(path.join(folder, file)) : parseRealFile(path.join(folder, file))));
    }
  }
  questionCache = { signature, questions };
  return questions;
}

function publicQuestion(question, includeAnswer = false) {
  const result = {
    id: question.id, type: question.type, typeName: question.typeName,
    category: question.category, source: question.source, number: question.number, question: question.question,
  };
  if (includeAnswer) result.standardAnswer = question.standardAnswer || '';
  return result;
}

function readRecords() {
  const file = recordsFile();
  if (!fs.existsSync(file)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function writeRecords(records) {
  const file = recordsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(records, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function now() { return new Date().toISOString(); }

function questionTerms(text) {
  return new Set(String(text || '').toLowerCase().match(/[\u4e00-\u9fff]{2,8}|[a-z][a-z0-9_+-]{2,}/g) || []);
}

function normalizeSummary(value, question, source) {
  const score = Math.max(0, Math.min(100, Number.parseInt(value?.score, 10) || 0));
  const list = (key) => (Array.isArray(value?.[key]) ? value[key] : []).map(String).map((item) => item.trim()).filter(Boolean).slice(0, 8);
  return {
    score,
    summary: String(value?.summary || '回答已完成复盘。'),
    strengths: list('strengths'), gaps: list('gaps'), suggestions: list('suggestions'),
    referenceAnswer: String(value?.referenceAnswer || question.standardAnswer || '建议按背景、职责、做法、结果和复盘组织回答。'),
    source: source || 'rubric',
  };
}

function fallbackSummary(question, answer) {
  const standard = question.standardAnswer || '';
  const mine = questionTerms(answer);
  const expected = questionTerms(standard);
  const covered = [...expected].filter((term) => mine.has(term));
  const missing = [...expected].filter((term) => !mine.has(term)).slice(0, 8);
  const hasLength = String(answer).trim().length >= 100;
  if (standard) {
    return normalizeSummary({
      score: Math.max(30, Math.min(96, 42 + Math.round(54 * covered.length / Math.max(1, expected.size)))),
      summary: '回答已完成，下面按题目参考答案和表达结构进行复盘。',
      strengths: [hasLength ? '回答有一定展开，具备口头表达的完整度。' : '已经完成作答，下一轮可以更快给出结论和结构。', covered.length ? `覆盖了部分参考要点：${covered.slice(0, 6).join('、')}。` : ''],
      gaps: [missing.length ? `可以补充：${missing.join('、')}` : '关键要点覆盖较完整，可继续补充真实项目数据。'],
      suggestions: ['先给结论，再按 2-4 个要点展开，最后用结果或复盘收尾。', '尽量加入时间、数量、工具或结果等可验证细节。'],
      referenceAnswer: standard,
    }, question, 'rubric');
  }
  return normalizeSummary({
    score: hasLength ? 55 : 38,
    summary: '企业真题原始资料未附标准答案，先按真实面试回答框架进行复盘。',
    strengths: [hasLength ? '回答有一定展开，具备口头表达的完整度。' : '已经完成作答，下一轮可以更快给出结论和结构。'],
    gaps: ['建议补充背景、你的职责、具体步骤、结果数据和复盘。'],
    suggestions: ['先说背景和目标，再讲职责、做法、难点与取舍，最后用数据收尾。', '把“我做了什么”与“结果怎样”说得更具体。'],
    referenceAnswer: '建议按“背景/目标 → 我的职责 → 具体做法 → 难点与取舍 → 结果数据 → 复盘”组织回答。',
  }, question, 'rubric');
}

async function summarize(question, answer, previous) {
  if (isConfigured()) {
    try {
      const raw = await chat([
        { role: 'system', content: '你是一名严格但建设性的中文技术面试官。请按证据复盘回答，不编造事实，只返回严格 JSON。' },
        { role: 'user', content: JSON.stringify({
          题目类型: question.typeName, 分类: question.category, 题目: question.question,
          标准答案或参考要点: question.standardAnswer || '企业真题未附标准答案，请按完整回答框架评估。',
          候选人回答: answer, 上一次总结: previous || null,
          返回结构: { score: 0, summary: '一句结论', strengths: [], gaps: [], suggestions: [], referenceAnswer: '适合口头复述的参考回答' },
        }, null, 2) },
      ], { json: true, temperature: 0.2 });
      return normalizeSummary(parseJson(raw), question, 'ai');
    } catch (error) { console.warn('[面试刷题] AI 总结失败，使用本地评分：', error.message); }
  }
  return fallbackSummary(question, answer);
}

function listRecords() { return readRecords().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }

async function start(questionId) {
  const question = allQuestions().find((item) => item.id === questionId);
  if (!question) throw new Error('题目不存在');
  const record = {
    id: crypto.randomBytes(8).toString('hex'), createdAt: now(), startedAt: now(), status: 'answering',
    type: question.type, typeName: question.typeName, category: question.category, source: question.source,
    question: publicQuestion(question, true),
  };
  const records = readRecords(); records.push(record); writeRecords(records); return record;
}

async function answer(id, text) {
  const records = readRecords(); const record = records.find((item) => item.id === id);
  if (!record) throw new Error('练习记录不存在');
  if (record.status !== 'answering') throw new Error('当前练习不在首次回答阶段');
  const value = String(text || '').trim(); if (!value) throw new Error('回答不能为空');
  record.firstAnswer = value; record.firstAnsweredAt = now();
  record.elapsedSeconds = Math.max(0, Math.round((Date.now() - Date.parse(record.startedAt)) / 1000));
  record.summary = await summarize(record.question, value); record.status = 'review'; writeRecords(records); return record;
}

async function restate(id, text) {
  const records = readRecords(); const record = records.find((item) => item.id === id);
  if (!record) throw new Error('练习记录不存在');
  if (record.status !== 'review') throw new Error('请先完成首次回答');
  const value = String(text || '').trim(); if (!value) throw new Error('回答不能为空');
  record.restateAnswer = value; record.restateAnsweredAt = now();
  record.restateSummary = await summarize(record.question, value, record.summary); record.status = 'completed'; record.completedAt = now(); writeRecords(records); return record;
}

module.exports = {
  allQuestions, publicQuestion, isConfigured, listRecords, start, answer, restate,
  random(type) {
    const pool = allQuestions().filter((item) => !type || item.type === type);
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  },
};
