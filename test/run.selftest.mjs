// run.mjs（派工层）的自检：票数守卫、零票、DRY 绿灯、锚点检查器的 rc 分类、卡归属、
// 入口用法、座位 tag、on_missing、陈旧锁。
//
//   node plugin/research-dispatch/test/run.selftest.mjs
//
// 三条硬约束与 flow.selftest 同款：零联网、零模型、不碰工作树（夹具全在系统临时目录）。
//
// 为什么走真入口（node bin/dispatch.mjs run <brief>）而不是 import run()：run() 会
// process.chdir()、会往 process.env 里写东西，进程内跑一遍就把后面所有用例的环境弄脏了；
// 而且这些判据的对外承诺本来就是"退出码 + 终端文案"，只有真起进程才验得到。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');                 // plugin/research-dispatch
const REPO = path.resolve(SRC, '..', '..');           // 仓库根
const BIN = path.join(SRC, 'bin', 'dispatch.mjs');
const RUNMJS = path.join(SRC, 'lib', 'run.mjs');
const REAL_ANCHOR = path.join(REPO, 'dispatch', 'anchor_check.sh');
// 包外（npm 安装后）仓库里没有 dispatch/ 这一层。§5 验的是「run.mjs 怎么把检查器的
// 退出码与原文翻译成派工结论」，不是检查器本身，所以拿不到真脚本时用一个等价桩：
// 同样的退出码、同样风格的一句原话。有真脚本时仍然用真的（monorepo 里保持真集成）。
const REAL_ANCHOR_SRC = fs.existsSync(REAL_ANCHOR) ? fs.readFileSync(REAL_ANCHOR, 'utf8') : null;
function checkerStub(kind) {
  const m = {
    rc4: ['!! baselines/_fx/REPRO.md §3 的“我复现”列没有任何数值 —— 论文列有数但自己还没复现出的，不算可用锚点', 4],
    rc2: ['!! 找不到 python —— BB 一致性与 delta 对账都做不了（尺子不可用，退 2，不是锚点问题）', 2],
    rc1: ['!! baselines/_fx/REPRO.md §4 没签字 —— 未验收的基线不能当锚点', 1],
  }[kind];
  return '#!/usr/bin/env bash\nset -uo pipefail\nprintf \'%s\\n\' \'' + m[0] + '\' >&2\nexit ' + m[1] + '\n';
}

let checks = 0, fails = 0;
const ok = (m) => { checks++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { checks++; fails++; console.log('  \x1b[31m✗\x1b[0m ' + m); };
const t = (name, fn) => { try { fn(); ok(name); } catch (e) { bad(name + ' —— ' + (e && e.message)); } };

// Git Bash：run.mjs 里所有外部命令（CLI 座、锚点检查器、卡校验器）都经它启动。宿主进程
// 没有 fanout.sh 替我们 export DSH_DISPATCH_BASH，所以自己解析一份 —— 复用 flow-tools 的
// 解析器，它已显式排除 system32 下那个 WSL 转发器（拿它去跑只会得到一串 UTF-16 乱码）。
const ft = await import(pathToFileURL(path.join(SRC, 'lib', 'flow-tools.mjs')).href);
const bashInfo = ft.resolveBash();
const BASH = bashInfo.ok ? bashInfo.bin : 'bash';
if (!bashInfo.ok) {
  console.log('  \x1b[33m⚠\x1b[0m 没解析到 Git Bash（' + (bashInfo.reason || '未知原因') + '）—— 依赖 bash 的用例会失败');
}

const TMP_ROOTS = [];
function tmpRoot(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'run-selftest-' + tag + '-'));
  TMP_ROOTS.push(d);
  return d;
}

function writeStub(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/usr/bin/env bash\nset -uo pipefail\n' + body + '\n', { mode: 0o755 });
}

// 夹具座位表：字段名与 dispatch/seats.json 逐字一致（这是派工层唯一读的形状）。
function apiSeat(id) {
  return {
    id, kind: 'api', enabled: true,
    python: 'python',
    script: 'dispatch/api_chat.py',          // 桩：本文件永真跑 api（缺 env 即跳过）
    base_env_var: 'FX_API_BASE',
    key_env_var: 'FX_API_KEY',
    model: { env: 'FX_API_MODEL', default: 'fx-api-model-1' },
    votes: { env: 'API_VOTES', default: 1 },
    temperature: { env: 'FX_API_TEMP', default: '0.2' },
    identity: { kind: 'api' },
  };
}

