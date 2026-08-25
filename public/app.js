// 复述训练场 · 前端逻辑（hash 路由 + 5 视图 + Web Speech 录音转写）
'use strict';

// ---------- 小工具 ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 长文渲染：按空行分段 → 每个段落一个 <p>（学刊式阅读排版）
const paras = (s) => String(s ?? '')
  .replace(/\r/g, '')
  .split(/\n{2,}/)
  .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
  .filter(Boolean);
const renderContent = (text) => paras(text).map((p) => `<p>${esc(p)}</p>`).join('');

// 内联 SVG 图标（lucide 风格描边），避免 emoji 当图标
const ICONS = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
};
const iconBtn = (icon, label) => `${icon}<span>${label}</span>`;

const api = {
  async get(path) {
    const r = await fetch(path);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || '请求失败');
    return data;
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || '请求失败');
    return data;
  },
  async del(path) {
    const r = await fetch(path, { method: 'DELETE' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || '请求失败');
    return data;
  },
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// 会话状态（练习页用）
const session = { id: null, card: null, turns: [], busy: false };
// 复述时限（秒）：到点自动停录提交；断连重连时从剩余时间接续（由 micHandle.reset 重置）
const RETELL_SECONDS = 90;

// ---------- 路由 ----------
const NAV_GROUP = { home: 'practice', practice: 'practice', speech: 'speech', cards: 'material', bookshelf: 'reading', books: 'library', words: 'words', history: 'history' };
function router() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'home').split('/');
  const hash = parts[0];
  const group = NAV_GROUP[hash] || 'practice';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.group === group));
  const app = $('#app');
  app.innerHTML = '';
  if (hash === 'cards') { cards(app, parts[1] || 'ted'); return; }
  const views = { home, practice, speech, bookshelf, books, history, words };
  (views[hash] || home)(app);
}
window.addEventListener('hashchange', router);

async function refreshBadge() {
  try {
    const s = await api.get('/api/state');
    const n = $('#streak-num');
    if (n) n.textContent = s.streak;
  } catch { /* 忽略 */ }
}

// 进入练习页仅先载入素材；会话（历史记录）延迟到「开始复述」时才创建
function startPractice(card) {
  session.id = null;
  session.card = card;
  session.turns = [];
  if (micHandle) micHandle.reset(); // 新素材：重新从 90 秒开始
  location.hash = '#/practice';
}

// 真正开始复述（录音启动或提交文本）时才建会话，确保只有练过的才进历史
async function ensureSession() {
  if (session.id) return session.id;
  if (!session.card) throw new Error('还没选素材');
  const { sessionId } = await api.post('/api/sessions', { cardId: session.card.id });
  session.id = sessionId;
  return sessionId;
}

// ---------- 首页：选择板块 → 弹窗完整素材卡 ----------
const CATS = {
  ted: { name: 'TED 演讲复述', desc: '观点/方法类演讲，完整中文文稿', icon: ICONS.sparkles },
  rmrb: { name: '人民日报素材复述', desc: '评论版：人民时评 · 今日谈 · 人民论坛', icon: ICONS.pin },
  short: { name: '每日短评复述', desc: '人民网观点短评 · 约500字 · 每日更新', icon: ICONS.refresh },
};

async function home(root) {
  refreshBadge();
  root.innerHTML = `
    <h2>开始一次复述</h2>
    <p class="dim">选板块 → 完整素材弹出来（阅读不限时）→ 复述限时 1 分 30 秒，到点自动转写提交。</p>
    <div class="how-card">
      <b>💡 怎么复述更好？</b>
      <p>复述不是背稿，而是<b>把一个故事讲给朋友听</b>——用自己的话，让人听懂。</p>
      <p class="how-len">📏 素材以 <b>≤800 字</b>为佳（≈90 秒能讲完的主干）；选卡时会优先给最短的素材。</p>
      <div class="how-steps">
        <div class="how-step"><span>1</span><div><b>结论先行</b>·开口第一句就亮核心观点<br><em>“这篇讲的是：微小的持续改变，比大挑战更容易坚持。”</em></div></div>
        <div class="how-step"><span>2</span><div><b>论点撑腰</b>·用 2-3 个素材里的要点/例子展开，讲完例子记得回到观点<br><em>“他拿自己 30 天写小说举例……所以关键在于‘小步、持续’。”</em></div></div>
        <div class="how-step"><span>3</span><div><b>收尾点睛</b>·一句呼应核心 + 自己的感受或联想<br><em>“这让我想到，背单词也可以 30 天起个量。”</em></div></div>
      </div>
      <div class="how-compare">
        <span class="no">❌ 念稿式</span>从头背到尾，卡壳就“嗯…然后…就是…”，漏了细节越慌越乱
        <br>
        <span class="yes">✅ 讲人式</span>观点→例子→观点，有停顿有节奏；90 秒内优先讲主干，细节漏了不心虚
      </div>
    </div>
    <div class="pick-grid">
      ${Object.entries(CATS).map(([key, c]) => `
        <button class="pick-card" data-cat="${key}">
          <div class="pick-icon">${c.icon}</div>
          <div><b>${esc(c.name)}</b><span class="dim">${esc(c.desc)}</span></div>
        </button>`).join('')}
    </div>
    <div id="pick-status" class="dim"></div>`;

  root.querySelectorAll('.pick-card').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cat = btn.dataset.cat;
      root.querySelectorAll('.pick-card').forEach((b) => b.classList.toggle('active', b === btn));
      const status = $('#pick-status');
      status.textContent = '正在挑素材…';
      btn.disabled = true;
      try {
        const r = await api.post('/api/practice/pick', { category: cat });
        showMaterialModal(r.card, () => startPractice(r.card));
        status.textContent = '';
      } catch (err) {
        status.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// 素材弹窗：展示完整素材，读完点"开始复述"
function showMaterialModal(card, onStart) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <b>${esc(card.title)}</b>
        <span class="dim">完整素材 · ${card.content.length} 字 · 阅读不限时</span>
        <button class="modal-close" aria-label="关闭">×</button>
      </div>
      <div class="modal-body card-content">${renderContent(card.content)}</div>
      <div class="modal-foot">
        <button class="ghost" data-swap>换一张</button>
        <button class="primary" data-start>${iconBtn(ICONS.mic, '我准备好了，开始复述')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-start]').addEventListener('click', () => { close(); onStart(); });
  overlay.querySelector('[data-swap]').addEventListener('click', async () => {
    const btn = overlay.querySelector('[data-swap]');
    btn.disabled = true;
    try {
      const cat = document.querySelector('.pick-card.active')?.dataset.cat || 'ted';
      const r = await api.post('/api/practice/pick', { category: cat });
      overlay.querySelector('.modal-head b').textContent = r.card.title;
      overlay.querySelector('.modal-head span.dim').textContent = `完整素材 · ${r.card.content.length} 字 · 阅读不限时`;
      overlay.querySelector('.modal-body').innerHTML = renderContent(r.card.content);
      overlay.querySelector('[data-start]').onclick = () => { close(); startPractice(r.card); };
    } catch (err) { toast(err.message); } finally {
      btn.disabled = false;
    }
  });
}

// ---------- 练习页 ----------
function practice(root) {
  if (!session.card) {
    root.innerHTML = `<div class="empty">还没开始练习。<a href="#/home">回首页</a>选一张素材。</div>`;
    return;
  }
  const card = session.card;
  root.innerHTML = `
    <div class="card">
      <h2>${esc(card.title)}</h2>
      <div class="card-content">${renderContent(card.content)}</div>
    </div>
    <div id="chat" class="chat"></div>
    <div id="timer" class="timer hidden">复述剩余 90 秒</div>
    <div class="input-area">
      <textarea id="transcript" rows="3" placeholder="语音转写会实时出现在这里，也可以直接打字…"></textarea>
      <div class="input-actions">
        <button id="mic-btn">${iconBtn(ICONS.mic, '开始复述（90 秒）')}</button>
        <button id="send-btn" class="primary">讲完了，提交</button>
      </div>
      <div id="interim" class="interim"></div>
    </div>`;

  // 回放已有对话（只回放听众追问，报告的"你的复述"在历史记录页查看）
  session.turns.forEach((t) => { if (t.role === 'assistant') addBubble(t.role, t.text); });

  const transcript = $('#transcript');
  const interimEl = $('#interim');
  const micBtn = $('#mic-btn');
  const sendBtn = $('#send-btn');

  micHandle = setupMic(transcript, interimEl, micBtn, sendBtn, {
    duration: 90,
    startLabel: '开始复述（90 秒）',
    continueLabel: '继续复述（剩 {s}s）',
    timerPrefix: '复述剩余',
    onStart: () => ensureSession(), // 开始录音才算一次练习 → 此时创建会话/历史
  });

  sendBtn.addEventListener('click', () => sendTurn(transcript, interimEl, sendBtn));
  transcript.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendBtn.click();
  });
}

