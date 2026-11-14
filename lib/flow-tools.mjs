// 桌面向导与跨宿主工具通道（v2.1.0）：将科研评审流程的「分类 / Agent 发现 / 盘面扫描 / 横向总表 / 免费预演 / 状态断点」接入工具层。
//
// 设计原则：
//   1. 单一判据来源 —— 默认走纯 Node 内置实现（scanPendingVerdicts / summarizeTopic / discoverAgents / run DRY 预演）；
//      兼容仓库内显式残留旧脚本的场景。
//   2. 花钱前必停 —— 本工具仅提供 classify / agents / status / summary / preview(DRY) / state_get / state_set
//      七类免费动作；真跑扇出与发散需经用户确认后显式触发。
//   3. DSH 作用域收敛 —— 默认不读 ~/.dsh 面板 patch，仅当宿主显式传 opts.useDshPatch === true 时叠加。
//   4. fail-closed 注册 —— 工具参数 Schema 不合对象根规范时当场抛错告警，绝不静默缺席。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import * as registryMod from './registry.mjs';
import {
  loadConfig,
  discoverAgents,
  resolveExecutionPlan,
  resolveDivergePlan,
  effectiveDefaultBackends,
} from './registry.mjs';
import { scanPendingVerdicts, summarizeTopic } from './validators.mjs';

function resolveStageSafe(cfg, stageName, opts = {}) {
  if (typeof registryMod.resolveStagePlan === 'function') {
    return registryMod.resolveStagePlan(cfg, stageName, opts);
  }
  return resolveDivergePlan(cfg, opts);
}

function buildFourStageSnapshot(rootDir, seatsFileOpt, useDshPatch) {
  if (!rootDir) return { lineup: null, stages: null };
  let cfg = null;
  try {
    cfg = loadConfig(rootDir, seatsFileOpt, { useDshPatch });
  } catch {
    return { lineup: null, stages: null };
  }
  const ln = cfg.lineup || {};
  const lineup = {
    scout: ln.scout || null,
    diverge: ln.diverge || null,
    review: Array.isArray(ln.review) ? ln.review : null,
    novelty: ln.novelty || null,
    default_backends: effectiveDefaultBackends(cfg),
    require_unique_models: Boolean(cfg.policy && cfg.policy.require_unique_models === true),
  };

  const scoutPlan = resolveStageSafe(cfg, 'scout', { useDshPatch });
  const divPlan = resolveDivergePlan(cfg, { useDshPatch });
  const revPlan = resolveExecutionPlan(cfg, { useDshPatch });
  const novPlan = resolveStageSafe(cfg, 'novelty', { useDshPatch });

  const stages = {
    scout: scoutPlan.ok
      ? { seat: scoutPlan.seatId, model: scoutPlan.model || '', source: scoutPlan.source }
      : { error: scoutPlan.error },
    diverge: divPlan.ok
      ? {
          seat: divPlan.seatId,
          model: divPlan.model || '',
          count: divPlan.defaultCount ?? 10,
          use_dead_ends: divPlan.defaultUseDeadEnds !== false,
          source: divPlan.source,
        }
      : { error: divPlan.error },
    review: revPlan.ok
      ? {
          slots: revPlan.slots,
          backends: revPlan.backendList,
          source: revPlan.source,
        }
      : { error: revPlan.error, slots: [] },
    novelty: novPlan.ok
      ? { seat: novPlan.seatId, model: novPlan.model || '', source: novPlan.source }
      : { error: novPlan.error },
    require_unique_models: Boolean(cfg.policy && cfg.policy.require_unique_models === true),
  };

  return { lineup, stages };
}

