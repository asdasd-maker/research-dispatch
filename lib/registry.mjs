// 座位表加载与身份解析 —— 分派层唯一的配置入口。
//
// 配置文件路径（按优先级）：
//   1. 环境变量 DSH_DISPATCH_CONFIG 指向的 JSON
//   2. <仓库根>/dispatch/seats.json          ← 提交进仓库的可编辑默认值，字段说明见插件 README
// 单次调用参数（环境变量，均与旧版脚本同名，不新建口径）：
//   BACKENDS="codex dsh qoder"        本轮只跑这几座
//   <SEAT>_MODEL / <SEAT>_EFFORT        该座的显式模型 / 推理档（走 -explicit，不读配置文件）
//   <SEAT>_BODY / <SEAT>_SHA            delivery 类座位的待投递正文 / payload 绑定 sha
//   API_*                                api 座的端点、模型、票数、温度（见 seats.json 的 api 段）
import fs from 'node:fs';
import path from 'node:path';
import { expandHome, resolveModel, dshTag, seatAttestToken, qoderSelfModel } from './models.mjs';
import { readDshOverrides, overrideOf } from './settings-file.mjs';

// DSH 设置面板写下的值：进程内读一次就够（CLI 是短命进程，面板改动发生在下一轮）。
let _dshCache;
export function dshOverrides() {
  if (_dshCache === undefined) _dshCache = readDshOverrides();
  return _dshCache;
}

export function configPath(root, explicit) {
  // 优先级：调用方显式给的（设置面板的 seatsFile）> DSH_DISPATCH_CONFIG > 仓库默认
  const override = explicit || process.env.DSH_DISPATCH_CONFIG;
  if (override) return path.resolve(root, override);
  return path.join(root, 'dispatch', 'seats.json');
}

export function loadConfig(root, explicit) {
  const file = configPath(root, explicit);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    const err = new Error('找不到座位表 ' + file + ' —— 分派层没有可读的配置，票源与塌缩断言都无法工作');
    err.code = 'NO_CONFIG';
    throw err;
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    const err = new Error('座位表 ' + file + ' 不是合法 JSON：' + e.message + ' —— 票源与塌缩断言都无法工作');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  if (!cfg || !Array.isArray(cfg.seats)) {
    const err = new Error('座位表 ' + file + ' 缺少 seats 数组 —— 票源与塌缩断言都无法工作');
    err.code = 'BAD_CONFIG';
    throw err;
  }
  cfg.__file = file;
  return cfg;
}

// manual* 这类座位名不是枚举出来的：配置里用 seat_pattern 声明一族，运行时按实际名字命中。
export function findSeat(cfg, be) {
  for (const s of cfg.seats) {
    if (s.id === be) return s;
    if (s.seat_pattern && new RegExp('^' + s.seat_pattern + '$').test(be)) return s;
  }
  return null;
}

export function enabledSeatIds(cfg) {
  return cfg.seats.filter((s) => s.enabled).map((s) => s.id);
}

// 座位名 → 环境变量里的占位符（manual1 → MANUAL1）
export function seatUpper(be) {
  return be.toUpperCase();
}

function interpolateSeat(tpl, be) {
  return String(tpl || '').replace(/\{SEAT_UPPER\}/g, seatUpper(be)).replace(/\{SEAT\}/g, be);
}

export function seatEnvName(seat, field, be) {
  return interpolateSeat(seat[field] || '', be);
}

/**
 * 这一座的身份标签。三种来源必须能区分，否则票面会说谎：
 *   <name>-from-config   配置回读（可证）
 *   <name>-explicit      人显式点名（可证）
 *   unknown-check-config 读不出来 / 自报（不可证，进不了 priors）
 *   <name>-manual-attested  署名票且绑上了 payload sha（可证，但要人担责）
 */
/**
 * 显式模型的优先级：环境变量 > 设置文档里的旧面板字段（<座>Model，仅兼容老配置）>
 * 座位表里的 seat.model_override > （config 类再退回读该 CLI 自己的配置文件）。
 *
 * 此前：面板不再持有逐座覆盖，座位是数据、唯一落点是 dispatch/seats.json。
 * 旧字段仍读一层，是为了让升级前存进设置文档的值不突然失效；写路径已经没有了。
 */
function explicitModelOf(seat, id) {
  const legacyField = id.dsh_setting || (seat.id + 'Model');
  const legacy = overrideOf(dshOverrides().config, legacyField);
  return process.env[id.explicit_env || ''] || legacy || seat.model_override || '';
}

export function seatIdentity(seat, ctx) {
  const id = seat.identity || {};
  const kind = id.kind || 'config';
  const be = ctx.seat;
  const explicit = explicitModelOf(seat, id);
  if (kind === 'manual') return seatAttestToken(be, ctx.payloadSha);
  if (kind === 'settings') return explicit ? explicit + '-explicit' : dshTag();
  if (kind === 'api') return apiModel(seat);
  // selfdeclared 放在 manual 之后：自报身份本身【永不】进先验，只有署名票形态才放行 ——
  // 座位声明了 model_env + attest_sha_env，且人交回的 sha 与当前 payload 一致（由
  // seatAttestToken 唯一裁定，缺任一条它返回 unknown-check-config）。qoder 就属这一种：
  // 只给自报名 → unknown；连 payload sha 一起交回 → <name>-manual-attested。
  if (kind === 'selfdeclared') {
    if (seat.model_env && seat.attest_sha_env) return seatAttestToken(be, ctx.payloadSha);
    return 'unknown-check-config';
  }
  const cfgFile = expandHome(process.env[id.file_env || ''] || id.default_file || '');
  return resolveModel(explicit, cfgFile, id.pattern, id.cut_field);
}

