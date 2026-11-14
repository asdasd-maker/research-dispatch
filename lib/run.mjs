// 通用全阶段多 Agent 科研派工执行引擎（v2.1.0）：
//   1. run(opts)        —— 自由多 Agent 盲审扇出、同工具多票防覆盖、可选异构门禁与 manifest 落盘
//   2. runDiverge(opts) —— 通用多 Agent 候选发散（支持 lineup 默认条数与默认 dead-ends 策略）
//   3. runScout(opts)   —— S0 文献调研真实派工、多卡切分、checkPaperCard 校验与可选自动成池
//   4. runNovelty(opts) —— S4.5 前置查重真实派工、推式单卡隔离与 checkNoveltyReport 闸门
//
// 退出码契约：
//   0 正常出票或发散落盘成功
//   1 降级轮（部分后端缺席/失败、或同指纹旧卡补票计数不等）；命令行用法错误也走 1
//   2 基础设施不可用（配置缺失/越界、一票未出、校验器不可用；或开启 require_unique_models 时预检撞同模型）
//   3 本轮作废（开启 require_unique_models 时实跑票源塌缩，或校验器内部异常）
//   8 工单或发散前置材料不合格（缺可验收基线锚点、文献池为空等）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as registryMod from './registry.mjs';
import {
  loadConfig,
  findSeat,
  seatIdentity,
  buildArgv,
  seatEnvName,
  apiModel,
  executorOverrideOf,
  seatKindOf,
  assertInside,
  resolveExecutionPlan,
  resolveDivergePlan,
  reviewModels,
  BUILT_IN_CLI_SEATS,
} from './registry.mjs';
import { normModel, modelFamily, dshLiveModel } from './models.mjs';
import { resolveBash } from './flow-tools.mjs';
import {
  checkAnchor,
  extractCardVerdict,
  checkCardFile,
  maskSecrets,
  apiChatCompletion,
} from './validators.mjs';
import {
  serializeIdeaPool,
  checkPaperCard,
  assemblePaperPool,
  checkNoveltyReport,
} from './workflow.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const BUNDLED_REVIEWER_ROLES = [
  path.join(PACKAGE_ROOT, 'examples', 'reviewer.md'),
  path.join(PACKAGE_ROOT, 'examples', 'roles', 'reviewer.md'),
];
const BUNDLED_DIVERGER_ROLES = [
  path.join(PACKAGE_ROOT, 'examples', 'roles', 'diverger.md'),
];
const BUNDLED_SCOUT_ROLES = [
  path.join(PACKAGE_ROOT, 'examples', 'roles', 'scout.md'),
];
const BUNDLED_NOVELTY_ROLES = [
  path.join(PACKAGE_ROOT, 'examples', 'roles', 'novelty.md'),
];

function resolveStage(cfg, stageName, opts = {}) {
  if (typeof registryMod.resolveStagePlan === 'function') {
    return registryMod.resolveStagePlan(cfg, stageName, opts);
  }
  return resolveDivergePlan(cfg, opts);
}

const C = { log: '\x1b[36m', skip: '\x1b[33m', fail: '\x1b[31m', off: '\x1b[0m' };

export function makeIO(root, { captureOnly = false, onOutput = null } = {}) {
  const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
  const emitOut = (colored, isErr = false) => {
    if (typeof onOutput === 'function') onOutput(stripAnsi(colored));
    if (captureOnly) return;
    if (isErr) process.stderr.write(colored + '\n');
    else process.stdout.write(colored + '\n');
  };
  return {
    root,
    log: (s) => emitOut(C.log + '== ' + s + C.off),
    skip: (s) => emitOut(C.skip + '-- ' + s + C.off),
    fail: (s) => emitOut(C.fail + '!! ' + s + C.off),
    plain: (s) => emitOut(String(s)),
    err: (s) => emitOut(String(s), true),
  };
}

function sha256File(f, len) {
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, len);
}

function isoSec() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
}

function compactStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function firstOutputLine(s) {
  const clean = String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
  return clean.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '';
}

function sanitizeMetaToken(v, fallback = '') {
  const s = String(v ?? fallback)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/-->/g, '--%3E')
    .trim()
    .replace(/\s+/g, '_');
  return s || fallback;
}

function sanitizeMetaPath(v) {
  return String(v ?? '')
    .replace(/[\r\n]+/g, '')
    .replace(/-->/g, '--%3E')
    .trim();
}

// 卡名必须是 <ID>.<座位名>.md，且座位名不含点号，防止误伤前缀相似的其它工单卡片。
function cardSeatOf(file, ID) {
  if (!file || !file.endsWith('.md')) return '';
  const pre = ID + '.';
  if (!file.startsWith(pre)) return '';
  const seat = file.slice(pre.length, -3);
  if (!seat || seat.includes('.')) return '';
  return seat;
}

function readLock(LOCK) {
  try {
    const t = fs.readFileSync(LOCK, 'utf8').trim();
    if (!t) return { pid: 0, at: 0 };
    const parts = t.split(/\s+/);
    const pid = Number(parts[0] || '');
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : 0,
      at: Date.parse(parts[1] || '') || 0,
    };
  } catch {
    return null;
  }
}

function lockOwnerText(LOCK) {
  const l = readLock(LOCK);
  if (!l) return '';
  const bits = [];
  if (l.pid) bits.push('pid ' + l.pid);
  if (l.at) bits.push('自 ' + new Date(l.at).toISOString());
  return bits.join('，');
}

function lockIsStale(LOCK, maxAgeMs) {
  const l = readLock(LOCK);
  if (!l) return '';
  if (!l.pid) return '锁里没有可读的 pid（旧版留下的空锁）';
  if (l.at && Date.now() - l.at > maxAgeMs) return '已超过 ' + Math.round(maxAgeMs / 3600000) + ' 小时未更新';
  try {
    process.kill(l.pid, 0);
  } catch (e) {
    if (e && e.code === 'ESRCH') return 'pid ' + l.pid + ' 已不在';
    return '';
  }
  return '';
}

// 进程级单次信号守卫：避免多次重入 run() 累加监听器导致 MaxListeners 泄漏，同时保证 SIGINT 清锁语义稳定。
const ACTIVE_LOCKS = new Set();
let _signalHandlersInstalled = false;

function ensureSignalHandlers() {
  if (_signalHandlersInstalled) return;
  _signalHandlersInstalled = true;
  const clearAllLocks = () => {
    for (const lk of [...ACTIVE_LOCKS]) {
      try { fs.unlinkSync(lk); } catch { /* 已不在 */ }
    }
    ACTIVE_LOCKS.clear();
  };
  process.on('exit', clearAllLocks);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      clearAllLocks();
      process.stdout.write(C.fail + '!! 收到 ' + sig + '：已清掉锁并退出（本轮作废，别把半轮当结论）' + C.off + '\n');
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
}

// 统一复用 flow-tools 的 Git Bash 解析器，绝不回落成裸名 'bash' 撞向 system32 WSL 转发器。
export function bashBin() {
  const info = resolveBash();
  return info.ok ? info.bin : null;
}

function findNativeExecutable(cmd) {
  if (!cmd) return null;
  const isWin = process.platform === 'win32';
  if (/[/\\]/.test(cmd)) {
    try { return fs.statSync(cmd).isFile() ? path.resolve(cmd) : null; } catch { return null; }
  }
  const rawPath = String(process.env.PATH || process.env.Path || '');
  const dirs = rawPath.split(isWin ? ';' : ':');
  const exts = isWin
    ? (/\.[A-Za-z0-9]+$/.test(cmd) ? [''] : ['.exe', '.cmd', '.bat', ''])
    : [''];
  for (const d of dirs) {
    const dir = d.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    for (const ext of exts) {
      const cand = path.join(dir, cmd + ext);
      if (isWin && cmd.toLowerCase() === 'bash' && /[\\/](?:system32|syswow64|sysnative)[\\/]/i.test(cand)) {
        continue;
      }
      try {
        if (fs.statSync(cand).isFile()) return cand;
      } catch { /* 继续 */ }
    }
  }
  return null;
}

export function resolveCmd(cmd) {
  if (!cmd) return null;
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(cmd)) {
    return findNativeExecutable(cmd);
  }
  const b = bashBin();
  if (b) {
    const r = spawnSync(b, ['-c', 'command -v "$1"', 'x', cmd], { encoding: 'utf8', windowsHide: true });
    const hit = !r.error && r.status === 0 ? (r.stdout || '').trim() : '';
    if (hit && !(process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(hit))) {
      return hit;
    }
  }
  return findNativeExecutable(cmd);
}

/**
 * 为 Windows `cmd.exe /d /s /c "<cmdLine>"`（配合 `windowsVerbatimArguments: true`）安全包裹单参：
 * - 可执行路径（`isExe=true`）强制用双引号包裹，免疫 `Program Files` / `My Tools (v2)` 等含空格与括号路径；
 * - 参数内双引号翻倍为 `""`（平衡 `cmd.exe` 引号状态并由 CRT 还原为单引号），`%` 拆为 `"^%"` 阻断 `%VAR%` 注入展开。
 */
export function quoteWinCmdToken(s, isExe = false) {
  const str = String(s);
  if (isExe) {
    return '"' + str.replace(/"/g, '').replace(/%/g, '"^%"') + '"';
  }
  if (str.length > 0 && !/[\s"&|<>^()%!]/.test(str)) return str;
  const inner = str
    .replace(/(\\*)"/g, '$1$1""')
    .replace(/(\\+)$/, '$1$1')
    .replace(/%/g, '"^%"');
  return '"' + inner + '"';
}

function stripTrailingNewlines(s) {
  return s.replace(/\n+$/, '');
}

export function briefForPrompt(text) {
  const noBom = text.replace(/^\uFEFF/, '');
  return noBom.split('\n').filter((l) => !/^[ \t\r]*<!-- meta role=brief[ \t\r]/.test(l)).join('\n');
}

export function buildPayload(roleText, briefText) {
  return stripTrailingNewlines(roleText) + '\n\n---\n\n' + stripTrailingNewlines(briefForPrompt(briefText)) + '\n';
}

function readText(f) {
  return fs.readFileSync(f, 'utf8');
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (!e || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) break;
    }
  }
  try {
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* 忽略清理失败 */ }
    throw lastErr;
  }
}

// 兼容 kimi --output-format stream-json（JSONL assistant 分块流）与普通纯文本 stdout 输出。
function unwrapCliBodyText(rawText) {
  const text = String(rawText ?? '');
  if (!text.trim()) return '';
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0 || !lines.every((l) => l.startsWith('{'))) {
    return text;
  }
  const parts = [];
  let sawStructuredEvent = false;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') {
        if (obj.role || obj.type) sawStructuredEvent = true;
        if (obj.role === 'assistant' && !obj.type) {
          if (typeof obj.content === 'string' && obj.content) {
            parts.push(obj.content);
          } else if (Array.isArray(obj.content)) {
            for (const blk of obj.content) {
              if (blk && blk.type === 'text' && typeof blk.text === 'string' && blk.text) {
                parts.push(blk.text);
              }
            }
          }
        } else if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
          for (const blk of obj.message.content) {
            if (blk && blk.type === 'text' && typeof blk.text === 'string' && blk.text) {
              parts.push(blk.text);
            }
          }
        }
      }
    } catch {
      return text;
    }
  }
  if (sawStructuredEvent) {
    return parts.join('\n').trim() ? (parts.join('\n').trim() + '\n') : '';
  }
  return text;
}

const CLI_TIMEOUT_MS = 15 * 60 * 1000;
const WIN_MAX_ARGV_PAYLOAD_BYTES = 24000;

function seatTimeoutMs(seat, opts) {
  const raw = (opts && opts.seatTimeoutMs) ?? (seat && seat.timeout_ms) ?? process.env.DSH_SEAT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : CLI_TIMEOUT_MS;
}

function describeSpawn(r) {
  const bits = [];
  if (r.error) bits.push('error=' + (r.error.code || r.error.message));
  if (r.signal) bits.push('signal=' + r.signal);
  bits.push('status=' + (r.status === null || r.status === undefined ? 'null' : r.status));
  return bits.join(' ');
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch { /* 忽略 */ }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 忽略 */ }
  }
}

/**
 * 异步启动子进程并在超时时整树回收（Windows `taskkill /T /F`，POSIX 进程组 `kill(-pid)`），
 * 同时确保所有打开的文件描述符在异常或结束时均安全关闭，不阻塞主事件循环、不泄露句柄。
 */
function spawnWithTimeout(bin, args, { cwd, env, stdinFile = null, stdoutFile = null, stderrFile = null, timeoutMs = CLI_TIMEOUT_MS, windowsVerbatimArguments = false } = {}) {
  const openedFds = [];
  const closeAllFds = () => {
    while (openedFds.length > 0) {
      const fd = openedFds.pop();
      try { fs.closeSync(fd); } catch { /* 忽略已关句柄 */ }
    }
  };

  let inFd = 'ignore';
  let outFd = 'inherit';
  let errFd = 'ignore';
  try {
    if (stdinFile) {
      inFd = fs.openSync(stdinFile, 'r');
      openedFds.push(inFd);
    }
    if (stdoutFile) {
      outFd = fs.openSync(stdoutFile, 'w');
      openedFds.push(outFd);
    }
    if (stderrFile) {
      errFd = fs.openSync(stderrFile, 'w');
      openedFds.push(errFd);
    }
  } catch (openErr) {
    closeAllFds();
    return Promise.resolve({ status: null, signal: null, error: openErr });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finishSpawn = (res) => {
      if (settled) return;
      settled = true;
      closeAllFds();
      resolve(res);
    };

    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: env || process.env,
        stdio: [inFd, outFd, errFd],
        windowsHide: true,
        windowsVerbatimArguments,
        detached: process.platform !== 'win32',
      });
    } catch (spawnErr) {
      return finishSpawn({ status: null, signal: null, error: spawnErr });
    }

    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      try { if (typeof child.unref === 'function') child.unref(); } catch { /* 忽略 */ }
      const timeoutErr = new Error('子进程执行超时（' + timeoutMs + 'ms）');
      timeoutErr.code = 'ETIMEDOUT';
      finishSpawn({ status: null, signal: 'SIGKILL', error: timeoutErr });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      finishSpawn({ status: null, signal: null, error: err });
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      finishSpawn({ status: code, signal: sig, error: null });
    });
  });
}

function apiVotesOf(seat) {
  if (!seat || !seat.votes) return 1;
  const envName = seat.votes.env || 'API_VOTES';
  const rawEnv = process.env[envName];
  const used = rawEnv === undefined || rawEnv === '' ? seat.votes.default : rawEnv;
  const n = Number(used);
  if (!Number.isInteger(n) || n <= 0) {
    const shown = rawEnv === undefined || rawEnv === ''
      ? '座位表 votes.default=' + JSON.stringify(seat.votes.default) + '（' + envName + ' 未设置）'
      : envName + '=' + JSON.stringify(rawEnv);
    const err = new Error('座位 ' + (seat.id || 'api') + ' 的票数配置非法：' + shown
      + ' —— 有效值是 ≥1 的整数。票数算不出来时三个票数守卫全部失效，所以停在这里'
      + '（修法：设 ' + envName + '=<正整数>，或去掉这个变量用座位表的默认值）');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return n;
}

function deriveTopicRouting(root, briefAbs, P, ID) {
  const customCardsEnv = String(process.env.CARDS_DIR || '').trim();
  const cfgCards = P.cards_dir || 'ideas/cards';
  if (!customCardsEnv && cfgCards === 'ideas/cards') {
    const rel = path.relative(root, path.resolve(briefAbs)).replace(/\\/g, '/');
    const m = rel.match(/^ideas\/([^/]+)\/briefs\/[^/]+\.md$/);
    if (m && m[1] && m[1] !== 'briefs' && m[1] !== 'cards' && m[1] !== '.' && m[1] !== '..') {
      const topicSlug = m[1];
      const topicCards = assertInside(root, 'cards_dir', 'ideas/' + topicSlug + '/cards');
      return {
        cardsRel: topicCards,
        verdictRel: 'ideas/' + topicSlug + '/verdict-' + ID + '.md',
        topic: topicSlug,
      };
    }
  }
  const chosen = assertInside(root, 'cards_dir', customCardsEnv || cfgCards);
  return {
    cardsRel: chosen,
    verdictRel: 'ideas/verdict-' + ID + '.md',
    topic: '',
  };
}

function resolveBundledFile(candidates) {
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* 继续 */ }
  }
  return '';
}

