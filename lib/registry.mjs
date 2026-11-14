// 座位表加载、路径边界校验、四阶段阵容编排（lineup）、面板写穿同步、Agent 自动探测与身份解析（v2.1.0）。
//
// 配置文件路径（按优先级）：
//   1. 调用方显式传入的相对路径（如 seatsFile，须位于仓库根内）
//   2. 环境变量 DSH_DISPATCH_CONFIG 指向的 JSON
//   3. （仅当处于 DSH 宿主作用域时）设置面板持久化的 seatsFile（须位于仓库根内）
//   4. <仓库根>/dispatch/seats.json
import fs from 'node:fs';
import path from 'node:path';
import {
  expandHome,
  resolveModel,
  geminiConfigModel,
  dshTag,
  seatAttestToken,
  qoderSelfModel,
  probeAgentModelsFromConfigs,
} from './models.mjs';
import { readDshOverrides, overrideOf, isDshPatchActive } from './settings-file.mjs';

export const BUILT_IN_CLI_SEATS = {
  gemini: {
    id: 'gemini',
    kind: 'cli',
    enabled: true,
    command: 'gemini',
    argv: ['-p', '{payload}', '{optional_args}'],
    payload_position: 'argv',
    output: 'stdout',
    optional_args: [
      { env: 'GEMINI_MODEL', argv: ['-m', '{env}'] },
    ],
    identity: {
      kind: 'gemini',
      explicit_env: 'GEMINI_MODEL',
      file_env: 'GEMINI_CFG',
      default_file: '~/.gemini/settings.json',
      pattern: '"model"\\s*:\\s*"[^"]*"',
      cut_field: 4,
    },
  },
  kimi: {
    id: 'kimi',
    kind: 'cli',
    enabled: true,
    command: 'kimi',
    argv: ['-p', '{payload}', '--output-format', 'text', '{optional_args}'],
    payload_position: 'argv',
    output: 'stdout',
    optional_args: [
      { env: 'KIMI_MODEL', argv: ['-m', '{env}'] },
    ],
    identity: {
      kind: 'config',
      explicit_env: 'KIMI_MODEL',
      file_env: 'KIMI_CFG',
      default_file: '~/.kimi/config.toml',
      pattern: '^(?:default_model|model)\\s*=\\s*"[^"]*"',
      cut_field: 2,
    },
  },
};

function cloneBuiltInSeat(name) {
  const tpl = BUILT_IN_CLI_SEATS[name];
  return tpl ? JSON.parse(JSON.stringify(tpl)) : null;
}

function unwrapPlain(v) {
  if (v && typeof v === 'object' && typeof v.get === 'function') {
    try { return v.get(); } catch { return v; }
  }
  return v;
}

function parseDivergeCountValue(val) {
  const raw = unwrapPlain(val);
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= 50) return n;
  return null;
}

function parseOptionalBool(val) {
  const raw = unwrapPlain(val);
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return null;
  }
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === 'blank' || s === 'none') return false;
  return null;
}

// 实时读取 DSH 设置覆盖值（默认在非 DSH 宿主下不生效，除非显式传 opts.useDshPatch === true 或设环境变量）。
export function dshOverrides(opts = {}) {
  return readDshOverrides(opts);
}

function normPathForCompare(p) {
  const clean = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? clean.toLowerCase() : clean;
}

function resolveRealWithTail(targetPath) {
  const tail = [];
  let cur = path.resolve(targetPath);
  while (true) {
    if (fs.existsSync(cur)) {
      try {
        const real = fs.realpathSync(cur);
        return tail.length ? path.join(real, ...tail.reverse()) : real;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(targetPath);
    tail.push(path.basename(cur));
    cur = parent;
  }
}

/**
 * 校验配置路径必须落在仓库根 `root` 内部（兼容 Windows 盘符大小写差异，并经 realpathSync
 * 拦截指向仓外的软链接或 NTFS Junction 目录联接）。返回原相对路径值。
 */
export function assertInside(root, where, p) {
  const raw = String(p ?? '');
  const baseLex = path.resolve(String(root || '.'));
  const absLex = path.resolve(baseLex, raw);
  const nb = normPathForCompare(baseLex);
  const na = normPathForCompare(absLex);
  if (na !== nb && !na.startsWith(nb + path.sep)) {
    const err = new Error('座位表 paths.' + where + ' 越出仓库根：' + raw + ' → ' + absLex + '（只允许仓库内路径）');
    err.code = 'BAD_CONFIG';
    throw err;
  }

  if (fs.existsSync(baseLex)) {
    const realBase = resolveRealWithTail(baseLex);
    const realTarget = resolveRealWithTail(absLex);
    if (!realBase || !realTarget) {
      const err = new Error('座位表 paths.' + where + ' 真实路径无法解析：' + raw);
      err.code = 'BAD_CONFIG';
      throw err;
    }
    const rnb = normPathForCompare(realBase);
    const rna = normPathForCompare(realTarget);
    if (rna !== rnb && !rna.startsWith(rnb + path.sep)) {
      const err = new Error('座位表 paths.' + where + ' 经软链/目录联接越出仓库根：' + raw + ' → ' + realTarget + '（只允许仓库内路径）');
      err.code = 'BAD_CONFIG';
      throw err;
    }
  }
  return p;
}

export function configPath(root, explicit, opts = {}) {
  let expStr = explicit;
  let effOpts = opts || {};
  if (explicit && typeof explicit === 'object') {
    effOpts = explicit;
    expStr = explicit.seatsFile || '';
  }
  const exp = String(expStr || '').trim();
  if (exp) {
    assertInside(root, 'seatsFile', exp);
    return path.resolve(root, exp);
  }
  const envCfg = String(process.env.DSH_DISPATCH_CONFIG || '').trim();
  if (envCfg) return path.resolve(root, envCfg);

  const panelSeats = overrideOf(dshOverrides(effOpts).config, 'seatsFile');
  if (panelSeats) {
    assertInside(root, 'seatsFile', panelSeats);
    return path.resolve(root, panelSeats);
  }
  return path.join(root, 'dispatch', 'seats.json');
}

function validateSeatDefinitions(seats, file) {
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    if (!s || typeof s !== 'object') {
      const err = new Error('座位表 ' + file + ' 第 ' + (i + 1) + ' 项不是对象');
      err.code = 'BAD_CONFIG';
      throw err;
    }
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    if (!id) {
      const err = new Error('座位表 ' + file + ' 第 ' + (i + 1) + ' 项缺少合法的座位 id');
      err.code = 'BAD_CONFIG';
      throw err;
    }
    if (s.seat_pattern !== undefined) {
      if (!/^[A-Za-z0-9_-]+\*?$/.test(id)) {
        const err = new Error('座位表 ' + file + ' 的通配座位 id 非法：' + JSON.stringify(s.id) + '（只允许字母、数字、下划线、连字符及末尾 *）');
        err.code = 'BAD_CONFIG';
        throw err;
      }
      let patRe;
      try {
        patRe = new RegExp('^' + String(s.seat_pattern) + '$');
      } catch (e) {
        const err = new Error('座位表 ' + file + ' 座位 ' + id + ' 的 seat_pattern 正则非法：' + e.message);
        err.code = 'BAD_CONFIG';
        throw err;
      }
      if (patRe.test('a.b') || patRe.test('a/b') || patRe.test('a\\b') || patRe.test('a b')) {
        const err = new Error('座位表 ' + file + ' 座位 ' + id + ' 的 seat_pattern 不允许匹配点号、路径分隔符或空白字符');
        err.code = 'BAD_CONFIG';
        throw err;
      }
    } else if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      const err = new Error('座位表 ' + file + ' 的座位 id 非法：' + JSON.stringify(s.id)
        + ' —— 座位 id 只允许字母、数字、下划线与连字符（禁止包含点号、斜杠或空格，否则卡片归属与路径隔离会失效）');
      err.code = 'BAD_CONFIG';
      throw err;
    }

    if (s.identity && s.identity.pattern !== undefined && s.identity.pattern !== '') {
      try {
        new RegExp(String(s.identity.pattern), 'gm');
      } catch (e) {
        const err = new Error('座位表 ' + file + ' 座位 ' + id + ' 的 identity.pattern 正则非法：' + e.message);
        err.code = 'BAD_CONFIG';
        throw err;
      }
    }
  }
}