function addBubble(role, text) {
  const chat = $('#chat');
  if (!chat) return;
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.innerHTML = role === 'assistant' ? `<span class="tag">听众</span>${esc(text)}` : esc(text);
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

async function sendTurn(transcript, interimEl, sendBtn) {
  const text = transcript.value.trim();
  if (!text || session.busy) return;
  session.busy = true;
  sendBtn.disabled = true;
  if (recording) recognition.stop(); // 提交时先停掉录音，避免继续识别
  const sendLabel = sendBtn.textContent;
  sendBtn.textContent = '🤖 AI 分析中…（约 30-60 秒，请稍候）';
  transcript.value = '';
  interimEl.textContent = '';
  try {
    await ensureSession(); // 提交才算开始：此时才创建会话/历史
    const r = await api.post(`/api/sessions/${session.id}/turn`, { text });
    if (r.type === 'reply') {
      // 报告后的听众追问答（保留对话气泡，与报告区并存）
      session.turns.push({ role: 'user', text }, { role: 'assistant', text: r.text });
      addBubble('assistant', r.text);
    } else {
      session.turns.push({ role: 'user', text });
      // 不弹"对话气泡"，直接渲染完整报告（含"你的复述"）
      const chat = $('#chat');
      if (chat) chat.innerHTML = '';
      renderReport(r.report, text);
      refreshBadge();
    }
    if (micHandle) micHandle.reset(); // 本轮结束，下一轮重新 90 秒
  } catch (err) {
    toast(err.message);
  } finally {
    session.busy = false;
    sendBtn.disabled = false;
    sendBtn.innerHTML = sendLabel;
  }
}

// 报告主体 HTML（练习页与历史记录页共用）
function reportHtml(report) {
  const audit = (report.audit || []).map(
    (h) => `<li><b>${esc(h.word)}</b> 出现 ${h.count} 次 <span class="dim">（${esc(h.type || '口语词')}）</span> → <span class="better">${esc(h.better)}</span></li>`
  ).join('');
  const words = (report.words || []).map(
    (w) => `<li><span class="orig">${esc(w.original)}</span> → <span class="better">${esc(w.better)}</span> <span class="dim">${esc(w.reason || '')}</span></li>`
  ).join('');
  const demo = report.demo;
  return `
    <p>${esc(report.summary || '练习完成。')}</p>
    ${demo ? `
      <div class="demo-block">
        <b>AI 示范表达${demo.book ? ` · 参考《${esc(demo.book)}》` : ''}</b>
        ${demo.structure ? `<div class="demo-structure">${esc(demo.structure)}</div>` : ''}
        <div class="demo-text">${esc(demo.text || '')}</div>
        ${demo.reason ? `<div class="dim demo-reason">${esc(demo.reason)}</div>` : ''}
      </div>` : ''}
    ${report.comparison && report.comparison.length ? `
      <div class="compare-block">
        <b>对比 · 你的表达 vs 示范</b>
        <ul>${report.comparison.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      </div>` : ''}
    ${audit ? `<div class="audit"><b>本次口语词／语气词</b><ul>${audit}</ul></div>` : ''}
    <b>替换建议</b>
    <ul>${words || '<li class="dim">（没有特别需要替换的用词）</li>'}</ul>
    ${report.question ? `
      <div class="ask-block">
        <b>💬 听众追问 <span class="dim">（第三板块 · 可选继续）</span></b>
        <p>${esc(report.question)}</p>
        <span class="dim">在下方输入框回复听众（她会接着追问或自然收尾），不回复就点「完成」。</span>
      </div>` : ''}`;
}

function renderReport(report, userText) {
  const div = document.createElement('div');
  div.className = 'report';
  div.innerHTML = `
    <h3>收尾报告</h3>
    ${userText ? `
      <div class="your-retell">
        <b>🗣 你的复述</b>
        <p>${esc(userText)}</p>
      </div>` : ''}
    ${reportHtml(report)}
    <div class="actions">
      <a href="#/home"><button class="primary">完成，回首页</button></a>
      <a href="#/words"><button class="ghost">看词库</button></a>
    </div>`;
  $('#chat').appendChild(div);
}

// ---------- 录音转写（Web Speech API） ----------
let recognition = null;
let recording = false;

const setMic = (btn, label, icon = ICONS.mic) => {
  btn.innerHTML = iconBtn(icon, label);
};

function setupMic(textarea, interimEl, micBtn, sendBtn, opts = {}) {
  const DUR = opts.duration || 90; // 一轮时限（秒）
  const START_LABEL = opts.startLabel || `开始（${DUR} 秒）`;
  const CONTINUE_LABEL = opts.continueLabel || '继续（剩 {s}s）';
  const TIMER_PREFIX = opts.timerPrefix || '剩余';
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    micBtn.disabled = true;
    micBtn.textContent = '浏览器不支持语音（请用 Edge）';
    return {};
  }
  if (!window.isSecureContext) {
    micBtn.disabled = true;
    micBtn.textContent = '语音需要 localhost 或 https 访问（当前地址不是）';
    return {};
  }
  const errorMsg = {
    'not-allowed': '麦克风权限被拒绝：请点地址栏左侧的锁/图标，允许麦克风后重试',
    'no-speech': '没听到声音，请靠近麦克风再试',
    'network': '语音服务连不上（建议换 Edge 浏览器，或直接打字）',
    'aborted': '录音被中断，请重试',
    'audio-capture': '没有检测到麦克风，请检查设备',
    'service-not-allowed': '语音服务不可用，建议换 Edge 浏览器或直接打字',
  };
  let confirmed = ''; // 累积所有已确认的转写文本（含手动输入，永不覆盖）
  let remain = DUR;   // 本轮剩余秒数：断连重连时保留，新轮 reset()

  // ---------- 时限：到点自动停录并提交；断连重连从剩余时间接续 ----------
  let timerId = null;
  const timerEl = () => $('#timer');
  const startTimer = () => {
    const el = timerEl();
    let r = remain > 0 ? remain : DUR; // 断连后接续剩余时间
    remaining = r;
    if (el) {
      setMic(micBtn, `录音中…（剩 ${r}s）`, ICONS.stop);
      el.classList.remove('hidden');
      el.textContent = `${TIMER_PREFIX} ${r} 秒`;
      el.classList.toggle('urgent', false);
    }
    clearInterval(timerId);
    timerId = setInterval(() => {
      r--;
      remain = r;
      remaining = r;
      if (el) {
        el.textContent = `${TIMER_PREFIX} ${r} 秒`;
        if (r <= 15) el.classList.add('urgent');
      }
      if (opts.onTick) opts.onTick(r); // 页面自定义时钟（如演讲大时钟）
      if (r <= 0) {
        clearInterval(timerId);
        timerId = null;
        if (el) el.textContent = '⏱ 时间到，正在提交…';
        if (recording) { try { recognition.stop(); } catch { /* */ } }
        // 等 onend 把最后的转写尾巴并入文本框，再自动提交
        if (sendBtn && !sendBtn.disabled) setTimeout(() => sendBtn.click(), 800);
      }
    }, 1000);
  };
  const stopTimer = () => {
    if (timerId) { clearInterval(timerId); timerId = null; }
  };
  // 按钮文案：断连后显示"继续（剩 Xs）"，未开始的轮显示初始文案
  const micLabel = () =>
    remain > 0 && remain < DUR
      ? CONTINUE_LABEL.replace('{s}', remain)
      : START_LABEL;

  micBtn.addEventListener('click', async () => {
    if (recording) { recognition.stop(); return; }
    if (opts.onStart) { try { await opts.onStart(); } catch (err) { toast(err.message); return; } }
    recognition = new SR();
    recognition.lang = 'zh-CN';
    recognition.continuous = true;
    recognition.interimResults = true;
    confirmed = textarea.value; // 保留已输入的内容，转写结果持续追加在后面

    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) confirmed += t; // 已确认的文本永久累积
        else interim += t;
      }
      textarea.value = confirmed;
      interimEl.textContent = interim;
    };
    recognition.onend = () => {
      recording = false;
      stopTimer();
      setMic(micBtn, micLabel());
      // 停下来时若还有未确认的尾巴，并入文本框，避免丢失最后一句话
      const tail = interimEl.textContent.trim();
      if (tail) {
        confirmed += tail;
        textarea.value = confirmed;
        if (opts.onText) opts.onText(confirmed);
      }
      interimEl.textContent = '';
    };
    recognition.onerror = (e) => {
      recording = false;
      stopTimer();
      setMic(micBtn, micLabel());
      toast(errorMsg[e.error] || ('语音识别出错：' + e.error));
    };
    recording = true;
    setMic(micBtn, '停止录音', ICONS.stop);
    try {
      recognition.start();
      startTimer();
    } catch (err) {
      recording = false;
      stopTimer();
      setMic(micBtn, micLabel());
      toast('语音启动失败：' + err.message + '（建议换 Edge 浏览器，或直接打字）');
    }
  });

  // 新轮开始：重置剩余时间；返回句柄供页面在换题/提交后调用
  return {
    reset() { remain = DUR; },
    fill(text) { confirmed += text; textarea.value = confirmed; if (opts.onText) opts.onText(confirmed); },
  };
}

// 当前 mic 句柄（练习页/演讲页各自挂载）
let micHandle = null;
// 当前计时剩余秒（供页面读取）
let remaining = 0;

const lenBadge = (n) =>
  n <= 800 ? '<span class="badge badge-good">短素材 ✓</span>'
  : n <= 950 ? '<span class="badge badge-warn">接近标准</span>'
  : '<span class="badge badge-long">偏长</span>';