// ── 仓库根探测：优先 DSH_DISPATCH_ROOT，其次从传入起点或 cwd / 包位置向上查找 dispatch/seats.json ──
export function findRepoRoot(from) {
  const envRoot = String(process.env.DSH_DISPATCH_ROOT || '').trim();
  if (envRoot) return path.resolve(envRoot);

  const walk = (start) => {
    let dir = path.resolve(start);
    for (let i = 0; i < 5; i++) {
      if (fs.existsSync(path.join(dir, 'dispatch', 'seats.json'))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return null;
  };

  if (from) return walk(from);
  return walk(process.cwd()) || walk(path.dirname(fileURLToPath(import.meta.url)));
}

const STANDARD_GIT_BASH = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
];

const BASH_HINT = '设置环境变量 DSH_DISPATCH_BASH 指向 Git Bash 的完整路径'
  + '（例如 C:\\Program Files\\Git\\bin\\bash.exe）；或安装 Git for Windows 并确保 git.exe 在 PATH 中';

// Windows 下 System32 / SysWOW64 / Sysnative / WindowsApps 中的 bash.exe 是 WSL 转发器而非 Git Bash。
function isWslForwarder(p) {
  const s = String(p || '');
  return /[\\/](?:system32|syswow64|sysnative)[\\/]/i.test(s)
    || /[\\/]windowsapps[\\/]bash\.exe$/i.test(s);
}

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
 * 步骤③扫描 PATH 时若遇到 system32 等 WSL 转发器，记录留痕并继续向后扫描 PATH，
 * 仍未命中时继续执行步骤④从 git.exe 反推 <GitRoot>/bin/bash.exe 与 usr/bin/bash.exe。
 */
export function resolveBash(opts = {}) {
  const env = opts.env || process.env;
  const exists = opts.exists || ((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const warnings = [];

  // ① 显式环境变量
  for (const k of ['DSH_DISPATCH_BASH', 'RESEARCH_DISPATCH_BASH']) {
    const c = String((env && env[k]) || '').trim();
    if (!c) continue;
    if (isWslForwarder(c)) {
      warnings.push(k + ' 指向 WSL 转发器（' + c + '），不是 Git Bash：已忽略');
      continue;
    }
    if (!exists(c)) {
      warnings.push(k + ' 指向的 bash 不存在：' + c + '（已忽略，继续自动探测）');
      continue;
    }
    return { ok: true, bin: c, via: k, warnings };
  }

  // ② 标准安装位
  for (const c of STANDARD_GIT_BASH) {
    if (exists(c)) return { ok: true, bin: c, via: 'standard', warnings };
  }

  // ③ 扫描整个 PATH，遇到 WSL 转发器时跳过继续向后探测真 Git Bash
  let skippedWsl = null;
  const rawPath = String((env && (env.PATH || env.Path)) || '');
  const pathDirs = rawPath.split(process.platform === 'win32' ? ';' : ':');
  const bashNames = process.platform === 'win32' ? ['bash.exe', 'bash'] : ['bash'];
  for (const d of pathDirs) {
    const dir = d.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    for (const n of bashNames) {
      const p = path.join(dir, n);
      if (!exists(p)) continue;
      if (isWslForwarder(p)) {
        if (!skippedWsl) skippedWsl = p;
        warnings.push('已跳过 PATH 中的 WSL 转发器：' + p);
        continue;
      }
      return { ok: true, bin: p, via: 'path', warnings };
    }
  }

  // ④ 从 PATH 中的 git.exe 反推 Git 安装根目录下的 bin/bash.exe 或 usr/bin/bash.exe
  const git = findOnPath(process.platform === 'win32' ? ['git.exe', 'git'] : ['git'], env, exists);
  if (git) {
    const root = path.dirname(path.dirname(git));
    for (const rel of ['bin', 'usr/bin']) {
      const c = path.join(root, rel, process.platform === 'win32' ? 'bash.exe' : 'bash');
      if (!isWslForwarder(c) && exists(c)) {
        return { ok: true, bin: c, via: 'git-root', warnings };
      }
    }
  }

  if (skippedWsl) {
    return {
      ok: false,
      bin: null,
      via: 'path',
      reason: 'bash-unavailable',
      detail: 'PATH 首选 bash 是 system32 下的 WSL 转发器：' + skippedWsl + '（继续扫描 PATH 与 git.exe 反推均未找到可用 Git Bash）',
      hint: BASH_HINT,
      warnings,
    };
  }

  return {
    ok: false,
    bin: null,
    reason: 'bash-unavailable',
    detail: '没找到可用的 Git Bash（标准安装位、PATH、git.exe 反推都落空）',
    hint: BASH_HINT,
    warnings,
  };
}

let _bash = null;
let _bashCacheKey = null;

function bashEnvSignature() {
  return [
    process.env.DSH_DISPATCH_BASH || '',
    process.env.RESEARCH_DISPATCH_BASH || '',
    process.env.PATH || '',
    process.env.Path || '',
  ].join('\0');
}

export function bashInfo() {
  const sig = bashEnvSignature();
  if (!_bash || _bashCacheKey !== sig) {
    _bash = resolveBash();
    _bashCacheKey = sig;
  }
  return _bash;
}

export function bashBin() {
  const info = bashInfo();
  return info.ok ? info.bin : null;
}

// ── 文件夹分类：fresh（空项目）/ ours（含本工具配置或产物）/ foreign（已有其它科研资料）──
export function classifyFolder(rootDir) {
  const evidence = [];
  const readFirst = (p) => {
    try { return fs.readFileSync(p, 'utf8').split(/\r?\n/, 1)[0] || ''; } catch { return ''; }
  };
  const firstOf = (dir, pred) => {
    try {
      for (const f of fs.readdirSync(dir)) if (pred(f)) return path.join(dir, f);
    } catch { /* 目录不存在 */ }
    return null;
  };

  if (fs.existsSync(path.join(rootDir, 'dispatch', 'seats.json'))) {
    evidence.push('座位表配置 dispatch/seats.json');
  }
  const agentsMd = path.join(rootDir, 'AGENTS.md');
  if (fs.existsSync(agentsMd)) {
    try {
      const txt = fs.readFileSync(agentsMd, 'utf8');
      if (txt.includes('research-dispatch')) {
        evidence.push('主控规程 AGENTS.md');
      }
    } catch { /* 忽略 */ }
  }

  const briefDirs = [path.join(rootDir, 'ideas', 'briefs')];
  const cardDirs = [path.join(rootDir, 'ideas', 'cards')];
  try {
    const ideasRoot = path.join(rootDir, 'ideas');
    for (const ent of fs.readdirSync(ideasRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === 'briefs' || ent.name === 'cards' || ent.name.startsWith('.')) continue;
      briefDirs.push(path.join(ideasRoot, ent.name, 'briefs'));
      cardDirs.push(path.join(ideasRoot, ent.name, 'cards'));
    }
  } catch { /* 无 ideas 目录 */ }

  for (const bd of briefDirs) {
    const brief = firstOf(bd, (f) => f.endsWith('.md') && !f.startsWith('.'));
    if (brief) {
      if (/meta role=brief/.test(readFirst(brief))) {
        evidence.push('工单指纹 ' + path.relative(rootDir, brief));
      } else {
        evidence.push('评审工单 ' + path.relative(rootDir, brief));
      }
      break;
    }
  }

  for (const cd of cardDirs) {
    const mf = firstOf(cd, (f) => f.endsWith('.manifest'));
    if (mf && /manifest schema=/.test(readFirst(mf))) {
      evidence.push('manifest 指纹 ' + path.relative(rootDir, mf));
      break;
    }
  }

  const pool = path.join(rootDir, 'papers', 'cards', '_pool.md');
  const poolHead = readFirst(pool);
  if (
    /_pool 由 .*assemble_pool/.test(poolHead)
    || /_pool assembled by|meta role=pool/.test(poolHead)
    || /meta role=diverger/.test(poolHead)
    || /^<!--\s*_pool\b/.test(poolHead)
  ) {
    evidence.push('池子指纹 papers/cards/_pool.md');
  }
  if (fs.existsSync(path.join(rootDir, '.flow', 'state.json'))) {
    evidence.push('流程状态 .flow/state.json');
  }

  let klass = 'fresh';
  if (evidence.length) {
    klass = 'ours';
  } else {
    const any = ['ideas', 'papers', 'baselines', 'contract'].some((d) => {
      try { return fs.readdirSync(path.join(rootDir, d)).length > 0; } catch { return false; }
    });
    if (any) klass = 'foreign';
  }

  let latest = null;
  let best = null;
  for (const dir of cardDirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.manifest')) continue;
        const p = path.join(dir, f);
        const head = readFirst(p);
        const t = (head.match(/ (\d{4}-\d{2}-\d{2}T[^ ]+)/) || [])[1] || '';
        const ms = t ? Date.parse(t) : NaN;
        const isBetter = !best || (
          Number.isFinite(ms) && Number.isFinite(best.ms) ? ms > best.ms : t > best.t
        );
        if (isBetter) best = { t, ms, id: f.replace(/\.manifest$/, ''), head };
      }
    } catch { /* 目录不存在 */ }
  }
  if (best) {
    latest = {
      id: best.id,
      when: best.t || null,
      status: (best.head.match(/ status=([^ ]+(?:\([^)]*\)[^ ]*)*) -->/) || [])[1] || null,
    };
  }

  return { class: klass, evidence, latest };
}