function cliSeat(id, command, extra = {}) {
  return {
    id, kind: 'cli', enabled: true, command,
    argv: ['-x', '{payload}'], payload_position: 'argv', output: 'stdout',
    identity: { kind: 'config', explicit_env: 'FX_MODEL' },
    ...extra,
  };
}

/**
 * 造一棵最小可跑的仓库树：座位表 + 角色文件 + 工单 + 两个尺子桩。
 * checker: 'ok'（默认，尺子可用）| 'real'（拷真 anchor_check.sh）| 脚本文本
 */
function mkFixture(tag, o = {}) {
  const root = tmpRoot(tag);
  const id = o.id || 'idea_01';
  fs.mkdirSync(path.join(root, 'dispatch'), { recursive: true });
  fs.mkdirSync(path.join(root, 'roles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ideas', 'briefs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ideas', 'cards'), { recursive: true });
  fs.writeFileSync(path.join(root, 'roles', 'reviewer.md'), '你是评审。只输出 YAML。\n');

  // 尺子 1：锚点检查器。默认桩退 0；F2-4 的用例换成真脚本（或真脚本 + 环境改造）。
  const checker = o.checkerBody === undefined ? 'exit 0' : o.checkerBody;
  writeStub(path.join(root, 'dispatch', 'anchor_check.sh'), checker);
  // 尺子 2：卡校验器。本文件的判据都在 run.mjs 侧，校验器一律放行（真校验器有它自己的自检）。
  writeStub(path.join(root, 'dispatch', 'fx_validator.sh'), 'exit 0');

  const cfg = {
    version: 1,
    paths: {
      cards_dir: 'ideas/cards',
      workers_dir: 'workers',
      role_file: 'roles/reviewer.md',
      anchor_checker: 'dispatch/anchor_check.sh',
      // cmd[0] 用绝对路径的 bash（不在仓库内也不是越界），cmd[1] 才是仓库内脚本。
      card_validator: [BASH, 'dispatch/fx_validator.sh'],
    },
    default_backends: o.defaultBackends || ['codex'],
    seats: o.seats || [cliSeat('codex', 'node')],
  };
  fs.writeFileSync(path.join(root, 'dispatch', 'seats.json'), JSON.stringify(cfg, null, 2));

  const anchor = o.anchor === undefined ? 'baselines/_fx' : o.anchor;
  const baseline = o.baseline === undefined ? 'top-1 = 76.0。\n' : o.baseline;
  const brief = path.join(root, 'ideas', 'briefs', id + '.md');
  fs.writeFileSync(brief, [
    '<!-- meta role=brief idea=' + id + ' bsha=deadbeef anchor=' + anchor + ' -->',
    '## 待评审材料（唯一输入）',
    '',
    '### Baseline',
    '',
    baseline,
    '### Idea',
    '',
    '**ID**: ' + id,
    '',
  ].join('\n'));
  return { root, id, brief, cfg };
}

// 子进程环境：密封 HOME 与设置文档，否则真机上"面板里的评审票 / 各家 CLI 配置"会混进来，
// 断言的结论就跟着这台机器变。
function childEnv(root, extra = {}) {
  const env = { ...process.env };
  for (const k of ['BACKENDS', 'DRY', 'API_VOTES', 'CALIBRATION', 'SHOW_PAYLOAD_TO', 'ALLOW_DOOMED_PLAN']) delete env[k];
  const fakeHome = path.join(root, '.fakehome');
  fs.mkdirSync(fakeHome, { recursive: true });
  Object.assign(env, {
    DSH_DISPATCH_ROOT: root,
    DSH_DISPATCH_BASH: BASH,
    DSH_DISPATCH_SETTINGS: path.join(root, 'no-such-settings.yml'),
    HOME: fakeHome,
    FX_MODEL: 'fx-model-1',
    ...extra,
  });
  for (const k of Object.keys(env)) if (env[k] === '') delete env[k];
  return env;
}

function runDispatch(root, args, extra = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: root, encoding: 'utf8', env: childEnv(root, extra), timeout: 120000,
  });
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function lockPath(root, id) {
  return path.join(root, 'ideas', 'cards', id + '.lock');
}

function firstLineOf(text, needle) {
  return String(text).split('\n').find((l) => l.includes(needle)) || '';
}

