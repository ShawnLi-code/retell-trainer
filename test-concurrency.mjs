// 并发隔离压测：7 个用户高频交错读写，验证 AsyncLocalStorage 绝不串库。
// 用法：node test-concurrency.mjs   （需服务在 :3025 运行）
const BASE = process.env.BASE || 'http://127.0.0.1:3025';
const OWNER_CODE = process.env.OWNER_CODE || 'LOCALOWNER';

function mk() {
  let cookie = '';
  const send = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const m = c.match(/rt_uid=([^;]+)/); if (m) cookie = 'rt_uid=' + m[1];
    }
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return { send };
}

(async () => {
  const owner = mk();
  let r = await owner.send('POST', '/api/auth/join', { code: OWNER_CODE });
  if (r.status !== 200) { console.error('站长登录失败', r.data); process.exit(2); }

  const N = 6;
  const me = { owner: 'OWNER' };
  const friends = [];
  for (let i = 0; i < N; i++) {
    const code = (await owner.send('POST', '/api/admin/codes', { label: '并发F' + i })).data.code;
    const f = mk();
    const j = await f.send('POST', '/api/auth/join', { code, name: 'F' + i });
    if (j.status !== 200) { console.error('朋友登录失败', i, j.data); process.exit(2); }
    friends.push(f);
    me['F' + i] = 'F' + i;
  }

  const marker = Date.now();
  const WRITE_PER_USER = 8;

  // 1) 全员并发写：每人写 WRITE_PER_USER 条私有素材，标题前缀 = 自己的名字
  const writes = [];
  friends.forEach((f, i) => {
    for (let k = 0; k < WRITE_PER_USER; k++) {
      writes.push(f.send('POST', '/api/cards', { title: `F${i}-${k}-${marker}`, content: ('朋友内容' + i + '-' + k + ' ').repeat(15) }));
    }
  });
  for (let k = 0; k < WRITE_PER_USER; k++) {
    writes.push(owner.send('POST', '/api/cards', { title: `OWNER-${k}-${marker}`, content: ('站长内容' + k + ' ').repeat(15) }));
  }
  const wres = await Promise.all(writes);
  const wFail = wres.filter((x) => x.status !== 200).length;
  console.log(`并发写入 ${writes.length} 条，失败 ${wFail} 条`);

  // 2) 全员并发读自己的列表：不能看到任何别人前缀的标题；必须看到自己全部前缀标题
  const owners = ['OWNER', ...Array.from({ length: N }, (_, i) => 'F' + i)];
  const clients = [owner, ...friends];
  let cross = 0, missing = 0;
  const READ_ROUNDS = 6;
  await Promise.all(clients.map((cli, idx) => {
    const tag = owners[idx];
    return (async () => {
      for (let round = 0; round < READ_ROUNDS; round++) {
        const list = (await cli.send('GET', '/api/cards')).data;
        const mine = list.filter((c) => c.title.endsWith(marker) && c.title.startsWith(tag + '-'));
        const foreign = list.filter((c) => {
          if (!c.title.endsWith(marker)) return false;
          return owners.some((o) => o !== tag && c.title.startsWith(o + '-'));
        });
        if (foreign.length) { cross++; console.log(`  污染: ${tag} 看到了 ${foreign.slice(0, 2).map((c) => c.title)}`); }
        if (mine.length < WRITE_PER_USER) { missing++; console.log(`  丢失: ${tag} 只看到 ${mine.length}/${WRITE_PER_USER}`); }
      }
    })();
  }));

  // 3) 并发写（不同前缀 W，与 step2 区分），验证读回也互不串
  await Promise.all(clients.map(async (cli, idx) => {
    const tag = owners[idx];
    for (let k = 0; k < 4; k++) {
      await cli.send('POST', '/api/cards', { title: `W${tag}-${k}-${marker}`, content: ('并发内容 ').repeat(12) });
    }
    const list = (await cli.send('GET', '/api/cards')).data
      .filter((c) => String(c.title).endsWith(String(marker)) && String(c.title).startsWith('W'));
    const own = list.filter((c) => c.title.startsWith(`W${tag}-`)).length;
    const foreign = list.filter((c) => owners.some((o) => o !== tag && c.title.startsWith(`W${o}-`)));
    if (own !== 4) { missing++; console.log(`  丢失(W): ${tag} 只看到 ${own}/4`); }
    if (foreign.length) { cross++; console.log(`  污染(W): ${tag} 看到 ${foreign.length} 条别人的`); }
  }));

  console.log(`\n跨库污染 = ${cross}（应为 0）｜数据丢失 = ${missing}（应为 0）`);
  if (cross === 0 && missing === 0 && wFail === 0) { console.log('✅ 高并发下硬隔离成立'); process.exit(0); }
  console.log('❌ 并发隔离有问题');
  process.exit(1);
})();