export function loadConfig(root, explicit, opts = {}) {
  let expStr = explicit;
  let effOpts = opts || {};
  if (explicit && typeof explicit === 'object') {
    effOpts = explicit;
    expStr = explicit.seatsFile || '';
  }
  const file = configPath(root, expStr, effOpts);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    const err = new Error('找不到座位表 ' + file + ' —— 分派层没有可读的配置。'
      + '修法（任选其一）：① 运行 npx research-dispatch init 一键初始化项目；'
      + '② 把包内 examples/seats.example.json 拷到 ' + path.join(root, 'dispatch', 'seats.json') + '；'
      + '③ 用 DSH_DISPATCH_CONFIG=<文件> 指定座位表。');
    err.code = 'NO_CONFIG';
    throw err;
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    const err = new Error('座位表 ' + file + ' 不是合法 JSON：' + e.message);
    err.code = 'BAD_CONFIG';
    throw err;
  }
  if (!cfg || !Array.isArray(cfg.seats)) {
    const err = new Error('座位表 ' + file + ' 缺少 seats 数组');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  if (cfg.policy !== undefined && (!cfg.policy || typeof cfg.policy !== 'object' || Array.isArray(cfg.policy))) {
    const err = new Error('座位表 ' + file + ' 的 policy 字段必须是对象');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  if (cfg.lineup !== undefined && (!cfg.lineup || typeof cfg.lineup !== 'object' || Array.isArray(cfg.lineup))) {
    const err = new Error('座位表 ' + file + ' 的 lineup 字段必须是对象');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  validateSeatDefinitions(cfg.seats, file);
  cfg.__file = file;
  return cfg;
}

// 运行时座位查找：强制校验运行时名称合法性，支持 seat_pattern 通配一族（如 manual1），并对 gemini / kimi 提供内置 CLI 座位兜底。
export function findSeat(cfg, be) {
  const name = typeof be === 'string' ? be.trim() : '';
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) return null;
  const seats = (cfg && Array.isArray(cfg.seats)) ? cfg.seats : [];
  for (const s of seats) {
    if (!s.seat_pattern && s.id === name) return s;
    if (s.seat_pattern && new RegExp('^' + s.seat_pattern + '$').test(name)) return s;
  }
  if (Object.prototype.hasOwnProperty.call(BUILT_IN_CLI_SEATS, name)) {
    return cloneBuiltInSeat(name);
  }
  return null;
}

export function enabledSeatIds(cfg) {
  return cfg.seats.filter((s) => s.enabled !== false && !s.seat_pattern).map((s) => s.id);
}

export function seatUpper(be) {
  return String(be || '').toUpperCase();
}

function interpolateSeat(tpl, be) {
  return String(tpl || '').replace(/\{SEAT_UPPER\}/g, seatUpper(be)).replace(/\{SEAT\}/g, String(be || ''));
}

export function seatEnvName(seat, field, be) {
  return interpolateSeat((seat && seat[field]) || '', be);
}

function explicitModelOf(seat, id, voteModel = '', opts = {}) {
  const explicitEnv = id.explicit_env || (id.kind === 'settings' ? 'DSH_MODEL' : '');
  const legacyField = id.dsh_setting || (seat.id + 'Model');
  const legacy = overrideOf(dshOverrides(opts).config, legacyField);
  const vm = String(voteModel || '').trim();
  const envVal = explicitEnv ? String(process.env[explicitEnv] || '').trim() : '';
  return vm || envVal || legacy || seat.model_override || '';
}

export function seatIdentity(seat, ctx = {}) {
  if (!seat) return 'unknown-check-config';
  const id = seat.identity || {};
  const kind = id.kind || 'config';
  const be = ctx.seat || seat.id || '';
  const voteModel = String(ctx.voteModel || '').trim();
  const patchOpts = { useDshPatch: Boolean(ctx.useDshPatch) };

  if (seatKindOf(seat, patchOpts) === 'api' && kind !== 'api' && (seat.model || voteModel)) {
    return apiModel(seat, voteModel, patchOpts);
  }
  const explicit = String(explicitModelOf(seat, id, voteModel, patchOpts) || '').trim();
  if (kind === 'manual') return seatAttestToken(be, ctx.payloadSha, seat);
  if (kind === 'settings') return explicit ? explicit + '-explicit' : dshTag();
  if (kind === 'api') return apiModel(seat, voteModel, patchOpts);
  if (kind === 'selfdeclared') {
    if (seat.model_env && (seat.attest_sha_env || seat.sha_env)) {
      return seatAttestToken(be, ctx.payloadSha, seat);
    }
    return 'unknown-check-config';
  }
  if (kind === 'gemini' || /\/\.gemini\/settings\.json$/i.test(String(id.default_file || '').replace(/\\/g, '/'))) {
    const cfgFileOverride = process.env[id.file_env || 'GEMINI_CFG'] || id.default_file || '';
    return geminiConfigModel(explicit, cfgFileOverride);
  }
  const cfgFile = expandHome(process.env[id.file_env || ''] || id.default_file || '');
  return resolveModel(explicit, cfgFile, id.pattern, id.cut_field);
}

// api 座模型优先级：票位指定模型 > 环境变量 > （DSH 宿主内）旧设置字段 > model_override > 座位表默认 > unknown-check-config。
export function apiModel(seat, voteModel = '', opts = {}) {
  const vm = String(voteModel || '').trim();
  if (!seat) return vm || 'unknown-check-config';
  const env = process.env;
  const modelCfg = seat.model && typeof seat.model === 'object' ? seat.model : {};
  const envVal = modelCfg.env ? String(env[modelCfg.env] || '').trim() : '';
  const legacyField = (seat.identity && seat.identity.dsh_setting) || (seat.id + 'Model');
  const legacy = overrideOf(dshOverrides(opts).config, legacyField);
  const picked = vm || envVal || legacy || seat.model_override || modelCfg.default || '';
  return String(picked).trim() || 'unknown-check-config';
}

// argv 模板展开：{workers_dir} {tmp} {payload} {patch} {optional_args}
export function buildArgv(seat, ctx) {
  const envSource = (ctx && ctx.env) || process.env;
  const optional = [];
  for (const o of seat.optional_args || []) {
    const v = envSource[o.env] || '';
    if (!v) continue;
    for (const a of o.argv) optional.push(String(a).replace(/\{env\}/g, v));
  }
  const out = [];
  for (const tok of seat.argv || []) {
    const t = String(tok);
    if (t === '{optional_args}') {
      out.push(...optional);
      continue;
    }
    // 占位符一次替换，避免用户 payload 文本中的字面量 {patch} 等被二次展开。
    const subst = (s) => s.replace(/\{workers_dir\}/g, ctx.workersDir || '')
                             .replace(/\{tmp\}/g, ctx.tmp || '')
                             .replace(/\{patch\}/g, ctx.patch || '');
    out.push(t.split('{payload}').map(subst).join(ctx.payloadText || ''));
  }
  return out;
}

export function effectiveDefaultBackends(cfg) {
  return (cfg && cfg.default_backends) || ['codex', 'claude', 'dsh'];
}

export function seatKindOf(seat, opts = {}) {
  if (!seat) return '';
  const ov = executorOverrideOf(seat, opts);
  return ov === 'subagent' ? 'delivery' : (ov || seat.kind);
}

export function executorOverrideOf(seat, opts = {}) {
  if (!seat || !seat.id) return '';
  const dshKey = (seat.identity && seat.identity.dsh_setting) || '';
  const legacyField = dshKey.endsWith('Model') ? dshKey.slice(0, -5) + 'Executor' : (seat.id + 'Executor');
  const normExec = (v) => {
    const s = String(v || '').trim();
    if (!s) return '';
    const n = s === 'delivery' || s === 'subagent' ? 'subagent' : s;
    return ['cli', 'api', 'subagent'].includes(n) ? n : '';
  };
  return normExec(overrideOf(dshOverrides(opts).config, legacyField)) || normExec(seat.executor_override);
}

/**
 * 解析单票位语法（支持字符串 `"seat[:model]"` 或对象 `{ id?, seat, model? }`）。
 * 按首个 `:` 切分 seat 与 model，保留 `dsh:provider/model` 或含冒号模型 ID 的完整后缀。
 */
export function parseSlotSpecToken(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    const i = t.indexOf(':');
    const executor = (i < 0 ? t : t.slice(0, i)).trim();
    const model = i < 0 ? '' : t.slice(i + 1).trim();
    return executor ? { id: '', executor, model } : null;
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const rawExec = String(raw.seat || raw.executor || '').trim();
    if (!rawExec) return null;
    let executor = rawExec;
    let model = raw.model !== undefined && raw.model !== null ? String(raw.model).trim() : '';
    if (!model && rawExec.includes(':')) {
      const i = rawExec.indexOf(':');
      executor = rawExec.slice(0, i).trim();
      model = rawExec.slice(i + 1).trim();
    }
    const id = raw.id !== undefined && raw.id !== null ? String(raw.id).trim() : '';
    return executor ? { id, executor, model } : null;
  }
  return null;
}

