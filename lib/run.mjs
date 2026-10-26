// 一次调用跑完整轮分派：规划（谁去评、用哪个模型）→ 落地（调用、落卡、汇总、manifest）。
//
// 这是 dispatch/fanout.sh 的搬家终点。bash 那边只剩壳（参数与环境闸门），所有分派逻辑在
// 这一个程序里一次做完 —— 规划与执行不再分居两个语言、两份状态。
//
// 退出码契约（原样保留，改动前先看这里）：
//   0 正常出票   1 有后端失败/降级轮（票有效，只是不齐）；参数用错也走 1
//   2 基础设施不可用，一票未出   3 本轮作废   8 工单不合格（无可验收锚点）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadConfig, findSeat, seatIdentity, buildArgv, seatEnvName, apiModel, effectiveDefaultBackends, executorOverrideOf, seatKindOf, panelVotes } from './registry.mjs';
import { normModel } from './models.mjs';

const C = { log: '\x1b[36m', skip: '\x1b[33m', fail: '\x1b[31m', off: '\x1b[0m' };

export function makeIO(root) {
  const out = (s) => process.stdout.write(s + '\n');
  const io = {
    root,
    log: (s) => out(C.log + '== ' + s + C.off),
    skip: (s) => out(C.skip + '-- ' + s + C.off),
    fail: (s) => out(C.fail + '!! ' + s + C.off),
    plain: (s) => out(s),
    err: (s) => process.stderr.write(s + '\n'),
  };
  return io;
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

// 这台机器上 `bash` 在 PATH 里可能指向 WSL 转发器（实测 C:\\WINDOWS\\system32\\bash.exe），
// 而 WSL 在这个仓库里是被机制级拒绝的。所以只用调用方显式交过来的那个 bash：
// dispatch/fanout.sh 与 dispatch/models.sh 都会 export DSH_DISPATCH_BASH="$BASH"。
export function bashBin() {
  return process.env.DSH_DISPATCH_BASH || process.env.RESEARCH_DISPATCH_BASH || 'bash';
}

// 外部 CLI 一律经 bash 解析与执行：
//   ① Windows 的 CreateProcess 不认 shebang，直接 spawn 一个 #!/bin/bash 的假件会 ENOENT；
//   ② npm 装的 codex/claude 在 Git Bash 里是 sh 脚本，同样过不了 CreateProcess。
// 经 bash -c 'exec "$0" "$@"' 之后，解析规则与旧版脚本（bash 里直接调命令）逐字一致。
export function resolveCmd(cmd) {
  if (!cmd) return null;
  const r = spawnSync(bashBin(), ['-c', 'command -v "$1"', 'x', cmd], { encoding: 'utf8' });
  if (r.error) return null;
  const out = (r.stdout || '').trim();
  return r.status === 0 && out ? out : null;
}

// 与 bash 的 $(cat f | sed ...) 同义：剥 BOM、剥 meta 行、去掉尾部空行。
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

// 卡与 manifest 都先写同目录临时文件再 rename：读者要么看到旧的、要么看到完整的，
// 不会读到写了一半的 meta 头。临时文件与目标同目录，避免跨盘 rename 失败。
// 每个 CLI/api 座的临时目录：挂在 process.on('exit') 的清理表上，别每轮往 TEMP 里留一份正文。
const CARD_TMPDIRS = [];

function mkCardTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'card.'));
  CARD_TMPDIRS.push(d);
  return path.join(d, 'body.md');
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function exitWith(code) {
  process.exitCode = code;
  return code;
}

// 外部 CLI 单次调用上限：大工单 + 慢模型的经验上界是十来分钟。没有它，模型一卡住派工进程
// 就永久挂起（宿主里这次调用也跟着挂），而退出码契约里没有第三种"挂着"。
const CLI_TIMEOUT_MS = 15 * 60 * 1000;

// spawn 失败时 status 是 null，唯一线索在 r.error / r.signal —— 不读它，
// "进程根本没起来"和"起来了没输出"在日志里长得一模一样，.err 还往往是空的。
function describeSpawn(r) {
  const bits = [];
  if (r.error) bits.push('error=' + (r.error.code || r.error.message));
  if (r.signal) bits.push('signal=' + r.signal);
  bits.push('status=' + (r.status === null || r.status === undefined ? 'null' : r.status));
  return bits.join(' ');
}

// 座位表里的路径（cards_dir / workers_dir / role_file / anchor_checker / card_validator）
// 都来自可被设置面板或 DSH_DISPATCH_CONFIG 指向的 JSON，必须钉在仓库根内：越界等于把
// "读哪个文件进 prompt""往哪写卡"交给了配置。root 自身放行；返回原值，保持既有输出与
// 相对路径语义逐字节不变（调用方 cwd 已经是 root）。
// 座位的实际执行方式：唯一实现在 registry.seatKindOf（诊断 / 派工 / 票数统计共用一份）。
// 面板可把任何座位切到 cli/api/subagent（只切 kind，命令仍来自座位表）。

// 这座出几票。api 座由 API_VOTES 控制；被面板切成 api 的其它座没有 votes 字段，
// 按 1 票算（它也只可能跑一次），绝不能让 undefined 变成 NaN 把比较全变成 false。
function apiVotesOf(seat) {
  if (!seat || !seat.votes) return 1;
  return Number(process.env[seat.votes.env] || seat.votes.default);
}

function assertInside(root, where, p) {
  const base = path.resolve(root);
  const abs = path.resolve(base, p);
  if (abs === base || abs.startsWith(base + path.sep)) return p;
  const err = new Error('座位表 paths.' + where + ' 越出仓库根：' + p + ' → ' + abs + '（只允许仓库内路径）');
  err.code = 'BAD_CONFIG';
  throw err;
}

