// flow-tools（桌面向导执行通道）的自检：分类器、状态断点、schema 守卫、脚本执行内核。
//
//   node plugin/research-dispatch/test/flow.selftest.mjs
//
// 三条硬约束与其它自检同款：不联网、不碰工作树（夹具全在 mktemp 副本里）、
// 收尾给结论行。status/preview 用例需要 Git Bash（与 selftest_pending 同依赖）。
import assert from 'node:assert/strict';
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
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log();
if (fails > 0) { console.log('✗ ' + fails + '/' + checks + ' 条断言失守 —— 桌面向导通道不可信'); process.exit(1); }
console.log('全部 ' + checks + ' 条断言通过（flow-tools 桌面向导，零联网零模型，工作树未动）');