export function parseLineupSpecString(raw) {
  if (raw === null || raw === undefined) return [];
  return String(raw)
    .split(/[\s,]+/)
    .map((tok) => parseSlotSpecToken(tok))
    .filter(Boolean);
}

/**
 * 面板里的评审票（DSL：`exec:model,exec:model`；仅在 DSH 宿主作用域激活时非空）。
 * @returns {Array<{executor: string, model: string}>}
 */
export function panelVotes(opts = {}) {
  const raw = overrideOf(dshOverrides(opts).config, 'reviewVotes');
  if (!raw) return [];
  return String(raw).split(',').map((tok) => {
    const parsed = parseSlotSpecToken(tok);
    return parsed ? { executor: parsed.executor, model: parsed.model } : null;
  }).filter(Boolean);
}

function mapExecutorToSeatId(cfg, executor, allowUnknown = true) {
  const name = String(executor || '').trim();
  if (!name) return '';
  const direct = findSeat(cfg, name);
  if (direct) return direct.seat_pattern ? name : direct.id;
  const byCmd = ((cfg && cfg.seats) || []).find((s) => !s.seat_pattern && s.command === name);
  if (byCmd) return byCmd.id;
  return allowUnknown ? name : '';
}

function finalizeSlots(rawSlots, source, skippedVotes = []) {
  const counts = new Map();
  for (const s of rawSlots) {
    counts.set(s.seat, (counts.get(s.seat) || 0) + 1);
  }
  const usedTags = new Set();
  for (const s of rawSlots) {
    if (s.id && /^[A-Za-z0-9_-]+$/.test(s.id)) usedTags.add(s.id);
  }
  const seqs = new Map();
  const slots = [];
  const voteModels = new Map();

  for (const s of rawSlots) {
    let tag = '';
    if (s.id && /^[A-Za-z0-9_-]+$/.test(s.id)) {
      tag = s.id;
    } else if ((counts.get(s.seat) || 0) <= 1 && !usedTags.has(s.seat)) {
      tag = s.seat;
    } else {
      let idx = (seqs.get(s.seat) || 0) + 1;
      while (usedTags.has(s.seat + idx)) idx += 1;
      seqs.set(s.seat, idx);
      tag = s.seat + idx;
    }
    usedTags.add(tag);
    const model = String(s.model || '').trim();
    slots.push({ tag, seat: s.seat, model });
    if (model) {
      voteModels.set(tag, model);
      if ((counts.get(s.seat) || 0) === 1) voteModels.set(s.seat, model);
    }
  }

  const backendsDisplay = slots.map((s) => (s.model ? (s.tag + ':' + s.model) : s.tag)).join(' ');
  return {
    ok: true,
    source,
    backendsRaw: backendsDisplay,
    slots,
    backendList: slots.map((s) => s.seat),
    slotTags: slots.map((s) => s.tag),
    voteModels,
    skippedVotes,
    duplicateVotes: [],
  };
}