// api 座的模型：与其它 kind 同一条优先级（环境变量 > 面板 > model_override > 座位表默认）。
// 必须放在这里而不是调用点各算一遍 —— 卡 meta 与真正传 --model 的值来自同一个函数，
// 否则"卡上写着面板里的模型、实跑用的是 API_MODEL"，异构性断言比的是两个不同的东西。
export function apiModel(seat) {
  const env = process.env;
  const legacyField = (seat.identity && seat.identity.dsh_setting) || (seat.id + 'Model');
  const legacy = overrideOf(dshOverrides().config, legacyField);
  return env[seat.model.env] || legacy || seat.model_override || seat.model.default;
}

// argv 模板展开：{workers_dir} {tmp} {payload} {patch} {optional_args}
// {optional_args} 是唯一可展开成 0..N 个 token 的占位符（模型/档位是可选参数，不配就不出现）。
export function buildArgv(seat, ctx) {
  const optional = [];
  for (const o of seat.optional_args || []) {
    const v = process.env[o.env] || '';
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
    // 占位符必须【一次】替换：payload 是用户内容，里面出现字面量 {patch} 不许被再展开。
    // 做法是按 {payload} 把模板切成段，只在段内替换其它占位符，最后把 payload 拼回去。
    const subst = (s) => s.replace(/\{workers_dir\}/g, ctx.workersDir)
                             .replace(/\{tmp\}/g, ctx.tmp || '')
                             .replace(/\{patch\}/g, ctx.patch || '');
    out.push(t.split('{payload}').map(subst).join(ctx.payloadText || ''));
  }
  return out;
}
// 三家评审位的当前生效值，一行一个；自报类座位只在显式配置了模型时才追加自己那一行。
// 顺序与配置里的座位顺序一致 —— 旧版是 codex/claude/dsh/(qoder)，默认表逐字节相同。
// 这里从座位表读，而不是把三个配置路径再抄一遍：抄一遍就是第二个实现，迟早与派工漂移。
export function reviewModels(cfg) {
  const out = [];
  for (const seat of cfg.seats) {
    const kind = (seat.identity && seat.identity.kind) || 'config';
    if (kind === 'config' || kind === 'settings' || (kind === 'api' && seat.model)) {
      // api 座也进同族比对（按设计）：BACKENDS=api 时塌缩断言算它一票，
      // 同族留痕若不含它，diverge 与 fanout 两个消费方口径就分了家。
      out.push(seatIdentity(seat, { seat: seat.id, payloadSha: '' }));
    } else if (kind === 'selfdeclared') {
      const q = qoderSelfModel();
      if (q) out.push(q);
    }
  }
  return out;
}

/**
 * 本轮"没指定评审票"时跑哪几座 —— 只看座位表的 default_backends。
 *
 * 此前：面板上的「默认座位」已删除。它和"评审环节的票"是同一件事的两个说法：
 * 票非空时它完全不生效，票为空时它才接管 —— 一个平时不起作用的输入框只会误导。
 * 现在唯一可见的控制点是评审票（几票 = 几座）；座位表这几行是"没有 DSH 时"的兜底。
 * @returns {string[]}
 */
export function effectiveDefaultBackends(cfg) {
  return cfg.default_backends || ['codex', 'claude', 'dsh'];
}

/**
 * 面板设定的执行方式（cli / api / subagent）。留空 = 按座位表。
 * 只在 kind 层面生效：命令、argv 仍由座位表决定 —— 界面不编辑结构字段。
 * @param {object} seat
 * @returns {string} 归一化后的执行方式，或空串
 */
/**
 * 座位**实际生效的**执行方式（cli / api / delivery）。面板与座位表的 executor_override
 * 都可以改掉它 —— 派工、票数统计、诊断输出必须用同一个结果，否则"计划 N 票"会和真正
 * 派出去的座位数对不上，或者界面上改成 subagent 而 seats 输出还说 cli。
 */
export function seatKindOf(seat) {
  if (!seat) return '';
  const ov = executorOverrideOf(seat);
  return ov === 'subagent' ? 'delivery' : (ov || seat.kind);
}

export function executorOverrideOf(seat) {
  if (!seat || !seat.id) return '';
  const legacyField = ((seat.identity && seat.identity.dsh_setting) || (seat.id + 'Model')).replace(/Model$/, 'Executor');
  const legacy = overrideOf(dshOverrides().config, legacyField);
  // 第二优先级是座位表自己的 executor_override：改 seats.json 就换执行方式 ——
  // 它以前是个写了没人读的死字段，现在是真的落点。
  const v = legacy || seat.executor_override || '';
  if (!v) return '';
  const norm = v === 'delivery' || v === 'subagent' ? 'subagent' : v;
  return ['cli', 'api', 'subagent'].includes(norm) ? norm : '';
}

/**
 * 面板里的评审票（可自由增删）。
 * DSL：`exec:model,exec:model` —— 不含引号，能安全穿过 YAML 设置文档。
 * @returns {Array<{executor: string, model: string}>} 空数组 = 没配，按座位表
 */
export function panelVotes() {
  const raw = overrideOf(dshOverrides().config, 'reviewVotes');
  if (!raw) return [];
  return String(raw).split(',').map((tok) => {
    const t = tok.trim();
    if (!t) return null;
    const i = t.indexOf(':');
    const executor = (i < 0 ? t : t.slice(0, i)).trim();
    const model = i < 0 ? '' : t.slice(i + 1).trim();
    return executor ? { executor, model } : null;
  }).filter(Boolean);
}