// ---------- 素材库（TED / 人民日报 / 每日短评 三个板块） ----------
async function cards(root, sub = 'ted') {
  root.innerHTML = '<div class="loading">加载中…</div>';
  let list;
  try {
    list = await api.get('/api/cards');
  } catch (err) {
    root.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  const cat = ['short', 'rmrb'].includes(sub) ? sub : 'ted';
  const items = list.filter((c) => c.category === cat);
  const catMeta = CATS[cat];
  const tabs = [
    ['ted', 'TED 演讲'],
    ['rmrb', '人民日报'],
    ['short', '每日短评'],
  ].map(([k, name]) => `<a href="#/cards${k === 'ted' ? '' : '/' + k}" class="${cat === k ? 'active' : ''}">${name}</a>`).join('');

  root.innerHTML = `
    <div class="view-tabs">${tabs}</div>
    <h2>${esc(catMeta.name)} <span class="count">${items.length} 篇</span></h2>
    ${cat === 'ted' ? `
      <div class="gen-row">
        <input id="ted-url" placeholder="TED 演讲稿链接：https://www.ted.com/talks/… 或演讲 slug（自动导入中文文稿）">
        <button id="ted-btn" class="ghost">${iconBtn(ICONS.sparkles, '导入 TED 演讲')}</button>
      </div>` : cat === 'rmrb' ? `
      <div class="gen-row">
        <span class="dim">自动抓数字报评论版（人民时评 / 今日谈 / 人民论坛），每日 04:00 后可用</span>
        <button id="rmrb-btn" class="ghost">${iconBtn(ICONS.refresh, '抓取今日评论')}</button>
      </div>` : `
      <div class="gen-row">
        <span class="dim">自动抓人民网观点频道最近 7 天短评（人民快评 / 壹时评等，300-1400 字）</span>
        <button id="short-btn" class="ghost">${iconBtn(ICONS.refresh, '抓取每日短评')}</button>
      </div>
      <div class="gen-col short-paste">
        <span class="dim">💡 刷到好短评（南方都市报街谈 / 其他媒体快评）直接丢进来：</span>
        <input id="short-url" placeholder="短评 URL：粘贴链接，自动提取标题和正文（任意媒体页）">
        <input id="short-title" placeholder="标题（直接贴正文时填写）">
        <textarea id="short-content" placeholder="或直接粘贴短评正文（300 字以上）"></textarea>
        <button id="short-import" class="ghost">${iconBtn(ICONS.plus, '保存为短评素材')}</button>
      </div>`}
    <ul class="card-list">
      ${items.map((c) => `
        <li class="card-row">
          <div class="card-info">
            <b>${esc(c.title)}</b>
            <span class="dim">${c.content.length} 字${lenBadge(c.content.length)} · ${esc(c.source || '')}${c.used_at ? ' · 练过' : ' · 未练'}</span>
          </div>
          <button class="practice-btn" data-id="${c.id}">直接练</button>
        </li>`).join('') || `<li class="dim">「${esc(catMeta.name)}」还没有素材${cat === 'rmrb' ? '，点上面按钮抓取今日评论' : cat === 'short' ? '，点上面按钮抓取每日短评' : '，粘贴一个 TED 演讲链接导入'}</li>`}
    </ul>`;

  const btn = cat === 'ted' ? $('#ted-btn') : cat === 'rmrb' ? $('#rmrb-btn') : $('#short-btn');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        if (cat === 'ted') {
          const url = $('#ted-url').value.trim();
          if (!url) return toast('先粘贴 TED 演讲链接或 slug');
          btn.textContent = '导入中…';
          const r = await api.post('/api/cards/fetch-ted', { url });
          toast(`《${r.title}》新增 ${r.added} 张卡` + (r.skipped ? `，跳过 ${r.skipped} 张` : ''));
          $('#ted-url').value = '';
        } else {
          btn.textContent = '抓取中…';
          const r = await api.post(cat === 'rmrb' ? '/api/cards/fetch-rmrb' : '/api/cards/fetch-short', {});
          toast(`新增 ${r.added} 篇` + (r.skipped ? `，跳过 ${r.skipped} 篇` : ''));
        }
        cards(root, cat);
      } catch (err) {
        toast(err.message);
      } finally {
        btn.disabled = false;
        if (cat === 'ted') btn.innerHTML = iconBtn(ICONS.sparkles, '导入 TED 演讲');
        else btn.innerHTML = iconBtn(ICONS.refresh, cat === 'rmrb' ? '抓取今日评论' : '抓取每日短评');
      }
    });
  }

  // 短评：粘贴导入
  if (cat === 'short') {
    const imp = $('#short-import');
    if (imp) imp.addEventListener('click', async () => {
      const url = $('#short-url').value.trim();
      const title = $('#short-title').value.trim();
      const content = $('#short-content').value.trim();
      if (!url && !content) return toast('粘贴一个短评 URL 或正文');
      imp.disabled = true;
      try {
        const r = await api.post('/api/cards/import-short', { url, title, content });
        toast(`《${r.title}》已保存（${r.len} 字）`);
        $('#short-url').value = ''; $('#short-title').value = ''; $('#short-content').value = '';
        cards(root, cat);
      } catch (err) {
        toast(err.message);
      } finally {
        imp.disabled = false;
      }
    });
  }

  document.querySelectorAll('.practice-btn').forEach((pb) => {
    pb.addEventListener('click', () => {
      const card = items.find((c) => c.id === Number(pb.dataset.id));
      // 和首页抽卡一样：先弹完整素材卡，读了点「我准备好了」才开始
      if (card) showMaterialModal(card, () => startPractice(card));
    });
  });
}

// ---------- 一分钟演讲挑战 ----------
// 状态：idle（抽题）→ learning（10 分钟自学，deadline 持久化）→ ready（到点）→ speaking（60 秒演讲）→ done（点评）
const SPEECH_KEY = 'speech-challenge';
let SPEECH_TOPICS = { concepts: [], hot: [] };
let spClock = null;
let chimeCtx = null;

// 抽题提示音：Web Audio 合成"叮铃铃"（转盘/老虎机抽中效果）
function playChime() {
  try {
    chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (chimeCtx.state === 'suspended') chimeCtx.resume();
    const now = chimeCtx.currentTime;
    const notes = [880, 1108.7, 1318.5, 1760]; // A5 → C#6 → E6 → A6 上行琶音
    notes.forEach((freq, i) => {
      const t = now + i * 0.085;
      [1, 2.76, 5.4].forEach((mult, k) => { // 基频 + 泛音 → 铃音感
        const osc = chimeCtx.createOscillator();
        const gain = chimeCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq * mult;
        const peak = 0.14 / (k + 1);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(peak, t + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.75 - k * 0.1);
        osc.connect(gain).connect(chimeCtx.destination);
        osc.start(t);
        osc.stop(t + 0.85);
      });
    });
  } catch { /* 无音频环境忽略 */ }
}

// 轮播"哒"声：每个跳动 tick 的短促敲击音（转盘节奏）
function playTick() {  try {
    chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (chimeCtx.state === 'suspended') chimeCtx.resume();
    const t = chimeCtx.currentTime;
    const osc = chimeCtx.createOscillator();
    const gain = chimeCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1500 + Math.random() * 500, t);
    gain.gain.setValueAtTime(0.1, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
    osc.connect(gain).connect(chimeCtx.destination);
    osc.start(t);
    osc.stop(t + 0.07);
  } catch { /* 忽略 */ }
}

// 书架滑动"唰"声：手动翻一格时的轻快滑动音
function playSwipe() {
  try {
    chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (chimeCtx.state === 'suspended') chimeCtx.resume();
    const t = chimeCtx.currentTime;
    const osc = chimeCtx.createOscillator();
    const gain = chimeCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(950, t);
    osc.frequency.exponentialRampToValueAtTime(420, t + 0.16);
    gain.gain.setValueAtTime(0.07, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(chimeCtx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  } catch { /* 忽略 */ }
}

// 语音支持探针：演讲开始前检测（浏览器有无 API + 能否真正启动）
function probeSpeech(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return resolve({ ok: false, reason: 'api' });
    let done = false;
    let r = null;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      try { if (r) r.stop(); } catch { /* */ }
      resolve({ ok, reason });
    };
    try {
      r = new SR();
      r.lang = 'zh-CN';
      r.continuous = false;
      r.interimResults = false;
      r.onstart = () => finish(true);
      r.onerror = (e) => finish(false, e.error || 'unknown');
      r.onend = () => finish(false, 'no-start');
      r.start();
      setTimeout(() => finish(false, 'timeout'), timeoutMs);
    } catch {
      finish(false, 'exception');
    }
  });
}

// 语音不可用的原因文案
function speechFailText(reason) {
  switch (reason) {
    case 'api': return '当前浏览器没有语音识别功能';
    case 'not-allowed': return '麦克风权限被拒绝（点地址栏左侧锁图标 → 允许麦克风）';
    case 'network': return '语音服务连不上（Chrome 语音走 Google，国内基本不可用）';
    case 'service-not-allowed': return '浏览器语音服务不可用';
    default: return '语音服务启动失败';
  }
}

// ⏰ 学习结束提醒音：四声上行大铃（铛-铛-铛-铛———）
function playBell() {
  try {
    chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (chimeCtx.state === 'suspended') chimeCtx.resume();
    const now = chimeCtx.currentTime;
    const notes = [[659.25, 0], [783.99, 0.4], [1046.5, 0.8], [1318.5, 1.3]]; // E5 G5 C6 E6
    notes.forEach(([freq, off]) => {
      const t = now + off;
      [1, 2.0, 4.0].forEach((mult, k) => {
        const osc = chimeCtx.createOscillator();
        const gain = chimeCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq * mult;
        const peak = 0.18 / (k + 1);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(peak, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + (off === 1.3 ? 1.8 : 1.0) - k * 0.12);
        osc.connect(gain).connect(chimeCtx.destination);
        osc.start(t);
        osc.stop(t + 2);
      });
    });
  } catch { /* 忽略 */ }
}

// 学习结束：音效 + 桌面通知 + 页面标题闪烁
function notifyTimeUp(topic) {
  playBell();
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('⏰ 10 分钟自学结束', { body: `准备 1 分钟演讲：《${topic}》`, tag: 'speech-timeup' });
    }
  } catch { /* 忽略 */ }
  const orig = document.title;
  document.title = '⏰ 时间到！准备演讲！';
  setTimeout(() => { document.title = orig; }, 5000);
}