/**
 * 统一解析本轮评审执行计划（供 `bin/dispatch.mjs plan`、`seats` 与 `lib/run.mjs` 共用）：
 * 优先级：
 *   1. CLI 参数 / 环境变量（opts.reviewSpec / REVIEW_LINEUP / opts.backendsEnv / BACKENDS）
 *   2. （仅在 DSH 宿主作用域激活时）设置面板 reviewVotes
 *   3. 项目 dispatch/seats.json 的 lineup.review
 *   4. 项目 dispatch/seats.json 的 default_backends
 * 支持同一 Agent 在一轮中排多票（自动生成 <seat>1, <seat>2 标签，互不覆盖）。
 */
export function resolveExecutionPlan(cfg, opts = {}) {
  const inlineRaw = opts.reviewSpec !== undefined
    ? opts.reviewSpec
    : (process.env.REVIEW_LINEUP !== undefined && process.env.REVIEW_LINEUP !== ''
      ? process.env.REVIEW_LINEUP
      : (opts.backendsEnv !== undefined ? opts.backendsEnv : process.env.BACKENDS));

  if (inlineRaw !== undefined && inlineRaw !== '') {
    const tokens = parseLineupSpecString(inlineRaw);
    const rawSlots = tokens.map((t) => ({
      id: t.id || '',
      seat: mapExecutorToSeatId(cfg, t.executor, true),
      model: t.model || '',
    }));
    const res = finalizeSlots(rawSlots, 'env');
    res.backendsRaw = String(inlineRaw).trim();
    return res;
  }

  if (isDshPatchActive(opts)) {
    const votes = panelVotes(opts);
    if (votes.length > 0) {
      const skippedVotes = [];
      const rawSlots = [];
      for (const v of votes) {
        const seatId = mapExecutorToSeatId(cfg, v.executor, false);
        if (!seatId) {
          skippedVotes.push(v.executor);
          continue;
        }
        rawSlots.push({ id: '', seat: seatId, model: v.model || '' });
      }
      if (rawSlots.length === 0) {
        return {
          ok: false,
          code: 'BAD_PANEL_VOTES',
          source: 'panel',
          backendsRaw: '',
          slots: [],
          backendList: [],
          slotTags: [],
          voteModels: new Map(),
          skippedVotes,
          duplicateVotes: [],
          error: '设置面板配置的评审票（' + votes.map((v) => v.executor).join(', ')
            + '）在座位表中均无对应座位（可选：' + cfg.seats.filter((s) => !s.seat_pattern).map((s) => s.id).join(' ')
            + '）—— 拒绝静默回退默认座位以免误调付费模型。请在面板修正评审票，或在 seats.json 补齐对应座位。',
        };
      }
      return finalizeSlots(rawSlots, 'panel', skippedVotes);
    }
  }

  if (cfg && cfg.lineup && Array.isArray(cfg.lineup.review) && cfg.lineup.review.length > 0) {
    const rawSlots = cfg.lineup.review
      .map((item) => parseSlotSpecToken(item))
      .filter(Boolean)
      .map((t) => ({
        id: t.id || '',
        seat: mapExecutorToSeatId(cfg, t.executor, true),
        model: t.model || '',
      }));
    return finalizeSlots(rawSlots, 'lineup');
  }

  const defaultTokens = effectiveDefaultBackends(cfg)
    .map((item) => parseSlotSpecToken(item))
    .filter(Boolean)
    .map((t) => ({
      id: t.id || '',
      seat: mapExecutorToSeatId(cfg, t.executor, true),
      model: t.model || '',
    }));
  return finalizeSlots(defaultTokens, 'default');
}

function readLegacyStageOpinion(ov, stage) {
  const raw = String((ov && ov.stageOpinions) || '').trim();
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const [st, exec, ...rest] = seg.split(':');
    if (String(st || '').trim().toLowerCase() === stage && String(exec || '').trim()) {
      return { id: '', executor: String(exec).trim(), model: rest.join(':').trim() };
    }
  }
  return null;
}

/**
 * 解析单席位阶段（`'scout' | 'diverge' | 'novelty'`）的执行座位与模型：
 * 优先级：
 *   1. opts.agent / 环境变量 <STAGE>_AGENT（SCOUT_AGENT / DIVERGE_AGENT / NOVELTY_AGENT）
 *   2. （仅在 DSH 宿主作用域激活时）面板 <stage>Command + <stage>Model（兼容历史 stageOpinions）
 *   3. seats.json 的 lineup[stageName]
 *   4. 回退 seats.json 的 lineup.diverge
 *   5. effectiveDefaultBackends(cfg)[0] > 首个已启用 CLI 座
 */
