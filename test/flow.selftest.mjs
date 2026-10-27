// flow-tools（桌面向导执行通道）的自检：分类器、状态断点、schema 守卫、脚本执行内核。
//
//   node plugin/research-dispatch/test/flow.selftest.mjs
//
// 三条硬约束与其它自检同款：不联网、不碰工作树（夹具全在 mktemp 副本里）、
// 收尾给结论行。status/preview 用例需要 Git Bash（与 selftest_pending 同依赖）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const ft = await import(pathToFileURL(path.join(SRC, 'lib', 'flow-tools.mjs')).href);

let checks = 0, fails = 0;
const ok = (m) => { checks++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { checks++; fails++; console.log('  \x1b[31m✗\x1b[0m ' + m); };
const t = (name, fn) => { try { fn(); ok(name); } catch (e) { bad(name + ' —— ' + e.message); } };
const ta = async (name, fn) => { try { await fn(); ok(name); } catch (e) { bad(name + ' —— ' + e.message); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-selftest-'));
try {
  console.log('── 1) schema 守卫（fail-closed：方言 schema 必须被拒）');
  t('FLOW_PARAMETERS 是对象根且 violations 为空', () => {
    assert.equal(ft.parameterShapeViolations(ft.FLOW_PARAMETERS).length, 0);
    assert.equal(ft.FLOW_PARAMETERS.type, 'object');
    assert.ok(ft.FLOW_PARAMETERS.required.includes('action'));
  });
  t('逐属性 required 方言被点名（实践教训）', () => {
    const v = ft.parameterShapeViolations({ command: { type: 'string', required: true } });
    assert.ok(v.length >= 2, '应报 type 与 properties 两类违规，实得：' + v.join('；'));
  });
  t('registerFlowTools 透传 dispose 且 execute 可调', () => {
    let def = null;
    const scope = { tools: { register: (d) => { def = d; return () => {}; } } };
    const off = ft.registerFlowTools(scope, { repoRoot: tmp });
    assert.equal(typeof off, 'function');
    assert.equal(def.name, 'research_dispatch');
    assert.equal(def.parameters.type, 'object');
  });
  t('render 返回内容块数组（宿主 transport 对 result.content 调 .some，字符串会炸）', () => {
    let def = null;
    const scope = { tools: { register: (d) => { def = d; return () => {}; } } };
    ft.registerFlowTools(scope, { repoRoot: tmp });
    const blocks = def.output.render({}, { ok: true });
    assert.ok(Array.isArray(blocks), 'render 必须返回数组，实得 ' + typeof blocks);
    assert.ok(blocks.every((b) => b && b.type === 'text' && typeof b.text === 'string'));
    assert.equal(JSON.parse(blocks[0].text).ok, true);
  });

  console.log('── 2) classifyFolder 三分类（指纹=可念给用户听的证据）');
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-fresh-'));
  t('空目录 → fresh', () => assert.equal(ft.classifyFolder(fresh).class, 'fresh'));
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-foreign-'));
  fs.mkdirSync(path.join(foreign, 'papers'), { recursive: true });
  fs.writeFileSync(path.join(foreign, 'papers', 'x.md'), '别人家的笔记');
  t('有内容但无指纹 → foreign（不假装认领）', () => {
    const c = ft.classifyFolder(foreign);
    assert.equal(c.class, 'foreign');
    assert.equal(c.evidence.length, 0);
  });
  const ours = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ours-'));
  fs.mkdirSync(path.join(ours, 'ideas', 'briefs'), { recursive: true });
  fs.mkdirSync(path.join(ours, 'ideas', 'cards'), { recursive: true });
  fs.writeFileSync(path.join(ours, 'ideas', 'briefs', 'idea_01.md'),
    '<!-- meta role=brief idea=idea_01 bsha=abc anchor=x:signed -->\n正文');
  t('工单指纹 → ours 且 evidence 点名文件', () => {
    const c = ft.classifyFolder(ours);
    assert.equal(c.class, 'ours');
    assert.ok(c.evidence.some((e) => e.includes('idea_01.md')));
  });
  fs.writeFileSync(path.join(ours, 'ideas', 'cards', 'idea_02.manifest'),
    '<!-- manifest schema=2 2026-10-24T11:00:00+08:00 brief=b sha=abc status=PARTIAL(2/3) -->\nvotes: codex claude');
  t('manifest 指纹 → latest 报出最新轮次与 status', () => {
    const c = ft.classifyFolder(ours);
    assert.equal(c.latest.id, 'idea_02');
    assert.equal(c.latest.when, '2026-10-24T11:00:00+08:00');
    assert.ok(String(c.latest.status).startsWith('PARTIAL'));
  });

  console.log('── 3) 状态断点（origin 分得清人定与默认）');
  await ta('state_set → state_get 回读一致，二次写入合并不覆盖', async () => {
    const s1 = await ft.dispatchFlow({ action: 'state_set', step: 'ask-direction', open_question: 'direction',
      entries: { direction: { answer: 'KL 峰值早停', origin: 'human' } } }, { repoRoot: ours });
    assert.equal(s1.ok, true);
    const s2 = await ft.dispatchFlow({ action: 'state_set', step: 'preview-confirm',
      entries: { budget: { answer: '默认20条', origin: 'default' } } }, { repoRoot: ours });
    assert.equal(s2.state.answers.direction.answer, 'KL 峰值早停');
    assert.equal(s2.state.answers.budget.origin, 'default');
    const g = await ft.dispatchFlow({ action: 'state_get' }, { repoRoot: ours });
    assert.equal(g.exists, true);
    assert.equal(g.state.step, 'preview-confirm');
  });
  t('classify 把流程状态也认作指纹（断点可续）', () => {
    assert.ok(ft.classifyFolder(ours).evidence.some((e) => e.includes('.flow/state.json')));
  });

  console.log('── 4) status：经执行内核调原脚本（fixture 树，不碰工作树）');
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-status-'));
  fs.mkdirSync(path.join(st, 'dispatch'), { recursive: true });
  fs.mkdirSync(path.join(st, 'ideas', 'cards'), { recursive: true });
  // 有真实脚本就用它（monorepo 内保留对真脚本的覆盖）；独立安装/发布包里用自带桩，
  // 保证 npm 用户 `npm test` 也能跑绿——旧版直接 copy 仓库文件，包外必崩。
  const realScript = path.join(SRC, '..', '..', 'dispatch', 'pending_verdicts.sh');
  if (fs.existsSync(realScript)) {
    fs.copyFileSync(realScript, path.join(st, 'dispatch', 'pending_verdicts.sh'));
  } else {
    fs.writeFileSync(path.join(st, 'dispatch', 'pending_verdicts.sh'),
      '#!/usr/bin/env bash\necho "状态：1 轮待裁决"\necho "待裁决 1"\necho "  idea_07  votes: codex claude dsh"\nexit 1\n', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(st, 'ideas', 'cards', 'idea_07.manifest'),
    '<!-- manifest schema=2 2026-10-24T12:00:00+08:00 brief=b sha=dead status=OK -->\nvotes: codex claude dsh\n');
  await ta('status 退 1（有待裁决）且报告点名轮次', async () => {
    const r = await ft.dispatchFlow({ action: 'status' }, { repoRoot: st });
    assert.equal(r.ok, false);           // rc=1 = 有待裁决，是既定语义不是故障
    assert.equal(r.rc, 1);
    assert.ok(r.report.includes('idea_07'), '报告应点名待裁决轮次');
    assert.ok(r.report.includes('待裁决 1'));
  });
  await ta('preview 缺 brief 被参数闸拦住', async () => {
    const r = await ft.dispatchFlow({ action: 'preview' }, { repoRoot: st });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'brief-required');
  });
  t('bashBin 不落 system32（WSL 转发器被排除）', () => {
    assert.ok(!/system32/i.test(ft.bashBin()));
  });

  console.log('── 5) repo-root 推导');
  t('findRepoRoot：命中仓库根则必须真有 seats.json，包外返回 null 不抛错', () => {
    const r = ft.findRepoRoot();
    if (r) assert.ok(fs.existsSync(path.join(r, 'dispatch', 'seats.json')), '命中时必须真有 seats.json');
    else assert.equal(r, null, '未命中应为 null（不抛错）');
  });
  console.log('── 6) F1-1 命令注入：preview 的工单路径只走 argv，逐字节进 fanout');
  // 旧版拼的是 "bash dispatch/fanout.sh " + JSON.stringify(brief) 交给 bash -c ——
  // 双引号挡不住 $(...)/反引号，实测会真创建 PWNED，且 argv1 被静默换成 x.md 之后照样回 ok:true。
  const inj = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-inj-'));
  fs.mkdirSync(path.join(inj, 'dispatch'), { recursive: true });
  fs.writeFileSync(path.join(inj, 'dispatch', 'fanout.sh'),
    '#!/usr/bin/env bash\nprintf \'%s\' "$1" > argv1.txt\nprintf \'DRY=%s\' "${DRY:-}" > env.txt\nexit 0\n',
    { mode: 0o755 });
  const NASTY = 'x$(touch PWNED).md `touch PWNED2` a\'b"c;d e 中文 换行\n第二行.md';
  await ta('注入串逐字节进 fanout（argv1 与传入值完全相同）', async () => {
    const r = await ft.dispatchFlow({ action: 'preview', brief: NASTY }, { repoRoot: inj });
    assert.equal(r.ok, true, 'preview 应成功，实得：' + JSON.stringify(r).slice(0, 400));
    const got = fs.readFileSync(path.join(inj, 'argv1.txt'), 'utf8');
    assert.equal(got, NASTY, 'argv1 与传入值不等：' + JSON.stringify(got));
    assert.equal(Buffer.compare(Buffer.from(got, 'utf8'), Buffer.from(NASTY, 'utf8')), 0);
  });
  t('注入串没有执行任何替换（PWNED / PWNED2 未被创建）', () => {
    for (const d of [inj, HERE, process.cwd(), os.tmpdir()]) {
      for (const n of ['PWNED', 'PWNED2']) {
        assert.ok(!fs.existsSync(path.join(d, n)), '不该出现 ' + path.join(d, n));
      }
    }
  });
  t('不走 shell 也没丢环境：DRY=1 仍进到脚本', () => {
    assert.equal(fs.readFileSync(path.join(inj, 'env.txt'), 'utf8'), 'DRY=1');
  });

  console.log('── 7) F1-2 裸 bash 兜底：拒用 system32 的 WSL 转发器 + 解析留痕');
  t('PATH 首选 bash 是 system32 转发器 → bash-unavailable（不拿它去跑）', () => {
    const res = ft.resolveBash({
      env: { PATH: 'C:\\Windows\\System32;C:\\Users\\x\\bin' },
      exists: (p) => /[\\/]system32[\\/]bash\.exe$/i.test(p),
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bash-unavailable');
    assert.equal(res.bin, null, '解析失败时 bin 必须是 null（不许回落成裸名 bash）');
    assert.match(String(res.detail), /WSL/);
    assert.match(String(res.hint), /DSH_DISPATCH_BASH/);
  });
  t('真机 PATH 只留 system32 时解析不到可用 bash（转发器一律拒）', () => {
    const res = ft.resolveBash({ env: { PATH: 'C:\\Windows\\System32' }, exists: (p) => fs.existsSync(p) });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bash-unavailable');
    assert.match(String(res.hint), /DSH_DISPATCH_BASH/);
  });
  t('环境变量指向不存在的 bash → 留痕（不静默忽略），并继续自动探测', () => {
    const res = ft.resolveBash({ env: { DSH_DISPATCH_BASH: 'C:\\nope\\bash.exe', PATH: '' }, exists: () => false });
    assert.equal(res.ok, false);
    assert.ok(Array.isArray(res.warnings) && res.warnings.length > 0, 'warnings 不能为空');
    assert.ok(res.warnings.some((w) => w.includes('DSH_DISPATCH_BASH') && w.includes('不存在')),
      '实得：' + JSON.stringify(res.warnings));
  });
  await ta('bash 不可用时 status 回 bash-unavailable（不是 rc:1 加 UTF-16 乱码）', async () => {
    const r = await ft.dispatchFlow({ action: 'status' },
      { repoRoot: st, bash: { ok: false, reason: 'bash-unavailable', detail: 'PATH 首选 bash 是 system32 下的 WSL 转发器：X', hint: '设置 DSH_DISPATCH_BASH 指向 Git Bash 完整路径' } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bash-unavailable');
    assert.equal(r.rc, undefined, '不该伪装成脚本自己退 1');
    assert.match(String(r.hint), /DSH_DISPATCH_BASH/);
  });

  console.log('── 8) F1-3 池子指纹：认 assemble_pool.sh 真行的首行');
  // 生产端是 dispatch/assemble_pool.sh:82，首行 "<!-- _pool 由 dispatch/assemble_pool.sh 装配 · valid=… -->"；
  // "meta role=diverger" 是 pool_io.py 写给发散产物的行（旧版池子才有）。只认后者 = 死检查。
  const poolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-pool-'));
  fs.mkdirSync(path.join(poolDir, 'dispatch'), { recursive: true });
  fs.mkdirSync(path.join(poolDir, 'papers', 'cards'), { recursive: true });
  const repoDispatch = path.join(SRC, '..', '..', 'dispatch');
  const haveRealPool = fs.existsSync(path.join(repoDispatch, 'assemble_pool.sh'))
    && fs.existsSync(path.join(repoDispatch, 'check_paper.py'));
  fs.writeFileSync(path.join(poolDir, 'papers', 'cards', 'resnet.md'),
    '<!-- meta role=scout via=qoder-subagent -->\n\n```yaml\npaper_id: resnet\ntitle: "T resnet"\nvenue: CVPR\ncode_url: none\nabstract_zh: "摘要一二三。"\nintro_key: "痛点。"\nrelevance: "相关。"\n```\n');
  if (haveRealPool) {
    fs.copyFileSync(path.join(repoDispatch, 'assemble_pool.sh'), path.join(poolDir, 'dispatch', 'assemble_pool.sh'));
    fs.copyFileSync(path.join(repoDispatch, 'check_paper.py'), path.join(poolDir, 'dispatch', 'check_paper.py'));
  }
  const pyOk = (() => {
    const b = ft.bashBin();
    if (!b) return false;
    try {
      const s = spawnSync(b, ['-c', 'command -v python'], { encoding: 'utf8', windowsHide: true });
      return s.status === 0 && String(s.stdout || '').trim() !== '';
    } catch { return false; }
  })();
  let poolFromReal = false;
  if (haveRealPool && pyOk) {
    await ft.runScript(poolDir, 'dispatch/assemble_pool.sh', [], { timeoutMs: 60000 });
    poolFromReal = fs.existsSync(path.join(poolDir, 'papers', 'cards', '_pool.md'));
  }
  if (!poolFromReal) {
    // 包外 / 无 python 的自检机：按生产端**逐字节**的首行造池子，判据仍然由 flow-tools 判。
    fs.writeFileSync(path.join(poolDir, 'papers', 'cards', '_pool.md'),
      '<!-- _pool 由 dispatch/assemble_pool.sh 装配 · valid=1/1 · 检索来源见各卡 meta（Qoder subagent） -->\n\n正文\n');
  }
  t('只有文献池的目录判 ours 且 evidence 点名 papers/cards/_pool.md（' +
    (poolFromReal ? '真跑 assemble_pool.sh 拼出的池' : '按生产端首行生成的池') + '）', () => {
    const c = ft.classifyFolder(poolDir);
    assert.equal(c.class, 'ours', '实得 ' + c.class + '，evidence=' + JSON.stringify(c.evidence));
    assert.ok(c.evidence.some((e) => e.includes('papers/cards/_pool.md')),
      'evidence 应点名池子；实得 ' + JSON.stringify(c.evidence));
  });
  t('旧标记 meta role=diverger 仍兼容（历史池子不因改判据变 foreign）', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-poolold-'));
    fs.mkdirSync(path.join(d, 'papers', 'cards'), { recursive: true });
    fs.writeFileSync(path.join(d, 'papers', 'cards', '_pool.md'),
      '<!-- meta role=diverger model=kimi-k3 input=papers/cards/_pool.md isha=abc topic=t -->\n');
    const c = ft.classifyFolder(d);
    assert.equal(c.class, 'ours');
    assert.ok(c.evidence.some((e) => e.includes('papers/cards/_pool.md')));
  });

  console.log('── 9) F1-4 state_set：只合并**显式给出**的字段');
  const st2 = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-state-'));
  await ta('先写 step+open_question，再只传 entries → 断点仍在，answers 正常合并', async () => {
    const r1 = await ft.dispatchFlow({ action: 'state_set', step: 'ask-direction', open_question: 'direction',
      entries: { a: { answer: 'KL 峰值早停', origin: 'human' } } }, { repoRoot: st2 });
    assert.equal(r1.ok, true);
    const r2 = await ft.dispatchFlow({ action: 'state_set', entries: { b: { answer: '默认20条', origin: 'default' } } }, { repoRoot: st2 });
    assert.equal(r2.ok, true);
    const disk = JSON.parse(fs.readFileSync(ft.statePath(st2), 'utf8'));
    assert.equal(disk.step, 'ask-direction', '断点 step 被抹掉了：' + JSON.stringify(disk));
    assert.equal(disk.open_question, 'direction', '断点 open_question 被抹掉了');
    assert.equal(disk.answers.a.answer, 'KL 峰值早停');
    assert.equal(disk.answers.b.origin, 'default');
  });

  console.log('── 10) F1-5 超时：调用方不被告拖住，孙进程树被回收');
  const toDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-to-'));
  fs.mkdirSync(path.join(toDir, 'dispatch'), { recursive: true });
  // 探针形态对齐报告：后台子 shell 握着 stdout 管道、1.2s 后落 ORPHAN，脚本本体常驻。
  fs.writeFileSync(path.join(toDir, 'dispatch', 'slow.sh'),
    '#!/usr/bin/env bash\n( sleep 1.2; : > ORPHAN ) &\nsleep 10\n', { mode: 0o755 });
  await ta('timeoutMs=300 百毫秒量级返回，且事后 ORPHAN 不出现（树被回收）', async () => {
    const t0 = Date.now();
    const r = await ft.runScript(toDir, 'dispatch/slow.sh', [], { timeoutMs: 300 });
    const cost = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
    assert.ok(cost < 1500, 'timeoutMs=300 的调用被拖住了：' + cost + 'ms');
    assert.ok(r.cleanup && typeof r.cleanup.detail === 'string', '清理必须留痕：' + JSON.stringify(r.cleanup));
    await new Promise((res) => setTimeout(res, 2500));
    assert.ok(!fs.existsSync(path.join(toDir, 'ORPHAN')), '孙进程没被回收：ORPHAN 被创建了');
  });

  console.log('── 11) F1-6 / F1-7 装配期喊话真的被捕获 + 配置坏了工具仍在');
  process.env.RESEARCH_DISPATCH_DIAG = path.join(tmp, 'diag.log');
  const idx = await import(pathToFileURL(path.join(SRC, 'lib', 'index.js')).href);
  // 假 ctx：logger 是**函数**（cordis 形态 ctx.logger(name) → Logger），同时自身也带 .info/.error。
  const captured = [];
  const fakeLogger = (name) => ({
    info: (m) => captured.push({ level: 'info', text: String(m) }),
    error: (m) => captured.push({ level: 'error', text: String(m) }),
  });
  fakeLogger.info = (m) => captured.push({ level: 'info', text: String(m) });
  fakeLogger.error = (m) => captured.push({ level: 'error', text: String(m) });
  const mkCtx = (defs) => ({
    logger: fakeLogger,
    get: (n) => (n === 'tools' ? { register: (d) => { defs.push(d); return () => {}; } } : null),
    on: () => {},
  });
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-cfg-'));
  fs.mkdirSync(path.join(broken, 'papers'), { recursive: true });
  fs.writeFileSync(path.join(broken, 'papers', 'x.md'), '别人家的笔记');
  const brokenDefs = [];
  await ta('座位表缺失：apply 不抛、工具仍注册、classify 可用、status/preview 回 config-error', async () => {
    idx.apply(mkCtx(brokenDefs), { repoRoot: broken, seatsFile: 'dispatch/seats.json' });
    assert.equal(brokenDefs.length, 1, '配置坏了也必须注册 research_dispatch（旧版直接 return）');
    assert.equal(brokenDefs[0].name, 'research_dispatch');
    const cls = await brokenDefs[0].execute({ action: 'classify' });
    assert.equal(cls.ok, true, 'classify 不依赖座位表，必须仍可用：' + JSON.stringify(cls).slice(0, 300));
    assert.equal(cls.class, 'foreign');
    const s = await brokenDefs[0].execute({ action: 'status' });
    assert.equal(s.ok, false);
    assert.equal(s.reason, 'config-error');
    assert.match(String(s.detail), /找不到座位表/, 'detail 必须是原始报错：' + String(s.detail));
    const p = await brokenDefs[0].execute({ action: 'preview', brief: 'ideas/briefs/x.md' });
    assert.equal(p.ok, false);
    assert.equal(p.reason, 'config-error');
  });
  t('装配期错误真的进了 logger（旧写法 ctx.logger("error", msg) 会被丢）', () => {
    const errs = captured.filter((c) => c.level === 'error').map((c) => c.text);
    assert.ok(errs.length > 0, 'logger 一条都没收到：' + JSON.stringify(captured));
    assert.ok(errs.some((x) => x.includes('座位表加载失败')), '实得：' + JSON.stringify(errs));
  });
  t('装配成功时 info 留言也真的进了 logger（不是只落 console）', () => {
    const good = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-cfgok-'));
    fs.mkdirSync(path.join(good, 'dispatch'), { recursive: true });
    fs.writeFileSync(path.join(good, 'dispatch', 'seats.json'), JSON.stringify({ seats: [{ id: 'codex', enabled: true }] }));
    const before = captured.length;
    const defs = [];
    idx.apply(mkCtx(defs), { repoRoot: good, seatsFile: 'dispatch/seats.json' });
    const infos = captured.slice(before).filter((c) => c.level === 'info').map((c) => c.text);
    assert.ok(infos.some((x) => x.includes('已加载')), '实得：' + JSON.stringify(infos));
    assert.equal(defs.length, 1);
  });

} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log();
if (fails > 0) { console.log('✗ ' + fails + '/' + checks + ' 条断言失守 —— 桌面向导通道不可信'); process.exit(1); }
console.log('全部 ' + checks + ' 条断言通过（flow-tools 桌面向导，零联网零模型，工作树未动）');