export async function run(opts = {}) {
  const { root: rawRoot, briefArg } = opts;
  const useDshPatch = Boolean(opts.useDshPatch);
  const root = path.resolve(String(rawRoot || process.cwd()));
  const origCwd = process.cwd();
  const savedEnv = new Map();
  const setScopedEnv = (key, val) => {
    if (!savedEnv.has(key)) {
      savedEnv.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    }
    process.env[key] = val;
  };
  const finish = (code) => {
    if (!opts.noExitCode) process.exitCode = code;
    return code;
  };

  // 在切换 cwd 之前预先解析可能相对于调用方目录传入的路径参数
  const resolveCallerOrRootPath = (p, preferRoot = true) => {
    if (!p) return '';
    if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return path.resolve(p);
    const fromRoot = path.resolve(root, p);
    const fromOrig = path.resolve(origCwd, p);
    if (preferRoot) {
      if (fs.existsSync(fromRoot)) return fromRoot;
      if (origCwd !== root && fs.existsSync(fromOrig)) return fromOrig;
      return fromRoot;
    }
    return origCwd !== root ? fromOrig : fromRoot;
  };

  const showPayloadRaw = process.env.SHOW_PAYLOAD_TO || '';
  const showPayloadDest = showPayloadRaw ? resolveCallerOrRootPath(showPayloadRaw, false) : '';

  const io = makeIO(root, { captureOnly: Boolean(opts.captureOnly), onOutput: opts.onOutput || null });
  const cardTmpDirs = [];
  let tmpDir = '';
  let LOCK = '';
  const releaseLock = () => {
    if (!LOCK) return;
    ACTIVE_LOCKS.delete(LOCK);
    try { fs.unlinkSync(LOCK); } catch { /* 已不在 */ }
    LOCK = '';
  };
  const mkCardTmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'card.'));
    cardTmpDirs.push(d);
    return path.join(d, 'body.md');
  };

  try {
    process.chdir(root);
    if (!process.env.DSH_PERMISSION_MODE) setScopedEnv('DSH_PERMISSION_MODE', 'read-only');
    const DRY = Boolean(opts.dry) || (process.env.DRY || '0') === '1';
    const CALIB = Boolean(opts.calibration) || process.env.CALIBRATION === '1';

    const cfg = loadConfig(root, opts.seatsFile, { useDshPatch });
    const P = cfg.paths || {};
    const WORKERS = assertInside(root, 'workers_dir', P.workers_dir || 'workers');
    const inRepoSandbox = P.sandbox_mode === 'in_repo';
    const requireUniqueModels = Boolean(
      (cfg.policy && cfg.policy.require_unique_models === true)
      || String(process.env.REQUIRE_UNIQUE_MODELS || '').trim() === '1'
    );

    let BRIEF = resolveCallerOrRootPath(briefArg, true);
    if (!BRIEF || !fs.existsSync(BRIEF) || !fs.statSync(BRIEF).isFile()) {
      io.plain('找不到 brief: ' + (BRIEF || briefArg));
      return finish(1);
    }
    BRIEF = path.resolve(BRIEF).replace(/\\/g, '/');
    const ID = path.basename(BRIEF, '.md');
    const topicRouting = deriveTopicRouting(root, BRIEF, P, ID);
    const CARDS = topicRouting.cardsRel;

    // ── 工单锚点出处与校准豁免闸门 ──────────────────────────────────────────
    const gate = anchorGate({ io, cfg, BRIEF, ID, root, CALIB });
    if (!gate.ok) return finish(gate.infra ? 2 : 8);
    const ANCHOR_TAG = gate.anchorTag;
    const warnTag = gate.warnTag;

    // ── 单工单互斥文件锁（默认不污染仓内 workers/，由每次 CLI 调用创建仓外临时目录）──
    const LOCK_STALE_MS = 6 * 60 * 60 * 1000;
    if (!DRY && !showPayloadDest) {
      ensureSignalHandlers();
      fs.mkdirSync(CARDS, { recursive: true });
      if (inRepoSandbox) fs.mkdirSync(WORKERS, { recursive: true });
      const lockFile = path.join(CARDS, ID + '.lock');
      const take = () => fs.writeFileSync(lockFile, process.pid + ' ' + isoSec() + '\n', { flag: 'wx' });
      try {
        take();
        LOCK = lockFile;
        ACTIVE_LOCKS.add(LOCK);
      } catch (lockErr) {
        if (!lockErr || lockErr.code !== 'EEXIST') {
          io.fail('无法创建派工锁文件（' + lockFile + '）：' + ((lockErr && (lockErr.code || lockErr.message)) || '文件系统错误'));
          return finish(2);
        }
        const why = lockIsStale(lockFile, LOCK_STALE_MS);
        if (!why) {
          const who = lockOwnerText(lockFile);
          io.fail('同一单已有派工在跑（锁：' + lockFile + (who ? '；持有者 ' + who : '') + '）—— 等它跑完再试');
          io.fail('  真的没人跑却卡在这里：删掉这个文件再跑（持有者已不在时，下一次运行会自动清）');
          return finish(2);
        }
        io.skip('上一轮的锁已是陈旧锁（' + why + '）→ 自动清掉并接管：' + lockFile);
        try {
          fs.unlinkSync(lockFile);
          take();
          LOCK = lockFile;
          ACTIVE_LOCKS.add(LOCK);
        } catch {
          io.fail('陈旧锁清不掉（' + lockFile + '）—— 手动删掉这个文件再跑；它不是本轮的派工，删它不会丢票');
          return finish(2);
        }
      }
    }

    // ── 评审角色提示词加载（独立轻量模式下默认 roles/reviewer.md 缺失时回退包内模板）──
    const configuredRoleFile = P.role_file || 'roles/reviewer.md';
    const roleFile = assertInside(root, 'role_file', configuredRoleFile);
    let ROLE_FILE_ABS = path.join(root, roleFile);
    let roleStat = null;
    try { roleStat = fs.statSync(ROLE_FILE_ABS); } catch { roleStat = null; }

    if (!roleStat) {
      const bundledReviewer = resolveBundledFile(BUNDLED_REVIEWER_ROLES);
      const canFallbackBundled = roleFile === 'roles/reviewer.md'
        && (P.require_anchor === false || !fs.existsSync(path.join(root, 'roles')))
        && Boolean(bundledReviewer);
      if (canFallbackBundled) {
        ROLE_FILE_ABS = bundledReviewer;
        roleStat = fs.statSync(ROLE_FILE_ABS);
        io.skip('未找到项目内 roles/reviewer.md → 自动使用包内内置评审角色模板 ' + path.relative(PACKAGE_ROOT, bundledReviewer).replace(/\\/g, '/'));
      }
    }

    if (!roleStat || !roleStat.isFile()) {
      const err = new Error('座位表 paths.role_file 指向的'
        + (roleStat ? '路径存在但不是普通文件（是个目录？）' : '文件不存在')
        + '：' + ROLE_FILE_ABS
        + ' —— 这是座位表配置指错了文件（或工作树里缺这份角色说明），不是程序异常。'
        + '修法：运行 npx research-dispatch init 补齐模板，或在 dispatch/seats.json 里把 paths.role_file 改成存在的文件');
      err.code = 'BAD_CONFIG';
      throw err;
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload.'));
    const PAYLOAD_FILE = path.join(tmpDir, 'payload.txt');
    fs.writeFileSync(PAYLOAD_FILE, buildPayload(readText(ROLE_FILE_ABS), readText(BRIEF)), 'utf8');

    const FANOUT_PAYLOAD_SHA = sha256File(PAYLOAD_FILE, 16);
    setScopedEnv('FANOUT_PAYLOAD_SHA', FANOUT_PAYLOAD_SHA);

    if (showPayloadDest) {
      try {
        fs.mkdirSync(path.dirname(showPayloadDest), { recursive: true });
        fs.copyFileSync(PAYLOAD_FILE, showPayloadDest);
      } catch {
        io.err('!! 写不了 ' + showPayloadDest);
        return finish(2);
      }
      const bytes = fs.statSync(PAYLOAD_FILE).size;
      io.plain('== payload 副本 → ' + showPayloadDest + '（' + bytes + ' 字节 sha=' + FANOUT_PAYLOAD_SHA + '）。已退出：未派工、未动盘');
      io.plain('   署名票要把这份 sha 随答案一起交回 —— 它证明你回答的就是这份字节，而不是被改软过的一版问题。');
      return finish(0);
    }

    const BSHA = sha256File(BRIEF, 12);
    const planRes = resolveExecutionPlan(cfg, { useDshPatch, reviewSpec: opts.reviewSpec });
    for (const sk of planRes.skippedVotes) {
      io.skip('面板票里的执行者 ' + sk + ' 没有对应座位，已跳过');
    }
    if (!planRes.ok) {
      io.fail(planRes.error);
      return finish(2);
    }

    const BACKENDS = planRes.backendsRaw;
    const slots = planRes.slots || [];
    const ctxBase = {
      payloadSha: FANOUT_PAYLOAD_SHA,
      workersDir: WORKERS,
      inRepoSandbox,
      payloadFile: PAYLOAD_FILE,
      tmpDir,
      seatTimeoutMs: opts.seatTimeoutMs,
      useDshPatch,
    };

    const UNKNOWN_SEEN = new Set();
    const reportUnknownBackend = (be) => {
      if (UNKNOWN_SEEN.has(be)) return;
      UNKNOWN_SEEN.add(be);
      const avail = [...new Set([...cfg.seats.map((s) => s.id), ...Object.keys(BUILT_IN_CLI_SEATS)])];
      io.fail('未知后端: ' + be + '（可选 ' + avail.join(' ') + '）');
    };

    // ── 开跑前模型先验检查（默认允许同模型自由组合，仅在 require_unique_models=true 时硬拦）──
    const PRIOR_PLAN = [];
    let N_PROVEN_PLAN = 0;
    const warnedDisabled = new Set();
    for (const slot of slots) {
      const be = slot.seat;
      const vm = slot.model || '';
      const seat = findSeat(cfg, be);
      if (seat && seat.enabled === false && !warnedDisabled.has(be)) {
        warnedDisabled.add(be);
        io.skip(be + ' 在座位表里是 enabled:false（停用）—— 因显式点名照跑；若非本意，改 dispatch/seats.json 或换座位');
      }
      if (!seat) {
        reportUnknownBackend(be);
        continue;
      }
      const rawNorm = normModel(seatIdentity(seat, { ...ctxBase, seat: be, voteModel: vm, useDshPatch }));
      PRIOR_PLAN.push(rawNorm || 'unknown-check-config');
      if (seatKindOf(seat, { useDshPatch }) === 'api') N_PROVEN_PLAN += apiVotesOf(seat);
      else N_PROVEN_PLAN += 1;
    }

    const uniq = [];
    for (const p of PRIOR_PLAN) if (!uniq.includes(p)) uniq.push(p);
    const N_UNIQ_PLAN = uniq.length;
    if (N_UNIQ_PLAN < N_PROVEN_PLAN && N_PROVEN_PLAN >= 2) {
      if (requireUniqueModels && process.env.ALLOW_DOOMED_PLAN !== '1') {
        const UNK_N = PRIOR_PLAN.filter((p) => p === 'unknown-check-config').length;
        io.plain('✗ 计划后端 ' + BACKENDS + ' 按塌缩断言的归一化只有 ' + N_UNIQ_PLAN + ' 个独立先验（ ' + PRIOR_PLAN.join(' ') + '），却要出 ' + N_PROVEN_PLAN + ' 票');
        if (UNK_N > 0) {
          const readable = PRIOR_PLAN.filter((p) => p !== 'unknown-check-config');
          const rUniq = [];
          for (const p of readable) if (!rUniq.includes(p)) rUniq.push(p);
          const rVote = N_PROVEN_PLAN - UNK_N;
          if (rUniq.length >= rVote) {
            io.plain('  其中 ' + UNK_N + ' 格配置读不出，可读部分并无同模型重复 —— 真跑会记『异构性不可证』');
            io.plain('  而不是作废；拦在开跑前是因为已开启 require_unique_models 门禁。先修配置再跑。');
          } else {
            io.plain('  其中 ' + UNK_N + ' 格配置读不出，其余格子确有同模型重复 —— require_unique_models 门禁判作废，开跑前拦截。');
          }
        } else {
          io.plain('  已开启 policy.require_unique_models 强门禁：同模型多票或跨座位同模型重复在开跑前被拦截。');
        }
        io.plain('  修法：换不同模型，或在 dispatch/seats.json 设 "require_unique_models": false（或传 ALLOW_DOOMED_PLAN=1）');
        return finish(2);
      }
      if (!requireUniqueModels) {
        const readablePriors = PRIOR_PLAN.filter((p) => p && p !== 'unknown-check-config');
        const uniqReadable = [...new Set(readablePriors)];
        if (readablePriors.length >= 2 && uniqReadable.length < readablePriors.length) {
          io.skip('共享模型提示：计划已证先验 ' + readablePriors.length + ' 票覆盖 ' + uniqReadable.length + ' 个归一化模型（' + readablePriors.join(' ') + '）—— 默认自由出票，将在 manifest 记录 shared_models');
        }
      }
    }

    // ── 陈旧卡隔离 ────────────────────────────────────────────────────────
    if (!DRY && fs.existsSync(CARDS)) {
      for (const f of fs.readdirSync(CARDS)) {
        const seat = cardSeatOf(f, ID);
        if (!seat) continue;
        quarantineStale({ io, CARDS, ID, BSHA, seat, DRY });
      }
    }

    const FAILED = [];
    const SKIPPED = [];
    let VOID = '';
    let INFRA = '';

    const cardFiles = () => {
      if (!fs.existsSync(CARDS)) return [];
      return fs.readdirSync(CARDS)
        .filter((f) => cardSeatOf(f, ID))
        .sort()
        .map((f) => path.join(CARDS, f));
    };

    const PRODUCED = [];
    const emit = (tag, bodyFile, model, declared) => {
      const safeTag = sanitizeMetaToken(tag, 'seat');
      const safeBrief = sanitizeMetaPath(BRIEF);
      const safeModel = sanitizeMetaToken(model, 'unknown-check-config');
      const safeDeclared = declared ? sanitizeMetaToken(declared) : '';
      const card = path.join(CARDS, ID + '.' + safeTag + '.md');
      if (DRY) {
        io.log('[dry] 将写 ' + card + '  model=' + safeModel + (safeDeclared ? ' declared=' + safeDeclared : ''));
        PRODUCED.push(safeTag);
        return { ok: true, code: 0 };
      }
      const head = '<!-- meta backend=' + safeTag + ' brief=' + safeBrief + ' sha=' + BSHA + ' model=' + safeModel +
        ' ts=' + isoSec() + (safeDeclared ? ' declared=' + safeDeclared : '') + ' -->\n';
      writeAtomic(card, head + readText(bodyFile));
      io.log('已写 ' + card);
      const rc = checkCard(root, P, card, ID, io);
      if (rc === 0) {
        PRODUCED.push(safeTag);
        return { ok: true, code: 0 };
      }
      if (rc === 2) {
        INFRA = 'validator-unavailable';
        try { fs.unlinkSync(card); } catch { /* 清理未验过的卡，避免残留假票 */ }
        io.fail('校验器不可用 → 不是卡的问题，按基础设施失败处理（退 2）');
        return { ok: false, code: 2, reason: 'validator-unavailable' };
      }
      if (rc !== 1) {
        VOID = 'validator-rc' + rc;
        io.fail('校验器异常（退出码 ' + rc + '），闸门坏了绝不记成\'卡不合格\' → 本轮作废');
        return { ok: false, code: 3, reason: 'validator' };
      }
      fs.mkdirSync(path.join(CARDS, 'rejected'), { recursive: true });
      fs.renameSync(card, path.join(CARDS, 'rejected', path.basename(card) + '.rejected'));
      io.fail(safeTag + ' 卡未通过校验 → 移入 ' + CARDS + '/rejected/，这一票不计数');
      return { ok: false, code: 1, reason: safeTag + '-invalid-card' };
    };

    for (const slot of slots) {
      const be = slot.seat;
      const slotTag = slot.tag || slot.seat;
      const voteModel = slot.model || '';
      const seat = findSeat(cfg, be);
      if (!seat) {
        reportUnknownBackend(be);
        FAILED.push(slotTag);
        continue;
      }
      const ov = executorOverrideOf(seat, { useDshPatch });
      const kind = seatKindOf(seat, { useDshPatch });
      if (ov && ov !== seat.kind) {
        io.skip(slotTag + ' 座的执行方式被设置面板改为 ' + ov + '（座位表里是 ' + seat.kind + '）');
      }
      if (kind === 'cli') {
        await runCliSeat({
          io, root, cfg, seat, be, slotTag, voteModel, ID, CARDS, BRIEF, PAYLOAD_FILE,
          DRY, FAILED, SKIPPED, emit, ctxBase, mkCardTmp,
        });
      } else if (kind === 'api') {
        await runApiSeat({
          io, root, cfg, seat, be, slotTag, voteModel, ID, CARDS, PAYLOAD_FILE,
          DRY, FAILED, SKIPPED, emit, ctxBase, mkCardTmp,
        });
      } else if (kind === 'delivery') {
        runDeliverySeat({
          io, seat, be, slotTag, ID, CARDS, BRIEF, DRY, FAILED, SKIPPED, emit, ctxBase,
          resolvePath: (p) => resolveCallerOrRootPath(p, true),
        });
      } else {
        io.fail('座位 ' + slotTag + ' 的 kind=' + seat.kind + ' 不认识（可选 cli / api / delivery）');
        FAILED.push(slotTag);
      }
      // 校验器不可用属基础设施级故障，立即中止后续付费座位调用止损
      if (INFRA) break;
    }

    // ── 汇总与 manifest ────────────────────────────────────────────────────
    io.plain('');
    io.log('判定汇总 ' + ID);
    const files = cardFiles();
    if (files.length > 0) {
      for (const f of files) {
        const text = readText(f);
        const ex = extractCardVerdict(text);
        if (ex.found && ex.data && ex.verdict) {
          io.plain(f + ':verdict: ' + ex.verdict);
          if (ex.data.kill_reason !== undefined && ex.data.kill_reason !== null) {
            const kr = String(ex.data.kill_reason).replace(/\r?\n/g, ' ').trim();
            io.plain(f + ':kill_reason: ' + kr);
          }
          if (ex.data.confidence !== undefined && ex.data.confidence !== null) {
            io.plain(f + ':confidence: ' + String(ex.data.confidence).trim());
          }
        } else {
          for (const line of text.split('\n')) {
            if (/^[ \t]*verdict:|^[ \t]*kill_reason:|^[ \t]*confidence:/.test(line)) {
              io.plain(f + ':' + line);
            }
          }
        }
      }
    } else {
      io.plain('  （无卡可汇总：所有后端都没成功）');
    }

    let N_EXPECTED = 0;
    for (const slot of slots) {
      const seat = findSeat(cfg, slot.seat);
      if (seat && seatKindOf(seat, { useDshPatch }) === 'api') N_EXPECTED += apiVotesOf(seat);
      else N_EXPECTED += 1;
    }

    const NO_SEAT_PLAN = N_EXPECTED === 0;
    if (NO_SEAT_PLAN) {
      io.fail('本轮没有排任何座位（计划 0 票，后端：' + (BACKENDS || '<空>') + '）'
        + ' —— 这一轮不会有人评审，也不许被读成"没人反对"');
      io.fail('  成因两种：座位表的 default_backends 是空数组，或 BACKENDS 传了空串。至少排一个座位再跑');
    }

    let EXITCODE = 0;
    let STATUS = 'OK';
    let UNIQ = 0;
    let UNKNOWN = 0;
    const VOTES = [];
    const VOTE_MODELS = [];
    const ADOPTED = [];
    const ADOPTED_SEATS = new Set();
    const ATTESTED = [];
    const SEEN_M = [];
    const PRODUCED_SET = new Set(PRODUCED);
    const whitelist = buildWhitelist(cfg, planRes.slotTags || []);

    for (const f of files) {
      let rc = 0;
      try { rc = checkCard(root, P, f, ID, io); } catch { rc = 3; }
      if (rc === 2) { INFRA = 'validator-unavailable'; continue; }
      if (rc !== 0 && rc !== 1) {
        io.fail('校验器自身异常(rc=' + rc + ')于 ' + path.basename(f) + ' → 闸门坏了绝不记成\'卡不合格\'，本轮作废');
        VOID = 'validator-rc' + rc;
        continue;
      }
      if (rc === 1) {
        if (DRY) {
          io.fail(path.basename(f) + ' 复检不合格（DRY：不移动，真跑时会移入 rejected/），不计数');
        } else {
          fs.mkdirSync(path.join(CARDS, 'rejected'), { recursive: true });
          fs.renameSync(f, path.join(CARDS, 'rejected', path.basename(f) + '.rejected'));
          io.fail(path.basename(f) + ' 复检不合格 → 移入 rejected/，不计数');
        }
        continue;
      }
      const be = path.basename(f).slice(ID.length + 1, -3);
      if (!whitelist(be)) {
        if (DRY) {
          io.fail('未知后端名 ' + be + '（DRY：不移动，真跑时会移入 rejected/），不计数');
        } else {
          fs.mkdirSync(path.join(CARDS, 'rejected'), { recursive: true });
          fs.renameSync(f, path.join(CARDS, 'rejected', path.basename(f) + '.unknown-seat'));
          io.fail('未知后端名 ' + be + ' → 移入 rejected/，这一票不计数（卡名不在白名单里 = 不是任何后端写的）');
        }
        FAILED.push(be + '-unknown-seat');
        continue;
      }
      const first = readText(f).split('\n')[0] || '';
      const m = first.match(/ model=([^ ]+) ts=/);
      const mdl = m ? m[1] : '';
      VOTES.push(be);
      VOTE_MODELS.push(be + '=' + (mdl || 'unknown-check-config'));
      if (!PRODUCED_SET.has(be)) {
        ADOPTED.push(be + (mdl ? '=' + mdl : ''));
        ADOPTED_SEATS.add(be);
      }
      if (/-manual-attested$/.test(mdl)) {
        ATTESTED.push(be + '=' + mdl);
      }
      const n = normModel(mdl || 'unknown-check-config') || 'unknown-check-config';
      if (n === 'unknown-check-config') { UNKNOWN += 1; continue; }
      if (!SEEN_M.includes(n)) { SEEN_M.push(n); UNIQ += 1; }
    }

    if (INFRA) {
      io.fail('校验器不可用（' + INFRA + '）→ 本轮票无法判定：不写 manifest、按基础设施失败退 2');
      return finish(2);
    }

    if (VOTES.length > 0) {
      if (DRY) {
        io.skip('盘上现有票 ' + VOTES.length + '（' + VOTES.join(' ') + '），独立先验 ' + UNIQ
          + ' 个：' + SEEN_M.join(' ') + ' —— DRY 预演：这些不是这一轮的票');
      } else {
        io.log('有效票 ' + VOTES.length + '（' + VOTES.join(' ') + '），独立先验 ' + UNIQ + ' 个：' + SEEN_M.join(' '));
      }
    }

    if (ADOPTED.length > 0 && !DRY) {
      io.fail('其中 ' + ADOPTED.length + ' 票不是本轮产出的（同指纹旧卡）：' + ADOPTED.join(' ')
        + ' —— 它们是这份工单的票，但不是这一次调用的产出');
    }

    if (NO_SEAT_PLAN) {
      STATUS = 'NO-OUTPUT(0/0)';
      EXITCODE = 2;
    } else if (!DRY && VOTES.length === 0) {
      io.fail('本轮一票都没产出来（计划 ' + N_EXPECTED + ' 票，后端：' + BACKENDS + '；缺失：'
        + (SKIPPED.join(' ') || '无') + ' ' + (FAILED.join(' ') || '无') + '）');
      io.fail('  → 这既不是"降级轮"，也不是"没人反对"：它等于这一轮没跑过。修好后端再重跑');
      STATUS = 'NO-OUTPUT(0/' + N_EXPECTED + ')';
      EXITCODE = 2;
    } else if (!DRY && VOTES.length < N_EXPECTED) {
      io.fail('只凑到 ' + VOTES.length + ' 票，计划 ' + N_EXPECTED + ' 票（后端：' + BACKENDS + '）（缺失：' + (SKIPPED.join(' ') || '无') + ' ' + (FAILED.join(' ') || '无') + '）');
      io.fail('  → 降级轮。少票合法，但**别把它的结论当成\'三家共识\'**，更别据此判某个 idea 无人反对');
      STATUS = 'PARTIAL(' + VOTES.length + '/' + N_EXPECTED + ')';
      if (EXITCODE === 0) EXITCODE = 1;
    } else if (!DRY && VOTES.length > N_EXPECTED) {
      io.fail('有效票 ' + VOTES.length + ' 多于计划 ' + N_EXPECTED + ' 票（后端：' + BACKENDS + '）—— 多出来的不是这一轮排的座位');
      STATUS = 'OVER-COUNT(' + VOTES.length + '>' + N_EXPECTED + ')';
      if (EXITCODE === 0) EXITCODE = 1;
    } else if (DRY && PRODUCED.length === 0) {
      io.fail('这一轮预演结果是零票（计划 ' + N_EXPECTED + ' 票，可执行座位 0 个；后端：' + BACKENDS
        + '；缺失：' + (SKIPPED.join(' ') || '无') + ' ' + (FAILED.join(' ') || '无') + '）');
      io.fail('  → 别去花钱：真跑也是这一票都出不来。先把座位表里的命令装上，或换一个座位再预演');
      STATUS = 'NO-OUTPUT(0/' + N_EXPECTED + ')';
      EXITCODE = 2;
    }

    if (!DRY && PRODUCED.length === 0 && VOTES.length > 0) {
      io.fail('本轮零产出 —— 这 ' + VOTES.length + ' 票全部来自更早一轮（同指纹旧卡），status 不按本轮通过记');
      STATUS = (STATUS === 'OK' ? '' : STATUS + '+') + 'ADOPTED-ONLY(' + VOTES.length + '/' + N_EXPECTED + ')';
      if (EXITCODE === 0) EXITCODE = 1;
    } else if (!DRY && ADOPTED.length > 0) {
      STATUS = (STATUS === 'OK' ? '' : STATUS + '+') + 'ADOPTED(' + ADOPTED.length + ')';
    }

    if (!DRY && UNKNOWN > 0) {
      io.fail('有 ' + UNKNOWN + ' 票的模型身份读不出来 → 本轮异构性【不可证】');
      io.fail('  两种成因分开查：① 某家 CLI 的配置路径变了（head -1 ' + CARDS + '/' + ID + '.*.md 看 model= 字段）');
      io.fail('  ② 代写位自报身份无配置可回读，看 meta 的 declared= 是谁自报的');
      STATUS = (STATUS === 'OK' ? '' : STATUS + '+') + 'UNPROVEN-IDENTITY(' + UNKNOWN + ')';
    }

    const PROVEN = VOTES.length - UNKNOWN;
    let sharedModelsLine = '';
    if (PROVEN >= 2 && UNIQ < PROVEN) {
      if (requireUniqueModels) {
        io.fail('票源塌缩：' + PROVEN + ' 票可证但只有 ' + UNIQ + ' 个独立先验 —— 已开启 require_unique_models，判本轮作废');
        io.fail('排查：用 DRY=1 预演 ' + (opts.briefArg || BRIEF) + ' 看各家 meta；或将 policy.require_unique_models 设为 false');
        STATUS = 'VOID(collapse ' + UNIQ + '<' + PROVEN + ')';
        if (!DRY) EXITCODE = 3;
      } else {
        sharedModelsLine = UNIQ + '/' + PROVEN + ' unique';
        if (!DRY) {
          io.skip('共享模型留痕：' + PROVEN + ' 票覆盖 ' + UNIQ + ' 个底层模型（' + SEEN_M.join(' ') + '）—— 全部真卡已保留，manifest 记录 shared_models: ' + sharedModelsLine);
        }
      }
    }

    if (!DRY && STATUS === 'OK' && VOTES.length === 1) {
      STATUS = 'OK(single-vote ' + VOTES[0] + ')';
      io.skip('本轮只有 1 票（' + VOTES[0] + '）—— status 记成 OK(single-vote)，别按共识读');
    }
    if (!DRY && VOID) {
      STATUS = 'VOID(' + VOID + ')';
      EXITCODE = 3;
    }

    if (!DRY) {
      const lines = [];
      lines.push('<!-- manifest schema=2 ' + isoSec() + ' brief=' + sanitizeMetaPath(BRIEF) + ' sha=' + BSHA + ' status=' + STATUS + ' -->');
      lines.push('votes: ' + (VOTES.join(' ') || 'none'));
      lines.push('priors: ' + (SEEN_M.join(' ') || 'none'));
      lines.push('produced: ' + (PRODUCED.join(' ') || 'none'));
      if (VOTE_MODELS.length > 0) lines.push('vote_models: ' + VOTE_MODELS.join(' '));
      if (sharedModelsLine) lines.push('shared_models: ' + sharedModelsLine);
      if (ATTESTED.length > 0) lines.push('attested: ' + ATTESTED.join(' '));
      lines.push('anchor: ' + (ANCHOR_TAG || 'none'));
      if (warnTag) lines.push('provenance: ' + warnTag);
      if (VOID) lines.push('void_reason: ' + VOID);
      for (const f of files) {
        if (!fs.existsSync(f)) continue;
        const seatLabel = path.basename(f).slice(ID.length + 1, -3);
        const text = readText(f);
        const ex = extractCardVerdict(text);
        if (ex.found && ex.verdict) {
          lines.push(seatLabel + ' → verdict: ' + ex.verdict);
        } else {
          for (const line of text.split('\n')) {
            if (/^[ \t]*verdict:/.test(line)) {
              lines.push(seatLabel + ' → ' + line.trim());
              break;
            }
          }
        }
      }
      writeAtomic(path.join(CARDS, ID + '.manifest'), lines.join('\n') + '\n');
      io.log('manifest → ' + CARDS + '/' + ID + '.manifest  status=' + STATUS);
    }

    if (/^VOID/.test(STATUS)) {
      if (DRY) {
        io.skip('DRY：盘上旧卡呈 ' + STATUS + ' —— 真跑时会把本轮冲突卡移入 rejected/*.void，预演不动盘');
      } else {
        fs.mkdirSync(path.join(CARDS, 'rejected'), { recursive: true });
        // 增量补票保护：仅隔离本轮新产出或未归入前序有效旧卡（ADOPTED_SEATS）的卡片，绝不损毁前序轮次已付费真卡。
        for (const f of files) {
          const seatLabel = path.basename(f).slice(ID.length + 1, -3);
          if (ADOPTED_SEATS.has(seatLabel)) continue;
          try { fs.renameSync(f, path.join(CARDS, 'rejected', path.basename(f) + '.void')); } catch { /* 已不在 */ }
        }
        io.fail('本轮 ' + STATUS + '：本轮冲突/异常卡片已移入 rejected/*.void，后续汇总不会误用');
      }
    }

    if (SKIPPED.length > 0) io.skip('已跳过: ' + SKIPPED.join(' '));
    if (FAILED.length > 0) {
      io.fail('执行失败: ' + FAILED.join(' ') + '   ← 真失败，必须看 .err/rejected');
      if (EXITCODE === 0) EXITCODE = 1;
    }
    io.plain('');
    io.plain('下一步：读 ' + CARDS + '/' + ID + '.manifest 与各家卡（或运行 npx research-dispatch summary' + (topicRouting.topic ? ' --topic ' + topicRouting.topic : '') + '），你自己写 ' + topicRouting.verdictRel + '（约束 2：裁决权不下放）');
    return finish(EXITCODE);
  } finally {
    releaseLock();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    for (const d of cardTmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    for (const [k, prev] of savedEnv.entries()) {
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
    try { process.chdir(origCwd); } catch { /* 忽略 */ }
  }
}

function buildWhitelist(cfg, extraSlotTags = []) {
  const exact = new Set();
  const patterns = [];

  const registerBaseSeatId = (id) => {
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return;
    exact.add(id);
    patterns.push(new RegExp('^' + id + '[0-9]+$'));
  };

  for (const s of cfg.seats) {
    if (s.seat_pattern) {
      patterns.push(new RegExp('^' + s.seat_pattern + '$'));
    } else {
      registerBaseSeatId(s.id);
    }
  }
  for (const builtInId of Object.keys(BUILT_IN_CLI_SEATS)) {
    registerBaseSeatId(builtInId);
  }
  for (const t of extraSlotTags) {
    if (t && /^[A-Za-z0-9_-]+$/.test(t)) exact.add(t);
  }
  return (be) => exact.has(be) || patterns.some((r) => r.test(be));
}

function validatorArgv(P) {
  const v = P.card_validator;
  if (Array.isArray(v) && v.length) return v.map(String);
  const s = String(v || 'python dispatch/check_card.py').trim();
  const q = s.match(/^"([^"]+)"\s*(.*)$/);
  if (q) return [q[1], ...(q[2] ? q[2].split(/\s+/) : [])];
  return s.split(/\s+/);
}

// 卡片校验器：若未显式自定义且仓内无 dispatch/check_card.py，无缝调用内置纯 Node checkCardFile；
// 若调用外部校验脚本，透传非零退出时的 stderr 诊断，帮助用户直接定位卡片问题。
function checkCard(root, P, card, expectedIdeaId, io) {
  const rawValidator = P.card_validator;
  const isDefaultValidator = !rawValidator || String(rawValidator).trim() === 'python dispatch/check_card.py';
  if (isDefaultValidator && !fs.existsSync(path.join(root, 'dispatch', 'check_card.py'))) {
    const res = checkCardFile(card, { expectedIdeaId });
    if (res.rc !== 0 && res.stderr && io) {
      for (const line of String(res.stderr).split(/\r?\n/)) {
        if (line.trim()) io.plain('   ' + line);
      }
    }
    return res.rc;
  }

  const cmd = validatorArgv(P);
  for (const seg of (cmd.length > 1 ? cmd.slice(1) : cmd)) assertInside(root, 'card_validator', seg);
  const r = spawnSync(cmd[0], [...cmd.slice(1), card, '--quiet'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.error || r.status === 126 || r.status === 127) {
    process.stderr.write('⚠ card_validator 不可用（' + (r.error ? (r.error.code || r.error.message) : 'status=' + r.status) + '）：' + cmd[0] + '\n');
    return 2;
  }
  if (r.status !== 0 && io) {
    const diagText = String(r.stderr || r.stdout || '').trim();
    if (diagText) {
      for (const line of diagText.split(/\r?\n/).slice(0, 8)) {
        if (line.trim()) io.plain('   ' + line.replace(/\x1b\[[0-9;]*m/g, ''));
      }
    }
  }
  return r.status === null ? 3 : r.status;
}

function quarantineStale({ io, CARDS, ID, BSHA, seat, DRY }) {
  const card = path.join(CARDS, ID + '.' + seat + '.md');
  if (!fs.existsSync(card)) return;
  const first = readText(card).split('\n')[0] || '';
  const m = first.match(/ sha=([0-9a-f]*) /);
  const old = m ? m[1] : '';
  if (old === BSHA) return;
  if (DRY) return;
  fs.mkdirSync(path.join(CARDS, 'stale'), { recursive: true });
  fs.renameSync(card, path.join(CARDS, 'stale', ID + '.' + seat + '.md.' + (old || 'no-sha')));
  io.skip(seat + ' 的卡 brief 指纹是 ' + (old || '<缺失>') + '、当前是 ' + BSHA + ' → 移入 cards/stale/，不混入本轮');
}

function verifyBaselineAnchor({ io, cfg, root, anchor, briefId = '', calibration = false }) {
  const configuredChecker = cfg && cfg.paths && cfg.paths.anchor_checker;
  const checker = assertInside(root, 'anchor_checker', configuredChecker || 'dispatch/anchor_check.sh');
  const checkerAbs = path.join(root, checker);
  const bBin = bashBin();

  let r;
  if (fs.existsSync(checkerAbs) && bBin) {
    r = spawnSync(bBin, [checker, anchor], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
    });
  } else if (!configuredChecker || (!fs.existsSync(checkerAbs) && checker === 'dispatch/anchor_check.sh')) {
    const builtIn = checkAnchor(root, anchor, { briefId, calibration });
    r = { error: null, status: builtIn.rc, stdout: builtIn.stdout || '', stderr: builtIn.stderr || '' };
  } else {
    r = {
      error: new Error(fs.existsSync(checkerAbs) ? '未找到可用的 Git Bash 运行 ' + checker : 'ENOENT: ' + checker),
      status: null,
      stdout: '',
      stderr: '',
    };
  }
  return { r, checker };
}

function anchorGate({ io, cfg, BRIEF, ID, root, CALIB }) {
  const firstLine = (readText(BRIEF).split('\n')[0] || '').replace(/^\uFEFF/, '').replace(/\r$/, '');
  let anchor = '';
  const am = firstLine.match(/^<!-- meta role=brief\b.*? anchor=(.*?) -->$/);
  if (am) anchor = am[1].trim();
  let warnTag = '';
  const wm = firstLine.match(/[ \t](warn=[^ ]*).* anchor=.*/);
  if (wm) warnTag = wm[1];

  // ① 优先处理 CALIBRATION=1 下的 smoke_/calib_ 冒烟工单直接豁免（早于任何外部脚本调用，无需 baselines/ 存在）
  if (CALIB && /^(smoke_|calib_)/.test(ID)) {
    const calAnchor = anchor || 'none';
    io.skip('校准轮 ' + ID + ' 的锚点未验收（' + calAnchor + '）—— CALIBRATION=1 已显式强过');
    io.plain('   这一轮的 baseline_fit 只是素材，别当共识读；痕迹已写进 manifest 的 anchor: 行。');
    return { ok: true, anchorTag: 'unverified-calibration ' + calAnchor, warnTag };
  }

  // ② 独立轻量模式判定：require_anchor===false，或仓内既无 anchor_check.sh 也无 baselines/
  const P = (cfg && cfg.paths) || {};
  const lightweightStandalone = P.require_anchor === false || (
    !fs.existsSync(path.join(root, P.anchor_checker || 'dispatch/anchor_check.sh'))
    && !fs.existsSync(path.join(root, 'baselines'))
  );
  if (!anchor && !lightweightStandalone) {
    io.fail('工单 ' + ID + ' 没有 anchor= 出处行 —— 手写 brief 不进评审');
    io.plain('   出处行由 briefs 子命令注入。正解：npx research-dispatch briefs <idea池> --baseline <锚点目录>');
    io.plain('   （若在独立项目中评审普通工单，可在 dispatch/seats.json 的 paths 段设 "require_anchor": false。）');
    return { ok: false };
  }

  const body = readText(BRIEF);
  // 终止锚仅认 ### Idea 或文件末尾；切忌用 ^#{1,2} 截断，因为 briefs 拼入的 BRIEF_BLOCK.md 常含 # / ## 标题
  const bsecMatch = body.match(/^###[ \t]*Baseline[^\n]*\n([\s\S]*?)(?=^###[ \t]*Idea\b|(?![\s\S]))/m);
  const bsec = bsecMatch ? bsecMatch[1] : '';
  if (!bsec.replace(/\s/g, '')) {
    io.fail('工单 ' + ID + ' 没带上 ### Baseline 段（anchor= 只证明尺子存在，不证明内容进来了）');
    return { ok: false };
  }
  if (!/[0-9]/.test(bsec)) {
    io.fail('工单 ' + ID + ' 的 Baseline 段没有任何数值 —— 没有数的锚点不可证伪');
    return { ok: false };
  }

  if (!anchor || anchor === 'none') {
    if (lightweightStandalone) {
      return { ok: true, anchorTag: 'none', warnTag };
    }
    io.fail('工单 ' + ID + ' 的 anchor=none 仅允许在轻量独立项目（require_anchor: false）中使用');
    return { ok: false };
  }

  const { r, checker } = verifyBaselineAnchor({ io, cfg, root, anchor, briefId: ID, calibration: CALIB });

  if (!r.error && r.status === 0) return { ok: true, anchorTag: anchor + ':signed', warnTag };

  if (r.error || r.status === 126 || r.status === 127) {
    const why = r.error ? (r.error.code || r.error.message) : ('status=' + r.status);
    io.fail('锚点检查器不可用（' + why + '）：' + checker + ' —— 不是工单的问题，是这把尺子没装上');
    const firstErr = firstOutputLine(r.stderr);
    if (firstErr) io.plain('   stderr: ' + firstErr);
    return { ok: false, infra: true };
  }

  if (/^(smoke_|calib_)/.test(ID)) {
    io.fail('校准轮 ' + ID + ' 的锚点未通过 anchor_check（' + anchor + '）—— 拒出票');
    io.plain('   要么按 baselines/TEMPLATE.REPRO.md 复现并签字，要么显式 CALIBRATION=1 承认这是无锚点校准。');
    return { ok: false };
  }

  if (r.status === 2) {
    const note = firstOutputLine(r.stderr) || firstOutputLine(r.stdout);
    io.fail('锚点检查器 anchor_check（' + anchor + '）自己报不可用（退出码 2）：' + checker
      + ' —— 是尺子/环境的问题，不是工单不合格');
    if (note) io.plain('   检查器原话: ' + note);
    io.plain('   照那句话去修环境或路径；不要重写工单，也别把这一轮当成"锚点对不上"');
    io.plain('   （CALIBRATION=1 只豁免 smoke_/calib_ 前缀的校准轮，不豁免真课题工单。）');
    return { ok: false, infra: true };
  }

  if (r.status === 4) {
    const note = firstOutputLine(r.stdout) || firstOutputLine(r.stderr);
    io.fail('工单 ' + ID + ' 的锚点/基线不可用 —— anchor_check（' + anchor + '）判它不能当锚点（退出码 4）');
    if (note) io.plain('   检查器原话: ' + note);
    io.plain('   4 与 2 是两件事：2 是尺子/环境坏了（基础设施），4 是这份锚点自身不可用。');
    io.plain('   正解：按 baselines/TEMPLATE.REPRO.md 补齐并签字；目录不存在时先查 anchor= 路径有没有写错/被空格截断。');
    io.plain('   （CALIBRATION=1 只豁免 smoke_/calib_ 前缀的校准轮，不豁免真课题工单。）');
    return { ok: false };
  }

  io.fail('工单 ' + ID + ' 的锚点未通过 anchor_check（' + anchor + '）—— 没校过的尺子进不了评审');
  io.plain('   生成路径（diverge/briefs）是同一道闸门：先按 baselines/TEMPLATE.REPRO.md 复现并签字。');
  io.plain('   （CALIBRATION=1 只豁免 smoke_/calib_ 前缀的校准轮，不豁免真课题工单。）');
  return { ok: false };
}

function keepErr(io, ok, errFile, DRY) {
  if (!fs.existsSync(errFile)) return;
  if (DRY) { try { fs.rmSync(errFile); } catch { /* 忽略 */ } return; }
  if (ok) { try { fs.rmSync(errFile); } catch { /* 忽略 */ } return; }
  const masked = maskSecrets(readText(errFile));
  const lines = masked.split('\n');
  fs.writeFileSync(errFile, lines.slice(-201).join('\n'), 'utf8');
}

export function buildDshModelOverrideFiles(tmpDir, basePatchAbs, explicitModel, slotTag = '') {
  let prov = '';
  let bareModel = explicitModel;
  const slashIdx = explicitModel.indexOf('/');
  if (slashIdx > 0) {
    prov = explicitModel.slice(0, slashIdx);
    bareModel = explicitModel.slice(slashIdx + 1);
  } else {
    const live = dshLiveModel();
    const liveSlash = live.indexOf('/');
    if (liveSlash > 0) prov = live.slice(0, liveSlash);
  }

  const suffix = slotTag ? ('-' + String(slotTag).replace(/[^A-Za-z0-9_-]/g, '_')) : '';
  const settingsLines = ['agent-default-model:'];
  if (prov) settingsLines.push('  provider: ' + JSON.stringify(prov));
  settingsLines.push('  model: ' + JSON.stringify(bareModel));
  const settingsFile = path.join(tmpDir, 'dsh-override-settings' + suffix + '.yaml');
  fs.writeFileSync(settingsFile, settingsLines.join('\n') + '\n', 'utf8');

  let patchContent = '';
  if (basePatchAbs && fs.existsSync(basePatchAbs)) {
    patchContent = fs.readFileSync(basePatchAbs, 'utf8').replace(/\s*$/, '\n');
  }
  const patchLines = [
    '- id: agent-default-model',
    '  config:',
  ];
  if (prov) patchLines.push('    provider: ' + JSON.stringify(prov));
  // 注意：dsh pi-ai 要求 agent-default-model.config.model 为不含 provider/ 前缀的裸模型 ID（bareModel）
  patchLines.push('    model: ' + JSON.stringify(bareModel));
  const patchFile = path.join(tmpDir, 'dsh-override' + suffix + '.patch.yml');
  fs.writeFileSync(patchFile, patchContent + patchLines.join('\n') + '\n', 'utf8');

  return { settingsFile, patchFile };
}

function resolveSeatModelEnvVar(seat) {
  const id = (seat && seat.identity) || {};
  if (id.explicit_env) return id.explicit_env;
  if (id.kind === 'settings') return 'DSH_MODEL';
  if (Array.isArray(seat && seat.optional_args) && seat.optional_args.length > 0 && seat.optional_args[0].env) {
    return seat.optional_args[0].env;
  }
  return '';
}

/**
 * 通用 CLI 座位单次调用（供评审 runCliSeat 与发散 runDiverge 共享）：
 * 默认在 os.tmpdir() 下创建独立空沙箱目录作为 cwd 与 {workers_dir}，彻底隔绝项目根 AGENTS.md / CLAUDE.md！
 */
async function invokeCliSeatProcess({
  root,
  seat,
  slotTag,
  voteModel,
  payloadFile,
  payloadText,
  outFile,
  errFile,
  tmpDir,
  inRepoSandbox,
  repoWorkersDir,
  DRY,
  timeoutMs,
  payloadPromptHint,
}) {
  const idKind = (seat.identity && seat.identity.kind) || 'config';
  const optPatchArg = Array.isArray(seat.optional_args)
    ? seat.optional_args.find(
        (oa) => oa && oa.env && (oa.env === 'DSH_PATCH' || (Array.isArray(oa.argv) && oa.argv.includes('--patch'))),
      )
    : null;
  const patchEnvName = seat.patch_env || (optPatchArg && optPatchArg.env) || (idKind === 'settings' ? 'DSH_PATCH' : '');
  const argvUsesPatchToken = Array.isArray(seat.argv) && seat.argv.some((tok) => String(tok).includes('{patch}'));

  let patch = '';
  if (patchEnvName || seat.patch_default) {
    patch = (patchEnvName ? process.env[patchEnvName] : '') || seat.patch_default || '';
  }
  if (seat.require_file) {
    const needRel = (seat.require_file.path || '').replace('{patch}', patch);
    const needAbs = path.isAbsolute(needRel) ? needRel : path.resolve(root, needRel);
    if (!fs.existsSync(needAbs)) {
      const how = seat.require_file.on_missing === 'fail' ? 'fail' : 'skip';
      const msg = (seat.require_file.note || '找不到 {path}').replace('{patch}', patch);
      return { outcome: how === 'fail' ? 'missing-fail' : 'missing-skip', message: msg };
    }
  }

  const resolvedCmd = resolveCmd(seat.command);
  if (!resolvedCmd) {
    return { outcome: 'not-installed' };
  }

  const childEnv = { ...process.env };
  const explicitEnv = resolveSeatModelEnvVar(seat);
  if (voteModel && explicitEnv) {
    childEnv[explicitEnv] = voteModel;
  }

  let effectivePatch = patch ? (path.isAbsolute(patch) ? patch : path.resolve(root, patch)) : '';
  if (effectivePatch && !argvUsesPatchToken && patchEnvName) {
    childEnv[patchEnvName] = effectivePatch;
  }

  const dshExplicit = idKind === 'settings'
    ? String(voteModel || process.env[explicitEnv || 'DSH_MODEL'] || seat.model_override || '').trim()
    : '';
  if (!DRY && dshExplicit && tmpDir) {
    const ovFiles = buildDshModelOverrideFiles(tmpDir, effectivePatch, dshExplicit, slotTag);
    effectivePatch = ovFiles.patchFile;
    childEnv.DSH_SETTINGS = ovFiles.settingsFile;
    if (!argvUsesPatchToken) {
      childEnv[patchEnvName || 'DSH_PATCH'] = ovFiles.patchFile;
    }
  }

  const isWinCmdScript = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(resolvedCmd);
  const drySandboxLabel = inRepoSandbox ? repoWorkersDir : path.join(os.tmpdir(), 'rd-worker-dry');

  if (DRY) {
    const dryEnv = (dshExplicit && !argvUsesPatchToken)
      ? { ...childEnv, [patchEnvName || 'DSH_PATCH']: path.join(drySandboxLabel, 'dsh-override.patch.yml') }
      : childEnv;
    const dryArgv = buildArgv(seat, {
      workersDir: drySandboxLabel,
      tmp: outFile,
      payloadText,
      patch: dshExplicit ? path.join(drySandboxLabel, 'dsh-override.patch.yml') : patch,
      env: dryEnv,
    });
    return { outcome: 'dry', argv: dryArgv };
  }

  let ephemeralRoot = '';
  let sandboxDir = '';
  if (inRepoSandbox) {
    sandboxDir = path.resolve(root, repoWorkersDir || 'workers');
    fs.mkdirSync(sandboxDir, { recursive: true });
  } else {
    ephemeralRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-worker-'));
    sandboxDir = path.join(ephemeralRoot, 'workers');
    fs.mkdirSync(sandboxDir, { recursive: true });
  }

  let effectivePayloadText = payloadText;
  let forceStdinFile = seat.payload_position === 'stdin' ? payloadFile : null;
  let sandboxPayloadFile = '';
  const needsSandboxPayload = seat.payload_position === 'argv' && (
    Buffer.byteLength(payloadText, 'utf8') > WIN_MAX_ARGV_PAYLOAD_BYTES
    || (isWinCmdScript && /[\r\n]/.test(payloadText))
  );
  if (needsSandboxPayload) {
    sandboxPayloadFile = path.join(sandboxDir, '.review_payload_' + sanitizeMetaToken(slotTag, 'seat') + '_' + process.pid + '.md');
    fs.writeFileSync(sandboxPayloadFile, payloadText, 'utf8');
    effectivePayloadText = payloadPromptHint
      ? payloadPromptHint(path.basename(sandboxPayloadFile))
      : ('请完整阅读标准输入（stdin）或当前目录文件 ' + path.basename(sandboxPayloadFile) + ' 中的角色要求与工单材料，严格按契约仅输出结果。');
    forceStdinFile = payloadFile;
  }

  const argv = buildArgv(seat, {
    workersDir: sandboxDir,
    tmp: outFile,
    payloadText: effectivePayloadText,
    patch: effectivePatch,
    env: childEnv,
  });
  if (idKind === 'settings' && effectivePatch && !argvUsesPatchToken && !argv.includes('--patch')) {
    const insertAt = argv.length > 0 ? argv.length - 1 : 0;
    argv.splice(insertAt, 0, '--patch', effectivePatch);
  }

  let spawnRes;
  try {
    const bBin = isWinCmdScript ? null : bashBin();
    if (bBin) {
      spawnRes = await spawnWithTimeout(
        bBin,
        ['-c', 'exec "$0" "$@"', seat.command, ...argv],
        {
          cwd: sandboxDir,
          env: childEnv,
          stdinFile: forceStdinFile,
          stdoutFile: seat.output === 'file' ? null : outFile,
          stderrFile: errFile,
          timeoutMs,
        },
      );
    } else if (isWinCmdScript) {
      const cmdLine = [quoteWinCmdToken(resolvedCmd, true), ...argv.map((x) => quoteWinCmdToken(x, false))].join(' ');
      spawnRes = await spawnWithTimeout(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', '"' + cmdLine + '"'],
        {
          cwd: sandboxDir,
          env: childEnv,
          stdinFile: forceStdinFile,
          stdoutFile: seat.output === 'file' ? null : outFile,
          stderrFile: errFile,
          timeoutMs,
          windowsVerbatimArguments: true,
        },
      );
    } else {
      spawnRes = await spawnWithTimeout(
        resolvedCmd,
        argv,
        {
          cwd: sandboxDir,
          env: childEnv,
          stdinFile: forceStdinFile,
          stdoutFile: seat.output === 'file' ? null : outFile,
          stderrFile: errFile,
          timeoutMs,
        },
      );
    }
  } finally {
    if (sandboxPayloadFile) {
      try { fs.unlinkSync(sandboxPayloadFile); } catch { /* 忽略 */ }
    }
    if (ephemeralRoot) {
      try { fs.rmSync(ephemeralRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
    const rawOut = readText(outFile);
    const unwrapped = unwrapCliBodyText(rawOut);
    if (unwrapped !== rawOut) {
      fs.writeFileSync(outFile, unwrapped, 'utf8');
    }
  }

  return { outcome: 'ran', spawnRes, argv };
}

async function runCliSeat(a) {
  const { io, root, seat, be, slotTag, voteModel, ID, CARDS, PAYLOAD_FILE, DRY, FAILED, SKIPPED, emit, ctxBase, mkCardTmp } = a;
  const tag = slotTag || be;
  const payloadText = readText(PAYLOAD_FILE);
  const tmp = mkCardTmp();
  const ERR = path.join(CARDS, ID + '.' + tag + '.err');
  const errFile = DRY ? path.join(path.dirname(tmp), 'dry.err') : ERR;
  const timeoutMs = seatTimeoutMs(seat, ctxBase);

  const execRes = await invokeCliSeatProcess({
    root,
    seat,
    slotTag: tag,
    voteModel,
    payloadFile: PAYLOAD_FILE,
    payloadText,
    outFile: tmp,
    errFile,
    tmpDir: ctxBase.tmpDir,
    inRepoSandbox: Boolean(ctxBase.inRepoSandbox),
    repoWorkersDir: ctxBase.workersDir,
    DRY,
    timeoutMs,
  });

  if (execRes.outcome === 'missing-fail') {
    io.fail(execRes.message + ' —— 这座声明了 on_missing: fail，缺件按执行失败记（不是"这轮没排它"）');
    FAILED.push(tag);
    return;
  }
  if (execRes.outcome === 'missing-skip') {
    io.fail(execRes.message);
    SKIPPED.push(tag);
    return;
  }
  if (execRes.outcome === 'not-installed') {
    io.skip(tag + ' 未安装');
    SKIPPED.push(tag);
    return;
  }

  const modelTag = seatIdentity(seat, { ...ctxBase, seat: be, voteModel, useDshPatch: ctxBase.useDshPatch });
  io.log(tag + ' 评审 ' + ID + (voteModel ? ' (' + voteModel + ')' : ''));
  if (execRes.outcome === 'dry') {
    io.plain('  [dry] ' + seat.command + ' ' + execRes.argv.map((x) => (x === payloadText ? '<payload>' : x)).join(' ') + ' 2> ' + ERR);
    const res = emit(tag, tmp, modelTag);
    if (!res.ok) FAILED.push(tag + '-invalid-card');
    return;
  }

  const r = execRes.spawnRes;
  const hasBody = fs.existsSync(tmp) && fs.statSync(tmp).size > 0;
  if (r.status === 0 && hasBody) {
    const res = emit(tag, tmp, modelTag);
    keepErr(io, res.ok, errFile, DRY);
    if (!res.ok) {
      if (res.code === 3) FAILED.push('validator');
      else if (res.code !== 2) FAILED.push(tag + '-invalid-card');
    }
  } else {
    io.fail(tag + ' 失败或零输出，见 ' + ERR + '（' + describeSpawn(r) + '）');
    FAILED.push(tag);
    keepErr(io, false, errFile, DRY);
  }
}

async function runApiSeat(a) {
  const { io, root, seat, be, slotTag, voteModel, ID, CARDS, PAYLOAD_FILE, DRY, FAILED, SKIPPED, emit, ctxBase, mkCardTmp } = a;
  const baseTag = slotTag || be;
  const env = process.env;
  const model = apiModel(seat, voteModel, { useDshPatch: ctxBase.useDshPatch });
  if (!model || model === 'unknown-check-config') {
    io.fail(baseTag + ' 座按 api 派工，但未配置可用模型（model / API_MODEL）—— 配置错位，不是后端失败');
    FAILED.push(baseTag + '-api-unconfigured');
    return;
  }

  const baseVar = env[seat.base_env_var || 'API_BASE_ENV'] || seat.base_env_default || 'OPENAI_BASE_URL';
  const keyVar = env[seat.key_env_var || 'API_KEY_ENV'] || seat.key_env_default || 'OPENAI_API_KEY';
  if (!env[baseVar] || !env[keyVar]) {
    io.skip(baseTag + ' 未配置（' + baseVar + ' / ' + keyVar + '）');
    SKIPPED.push(baseTag);
    return;
  }

  const votes = apiVotesOf(seat);
  const timeoutMs = seatTimeoutMs(seat, ctxBase);
  const scriptRel = seat.script ? assertInside(root, 'seat.script', seat.script) : '';
  const scriptAbs = scriptRel ? path.join(root, scriptRel) : '';
  const useExternalScript = Boolean(scriptAbs && fs.existsSync(scriptAbs));

  const tempCfg = seat.temperature && typeof seat.temperature === 'object' ? seat.temperature : null;
  const rawTemp = tempCfg ? (env[tempCfg.env || ''] ?? tempCfg.default ?? '') : '';
  const maxTokCfg = seat.max_tokens && typeof seat.max_tokens === 'object' ? seat.max_tokens : null;
  const rawMaxTok = maxTokCfg && maxTokCfg.env ? (env[maxTokCfg.env] || '') : (maxTokCfg && maxTokCfg.default ? String(maxTokCfg.default) : '');

  for (let i = 1; i <= votes; i++) {
    const tag = votes === 1 ? baseTag : (baseTag + i);
    const tmp = mkCardTmp();
    const ERR = path.join(CARDS, ID + '.' + tag + '.err');
    const errFile = DRY ? tmp + '.err' : ERR;
    io.log(baseTag + ' 评审 ' + ID + ' vote#' + i + ' (' + model + ')');

    if (DRY) {
      const viaLabel = useExternalScript ? ((seat.python || 'python') + ' ' + scriptRel) : 'apiChatCompletion(fetch)';
      io.plain('  [dry] ' + viaLabel + ' --model ' + model + ' < [reviewer + brief] > ' + CARDS + '/' + ID + '.' + tag + '.md 2> ' + ERR);
      const res = emit(tag, tmp, model);
      if (!res.ok) FAILED.push(tag + '-invalid-card');
      continue;
    }

    if (useExternalScript) {
      const argv = [
        seat.python || 'python',
        scriptRel,
        '--base-env',
        baseVar,
        '--key-env',
        keyVar,
        '--model',
        model,
        '--temperature',
        String(rawTemp !== '' ? rawTemp : '0.7'),
      ];
      if (rawMaxTok) argv.push('--max-tokens', String(rawMaxTok));
      if (seat.retries && seat.retries.env && env[seat.retries.env]) {
        argv.push('--retries', env[seat.retries.env]);
      }

      const r = await spawnWithTimeout(argv[0], argv.slice(1), {
        cwd: root,
        env: process.env,
        stdinFile: PAYLOAD_FILE,
        stdoutFile: tmp,
        stderrFile: errFile,
        timeoutMs,
      });
      const hasBody = fs.existsSync(tmp) && fs.statSync(tmp).size > 0;
      if (r.status === 0 && hasBody) {
        const res = emit(tag, tmp, model);
        keepErr(io, res.ok, errFile, DRY);
        if (!res.ok) {
          if (res.code === 2) break;
          if (res.code === 3) FAILED.push('validator');
          else FAILED.push(tag + '-invalid-card');
        }
      } else {
        io.fail(baseTag + ' vote#' + i + ' 失败或零输出，见 ' + ERR + '（' + describeSpawn(r) + '）');
        FAILED.push(tag);
        keepErr(io, false, errFile, DRY);
      }
      continue;
    }

    // 纯 Node 内置 OpenAI 兼容调用：独立安装包无需 Python 与外部脚本即可运行 API 座
    const apiRes = await apiChatCompletion({
      baseUrl: env[baseVar],
      apiKey: env[keyVar],
      model,
      payload: readText(PAYLOAD_FILE),
      timeoutMs,
      maxTokens: rawMaxTok ? Number(rawMaxTok) : 4096,
      temperature: rawTemp !== '' ? Number(rawTemp) : null,
    });
    if (apiRes.ok && apiRes.content) {
      fs.writeFileSync(tmp, apiRes.content.endsWith('\n') ? apiRes.content : apiRes.content + '\n', 'utf8');
      const res = emit(tag, tmp, model);
      keepErr(io, res.ok, errFile, DRY);
      if (!res.ok) {
        if (res.code === 2) break;
        if (res.code === 3) FAILED.push('validator');
        else FAILED.push(tag + '-invalid-card');
      }
    } else {
      fs.mkdirSync(path.dirname(errFile), { recursive: true });
      fs.writeFileSync(errFile, maskSecrets(apiRes.stderr || ('API 调用失败 rc=' + apiRes.rc + '\n')), 'utf8');
      io.fail(baseTag + ' vote#' + i + ' 失败或零输出，见 ' + ERR + '（rc=' + apiRes.rc + '）');
      FAILED.push(tag);
      keepErr(io, false, errFile, DRY);
    }
  }
}

function runDeliverySeat(a) {
  const { io, seat, be, slotTag, ID, CARDS, BRIEF, DRY, FAILED, SKIPPED, emit, ctxBase, resolvePath } = a;
  const tag = slotTag || be;
  const bodyVar = seatEnvName(seat, 'body_env', tag) || (tag.toUpperCase() + '_BODY');
  const modelVar = seatEnvName(seat, 'model_env', tag) || (tag.toUpperCase() + '_MODEL');
  const rawBody = process.env[bodyVar] || '';
  const body = rawBody && typeof resolvePath === 'function' ? resolvePath(rawBody) : rawBody;
  const declared = (process.env[modelVar] || '').trim();

  if (!declared) {
    io.fail(tag + ' 座没配 ' + modelVar + ' —— 这座的身份全靠自报，连报的是谁都没留下，不算票');
    FAILED.push(tag + '-unconfigured');
    return;
  }
  if (!rawBody || !fs.existsSync(body)) {
    io.skip(tag + ' 座待交付：先把正文（只输出 YAML，不带 meta 行）写到文件，再以 ' + bodyVar + '=<该文件> 重跑');
    SKIPPED.push(tag);
    return;
  }

  let bodyStat = null;
  try { bodyStat = fs.statSync(body); } catch { bodyStat = null; }
  if (!bodyStat || !bodyStat.isFile()) {
    io.fail(tag + ' 正文路径不是普通文件：' + rawBody);
    FAILED.push(tag + '-invalid-body');
    return;
  }

  if (bodyStat.mtimeMs < fs.statSync(BRIEF).mtimeMs) {
    io.fail(tag + ' 正文 ' + rawBody + ' 不比工单 ' + BRIEF + ' 新 → 可能是旧一版工单的正文冒充本轮的票，拒收');
    FAILED.push(tag + '-stale-body');
    return;
  }

  const idToken = seatIdentity(seat, { ...ctxBase, seat: tag, useDshPatch: ctxBase.useDshPatch });
  const how = /-manual-attested$/.test(idToken)
    ? '已绑 payload sha=' + ctxBase.payloadSha + ' → 计入先验（署名类，非配置回读）'
    : '未绑/不符 payload sha → 只算一票，不进先验';
  io.log(tag + ' 座代递票 ' + ID + '（答者：' + declared + '；' + how + '）');
  if (DRY) {
    io.plain('  [dry] wrap ' + rawBody + ' → ' + CARDS + '/' + ID + '.' + tag + '.md  model=' + idToken + ' declared=' + declared);
  }
  const hasBody = DRY || bodyStat.size > 0;
  if (!hasBody) {
    io.fail(tag + ' 正文为空 —— 空卡比没卡更危险');
    FAILED.push(tag);
    return;
  }
  const res = emit(tag, body, idToken, declared);
  if (!res.ok) {
    if (res.code === 3) FAILED.push('validator');
    else if (res.code !== 2) FAILED.push(tag + '-invalid-card');
  }
}

/**
 * 通用多 Agent 候选发散执行器（v2.0.0）：
 * 支持任意 CLI（codex / claude / dsh / gemini / kimi）或纯 Node API 座位，在仓外 os.tmpdir() 沙箱运行，
 * 自动拼装 roles/diverger.md + 文献池 _pool.md + 可选基线 BRIEF_BLOCK.md + 可选 ≤60 行 dead-ends.md（或 --no-dead-ends 纯空白模式），
 * 并通过 serializeIdeaPool 写入带溯源指纹的 ideas/<topic?>/raw-<slug>-<ts>.md。
 */
export async function runDiverge(opts = {}) {
  const root = path.resolve(String(opts.root || process.cwd()));
  const origCwd = process.cwd();
  const useDshPatch = Boolean(opts.useDshPatch);
  const io = makeIO(root, { captureOnly: Boolean(opts.captureOnly), onOutput: opts.onOutput || null });
  const finish = (code) => {
    if (!opts.noExitCode) process.exitCode = code;
    return code;
  };

  const resolveCallerOrRootPath = (p) => {
    if (!p) return '';
    if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return path.resolve(p);
    const fromRoot = path.resolve(root, p);
    const fromOrig = path.resolve(origCwd, p);
    if (fs.existsSync(fromRoot)) return fromRoot;
    if (origCwd !== root && fs.existsSync(fromOrig)) return fromOrig;
    return fromRoot;
  };

  const direction = String(opts.direction || '').trim();
  if (!direction) {
    io.err('用法: dispatch.mjs diverge <方向描述> [条数=10] [--topic <slug>] [--baseline <dir>] [--pool <file>] [--dead-ends <file> | --no-dead-ends] [--agent <seat[:model]>] [--dry]');
    return finish(1);
  }

  const hasExplicitCount = opts.count !== undefined && opts.count !== null && opts.count !== '';
  const explicitCount = hasExplicitCount ? Number(opts.count) : null;
  if (hasExplicitCount && (!Number.isInteger(explicitCount) || explicitCount < 1 || explicitCount > 50)) {
    io.err('!! 发散条数必须是 1..50 的整数，实得：' + JSON.stringify(opts.count));
    return finish(1);
  }

  const rawTopic = opts.topic !== undefined && opts.topic !== null ? String(opts.topic).trim() : '';
  if (rawTopic && (!/^[A-Za-z0-9._-]+$/.test(rawTopic) || rawTopic === '.' || rawTopic === '..')) {
    io.err('!! --topic 课题名非法（仅允许字母、数字、点、下划线与连字符）：' + JSON.stringify(rawTopic));
    return finish(1);
  }

  const explicitNoDeadEnds = Boolean(opts.noDeadEnds) || String(process.env.NO_DEAD_ENDS || '').trim() === '1';
  const hasExplicitDeadEnds = opts.deadEndsFile !== undefined && opts.deadEndsFile !== null && String(opts.deadEndsFile).trim() !== '';
  if (explicitNoDeadEnds && hasExplicitDeadEnds) {
    io.err('!! --no-dead-ends 与 --dead-ends 不能同时指定（前者启用纯空白发散模式，后者显式挂载死胡同文件）');
    return finish(1);
  }

  const DRY = Boolean(opts.dry) || (process.env.DRY || '0') === '1';
  let tmpDir = '';

  try {
    process.chdir(root);
    const cfg = loadConfig(root, opts.seatsFile, { useDshPatch });
    const P = cfg.paths || {};
    const WORKERS = assertInside(root, 'workers_dir', P.workers_dir || 'workers');
    const inRepoSandbox = P.sandbox_mode === 'in_repo';

    // 1) 文献池校验
    const poolArg = opts.poolFile || process.env.INPUT || 'papers/cards/_pool.md';
    const poolAbs = resolveCallerOrRootPath(poolArg);
    assertInside(root, 'pool', path.relative(root, poolAbs));
    if (!fs.existsSync(poolAbs) || !fs.statSync(poolAbs).isFile()) {
      io.fail('找不到文献池文件 ' + poolArg + '（请先运行 npx research-dispatch pool 汇总文献卡）');
      return finish(1);
    }
    const poolText = readText(poolAbs);
    if (!poolText.replace(/\s+/g, '')) {
      io.fail('文献池 ' + poolArg + ' 为空（0 字节有效内容），拒绝盲目发散');
      return finish(8);
    }
    const poolRel = path.relative(root, poolAbs).replace(/\\/g, '/');

    // 2) 可选基线锚点校验
    const rawBaseline = opts.noBaseline ? '' : String(opts.baselineDir || process.env.BASELINE || '').trim();
    let baselineLabel = 'none';
    let bsha = 'none';
    let briefBlockText = '';
    if (rawBaseline) {
      const baseAbs = resolveCallerOrRootPath(rawBaseline);
      const baseRel = path.relative(root, baseAbs).replace(/\\/g, '/');
      assertInside(root, 'baseline', baseRel);
      const bbAbs = path.join(baseAbs, 'BRIEF_BLOCK.md');
      if (!fs.existsSync(bbAbs) || !fs.statSync(bbAbs).isFile()) {
        io.fail('指定的基线目录缺少 BRIEF_BLOCK.md：' + path.join(baseRel, 'BRIEF_BLOCK.md'));
        return finish(8);
      }
      const { r } = verifyBaselineAnchor({ io, cfg, root, anchor: baseRel, briefId: '', calibration: false });
      if (r.error || r.status === 2 || r.status === 126 || r.status === 127) {
        const note = firstOutputLine(r.stderr) || firstOutputLine(r.stdout);
        io.fail('基线锚点检查器不可用（' + baseRel + '）' + (note ? '：' + note : ''));
        return finish(2);
      }
      if (r.status !== 0) {
        const note = firstOutputLine(r.stderr) || firstOutputLine(r.stdout);
        io.fail('基线目录 ' + baseRel + ' 未通过锚点验收（需完成复现并在 REPRO.md 签 SIGNOFF: PASS）' + (note ? '：' + note : ''));
        return finish(8);
      }
      baselineLabel = baseRel + '/BRIEF_BLOCK.md';
      briefBlockText = readText(bbAbs);
      bsha = crypto.createHash('sha256').update(briefBlockText.replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 12);
    }

    // 3) 发散角色文件加载（优先项目内 roles/diverger.md，缺失回退包内 examples/roles/diverger.md）
    const configuredDivRole = P.diverger_role_file || 'roles/diverger.md';
    assertInside(root, 'diverger_role_file', configuredDivRole);
    let divRoleAbs = path.join(root, configuredDivRole);
    if (!fs.existsSync(divRoleAbs) || !fs.statSync(divRoleAbs).isFile()) {
      const bundled = resolveBundledFile(BUNDLED_DIVERGER_ROLES);
      if (bundled) {
        divRoleAbs = bundled;
        io.skip('未找到项目内 ' + configuredDivRole + ' → 自动使用包内内置模板 examples/roles/diverger.md');
      } else {
        const err = new Error('找不到发散角色文件 ' + configuredDivRole + '（请运行 npx research-dispatch init 生成）');
        err.code = 'BAD_CONFIG';
        throw err;
      }
    }

    // 4) 解析发散座位、模型、默认条数与默认 dead-ends 策略
    const divPlan = resolveDivergePlan(cfg, { agent: opts.agent, useDshPatch });
    if (!divPlan.ok) {
      io.fail(divPlan.error);
      return finish(2);
    }
    const planDefaultCount = Number(divPlan.defaultCount);
    const count = hasExplicitCount
      ? explicitCount
      : (Number.isInteger(planDefaultCount) && planDefaultCount >= 1 && planDefaultCount <= 50 ? planDefaultCount : 10);
    const policyNoDeadEnds = !hasExplicitDeadEnds
      && opts.useDeadEnds !== true
      && divPlan.defaultUseDeadEnds === false;
    const noDeadEnds = explicitNoDeadEnds || policyNoDeadEnds;

    // 5) 可选负知识库 dead-ends.md（默认自动发现 + ≤60 行截断保护；--no-dead-ends 或默认策略关闭时跳过）
    let deadEndsAbs = '';
    if (noDeadEnds) {
      io.log('纯空白发散模式（' + (explicitNoDeadEnds ? '--no-dead-ends' : 'lineup.diverge.use_dead_ends=false') + '）：跳过挂载 dead-ends.md，上下文仅含调研结果与基线');
    } else if (hasExplicitDeadEnds) {
      deadEndsAbs = resolveCallerOrRootPath(opts.deadEndsFile);
      assertInside(root, 'dead_ends', path.relative(root, deadEndsAbs));
      if (!fs.existsSync(deadEndsAbs) || !fs.statSync(deadEndsAbs).isFile()) {
        io.fail('找不到显式指定的 --dead-ends 文件：' + opts.deadEndsFile);
        return finish(1);
      }
    } else {
      const cands = [];
      if (rawTopic) cands.push(path.join(root, 'ideas', rawTopic, 'dead-ends.md'));
      cands.push(path.join(root, 'ideas', 'dead-ends.md'));
      for (const c of cands) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) {
          deadEndsAbs = c;
          break;
        }
      }
    }

    let deadEndsUsedText = '';
    let deadEndsSha = '';
    if (deadEndsAbs) {
      const rawDead = readText(deadEndsAbs).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
      if (rawDead) {
        const allLines = rawDead.split('\n');
        const usedLines = allLines.length > 60 ? allLines.slice(0, 60) : allLines;
        if (allLines.length > 60) {
          io.skip('dead-ends.md 共 ' + allLines.length + ' 行，已自动截断保留前 60 行注入，防止负向锚定过载');
        }
        deadEndsUsedText = usedLines.join('\n');
        deadEndsSha = crypto.createHash('sha256').update(Buffer.from(deadEndsUsedText, 'utf8')).digest('hex').slice(0, 12);
      }
    }

    const seat = divPlan.seat;
    const seatId = divPlan.seatId;
    const voteModel = divPlan.model || '';
    const effKind = seatKindOf(seat, { useDshPatch });
    if (effKind !== 'cli' && effKind !== 'api') {
      io.fail('发散环节仅支持 cli 或 api 座位，当前座位 ' + seatId + ' 的类型为 ' + effKind + '（请用 --agent 指定如 codex / claude / gemini / dsh / kimi / api）');
      return finish(2);
    }

    const resolvedIdentity = effKind === 'api'
      ? apiModel(seat, voteModel, { useDshPatch })
      : seatIdentity(seat, { seat: seatId, payloadSha: '', voteModel, useDshPatch });
    const rawDisplayModel = voteModel
      || normModel(resolvedIdentity)
      || seatId;
    const modelLabel = rawDisplayModel === 'unknown-check-config' ? seatId : rawDisplayModel;

    let sameFamilyWarn = '';
    const divFam = modelFamily(voteModel || resolvedIdentity);
    const revModels = reviewModels(cfg, { useDshPatch });
    const revFams = revModels
      .filter((m) => m && normModel(m) !== 'unknown-check-config')
      .map((m) => ({ raw: m, fam: modelFamily(m) }))
      .filter((x) => x.fam);
    if (!divFam || normModel(resolvedIdentity) === 'unknown-check-config' || revFams.length === 0) {
      sameFamilyWarn = 'same-family-unchecked';
    } else {
      const clashes = revFams.filter((x) => x.fam === divFam).map((x) => x.raw);
      if (clashes.length > 0) {
        sameFamilyWarn = 'same-family:' + divFam;
        io.skip('发散位 ' + modelLabel + ' 与评审位同族（' + divFam + '：' + clashes.join(', ') + '）—— 照常发散，已记入产物 meta warn=' + sameFamilyWarn);
      }
    }

    // 6) 组装发散 Prompt Payload
    const promptChunks = [
      stripTrailingNewlines(readText(divRoleAbs)),
      '---',
      '## 本轮任务\n方向：' + direction + '\n产出条数：' + count + '\n\n'
        + '**自包含硬约束**：输出的每一条 `### idea_NN` 必须 100% 独立自包含（完整写清核心机制、量化预测指标/判据与最小证伪实验），**严禁**出现“同 idea_01”“见上一条”等任何跨条引用。',
    ];
    if (briefBlockText) {
      promptChunks.push('## 你要改进的 Baseline（每条 idea 均须对齐该基线口径，不得篡改指标定义）\n\n' + stripTrailingNewlines(briefBlockText));
    } else {
      promptChunks.push('## Baseline\n\n本轮未指定已验收基线目录。**严禁臆造基线数值**；请将所需基线前提明确写入每条候选的『最小证伪实验』中。');
    }
    if (deadEndsUsedText) {
      promptChunks.push('## 已证伪机制与禁入死胡同（dead-ends.md，请避开以下已被实验否决的路径）\n\n' + deadEndsUsedText);
    }
    promptChunks.push('## 你唯一可见的领域文献材料（来自 ' + poolRel + '）\n\n' + stripTrailingNewlines(poolText));
    const fullPayload = promptChunks.join('\n\n') + '\n';

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-diverge-'));
    const payloadFile = path.join(tmpDir, 'diverge-payload.md');
    const outTmpFile = path.join(tmpDir, 'diverge-out.md');
    fs.writeFileSync(payloadFile, fullPayload, 'utf8');

    const targetDirRel = rawTopic ? ('ideas/' + rawTopic) : 'ideas';
    const slug = sanitizeMetaToken(modelLabel, seatId).replace(/[/:.\\]+/g, '_');
    const stamp = compactStamp();

    if (DRY) {
      if (effKind === 'cli') {
        const dryRes = await invokeCliSeatProcess({
          root,
          seat,
          slotTag: seatId,
          voteModel,
          payloadFile,
          payloadText: fullPayload,
          outFile: outTmpFile,
          errFile: path.join(tmpDir, 'dry.err'),
          tmpDir,
          inRepoSandbox: Boolean(inRepoSandbox),
          repoWorkersDir: WORKERS,
          DRY: true,
          timeoutMs: seatTimeoutMs(seat, opts),
        });
        if (dryRes.outcome === 'not-installed') {
          io.fail('发散座位命令未安装：' + seat.command);
          return finish(2);
        }
        if (dryRes.outcome === 'missing-fail' || dryRes.outcome === 'missing-skip') {
          io.fail(dryRes.message);
          return finish(2);
        }
        io.log('[dry] 发散预演通过：seat=' + seatId + ' model=' + modelLabel + ' count=' + count + ' → ' + targetDirRel + '/raw-' + slug + '-' + stamp + '.md');
        return finish(0);
      }
      const baseVar = process.env[seat.base_env_var || 'API_BASE_ENV'] || seat.base_env_default || 'OPENAI_BASE_URL';
      const keyVar = process.env[seat.key_env_var || 'API_KEY_ENV'] || seat.key_env_default || 'OPENAI_API_KEY';
      if (!process.env[baseVar] || !process.env[keyVar]) {
        io.fail('API 发散座位未配置环境变量（' + baseVar + ' / ' + keyVar + '）');
        return finish(2);
      }
      io.log('[dry] 发散预演通过：seat=' + seatId + '(api) model=' + modelLabel + ' count=' + count + ' → ' + targetDirRel + '/raw-' + slug + '-' + stamp + '.md');
      return finish(0);
    }

    fs.mkdirSync(path.join(root, targetDirRel), { recursive: true });
    const errLogRel = targetDirRel + '/last_diverge-' + stamp + '.err';
    const errLogAbs = path.join(root, errLogRel);
    const timeoutMs = seatTimeoutMs(seat, opts);

    io.log('发散启动：' + seatId + ' (' + modelLabel + ')，目标 ' + count + ' 条，输入 ' + Buffer.byteLength(fullPayload, 'utf8') + ' 字节');

    if (effKind === 'cli') {
      const execRes = await invokeCliSeatProcess({
        root,
        seat,
        slotTag: seatId,
        voteModel,
        payloadFile,
        payloadText: fullPayload,
        outFile: outTmpFile,
        errFile: errLogAbs,
        tmpDir,
        inRepoSandbox: Boolean(inRepoSandbox),
        repoWorkersDir: WORKERS,
        DRY: false,
        timeoutMs,
        payloadPromptHint: (fname) => '请打开并完整阅读当前目录文件 ' + fname + '（或标准输入 stdin），其中包含本轮唯一的发散任务与文献材料，严格按规定的 ### idea_NN 格式与条数输出结果，禁止跨条引用。',
      });
      if (execRes.outcome === 'not-installed') {
        io.fail('发散座位命令未安装：' + seat.command);
        return finish(2);
      }
      if (execRes.outcome === 'missing-fail' || execRes.outcome === 'missing-skip') {
        io.fail(execRes.message);
        return finish(2);
      }
      if (!execRes.spawnRes || execRes.spawnRes.status !== 0) {
        keepErr(io, false, errLogAbs, false);
        io.fail(seatId + ' 发散执行失败（' + describeSpawn(execRes.spawnRes || {}) + '），诊断见 ' + errLogRel);
        return finish(2);
      }
    } else {
      const baseVar = process.env[seat.base_env_var || 'API_BASE_ENV'] || seat.base_env_default || 'OPENAI_BASE_URL';
      const keyVar = process.env[seat.key_env_var || 'API_KEY_ENV'] || seat.key_env_default || 'OPENAI_API_KEY';
      if (!process.env[baseVar] || !process.env[keyVar]) {
        io.fail('API 发散座位未配置环境变量（' + baseVar + ' / ' + keyVar + '）');
        return finish(2);
      }
      const tempCfg = seat.temperature && typeof seat.temperature === 'object' ? seat.temperature : null;
      const rawTemp = tempCfg ? (process.env[tempCfg.env || ''] ?? tempCfg.default ?? '') : '';
      const maxTokCfg = seat.max_tokens && typeof seat.max_tokens === 'object' ? seat.max_tokens : null;
      const rawMaxTok = maxTokCfg && maxTokCfg.env ? (process.env[maxTokCfg.env] || '') : (maxTokCfg && maxTokCfg.default ? String(maxTokCfg.default) : '');

      const apiRes = await apiChatCompletion({
        baseUrl: process.env[baseVar],
        apiKey: process.env[keyVar],
        model: modelLabel,
        payload: fullPayload,
        timeoutMs,
        maxTokens: rawMaxTok ? Number(rawMaxTok) : 8192,
        temperature: rawTemp !== '' ? Number(rawTemp) : null,
      });
      if (!apiRes.ok || !apiRes.content) {
        fs.writeFileSync(errLogAbs, maskSecrets(apiRes.stderr || ('API 发散调用失败 rc=' + apiRes.rc + '\n')), 'utf8');
        keepErr(io, false, errLogAbs, false);
        io.fail(seatId + ' API 发散失败（rc=' + apiRes.rc + '），诊断见 ' + errLogRel);
        return finish(2);
      }
      fs.writeFileSync(outTmpFile, apiRes.content + '\n', 'utf8');
    }

    const rawBody = fs.existsSync(outTmpFile) ? readText(outTmpFile) : '';
    const cleanBody = rawBody.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
    if (!cleanBody) {
      keepErr(io, false, errLogAbs, false);
      io.fail(seatId + ' 返回零输出，本次发散不落半成品文件' + (fs.existsSync(errLogAbs) ? '（见 ' + errLogRel + '）' : ''));
      return finish(2);
    }
    keepErr(io, true, errLogAbs, false);

    const gotIdeas = (cleanBody.match(/^###[ \t]+idea_/gm) || []).length;
    const isShort = gotIdeas < count * 0.6;
    const warnParts = [];
    if (isShort) warnParts.push('short_pool');
    if (sameFamilyWarn) warnParts.push(sameFamilyWarn);

    const serialized = serializeIdeaPool({
      role: 'diverger',
      model: modelLabel,
      input: poolRel,
      inputName: poolRel,
      topic: rawTopic || direction,
      requested: count,
      gotIdeas,
      got_ideas: gotIdeas,
      baseline: baselineLabel,
      bsha,
      deadEndsSha,
      warn: warnParts.join(','),
      warnShort: isShort,
      warnSameFamily: sameFamilyWarn,
      body: cleanBody,
    });
    const finalPoolText = typeof serialized === 'string' ? serialized : serialized.text;

    let outRel = targetDirRel + '/raw-' + slug + '-' + stamp + '.md';
    if (fs.existsSync(path.join(root, outRel))) {
      let n = 2;
      while (fs.existsSync(path.join(root, targetDirRel + '/raw-' + slug + '-' + stamp + '-' + n + '.md'))) n += 1;
      outRel = targetDirRel + '/raw-' + slug + '-' + stamp + '-' + n + '.md';
    }
    writeAtomic(path.join(root, outRel), finalPoolText);
    io.log('已写 ' + outRel + '（请求 ' + count + ' 条，实得 ' + gotIdeas + ' 条）');
    if (isShort) {
      io.skip('实得候选条数 ' + gotIdeas + '/' + count + ' 少于 60% 阈值，已在产物 meta 标记 warn=short_pool');
    }

    const nextCmd = 'npx research-dispatch briefs ' + outRel
      + (rawTopic ? ' --topic ' + rawTopic : '')
      + (rawBaseline ? ' --baseline ' + rawBaseline : '');
    io.plain('下一步拆单：' + nextCmd);
    return finish(0);
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    try { process.chdir(origCwd); } catch { /* 忽略 */ }
  }
}

function extractYamlPaperId(text) {
  const m = String(text || '').match(/^[ \t]*paper_id[ \t]*:[ \t]*([^\r\n#]+)/m);
  if (!m) return '';
  return m[1].trim().replace(/^["'`]+|["'`]+$/g, '').trim();
}

function normalizeCardSlug(rawName, fallbackBody = '', idx = 1) {
  let base = String(rawName || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (base) {
    base = path.basename(base.replace(/\\/g, '/')).replace(/\.md$/i, '').trim();
  }
  if (!base) {
    base = extractYamlPaperId(fallbackBody).replace(/\.md$/i, '');
  }
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!safe || safe === '.' || safe === '..' || safe === '_pool') {
    return 'scout-card-' + idx;
  }
  return safe;
}

export function splitScoutOutputCards(rawText) {
  const normalized = String(rawText || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const summarySplit = normalized.split(/^[ \t]*===[ \t]*(?:SUMMARY|END[ _-]?CARDS|TOP[ _-]?NEIGHBORS)[^=\n]*===[ \t]*$/im);
  const cardsRegion = summarySplit[0] || '';

  const markerRe = /^[ \t]*===[ \t]*CARD:[ \t]*([^\n=]+?)[ \t]*===[ \t]*$/gm;
  const markers = [];
  let m;
  while ((m = markerRe.exec(cardsRegion)) !== null) {
    markers.push({
      rawName: m[1],
      headerStart: m.index,
      bodyStart: m.index + m[0].length,
    });
  }

    if (markers.length > 0) {
    const out = [];
    for (let i = 0; i < markers.length; i += 1) {
      const segEnd = i + 1 < markers.length ? markers[i + 1].headerStart : cardsRegion.length;
      const segBody = cardsRegion.slice(markers[i].bodyStart, segEnd).trim();
      if (!segBody) continue;
      const yamlPid = extractYamlPaperId(segBody);
      const validPidSlug = yamlPid
        && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(yamlPid)
        && !/^(?:todo|tbd|none|null|_pool)$/i.test(yamlPid)
        ? yamlPid.replace(/\.md$/i, '')
        : '';
      const slug = validPidSlug || normalizeCardSlug(markers[i].rawName, segBody, i + 1);
      out.push({ slug, body: segBody });
    }
    return out;
  }

  // 兼容未写 === CARD: <slug>.md === 的输出：多围栏逐张切分，单卡（围栏或裸 YAML）整段保留以接受 checkPaperCard 散文边界校验
  const fenceMatches = [...cardsRegion.matchAll(/```(?:yaml|yml)?[ \t]*\n([\s\S]*?)```/gi)];
  if (fenceMatches.length > 1 && fenceMatches.every((fm) => /^[ \t]*paper_id[ \t]*:/m.test(fm[1]))) {
    return fenceMatches.map((fm, idx) => {
      const fencedBody = '```yaml\n' + fm[1].replace(/\n+$/, '') + '\n```';
      const slug = normalizeCardSlug('', fm[1], idx + 1);
      return { slug, body: fencedBody };
    });
  }

  const trimmed = cardsRegion.trim();
  if (!trimmed) return [];
  const slug = normalizeCardSlug('', trimmed, 1);
  return [{ slug, body: trimmed }];
}

/**
 * S0 文献调研真实派工执行器（v2.1.0）：
 * 调用 resolveStagePlan(cfg, 'scout') 选定执行座位，在 os.tmpdir() 空沙箱中运行，
 * 优先抓取 arXiv LaTeX/HTML/Markdown 信息并按 === CARD: <slug>.md === 切分多张文献卡，
 * 逐张调用 checkPaperCard：合格卡写入 papers/cards/<slug>.md，不合格卡隔离至 papers/cards/rejected/，
 * 传 --pool (assemblePool: true) 时自动更新 papers/cards/_pool.md。
 */
export async function runScout(opts = {}) {
  const root = path.resolve(String(opts.root || process.cwd()));
  const origCwd = process.cwd();
  const useDshPatch = Boolean(opts.useDshPatch);
  const io = makeIO(root, { captureOnly: Boolean(opts.captureOnly), onOutput: opts.onOutput || null });
  const finish = (code) => {
    if (!opts.noExitCode) process.exitCode = code;
    return code;
  };

  const resolveCallerOrRootPath = (p) => {
    if (!p) return '';
    if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return path.resolve(p);
    const fromRoot = path.resolve(root, p);
    const fromOrig = path.resolve(origCwd, p);
    if (fs.existsSync(fromRoot)) return fromRoot;
    if (origCwd !== root && fs.existsSync(fromOrig)) return fromOrig;
    return fromRoot;
  };

  const query = String(opts.query ?? opts.direction ?? '').trim();
  if (!query) {
    io.err('用法: dispatch.mjs scout <调研方向> [篇数=5] [--cards <dir>] [--agent <seat[:model]>] [--pool] [--dry]');
    return finish(1);
  }

  const hasExplicitCount = opts.count !== undefined && opts.count !== null && opts.count !== '';
  const count = hasExplicitCount ? Number(opts.count) : 5;
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    io.err('!! 文献调研篇数必须是 1..50 的整数，实得：' + JSON.stringify(opts.count));
    return finish(1);
  }

  const DRY = Boolean(opts.dry) || (process.env.DRY || '0') === '1';
  const assemblePool = Boolean(opts.assemblePool || opts.pool);
  let tmpDir = '';

  try {
    process.chdir(root);
    const cfg = loadConfig(root, opts.seatsFile, { useDshPatch });
    const P = cfg.paths || {};
    const WORKERS = assertInside(root, 'workers_dir', P.workers_dir || 'workers');
    const inRepoSandbox = P.sandbox_mode === 'in_repo';

    const rawCardsDir = String(opts.cardsDir || opts.cards || 'papers/cards').trim() || 'papers/cards';
    const cardsAbs = path.isAbsolute(rawCardsDir) || /^[A-Za-z]:/.test(rawCardsDir)
      ? path.resolve(rawCardsDir)
      : path.resolve(root, rawCardsDir);
    const cardsRel = path.relative(root, cardsAbs).replace(/\\/g, '/') || 'papers/cards';
    assertInside(root, 'cards_dir', cardsRel);

    // 扫描已有文献卡，避免重复建卡
    const existingCards = [];
    if (fs.existsSync(cardsAbs) && fs.statSync(cardsAbs).isDirectory()) {
      for (const f of fs.readdirSync(cardsAbs).sort()) {
        if (!f.endsWith('.md') || f === '_pool.md' || f.startsWith('.')) continue;
        const fp = path.join(cardsAbs, f);
        try {
          if (!fs.statSync(fp).isFile()) continue;
          const txt = readText(fp);
          const tm = txt.match(/^[ \t]*title[ \t]*:[ \t]*(.+)$/m);
          const titleVal = tm ? tm[1].trim().replace(/^["']|["']$/g, '') : '';
          existingCards.push({ slug: f.slice(0, -3), title: titleVal });
        } catch { /* 忽略无法读取的文件 */ }
      }
    }

    // 加载 roles/scout.md（缺失回退包内 examples/roles/scout.md）
    const configuredScoutRole = P.scout_role_file || 'roles/scout.md';
    assertInside(root, 'scout_role_file', configuredScoutRole);
    let scoutRoleAbs = path.join(root, configuredScoutRole);
    if (!fs.existsSync(scoutRoleAbs) || !fs.statSync(scoutRoleAbs).isFile()) {
      const bundled = resolveBundledFile(BUNDLED_SCOUT_ROLES);
      if (bundled) {
        scoutRoleAbs = bundled;
        io.skip('未找到项目内 ' + configuredScoutRole + ' → 自动使用包内内置模板 examples/roles/scout.md');
      } else {
        const err = new Error('找不到文献调研角色文件 ' + configuredScoutRole + '（请运行 npx research-dispatch init 生成）');
        err.code = 'BAD_CONFIG';
        throw err;
      }
    }

    const scoutPlan = resolveStage(cfg, 'scout', { agent: opts.agent, useDshPatch });
    if (!scoutPlan.ok) {
      io.fail(scoutPlan.error);
      return finish(2);
    }
    const seat = scoutPlan.seat;
    const seatId = scoutPlan.seatId;
    const voteModel = scoutPlan.model || '';
    const effKind = seatKindOf(seat, { useDshPatch });
    if (effKind !== 'cli' && effKind !== 'api') {
      io.fail('文献调研环节仅支持 cli 或 api 座位，当前座位 ' + seatId + ' 的类型为 ' + effKind);
      return finish(2);
    }

    const resolvedIdentity = effKind === 'api'
      ? apiModel(seat, voteModel, { useDshPatch })
      : seatIdentity(seat, { seat: seatId, payloadSha: '', voteModel, useDshPatch });
    const rawDisplayModel = voteModel || normModel(resolvedIdentity) || seatId;
    const modelLabel = rawDisplayModel === 'unknown-check-config' ? seatId : rawDisplayModel;

    const promptChunks = [
      stripTrailingNewlines(readText(scoutRoleAbs)),
      '---',
      [
        '## 本轮文献调研任务',
        '调研主题：' + query,
        '目标篇数：' + count,
        '',
        '**源码优先硬约束**：获取论文正文信息时，必须优先抓取 arXiv TeX/LaTeX 源码（`e-print`）或 HTML/Markdown（如 arXiv HTML、`ar5iv`、官方代码仓库 README），仅当无源码且无 HTML/Markdown 时才回退读取 PDF；严禁凭记忆编造不存在的论文或代码链接。',
        '',
        '**多卡分隔输出契约**：请将每篇检索到的真实论文按 `=== CARD: <slug>.md ===` 独立分隔输出，`<slug>` 仅用小写字母、数字与连字符，且必须与卡内 `paper_id` 完全一致；每个分隔段内只输出一个 ```yaml 代码块（代码块前后严禁夹带超过 30 字散文）：',
        '',
        '=== CARD: author-2025-keyword.md ===',
        '```yaml',
        'paper_id: author-2025-keyword',
        'title: "Exact Paper Title"',
        'venue: ICLR',
        'code_url: none',
        'abstract_zh: "不超过 3 句的中文核心摘要。"',
        'intro_key: "针对的具体痛点与核心切入机制（1-2 句）。"',
        'relevance: "与本课题的直接关联或边界差异（1 句）。"',
        '```',
        '',
        '如需补充 Top 3–5 核心近邻精读建议，请统一置于最后一行 `=== SUMMARY ===` 分隔符之后。',
      ].join('\n'),
    ];

    if (existingCards.length > 0) {
      const listed = existingCards.slice(0, 80).map((c) => '- ' + c.slug + (c.title ? ' — ' + c.title : '')).join('\n');
      promptChunks.push('## 已收录文献卡（共 ' + existingCards.length + ' 篇，请避免重复收录同名或同篇论文）\n\n' + listed);
    }

    const fullPayload = promptChunks.join('\n\n') + '\n';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-scout-'));
    const payloadFile = path.join(tmpDir, 'scout-payload.md');
    const outTmpFile = path.join(tmpDir, 'scout-out.md');
    fs.writeFileSync(payloadFile, fullPayload, 'utf8');

    const slug = sanitizeMetaToken(modelLabel, seatId).replace(/[/:.\\]+/g, '_');
    const stamp = compactStamp();
    const rawOutRel = 'papers/scout-' + slug + '-' + stamp + '.md';

    if (DRY) {
      if (effKind === 'cli') {
        const dryRes = await invokeCliSeatProcess({
          root,
          seat,
          slotTag: seatId,
          voteModel,
          payloadFile,
          payloadText: fullPayload,
          outFile: outTmpFile,
          errFile: path.join(tmpDir, 'dry.err'),
          tmpDir,
          inRepoSandbox: Boolean(inRepoSandbox),
          repoWorkersDir: WORKERS,
          DRY: true,
          timeoutMs: seatTimeoutMs(seat, opts),
        });
        if (dryRes.outcome === 'not-installed') {
          io.fail('文献调研座位命令未安装：' + seat.command);
          return finish(2);
        }
        if (dryRes.outcome === 'missing-fail' || dryRes.outcome === 'missing-skip') {
          io.fail(dryRes.message);
          return finish(2);
        }
        io.log('[dry] 文献调研预演通过：seat=' + seatId + ' model=' + modelLabel + ' count=' + count + ' cards=' + cardsRel + (assemblePool ? ' (+pool)' : '') + ' → ' + rawOutRel);
        return finish(0);
      }
      const baseVar = process.env[seat.base_env_var || 'API_BASE_ENV'] || seat.base_env_default || 'OPENAI_BASE_URL';
      const keyVar = process.env[seat.key_env_var || 'API_KEY_ENV'] || seat.key_env_default || 'OPENAI_API_KEY';
      if (!process.env[baseVar] || !process.env[keyVar]) {
        io.fail('API 文献调研座位未配置环境变量（' + baseVar + ' / ' + keyVar + '）');
        return finish(2);
      }
      io.log('[dry] 文献调研预演通过：seat=' + seatId + '(api) model=' + modelLabel + ' count=' + count + ' cards=' + cardsRel + (assemblePool ? ' (+pool)' : '') + ' → ' + rawOutRel);
      return finish(0);
    }

    fs.mkdirSync(path.join(root, 'papers'), { recursive: true });
    fs.mkdirSync(cardsAbs, { recursive: true });
    const errLogRel = 'papers/last_scout-' + stamp + '.err';
    const errLogAbs = path.join(root, errLogRel);
    const timeoutMs = seatTimeoutMs(seat, opts);

    io.log('文献调研启动：' + seatId + ' (' + modelLabel + ')，目标 ' + count + ' 篇，输入 ' + Buffer.byteLength(fullPayload, 'utf8') + ' 字节');

    if (effKind === 'cli') {
      const execRes = await invokeCliSeatProcess({
        root,
        seat,
        slotTag: seatId,
        voteModel,
        payloadFile,
        payloadText: fullPayload,
        outFile: outTmpFile,
        errFile: errLogAbs,
        tmpDir,
        inRepoSandbox: Boolean(inRepoSandbox),
        repoWorkersDir: WORKERS,
        DRY: false,
        timeoutMs,
        payloadPromptHint: (fname) => '请打开并完整阅读当前目录文件 ' + fname + '（或标准输入 stdin），按其中的文献调研任务检索真实文献并按 === CARD: <slug>.md === 分隔输出结构化 YAML 文献卡。',
      });
      if (execRes.outcome === 'not-installed') {
        io.fail('文献调研座位命令未安装：' + seat.command);
        return finish(2);
      }
      if (execRes.outcome === 'missing-fail' || execRes.outcome === 'missing-skip') {
        io.fail(execRes.message);
        return finish(2);
      }
      if (!execRes.spawnRes || execRes.spawnRes.status !== 0) {
        keepErr(io, false, errLogAbs, false);
        io.fail(seatId + ' 文献调研执行失败（' + describeSpawn(execRes.spawnRes || {}) + '），诊断见 ' + errLogRel);
        return finish(2);
      }
    } else {
      const baseVar = process.env[seat.base_env_var || 'API_BASE_ENV'] || seat.base_env_default || 'OPENAI_BASE_URL';
      const keyVar = process.env[seat.key_env_var || 'API_KEY_ENV'] || seat.key_env_default || 'OPENAI_API_KEY';
      if (!process.env[baseVar] || !process.env[keyVar]) {
        io.fail('API 文献调研座位未配置环境变量（' + baseVar + ' / ' + keyVar + '）');
        return finish(2);
      }
      const tempCfg = seat.temperature && typeof seat.temperature === 'object' ? seat.temperature : null;
      const rawTemp = tempCfg ? (process.env[tempCfg.env || ''] ?? tempCfg.default ?? '') : '';
      const maxTokCfg = seat.max_tokens && typeof seat.max_tokens === 'object' ? seat.max_tokens : null;
      const rawMaxTok = maxTokCfg && maxTokCfg.env ? (process.env[maxTokCfg.env] || '') : (maxTokCfg && maxTokCfg.default ? String(maxTokCfg.default) : '');

      const apiRes = await apiChatCompletion({
        baseUrl: process.env[baseVar],
        apiKey: process.env[keyVar],
        model: modelLabel,
        payload: fullPayload,
        timeoutMs,
        maxTokens: rawMaxTok ? Number(rawMaxTok) : 8192,
        temperature: rawTemp !== '' ? Number(rawTemp) : null,
      });
      if (!apiRes.ok || !apiRes.content) {
        fs.writeFileSync(errLogAbs, maskSecrets(apiRes.stderr || ('API 文献调研调用失败 rc=' + apiRes.rc + '\n')), 'utf8');
        keepErr(io, false, errLogAbs, false);
        io.fail(seatId + ' API 文献调研失败（rc=' + apiRes.rc + '），诊断见 ' + errLogRel);
        return finish(2);
      }
      fs.writeFileSync(outTmpFile, apiRes.content + '\n', 'utf8');
    }

    const rawBody = fs.existsSync(outTmpFile) ? readText(outTmpFile) : '';
    const cleanBody = rawBody.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
    if (!cleanBody) {
      keepErr(io, false, errLogAbs, false);
      io.fail(seatId + ' 返回零输出，本次文献调研不落半成品文件' + (fs.existsSync(errLogAbs) ? '（见 ' + errLogRel + '）' : ''));
      return finish(2);
    }
    keepErr(io, true, errLogAbs, false);

    let finalRawRel = rawOutRel;
    if (fs.existsSync(path.join(root, finalRawRel))) {
      let n = 2;
      while (fs.existsSync(path.join(root, 'papers/scout-' + slug + '-' + stamp + '-' + n + '.md'))) n += 1;
      finalRawRel = 'papers/scout-' + slug + '-' + stamp + '-' + n + '.md';
    }
    const rawMeta = '<!-- meta role=scout seat=' + sanitizeMetaToken(seatId, 'scout')
      + ' model=' + sanitizeMetaToken(modelLabel, seatId)
      + ' requested=' + count
      + ' ts=' + isoSec() + ' -->\n\n';
    writeAtomic(path.join(root, finalRawRel), rawMeta + cleanBody + '\n');
    io.log('原始调研记录已写入 ' + finalRawRel);

    const splitCards = splitScoutOutputCards(cleanBody);
    const checkTmpDir = path.join(tmpDir, 'check-cards');
    fs.mkdirSync(checkTmpDir, { recursive: true });
    const validFiles = [];
    const rejectedFiles = [];
    const seenSlugs = new Map();

    for (let i = 0; i < splitCards.length; i += 1) {
      const item = splitCards[i];
      const countSeen = (seenSlugs.get(item.slug) || 0) + 1;
      seenSlugs.set(item.slug, countSeen);
      const effectiveSlug = countSeen === 1 ? item.slug : (item.slug + '-dup' + countSeen);
      const cardMeta = '<!-- meta role=scout seat=' + sanitizeMetaToken(seatId, 'scout')
        + ' model=' + sanitizeMetaToken(modelLabel, seatId)
        + ' ts=' + isoSec() + ' -->\n';
      const cardContent = cardMeta + item.body.replace(/\r\n/g, '\n').trim() + '\n';
      const candPath = path.join(checkTmpDir, effectiveSlug + '.md');
      fs.writeFileSync(candPath, cardContent, 'utf8');

      const chk = checkPaperCard(candPath);
      if (chk.ok) {
        const destAbs = path.join(cardsAbs, effectiveSlug + '.md');
        writeAtomic(destAbs, cardContent);
        validFiles.push(effectiveSlug + '.md');
        io.log('合格文献卡落盘：' + cardsRel + '/' + effectiveSlug + '.md');
      } else {
        const rejAbs = path.join(cardsAbs, 'rejected', effectiveSlug + '.md');
        writeAtomic(rejAbs, cardContent);
        rejectedFiles.push(effectiveSlug + '.md');
        const reason = Array.isArray(chk.problems) && chk.problems.length > 0
          ? chk.problems.join('；')
          : firstOutputLine(chk.stderr);
        io.skip('文献卡未通过 checkPaperCard，已隔离至 ' + cardsRel + '/rejected/' + effectiveSlug + '.md：' + reason);
      }
    }

    let poolRc = 0;
    if (assemblePool && (validFiles.length > 0 || existingCards.length > 0)) {
      const poolOutRel = opts.outFile || (cardsRel + '/_pool.md');
      const poolRes = assemblePaperPool(root, {
        cardsDir: cardsRel,
        outFile: poolOutRel,
        dry: false,
      });
      if (poolRes.stdout) io.log(poolRes.stdout.replace(/^==\s*/, ''));
      if (poolRes.stderr) io.skip(poolRes.stderr);
      poolRc = poolRes.rc ?? (poolRes.ok ? 0 : 1);
    }

    if (validFiles.length === 0) {
      io.fail('本轮调研未产出合格文献卡（隔离 ' + rejectedFiles.length + ' 张），请核查原始输出 ' + finalRawRel);
      return finish(1);
    }
    if (rejectedFiles.length > 0 || poolRc !== 0) {
      io.skip('文献调研完成（合格 ' + validFiles.length + ' 张，隔离不合格 ' + rejectedFiles.length + ' 张 → 返回 rc=1 提醒复核）');
      return finish(1);
    }
    io.log('文献调研完成：共落盘合格文献卡 ' + validFiles.length + ' 张' + (assemblePool ? ' 并已更新 _pool.md' : ''));
    return finish(0);
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    try { process.chdir(origCwd); } catch { /* 忽略 */ }
  }
}

function resolveBriefForNovelty(root, origCwd, rawBrief, rawTopic) {
  const s = String(rawBrief || '').trim();
  if (!s) return { ok: false, error: '未指定待查重工单' };

  const tryDirect = (p) => {
    if (!p) return '';
    if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) {
      return fs.existsSync(p) && fs.statSync(p).isFile() ? path.resolve(p) : '';
    }
    const fromRoot = path.resolve(root, p);
    if (fs.existsSync(fromRoot) && fs.statSync(fromRoot).isFile()) return fromRoot;
    if (origCwd !== root) {
      const fromOrig = path.resolve(origCwd, p);
      if (fs.existsSync(fromOrig) && fs.statSync(fromOrig).isFile()) return fromOrig;
    }
    return '';
  };

  const directHit = tryDirect(s);
  if (directHit) return { ok: true, briefAbs: directHit };

  const candId = s.replace(/\.md$/i, '');
  if (!candId || /[/\\]/.test(candId) || candId === '.' || candId === '..') {
    return { ok: false, error: '找不到待查重工单文件：' + s };
  }

  if (rawTopic) {
    const byTopic = path.join(root, 'ideas', rawTopic, 'briefs', candId + '.md');
    if (fs.existsSync(byTopic) && fs.statSync(byTopic).isFile()) {
      return { ok: true, briefAbs: byTopic };
    }
    return { ok: false, error: '在课题 ' + rawTopic + ' 下找不到工单：ideas/' + rawTopic + '/briefs/' + candId + '.md' };
  }

  const topBrief = path.join(root, 'ideas', 'briefs', candId + '.md');
  if (fs.existsSync(topBrief) && fs.statSync(topBrief).isFile()) {
    return { ok: true, briefAbs: topBrief };
  }

  const ideasRoot = path.join(root, 'ideas');
  const topicHits = [];
  if (fs.existsSync(ideasRoot) && fs.statSync(ideasRoot).isDirectory()) {
    for (const ent of fs.readdirSync(ideasRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === 'briefs' || ent.name === 'cards' || ent.name === 'archive' || ent.name.startsWith('.')) {
        continue;
      }
      const p = path.join(ideasRoot, ent.name, 'briefs', candId + '.md');
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        topicHits.push({ topic: ent.name, path: p });
      }
    }
  }

  if (topicHits.length === 1) {
    return { ok: true, briefAbs: topicHits[0].path };
  }
  if (topicHits.length > 1) {
    return {
      ok: false,
      error: '多个课题下均存在工单 ' + candId + '（' + topicHits.map((h) => h.topic).join(', ') + '），请用 --topic <slug> 明确指定',
    };
  }
  return { ok: false, error: '找不到待查重工单：' + s };
}

/**
 * S4.5 前置查重真实派工执行器（v2.1.0）：
 * 调用 resolveStagePlan(cfg, 'novelty')，严格推式隔离单张候选工单（+ 可选 _pool.md，严禁混入其它候选），
 * 在 os.tmpdir() 空沙箱中运行座位并写入 papers/novelty/<id>.md，落盘后立即运行 checkNoveltyReport 校验闸门。
 */
export async function runNovelty(opts = {}) {
  const root = path.resolve(String(opts.root || process.cwd()));
  const origCwd = process.cwd();
  const useDshPatch = Boolean(opts.useDshPatch);
  const io = makeIO(root, { captureOnly: Boolean(opts.captureOnly), onOutput: opts.onOutput || null });
  const finish = (code) => {
    if (!opts.noExitCode) process.exitCode = code;
    return code;
  };

  const resolveCallerOrRootPath = (p) => {
    if (!p) return '';
    if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return path.resolve(p);
    const fromRoot = path.resolve(root, p);
    const fromOrig = path.resolve(origCwd, p);
    if (fs.existsSync(fromRoot)) return fromRoot;
    if (origCwd !== root && fs.existsSync(fromOrig)) return fromOrig;
    return fromRoot;
  };

  const rawBrief = String(opts.brief ?? opts.briefArg ?? '').trim();
  if (!rawBrief) {
    io.err('用法: dispatch.mjs novelty <工单路径或ID> [--topic <slug>] [--pool <file>] [--out <file>] [--agent <seat[:model]>] [--dry]');
    return finish(1);
  }

  const rawTopic = opts.topic !== undefined && opts.topic !== null ? String(opts.topic).trim() : '';
  if (rawTopic && (!/^[A-Za-z0-9._-]+$/.test(rawTopic) || rawTopic === '.' || rawTopic === '..')) {
    io.err('!! --topic 课题名非法（仅允许字母、数字、点、下划线与连字符）：' + JSON.stringify(rawTopic));
    return finish(1);
  }

  const DRY = Boolean(opts.dry) || (process.env.DRY || '0') === '1';
  let tmpDir = '';

  try {
    process.chdir(root);
    const cfg = loadConfig(root, opts.seatsFile, { useDshPatch });
    const P = cfg.paths || {};
    const WORKERS = assertInside(root, 'workers_dir', P.workers_dir || 'workers');
    const inRepoSandbox = P.sandbox_mode === 'in_repo';

    const briefResolved = resolveBriefForNovelty(root, origCwd, rawBrief, rawTopic);
    if (!briefResolved.ok) {
      io.fail(briefResolved.error);
      return finish(1);
    }
    const briefAbs = briefResolved.briefAbs;
    const briefRel = path.relative(root, briefAbs).replace(/\\/g, '/');
    assertInside(root, 'brief', briefRel);
    const ideaId = path.basename(briefAbs, '.md');

    const rawOut = String(opts.outFile ?? opts.out ?? ('papers/novelty/' + ideaId + '.md')).trim();
    const outAbs = path.isAbsolute(rawOut) || /^[A-Za-z]:/.test(rawOut)
      ? path.resolve(rawOut)
      : path.resolve(root, rawOut);
    const outRel = path.relative(root, outAbs).replace(/\\/g, '/');
    assertInside(root, 'novelty_out', outRel);
    const expectedIdeaId = path.basename(outAbs, '.md').replace(/^novelty[-_]/i, '') || ideaId;

    // 可选本地文献池（显式传 --pool 缺失时报错；默认 papers/cards/_pool.md 存在则挂载，不存在静默跳过）
    let poolText = '';
    let poolRel = '';
    const explicitPool = String(opts.poolFile ?? opts.pool ?? '').trim();
    if (explicitPool) {
      const poolAbs = resolveCallerOrRootPath(explicitPool);
      poolRel = path.relative(root, poolAbs).replace(/\\/g, '/');
      assertInside(root, 'pool', poolRel);
      if (!fs.existsSync(poolAbs) || !fs.statSync(poolAbs).isFile()) {
        io.fail('找不到显式指定的文献池文件：' + explicitPool);
        return finish(1);
      }
      poolText = readText(poolAbs);
    } else {
      const defPoolAbs = path.join(root, 'papers', 'cards', '_pool.md');
      if (fs.existsSync(defPoolAbs) && fs.statSync(defPoolAbs).isFile()) {
        poolText = readText(defPoolAbs);
        poolRel = 'papers/cards/_pool.md';
      }
    }

    // 加载 roles/novelty.md（缺失回退包内 examples/roles/novelty.md）
    const configuredNovRole = P.novelty_role_file || 'roles/novelty.md';
    assertInside(root, 'novelty_role_file', configuredNovRole);
    let novRoleAbs = path.join(root, configuredNovRole);
    if (!fs.existsSync(novRoleAbs) || !fs.statSync(novRoleAbs).isFile()) {
      const bundled = resolveBundledFile(BUNDLED_NOVELTY_ROLES);
      if (bundled) {
        novRoleAbs = bundled;
        io.skip('未找到项目内 ' + configuredNovRole + ' → 自动使用包内内置模板 examples/roles/novelty.md');
      } else {
        const err = new Error('找不到查重角色文件 ' + configuredNovRole + '（请运行 npx research-dispatch init 生成）');
        err.code = 'BAD_CONFIG';
        throw err;
      }
    }

    const novPlan = resolveStage(cfg, 'novelty', { agent: opts.agent, useDshPatch });
    if (!novPlan.ok) {
      io.fail(novPlan.error);
      return finish(2);
    }
    const seat = novPlan.seat;
    const seatId = novPlan.seatId;
    const voteModel = novPlan.model || '';
    const effKind = seatKindOf(seat, { useDshPatch });
    if (effKind !== 'cli' && effKind !== 'api') {
      io.fail('前置查重环节仅支持 cli 或 api 座位，当前座位 ' + seatId + ' 的类型为 ' + effKind);
      return finish(2);
    }

    const resolvedIdentity = effKind === 'api'
      ? apiModel(seat, voteModel, { useDshPatch })
      : seatIdentity(seat, { seat: seatId, payloadSha: '', voteModel, useDshPatch });
    const rawDisplayModel = voteModel || normModel(resolvedIdentity) || seatId;
    const modelLabel = rawDisplayModel === 'unknown-check-config' ? seatId : rawDisplayModel;

    let sameFamilyWarn = '';
    const novFam = modelFamily(voteModel || resolvedIdentity);
    const revModels = reviewModels(cfg, { useDshPatch });
    const revFams = revModels
      .filter((m) => m && normModel(m) !== 'unknown-check-config')
      .map((m) => ({ raw: m, fam: modelFamily(m) }))
      .filter((x) => x.fam);
    if (novFam && normModel(resolvedIdentity) !== 'unknown-check-config' && revFams.length > 0) {
      const clashes = revFams.filter((x) => x.fam === novFam).map((x) => x.raw);
      if (clashes.length > 0) {
        sameFamilyWarn = 'same-family:' + novFam;
      }
    }

    // 推式单工单隔离组装：仅含 roles/novelty.md + 当前唯一 brief + 可选 _pool.md
    const promptChunks = [
      stripTrailingNewlines(readText(novRoleAbs)),
      '---',
      '## 待查重唯一候选工单（idea_id: "' + expectedIdeaId + '"，来源 ' + briefRel + '）\n\n'
        + stripTrailingNewlines(briefForPrompt(readText(briefAbs))),
    ];
    if (poolText.trim()) {
      promptChunks.push('## 本地已入库文献池（来自 ' + poolRel + '）\n\n' + stripTrailingNewlines(poolText));
    }
    if (sameFamilyWarn) {
      promptChunks.push('## 同源模型透明声明提示\n当前查重执行模型（' + modelLabel + '）与盲审席位存在同模型家族重叠（' + sameFamilyWarn + '），请在 YAML 的 `note` 字段中如实注明。');
    }
    promptChunks.push(
      '## 输出格式硬要求\n整份输出只能包含一个 ```yaml 代码块（代码块前后不得附带超过 30 字散文），且 `idea_id` 字段必须精确填写 `"' + expectedIdeaId + '"`。',
    );

    const fullPayload = promptChunks.join('\n\n') + '\n';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-novelty-'));
    const payloadFile = path.join(tmpDir, 'novelty-payload.md');
    const outTmpFile = path.join(tmpDir, 'novelty-out.md');
    fs.writeFileSync(payloadFile, fullPayload, 'utf8');

    if (DRY) {
      if (effKind === 'cli') {
        const dryRes = await invokeCliSeatProcess({
          root,
          seat,
          slotTag: seatId,
          voteModel,
          payloadFile,
          payloadText: fullPayload,
          outFile: outTmpFile,
          errFile: path.join(tmpDir, 'dry.err'),
          tmpDir,
          inRepoSandbox: Boolean(inRepoSandbox),
          repoWorkersDir: WORKERS,
          DRY: true,
          timeoutMs: seatTimeoutMs(seat, opts),
        });
        if (dryRes.outcome === 'not-installed') {
          io.fail('前置查重座位命令未安装：' + seat.command);
          return finish(2);
        }
        if (dryRes.outcome === 'missing-fail' || dryRes.outcome === 'missing-skip') {
          io.fail(dryRes.message);
          return finish(2);
        }
        io.log('[dry] 前置查重预演通过：seat=' + seatId + ' model=' + modelLabel + ' brief=' + briefRel + ' → ' + outRel);
        return finish(0);
      }
      const baseVar = process.env[seat.base_env_var || 'API_BASE_ENV'] || seat.base_env_default || 'OPENAI_BASE_URL';
      const keyVar = process.env[seat.key_env_var || 'API_KEY_ENV'] || seat.key_env_default || 'OPENAI_API_KEY';
      if (!process.env[baseVar] || !process.env[keyVar]) {
        io.fail('API 前置查重座位未配置环境变量（' + baseVar + ' / ' + keyVar + '）');
        return finish(2);
      }
      io.log('[dry] 前置查重预演通过：seat=' + seatId + '(api) model=' + modelLabel + ' brief=' + briefRel + ' → ' + outRel);
      return finish(0);
    }

    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    const stamp = compactStamp();
    const errLogRel = 'papers/novelty/last_novelty-' + sanitizeMetaToken(ideaId, 'idea') + '-' + stamp + '.err';
    const errLogAbs = path.join(root, errLogRel);
    fs.mkdirSync(path.dirname(errLogAbs), { recursive: true });
    const timeoutMs = seatTimeoutMs(seat, opts);

    io.log('前置查重启动：' + seatId + ' (' + modelLabel + ') 核查 ' + briefRel + ' → ' + outRel);

    if (effKind === 'cli') {
      const execRes = await invokeCliSeatProcess({
        root,
        seat,
        slotTag: seatId,
        voteModel,
        payloadFile,
        payloadText: fullPayload,
        outFile: outTmpFile,
        errFile: errLogAbs,
        tmpDir,
        inRepoSandbox: Boolean(inRepoSandbox),
        repoWorkersDir: WORKERS,
        DRY: false,
        timeoutMs,
        payloadPromptHint: (fname) => '请打开并完整阅读当前目录文件 ' + fname + '（或标准输入 stdin），仅针对其中的唯一候选工单执行外部查重，并严格输出单个 ```yaml 查重报告代码块。',
      });
      if (execRes.outcome === 'not-installed') {
        io.fail('前置查重座位命令未安装：' + seat.command);
        return finish(2);
      }
      if (execRes.outcome === 'missing-fail' || execRes.outcome === 'missing-skip') {
        io.fail(execRes.message);
        return finish(2);
      }
      if (!execRes.spawnRes || execRes.spawnRes.status !== 0) {
        keepErr(io, false, errLogAbs, false);
        io.fail(seatId + ' 前置查重执行失败（' + describeSpawn(execRes.spawnRes || {}) + '），诊断见 ' + errLogRel);
        return finish(2);
      }
    } else {
      const baseVar = process.env[seat.base_env_var || 'API_BASE_ENV'] || seat.base_env_default || 'OPENAI_BASE_URL';
      const keyVar = process.env[seat.key_env_var || 'API_KEY_ENV'] || seat.key_env_default || 'OPENAI_API_KEY';
      if (!process.env[baseVar] || !process.env[keyVar]) {
        io.fail('API 前置查重座位未配置环境变量（' + baseVar + ' / ' + keyVar + '）');
        return finish(2);
      }
      const tempCfg = seat.temperature && typeof seat.temperature === 'object' ? seat.temperature : null;
      const rawTemp = tempCfg ? (process.env[tempCfg.env || ''] ?? tempCfg.default ?? '') : '';
      const maxTokCfg = seat.max_tokens && typeof seat.max_tokens === 'object' ? seat.max_tokens : null;
      const rawMaxTok = maxTokCfg && maxTokCfg.env ? (process.env[maxTokCfg.env] || '') : (maxTokCfg && maxTokCfg.default ? String(maxTokCfg.default) : '');

      const apiRes = await apiChatCompletion({
        baseUrl: process.env[baseVar],
        apiKey: process.env[keyVar],
        model: modelLabel,
        payload: fullPayload,
        timeoutMs,
        maxTokens: rawMaxTok ? Number(rawMaxTok) : 4096,
        temperature: rawTemp !== '' ? Number(rawTemp) : null,
      });
      if (!apiRes.ok || !apiRes.content) {
        fs.writeFileSync(errLogAbs, maskSecrets(apiRes.stderr || ('API 前置查重调用失败 rc=' + apiRes.rc + '\n')), 'utf8');
        keepErr(io, false, errLogAbs, false);
        io.fail(seatId + ' API 前置查重失败（rc=' + apiRes.rc + '），诊断见 ' + errLogRel);
        return finish(2);
      }
      fs.writeFileSync(outTmpFile, apiRes.content + '\n', 'utf8');
    }

    const rawBody = fs.existsSync(outTmpFile) ? readText(outTmpFile) : '';
    const cleanBody = rawBody.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
    if (!cleanBody) {
      keepErr(io, false, errLogAbs, false);
      io.fail(seatId + ' 返回零输出，本次查重不落半成品文件' + (fs.existsSync(errLogAbs) ? '（见 ' + errLogRel + '）' : ''));
      return finish(2);
    }
    keepErr(io, true, errLogAbs, false);

    const briefSha = sha256File(briefAbs, 12);
    const metaHead = '<!-- meta role=novelty idea=' + sanitizeMetaToken(ideaId, 'idea')
      + ' seat=' + sanitizeMetaToken(seatId, 'novelty')
      + ' model=' + sanitizeMetaToken(modelLabel, seatId)
      + ' brief=' + sanitizeMetaPath(briefRel)
      + ' sha=' + briefSha
      + ' ts=' + isoSec()
      + (sameFamilyWarn ? (' warn=' + sanitizeMetaToken(sameFamilyWarn)) : '')
      + ' -->\n';

    const fullContent = metaHead + cleanBody + '\n';
    const checkDir = path.join(tmpDir, 'check-novelty');
    fs.mkdirSync(checkDir, { recursive: true });
    const candPath = path.join(checkDir, path.basename(outAbs));
    fs.writeFileSync(candPath, fullContent, 'utf8');

    const chk = checkNoveltyReport(candPath);
    if (!chk.ok) {
      const rejAbs = path.join(path.dirname(outAbs), 'rejected', path.basename(outAbs));
      const rejRel = path.relative(root, rejAbs).replace(/\\/g, '/');
      writeAtomic(rejAbs, fullContent);
      io.fail('查重报告未通过 checkNoveltyReport 校验闸门，已隔离至 ' + rejRel + '（未覆盖正式路径 ' + outRel + '）：');
      if (chk.stderr) io.err(chk.stderr);
      return finish(chk.rc || 1);
    }

    writeAtomic(outAbs, fullContent);
    io.log('查重报告已落盘并通过校验：' + outRel + '（duplication_risk=' + chk.data.duplication_risk + ', confidence=' + chk.data.confidence + '）');
    return finish(0);
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
    try { process.chdir(origCwd); } catch { /* 忽略 */ }
  }
}