export function resolveStagePlan(cfg, stageName, opts = {}) {
  const stage = String(stageName || 'diverge').trim().toLowerCase();
  if (!['scout', 'diverge', 'novelty'].includes(stage)) {
    return {
      ok: false,
      code: 'BAD_STAGE',
      stage,
      source: 'arg',
      seatId: '',
      seat: null,
      model: '',
      error: '未知阶段名称: ' + JSON.stringify(stageName) + '（仅支持 scout / diverge / novelty）',
    };
  }

  let source = 'default';
  let picked = null;
  const envKey = stage.toUpperCase() + '_AGENT';
  const hasArg = opts.agent !== undefined && opts.agent !== null && String(opts.agent).trim() !== '';
  const inlineAgent = hasArg ? opts.agent : (process.env[envKey] || '');

  if (String(inlineAgent).trim()) {
    picked = parseSlotSpecToken(inlineAgent);
    source = hasArg ? 'arg' : 'env';
  } else if (isDshPatchActive(opts)) {
    const ov = dshOverrides(opts).config || {};
    const cmd = String(ov[stage + 'Command'] || '').trim();
    const mdl = String(ov[stage + 'Model'] || '').trim();
    if (cmd) {
      picked = { id: '', executor: cmd, model: mdl };
      source = 'panel';
    } else {
      const leg = readLegacyStageOpinion(ov, stage);
      if (leg) {
        picked = leg;
        source = 'panel';
      }
    }
  }

  if (!picked && cfg && cfg.lineup && cfg.lineup[stage]) {
    picked = parseSlotSpecToken(cfg.lineup[stage]);
    if (picked) source = 'lineup';
  }

  if (!picked && stage !== 'diverge' && cfg && cfg.lineup && cfg.lineup.diverge) {
    picked = parseSlotSpecToken(cfg.lineup.diverge);
    if (picked) source = 'lineup-diverge';
  }

  const safeCfg = cfg && typeof cfg === 'object' ? cfg : { seats: [] };
  if (!picked) {
    const preferred = effectiveDefaultBackends(safeCfg)
      .map((x) => parseSlotSpecToken(x))
      .filter(Boolean);
    if (preferred.length > 0) {
      picked = preferred[0];
    } else {
      const seatsArr = Array.isArray(safeCfg.seats) ? safeCfg.seats : [];
      const firstCli = seatsArr.find((s) => s.enabled !== false && !s.seat_pattern && (s.kind || 'cli') === 'cli');
      const firstAny = seatsArr.find((s) => s.enabled !== false && !s.seat_pattern);
      const chosen = firstCli || firstAny;
      picked = chosen ? { id: '', executor: chosen.id, model: '' } : { id: '', executor: 'codex', model: '' };
    }
  }

  const seatId = mapExecutorToSeatId(safeCfg, picked.executor, false);
  const seat = seatId ? findSeat(safeCfg, seatId) : null;
  const stageLabels = { scout: '调研', diverge: '发散', novelty: '查重' };
  const label = stageLabels[stage] || stage;
  if (!seat) {
    const avail = [...new Set([...(safeCfg.seats || []).filter((s) => !s.seat_pattern).map((s) => s.id), 'gemini', 'kimi'])];
    return {
      ok: false,
      code: stage === 'diverge' ? 'UNKNOWN_DIVERGE_SEAT' : ('UNKNOWN_' + stage.toUpperCase() + '_SEAT'),
      stage,
      source,
      seatId: picked.executor,
      seat: null,
      model: picked.model || '',
      error: '未知' + label + '执行座位: ' + picked.executor + '（可选：' + avail.join(' ') + '）',
    };
  }

  return {
    ok: true,
    stage,
    source,
    seatId: seat.seat_pattern ? picked.executor : seat.id,
    seat,
    model: picked.model || '',
  };
}

/**
 * 解析发散环节执行座位、模型及策略默认值（复用 `resolveStagePlan(cfg, 'diverge', opts)`）：
 * 额外返回：
 *   - `defaultCount`：DSH 面板 `divergeCount` > `cfg.lineup?.diverge?.count` > `10`（1..50 整数）
 *   - `defaultUseDeadEnds`：DSH 面板 `divergeUseDeadEnds` > `cfg.lineup?.diverge?.use_dead_ends` > `true`
 */
export function resolveDivergePlan(cfg, opts = {}) {
  const base = resolveStagePlan(cfg, 'diverge', opts);
  const divCfg = (cfg && cfg.lineup && cfg.lineup.diverge && typeof cfg.lineup.diverge === 'object' && !Array.isArray(cfg.lineup.diverge))
    ? cfg.lineup.diverge
    : null;

  let defaultCount = null;
  let defaultUseDeadEnds = null;
  if (isDshPatchActive(opts)) {
    const ov = dshOverrides(opts).config || {};
    defaultCount = parseDivergeCountValue(ov.divergeCount);
    defaultUseDeadEnds = parseOptionalBool(ov.divergeUseDeadEnds);
  }
  if (defaultCount === null && divCfg) {
    defaultCount = parseDivergeCountValue(divCfg.count);
  }
  if (defaultUseDeadEnds === null && divCfg) {
    defaultUseDeadEnds = parseOptionalBool(divCfg.use_dead_ends !== undefined ? divCfg.use_dead_ends : divCfg.useDeadEnds);
  }
  if (defaultCount === null) defaultCount = 10;
  if (defaultUseDeadEnds === null) defaultUseDeadEnds = true;

  return {
    ...base,
    defaultCount,
    defaultUseDeadEnds,
  };
}

// 当前生效评审座位的模型身份列表（供发散环节做同族留痕比对）。
export function reviewModels(cfg, opts = {}) {
  const out = [];
  if (cfg && cfg.lineup && Array.isArray(cfg.lineup.review) && cfg.lineup.review.length > 0) {
    const planRes = resolveExecutionPlan(cfg, opts);
    if (planRes.ok) {
      for (const sl of planRes.slots) {
        const seat = findSeat(cfg, sl.seat);
        if (!seat) continue;
        const kind = (seat.identity && seat.identity.kind) || 'config';
        if (kind === 'selfdeclared') {
          const q = qoderSelfModel();
          if (q) out.push(q);
          continue;
        }
        out.push(seatIdentity(seat, { seat: sl.seat, payloadSha: '', voteModel: sl.model, useDshPatch: Boolean(opts.useDshPatch) }));
      }
      return out;
    }
  }

  for (const seat of cfg.seats) {
    const kind = (seat.identity && seat.identity.kind) || 'config';
    if (kind === 'selfdeclared') {
      const q = qoderSelfModel();
      if (q) out.push(q);
      continue;
    }
    if (seat.enabled === false) continue;
    if (kind === 'config' || kind === 'gemini' || kind === 'settings' || (kind === 'api' && seat.model)) {
      out.push(seatIdentity(seat, { seat: seat.id, payloadSha: '', useDshPatch: Boolean(opts.useDshPatch) }));
    }
  }
  return out;
}

function findExecutableOnPath(cmd) {
  if (!cmd) return null;
  const isWin = process.platform === 'win32';
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
      try {
        if (fs.statSync(cand).isFile()) return cand;
      } catch { /* 继续 */ }
    }
  }
  return null;
}

