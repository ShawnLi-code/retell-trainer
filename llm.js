// LLM 调用封装：OpenAI 兼容 chat/completions
// 主渠道（默认配置）+ 备用渠道（DeepSeek 官方）：主渠道失败自动切换

// 主渠道
const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'deepseek-chat';
// 备用渠道（DeepSeek 官方）
const DS_BASE_URL = (process.env.DS_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DS_API_KEY = process.env.DS_API_KEY || '';
const DS_MODEL = process.env.DS_MODEL || 'deepseek-chat';
// 单次调用超时：可用 LLM_TIMEOUT_MS 覆盖。超时不再同渠道重试（那只会把等待翻倍），直接切下一渠道
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 90000;

function isConfigured() {
  return !!API_KEY || !!DS_API_KEY;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callOnce(opts, messages, { json, temperature }) {
  const { base, key, model } = opts;
  const body = { model, messages, temperature };
  if (json) body.response_format = { type: 'json_object' };

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err?.cause?.message || err?.message || '';
    const e = new Error(`网络失败:${detail}`);
    // 超时/中断：同渠道再等一次只会把用户等待翻倍 → 标记为直接换渠道
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') e.switchChannel = true;
    e.retryable = true;
    throw e;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e = new Error(`HTTP ${res.status}:${text.slice(0, 200)}`);
    // 5xx / 429 / 超时类网关页 → 可重试；4xx（配置/密钥问题）→ 不可重试
    e.retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw e;
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    const e = new Error('LLM 返回为空');
    e.retryable = true;
    throw e;
  }
  return content;
}

/** 把底层英文/原始错误翻译成用户看得懂的中文 */
function friendly(err) {
  const m = String(err?.message || err || '');
  if (/网络失败/.test(m)) {
    const detail = m.replace('网络失败:', '').slice(0, 60);
    return new Error(`AI 服务连接不上（${detail || '网络错误'}），请稍后重试`);
  }
  if (/返回为空/.test(m)) return new Error('AI 没有返回内容，请重试一次');
  if (/超时|timeout|508|504|503|502|500|429|408/.test(m)) {
    return new Error('AI 服务暂时繁忙（等待超时），已自动重试并切换备用渠道，请稍后再试');
  }
  if (/HTTP 4\d\d/.test(m)) {
    const code = m.match(/HTTP (\d+)/)?.[1] || '';
    if (code === '401' || code === '403') return new Error('LLM API 密钥无效或没有权限，请检查 .env 里的 LLM_API_KEY');
    if (code === '429') return new Error('AI 用量超限，请稍后再试');
    return new Error(`AI 服务拒绝请求（错误码 ${code}）`);
  }
  return new Error(m);
}

/**
 * @param {Array<{role:string, content:string}>} messages
 * @param {{json?: boolean, temperature?: number}} opts
 * @returns {Promise<string>} 模型输出文本
 * 顺序：主渠道 → 失败重试 1 次 → 失败切备用渠道（DeepSeek 官方）→ 仍失败则报中文错误
 */
async function chat(messages, { json = false, temperature = 0.3 } = {}) {
  if (!isConfigured()) {
    throw new Error('未配置 LLM_API_KEY，请在项目根目录的 .env 中设置');
  }
  const channels = [];
  if (API_KEY) channels.push({ base: BASE_URL, key: API_KEY, model: MODEL, name: '主渠道' });
  if (DS_API_KEY) channels.push({ base: DS_BASE_URL, key: DS_API_KEY, model: DS_MODEL, name: '备用渠道(DeepSeek官方)' });

  let lastErr = null;
  for (const ch of channels) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await callOnce(ch, messages, { json, temperature });
      } catch (err) {
        lastErr = err;
        // 超时类：换渠道；同渠道重试只留给 429/5xx 这类"快失败"的临时错误
        if (err.switchChannel) break;
        if (attempt === 1 && err.retryable) { await sleep(1500); continue; }
        break; // 该渠道确实不行 → 换下一个渠道
      }
    }
  }
  throw friendly(lastErr);
}

/** 启动健康自检：GET /models（不耗 token），主渠道失效时在控制台明确提示 */
async function healthCheck() {
  const probe = async (name, base, key) => {
    if (!key) return `${name}：未配置`;
    try {
      const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      return `${name}：${res.ok ? 'OK ✅' : '异常(HTTP ' + res.status + ')'}`;
    } catch (err) {
      return `${name}：连不上(${String(err?.message || '').slice(0, 40)})`;
    }
  };
  const [main, backup] = await Promise.all([
    probe('主渠道(' + BASE_URL.replace(/^https?:\/\//, '') + ')', BASE_URL, API_KEY),
    DS_API_KEY ? probe('备用渠道(DeepSeek官方)', DS_BASE_URL, DS_API_KEY) : Promise.resolve('备用渠道：未配置'),
  ]);
  console.log('[LLM 自检] ' + main + ' | ' + backup);
}

/** 解析模型输出的 JSON（容忍 ```json 包裹或前后多余文字） */
function parseJson(content) {
  const text = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error('AI 返回的内容格式不对（不是 JSON），请重试一次');
  }
}

module.exports = { chat, parseJson, isConfigured, healthCheck };