// ── 外部脚本执行内核：参数逐项经 argv 传递（不走 shell 拼接），超时整树清理，StringDecoder 防截断乱码 ──
export function runScript(rootDir, script, argv = [], { env = {}, timeoutMs = 120000, tail = 4000, bash = null } = {}) {
  const resolved = bash || bashInfo();
  const extra = resolved.warnings && resolved.warnings.length ? { bashWarnings: resolved.warnings } : {};
  if (!resolved.ok) {
    return Promise.resolve({
      ok: false,
      reason: resolved.reason || 'bash-unavailable',
      ...(resolved.detail ? { detail: resolved.detail } : {}),
      ...(resolved.hint ? { hint: resolved.hint } : {}),
      ...extra,
    });
  }
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const maxKeep = Math.max(tail * 2, 8192);
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');

    const appendOut = (chunkStr) => {
      if (!chunkStr) return;
      out += chunkStr;
      if (out.length > maxKeep) out = out.slice(-tail);
    };
    const flushDecoders = () => {
      appendOut(outDec.end());
      appendOut(errDec.end());
    };
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve({ ...r, ...extra });
    };

    let child;
    try {
      child = spawn(resolved.bin, [script, ...argv], {
        cwd: rootDir,
        windowsHide: true,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      return done({ ok: false, reason: 'spawn-failed', detail: String((e && e.message) || e) });
    }

    const killTree = () => {
      const pid = child && child.pid;
      if (!pid) return { ok: false, detail: 'no-pid' };
      if (process.platform === 'win32') {
        try {
          const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          return { ok: r.status === 0, detail: 'taskkill /T /F rc=' + r.status + (r.error ? '（' + r.error.message + '）' : '') };
        } catch (e) {
          return { ok: false, detail: 'taskkill 抛错：' + String((e && e.message) || e) };
        }
      }
      try {
        process.kill(-pid, 'SIGKILL');
        return { ok: true, detail: 'kill(-' + pid + ') SIGKILL' };
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
          return { ok: true, detail: 'kill(' + pid + ') SIGKILL（单进程退化）' };
        } catch (e2) {
          return { ok: false, detail: 'kill 失败：' + String((e2 && e2.message) || e2) };
        }
      }
    };

    const harvest = () => {
      try { child.stdout.destroy(); } catch { /* 已关闭 */ }
      try { child.stderr.destroy(); } catch { /* 已关闭 */ }
      try { if (typeof child.unref === 'function') child.unref(); } catch { /* 忽略 */ }
    };

    const timer = setTimeout(() => {
      const cleanup = killTree();
      harvest();
      flushDecoders();
      done({ ok: false, reason: 'timeout', timeoutMs, cleanup, tail: out.slice(-tail) });
    }, timeoutMs);

    child.stdout.on('data', (d) => appendOut(typeof d === 'string' ? d : outDec.write(d)));
    child.stderr.on('data', (d) => appendOut(typeof d === 'string' ? d : errDec.write(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      flushDecoders();
      done({ ok: false, reason: 'spawn-error', detail: String((e && e.message) || e) });
    });
    child.on('close', (rc) => {
      clearTimeout(timer);
      flushDecoders();
      done({ ok: rc === 0, rc, tail: out.slice(-tail) });
    });
  });
}