/**
 * 自动探测本机已安装的 CLI Agent、API 环境变量及各自配置文件中的可用模型列表，并返回四阶段阵容配置。
 */
export function discoverAgents(rootDir = null, opts = {}) {
  const probed = probeAgentModelsFromConfigs();
  let cfg = null;
  if (rootDir) {
    try {
      cfg = loadConfig(rootDir, opts.seatsFile, opts);
    } catch {
      cfg = null;
    }
  }

  const cliList = ['codex', 'claude', 'dsh', 'gemini', 'kimi'];
  const agents = cliList.map((id) => {
    const bin = findExecutableOnPath(id);
    const p = probed[id] || { configFile: null, configExists: false, defaultModel: '', models: [] };
    return {
      id,
      kind: 'cli',
      installed: Boolean(bin),
      bin: bin || null,
      default_model: p.defaultModel || null,
      models: p.models || [],
      config_file: p.configExists ? p.configFile : null,
    };
  });

  agents.push({
    id: 'api',
    kind: 'api',
    installed: probed.api.configuredKeyVars.length > 0,
    bin: null,
    configured_keys: probed.api.configuredKeyVars,
    configured_bases: probed.api.configuredBaseVars,
    default_model: probed.api.defaultModel || null,
    models: probed.api.models || [],
    config_file: null,
  });

  return {
    ok: true,
    root: rootDir ? path.resolve(rootDir) : null,
    config: cfg ? cfg.__file : null,
    lineup: cfg ? {
      scout: (cfg.lineup && cfg.lineup.scout) || null,
      diverge: (cfg.lineup && cfg.lineup.diverge) || null,
      review: (cfg.lineup && Array.isArray(cfg.lineup.review)) ? cfg.lineup.review : null,
      novelty: (cfg.lineup && cfg.lineup.novelty) || null,
      default_backends: effectiveDefaultBackends(cfg),
      require_unique_models: Boolean(cfg.policy && cfg.policy.require_unique_models === true),
    } : null,
    agents,
  };
}

