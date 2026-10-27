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
import { spawn, spawnSync } from 'node:child_process';
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
//
// F1-2：兜底不再把裸名 'bash' 直接交给 spawn。'bash' 到底指谁由 PATH 决定，而
// system32\bash.exe 是 wsl.exe 的**转发器**（不是真 bash）—— 一旦它被前置到 PATH，
// spawn 出来的是 WSL，参数语义与路径全换，调用方只看到 rc=1 加一串 UTF-16 乱码。
// 现在：解析结果显式带 ok/reason/hint；解析到转发器就不拿它去跑；环境变量指错
//（不存在 / 指向转发器）也不再静默忽略，记进 warnings 供上层留痕。
const STANDARD_GIT_BASH = [
  // 只在标准安装位探测；不写死任何特定机器的路径（旧版曾写死 E:\Git\bin\bash.exe）。
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
];
const BASH_HINT = '设置环境变量 DSH_DISPATCH_BASH 指向 Git Bash 的完整路径'
  + '（例如 C:\\Program Files\\Git\\bin\\bash.exe）；或把 Git Bash 装在标准安装位，'
  + '或让 PATH 里的 bash 不是 system32 下的 WSL 转发器';

// system32 / SysWOW64 下的 bash.exe 在 Windows 上只是 WSL 的转发器，不是 Git Bash。
function isWslForwarder(p) {
  return /[\\/](?:system32|syswow64)[\\/]/i.test(String(p || ''));
}

// PATH 里按目录顺序找一个真实存在的可执行文件（exists 可注入，便于自检不起真环境）。
function findOnPath(names, env, exists) {
  const raw = String((env && (env.PATH || env.Path)) || '');
  const dirs = raw.split(process.platform === 'win32' ? ';' : ':');
  for (const d of dirs) {
    const dir = d.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      if (exists(p)) return p;
    }
  }
  return null;
}

/**
 * 解析可用的 Git Bash。返回 { ok, bin, via, warnings, reason?, detail?, hint? }。
 * ok:false 时 bin 为 null —— 调用方**不许**拿它去跑，只能把 reason/hint 交给用户。
 * opts.env / opts.exists 只为自检可注入，生产调用一律零参。
 */