// ── 流程状态（断点续问）：.flow/state.json ──
export function statePath(rootDir) {
  return path.join(rootDir, '.flow', 'state.json');
}

export function readState(rootDir) {
  const p = statePath(rootDir);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error('读取流程状态失败（' + p + '）：' + ((e && e.message) || String(e)));
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    try { fs.copyFileSync(p, p + '.corrupt.' + Date.now() + '.bak'); } catch { /* 备份失败忽略 */ }
    return null;
  }
}

function writeFileAtomicSync(dest, content) {
  const tmp = dest + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(tmp, dest);
      return;
    } catch (e) {
      lastErr = e;
      if (!e || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) break;
    }
  }
  try {
    fs.copyFileSync(tmp, dest);
    fs.unlinkSync(tmp);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* 忽略清理失败 */ }
    throw lastErr;
  }
}

export function writeState(rootDir, mut) {
  const rawPrev = readState(rootDir);
  const prev = rawPrev && typeof rawPrev === 'object' && !Array.isArray(rawPrev)
    ? rawPrev
    : { version: 1, answers: {} };
  const prevAnswers = prev.answers && typeof prev.answers === 'object' && !Array.isArray(prev.answers)
    ? prev.answers
    : {};
  const given = {};
  for (const [k, v] of Object.entries(mut || {})) {
    if (v !== undefined) given[k] = v;
  }
  const next = {
    ...prev,
    ...given,
    answers: { ...prevAnswers, ...(given.answers || {}) },
    updated: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(rootDir, '.flow'), { recursive: true });
  writeFileAtomicSync(statePath(rootDir), JSON.stringify(next, null, 2) + '\n');
  return next;
}