function writeJsonAtomicSync(dest, obj) {
  const content = JSON.stringify(obj, null, 2) + '\n';
  const tmp = dest + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(tmp, content, 'utf8');
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
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

function normalizeDivergeLineupObj(rawDiv) {
  const out = {};
  const tok = parseSlotSpecToken(rawDiv);
  if (tok && tok.executor) {
    out.seat = tok.executor;
    out.model = tok.model || '';
  } else if (rawDiv && typeof rawDiv === 'object' && !Array.isArray(rawDiv)) {
    if (typeof rawDiv.seat === 'string') out.seat = rawDiv.seat.trim();
    if (typeof rawDiv.model === 'string') out.model = rawDiv.model.trim();
  }
  if (rawDiv && typeof rawDiv === 'object' && !Array.isArray(rawDiv)) {
    const c = parseDivergeCountValue(rawDiv.count);
    if (c !== null) out.count = c;
    const u = parseOptionalBool(rawDiv.use_dead_ends !== undefined ? rawDiv.use_dead_ends : rawDiv.useDeadEnds);
    if (u !== null) out.use_dead_ends = u;
  }
  return out;
}

function pickDefaultSeatId(cfg) {
  const pref = effectiveDefaultBackends(cfg).map((x) => parseSlotSpecToken(x)).filter(Boolean);
  if (pref.length > 0) {
    const mapped = mapExecutorToSeatId(cfg, pref[0].executor, false);
    if (mapped) return mapped;
  }
  const firstCli = (cfg.seats || []).find((s) => s.enabled !== false && !s.seat_pattern && (s.kind || 'cli') === 'cli');
  if (firstCli) return firstCli.id;
  const firstAny = (cfg.seats || []).find((s) => !s.seat_pattern);
  return firstAny ? firstAny.id : 'codex';
}

/**
 * 解析并原子更新项目 dispatch/seats.json 中的四阶段 lineup（scout / diverge / review / novelty）与 policy 配置。
 */
export function updateLineup(rootDir, {
  scout,
  diverge,
  divergeCount,
  useDeadEnds,
  review,
  novelty,
  reset = false,
  requireUniqueModels,
  explicitConfig,
} = {}) {
  if (!rootDir) {
    const err = new Error('updateLineup 需要有效的项目根目录 rootDir');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  const cfg = loadConfig(rootDir, explicitConfig, { useDshPatch: false });
  const file = cfg.__file;

  const ensureValidSeat = (rawExec) => {
    const name = String(rawExec || '').trim();
    if (!name) {
      const err = new Error('阵容座位名不能为空');
      err.code = 'BAD_CONFIG';
      throw err;
    }
    const existing = (cfg.seats || []).find((s) => (!s.seat_pattern && s.id === name) || (s.seat_pattern && new RegExp('^' + s.seat_pattern + '$').test(name)));
    if (existing) {
      if (!existing.seat_pattern && existing.enabled === false) existing.enabled = true;
      return existing.seat_pattern ? name : existing.id;
    }
    const byCmd = (cfg.seats || []).find((s) => !s.seat_pattern && s.command === name);
    if (byCmd) {
      if (byCmd.enabled === false) byCmd.enabled = true;
      return byCmd.id;
    }
    if (Object.prototype.hasOwnProperty.call(BUILT_IN_CLI_SEATS, name)) {
      cfg.seats.push(cloneBuiltInSeat(name));
      return name;
    }
    const avail = [...new Set([...(cfg.seats || []).filter((s) => !s.seat_pattern).map((s) => s.id), 'gemini', 'kimi'])];
    const err = new Error('未知座位 ' + JSON.stringify(name) + '（可选：' + avail.join(', ') + '）');
    err.code = 'BAD_CONFIG';
    throw err;
  };

  if (reset) {
    delete cfg.lineup;
    if (cfg.policy && typeof cfg.policy === 'object') {
      cfg.policy.require_unique_models = false;
    }
  }

  if (scout !== undefined && scout !== null) {
    const tok = parseSlotSpecToken(scout);
    if (!tok || !tok.executor) {
      const err = new Error('--scout 参数格式非法，期望 <seat>[:<model>]（例如 gemini:gemini-2.5-pro）');
      err.code = 'BAD_CONFIG';
      throw err;
    }
    const seatId = ensureValidSeat(tok.executor);
    cfg.lineup = { ...(cfg.lineup || {}), scout: { seat: seatId, model: tok.model || '' } };
  }

  if (review !== undefined && review !== null) {
    const tokens = Array.isArray(review)
      ? review.map((x) => parseSlotSpecToken(x)).filter(Boolean)
      : parseLineupSpecString(review);
    if (tokens.length === 0) {
      const err = new Error('--review 至少需要指定一个评审票位（例如 codex:gpt-5,claude:sonnet）；如需重置请传 --reset');
      err.code = 'BAD_CONFIG';
      throw err;
    }
    const nextReview = tokens.map((t) => {
      const seatId = ensureValidSeat(t.executor);
      const item = { seat: seatId, model: t.model || '' };
      if (t.id) {
        if (!/^[A-Za-z0-9_-]+$/.test(t.id)) {
          const err = new Error('评审槽位自定义 id 非法：' + JSON.stringify(t.id));
          err.code = 'BAD_CONFIG';
          throw err;
        }
        item.id = t.id;
      }
      return item;
    });
    cfg.lineup = { ...(cfg.lineup || {}), review: nextReview };
    cfg.default_backends = [...new Set(nextReview.map((r) => r.seat))];
  }

  const hasDivSpec = diverge !== undefined && diverge !== null;
  const hasDivCount = divergeCount !== undefined && divergeCount !== null && String(divergeCount).trim() !== '';
  const hasDivDead = useDeadEnds !== undefined && useDeadEnds !== null && String(useDeadEnds).trim() !== '';
  if (hasDivSpec || hasDivCount || hasDivDead) {
    const nextDiv = normalizeDivergeLineupObj(cfg.lineup && cfg.lineup.diverge);
    if (hasDivSpec) {
      const tok = parseSlotSpecToken(diverge);
      if (!tok || !tok.executor) {
        const err = new Error('--diverge 参数格式非法，期望 <seat>[:<model>]（例如 codex:gpt-5 或 dsh:prov/mdl）');
        err.code = 'BAD_CONFIG';
        throw err;
      }
      const seatId = ensureValidSeat(tok.executor);
      nextDiv.seat = seatId;
      nextDiv.model = tok.model || '';
      if (typeof diverge === 'object' && !Array.isArray(diverge)) {
        if (!hasDivCount && diverge.count !== undefined) {
          const c = parseDivergeCountValue(diverge.count);
          if (c === null) {
            const err = new Error('发散默认条数必须是 1..50 的整数，实得：' + JSON.stringify(diverge.count));
            err.code = 'BAD_CONFIG';
            throw err;
          }
          nextDiv.count = c;
        }
        if (!hasDivDead && (diverge.use_dead_ends !== undefined || diverge.useDeadEnds !== undefined)) {
          const b = parseOptionalBool(diverge.use_dead_ends !== undefined ? diverge.use_dead_ends : diverge.useDeadEnds);
          if (b === null) {
            const err = new Error('发散 use_dead_ends 必须是布尔值');
            err.code = 'BAD_CONFIG';
            throw err;
          }
          nextDiv.use_dead_ends = b;
        }
      }
    }
    if (hasDivCount) {
      const c = parseDivergeCountValue(divergeCount);
      if (c === null) {
        const err = new Error('--diverge-count 发散默认条数必须是 1..50 的整数，实得：' + JSON.stringify(divergeCount));
        err.code = 'BAD_CONFIG';
        throw err;
      }
      nextDiv.count = c;
    }
    if (hasDivDead) {
      const b = parseOptionalBool(useDeadEnds);
      if (b === null) {
        const err = new Error('--use-dead-ends 参数非法，期望布尔值，实得：' + JSON.stringify(useDeadEnds));
        err.code = 'BAD_CONFIG';
        throw err;
      }
      nextDiv.use_dead_ends = b;
    }
    if (!nextDiv.seat) {
      nextDiv.seat = ensureValidSeat(pickDefaultSeatId(cfg));
      if (nextDiv.model === undefined) nextDiv.model = '';
    }
    cfg.lineup = { ...(cfg.lineup || {}), diverge: nextDiv };
  }

  if (novelty !== undefined && novelty !== null) {
    const tok = parseSlotSpecToken(novelty);
    if (!tok || !tok.executor) {
      const err = new Error('--novelty 参数格式非法，期望 <seat>[:<model>]（例如 claude:claude-sonnet-4-5）');
      err.code = 'BAD_CONFIG';
      throw err;
    }
    const seatId = ensureValidSeat(tok.executor);
    cfg.lineup = { ...(cfg.lineup || {}), novelty: { seat: seatId, model: tok.model || '' } };
  }

  if (requireUniqueModels !== undefined && requireUniqueModels !== null) {
    cfg.policy = { ...(cfg.policy || {}), require_unique_models: Boolean(requireUniqueModels) };
  } else if (!cfg.policy || typeof cfg.policy !== 'object') {
    cfg.policy = { require_unique_models: false };
  }

  const outObj = { ...cfg };
  delete outObj.__file;
  if (outObj.version === undefined || outObj.version < 2) {
    outObj.version = 2;
  }
  writeJsonAtomicSync(file, outObj);

  return {
    ok: true,
    file,
    lineup: outObj.lineup || null,
    policy: outObj.policy || { require_unique_models: false },
    default_backends: effectiveDefaultBackends(outObj),
  };
}

/**
 * 将 DSH 设置面板中非空的四阶段配置写穿同步至项目 `<rootDir>/<seatsFile>` 的 `lineup`：
 *   - 若座位表文件不存在，静默返回 `{ ok: false, synced: false, reason: 'missing' }` 不抛错；
 *   - 仅同步 `panelCfg` 中非空的阶段配置，严禁触碰 `cfg.seats[i].model_override` 等手写座位属性；
 *   - 若引用了 `gemini` 或 `kimi` 且 `cfg.seats` 中尚无该座则自动补入 `cloneBuiltInSeat`；
 *   - 仅当 JSON 结构真正发生变化时才原子写盘并返回 `{ ok: true, synced: true, file }`。
 */
export function syncPanelLineupToSeats(rootDir, seatsFile = 'dispatch/seats.json', panelCfg = {}) {
  let relSeats = seatsFile;
  let pCfg = panelCfg;
  if (seatsFile && typeof seatsFile === 'object' && !Array.isArray(seatsFile)) {
    pCfg = seatsFile;
    relSeats = unwrapPlain(pCfg.seatsFile) || 'dispatch/seats.json';
  }
  const rootStr = String(unwrapPlain(rootDir) || '').trim();
  if (!rootStr) {
    return { ok: false, synced: false, reason: 'missing' };
  }
  const cleanRel = String(unwrapPlain(relSeats) || '').trim() || 'dispatch/seats.json';
  let file = '';
  try {
    assertInside(rootStr, 'seatsFile', cleanRel);
    file = path.resolve(rootStr, cleanRel);
  } catch (e) {
    return { ok: false, synced: false, reason: 'bad-path', error: String((e && e.message) || e) };
  }

  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return { ok: false, synced: false, reason: 'missing', file };
    }
  } catch {
    return { ok: false, synced: false, reason: 'missing', file };
  }

  let rawText = '';
  let origObj = null;
  try {
    rawText = fs.readFileSync(file, 'utf8');
    origObj = JSON.parse(rawText);
    if (!origObj || !Array.isArray(origObj.seats)) {
      return { ok: false, synced: false, reason: 'bad-config', file };
    }
    validateSeatDefinitions(origObj.seats, file);
  } catch (e) {
    return { ok: false, synced: false, reason: 'bad-config', file, error: String((e && e.message) || e) };
  }

  const outObj = JSON.parse(JSON.stringify(origObj));
  const ensureSeat = (rawExec) => {
    const name = String(rawExec || '').trim();
    if (!name) return '';
    const existing = (outObj.seats || []).find((s) => (!s.seat_pattern && s.id === name) || (s.seat_pattern && new RegExp('^' + s.seat_pattern + '$').test(name)));
    if (existing) {
      if (!existing.seat_pattern && existing.enabled === false) existing.enabled = true;
      return existing.seat_pattern ? name : existing.id;
    }
    const byCmd = (outObj.seats || []).find((s) => !s.seat_pattern && s.command === name);
    if (byCmd) {
      if (byCmd.enabled === false) byCmd.enabled = true;
      return byCmd.id;
    }
    if (Object.prototype.hasOwnProperty.call(BUILT_IN_CLI_SEATS, name)) {
      outObj.seats.push(cloneBuiltInSeat(name));
      return name;
    }
    return '';
  };

  const src = pCfg && typeof pCfg === 'object' ? pCfg : {};
  const strField = (k) => String(unwrapPlain(src[k]) ?? '').trim();

  const scoutCmd = strField('scoutCommand');
  const scoutMdl = strField('scoutModel');
  const divCmd = strField('divergeCommand');
  const divMdl = strField('divergeModel');
  const divCount = parseDivergeCountValue(src.divergeCount);
  const divUseDead = parseOptionalBool(src.divergeUseDeadEnds !== undefined ? src.divergeUseDeadEnds : src.useDeadEnds);
  const revRaw = unwrapPlain(src.reviewVotes);
  const novCmd = strField('noveltyCommand');
  const novMdl = strField('noveltyModel');

  if (scoutCmd) {
    const seatId = ensureSeat(scoutCmd);
    if (seatId) {
      outObj.lineup = { ...(outObj.lineup || {}), scout: { seat: seatId, model: scoutMdl } };
    }
  }

  const prevDivRaw = outObj.lineup && outObj.lineup.diverge;
  const prevDivObj = normalizeDivergeLineupObj(prevDivRaw);
  const countNeedsSync = divCount !== null && (
    Boolean(divCmd)
    || divCount !== 10
    || (prevDivRaw && typeof prevDivRaw === 'object' && prevDivRaw.count !== undefined && prevDivRaw.count !== divCount)
  );
  const deadNeedsSync = divUseDead !== null && (
    Boolean(divCmd)
    || divUseDead !== true
    || (prevDivRaw && typeof prevDivRaw === 'object' && prevDivRaw.use_dead_ends !== undefined && prevDivRaw.use_dead_ends !== divUseDead)
  );

  if (divCmd || countNeedsSync || deadNeedsSync) {
    let divSeatId = prevDivObj.seat || '';
    let nextModel = prevDivObj.model || '';
    if (divCmd) {
      const resolved = ensureSeat(divCmd);
      if (resolved) {
        divSeatId = resolved;
        nextModel = divMdl;
      }
    } else if (!divSeatId) {
      divSeatId = ensureSeat(pickDefaultSeatId(outObj));
    }
    if (divSeatId) {
      const nextDiv = { seat: divSeatId, model: nextModel };
      if (divCount !== null && (countNeedsSync || prevDivObj.count !== undefined)) {
        nextDiv.count = divCount;
      } else if (prevDivObj.count !== undefined) {
        nextDiv.count = prevDivObj.count;
      }
      if (divUseDead !== null && (deadNeedsSync || prevDivObj.use_dead_ends !== undefined)) {
        nextDiv.use_dead_ends = divUseDead;
      } else if (prevDivObj.use_dead_ends !== undefined) {
        nextDiv.use_dead_ends = prevDivObj.use_dead_ends;
      }
      outObj.lineup = { ...(outObj.lineup || {}), diverge: nextDiv };
    }
  }

  const revTokens = Array.isArray(revRaw)
    ? revRaw.map((x) => parseSlotSpecToken(unwrapPlain(x))).filter(Boolean)
    : (typeof revRaw === 'string' && revRaw.trim()
      ? revRaw.split(',').map((t) => parseSlotSpecToken(t)).filter(Boolean)
      : []);
  if (revTokens.length > 0) {
    const nextRev = [];
    for (const t of revTokens) {
      const seatId = ensureSeat(t.executor);
      if (!seatId) continue;
      const item = { seat: seatId, model: t.model || '' };
      if (t.id && /^[A-Za-z0-9_-]+$/.test(t.id)) item.id = t.id;
      nextRev.push(item);
    }
    if (nextRev.length > 0) {
      outObj.lineup = { ...(outObj.lineup || {}), review: nextRev };
      outObj.default_backends = [...new Set(nextRev.map((r) => r.seat))];
    }
  }

  if (novCmd) {
    const seatId = ensureSeat(novCmd);
    if (seatId) {
      outObj.lineup = { ...(outObj.lineup || {}), novelty: { seat: seatId, model: novMdl } };
    }
  }

  if (JSON.stringify(origObj) === JSON.stringify(outObj)) {
    return { ok: true, synced: false, file, lineup: outObj.lineup || null };
  }

  if (outObj.version === undefined || outObj.version < 2) {
    outObj.version = 2;
  }
  writeJsonAtomicSync(file, outObj);
  return { ok: true, synced: true, file, lineup: outObj.lineup || null };
}