export async function run(opts) {
  const { root, briefArg } = opts;
  const io = makeIO(root);
  process.chdir(root);
  if (!process.env.DSH_PERMISSION_MODE) process.env.DSH_PERMISSION_MODE = 'read-only';
  const DRY = (process.env.DRY || '0') === '1';

  const cfg = loadConfig(root);
  const P = cfg.paths || {};
  const CARDS = assertInside(root, 'cards_dir', P.cards_dir || 'ideas/cards');
  const WORKERS = assertInside(root, 'workers_dir', P.workers_dir || 'workers');

  let BRIEF = briefArg;
  if (!(path.isAbsolute(BRIEF) || /^[A-Za-z]:/.test(BRIEF))) BRIEF = path.join(root, BRIEF);
  if (!fs.existsSync(BRIEF) || !fs.statSync(BRIEF).isFile()) {
    io.plain('找不到 brief: ' + BRIEF);
    return exitWith(1);
  }
  BRIEF = path.resolve(BRIEF).replace(/\\/g, '/');
  const ID = path.basename(BRIEF, '.md');

  // ── 工单必须带着可验收的锚点出处来评审 ────────────────────────────────
  const gate = anchorGate({ io, cfg, BRIEF, ID, root });
  if (!gate.ok) return exitWith(gate.infra ? 2 : 8);
  const ANCHOR_TAG = gate.anchorTag;
  const warnTag = gate.warnTag;

  // 同一单同时只许一个派工进程：卡片与 manifest 都是"读盘→改→写盘"，两个进程交错会写出
  // 半截卡，或把对方刚写的卡 rename 走（汇总里就少一票）。锁文件落盘，进程正常退出即删。
  let LOCK = '';
  if (!DRY && !process.env.SHOW_PAYLOAD_TO) {
    fs.mkdirSync(CARDS, { recursive: true });
    fs.mkdirSync(WORKERS, { recursive: true });
    LOCK = path.join(CARDS, ID + '.lock');
    try {
      fs.closeSync(fs.openSync(LOCK, 'wx'));
    } catch {
      io.fail('同一单已有派工在跑（锁：' + LOCK + '）—— 等它跑完再试；确认没有进程在跑，删掉这个文件即可');
      return exitWith(2);
    }
    process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch { /* 已不在 */ } });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload.'));
  const PAYLOAD_FILE = path.join(tmpDir, 'payload.txt');
  const roleFile = assertInside(root, 'role_file', P.role_file || 'roles/reviewer.md');
  fs.writeFileSync(PAYLOAD_FILE, buildPayload(readText(path.join(root, roleFile)), readText(BRIEF)));
  const cleanup = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    for (const d of CARD_TMPDIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  };
  process.on('exit', cleanup);

  const FANOUT_PAYLOAD_SHA = sha256File(PAYLOAD_FILE, 16);
  process.env.FANOUT_PAYLOAD_SHA = FANOUT_PAYLOAD_SHA;

  if (process.env.SHOW_PAYLOAD_TO) {
    const dest = process.env.SHOW_PAYLOAD_TO;
    try {
      fs.copyFileSync(PAYLOAD_FILE, dest);
    } catch {
      io.err('!! 写不了 ' + dest);
      return exitWith(2);
    }
    const bytes = fs.statSync(PAYLOAD_FILE).size;
    io.plain('== payload 副本 → ' + dest + '（' + bytes + ' 字节 sha=' + FANOUT_PAYLOAD_SHA + '）。已退出：未派工、未动盘');
    io.plain('   署名票要把这份 sha 随答案一起交回 —— 它证明你回答的就是这份字节，而不是被改软过的一版问题。');
    return exitWith(0);
  }

  const BSHA = sha256File(BRIEF, 12);
  const defaultBackends = effectiveDefaultBackends(cfg).join(' ');
  let BACKENDS = process.env.BACKENDS || defaultBackends;
  let backendList = BACKENDS.split(/\s+/).filter(Boolean);

  // 面板里的评审票（可增删）：exec:model 列表。这里只做"映射到已有座位"。
  // 同一执行者出现多次会被合并成一张卡 —— 脚本会当面说清，不静默少票。
  const votes = panelVotes();
  const voteModels = new Map();
  if (votes.length > 0 && !process.env.BACKENDS) {
    const mapped = [];
    for (const v of votes) {
      const seatId = cfg.seats.some((s) => s.id === v.executor) ? v.executor
        : (cfg.seats.find((s) => s.command === v.executor) || {}).id;
      if (!seatId) { io.skip('面板票里的执行者 ' + v.executor + ' 没有对应座位，已跳过'); continue; }
      if (mapped.includes(seatId)) { io.fail('同一执行者 ' + v.executor + ' 被排了多票 —— 现在只能合成一张卡，这一票不会单独出，请换一个执行者'); continue; }
      mapped.push(seatId);
      if (v.model) voteModels.set(seatId, v.model);
    }
    if (mapped.length) { backendList = mapped; BACKENDS = mapped.join(' '); }
  }

  const ctxBase = { payloadSha: FANOUT_PAYLOAD_SHA, workersDir: WORKERS, payloadFile: PAYLOAD_FILE };

  // ── 开跑前预检：用与塌缩断言同一个 normModel 预测这轮会不会作废 ──────────
  const PRIOR_PLAN = [];
  for (const be of backendList) {
    const seat = findSeat(cfg, be);
    // 每票的模型：注入该座位的显式模型环境变量。座位之间互不共用变量名，
    // 且本进程跑完即退出，所以不做还原（写回来反而多一处可变状态）。
    if (seat && voteModels.has(be)) {
      const envKey = (seat.identity && seat.identity.explicit_env) || '';
      if (envKey) process.env[envKey] = voteModels.get(be);
    }
    // enabled:false 只影响展示层（按设计）：显式点名照跑是既有行为，但必须留痕，
    // 否则「座位表说停用、实跑在跑」两套口径谁也看不见。
    if (seat && seat.enabled === false) io.skip(be + ' 在座位表里是 enabled:false（停用）—— 因显式点名照跑；若非本意，改 dispatch/seats.json 或换座位');
    if (!seat) {
      io.fail('未知后端: ' + be + '（可选 ' + cfg.seats.map((s) => s.id).join(' ') + '）');
      continue;
    }
    PRIOR_PLAN.push(normModel(seatIdentity(seat, { ...ctxBase, seat: be })));
  }
  const uniq = [];
  for (const p of PRIOR_PLAN) if (!uniq.includes(p)) uniq.push(p);
  const N_UNIQ_PLAN = uniq.length;
  let N_PROVEN_PLAN = 0;
  for (const be of backendList) {
    const seat = findSeat(cfg, be);
    if (seat && seatKindOf(seat) === 'api') N_PROVEN_PLAN += apiVotesOf(seat);
    else N_PROVEN_PLAN += 1;
  }
  if (N_UNIQ_PLAN < N_PROVEN_PLAN && N_PROVEN_PLAN >= 2 && process.env.ALLOW_DOOMED_PLAN !== '1') {
    const UNK_N = PRIOR_PLAN.filter((p) => p === 'unknown-check-config').length;
    io.plain('✗ 计划后端 ' + BACKENDS + ' 按塌缩断言的归一化只有 ' + N_UNIQ_PLAN + ' 个独立先验（ ' + PRIOR_PLAN.join(' ') + '），却要出 ' + N_PROVEN_PLAN + ' 票');
    if (UNK_N > 0) {
      const readable = PRIOR_PLAN.filter((p) => p !== 'unknown-check-config');
      const rUniq = [];
      for (const p of readable) if (!rUniq.includes(p)) rUniq.push(p);
      const rVote = N_PROVEN_PLAN - UNK_N;
      if (rUniq.length >= rVote) {
        io.plain('  其中 ' + UNK_N + ' 格配置读不出，可读部分并无同模型重复 —— 真跑会记『异构性不可证』');
        io.plain('  而不是作废；拦在开跑前是因为这一轮拿不出可证的异构性。先修配置再跑。');
      } else {
        io.plain('  其中 ' + UNK_N + ' 格配置读不出 —— 那部分真跑记『异构性不可证』而非作废；其余格子');
        io.plain('  确有同模型重复，塌缩断言必判作废 —— 别先花 N 次调用。');
      }
    } else {
      io.plain('  这种轮次一定被票源塌缩判作废 —— 别先花 N 次调用。');
    }
    io.plain('  加一家不同模型的，或显式 ALLOW_DOOMED_PLAN=1（明知这轮过不了异构性证明、只为看输出时再用）');
    return exitWith(2);
  }

  // ── 陈旧卡隔离 ────────────────────────────────────────────────────────
  if (!DRY && fs.existsSync(CARDS)) {
    for (const f of fs.readdirSync(CARDS)) {
      if (!f.startsWith(ID + '.') || !f.endsWith('.md')) continue;
      quarantineStale({ io, CARDS, ID, BSHA, seat: f.slice(ID.length + 1, -3), DRY });
    }
  }

  const FAILED = [];
  const SKIPPED = [];
  let VOID = '';
  // 校验器不可用 → 这轮判不了，必须退 2（基础设施），不许混进"卡不合格"或"降级轮"。
  let INFRA = '';

  const cardFiles = () => {
    if (!fs.existsSync(CARDS)) return [];
    return fs.readdirSync(CARDS).filter((f) => f.startsWith(ID + '.') && f.endsWith('.md'))
      .sort().map((f) => path.join(CARDS, f));
  };

  // 本轮**真的写下**的卡（座位 tag）。判定汇总只拿它当"这一轮产出的票"；
  // 盘上其余同指纹卡是更早一轮的产物（ADOPTED），两者在 status 上必须分得开。
  const PRODUCED = [];
  const emit = (tag, bodyFile, model, declared) => {
    const card = path.join(CARDS, ID + '.' + tag + '.md');
    if (DRY) {
      io.log('[dry] 将写 ' + card + '  model=' + model + (declared ? ' declared=' + declared : ''));
      PRODUCED.push(tag);
      return { ok: true, code: 0 };
    }
    const head = '<!-- meta backend=' + tag + ' brief=' + BRIEF + ' sha=' + BSHA + ' model=' + model +
      ' ts=' + isoSec() + (declared ? ' declared=' + declared : '') + ' -->\n';
    writeAtomic(card, head + readText(bodyFile));
    io.log('已写 ' + card);
    const rc = checkCard(root, P, card);
    if (rc === 0) { PRODUCED.push(tag); return { ok: true, code: 0 }; }
    if (rc === 2) {
      INFRA = 'validator-unavailable';
      io.fail('校验器不可用 → 不是卡的问题，按基础设施失败处理（退 2）');
      return { ok: false, code: 2, reason: 'validator-unavailable' };
    }
    if (rc !== 1) {
      io.fail('校验器异常（退出码 ' + rc + '），拒绝把『闸门坏了』记成『卡不合格』→ 本轮作废');
      return { ok: false, code: 3, reason: 'validator' };
    }
    fs.mkdirSync(path.join(CARDS, 'rejected'), { recursive: true });
    fs.renameSync(card, path.join(CARDS, 'rejected', path.basename(card) + '.rejected'));
    io.fail(tag + ' 卡未通过校验 → 移入 ' + CARDS + '/rejected/，这一票不计数');
    return { ok: false, code: 1, reason: tag + '-invalid-card' };
  };

  for (const be of backendList) {
    const seat = findSeat(cfg, be);
    if (!seat) {
      io.fail('未知后端: ' + be + '（可选 ' + cfg.seats.map((s) => s.id).join(' ') + '）');
      FAILED.push(be);
      continue;
    }
    // 面板可以把一个座位切到别的执行方式（只切 kind，命令/argv 仍来自座位表）。
    const ov = executorOverrideOf(seat);
    const kind = seatKindOf(seat);
    if (ov && ov !== seat.kind) io.skip(be + ' 座的执行方式被设置面板改为 ' + ov + '（座位表里是 ' + seat.kind + '）');
    if (kind === 'cli') {
      await runCliSeat({ io, cfg, seat, be, ID, CARDS, BRIEF, PAYLOAD_FILE, DRY, FAILED, SKIPPED, emit, ctxBase, setVoid: (v) => { if (v) VOID = v; } });
    } else if (kind === 'api') {
      await runApiSeat({ io, cfg, seat, be, ID, CARDS, PAYLOAD_FILE, DRY, FAILED, SKIPPED, emit, ctxBase });
    } else if (kind === 'delivery') {
      runDeliverySeat({ io, seat, be, ID, CARDS, BRIEF, DRY, FAILED, SKIPPED, emit, ctxBase });
    } else {
      io.fail('座位 ' + be + ' 的 kind=' + seat.kind + ' 不认识（可选 cli / api / delivery）');
      FAILED.push(be);
    }
  }

  // ── 汇总：以磁盘上的卡为唯一事实来源 ──────────────────────────────────
  // DRY 预演照样把盘上的卡过一遍（"这轮会不会被判废/被隔离"正是预演要看的东西），
  // 但绝不许把它们说成"这一轮的票"：预演没有产出，票数是盘上现状，不是本轮结果。
  io.plain('');
  io.log('判定汇总 ' + ID);
  const files = cardFiles();
  if (files.length > 0) {
    for (const f of files) {
      for (const line of readText(f).split('\n')) {
        if (/^[ \t]*verdict:|^[ \t]*kill_reason:|^[ \t]*confidence:/.test(line)) io.plain(f + ':' + line);
      }
    }
  } else {
    io.plain('  （无卡可汇总：所有后端都没成功）');
  }

  let N_EXPECTED = 0;
  for (const be of backendList) {
    const seat = findSeat(cfg, be);
    if (seat && seatKindOf(seat) === 'api') N_EXPECTED += apiVotesOf(seat);
    else N_EXPECTED += 1;
  }
  let EXITCODE = 0;
  let STATUS = 'OK';
  let UNIQ = 0;
  let UNKNOWN = 0;
  const VOTES = [];
  const ADOPTED = [];          // 计入有效票、但不是本轮产出的座位（更早一轮留下的同指纹卡）
  const SEEN_M = [];
  const PRODUCED_SET = new Set(PRODUCED);
  const whitelist = buildWhitelist(cfg);

  for (const f of files) {
    let rc = 0;
    try { rc = checkCard(root, P, f); } catch { rc = 3; }
    if (rc === 2) { INFRA = 'validator-unavailable'; continue; }
    if (rc === 3) {
      io.fail('校验器自身异常(rc=3)于 ' + path.basename(f) + ' → 闸门坏了绝不记成\'卡不合格\'，本轮作废');
      VOID = 'validator-rc3';
      continue;
    }
    if (rc !== 0) {
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
    const m = first.match(/ model=(.*) ts=/);
    const mdl = m ? m[1] : '';
    VOTES.push(be);
    // 旧卡点名带当时的 model（按设计）：同指纹旧卡被采纳时模型可能已换配置，
    // 光写座位名看不出「这票是旧模型打的」。
    if (!PRODUCED_SET.has(be)) ADOPTED.push(be + (mdl ? '=' + mdl : ''));
    const n = normModel(mdl || 'unknown-check-config');
    if (n === 'unknown-check-config') { UNKNOWN += 1; continue; }
    if (!SEEN_M.includes(n)) { SEEN_M.push(n); UNIQ += 1; }
  }
  if (INFRA) {
    io.fail('校验器不可用（' + INFRA + '）→ 本轮票无法判定：不写 manifest、按基础设施失败退 2');
    return exitWith(2);
  }
  if (VOTES.length > 0) {
    if (DRY) {
      // 同一行文字在预演里就是另一件事：这里的票来自盘上，本轮什么都没产出。
      io.skip('盘上现有票 ' + VOTES.length + '（' + VOTES.join(' ') + '），独立先验 ' + UNIQ
        + ' 个：' + SEEN_M.join(' ') + ' —— DRY 预演：这些不是这一轮的票');
    } else {
      io.log('有效票 ' + VOTES.length + '（' + VOTES.join(' ') + '），独立先验 ' + UNIQ + ' 个：' + SEEN_M.join(' '));
    }
  }

  // 有效票必须分成两类报：本轮产出的，与更早一轮留下、指纹仍对得上的（设计上承认
  // 它们有效 —— 同一份工单重跑不该重烧钱）。后者不许再和"这一轮每家都产出了"长得一样：
  // 旧版 BACKENDS=codex 的一轮会汇总出三票共识，而其中两票属于别的模型、别的时点。
  if (ADOPTED.length > 0) {
    io.fail('其中 ' + ADOPTED.length + ' 票不是本轮产出的（同指纹旧卡）：' + ADOPTED.join(' ')
      + ' —— 它们是这份工单的票，但不是这一次调用的产出');
  }
  if (!DRY && N_EXPECTED > 0 && VOTES.length === 0) {
    io.fail('本轮一票都没产出来（计划 ' + N_EXPECTED + ' 票，后端：' + BACKENDS + '；缺失：'
      + (SKIPPED.join(' ') || '无') + ' ' + (FAILED.join(' ') || '无') + '）');
    io.fail('  → 这既不是"降级轮"，也不是"没人反对"：它等于这一轮没跑过。修好后端再重跑');
    STATUS = 'NO-OUTPUT(0/' + N_EXPECTED + ')';
    EXITCODE = 2;
  } else if (!DRY && VOTES.length < N_EXPECTED) {
    io.fail('只凑到 ' + VOTES.length + ' 票，计划 ' + N_EXPECTED + ' 票（后端：' + BACKENDS + '）（缺失：' + (SKIPPED.join(' ') || '无') + ' ' + (FAILED.join(' ') || '无') + '）');
    io.fail('  → 降级轮。少票合法，但**别把它的结论当成\'三家共识\'**，更别据此判某个 idea 无人反对');
    STATUS = 'PARTIAL(' + VOTES.length + '/' + N_EXPECTED + ')';
  } else if (!DRY && N_EXPECTED > 0 && VOTES.length > N_EXPECTED) {
    io.fail('有效票 ' + VOTES.length + ' 多于计划 ' + N_EXPECTED + ' 票（后端：' + BACKENDS + '）—— 多出来的不是这一轮排的座位');
    STATUS = 'OVER-COUNT(' + VOTES.length + '>' + N_EXPECTED + ')';
    if (EXITCODE === 0) EXITCODE = 1;
  }
  // 本轮零产出、但盘上有同指纹旧卡：票仍有效，但不许让 status 看起来像"这一轮跑过"。
  if (!DRY && PRODUCED.length === 0 && VOTES.length > 0) {
    io.fail('本轮零产出 —— 这 ' + VOTES.length + ' 票全部来自更早一轮（同指纹旧卡），status 不按本轮通过记');
    STATUS = (STATUS === 'OK' ? '' : STATUS + '+') + 'ADOPTED-ONLY(' + VOTES.length + '/' + N_EXPECTED + ')';
    if (EXITCODE === 0) EXITCODE = 1;
  } else if (!DRY && ADOPTED.length > 0) {
    STATUS = (STATUS === 'OK' ? '' : STATUS + '+') + 'ADOPTED(' + ADOPTED.length + ')';
  }
  if (UNKNOWN > 0) {
    io.fail('有 ' + UNKNOWN + ' 票的模型身份读不出来 → 本轮异构性【不可证】');
    io.fail('  两种成因分开查：① 某家 CLI 的配置路径变了（head -1 ' + CARDS + '/' + ID + '.*.md 看 model= 字段）');
    io.fail('  ② qoder 代写位【恒】不可证 —— 自报身份没有配置可回读，看 meta 的 declared= 是谁自报的');
    STATUS = (STATUS === 'OK' ? '' : STATUS + '+') + 'UNPROVEN-IDENTITY(' + UNKNOWN + ')';
  }
  const PROVEN = VOTES.length - UNKNOWN;
  if (PROVEN >= 2 && UNIQ < PROVEN) {
    io.fail('票源塌缩：' + PROVEN + ' 票可证但只有 ' + UNIQ + ' 个独立先验 —— 判本轮作废');
    io.fail('排查：DRY=1 bash dispatch/fanout.sh ' + (opts.briefArg || BRIEF) + ' 看各家 meta；成因多为模型别名被改指向同一家');
    STATUS = 'VOID(collapse ' + UNIQ + '<' + PROVEN + ')';
    EXITCODE = 3;
  }
  if (STATUS === 'OK' && VOTES.length === 1) {
    STATUS = 'OK(single-vote ' + VOTES[0] + ')';
    io.skip('本轮只有 1 票（' + VOTES[0] + '）—— status 记成 OK(single-vote)，别按共识读');
  }
  if (VOID) { STATUS = 'VOID(' + VOID + ')'; EXITCODE = 3; }

  if (!DRY) {
    const lines = [];
    lines.push('<!-- manifest schema=2 ' + isoSec() + ' brief=' + BRIEF + ' sha=' + BSHA + ' status=' + STATUS + ' -->');
    lines.push('votes: ' + (VOTES.join(' ') || 'none'));
    lines.push('priors: ' + (SEEN_M.join(' ') || 'none'));
    // 本轮真的写下的座位（与 votes: 分开）：读 manifest 的人一眼能看出"哪些票是这一次的"
    lines.push('produced: ' + (PRODUCED.join(' ') || 'none'));
    lines.push('anchor: ' + (ANCHOR_TAG || 'none'));
    if (warnTag) lines.push('provenance: ' + warnTag);
    if (VOID) lines.push('void_reason: ' + VOID);
    for (const f of files) {
      // 汇总循环里可能已经把不合格/未知座位的卡移进 rejected/ —— 再读它就是 ENOENT。
      // 旧版脚本在这里有 [ -f "$f" ] 守卫，漏掉它会让"写到 manifest 之前"整轮崩掉，
      // 而崩溃的退出码恰好是 1，看起来像"正常降级"，manifest 却根本不存在。
      if (!fs.existsSync(f)) continue;
      for (const line of readText(f).split('\n')) {
        if (/^[ \t]*verdict:/.test(line)) {
          lines.push(path.basename(f).slice(ID.length + 1, -3) + ' → ' + line);
        }
      }
    }
    writeAtomic(path.join(CARDS, ID + '.manifest'), lines.join('\n') + '\n');
    io.log('manifest → ' + CARDS + '/' + ID + '.manifest  status=' + STATUS);
  }

  if (/^VOID/.test(STATUS)) {
    if (DRY) {
      io.skip('DRY：本轮 ' + STATUS + ' —— 真跑时会把卡片移入 rejected/*.void，预演不动盘');
    } else {
      fs.mkdirSync(path.join(CARDS, 'rejected'), { recursive: true });
      for (const f of files) {
        try { fs.renameSync(f, path.join(CARDS, 'rejected', path.basename(f) + '.void')); } catch { /* 已不在 */ }
      }
      io.fail('本轮 ' + STATUS + '：卡片已移入 rejected/*.void，后续汇总不会误用');
    }
  }

  if (SKIPPED.length > 0) io.skip('已跳过: ' + SKIPPED.join(' '));
  if (FAILED.length > 0) {
    io.fail('执行失败: ' + FAILED.join(' ') + '   ← 真失败，必须看 .err/rejected');
    if (EXITCODE === 0) EXITCODE = 1;
  }
  io.plain('');
  io.plain('下一步：读 ' + CARDS + '/' + ID + '.manifest 与各家卡，你自己写 ideas/verdict-' + ID + '.md（约束 2：裁决权不下放）');
  return exitWith(EXITCODE);
}