export function resolveBash(opts = {}) {
  const env = opts.env || process.env;
  const exists = opts.exists || ((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const warnings = [];

  // ① 显式环境变量：指错不静默忽略，留一条痕后继续自动探测。
  for (const k of ['DSH_DISPATCH_BASH', 'RESEARCH_DISPATCH_BASH']) {
    const c = String((env && env[k]) || '').trim();
    if (!c) continue;
    if (isWslForwarder(c)) { warnings.push(k + ' 指向 WSL 转发器（' + c + '），不是 Git Bash：已忽略'); continue; }
    if (!exists(c)) { warnings.push(k + ' 指向的 bash 不存在：' + c + '（已忽略，继续自动探测）'); continue; }
    return { ok: true, bin: c, via: k, warnings };
  }

  // ② 标准安装位
  for (const c of STANDARD_GIT_BASH) {
    if (exists(c)) return { ok: true, bin: c, via: 'standard', warnings };
  }

  // ③ PATH 里的 bash —— 必须校验它是不是 WSL 转发器。
  //    是则**直接拒**：PATH 首选就是转发器说明环境本身错了，再往后猜出来的更不可信。
  const onPath = findOnPath(process.platform === 'win32' ? ['bash.exe', 'bash'] : ['bash'], env, exists);
  if (onPath) {
    if (isWslForwarder(onPath)) {
      return {
        ok: false, bin: null, via: 'path', reason: 'bash-unavailable',
        detail: 'PATH 首选 bash 是 system32 下的 WSL 转发器：' + onPath,
        hint: BASH_HINT, warnings,
      };
    }
    return { ok: true, bin: onPath, via: 'path', warnings };
  }

  // ④ 只有 git.exe 在 PATH 的机器：Git for Windows 默认只把 ...\Git\cmd 放进 PATH，
  //    那个目录里没有 bash.exe。于是从 git.exe 反推安装根，再取它自带的 bash。
  const git = findOnPath(process.platform === 'win32' ? ['git.exe', 'git'] : ['git'], env, exists);
  if (git) {
    const root = path.dirname(path.dirname(git));
    for (const rel of ['bin', 'usr/bin']) {
      const c = path.join(root, rel, process.platform === 'win32' ? 'bash.exe' : 'bash');
      if (!isWslForwarder(c) && exists(c)) return { ok: true, bin: c, via: 'git-root', warnings };
    }
  }

  return {
    ok: false, bin: null, reason: 'bash-unavailable',
    detail: '没找到可用的 Git Bash（标准安装位、PATH、git.exe 反推都落空）',
    hint: BASH_HINT, warnings,
  };
}

let _bash = null;
// 解析结果只做一次（与旧版同口径）。解析不到就返回 null —— 不许回落成裸名 'bash'。
export function bashBin() {
  if (!_bash) _bash = resolveBash();
  return _bash.ok ? _bash.bin : null;
}

// 当前解析结论（含 ok/reason/hint/warnings）：给装配期日志与 diag 一个可读的出口。
export function bashInfo() {
  if (!_bash) _bash = resolveBash();
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
  // F1-3：池子的**生产者**是 dispatch/assemble_pool.sh:82，它写的首行是
  //   <!-- _pool 由 dispatch/assemble_pool.sh 装配 · valid=… · 检索来源见各卡 meta（…） -->
  // 而 'meta role=diverger' 是 pool_io.py 写给**发散产物**的首行（旧版池子才会带）。
  // 只认后者 = 死检查：真跑过 assemble_pool 的目录照样被判 foreign。两个都认，旧的留兼容。
  const poolHead = readFirst(pool);
  if (/_pool 由 dispatch\/assemble_pool\.sh 装配/.test(poolHead) || /meta role=diverger/.test(poolHead)) {
    evidence.push('池子指纹 papers/cards/_pool.md');
  }
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

// ── 执行内核：解析出的 Git Bash 直接跑原脚本，argv 逐个传参（**不经过 shell**）──
//
// F1-1：旧版把参数拼进 `bash -c "<cmdline>"`，只用 JSON.stringify 包了层双引号 ——
// 双引号挡不住 $(...) 与反引号：preview 传 "x$(touch PWNED).md" 会真的创建 PWNED，
// 且 bash 把 argv1 静默换成 x.md 之后工具照样回 ok:true（输入被换掉却没人知道，最坏的那种）。
// 现在参数只走 argv（execve 之后没有任何一层再做展开/替换），逐字节等于传入值；
// 也因此不需要原来的 " 2>&1"（stderr 本来就是独立管道，下面并进同一个 tail）。
//
// F1-5：超时不能只 kill 掉 bash —— 它派生的孙进程（模型 CLI / sleep / touch…）还握着
// stdout 管道，调用方会一直被拖到孙进程自己退出（实测 300ms 超时拖了 6283ms），
// 而孙进程该干的活照样干完。现在整棵树回收：Windows = taskkill /T /F，
// POSIX = 负 pid（子进程按 detached 起成独立进程组）。清理失败只留痕（cleanup 字段），不抛。
export function runScript(rootDir, script, argv = [], { env = {}, timeoutMs = 120000, tail = 4000, bash = null } = {}) {
  const resolved = bash || bashInfo();
  const extra = resolved.warnings && resolved.warnings.length ? { bashWarnings: resolved.warnings } : {};
  if (!resolved.ok) {
    // F1-2：解析不到可用的 Git Bash 就**不跑**，把 reason/hint 交给调用方，
    // 而不是拿裸名 'bash' 去撞 WSL 转发器（那会回一个 rc=1 加乱码，看起来像脚本自己失败）。
    return Promise.resolve({
      ok: false, reason: resolved.reason || 'bash-unavailable',
      ...(resolved.detail ? { detail: resolved.detail } : {}),
      ...(resolved.hint ? { hint: resolved.hint } : {}),
      ...extra,
    });
  }
  return new Promise((resolve) => {
    let out = '', settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve({ ...r, ...extra });
    };
    let child;
    try {
      child = spawn(resolved.bin, [script, ...argv], {
        cwd: rootDir, windowsHide: true, env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX 下要能 kill(-pid) 收整组；Windows 用 taskkill /T，不需要新进程组。
        detached: process.platform !== 'win32',
      });
    } catch (e) { return done({ ok: false, reason: 'spawn-failed', detail: String(e && e.message || e) }); }

    const killTree = () => {
      const pid = child && child.pid;
      if (!pid) return { ok: false, detail: 'no-pid' };
      if (process.platform === 'win32') {
        try {
          const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          return { ok: r.status === 0, detail: 'taskkill /T /F rc=' + r.status + (r.error ? '（' + r.error.message + '）' : '') };
        } catch (e) { return { ok: false, detail: 'taskkill 抛错：' + String((e && e.message) || e) }; }
      }
      try { process.kill(-pid, 'SIGKILL'); return { ok: true, detail: 'kill(-' + pid + ') SIGKILL' }; }
      catch (e) {
        try { process.kill(pid, 'SIGKILL'); return { ok: true, detail: 'kill(' + pid + ') SIGKILL（进程组不可用，退化为单进程）' }; }
        catch (e2) { return { ok: false, detail: 'kill 失败：' + String((e2 && e2.message) || e2) }; }
      }
    };
    // 管道必须主动销毁 + unref：否则即使子进程死了，调用方的 event loop 仍被它挂着。
    const harvest = () => {
      try { child.stdout.destroy(); } catch { /* 已关闭 */ }
      try { child.stderr.destroy(); } catch { /* 已关闭 */ }
      try { if (typeof child.unref === 'function') child.unref(); } catch { /* 无所谓 */ }
    };

    const timer = setTimeout(() => {
      const cleanup = killTree();
      harvest();
      done({ ok: false, reason: 'timeout', timeoutMs, cleanup, tail: out.slice(-tail) });
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
  // F1-4：mut 里的 undefined **不算给了值**。旧版把未传字段写成 undefined，展开进 prev
  // 后 JSON.stringify 又把它丢掉 —— 盘上的断点被静默抹平（先写 step+open_question，
  // 再只传 entries，断点双双消失）。只有显式给出的字段才参与合并。
  const given = {};
  for (const [k, v] of Object.entries(mut || {})) if (v !== undefined) given[k] = v;
  const next = { ...prev, ...given, answers: { ...(prev.answers || {}), ...(given.answers || {}) }, updated: new Date().toISOString() };
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
  // F1-7：座位表坏掉时工具**仍然在**（注册层已按此改），只有真要用座位表/分派脚本的
  // 两个动作明确回 config-error；classify 不依赖座位表，照常可用。
  // 注意 detail 必须带**原始报错**——用户需要看到"找不到座位表 <file>"那句，而不是一句 config-error。
  const configError = opts.configError ? String(opts.configError) : '';
  if (configError && (action === 'status' || action === 'preview')) {
    return { ok: false, action, reason: 'config-error', detail: configError };
  }
  // 脚本执行结果的统一形状：没跑起来要带 reason/detail/hint，超时要带 cleanup（清理是否成功）。
  const scriptOut = (r) => ({
    ok: r.ok, rc: r.rc,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
    ...(r.hint ? { hint: r.hint } : {}),
    ...(r.cleanup ? { cleanup: r.cleanup } : {}),
    ...(r.bashWarnings ? { bashWarnings: r.bashWarnings } : {}),
    report: r.tail,
  });
  try {
    if (action === 'classify') return { ok: true, action, root: rootDir, ...classifyFolder(rootDir) };
    if (action === 'status') {
      const r = await runScript(rootDir, 'dispatch/pending_verdicts.sh', [], { timeoutMs: 120000, bash: opts.bash || null });
      return { action, ...scriptOut(r) };
    }
    if (action === 'preview') {
      if (!args.brief) return { ok: false, reason: 'brief-required', hint: 'preview 需要工单路径（ideas/briefs/<id>.md）' };
      const env = { DRY: '1' };
      if (args.calibration) env.CALIBRATION = '1';
      // 工单路径只走 argv，绝不拼进命令行（F1-1）。
      const r = await runScript(rootDir, 'dispatch/fanout.sh', [args.brief], { env, timeoutMs: 300000, bash: opts.bash || null });
      return { action, ...scriptOut(r) };
    }
    if (action === 'state_get') {
      const s = readState(rootDir);
      return { ok: true, action, exists: !!s, state: s };
    }
    if (action === 'state_set') {
      // F1-4：只有显式给出的字段进 mut —— 未传的字段不进合并，断点不会被"只改答案"抹掉。
      const mut = {};
      if (typeof args.step === 'string') mut.step = args.step;
      if (typeof args.open_question === 'string') mut.open_question = args.open_question;
      if (args.entries && typeof args.entries === 'object') mut.answers = args.entries;
      const state = writeState(rootDir, mut);
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