// ── 工具参数 Schema（严格对象根 JSON Schema）──
export const FLOW_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['classify', 'agents', 'status', 'summary', 'preview', 'state_get', 'state_set'],
      description: 'classify=判定文件夹现状（首个动作）；agents=自动探测本机可用 Agent 与模型；status=待裁决/漂移盘面；summary=生成横向对比总表 _summary.md；preview=DRY 免费预演；state_get/state_set=向导断点读写',
    },
    topic: { type: 'string', description: 'status / summary 用：可选课题子目录名（如 ideas/<topic>/）' },
    brief: { type: 'string', description: 'preview 用：工单路径，如 ideas/<topic>/briefs/idea_01.md' },
    calibration: { type: 'boolean', description: 'preview 用：锚点未签字的冒烟轮（smoke_/calib_ 前缀工单）传 true' },
    step: { type: 'string', description: 'state_set 用：当前流程步骤标识（如 ask-direction / preview-confirm）' },
    open_question: { type: 'string', description: 'state_set 用：当前停在哪个问题上（断点；传空串或 null 可清空）' },
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

function parseBoolFlag(val) {
  if (val === true || val === 1) return true;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    return s === 'true' || s === '1';
  }
  return false;
}

// ── 动作分发 ──
export async function dispatchFlow(args, opts = {}) {
  const action = args && args.action;
  const useDshPatch = Boolean(opts.useDshPatch);
  const resolvedRoot = (typeof opts.getRepoRoot === 'function' ? opts.getRepoRoot() : null)
    || (typeof opts.repoRoot === 'function' ? opts.repoRoot() : opts.repoRoot)
    || findRepoRoot();
  const rootDir = resolvedRoot ? path.resolve(String(resolvedRoot)) : null;

  const seatsFileOpt = typeof opts.getSeatsFile === 'function'
    ? opts.getSeatsFile()
    : (typeof opts.seatsFile === 'function' ? opts.seatsFile() : opts.seatsFile);

  if (action === 'agents') {
    try {
      const info = discoverAgents(rootDir, { seatsFile: seatsFileOpt, useDshPatch });
      const snap = buildFourStageSnapshot(rootDir, seatsFileOpt, useDshPatch);
      return {
        ok: true,
        action,
        ...info,
        lineup: info.lineup ? { ...(snap.lineup || {}), ...info.lineup } : snap.lineup,
        stages: snap.stages,
      };
    } catch (e) {
      return { ok: false, action, reason: 'flow-error', detail: String((e && e.message) || e) };
    }
  }

  if (!rootDir) {
    return {
      ok: false,
      reason: 'repo-root-not-found',
      hint: '找不到 dispatch/seats.json；可运行 npx research-dispatch init 初始化项目，或用 DSH_DISPATCH_ROOT 指定仓库根',
    };
  }

  // 动态重检座位表：用户在面板或磁盘补齐/修复 seats.json 后无需重启宿主进程即可立即恢复。
  const checkConfigDynamically = Boolean(
    opts.configError
    || typeof opts.getRepoRoot === 'function'
    || typeof opts.repoRoot === 'function'
    || typeof opts.getSeatsFile === 'function'
    || opts.seatsFile !== undefined
    || opts.checkConfig === true
  );
  if (checkConfigDynamically && (action === 'status' || action === 'preview' || action === 'summary')) {
    try {
      loadConfig(rootDir, seatsFileOpt, { useDshPatch });
    } catch (e) {
      const detail = String((e && e.message) || opts.configError || e);
      return { ok: false, action, reason: 'config-error', detail };
    }
  }

  const scriptOut = (r) => ({
    ok: r.ok,
    rc: r.rc,
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
    ...(r.hint ? { hint: r.hint } : {}),
    ...(r.cleanup ? { cleanup: r.cleanup } : {}),
    ...(r.bashWarnings ? { bashWarnings: r.bashWarnings } : {}),
    report: r.tail,
  });

  const topicArg = typeof (args && args.topic) === 'string' && args.topic.trim() ? args.topic.trim() : null;

  try {
    if (action === 'classify') {
      return { ok: true, action, root: rootDir, ...classifyFolder(rootDir) };
    }

    if (action === 'status') {
      const stageSnap = buildFourStageSnapshot(rootDir, seatsFileOpt, useDshPatch);
      const stageFields = stageSnap.stages
        ? { lineup: stageSnap.lineup, stages: stageSnap.stages }
        : {};

      const pendingScript = path.join(rootDir, 'dispatch', 'pending_verdicts.sh');
      if (!topicArg && fs.existsSync(pendingScript) && (opts.bash || bashInfo().ok)) {
        const r = await runScript(rootDir, 'dispatch/pending_verdicts.sh', [], { timeoutMs: 120000, bash: opts.bash || null });
        if (!r.ok && r.reason) return { action, ...stageFields, ...scriptOut(r) };
        if (r.rc === 0 || r.rc === 1) {
          return {
            ok: true,
            action,
            rc: r.rc,
            has_pending: r.rc === 1,
            ...stageFields,
            ...(r.bashWarnings ? { bashWarnings: r.bashWarnings } : {}),
            report: r.tail,
          };
        }
        return { action, ...stageFields, ...scriptOut(r) };
      }

      const sv = scanPendingVerdicts(rootDir, { topic: topicArg });
      if (!sv || sv.ok === false) {
        return {
          ok: false,
          action,
          rc: sv && sv.rc !== undefined ? sv.rc : 2,
          reason: 'status-error',
          detail: (sv && (sv.stderr || sv.report)) || 'scanPendingVerdicts 执行失败',
        };
      }
      return {
        ok: true,
        action,
        ...(topicArg ? { topic: topicArg } : {}),
        rc: sv.rc,
        has_pending: sv.rc === 1,
        pendingCount: sv.pendingCount,
        buckets: sv.buckets,
        ...stageFields,
        report: sv.report,
      };
    }

    if (action === 'summary') {
      const sumRes = summarizeTopic(rootDir, { topic: topicArg, writeFile: true });
      if (!sumRes || sumRes.ok === false) {
        return {
          ok: false,
          action,
          reason: 'summary-error',
          detail: (sumRes && (sumRes.stderr || sumRes.error)) || 'summarizeTopic 执行失败',
        };
      }
      return {
        ok: true,
        action,
        ...(topicArg ? { topic: topicArg } : {}),
        outPath: sumRes.outPath || null,
        count: sumRes.count ?? 0,
        report: sumRes.markdown || '',
      };
    }

    if (action === 'preview') {
      if (typeof args.brief !== 'string' || !args.brief.trim()) {
        return { ok: false, reason: 'brief-required', hint: 'preview 需要工单路径（ideas/<topic>/briefs/<id>.md 或 ideas/briefs/<id>.md）' };
      }
      const stageSnap = buildFourStageSnapshot(rootDir, seatsFileOpt, useDshPatch);
      const stageFields = stageSnap.stages
        ? { lineup: stageSnap.lineup, stages: stageSnap.stages }
        : {};

      const isCalib = parseBoolFlag(args.calibration);
      const fanoutScript = path.join(rootDir, 'dispatch', 'fanout.sh');
      if (fs.existsSync(fanoutScript) && (opts.bash || bashInfo().ok)) {
        const env = { DRY: '1' };
        if (isCalib) env.CALIBRATION = '1';
        const r = await runScript(rootDir, 'dispatch/fanout.sh', [args.brief], { env, timeoutMs: 300000, bash: opts.bash || null });
        return { action, ...stageFields, ...scriptOut(r) };
      }

      const { run } = await import('./run.mjs');
      const captured = [];
      let rc = 2;
      try {
        rc = await run({
          root: rootDir,
          briefArg: args.brief.trim(),
          seatsFile: seatsFileOpt,
          useDshPatch,
          dry: true,
          calibration: isCalib,
          noExitCode: true,
          captureOnly: true,
          onOutput: (line) => captured.push(line),
        });
      } catch (e) {
        if (e && (e.code === 'NO_CONFIG' || e.code === 'BAD_CONFIG')) {
          return { ok: false, action, reason: 'config-error', detail: String(e.message) };
        }
        throw e;
      }
      const report = captured.join('\n').slice(-4000);
      return { action, ok: rc === 0, rc, ...stageFields, report };
    }

    if (action === 'state_get') {
      const s = readState(rootDir);
      return { ok: true, action, exists: !!s, state: s };
    }

    if (action === 'state_set') {
      const mut = {};
      if (typeof args.step === 'string') mut.step = args.step;
      if (args.open_question === null || typeof args.open_question === 'string') {
        mut.open_question = args.open_question;
      }
      if (args.entries !== undefined) {
        if (!args.entries || typeof args.entries !== 'object' || Array.isArray(args.entries)) {
          return { ok: false, action, reason: 'invalid-entries', detail: 'entries 必须是键值对象，不能是数组或原始值' };
        }
        mut.answers = args.entries;
      }
      const state = writeState(rootDir, mut);
      return { ok: true, action, state };
    }

    return { ok: false, reason: 'invalid-action', got: String(action) };
  } catch (e) {
    return { ok: false, reason: 'flow-error', detail: String((e && e.message) || e) };
  }
}

// ── 注册器：fail-closed，注册失败直接抛出以便装配层捕获留痕 ──
export function registerFlowTools(scope, opts = {}) {
  const violations = parameterShapeViolations(FLOW_PARAMETERS);
  if (violations.length) throw new Error('research_dispatch schema 不合规，拒绝注册：' + violations.join('；'));
  return scope.tools.register({
    name: 'research_dispatch',
    description: '科研派工向导（research-dispatch v2.0.0）的执行通道：classify 判定文件夹现状、agents 探测本机可用 Agent 与模型、status 扫描待裁决盘面、summary 生成横向对比总表、preview 做免费 DRY 预演、state_get/state_set 维护向导断点。classify 必须是第一个动作；真跑扇出/发散不经过本工具（花钱动作必须先经用户确认预演后另行触发）。',
    parameters: FLOW_PARAMETERS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute(args) {
      return await dispatchFlow(args, opts);
    },
  });
}
