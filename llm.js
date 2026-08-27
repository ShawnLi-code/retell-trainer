// LLM 调用封装：OpenAI 兼容 chat/completions
// 链式多渠道兜底：硅基流动免费模型（默认，多个模型按顺序，哪个挂了自动切下一个）
//              → DeepSeek 官方 / 其他兼容渠道（仅当未配置硅基流动时启用，避免误扣费）

// ---------- 硅基流动（免费模型链，默认主渠道）----------
const SF_BASE = (process.env.SF_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
const SF_KEY = process.env.SF_API_KEY || '';
// 免费模型按“质量/中文能力/速度”排序；前面的 402（余额不足）或超时，自动切换下一个
// 在 .env 里可通过 SF_MODELS 增删、调顺序（逗号分隔）。当前均为实测可用的免费模型：
// DeepSeek-V4-Flash（中文最稳）、Qwen3.5-27B（次之）、Nex-N2-Pro（最快）、Qwen3.5-35B-A3B、Qwen3.5-4B（兜底）
const SF_MODELS = (process.env.SF_MODELS
  || 'deepseek-ai/DeepSeek-V4-Flash,Qwen/Qwen3.5-27B,nex-agi/Nex-N2-Pro,Qwen/Qwen3.5-35B-A3B,Qwen/Qwen3.5-4B')
  .split(',').map((m) => m.trim()).filter(Boolean);
const SF_TIMEOUT_MS = Number(process.env.SF_TIMEOUT_MS) || 60000;

// ---------- 旧配置（DeepSeek 官方 / 自定义主备渠道）：仅当没有硅基 key 时才启用 ----------
const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const DS_BASE_URL = (process.env.DS_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DS_API_KEY = process.env.DS_API_KEY || '';
const DS_MODEL = process.env.DS_MODEL || 'deepseek-chat';
// 单次调用超时（旧渠道用 LLM_TIMEOUT_MS；硅基单独用 SF_TIMEOUT_MS）
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 90000;

function buildChannels() {
  const out = [];
  if (SF_KEY) {
    for (const m of SF_MODELS) {
      out.push({ base: SF_BASE, key: SF_KEY, model: m, name: '硅基流动·' + m.split('/').pop().slice(0, 30), timeout: SF_TIMEOUT_MS });
    }
  } else {
    if (API_KEY) out.push({ base: BASE_URL, key: API_KEY, model: MODEL, name: '主渠道', timeout: TIMEOUT_MS });
    if (DS_API_KEY) out.push({ base: DS_BASE_URL, key: DS_API_KEY, model: DS_MODEL, name: '备用渠道(DeepSeek官方)', timeout: TIMEOUT_MS });
  }
  return out;
}

function isConfigured() {
  return !!SF_KEY || ((!SF_KEY) && (!!API_KEY || !!DS_API_KEY));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callOnce(opts, messages, { json, temperature }) {
  const { base, key, model } = opts;
  const body = { model, messages, temperature };
  if (json) body.response_format = { type: 'json_object' };
  // 兼容性：硅基流动的 Qwen3.5 系列默认开"思考"（正文会被 reasoning 挤空），显式关闭
  if (/^Qwen\/Qwen3\.5/.test(model)) body.thinking = { type: 'disabled' };

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeout),
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
    // 5xx / 429 / 408 → 可重试；402（余额不足/免费额度用尽）→ 重试一次仍然失败就换下一个免费模型；
    // 4xx（配置/密钥问题）→ 不可重试，直接换渠道
    e.retryable = res.status >= 500 || res.status === 429 || res.status === 408 || res.status === 402;
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
  // 402：免费模型额度用尽/需要余额——链里所有模型都可能轮到它
  if (/402/.test(m)) {
    return new Error('AI 免费模型额度用尽（硅基流动 402），可去控制台确认免费额度或稍后再试');
  }
  if (/HTTP 4\d\d/.test(m)) {
    const code = m.match(/HTTP (\d+)/)?.[1] || '';
    if (code === '401' || code === '403') return new Error('LLM API 密钥无效或没有权限，请检查 .env 里的 SF_API_KEY');
    if (code === '429') return new Error('AI 用量超限，请稍后再试');
    return new Error(`AI 服务拒绝请求（错误码 ${code}）`);
  }
  return new Error(m);
}

/**
 * @param {Array<{role:string, content:string}>} messages
 * @param {{json?: boolean, temperature?: number}} opts
 * @returns {Promise<string>} 模型输出文本
 * 顺序：硅基流动免费模型链（依次尝试）→ 老渠道（仅未配置硅基时）。每个渠道最多 2 次尝试。
 */
async function chat(messages, { json = false, temperature = 0.3 } = {}) {
  const channels = buildChannels();
  if (!channels.length) {
    throw new Error('未配置 LLM，请在项目根目录的 .env 中设置 SF_API_KEY（硅基流动）');
  }
  // 兼容性：部分模型（如 Qwen 系）要求至少一条 user 消息，纯 system 调用补一条占位
  if (!messages.some((m) => m.role === 'user')) {
    messages = [...messages, { role: 'user', content: '请根据 system 指令完成任务，直接输出结果。' }];
  }
  let lastErr = null;
  for (const ch of channels) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await callOnce(ch, messages, { json, temperature });
      } catch (err) {
        lastErr = err;
        // 超时类：换渠道；同渠道重试只留给 429/402/5xx 这类"快失败"的临时错误
        if (err.switchChannel) break;
        if (attempt === 1 && err.retryable) { await sleep(1500); continue; }
        break; // 该渠道确实不行 → 换下一个
      }
    }
  }
  throw friendly(lastErr);
}

/** 启动健康自检（不耗 token）：硅基流动为主时检查 key 与模型列表 */
async function healthCheck() {
  if (SF_KEY) {
    const probe = async () => {
      try {
        const res = await fetch(`${SF_BASE}/models`, { headers: { Authorization: `Bearer ${SF_KEY}` }, signal: AbortSignal.timeout(8000) });
        return res.ok ? 'OK ✅' : '异常(HTTP ' + res.status + ')';
      } catch (err) {
        return '连不上(' + String(err?.message || '').slice(0, 40) + ')';
      }
    };
    console.log(`[LLM 自检] 硅基流动 ${probe ? await probe() : ''}，已配置免费模型 ${SF_MODELS.length} 个（按顺序兜底）`);
    return;
  }
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
