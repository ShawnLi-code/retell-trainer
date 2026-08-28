// 多用户硬隔离集成测试（需服务已在 :PORT 运行）：站长引导 → 建码 → 朋友进站 → 逐项验证互不可见
// 用法：node test-isolation.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:3025';

function mk() {
  let cookie = '';
  const send = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) { const m = c.match(/rt_uid=([^;]+)/); if (m) cookie = 'rt_uid=' + m[1]; }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
  return { send, hasCookie: () => !!cookie };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra || ''); } };

(async () => {
  const owner = mk();
  const friend = mk();
  const anon = mk();

  console.log('\n[1] 匿名访问受保护接口 → 401');
  const a = await anon.send('GET', '/api/state');
  ok('匿名 /api/state 401 + needAuth', a.status === 401 && a.data.needAuth === true, JSON.stringify(a));

  console.log('\n[2] 站长用 OWNER_CODE 登回（uid=owner，历史数据都在）');
  const j1 = await owner.send('POST', '/api/auth/join', { code: process.env.OWNER_CODE || 'LOCALOWNER' });
  ok('站长进入 200', j1.status === 200, JSON.stringify(j1));
  ok('站长 isOwner', j1.data.user && j1.data.user.isOwner === true, JSON.stringify(j1.data));
  const st = await owner.send('GET', '/api/state');
  ok('站长看到自己 streak/记录（totalSessions>0）', st.data.totalSessions > 0, JSON.stringify(st.data));
  const hist = await owner.send('GET', '/api/history');
  ok('站长历史 sessions 非空', Array.isArray(hist.data) ? hist.data.length > 0 : (hist.data.turns || hist.data.length !== 0), JSON.stringify(hist.data).slice(0, 80));
  const words = await owner.send('GET', '/api/words');
  ok('站长词库非空', Array.isArray(words.data) && words.data.length > 0, JSON.stringify(words.data).slice(0, 60));

  console.log('\n[3] 站长生成邀请码');
  const code = await owner.send('POST', '/api/admin/codes', { label: '测试朋友' });
  ok('生成码 200', code.status === 200 && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code.data.code || ''), JSON.stringify(code.data));
  const invCode = code.data.code;

  console.log('\n[4] 朋友用邀请码进站（新用户，空数据）');
  const j2 = await friend.send('POST', '/api/auth/join', { code: invCode, name: '小朋' });
  ok('朋友进入 200', j2.status === 200, JSON.stringify(j2));
  ok('朋友非站长', j2.data.user && j2.data.user.isOwner === false, JSON.stringify(j2.data));
  const fstate = await friend.send('GET', '/api/state');
  ok('朋友 totalSessions=0（看不到站长的练习）', fstate.data.totalSessions === 0, JSON.stringify(fstate.data));
  ok('朋友 me.name=小朋', fstate.data.me && fstate.data.me.name === '小朋', JSON.stringify(fstate.data.me));
  const fwords = await friend.send('GET', '/api/words');
  ok('朋友词库为空', Array.isArray(fwords.data) && fwords.data.length === 0, JSON.stringify(fwords.data));
  const fhist = await friend.send('GET', '/api/history');
  const fhistArr = Array.isArray(fhist.data) ? fhist.data : [];
  ok('朋友历史为空', fhistArr.length === 0, JSON.stringify(fhist.data).slice(0, 80));

  console.log('\n[5] 邀请码一次性 + 朋友不能进管理页');
  const reuse = await mk().send('POST', '/api/auth/join', { code: invCode, name: '蹭的' });
  ok('同码复用被拒', reuse.status === 400, JSON.stringify(reuse.data));
  const fadmin = await friend.send('GET', '/api/admin/overview');
  ok('朋友访问管理页 403', fadmin.status === 403, JSON.stringify(fadmin));

  console.log('\n[6] 素材归属：朋友看得到公共卡、看不到站长私有卡');
  const acards = await owner.send('GET', '/api/cards');
  const fcards = await friend.send('GET', '/api/cards');
  const aPriv = acards.data.filter((c) => c.scope === 'mine');
  const fPriv = fcards.data.filter((c) => c.scope === 'mine');
  const fHasOwnerPriv = fcards.data.some((c) => aPriv.some((p) => p.id === c.id));
  ok('站长能看到自己的私有卡', aPriv.length > 0, 'priv=' + aPriv.length);
  ok('朋友私有卡为 0', fPriv.length === 0, 'fpriv=' + fPriv.length);
  ok('朋友完全看不到站长私有卡', !fHasOwnerPriv);
  ok('朋友能看到公共卡', fcards.data.some((c) => c.scope === 'public'), 'pub=' + fcards.data.filter((c) => c.scope === 'public').length);

  console.log('\n[7] 写保护：朋友删不动公共卡、也删不动站长的卡');
  const firstPub = fcards.data.find((c) => c.scope === 'public');
  if (firstPub) {
    const delPub = await friend.send('DELETE', '/api/cards/' + firstPub.id);
    ok('朋友删公共卡 403', delPub.status === 403, JSON.stringify(delPub));
  }
  if (aPriv[0]) {
    const delOwner = await friend.send('DELETE', '/api/cards/' + aPriv[0].id);
    ok('朋友删站长私有卡 404/403（看不到=删不了）', delOwner.status === 404 || delOwner.status === 403, JSON.stringify(delOwner));
  }

  console.log('\n[8] 各写各的：朋友导入私有素材，站长看不到');
  const imp = await friend.send('POST', '/api/cards', { title: '朋友的秘密素材XYZ', content: '这是朋友自己加的一条素材内容，够长够长够长够长够长。'.repeat(6) });
  ok('朋友新增卡成功', imp.status === 200 && imp.data.id, JSON.stringify(imp.data));
  const fcards2 = await friend.send('GET', '/api/cards');
  const acards2 = await owner.send('GET', '/api/cards');
  const secretInFriend = fcards2.data.some((c) => c.title === '朋友的秘密素材XYZ');
  const secretInOwner = acards2.data.some((c) => c.title === '朋友的秘密素材XYZ');
  ok('朋友能看到自己新加的', secretInFriend);
  ok('站长看不到朋友新加的', !secretInOwner);

  console.log('\n[9] 站长刷新公共素材需 owner（朋友不能触发公共抓取）');
  const ffetch = await friend.send('POST', '/api/cards/fetch-rss', {});
  ok('朋友触发公共抓取 403', ffetch.status === 403, JSON.stringify(ffetch));

  console.log('\n[10] 书架隔离：朋友上传的书，站长看不到');
  // 用一段最小 epub? 上传需要真文件；这里改测 bookshelf 列表各自独立
  const abooks = await owner.send('GET', '/api/bookshelf');
  const fbooks = await friend.send('GET', '/api/bookshelf');
  ok('站长书架可见（含迁移过来的 owner 书）', Array.isArray(abooks.data.books), JSON.stringify(abooks).slice(0, 60));
  ok('朋友书架为空数组（独立目录）', Array.isArray(fbooks.data.books) && fbooks.data.books.length === 0, JSON.stringify(fbooks));

  console.log(`\n================ 结果：${pass} 通过 / ${fail} 失败 ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试脚本崩溃：', e); process.exit(2); });