// 老虎机式抽题：话题名快速跳转轮换 → 逐渐减速 → 定格目标词 + 叮铃铃
function spinTopic(root, sp, pool, target, kind) {
  const nameEl = $('#speech-topic-name');
  const kindEl = $('#speech-kind');
  const btn = $('#speech-redraw');
  const startBtn = $('#speech-start');
  if (btn) btn.disabled = true;
  if (startBtn) startBtn.disabled = true;
  const total = 20 + ((Math.random() * 7) | 0); // 20-26 个跳动
  let i = 0, interval = 55;
  const pick = () => pool[(Math.random() * pool.length) | 0];
  const tick = () => {
    if (i >= total) {
      // 🎰 定格
      sp.topic = target;
      sp.kind = kind;
      sp.phase = 'idle';
      saveSpeech(sp);
      if (nameEl) { nameEl.classList.remove('spin-pop'); nameEl.classList.add('spin-land'); }
      playChime(); // 叮铃铃~
      renderSpeech(root, sp);
      return;
    }
    if (i >= total - 3) {
      nameEl.textContent = target; // 尾声：目标词逐渐"慢速停靠"
    } else {
      nameEl.textContent = pick();
    }
    if (kindEl) kindEl.textContent = Math.random() < 0.4 ? '🔥 热点话题' : '📖 概念定义';
    nameEl.classList.remove('spin-pop');
    void nameEl.offsetWidth; // 重新触发动画
    nameEl.classList.add('spin-pop');
    playTick(); // 哒！
    i++;
    interval = Math.min(interval * 1.16, 320); // 指数减速
    setTimeout(tick, interval);
  };
  tick();
}

// 在演讲原文中高亮"用词替换"建议的词（划线 + 标注替换词 + hover 显示理由）
function highlightWords(text, words) {
  const list = (words || []).filter((w) => w && w.original && w.better).sort((a, b) => b.original.length - a.original.length);
  if (!list.length) return esc(text);
  const escRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let html = esc(text);
  const tokens = []; // {orig, better, reason}
  for (const w of list) {
    const re = new RegExp(escRegex(esc(w.original)), 'g');
    html = html.replace(re, () => {
      const i = tokens.length;
      tokens.push({ orig: esc(w.original), better: esc(w.better), reason: esc(w.reason || '') });
      return `\u0000${i}\u0000`;
    });
  }
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const t = tokens[Number(i)];
    return `<mark class="w-hit" title="建议：${t.better} — ${t.reason}">${t.orig}<span class="w-better">→ ${t.better}</span></mark>`;
  });
}

function speech(root) {
  let sp = null;
  try { sp = JSON.parse(sessionStorage.getItem(SPEECH_KEY)); } catch { sp = null; }
  if (!sp || !sp.topic) {
    sp = { topic: '', kind: 'concept', phase: 'idle', deadline: 0, feedback: null, spoken: '' };
    saveSpeech(sp);
  } else if (sp.phase === 'speaking') {
    // 演讲中刷新/重新进入页面 → 回到 ready，重新检测语音再开始
    sp.phase = 'ready';
    saveSpeech(sp);
  }
  renderSpeech(root, sp);
}

function saveSpeech(sp) {
  try { sessionStorage.setItem(SPEECH_KEY, JSON.stringify(sp)); } catch { /* 忽略 */ }
}

