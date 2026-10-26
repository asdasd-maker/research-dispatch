// 桌面向导的执行通道（P0）：把「开始科研」的一句话入口接到既有的命令行内核上。
//
// 设计铁律（与 2026-10-24 桌面化方案对齐）：
//   1. 单一执行内核——本模块只做「发起 + 汇报」，判据一律来自 dispatch/ 原脚本的
//      落盘产物；这里不重写任何门禁逻辑。
//   2. 花钱前必停——本工具只提供 classify/status/preview(DRY)/state 四类不花钱的
//      动作；真跑（扇出/发散）不进本工具，仍由人在确认预演后触发命令行或后续 job 层。
//   3. fail-closed 注册——schema 不合规就拒绝注册（实践教训：坏 schema
//      会让整个会话每轮 400 且不自愈），注册失败要喊出来，不许静默缺席。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── 仓库根：从本文件位置向上找 dispatch/seats.json；DSH_DISPATCH_ROOT 可覆盖 ──
export function findRepoRoot(from) {
  if (process.env.DSH_DISPATCH_ROOT) return path.resolve(process.env.DSH_DISPATCH_ROOT);
  let dir = from || path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'dispatch', 'seats.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// Git Bash 解析：宿主进程里没有 fanout.sh 替我们 export DSH_DISPATCH_BASH，
// 必须自己找，且要**显式排除** system32 里的 WSL 转发器（本包机制级拒绝 WSL——
// run.mjs:47 的教训在宿主侧同样成立）。候选顺序：环境变量 → 常见安装位 → PATH 探测。
let _bash = null;
export function bashBin() {
  if (_bash) return _bash;
  const cands = [
    process.env.DSH_DISPATCH_BASH,
    process.env.RESEARCH_DISPATCH_BASH,
    // 只在标准安装位探测；不写死任何特定机器的路径（旧版曾写死 E:\Git\bin\bash.exe）。
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ].filter(Boolean);
  for (const c of cands) {
    if (/system32/i.test(c)) continue;              // WSL 转发器
    if (fs.existsSync(c)) { _bash = c; return _bash; }
  }
  _bash = 'bash';                                    // 兜底与 run.mjs 口径一致
  return _bash;
}

// ── 文件夹分类：全新 / 本插件指纹 / 有科研但非本插件生成 ──
// 指纹=本链路落盘产物里的 meta 行（make_briefs/diverge/fanout 三处producer各一行）。
export function classifyFolder(rootDir) {
  const evidence = [];
  const readFirst = (p) => { try { return fs.readFileSync(p, 'utf8').split(/\r?\n/, 1)[0] || ''; } catch { return ''; } };
  const firstOf = (dir, pred) => {
    try {
      for (const f of fs.readdirSync(dir)) if (pred(f)) return path.join(dir, f);
    } catch { /* 目录不存在 */ }
    return null;
  };

  const brief = firstOf(path.join(rootDir, 'ideas', 'briefs'), (f) => f.endsWith('.md') && !f.startsWith('.'));
  if (brief && /meta role=brief/.test(readFirst(brief))) evidence.push('工单指纹 ' + path.relative(rootDir, brief));
  const mf = firstOf(path.join(rootDir, 'ideas', 'cards'), (f) => f.endsWith('.manifest'));
  if (mf && /manifest schema=/.test(readFirst(mf))) evidence.push('manifest 指纹 ' + path.relative(rootDir, mf));
  const pool = path.join(rootDir, 'papers', 'cards', '_pool.md');
  if (/meta role=diverger/.test(readFirst(pool))) evidence.push('池子指纹 papers/cards/_pool.md');
  if (fs.existsSync(path.join(rootDir, '.flow', 'state.json'))) evidence.push('流程状态 .flow/state.json');

  let klass = 'fresh';
  if (evidence.length) klass = 'ours';
  else {
    const any = ['ideas', 'papers', 'baselines', 'contract'].some((d) => {
      try { return fs.readdirSync(path.join(rootDir, d)).length > 0; } catch { return false; }
    });
    if (any) klass = 'foreign';
  }

  // ours：报「上次走到哪」——最新 manifest 的时间戳与 status（只读、不判健康）。
  let latest = null;
  try {
    const dir = path.join(rootDir, 'ideas', 'cards');
    let best = null;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.manifest')) continue;
      const p = path.join(dir, f);
      const head = readFirst(p);
      const t = (head.match(/ (\d{4}-\d{2}-\d{2}T[^ ]+)/) || [])[1] || '';
      if (!best || t > best.t) best = { t, id: f.replace(/\.manifest$/, ''), head };
    }
    if (best) latest = {
      id: best.id, when: best.t || null,
      status: (best.head.match(/ status=([^ ]+(?:\([^)]*\)[^ ]*)*) -->/) || [])[1] || null,
    };
  } catch { /* 无 cards 目录 */ }

  return { class: klass, evidence, latest };
}

// ── 执行内核：Git Bash 跑原脚本，回 rc + 输出尾 ──
export function runScript(rootDir, cmdline, { env = {}, timeoutMs = 120000, tail = 4000 } = {}) {
  return new Promise((resolve) => {
    let out = '', settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(bashBin(), ['-c', cmdline], { cwd: rootDir, windowsHide: true, env: { ...process.env, ...env } });
    } catch (e) { return done({ ok: false, reason: 'spawn-failed', detail: String(e && e.message || e) }); }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      done({ ok: false, reason: 'timeout', timeoutMs, tail: out.slice(-tail) });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, reason: 'spawn-error', detail: String(e && e.message || e) }); });
    child.on('close', (rc) => {
      clearTimeout(timer);
      done({ ok: rc === 0, rc, tail: out.slice(-tail) });
    });
  });
}