function buildWhitelist(cfg) {
  const ids = [];
  const patterns = [];
  for (const s of cfg.seats) {
    if (s.seat_pattern) patterns.push(new RegExp('^' + s.seat_pattern + '$'));
    else ids.push(s.id);
    if (s.kind === 'api') ids.push(s.id + '[0-9]+');
  }
  const exact = new Set(ids.filter((i) => !/[0-9]\+\]/.test(i) && !/\[\]/.test(i)));
  const numeric = ids.filter((i) => /\[0-9\]\+|\[\]/.test(i)).map((i) => new RegExp('^' + i + '$'));
  return (be) => exact.has(be) || numeric.some((r) => r.test(be)) || patterns.some((r) => r.test(be));
}

// 校验器命令的三种合法写法：数组（逐项，不切分）、带引号的路径（可含空格）、旧的单行
// "命令 参数"（保持 seats.json 现状）。只对最后一种做切分 —— C:/Program Files/... 会被
// 空白切坏，那是"尺子装不上"，不是"卡不合格"。
function validatorArgv(P) {
  const v = P.card_validator;
  if (Array.isArray(v) && v.length) return v.map(String);
  const s = String(v || 'python dispatch/check_card.py').trim();
  const q = s.match(/^"([^"]+)"\s*(.*)$/);
  if (q) return [q[1], ...(q[2] ? q[2].split(/\s+/) : [])];
  return s.split(/\s+/);
}