async function renderSpeech(root, sp) {
  // 阶段有效期：learning 且 deadline 过了 → 自动跳到 ready
  if (sp.phase === 'learning' && Date.now() >= sp.deadline) { sp.phase = 'ready'; saveSpeech(sp); }
  const t = sp.topic;
  let stage = '';
  if (sp.phase === 'idle') {
    stage = `
      <div class="speech-topic-card">
        <div class="topic-kind" id="speech-kind">${sp.kind === 'hot' ? '🔥 热点话题' : '📖 概念定义'}</div>
        <div class="topic-name${t ? '' : ' dim'}" id="speech-topic-name">${t ? esc(t) : '点下面按钮抽一个题'}</div>
        <div class="speech-actions">
          <button id="speech-redraw" class="ghost">${iconBtn(ICONS.refresh, t ? '换一个' : '随机抽一个')}</button>
          ${t ? `<button id="speech-start" class="primary">开始 10 分钟自学 →</button>` : ''}
        </div>
      </div>
      <div class="speech-steps">
        <div class="speech-step"><b>1️⃣ 抽题</b><span>随机抽一个概念/词，或网络热点</span></div>
        <div class="speech-step"><b>2️⃣ 自学 10 分钟</b><span>随便查：概念、来龙去脉、例子</span></div>
        <div class="speech-step"><b>3️⃣ 1 分钟讲清</b><span>脱稿总结，讲完 AI 教练点评</span></div>
      </div>`;
  } else if (sp.phase === 'learning') {
    const left = Math.max(0, sp.deadline - Date.now());
    stage = `
      <div class="speech-topic-card">
        <div class="topic-kind">${sp.kind === 'hot' ? '🔥 热点话题' : '📖 概念定义'}</div>
        <div class="topic-name">${esc(t)}</div>
        <div class="speech-clock" id="speech-clock">${fmtMMSS(left)}</div>
        <div class="dim">⏳ 自学时间：搜资料、想例子、列提纲。时间到自动进入演讲环节（页面刷新也会继续计时）</div>
        <div class="speech-actions">
          <button id="speech-abort" class="ghost">放弃这张题</button>
        </div>
      </div>`;
  } else if (sp.phase === 'ready') {
    stage = `
      <div class="speech-topic-card">
        <div class="topic-kind">${sp.kind === 'hot' ? '🔥 热点话题' : '📖 概念定义'}</div>
        <div class="topic-name">${esc(t)}</div>
        <div class="speech-ready">⏰ 10 分钟到了！深呼吸，用整整 1 分钟把这个词讲清楚——脱稿，讲给"完全没听说过"的人听。</div>
        <div class="speech-actions">
          <button id="speech-go" class="primary">开始 1 分钟演讲</button>
        </div>
      </div>`;
  } else if (sp.phase === 'speaking') {
    if (sp.speechOk) {
      stage = `
      <div class="speech-topic-card">
        <div class="topic-kind">${sp.kind === 'hot' ? '🔥 热点话题' : '📖 概念定义'}</div>
        <div class="topic-name">${esc(t)}</div>
        <div class="speech-bigclock" id="speech-bigclock">01:00</div>
        <div class="input-area">
          <textarea id="speech-text" rows="4" placeholder="说出来的话会实时转写到这里，也可以直接打字…"></textarea>
          <div class="input-actions">
            <button id="speech-mic" class="primary">${iconBtn(ICONS.mic, '开始演讲（60 秒）')}</button>
            <button id="speech-done" class="ghost">讲完了，提交点评</button>
          </div>
          <div id="interim" class="interim"></div>
        </div>
        <div id="timer" class="timer hidden">演讲剩余 60 秒</div>
      </div>`;
    } else {
      // 语音不可用：提示用外部语音转写软件，但 60 秒倒计时照常开始
      stage = `
      <div class="speech-topic-card">
        <div class="topic-kind">${sp.kind === 'hot' ? '🔥 热点话题' : '📖 概念定义'}</div>
        <div class="topic-name">${esc(t)}</div>
        <div class="speech-bigclock" id="speech-bigclock">01:00</div>
        <div class="speech-nospeech">⚠️ 语音检测未通过：<b>${speechFailText(sp.speechReason)}</b>
          <div class="speech-nospeech-sub">
            · 倒计时照常进行：用手机/电脑自带的<b>语音输入软件</b>对着讲 60 秒<br>
            · 讲完后把转写文字<b>粘贴到下面</b> → 点「提交点评」，效果一样<br>
            · 或者换 <b>Edge 浏览器</b> 打开本站（语音转写完全可用）
          </div>
        </div>
        <div class="input-area">
          <textarea id="speech-text" rows="5" placeholder="讲完后，把你用语音软件转写好的内容粘贴到这里…"></textarea>
          <div class="input-actions">
            <button id="speech-retry" class="ghost">重新检测语音</button>
            <button id="speech-done" class="primary">粘贴好了，提交点评</button>
          </div>
        </div>
      </div>`;
    }
  } else { // done
    const fb = sp.feedback || {};
    const stars = '★'.repeat(Math.max(1, Number(fb.score) || 3)) + '☆'.repeat(5 - Math.max(1, Number(fb.score) || 3));
    stage = `
      <div class="speech-topic-card">
        <div class="topic-kind">本次点评 · ${stars}</div>
        <div class="topic-name">${esc(t)}</div>
        <p class="speech-verdict">${esc(fb.verdict || '讲得不错！')}</p>
        ${fb.strong?.length ? `<div class="speech-fb"><b>👍 讲得好的</b><ul>${fb.strong.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
        ${fb.fixes?.length ? `<div class="speech-fb"><b>🔧 下一次这样更好</b><ul>${fb.fixes.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
        ${fb.structure ? `<div class="speech-fb"><b>🏗 结构</b><p>${esc(fb.structure)}</p></div>` : ''}
        ${fb.model ? `<div class="speech-compare">
          <div class="speech-cmp-col speech-cmp-mine">
            <b>🗣 你的演讲<span class="dim">（划线处=建议替换的用词）</span></b>
            <p>${highlightWords(sp.spoken || '（未记录到转写文本）', fb.words)}</p>
          </div>
          <div class="speech-cmp-col speech-cmp-demo">
            <b>🎤 AI 示范演讲 <span class="dim">（${esc((fb.model && fb.model.book) || '书库方法')}）</span></b>
            <p>${esc(((fb.model && fb.model.text) || fb.model) || '')}</p>
          </div>
        </div>` : ''}
        ${fb.words?.length ? `<div class="audit"><b>用词替换</b><ul>${fb.words.map((w) => `<li>「${esc(w.original)}」→ <b>${esc(w.better)}</b><span class="dim">${esc(w.reason || '')}</span></li>`).join('')}</ul></div>` : ''}
        <div class="speech-actions">
          ${sp.fromHistory && sp.logAt ? `<span class="dim" style="font-size:12px;align-self:center">📅 ${esc(String(sp.logAt).slice(0, 16))} 的点评记录</span>` : ''}
          ${fb.model && (fb.model.text || typeof fb.model === 'string') ? `<button id="speech-demo-retell" class="ghost">🎯 用 AI 示范练复述</button>` : ''}
          <button id="speech-again" class="primary">再抽一题 →</button>
        </div>
      </div>`;
  }

  root.innerHTML = `
    <h2>一分钟演讲挑战 <span class="count">抽词 · 10 分钟自学 · 1 分钟讲清</span></h2>
    ${stage}
    <div id="speech-history" style="margin-top:22px"></div>`;
  loadSpeechHistory($('#speech-history'), sp, root);

  // 绑定
  const bind = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('click', fn); };
  if (sp.phase === 'idle') {
    bind('#speech-redraw', async () => {
      if (!SPEECH_TOPICS.concepts.length) {
        try { const r = await api.get('/api/speech/topics'); SPEECH_TOPICS = r; } catch (err) { return toast(err.message); }
      }
      const isHot = Math.random() < 0.4 && SPEECH_TOPICS.hot.length;
      const pool = isHot ? SPEECH_TOPICS.hot : SPEECH_TOPICS.concepts;
      if (!pool.length) return toast('话题池为空');
      const target = pool[(Math.random() * pool.length) | 0];
      spinTopic(root, sp, pool, target, isHot ? 'hot' : 'concept'); // 🎰 轮播 → 定格
    });
    bind('#speech-start', () => {
      // 申请桌面通知权限（10 分钟到点时会弹提醒）
      if ('Notification' in window && Notification.permission === 'default') {
        try { Notification.requestPermission(); } catch { /* 忽略 */ }
      }
      sp.phase = 'learning';
      sp.deadline = Date.now() + 10 * 60 * 1000;
      sp.feedback = null; sp.spoken = '';
      saveSpeech(sp);
      renderSpeech(root, sp);
      startClock(root, sp);
    });
  }
  if (sp.phase === 'learning') {
    bind('#speech-abort', () => {
      sp = { topic: '', kind: 'concept', phase: 'idle', deadline: 0, feedback: null, spoken: '' };
      saveSpeech(sp);
      renderSpeech(root, sp);
    });
    startClock(root, sp);
  }
  if (sp.phase === 'ready') {
    bind('#speech-go', async () => {
      const goBtn = $('#speech-go');
      if (goBtn) { goBtn.disabled = true; goBtn.textContent = '检测语音支持中…'; }
      // ✅ 关键：先做语音支持检测，通过才开启 1 分钟倒计时
      const probe = await probeSpeech();
      sp.speechOk = probe.ok;
      sp.speechReason = probe.reason;
      sp.phase = 'speaking';
      saveSpeech(sp);
      renderSpeech(root, sp);
      const textarea = $('#speech-text');
      const doneBtn = $('#speech-done');
      const micBtn = $('#speech-mic');
      if (probe.ok) {
        micHandle = setupMic(textarea, $('#interim'), micBtn, doneBtn, {
          duration: 60,
          startLabel: '开始演讲（60 秒）',
          continueLabel: '继续演讲（剩 {s}s）',
          timerPrefix: '演讲剩余',
          onTick: (r) => {
            const el = $('#speech-bigclock');
            if (el) { el.textContent = fmtMMSS(r * 1000); el.classList.toggle('urgent', r <= 10); }
          },
          onText: (txt) => { sp.spoken = txt; },
        });
      }
      doneBtn.addEventListener('click', () => submitSpeech(root, sp, textarea));
    });
    // 语音不通的粘贴模式：60 秒大时钟照常跑，到点提醒粘贴提交
    if (!sp.speechOk) {
      startPasteClock(root, sp);
      bind('#speech-retry', () => {
        sp.phase = 'ready';
        saveSpeech(sp);
        renderSpeech(root, sp);
      });
    }
  }
  if (sp.phase === 'done') {
    bind('#speech-again', () => {
      sp = { topic: '', kind: 'concept', phase: 'idle', deadline: 0, feedback: null, spoken: '' };
      saveSpeech(sp);
      renderSpeech(root, sp);
    });
    // 用 AI 示范演讲当作复述素材，直接练一轮复述
    bind('#speech-demo-retell', async () => {
      const demoText = (sp.feedback?.model?.text || sp.feedback?.model || '');
      if (!demoText) return toast('这份记录没有示范演讲文本');
      const btn = $('#speech-demo-retell');
      btn.disabled = true;
      try {
        const r = await api.post('/api/cards', { title: `示范演讲：${sp.topic}`, content: demoText, source: `演讲挑战 AI 示范（${sp.feedback?.model?.book || ''}）` });
        const card = { id: r.id, title: `示范演讲：${sp.topic}`, content: demoText, source: '演讲AI示范' };
        startPractice(card);
      } catch (err) { toast(err.message); btn.disabled = false; }
    });
  }
  loadSpeechHistory($('#speech-history'), sp, root);
}

function fmtMMSS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// 粘贴模式：60 秒大时钟（语音不通时也用）
let pasteTimer = null;
function startPasteClock(root, sp) {
  if (pasteTimer) { clearInterval(pasteTimer); pasteTimer = null; }
  let left = 60000;
  const el = $('#speech-bigclock');
  if (el) { el.textContent = fmtMMSS(left); el.classList.remove('urgent'); }
  pasteTimer = setInterval(() => {
    if (sp.phase !== 'speaking' || sp.speechOk) { clearInterval(pasteTimer); pasteTimer = null; return; }
    left -= 1000;
    if (el) {
      el.textContent = fmtMMSS(Math.max(0, left));
      el.classList.toggle('urgent', left <= 10000);
    }
    if (left <= 0) {
      clearInterval(pasteTimer); pasteTimer = null;
      playChime();
      if (el) el.textContent = '00:00';
      toast('⏱ 60 秒到！把转写好的内容粘贴进文本框，点「提交点评」');
    }
  }, 1000);
}

// 学习阶段时钟（每 500ms 刷新；到点切 ready）
function startClock(root, sp) {  if (spClock) { clearInterval(spClock); spClock = null; }
  spClock = setInterval(() => {
    if (sp.phase !== 'learning') { clearInterval(spClock); spClock = null; return; }
    const el = $('#speech-clock');
    if (el) el.textContent = fmtMMSS(sp.deadline - Date.now());
    if (Date.now() >= sp.deadline) {
      clearInterval(spClock); spClock = null;
      sp.phase = 'ready'; saveSpeech(sp);
      notifyTimeUp(sp.topic); // ⏰ 铃音 + 桌面通知 + 标题闪烁
      renderSpeech(root, sp);
    }
  }, 500);
}

async function submitSpeech(root, sp, textarea) {
  const text = textarea.value.trim();
  if (!text) return toast('还没说/写内容，先讲一段再提交');
  if (sp.busy) return;
  sp.busy = true;
  const btn = $('#speech-done');
  if (btn) { btn.disabled = true; btn.textContent = '点评中…'; }
  try {
    const r = await api.post('/api/speech/log', { topic: sp.topic, kind: sp.kind, text });
    sp.feedback = r.feedback;
    sp.spoken = text;
    sp.phase = 'done';
    saveSpeech(sp);
    renderSpeech(root, sp);
  } catch (err) {
    toast(err.message);
    if (btn) { btn.disabled = false; btn.textContent = '讲完了，提交点评'; }
  } finally {
    sp.busy = false;
  }
}

async function loadSpeechHistory(elRoot, sp, root) {
  if (!elRoot || !sp || !root) return;
  try {
    const { logs } = await api.get('/api/speech/logs');
    if (!logs.length) { elRoot.innerHTML = ''; return; }
    elRoot.innerHTML = `
      <h3>挑战记录 <span class="count">${logs.length} · 点击查看完整点评</span></h3>
      <ul class="card-list">
        ${logs.map((l) => `
          <li class="card-row" data-log="${l.id}" style="cursor:pointer">
            <div class="card-info">
              <b>${esc(l.topic)}</b>
              <span class="dim">${String(l.created_at).slice(0, 16)} · ${l.score ? '★'.repeat(l.score) + '☆'.repeat(5 - l.score) : ''} · ${esc(l.feedback?.verdict || '')}</span>
            </div>
          </li>`).join('')}
      </ul>`;
    elRoot.querySelectorAll('[data-log]').forEach((li) => {
      li.addEventListener('click', () => {
        const l = logs.find((x) => x.id === Number(li.dataset.log));
        if (!l) return;
        sp.topic = l.topic;
        sp.kind = l.kind || 'concept';
        sp.phase = 'done';
        sp.feedback = l.feedback;
        sp.spoken = l.spoken || '';
        sp.logAt = l.created_at;
        sp.fromHistory = true;
        saveSpeech(sp);
        renderSpeech(root, sp);
      });
    });
  } catch { /* 忽略 */ }
}

// ---------- 书库（蒸馏的方法论书单） ----------
async function books(root) {
  root.innerHTML = '<div class="loading">加载中…</div>';
  let data;
  try {
    data = await api.get('/api/books');
  } catch (err) {
    root.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  const list = data.books || [];
  if (!list.length) {
    root.innerHTML = `<div class="empty">书库还是空的。</div>`;
    return;
  }
  const total = list.reduce((n, b) => n + (b.skills || []).length, 0);
  root.innerHTML = `
    <h2>表达方法书库 <span class="count">${list.length} 本 · ${total} 个技能</span></h2>
    <p class="dim">AI 示范表达就从这里选一本书的方法来组织——点开书看技能细则，也可对照报告里 AI 用了哪一本。</p>
    <div class="books-wrap">
      ${list.map((b, bi) => `
        <details class="book-card"${bi === 0 ? ' open' : ''}>
          <summary>
            <span class="book-name">《${esc(b.book)}》</span>
            <span class="dim book-meta">${esc(b.author || '')} · ${(b.skills || []).length} 个技能${b.dimensions ? ' · ' + esc(b.dimensions.join(' / ')) : ''}</span>
          </summary>
          <div class="book-body">
            <p class="book-essence">${esc(b.essence || '')}</p>
            ${b.scenes?.length ? `<div class="book-scenes"><b>适合场景</b><ul>${b.scenes.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
            <div class="skill-list">
              ${(b.skills || []).map((s, si) => `
                <details class="skill-item"${bi === 0 && si === 0 ? ' open' : ''}>
                  <summary><b>${esc(s.name)}</b><span class="dim skill-when">${esc(s.when || '')}</span></summary>
                  <div class="skill-body">
                    <p class="skill-model">${esc(s.model || '')}</p>
                    ${s.steps?.length ? `
                      <div class="skill-part"><b>怎么做</b><ol>${s.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>` : ''}
                    ${s.principles?.length ? `
                      <div class="skill-part"><b>要点</b><ul>${s.principles.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
                    ${s.example ? `<div class="skill-part"><b>例子</b><p class="skill-example">${esc(s.example)}</p></div>` : ''}
                    ${s.boundary ? `<div class="skill-part"><b>边界</b><p class="skill-boundary">${esc(s.boundary)}</p></div>` : ''}
                    ${s.checklist?.length ? `
                      <div class="skill-part"><b>自检清单</b><ul class="skill-check">${s.checklist.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
                  </div>
                </details>`).join('')}
            </div>
          </div>
        </details>`).join('')}
    </div>`;
}

// ---------- 历史 ----------
async function history(root) {
  root.innerHTML = '<div class="loading">加载中…</div>';
  let list;
  try {
    list = await api.get('/api/history');
  } catch (err) {
    root.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  if (!list.length) {
    root.innerHTML = `<div class="empty">还没有练习记录。<a href="#/home">去练第一次</a></div>`;
    return;
  }
  root.innerHTML = `<h2>练习历史 <span class="count">${list.length} 次 · 点击查看完整报告</span></h2>`;
  const wrap = document.createElement('div');
  list.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    const usrTurns = s.turns.filter((t) => t.role === 'user');
    item.innerHTML = `
      <div><b>${esc(s.cardTitle)}</b></div>
      <div class="meta">${esc(s.date)} · 复述 ${s.turnsCount} 轮 · ${esc(s.summary || '')}</div>
      <div class="history-detail" hidden>
        ${s.report && s.report.summary ? `
          <div class="report replay">
            ${usrTurns.length ? `
              <div class="your-retell"><b>🗣 你的复述</b><p>${esc(usrTurns[usrTurns.length - 1].text)}</p></div>` : ''}
            ${reportHtml(s.report)}
          </div>` : '<div class="dim">（该次练习没有完整报告）</div>'}
        <div class="actions">
          <button class="primary" data-replay>🔁 再次复述本篇</button>
        </div>
      </div>`;
    item.addEventListener('click', (e) => {
      if (e.target.closest('[data-replay]')) return;
      const d = item.querySelector('.history-detail');
      d.hidden = !d.hidden;
    });
    item.querySelector('[data-replay]').addEventListener('click', async () => {
      item.querySelector('[data-replay]').disabled = true;
      try {
        const all = await api.get('/api/cards');
        const card = all.find((c) => c.id === s.cardId);
        if (!card) return toast('素材已被删除，无法复述');
        startPractice(card);
      } catch (err) { toast(err.message); item.querySelector('[data-replay]').disabled = false; }
    });
    wrap.appendChild(item);
  });
  root.appendChild(wrap);
}

// ---------- 读书（本地书架） ----------
const escRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 分段渲染：识别 # 标题级、> 引用、• 列表、图片（epub/pdf 结构保留）
const parasHtml = (s) => String(s).split(/\n{2,}/).map((p) => {
  const t = p.replace(/\s*\n\s*/g, ' ').trim();
  if (!t) return '';
  if (t.startsWith('<figure')) return t;
  const hm = t.match(/^(#{1,4})\s+(.+)$/);
  if (hm) return `<div class="read-h${hm[1].length}">${hm[2]}</div>`;
  if (t.startsWith('>')) return `<div class="read-quote">${t.replace(/^>\s*/, '')}</div>`;
  if (/^([•·]\s*)/.test(t)) return `<p class="li">${t.replace(/^([•·]\s*)/, '')}</p>`;
  if (/^［图/.test(t)) return `<p class="read-img">${t}</p>`;
  return `<p>${t}</p>`;
}).filter(Boolean).join('');

let READ_STATE = null; // { book, chapters, marks, chapter }
let selBound = false;

async function bookshelf(root) {
  root.innerHTML = '<div class="loading">扫描书架…</div>';
  let data;
  try { data = await api.get('/api/bookshelf'); } catch (err) { root.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  const BOOKS = data.books || [];
  if (!BOOKS.length) {
    root.innerHTML = `<div class="empty">书架是空的。把书（epub / pdf / docx / txt / md）放进 <b>${esc(data.dir)}</b> 目录，回来刷新。<br><span class="dim">子目录 = 一本书（目录名即书名）；epub/pdf 也可以直接放在目录根下。</span></div>`;
    return;
  }
  const half = Math.ceil(BOOKS.length / 2);
  const row = (items) => `
    <div class="shelf-viewport"><div class="shelf-track">
      ${items.map(bookCard).join('')}${items.map(bookCard).join('')}
    </div></div>`;
  root.innerHTML = `
    <div class="page-wide">
      <div class="shelf-head">
        <h2>我的书架 <span class="count">${BOOKS.length} 本</span></h2>
        <span class="dim shelf-dir" title="${esc(data.dir)}">${esc(data.dir)}</span>
      </div>
      <div class="shelf">
        <button class="shelf-lr-btn" id="shelf-prev" title="后退一格" aria-label="后退">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <button class="shelf-lr-btn" id="shelf-next" title="前进一格" aria-label="前进">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        ${row(BOOKS.slice(0, half))}
        ${row(BOOKS.slice(half))}
      </div>
      <p class="dim shelf-tip">点击 ←/→ 滑动翻书 · 点击封面开始阅读 —— 目录选章 · 划线上色 · 每章读完立即复述感受</p>
    </div>`;
  // 滑动引擎：requestAnimationFrame 逐帧驱动（60fps 丝滑匀速），手动按钮做 easeOutCubic 补间 + 唰声
  const viewports = [...root.querySelectorAll('.shelf-viewport')];
  const tracks = viewports.map((vp) => vp.querySelector('.shelf-track'));
  const wrapX = (tr, x) => { const w = Math.max(1, Math.round(tr.scrollWidth / 2)); let v = x % w; if (v < 0) v += w; return v; };
  const apply = () => { for (const tr of tracks) tr.style.transform = `translateX(${-Number(tr.dataset.x || 0)}px)`; };
  let paused = false, rafId = null, lastT = 0, tween = null;
  const SPEED = 22; // px/s ≈ 75 秒一圈的慢速挪动
  const frame = (t) => {
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(50, t - (lastT || t));
    lastT = t;
    if (tween) {
      const p = Math.min(1, (t - tween.t0) / tween.dur);
      const e = 1 - Math.pow(1 - p, 3);
      tracks.forEach((tr, i) => { tr.dataset.x = wrapX(tr, tween.from[i] + tween.dir * tween.step * e); });
      apply();
      if (p >= 1) tween = null;
      return;
    }
    if (paused) return;
    for (const tr of tracks) tr.dataset.x = wrapX(tr, Number(tr.dataset.x || 0) + (SPEED * dt) / 1000);
    apply();
  };
  const startLoop = () => { if (rafId == null) { lastT = 0; rafId = requestAnimationFrame(frame); } };
  const stopLoop = () => { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } };
  const slide = (dir) => {
    playSwipe();
    tween = { t0: performance.now(), dur: 420, dir, step: 148, from: tracks.map((tr) => Number(tr.dataset.x || 0)) };
  };
  $('#shelf-prev').addEventListener('click', () => slide(-1));
  $('#shelf-next').addEventListener('click', () => slide(1));
  const shelfEl = root.querySelector('.shelf');
  shelfEl.addEventListener('mouseenter', () => { paused = true; });
  shelfEl.addEventListener('mouseleave', () => { paused = false; });
  window.addEventListener('hashchange', stopLoop);
  startLoop();
  root.querySelectorAll('.book-card').forEach((card) => card.addEventListener('click', () => { stopLoop(); openBook(card.dataset.id); }));
}

function bookCard(b) {
  const hue = [...b.title].reduce((s, c) => s + c.codePointAt(0), 0) % 360;
  return `
    <div class="book-card" data-id="${b.id}" title="${esc(b.title)}">
      <div class="book-cover-stack">
        <div class="book-cover text-cover" style="background:linear-gradient(160deg,hsl(${hue},45%,42%),hsl(${(hue + 40) % 360},55%,28%))">
          <span class="tc-title">${esc(b.title.slice(0, 10))}</span>
          <span class="tc-fmt">${esc(b.format.toUpperCase())}</span>
        </div>
        <img class="book-cover img-cover" src="/api/bookshelf/${b.id}/cover" loading="lazy" alt="" onerror="this.remove()">
      </div>
      <div class="book-meta">
        <b>${esc(b.title.length > 12 ? b.title.slice(0, 12) + '…' : b.title)}</b>
        <span class="dim">${esc(b.format.toUpperCase())}${b.chapterCount ? ` · ${b.chapterCount} 章` : ''}</span>
      </div>
    </div>`;
}

function coverFallback(img, title, fmt) {
  const hue = [...title].reduce((s, c) => s + c.codePointAt(0), 0) % 360;
  const d = document.createElement('div');
  d.className = 'book-cover text-cover';
  d.style.background = `linear-gradient(160deg,hsl(${hue},45%,42%),hsl(${(hue + 40) % 360},55%,28%))`;
  d.innerHTML = `<span class="tc-title">${esc(title.slice(0, 10))}</span><span class="tc-fmt">${esc(String(fmt).toUpperCase())}</span>`;
  img.replaceWith(d);
}

async function openBook(id, chapterIdx) {
  const root = $('#app');
  root.innerHTML = '<div class="loading">翻开书页…</div>';
  let data;
  try { data = await api.get(`/api/bookshelf/${id}`); } catch (err) {
    root.innerHTML = `<div class="empty">${esc(err.message)}<div class="actions"><button id="back-to-shelf" class="primary">返回书架</button></div></div>`;
    $('#back-to-shelf').addEventListener('click', () => bookshelf(root));
    return;
  }
  const { book, marks } = data;
  READ_STATE = { book, marks: marks || [], chapter: 0 };
  const pos = JSON.parse(localStorage.getItem('read-pos') || '{}');
  let cur = Number.isFinite(chapterIdx) ? chapterIdx : (pos[id] || 0);
  cur = Math.max(0, Math.min(cur, book.chapters.length - 1));
  READ_STATE.chapter = cur;
  renderReader(root, id);
  bindSelectionOnce();
}

// ---------- 统一阅读器：EPUB 型单章渲染（PDF 已自动转 EPUB）；目录常驻左侧、随内容滚动同步；每章底部可 AI 总结 ----------
let READER_CLEANUPS = []; // 每次渲染阅读器前清掉的监听

// 导航列表：优先书自带目录（toc 带 spineIdx 的项）；无 toc 用 spine；纯文本类用 chapters
function readerNavItems(book) {
  if (book.toc && book.toc.length) {
    return book.toc.filter((t) => t.spineIdx >= 0).map((t) => ({ label: t.title, level: t.level || 1, spine: t.spineIdx, anchor: t.anchor || '' }));
  }
  if (book.spine && book.spine.length) {
    return book.spine.map((s, i) => ({ label: s.title || `第 ${i + 1} 节`, level: 1, spine: Number(s.idx ?? i), anchor: '' }));
  }
  const out = [];
  (book.chapters || []).forEach((c, i) => { if (c.text) out.push({ label: c.title, level: c.parent ? 2 : 1, chapter: i, spine: -1, anchor: '' }); });
  return out;
}

// spine 序号 → 文字章下标（复述/划线数据用）；找不到则取它之前最近的一章
function resolveChapterOfSpine(book, si) {
  const cs = book.chapters || [];
  let hit = -1, last = -1;
  cs.forEach((c, i) => {
    if (!c.text) return;
    const a = c.spineIdx ?? -1, b = c.spineEnd ?? a;
    if (si >= a && si <= b) hit = i;
    else if (a <= si) last = i;
  });
  return hit >= 0 ? hit : (cs.length ? last : 0);
}
const chapterOfItem = (book, item) => (item.spine >= 0 ? resolveChapterOfSpine(book, item.spine) : (item.chapter ?? 0));

async function renderReader(root, id) {
  const { book } = READ_STATE;
  READER_CLEANUPS.splice(0).forEach((fn) => { try { fn(); } catch { /* */ } });
  const nav = readerNavItems(book);
  if (!nav.length) {
    root.innerHTML = '<div class="page-wide"><div class="empty">这本书暂时没有可读章节。</div></div>';
    return;
  }
  const posObj = JSON.parse(localStorage.getItem('read-pos') || '{}');
  let navIdx = Number(posObj[id]);
  if (!Number.isInteger(navIdx) || navIdx < 0 || navIdx >= nav.length) navIdx = 0;
  const fontPct = Math.min(150, Math.max(80, Number(localStorage.getItem('reader-font')) || 100));
  root.innerHTML = `
    <div class="page-wide">
    <div class="reader-wrap">
      <div class="reader-top">
        <button id="reader-back" class="ghost">← 书架</button>
        <div class="reader-title">
          <b>${esc(book.title)}</b>
          <span class="dim"><span id="reader-prog">第 ${navIdx + 1} / ${nav.length} 章</span></span>
        </div>
        <span class="font-ctl">
          <button id="reader-font-minus" class="ghost" title="缩小字号">A−</button>
          <button id="reader-font-plus" class="ghost" title="放大字号">A+</button>
        </span>
        <button id="reader-jump" class="ghost">📖 我的标记 (${(READ_STATE.marks || []).length})</button>
      </div>
      <div class="reader-body">
        <aside class="reader-toc"><b>目录</b><ol id="toc-list">
          ${nav.map((it, i) => `<li class="toc-item${(it.level || 1) > 1 ? ' toc-sub' : ''}" data-i="${i}" title="${esc(it.label)}">${esc(it.label)}</li>`).join('')}
        </ol></aside>
        <article class="reader-main">
          <div id="reader-crumb" class="reader-crumb"></div>
          <h3 id="reader-ch-title"></h3>
          <div class="reader-text" id="reader-text" style="font-size:${fontPct}%"><div class="loading">正在打开…</div></div>
          <div class="reader-actions">
            <button id="reader-prev" class="ghost">← 上一章</button>
            <button id="reader-recap" class="primary">✅ 我已读完这一章，AI 总结</button>
            <button id="reader-next" class="ghost">下一章 →</button>
          </div>
        </article>
      </div>
    </div>
    </div>`;

  const bind = (sel, fn) => { const el = $(sel); if (el) el.addEventListener('click', fn); };
  bind('#reader-back', () => bookshelf($('#app')));
  bind('#reader-jump', () => jumpToMark());
  bind('#reader-prev', () => loadReaderNav(READ_STATE.navIdx - 1, { scroll: 'top' }));
  bind('#reader-next', () => loadReaderNav(READ_STATE.navIdx + 1, { scroll: 'top' }));
  bind('#reader-recap', () => {
    const btn = $('#reader-recap');
    if (btn.disabled) return;
    const ch = READ_STATE.book.chapters[READ_STATE.chapter];
    if (!ch || !ch.text) return toast('本章没有可复述的文字');
    recapChapter(root, id);
  });
  const setFont = (d) => {
    const pct = Math.min(150, Math.max(80, (Number(localStorage.getItem('reader-font')) || 100) + d));
    localStorage.setItem('reader-font', String(pct));
    const el = $('#reader-text');
    if (el) el.style.fontSize = pct + '%';
  };
  bind('#reader-font-minus', () => setFont(-10));
  bind('#reader-font-plus', () => setFont(10));
  root.querySelectorAll('#toc-list .toc-item').forEach((li) => li.addEventListener('click', () => {
    loadReaderNav(Number(li.dataset.i), { anchor: readerNavItems(book)[Number(li.dataset.i)].anchor });
  }));
  bindReaderMarks(root, id);
  await loadReaderNav(navIdx, { scroll: 'top' });
}

async function loadReaderNav(idx, opts = {}) {
  const { book } = READ_STATE;
  const nav = readerNavItems(book);
  const item = nav[idx];
  const textEl = $('#reader-text');
  if (!item || !textEl) return;
  READ_STATE.navIdx = idx;
  READ_STATE.chapter = chapterOfItem(book, item);
  document.querySelectorAll('#toc-list .toc-item').forEach((li, i) => li.classList.toggle('cur', i === idx));
  const ti = $('#reader-ch-title');
  if (ti) ti.textContent = item.label;
  let parent = '';
  for (let i = idx - 1; i >= 0; i--) { if (nav[i].level < item.level) { parent = nav[i].label; break; } }
  const crumb = $('#reader-crumb');
  if (crumb) crumb.textContent = item.level > 1 && parent ? `◈ ${parent}` : '';
  const prog = $('#reader-prog');
  if (prog) prog.textContent = `第 ${idx + 1} / ${nav.length} 章`;
  localStorage.setItem('read-pos', JSON.stringify({ ...JSON.parse(localStorage.getItem('read-pos') || '{}'), [book.id]: idx }));
  const p = $('#reader-prev'), n = $('#reader-next');
  if (p) p.disabled = idx <= 0;
  if (n) n.disabled = idx >= nav.length - 1;
  if (opts.scroll !== 'keep') {
    window.scrollTo({ top: 0 });
    const mainEl = $('#reader-main');
    if (mainEl) mainEl.scrollTop = 0; // 滚动发生在正文栏内
  }

  if (item.spine >= 0) {
    textEl.innerHTML = '<div class="loading">正在加载本章…</div>';
    let r = null;
    try { r = await (await fetch(`/api/bookshelf/${book.id}/spine/${item.spine}/content`)).json(); } catch { /* 网络失败 */ }
    if ($('#reader-text') !== textEl) return; // 已切走
    if (!r || typeof r.html !== 'string') { textEl.innerHTML = '<div class="empty">本章加载失败，请刷新重试</div>'; return; }
    textEl.innerHTML = `<div class="epub-body">${r.html}</div>`;
    applyMarksHtml(textEl);
    setupTocSpy(idx);
  } else {
    const ch = book.chapters[item.chapter];
    textEl.innerHTML = ch ? renderChapterText(ch, item.chapter) : '<div class="empty">本章为空</div>';
    setupTocSpy(idx);
  }
  if (opts.thenFlash) {
    requestAnimationFrame(() => {
      const el = textEl.querySelector(`[data-mid="${opts.thenFlash}"]`);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2000); }
    });
  } else if (opts.anchor) {
    requestAnimationFrame(() => {
      try {
        const el = textEl.querySelector('#' + CSS.escape(opts.anchor));
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch { /* 锚点不存在则停留在顶部 */ }
    });
  }
}

// 目录滚动同步：当前章内若有锚点目录项，随滚动切换高亮；无锚点则固定高亮当前章
function setupTocSpy(idx) {
  const { book } = READ_STATE;
  const nav = readerNavItems(book);
  const item = nav[idx];
  const textEl = $('#reader-text');
  if (!textEl || !item || item.spine < 0) return;
  const anchors = [];
  nav.forEach((it, i) => {
    if (it.spine === item.spine && it.anchor) {
      try { const el = textEl.querySelector('#' + CSS.escape(it.anchor)); if (el) anchors.push({ i, el }); } catch { /* */ }
    }
  });
  if (!anchors.length) return;
  let raf = 0;
  const mainEl = $('#reader-main');
  const scrollHost = mainEl || window;
  const refTop = () => (mainEl ? mainEl.getBoundingClientRect().top : 0);
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!$('#reader-text')) return;
      const limit = refTop() + 130;
      let cur = anchors[0].i;
      for (const a of anchors) if (a.el.getBoundingClientRect().top <= limit) cur = a.i;
      document.querySelectorAll('#toc-list .toc-item').forEach((li, i) => li.classList.toggle('cur', i === cur));
    });
  };
  scrollHost.addEventListener('scroll', onScroll, { passive: true });
  READER_CLEANUPS.push(() => scrollHost.removeEventListener('scroll', onScroll));
}

// 内联渲染的章节里补挂划线高亮（mark 文本在 DOM 文本节点里匹配包裹）
function applyMarksHtml(el) {
  const marks = (READ_STATE.marks || []).filter((m) => m.text && m.text.length >= 2 && m.chapter === READ_STATE.chapter && (m.kind === 'mark' || m.kind === 'note'));
  for (const m of marks) {
    let node = null, off = -1;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const nd = walker.currentNode;
      if (!nd.parentElement || nd.parentElement.closest('.bm, script, style')) continue;
      const p = nd.nodeValue.indexOf(m.text);
      if (p >= 0) { node = nd; off = p; break; }
    }
    if (!node) continue;
    const parent = node.parentNode;
    const rest = node.splitText(off);
    const tail = rest.splitText(m.text.length);
    const span = document.createElement('span');
    span.className = 'bm' + (m.kind === 'note' ? ' bm-note' : '');
    span.dataset.mid = m.id;
    if (m.note) span.title = m.note;
    parent.replaceChild(span, rest);
    span.appendChild(rest);
    void tail;
  }
}

// 渲染章节文本：分段 + 图片 token（PDF 页图 / epub 插图）+ 划线标记高亮
function renderChapterText(ch, chapter) {
  const bookId = READ_STATE && READ_STATE.book ? READ_STATE.book.id : '';
  let html = String(ch.text || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // PDF 原页图：'auto' 模式只显示文字少的页（≈插图/表格页），'all' 显示每页；点击展开看原版
  const pdfMode = localStorage.getItem('pdf-page-mode') || 'auto';
  html = html.replace(/\u0002P(\d+):(\d+)\u0002/g, (_, n, len) => {
    if (pdfMode === 'auto' && Number(len) >= 200) return ''; // 纯文字页不重复渲染（仅真·图页/分隔页）
    return `<figure class="pageimg"><img class="pdf-page" loading="lazy" src="/api/bookshelf/${bookId}/pages/${n}" alt="原书第 ${n} 页"><figcaption>📄 原书第 ${n} 页 · 点击展开/收起</figcaption></figure>`;
  });
  // epub 内嵌插图
  html = html.replace(/\u0002I:([a-f0-9]{12}_[a-z0-9]+)\u0002/g, (_, k) => `<figure class="bookimg"><img class="book-img" loading="lazy" src="/api/bookshelf/${bookId}/imgs/${k}" alt="插图"><figcaption>🖼 本书插图</figcaption></figure>`);
  const marks = (READ_STATE.marks || []).filter((m) => m.text && m.text.length >= 2 && (m.kind === 'mark' || m.kind === 'note'));
  const tokens = [];
  for (const m of marks) {
    const re = new RegExp(escRegex(m.text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))), 'g');
    html = html.replace(re, () => { tokens.push(m); return `\u0000${tokens.length - 1}\u0000`; });
  }
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const m = tokens[Number(i)];
    return `<span class="bm${m.kind === 'note' ? ' bm-note' : ''}" data-mid="${m.id}"${m.note ? ` title="${esc(m.note)}"` : ''}>${esc(m.text)}</span>`;
  });
  return parasHtml(html);
}

function bindReaderMarks(root, id) {
  const textEl = $('#reader-text');
  if (!textEl) return;
  textEl.addEventListener('click', (e) => {
    // 点击页图/插图：展开/收起
    const pg = e.target.closest('.pdf-page, .book-img');
    if (pg) { e.stopPropagation(); pg.classList.toggle('full'); return; }
    const bm = e.target.closest('.bm');
    if (!bm) return;
    e.stopPropagation();
    const mid = Number(bm.dataset.mid);
    const m = (READ_STATE.marks || []).find((x) => x.id === mid);
    if (!m) return;
    const rect = bm.getBoundingClientRect();
    showSelPop(rect.left + rect.width / 2, rect.top + window.scrollY, `
      <b>${m.kind === 'note' ? '📝 笔记' : '✏️ 划线'}</b>
      <p class="sel-pop-text">${esc(m.text)}</p>
      ${m.note ? `<p class="dim">${esc(m.note)}</p>` : ''}
      <div class="sel-pop-actions">
        <button class="ghost" data-del>删除标记</button>
      </div>`, (pop) => {
      pop.querySelector('[data-del]').addEventListener('click', async () => {
        try {
          await api.del(`/api/bookshelf/${id}/marks/${mid}`);
          READ_STATE.marks = READ_STATE.marks.filter((x) => x.id !== mid);
          hideSelPop();
          pop.remove();
          loadReaderNav(READ_STATE.navIdx, { scroll: 'keep' });
        } catch (err) { toast(err.message); }
      });
    });
  });
}

// 选中文本 → 划线 / 笔记（微信读书式）
function bindSelectionOnce() {
  if (selBound) return;
  selBound = true;
  document.addEventListener('mouseup', (e) => {
    if (!e.target.closest) return;
    if (!e.target.closest('.reader-text')) { hideSelPop(); return; }
    const sel = window.getSelection();
    const txt = sel ? sel.toString().trim() : '';
    hideSelPop();
    if (!txt || txt.length < 6 || txt.length > 500 || txt.includes('\n\n')) return;
    // 框选起点落在划线上时忽略（避免点划线又弹框）
    if (e.target.closest('.bm')) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    showSelPop(rect.left + rect.width / 2, rect.top + window.scrollY, `
      <button class="ghost" data-act="mark">✏️ 划线</button>
      <button class="ghost" data-act="note">📝 划线+写笔记</button>`, (pop) => {
      const save = async (note) => {
        try {
          const id = READ_STATE.book.id;
          const r = await api.post(`/api/bookshelf/${id}/marks`, {
            chapter: READ_STATE.chapter, text: txt, kind: note ? 'note' : 'mark', note: note || '',
          });
          READ_STATE.marks.push({ id: r.id, text: txt, kind: note ? 'note' : 'mark', note: note || '', chapter: READ_STATE.chapter });
          hideSelPop();
          pop.remove();
          window.getSelection().removeAllRanges();
          loadReaderNav(READ_STATE.navIdx, { scroll: 'keep' });
        } catch (err) { toast(err.message); }
      };
      pop.querySelector('[data-act="mark"]').addEventListener('click', () => save(''));
      pop.querySelector('[data-act="note"]').addEventListener('click', () => {
        const note = prompt('写点笔记（会跟着划线一起显示）：');
        if (note !== null) save(note.trim());
      });
    });
  });
}

function jumpToMark() {
  const { book } = READ_STATE;
  const ms = READ_STATE.marks || [];
  if (!ms.length) return toast('还没有任何标记');
  const m = ms.find((x) => x.chapter === READ_STATE.chapter) || ms[0];
  if (!m) return toast('标记不存在');
  const nav = readerNavItems(book);
  let target = -1;
  nav.forEach((it, i) => { if (target < 0 && chapterOfItem(book, it) === m.chapter) target = i; });
  if (target < 0) target = 0;
  if (target !== READ_STATE.navIdx) loadReaderNav(target, { thenFlash: m.id });
  else {
    const el = document.querySelector(`[data-mid="${m.id}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2000); }
    else toast('本章还没有标记高亮');
  }
}

// 本章读完 → 章节文本存为素材卡 → 正常复述（语音说感受 → AI 三板块点评）
async function recapChapter(root, id) {
  const { book, chapter } = READ_STATE;
  const ch = book.chapters[chapter];
  const btn = $('#reader-recap');
  if (btn) { btn.disabled = true; btn.textContent = '已保存，正在打开复述…'; }
  try {
    const r = await api.post('/api/cards', {
      title: `《${book.title}》${ch.title}`,
      content: ch.text,
      source: `读书复述·${book.title}`,
    });
    startPractice({ id: r.id, title: `《${book.title}》${ch.title}`, content: ch.text });
  } catch (err) { toast(err.message); if (btn) { btn.disabled = false; btn.textContent = '✅ 我已读完这一章，AI 总结'; } }
}

// 浮动小弹层
let selPopEl = null;
function showSelPop(x, y, innerHtml, setup) {
  hideSelPop();
  const pop = document.createElement('div');
  pop.className = 'sel-pop';
  pop.innerHTML = innerHtml;
  document.body.appendChild(pop);
  const r = pop.getBoundingClientRect();
  let left = Math.min(Math.max(8, x - r.width / 2), document.documentElement.clientWidth - r.width - 8);
  let top = Math.max(8, y - r.height - 10);
  if (top < 8) top = y + 6;
  pop.style.left = left + 'px';
  pop.style.top = (top + window.scrollY) + 'px';
  selPopEl = pop;
  if (setup) setup(pop);
}
function hideSelPop() {
  if (selPopEl) { selPopEl.remove(); selPopEl = null; }
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideSelPop(); });
document.addEventListener('scroll', hideSelPop, true);

// ---------- 词库 ----------
async function words(root) {  root.innerHTML = '<div class="loading">加载中…</div>';
  let list;
  try {
    list = await api.get('/api/words');
  } catch (err) {
    root.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  if (!list.length) {
    root.innerHTML = `
      <h2>词库</h2>
      <div class="empty">词库还是空的——练一次复述，收尾报告会把替换词存进来。</div>`;
    return;
  }
  root.innerHTML = `
    <h2>词库 <span class="count">${list.length} 条</span></h2>
    <div class="words-wrap">
      ${list.map((w) => `
        <div class="word-row">
          <span class="orig">${esc(w.word)}</span>
          <span class="arrow">→</span>
          <span class="better">${esc(w.better)}</span>
          <span class="ctx">${esc(w.context || '')}</span>
        </div>`).join('')}
    </div>`;
}

// ---------- 启动 ----------
router();
refreshBadge();