// ── 流程状态（断点续问）：.flow/state.json ──
export function statePath(rootDir) { return path.join(rootDir, '.flow', 'state.json'); }
export function readState(rootDir) {
  try { return JSON.parse(fs.readFileSync(statePath(rootDir), 'utf8')); } catch { return null; }
}
export function writeState(rootDir, mut) {
  const prev = readState(rootDir) || { version: 1, answers: {} };
  const next = { ...prev, ...mut, answers: { ...(prev.answers || {}), ...((mut && mut.answers) || {}) }, updated: new Date().toISOString() };
  fs.mkdirSync(path.join(rootDir, '.flow'), { recursive: true });
  const tmp = statePath(rootDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, statePath(rootDir));
  return next;
}

// ── 工具 schema（对象根 JSON Schema——裸 register 不编译，方言会被服务端 400）──
export const FLOW_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['classify', 'status', 'preview', 'state_get', 'state_set'], description: 'classify=判定文件夹现状（必须是第一个动作）；status=待裁决/漂移盘面；preview=DRY 免费预演；state_get/state_set=向导断点读写' },
    brief: { type: 'string', description: 'preview 用：工单路径，如 ideas/briefs/idea_01.md' },
    calibration: { type: 'boolean', description: 'preview 用：锚点未签字的冒烟轮（smoke_/calib_ 前缀工单）传 true' },
    step: { type: 'string', description: 'state_set 用：当前流程步骤标识（如 ask-direction / preview-confirm）' },
    open_question: { type: 'string', description: 'state_set 用：当前停在哪个问题上（断点）' },
    entries: { type: 'object', additionalProperties: true, description: 'state_set 用：{问题id: {answer, origin: human|default}}' },
  },
};

export function parameterShapeViolations(schema) {
  const v = [];
  if (!schema || typeof schema !== 'object') v.push('schema 必须是对象');
  else {
    if (schema.type !== 'object') v.push('type 必须是 object（对象根）');
    if (!schema.properties || typeof schema.properties !== 'object') v.push('properties 必须是对象');
    if (schema.required !== undefined && !Array.isArray(schema.required)) v.push('required 必须是数组');
  }
  return v;
}

// ── 动作分发 ──
export async function dispatchFlow(args, opts = {}) {
  const rootDir = opts.repoRoot || findRepoRoot();
  if (!rootDir) return { ok: false, reason: 'repo-root-not-found', hint: '找不到 dispatch/seats.json；可用 DSH_DISPATCH_ROOT 指定仓库根' };
  const action = args && args.action;
  try {
    if (action === 'classify') return { ok: true, action, root: rootDir, ...classifyFolder(rootDir) };
    if (action === 'status') {
      const r = await runScript(rootDir, 'bash dispatch/pending_verdicts.sh 2>&1', { timeoutMs: 120000 });
      return { ok: r.ok, action, rc: r.rc, ...(r.reason ? { reason: r.reason } : {}), report: r.tail };
    }
    if (action === 'preview') {
      if (!args.brief) return { ok: false, reason: 'brief-required', hint: 'preview 需要工单路径（ideas/briefs/<id>.md）' };
      const env = { DRY: '1' };
      if (args.calibration) env.CALIBRATION = '1';
      const r = await runScript(rootDir, 'bash dispatch/fanout.sh ' + JSON.stringify(args.brief) + ' 2>&1', { env, timeoutMs: 300000 });
      return { ok: r.ok, action, rc: r.rc, ...(r.reason ? { reason: r.reason } : {}), report: r.tail };
    }
    if (action === 'state_get') {
      const s = readState(rootDir);
      return { ok: true, action, exists: !!s, state: s };
    }
    if (action === 'state_set') {
      const state = writeState(rootDir, {
        step: typeof args.step === 'string' ? args.step : undefined,
        open_question: typeof args.open_question === 'string' ? args.open_question : undefined,
        answers: args.entries && typeof args.entries === 'object' ? args.entries : {},
      });
      return { ok: true, action, state };
    }
    return { ok: false, reason: 'invalid-action', got: String(action) };
  } catch (e) {
    return { ok: false, reason: 'flow-error', detail: String(e && e.message || e) };
  }
}

// ── 注册器：fail-closed，注册失败向上抛（由 apply 记日志+diag，不许静默缺席）──
export function registerFlowTools(scope, opts = {}) {
  const violations = parameterShapeViolations(FLOW_PARAMETERS);
  if (violations.length) throw new Error('research_dispatch schema 不合规，拒绝注册：' + violations.join('；'));
  return scope.tools.register({
    name: 'research_dispatch',
    description: '科研派工向导（research-dispatch 插件）的执行通道：classify 判定文件夹现状、status 看待裁决盘面、preview 做免费 DRY 预演、state_get/state_set 维护向导断点。只在用户说「开始科研/继续科研」或明确要求科研流程时使用；classify 必须是第一个动作；真跑扇出/发散不经过本工具（花钱动作必须先经用户确认预演后另行触发）。',
    parameters: FLOW_PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      // 2026-10-25：当前 dsh-tools 的 register() 硬性要求 output.render(args, value)，
      // 缺失即抛 "must declare output { schema, render, presentationMeta? }"，注册当场失败。
      // 同日修：宿主把 render 返回值原样当 result.content（createSuccessResult 不校验形状），
      // run_code 传输层随后对 content 调 .some()——必须返回内容块数组；返回字符串即炸
      // "content.some is not a function"（宿主侧报错，本机实测）。
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }]; },
    },
    async execute(args) { return await dispatchFlow(args, opts); },
  });
}