try {
  // ── 1) 入口用法（F2-6）：问用法不等于环境坏了 ─────────────────────────
  console.log('── 1) bin/dispatch.mjs 的用法与未知子命令（F2-6）');
  const fx0 = mkFixture('usage');
  t('--help → 打印用法并退 0', () => {
    const r = runDispatch(fx0.root, ['--help']);
    assert.equal(r.rc, 0, '--help 应退 0，实得 ' + r.rc);
    assert.ok(r.out.includes('用法:'), '应打印用法');
  });
  t('-h → 退 0', () => {
    const r = runDispatch(fx0.root, ['-h']);
    assert.equal(r.rc, 0, '-h 应退 0，实得 ' + r.rc);
  });
  t('无参数 → 打印用法并退 0', () => {
    const r = runDispatch(fx0.root, []);
    assert.equal(r.rc, 0, '无参数应退 0，实得 ' + r.rc);
    assert.ok(r.out.includes('run <工单>'), '应打印用法正文');
  });
  t('未知子命令 → 退 2，但文案说明是「未知子命令」不是基础设施故障', () => {
    const r = runDispatch(fx0.root, ['no-such-subcommand']);
    assert.equal(r.rc, 2, '未知子命令应退 2，实得 ' + r.rc);
    assert.ok(r.out.includes('未知子命令'), '文案要点明是命令写错');
    assert.ok(!/未预期异常/.test(r.out), '不许把用法错说成未预期异常');
  });

  // ── 2) 票数守卫（F2-1）：非法票数当场 fail-closed ────────────────────
  console.log('── 2) 票数守卫（F2-1）');
  const fx1 = mkFixture('votes', { seats: [apiSeat('api')], defaultBackends: ['api'] });
  t('API_VOTES=abc → 退 2，点名 env 名与实际值', () => {
    const r = runDispatch(fx1.root, ['run', 'ideas/briefs/idea_01.md'], { API_VOTES: 'abc' });
    assert.equal(r.rc, 2, '票数非法必须退 2，实得 ' + r.rc);
    assert.ok(r.out.includes('API_VOTES'), '报错要点名变量名，实得：' + r.out.slice(0, 300));
    assert.ok(r.out.includes('"abc"'), '报错要带实际值');
    assert.ok(/票数配置非法/.test(r.out), '要说清是票数配置问题');
    assert.ok(!/未预期异常/.test(r.out), '这是配置错，不是未预期异常');
  });
  t('API_VOTES=abc 时一票都不许调（计划阶段就停）', () => {
    const cards = path.join(fx1.root, 'ideas', 'cards');
    const before = fs.readdirSync(cards).length;
    runDispatch(fx1.root, ['run', 'ideas/briefs/idea_01.md'], { API_VOTES: 'abc' });
    assert.equal(fs.readdirSync(cards).length, before, '不该写下任何卡/manifest');
  });
  t('API_VOTES=1 行为不变：跳过未配置的 api 座，manifest 记 NO-OUTPUT(0/1)', () => {
    const r = runDispatch(fx1.root, ['run', 'ideas/briefs/idea_01.md'], { API_VOTES: '1' });
    assert.equal(r.rc, 2, '零产出应退 2，实得 ' + r.rc);
    assert.ok(!/票数配置非法/.test(r.out), '合法票数不该报配置错');
    const man = fs.readFileSync(path.join(fx1.root, 'ideas', 'cards', 'idea_01.manifest'), 'utf8');
    assert.ok(man.includes('status=NO-OUTPUT(0/1)'), 'manifest 应记 NO-OUTPUT(0/1)，实得：' + firstLineOf(man, 'status='));
  });
  t('API_VOTES=0 → 退 2（≤0 也是非法票数）', () => {
    const fx = mkFixture('votes-zero', { seats: [apiSeat('api')], defaultBackends: ['api'] });
    const r = runDispatch(fx.root, ['run', 'ideas/briefs/idea_01.md'], { API_VOTES: '0' });
    assert.equal(r.rc, 2, 'API_VOTES=0 应退 2，实得 ' + r.rc);
    assert.ok(/票数配置非法/.test(r.out), '要说清是票数配置问题');
  });
  t('API_VOTES=1.5 → 退 2（非整数）', () => {
    const fx = mkFixture('votes-frac', { seats: [apiSeat('api')], defaultBackends: ['api'] });
    const r = runDispatch(fx.root, ['run', 'ideas/briefs/idea_01.md'], { API_VOTES: '1.5' });
    assert.equal(r.rc, 2, 'API_VOTES=1.5 应退 2，实得 ' + r.rc);
  });

  // ── 3) 零座位计划（F2-2）：没排座位不是"没人反对" ─────────────────────
  console.log('── 3) 计划 0 票（F2-2）');
  const fx2 = mkFixture('no-seat', { defaultBackends: [] });
  t('default_backends=[] → 退 2，文案说清"没排任何座位"', () => {
    const r = runDispatch(fx2.root, ['run', 'ideas/briefs/idea_01.md']);
    assert.equal(r.rc, 2, '计划 0 票应退 2，实得 ' + r.rc);
    assert.ok(r.out.includes('没有排任何座位'), '文案要点明没排座位，实得：' + r.out.slice(0, 250));
  });
  t('default_backends=[] → manifest 不是 OK，记 NO-OUTPUT(0/0)', () => {
    const man = fs.readFileSync(path.join(fx2.root, 'ideas', 'cards', 'idea_01.manifest'), 'utf8');
    assert.ok(!/status=OK/.test(man), 'manifest 不许写成 OK，实得：' + firstLineOf(man, 'status='));
    assert.ok(man.includes('status=NO-OUTPUT(0/0)'), '应记 NO-OUTPUT(0/0)');
    assert.ok(man.includes('votes: none'), 'votes 如实记 none');
  });

  // ── 4) DRY 预演（F2-3）：一定零票就不许给绿灯 ─────────────────────────
  console.log('── 4) DRY 预演的零票（F2-3）');
  const fx3a = mkFixture('dry-zero', { seats: [cliSeat('ghost', 'no-such-cli-xyz-42')], defaultBackends: ['ghost'] });
  t('DRY：座位表里的命令都不存在 → 退 2 且说"别去花钱"', () => {
    const r = runDispatch(fx3a.root, ['run', 'ideas/briefs/idea_01.md'], { DRY: '1' });
    assert.equal(r.rc, 2, '零票预演应退 2，实得 ' + r.rc);
    assert.ok(r.out.includes('零票'), '要点明这一轮是零票，实得：' + r.out.slice(-400));
    assert.ok(r.out.includes('别去花钱'), '要说清别去花钱');
  });
  t('DRY：命令真的在（node）→ 正常预演仍退 0', () => {
    const fx = mkFixture('dry-ok', { seats: [cliSeat('codex', 'node')], defaultBackends: ['codex'] });
    const r = runDispatch(fx.root, ['run', 'ideas/briefs/idea_01.md'], { DRY: '1' });
    assert.equal(r.rc, 0, '正常预演应退 0，实得 ' + r.rc + '；输出：' + r.out.slice(-300));
    assert.ok(r.out.includes('[dry] 将写'), '应打印预演计划');
  });

  // ── 5) 锚点检查器的 rc 分类（F2-4）：2 是尺子坏了，4 是锚点/基线不可用，1 是锚点对不上 ──
  console.log('── 5) 锚点检查器的退出码分类（F2-4）');
  const REPRO_NONUM = [
    '## 3. 关键指标',
    '| metric | 论文报告 | 我复现 | 容差 | 判定 |',
    '|---|---|---|---|---|',
    '| top1 | 76.1 |  | ±0.2 | ok |',
    '## 4. 人验收签字',
    'SIGNOFF: PASS',
    '',
  ].join('\n');
  const REPRO_NOSIGN = [
    '## 3. 关键指标',
    '| metric | 论文报告 | 我复现 | 容差 | 判定 |',
    '|---|---|---|---|---|',
    '| top1 | 76.1 | 76.0 | ±0.2 | ok |',
    '## 4. 人验收签字',
    'SIGNOFF: ________',
    '',
  ].join('\n');
  function realCheckerFixture(tag, repro, checkerTransform, fallbackKind) {
    const fx = mkFixture(tag, { defaultBackends: ['codex'], seats: [cliSeat('codex', 'node')] });
    fs.mkdirSync(path.join(fx.root, 'baselines', '_fx'), { recursive: true });
    fs.writeFileSync(path.join(fx.root, 'baselines', '_fx', 'REPRO.md'), repro);
    let src = REAL_ANCHOR_SRC !== null ? REAL_ANCHOR_SRC : checkerStub(fallbackKind);
    if (checkerTransform && REAL_ANCHOR_SRC !== null) src = checkerTransform(src);
    fs.writeFileSync(path.join(fx.root, 'dispatch', 'anchor_check.sh'), src, { mode: 0o755 });
    return fx;
  }
  t('检查器退 4（§3 无数值）→ 退 8 工单不合格，并原样引用检查器那行', () => {
    const fx = realCheckerFixture('anchor-rc4-nonum', REPRO_NONUM, null, 'rc4');
    const r = runDispatch(fx.root, ['run', 'ideas/briefs/idea_01.md']);
    assert.equal(r.rc, 8, '锚点/基线不可用应退 8，实得 ' + r.rc + '；输出：' + r.out.slice(-500));
    assert.ok(r.out.includes('没有任何数值'), '要引用检查器原文，实得：' + r.out.slice(-500));
    assert.ok(r.out.includes('检查器原话'), '要有明确的"原话"标记');
    assert.ok(r.out.includes('锚点/基线不可用'), '要说清是锚点/基线不可用，不是尺子坏了');
    assert.ok(!/自己报不可用/.test(r.out), '不许再把 rc=4 当"尺子/环境坏了"（上一轮的旧口径）');
  });
  t('检查器退 2（python 不在 PATH 的那台机器）→ 退 2，引用"找不到 python"', () => {
    const MARK = '# 尺子自身的依赖先查';
    if (REAL_ANCHOR_SRC !== null) {
      assert.ok(REAL_ANCHOR_SRC.includes(MARK), '真检查器里应有依赖检查的注释锚点');
    }
    const fx = realCheckerFixture('anchor-rc2-nopy', REPRO_NONUM, (src) => src.replace(MARK,
      'export PATH=/run-selftest-no-python   # 夹具：模拟这台机器上没有 python\n\n' + MARK), 'rc2');
    const r = runDispatch(fx.root, ['run', 'ideas/briefs/idea_01.md']);
    assert.equal(r.rc, 2, '缺依赖应退 2，实得 ' + r.rc + '；输出：' + r.out.slice(-500));
    assert.ok(r.out.includes('找不到 python'), '要引用检查器原文，实得：' + r.out.slice(-500));
    assert.ok(r.out.includes('不是锚点问题'), '检查器那句"不是锚点问题"要原样传出来');
  });
  t('检查器退 1（锚点对不上）→ 仍退 8 工单不合格', () => {
    const fx = realCheckerFixture('anchor-rc1', REPRO_NOSIGN, null, 'rc1');
    const r = runDispatch(fx.root, ['run', 'ideas/briefs/idea_01.md']);
    assert.equal(r.rc, 8, '锚点未签字应退 8，实得 ' + r.rc + '；输出：' + r.out.slice(-400));
    assert.ok(r.out.includes('锚点未通过'), '文案应仍是"锚点未通过"');
  });

  // ── 6) 卡归属（F2-5）：不属于本单的文件一个字节都不许碰 ───────────────
  console.log('── 6) 卡归属的前缀误伤（F2-5）');
  const fx5 = mkFixture('card-owner', { seats: [cliSeat('ghost', 'no-such-cli-xyz-42')], defaultBackends: ['ghost'] });
  const foreign = path.join(fx5.root, 'ideas', 'cards', 'idea_01.v2.codex.md');
  fs.writeFileSync(foreign, '<!-- meta backend=v2.codex brief=x sha=abcdef123456 model=other ts=2026-01-01T00:00:00+08:00 -->\nverdict: kill\n');
  t('只有 idea_01.v2.codex.md 时：文件原地不动', () => {
    runDispatch(fx5.root, ['run', 'ideas/briefs/idea_01.md']);
    assert.ok(fs.existsSync(foreign), '这一单的卡被另一单搬走了（前缀误伤）');
  });
  t('不产生 stale/ 条目（另一单的卡不该被隔离）', () => {
    assert.ok(!fs.existsSync(path.join(fx5.root, 'ideas', 'cards', 'stale')), 'stale/ 不该出现');
  });
  t('也不把它当成本单的票（manifest votes: none）', () => {
    const man = fs.readFileSync(path.join(fx5.root, 'ideas', 'cards', 'idea_01.manifest'), 'utf8');
    assert.ok(man.includes('votes: none'), '实得：' + firstLineOf(man, 'votes:'));
  });

  // ── 7) api 座被跳过时的座位 tag（F2-9）────────────────────────────────
  console.log('── 7) 跳过诊断的座位名（F2-9）');
  const fx9 = mkFixture('skip-tag', { seats: [apiSeat('kimi')], defaultBackends: ['kimi'] });
  t('api 座 id 不是 "api" 时：已跳过行报的是座位名 kimi', () => {
    const r = runDispatch(fx9.root, ['run', 'ideas/briefs/idea_01.md'], { API_VOTES: '1' });
    assert.ok(r.out.includes('已跳过: kimi'), '诊断应点名座位，实得：' + (firstLineOf(r.out, '已跳过') || '(没有已跳过行)'));
    assert.ok(!r.out.includes('已跳过: api'), '不许再推字面量 api');
  });

  // ── 8) require_file.on_missing（F2-12）────────────────────────────────
  console.log('── 8) require_file.on_missing（F2-12）');
  const noFile = { path: 'dispatch/no-such.patch.yml', note: '找不到 {patch}' };
  t('未声明 on_missing → 按 skip 记（缺失，不是执行失败）', () => {
    const fx = mkFixture('reqfile-skip', { seats: [cliSeat('codex', 'node', { require_file: noFile })], defaultBackends: ['codex'] });
    const r = runDispatch(fx.root, ['run', 'ideas/briefs/idea_01.md']);
    assert.equal(r.rc, 2, '零产出应退 2，实得 ' + r.rc);
    assert.ok(/缺失：.*codex/.test(r.out), '应记进"缺失"：' + firstLineOf(r.out, '本轮一票都没产出来'));
    assert.ok(!/执行失败: .*codex/.test(r.out), '不该记成执行失败');
  });
  t("on_missing: 'skip' → 与未声明一致", () => {
    const fx = mkFixture('reqfile-skip2', {
      seats: [cliSeat('codex', 'node', { require_file: { ...noFile, on_missing: 'skip' } })], defaultBackends: ['codex'],
    });
    const r = runDispatch(fx.root, ['run', 'ideas/briefs/idea_01.md']);
    assert.ok(/缺失：.*codex/.test(r.out), '应记进"缺失"');
    assert.ok(!/执行失败: .*codex/.test(r.out), '不该记成执行失败');
  });
  t("on_missing: 'fail' → 记 FAILED（执行失败），不再算作这轮没排它", () => {
    const fx = mkFixture('reqfile-fail', {
      seats: [cliSeat('codex', 'node', { require_file: { ...noFile, on_missing: 'fail' } })], defaultBackends: ['codex'],
    });
    const r = runDispatch(fx.root, ['run', 'ideas/briefs/idea_01.md']);
    assert.ok(/执行失败: .*codex/.test(r.out), '应记进执行失败，实得：' + r.out.slice(-400));
    assert.ok(r.out.includes('on_missing: fail'), '文案要点明是声明的结果');
  });

  // ── 9) 卡白名单的两条路（F2-11）──────────────────────────────────────
  console.log('── 9) 白名单：api 票序号（F2-11）');
  function apiCardFixture(tag, cardName) {
    const fx = mkFixture(tag, { seats: [apiSeat('api')], defaultBackends: ['api'] });
    const sha = crypto.createHash('sha256').update(fs.readFileSync(fx.brief)).digest('hex').slice(0, 12);
    const card = path.join(fx.root, 'ideas', 'cards', cardName);
    fs.writeFileSync(card, '<!-- meta backend=api1 brief=' + fx.brief.replace(/\\/g, '/') + ' sha=' + sha
      + ' model=fx-api-model-1 ts=2026-10-24T00:00:00+08:00 -->\nverdict: kill\n');
    return { fx, card };
  }
  t('idea_01.api1.md 被认成本单的票（api[0-9]+ 那条正则路真的在工作）', () => {
    const { fx, card } = apiCardFixture('wl-api1', 'idea_01.api1.md');
    const r = runDispatch(fx.root, ['run', 'ideas/briefs/idea_01.md'], { API_VOTES: '1' });
    assert.equal(r.rc, 1, '本轮零产出、盘上有同指纹旧卡 → 退 1，实得 ' + r.rc + '；输出：' + r.out.slice(-300));
    assert.ok(r.out.includes('ADOPTED-ONLY(1/1)'), '该票应被承认，实得：' + firstLineOf(r.out, 'ADOPTED-ONLY'));
    assert.ok(fs.existsSync(card), '卡不该被移走');
  });
  t('idea_01.apiX.md 不被认（票序号必须真的带数字）→ 移入 rejected', () => {
    const { fx } = apiCardFixture('wl-apix', 'idea_01.apiX.md');
    const r = runDispatch(fx.root, ['run', 'ideas/briefs/idea_01.md'], { API_VOTES: '1' });
    assert.ok(r.out.includes('未知后端名 apiX'), '应报未知后端名，实得：' + r.out.slice(-300));
    assert.ok(fs.existsSync(path.join(fx.root, 'ideas', 'cards', 'rejected', 'idea_01.apiX.md.unknown-seat')),
      '伪造卡应移进 rejected 留证据');
  });

  // ── 10) 锁（F2-8）：陈旧锁要能自己认出来，活锁不许动 ─────────────────
  console.log('── 10) 锁文件（F2-8）');
  const fx8 = mkFixture('lock', { seats: [cliSeat('ghost', 'no-such-cli-xyz-42')], defaultBackends: ['ghost'] });
  t('陈旧锁（pid 已不在）→ 自动清掉并接管，不当故障', () => {
    fs.writeFileSync(lockPath(fx8.root, fx8.id), '999999 ' + new Date().toISOString() + '\n');
    const r = runDispatch(fx8.root, ['run', 'ideas/briefs/idea_01.md']);
    assert.ok(r.out.includes('陈旧锁'), '要说清这是陈旧锁，实得：' + r.out.slice(0, 400));
    assert.ok(!fs.existsSync(lockPath(fx8.root, fx8.id)), '本轮结束后锁不该残留');
  });
  t('旧版空锁（读不出 pid）→ 也按陈旧锁清掉', () => {
    fs.writeFileSync(lockPath(fx8.root, fx8.id), '');
    const r = runDispatch(fx8.root, ['run', 'ideas/briefs/idea_01.md']);
    assert.ok(r.out.includes('陈旧锁'), '空锁也该被认出来');
    assert.ok(!fs.existsSync(lockPath(fx8.root, fx8.id)), '不该残留');
  });
  t('活锁（pid 还活着）→ 退 2 且不删，文案带持有者信息', () => {
    const live = lockPath(fx8.root, fx8.id);
    fs.writeFileSync(live, process.pid + ' ' + new Date().toISOString() + '\n');
    const r = runDispatch(fx8.root, ['run', 'ideas/briefs/idea_01.md']);
    assert.equal(r.rc, 2, '活锁应退 2，实得 ' + r.rc);
    assert.ok(r.out.includes('同一单已有派工在跑'), '要报"已有派工在跑"');
    assert.ok(r.out.includes('pid ' + process.pid), '要带持有者 pid，实得：' + firstLineOf(r.out, '持有者'));
    assert.ok(fs.existsSync(live), '活锁绝不能被删');
    fs.rmSync(live, { force: true });
  });
  t('SIGINT 处理器清锁：子进程退出后锁不残留', () => {
    const fx = mkFixture('sigint', { seats: [cliSeat('ghost', 'no-such-cli-xyz-42')], defaultBackends: ['ghost'] });
    const wrapper = path.join(fx.root, 'sig-child.mjs');
    fs.writeFileSync(wrapper, [
      'import { run } from ' + JSON.stringify(pathToFileURL(RUNMJS).href) + ';',
      'const mode = process.env.RUN_SELFTEST_SIG_MODE || "emit";',
      'await run({ root: process.cwd(), briefArg: "ideas/briefs/idea_01.md" });',
      // 此刻 run() 已返回，但锁要等 process 退出才删 —— 正好是信号进来那一刻的现场。
      'if (mode === "os") process.kill(process.pid, "SIGINT"); else process.emit("SIGINT");',
      'setTimeout(() => { console.error("SIGINT 没有被处理"); process.exit(7); }, 3000);',
    ].join('\n'));
    const r = spawnSync(process.execPath, [wrapper], {
      cwd: fx.root, encoding: 'utf8', env: childEnv(fx.root, { RUN_SELFTEST_SIG_MODE: 'emit' }), timeout: 60000,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 130, 'SIGINT 处理器应以 130 退出，实得 ' + r.status + '；输出：' + out.slice(-300));
    assert.ok(out.includes('收到 SIGINT'), '处理器要留下痕迹');
    assert.ok(!fs.existsSync(lockPath(fx.root, fx.id)), '锁残留了 —— 处理器没清锁');
  });
  if (process.platform !== 'win32') {
    t('SIGINT（真信号）在 POSIX 上同样清锁', () => {
      const fx = mkFixture('sigint-os', { seats: [cliSeat('ghost', 'no-such-cli-xyz-42')], defaultBackends: ['ghost'] });
      const wrapper = path.join(fx.root, 'sig-child.mjs');
      fs.writeFileSync(wrapper, [
        'import { run } from ' + JSON.stringify(pathToFileURL(RUNMJS).href) + ';',
        'await run({ root: process.cwd(), briefArg: "ideas/briefs/idea_01.md" });',
        'process.kill(process.pid, "SIGINT");',
        'setTimeout(() => { console.error("SIGINT 没有被处理"); process.exit(7); }, 3000);',
      ].join('\n'));
      const r = spawnSync(process.execPath, [wrapper], {
        cwd: fx.root, encoding: 'utf8', env: childEnv(fx.root), timeout: 60000,
      });
      assert.ok(r.status === 130 || r.signal === 'SIGINT', '真 SIGINT 应被处理器接住，实得 status=' + r.status + ' signal=' + r.signal);
      assert.ok(!fs.existsSync(lockPath(fx.root, fx.id)), '锁残留了');
    });
  } else {
    console.log('  \x1b[33m···\x1b[0m 真 SIGINT 投递在 Windows 上不可用（Node 只做 TerminateProcess，JS 处理器不跑）→ 该格跳过，靠上面的陈旧锁用例兜底');
  }
  // ── 11) paths.role_file 指错文件 ───────────────────────────────────────
  // 座位表的 role_file 写错（或工作树里缺这份角色说明）是配置错，不是"未预期异常"。
  // 旧版在 readText 处直接 ENOENT，顶层打一整段栈 + "未预期异常"，把人支去查代码。
  // 两格：① 文件不存在 ② 路径存在但是个目录（EISDIR 那一路）—— 同一口径的两种形态。
  console.log('── 11) 座位表 paths.role_file 指错文件');
  const assertRoleFileInfra = (r, roleAbs) => {
    assert.equal(r.rc, 2, '配置指错文件应退 2（基础设施），实得 ' + r.rc);
    assert.ok(r.out.includes('role_file'), '报错要点名字段 paths.role_file，实得：' + r.out.slice(0, 400));
    assert.ok(r.out.includes(roleAbs), '报错要带解析后的绝对路径 ' + roleAbs + '，实得：' + r.out.slice(0, 400));
    assert.ok(!/未预期异常/.test(r.out), '这是配置错，不许说成未预期异常');
    assert.ok(!/^[ \t]+at /m.test(r.out), '不许打印栈，实得：' + r.out.slice(0, 400));
  };
  t('① 缺 roles/reviewer.md → 退 2，报字段/绝对路径/修法，且不打栈', () => {
    const fx = mkFixture('rolefile-missing');
    const roleAbs = path.join(fx.root, 'roles', 'reviewer.md');
    fs.rmSync(roleAbs);
    const r = runDispatch(fx.root, ['run', 'ideas/briefs/idea_01.md']);
    assertRoleFileInfra(r, roleAbs);
    assert.ok(r.out.includes('文件不存在'), '文案要说清"文件不存在"，实得：' + r.out.slice(0, 400));
  });
  t('② roles/reviewer.md 是个目录（EISDIR）→ 退 2，同一条可读报错，不打栈', () => {
    const fx = mkFixture('rolefile-dir');
    const roleAbs = path.join(fx.root, 'roles', 'reviewer.md');
    fs.rmSync(roleAbs);
    fs.mkdirSync(roleAbs);
    const r = runDispatch(fx.root, ['run', 'ideas/briefs/idea_01.md']);
    assertRoleFileInfra(r, roleAbs);
    assert.ok(r.out.includes('不是普通文件'), '文案要说清"存在但不是普通文件"这层差异，实得：' + r.out.slice(0, 400));
  });
} finally {
  for (const d of TMP_ROOTS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
}

console.log();
if (fails > 0) { console.log('✗ ' + fails + '/' + checks + ' 条断言失守 —— 派工层不可信'); process.exit(1); }
console.log('全部 ' + checks + ' 条断言通过（派工层 run.mjs，零联网零模型，工作树未动）');