// 返回码：0 合格 | 1 卡不合格（校验器裁决）| 3 校验器自己报异常 | 2 我们根本起不来它。
// 2 与 3 都不许记成"卡不合格"：前者是基础设施不可用（退 2），后者是尺子坏了（本轮作废）。
function checkCard(root, P, card) {
  const cmd = validatorArgv(P);
  // 过仓库根约束的只有"像路径"的那几段：有参数时 cmd[0] 是 PATH 里解析的解释器（python），
  // 它不在仓库里也不算越界；但配置只写一个 token 时，那个 token 本身就是校验器路径，
  // 必须查 —— 否则 card_validator 写成 "../../evil.py" 时这道断言形同虚设。
  for (const seg of (cmd.length > 1 ? cmd.slice(1) : cmd)) assertInside(root, 'card_validator', seg);
  const r = spawnSync(cmd[0], [...cmd.slice(1), card, '--quiet'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error || r.status === 126 || r.status === 127) {
    process.stderr.write('⚠ card_validator 不可用（' + (r.error ? (r.error.code || r.error.message) : 'status=' + r.status) + '）：' + cmd[0] + '\n');
    return 2;
  }
  return r.status === null ? 3 : r.status;
}

function quarantineStale({ io, CARDS, ID, BSHA, seat, DRY }) {
  const card = path.join(CARDS, ID + '.' + seat + '.md');
  if (!fs.existsSync(card)) return;
  const first = (readText(card).split('\n')[0] || '');
  const m = first.match(/ sha=([0-9a-f]*) /);
  const old = m ? m[1] : '';
  if (old === BSHA) return;
  if (DRY) return;
  fs.mkdirSync(path.join(CARDS, 'stale'), { recursive: true });
  fs.renameSync(card, path.join(CARDS, 'stale', ID + '.' + seat + '.md.' + (old || 'no-sha')));
  io.skip(seat + ' 的卡 brief 指纹是 ' + (old || '<缺失>') + '、当前是 ' + BSHA + ' → 移入 cards/stale/，不混入本轮');
}

function anchorGate({ io, cfg, BRIEF, ID, root }) {
  const firstLine = (readText(BRIEF).split('\n')[0] || '').replace(/^\uFEFF/, '').replace(/\r$/, '');
  let anchor = '';
  const am = firstLine.match(/ anchor=(.*) -->$/);
  if (am) anchor = am[1];
  let warnTag = '';
  const wm = firstLine.match(/[ \t](warn=[^ ]*).* anchor=.*/);
  if (wm) warnTag = wm[1];
  if (!anchor) {
    io.fail('工单 ' + ID + ' 没有 anchor= 出处行 —— 手写 brief 不进评审');
    io.plain('   出处行由 make_briefs 注入。正解：bash dispatch/make_briefs.sh <idea池> --baseline <锚点目录>');
    io.plain('   （锚点目录不必在 baselines/ 下：--baseline 给什么路径，出处行就写什么路径。）');
    return { ok: false };
  }
  const body = readText(BRIEF);
  // 终止锚：Idea 子标题，或文件真正结束（用 (?!\S\s) 语义而不是 $ —— m 模式下 $ 是行尾，
  // 那会把 Baseline 段当场截成空串，表现为"工单没带 Baseline 段"的误判）。
  const bsecMatch = body.match(/^###[ \t]*Baseline[^\n]*\n([\s\S]*?)(?=^###[ \t]*Idea|(?![\s\S]))/m);
  const bsec = bsecMatch ? bsecMatch[1] : '';
  if (!bsec.replace(/\s/g, '')) {
    io.fail('工单 ' + ID + ' 没带上 ### Baseline 段（anchor= 只证明尺子存在，不证明内容进来了）');
    return { ok: false };
  }
  if (!/[0-9]/.test(bsec)) {
    io.fail('工单 ' + ID + ' 的 Baseline 段没有任何数值 —— 没有数的锚点不可证伪');
    return { ok: false };
  }
  const checker = assertInside(root, 'anchor_checker', (cfg.paths && cfg.paths.anchor_checker) || 'dispatch/anchor_check.sh');
  const r = spawnSync(bashBin(), [checker, anchor], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (!r.error && r.status === 0) return { ok: true, anchorTag: anchor + ':signed', warnTag };
  // 检查器自己跑不起来（文件不在 / 没执行位 / bash 起不来）与"跑了并拒绝"必须分开：
  // 前者是尺子坏了（基础设施，退 2），后者才是工单不合格（退 8）。126/127 是 bash 的
  // "不能执行/找不到"，与 r.error 同属"我们没起来它"。
  if (r.error || r.status === 126 || r.status === 127) {
    const why = r.error ? (r.error.code || r.error.message) : ('status=' + r.status);
    io.fail('锚点检查器不可用（' + why + '）：' + checker + ' —— 不是工单的问题，是这把尺子没装上');
    const firstErr = (r.stderr || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
    if (firstErr) io.plain('   stderr: ' + firstErr);
    return { ok: false, infra: true };
  }
  if (/^(smoke_|calib_)/.test(ID)) {
    if (process.env.CALIBRATION === '1') {
      io.skip('校准轮 ' + ID + ' 的锚点未验收（' + anchor + '）—— CALIBRATION=1 已显式强过');
      io.plain('   这一轮的 baseline_fit 只是素材，别当共识读；痕迹已写进 manifest 的 anchor: 行。');
      return { ok: true, anchorTag: 'unverified-calibration ' + anchor, warnTag };
    }
    io.fail('校准轮 ' + ID + ' 的锚点未通过 anchor_check（' + anchor + '）—— 拒出票');
    io.plain('   要么按 baselines/TEMPLATE.REPRO.md 复现并签字，要么显式 CALIBRATION=1 承认这是无锚点校准。');
    return { ok: false };
  }
  io.fail('工单 ' + ID + ' 的锚点未通过 anchor_check（' + anchor + '）—— 没校过的尺子进不了评审');
  io.plain('   生成路径（diverge/make_briefs）是同一道闸门：先按 baselines/TEMPLATE.REPRO.md 复现并签字。');
  io.plain('   （CALIBRATION=1 只豁免 smoke_/calib_ 前缀的校准轮，不豁免真课题工单。）');
  return { ok: false };
}

function keepErr(io, ok, errFile, DRY) {
  if (!fs.existsSync(errFile)) return;
  if (DRY) { try { fs.rmSync(errFile); } catch { /* 忽略 */ } return; }
  if (ok) { try { fs.rmSync(errFile); } catch { /* 忽略 */ } return; }
  const lines = readText(errFile).split('\n');
  fs.writeFileSync(errFile, lines.slice(-201).join('\n'));
}

async function runCliSeat(a) {
  const { io, cfg, seat, be, ID, CARDS, BRIEF, PAYLOAD_FILE, DRY, FAILED, SKIPPED, emit, ctxBase } = a;
  const payloadText = readText(PAYLOAD_FILE);
  let patch = '';
  if (seat.patch_env || seat.patch_default) {
    patch = process.env[seat.patch_env || ''] || seat.patch_default || '';
  }
  if (seat.require_file) {
    const need = (seat.require_file.path || '').replace('{patch}', patch);
    if (!fs.existsSync(need)) {
      io.fail((seat.require_file.note || '找不到 {path}').replace('{patch}', patch));
      SKIPPED.push(be);
      return;
    }
  }
  if (!resolveCmd(seat.command)) {
    io.skip(be + ' 未安装');
    SKIPPED.push(be);
    return;
  }
  const tmp = mkCardTmp();
  const ERR = path.join(CARDS, ID + '.' + be + '.err');
  // DRY 下诊断走临时文件：预演绝不能截断上一轮留下的真 .err（旧版脚本踩过这个坑）。
  const errFile = DRY ? path.join(path.dirname(tmp), 'dry.err') : ERR;
  const ctx = { ...ctxBase, tmp, payloadText, patch };
  const argv = buildArgv(seat, ctx);
  io.log(be + ' 评审 ' + ID);
  if (DRY) {
    io.plain('  [dry] ' + seat.command + ' ' + argv.map((x) => (x === payloadText ? '<payload>' : x)).join(' ') + ' 2> ' + ERR);
  }
  const stdio = [
    seat.payload_position === 'stdin' ? fs.openSync(PAYLOAD_FILE, 'r') : 'ignore',
    seat.output === 'file' ? 'inherit' : fs.openSync(tmp, 'w'),
    fs.openSync(errFile, 'w'),
  ];
  const r = DRY ? { status: 0 } : spawnSync(bashBin(), ['-c', 'exec "$0" "$@"', seat.command, ...argv], { cwd: process.cwd(), stdio, timeout: CLI_TIMEOUT_MS });
  try { if (typeof stdio[0] === 'number') fs.closeSync(stdio[0]); } catch { /* 忽略 */ }
  try { if (typeof stdio[1] === 'number') fs.closeSync(stdio[1]); } catch { /* 忽略 */ }
  try { if (typeof stdio[2] === 'number') fs.closeSync(stdio[2]); } catch { /* 忽略 */ }
  const hasBody = DRY || (fs.existsSync(tmp) && fs.statSync(tmp).size > 0);
  if (!DRY && r.status === 0 && hasBody) {
    const res = emit(be, tmp, seatIdentity(seat, { ...ctxBase, seat: be }));
    keepErr(io, res.ok, errFile, DRY);
    if (!res.ok) {
      if (res.code === 3) { a.setVoid('check_card rc=3'); FAILED.push('validator'); }
      else FAILED.push(be + '-invalid-card');
    }
  } else if (DRY) {
    const res = emit(be, tmp, seatIdentity(seat, { ...ctxBase, seat: be }));
    if (!res.ok) FAILED.push(be + '-invalid-card');
  } else {
    io.fail(be + ' 失败或零输出，见 ' + ERR + '（' + describeSpawn(r) + '）');
    FAILED.push(be);
    keepErr(io, false, errFile, DRY);
  }
}

async function runApiSeat(a) {
  const { io, cfg, seat, be, ID, CARDS, PAYLOAD_FILE, DRY, FAILED, SKIPPED, emit, ctxBase } = a;
  const env = process.env;
  // 设置面板可以把任何座位切成 api（只切 kind，结构字段仍来自座位表），但 cli/delivery 座
  // 没有 script/model/votes/temperature。缺字段就在这里明确失败 —— 别让 TypeError 冒到顶层：
  // 那会退 1，而契约里 1 = 降级轮、票有效，人会去读一个根本不存在的 manifest。
  // temperature 必须在列：argv 是【无条件】读 seat.temperature.env 的，漏了它这条校验
  // 就只挡住一半，面板切过来的座位照样在拼 argv 时抛。
  const missing = ['script', 'model', 'votes', 'temperature'].filter((k) => !seat[k]);
  if (missing.length) {
    io.fail(be + ' 座按 api 派工，但座位表里缺 ' + missing.join(' / ') + ' —— 配置错位，不是后端失败');
    FAILED.push(be + '-api-unconfigured');
    return;
  }
  const baseVar = env[seat.base_env_var || 'API_BASE_ENV'] || seat.base_env_default;
  const keyVar = env[seat.key_env_var || 'API_KEY_ENV'] || seat.key_env_default;
  if (!env[baseVar] || !env[keyVar]) {
    io.skip('api 未配置（' + baseVar + ' / ' + keyVar + '）');
    SKIPPED.push('api');
    return;
  }
  const model = apiModel(seat);
  const votes = Number(env[seat.votes.env] || seat.votes.default);
  for (let i = 1; i <= votes; i++) {
    const tag = 'api' + i;
    const tmp = mkCardTmp();
    const ERR = path.join(CARDS, ID + '.' + tag + '.err');
    const errFile = DRY ? tmp + '.err' : ERR;
    io.log('api 评审 ' + ID + ' vote#' + i + ' (' + model + ')');
    const argv = [seat.python || 'python', seat.script, '--base-env', baseVar, '--key-env', keyVar,
      '--model', model, '--temperature', env[seat.temperature.env] || seat.temperature.default];
    if (seat.max_tokens && env[seat.max_tokens.env]) argv.push('--max-tokens', env[seat.max_tokens.env]);
    if (seat.retries && env[seat.retries.env]) argv.push('--retries', env[seat.retries.env]);
    if (DRY) {
      io.plain('  [dry] python ' + seat.script + ' --model ' + model + ' < [roles/reviewer.md + brief] > ' + CARDS + '/' + ID + '.' + tag + '.md 2> ' + ERR);
    } else {
      const stdio = [fs.openSync(PAYLOAD_FILE, 'r'), fs.openSync(tmp, 'w'), fs.openSync(errFile, 'w')];
      const r = spawnSync(argv[0], argv.slice(1), { cwd: process.cwd(), stdio, timeout: CLI_TIMEOUT_MS });
      for (const fd of stdio) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
      const hasBody = fs.existsSync(tmp) && fs.statSync(tmp).size > 0;
      if (r.status === 0 && hasBody) {
        const res = emit(tag, tmp, model);
        keepErr(io, res.ok, errFile, DRY);
        if (!res.ok) FAILED.push(tag + '-invalid-card');
      } else {
        io.fail('api vote#' + i + ' 失败或零输出，见 ' + ERR + '（' + describeSpawn(r) + '）');
        FAILED.push(tag);
        keepErr(io, false, errFile, DRY);
      }
      continue;
    }
    const res = emit(tag, tmp, model);
    if (!res.ok) FAILED.push(tag + '-invalid-card');
  }
}

function runDeliverySeat(a) {
  const { io, seat, be, ID, CARDS, BRIEF, DRY, FAILED, SKIPPED, emit, ctxBase } = a;
  const bodyVar = seatEnvName(seat, 'body_env', be);
  const modelVar = seatEnvName(seat, 'model_env', be);
  const body = process.env[bodyVar] || '';
  const declared = process.env[modelVar] || '';
  if (!declared) {
    io.fail(be + ' 座没配 ' + modelVar + ' —— 这座的身份全靠自报，连报的是谁都没留下，不算票');
    FAILED.push(be + '-unconfigured');
    return;
  }
  if (!body || !fs.existsSync(body)) {
    io.skip(be + ' 座待交付：先把正文（只输出 YAML，不带 meta 行）写到文件，再以 ' + bodyVar + '=<该文件> 重跑');
    SKIPPED.push(be);
    return;
  }
  if (fs.statSync(body).mtimeMs < fs.statSync(BRIEF).mtimeMs) {
    io.fail(be + ' 正文 ' + body + ' 不比工单 ' + BRIEF + ' 新 → 可能是旧一版工单的正文冒充本轮的票，拒收');
    FAILED.push(be + '-stale-body');
    return;
  }
  const tag = seatIdentity(seat, { ...ctxBase, seat: be });
  const how = /-manual-attested$/.test(tag)
    ? '已绑 payload sha=' + ctxBase.payloadSha + ' → 计入先验（署名类，非配置回读）'
    : '未绑/不符 payload sha → 只算一票，不进先验';
  io.log(be + ' 座代递票 ' + ID + '（答者：' + declared + '；' + how + '）');
  if (DRY) {
    io.plain('  [dry] wrap ' + body + ' → ' + CARDS + '/' + ID + '.' + be + '.md  model=' + tag + ' declared=' + declared);
  }
  const hasBody = DRY || (fs.existsSync(body) && fs.statSync(body).size > 0);
  if (!hasBody) {
    io.fail(be + ' 正文为空 —— 空卡比没卡更危险');
    FAILED.push(be);
    return;
  }
  const res = emit(be, body, tag, declared);
  if (!res.ok) FAILED.push(be + '-invalid-card');
}
