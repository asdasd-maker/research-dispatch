#!/usr/bin/env node
// 全链路纯 Node 普适研究流水线 CLI 主入口（v2.3.0）：
// 覆盖一键初始化、跨宿主 Agent/模型探测、四阶段自由阵容编排（scout / diverge / review / novelty）、
// S0 文献调研派工与成池、S1 基线监控、S2 双模式候选发散、S3 自包含盲审拆单、
// S4 仓外隔离多 Agent 评审与五维排序总表、S4.5 前置查重派工与 Pilot 2σ 统计检验、S5 状态盘面、S6 契约冻结。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { run, runDiverge, runScout, runNovelty } from '../lib/run.mjs';
import * as registryMod from '../lib/registry.mjs';
import {
  loadConfig,
  findSeat,
  seatIdentity,
  seatEnvName,
  buildArgv,
  reviewModels,
  dshOverrides,
  seatKindOf,
  resolveExecutionPlan,
  resolveDivergePlan,
  discoverAgents,
  updateLineup,
} from '../lib/registry.mjs';
import {
  normModel,
  modelFamily,
  dshTag,
  qoderTag,
  qoderSelfModel,
  seatAttestToken,
  resolveModel,
  dshLiveModel,
  expandHome,
  refreshAgyModelsCache,
} from '../lib/models.mjs';
import {
  scanPendingVerdicts,
  summarizeTopic,
} from '../lib/validators.mjs';
import {
  checkPaperCard,
  assemblePaperPool,
  makeBriefs,
  checkNoveltyReport,
  checkContractFile,
  watchRepro,
  initProject,
} from '../lib/workflow.mjs';
import {
  computePairedStats,
  formatPairedStatsReport,
} from '../lib/pilot-stats.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(here, '..', '..', '..');

function rootDir() {
  const envRoot = String(process.env.DSH_DISPATCH_ROOT || '').trim();
  if (envRoot) return path.resolve(envRoot);

  const cwd = process.cwd();
  if (process.env.DSH_DISPATCH_CONFIG) return cwd;

  // 1) 从当前工作目录向上查找包含 dispatch/seats.json 或 .flow/state.json 的项目根
  let dir = path.resolve(cwd);
  for (let i = 0; i < 5; i++) {
    if (
      fs.existsSync(path.join(dir, 'dispatch', 'seats.json'))
      || fs.existsSync(path.join(dir, '.flow', 'state.json'))
    ) {
      return dir;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }

  // 2) 若显式处于 DSH 宿主覆盖作用域且配置了 repoRoot，采用该工作区根
  const panelRoot = String(((dshOverrides().config || {}).repoRoot) || '').trim();
  if (panelRoot) return path.resolve(panelRoot);

  // 3) 仅当 cwd 位于 DEFAULT_ROOT 内部时才回退 DEFAULT_ROOT，避免在无关空目录运行时误串到其它项目
  const norm = (p) => {
    const clean = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? clean.toLowerCase() : clean;
  };
  const cwdN = norm(cwd);
  const defN = norm(DEFAULT_ROOT);
  if (
    (cwdN === defN || cwdN.startsWith(defN + path.sep))
    && fs.existsSync(path.join(DEFAULT_ROOT, 'dispatch', 'seats.json'))
  ) {
    return DEFAULT_ROOT;
  }

  return cwd;
}

function resolveUserPath(root, rawArg) {
  const s = String(rawArg || '').trim();
  if (!s) return '';
  if (path.isAbsolute(s)) return path.resolve(s);
  const fromCwd = path.resolve(process.cwd(), s);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.resolve(root, s);
}

function parseCliFlags(args, { booleans = [], strings = [] } = {}) {
  const boolSet = new Set(booleans);
  const strSet = new Set(strings);
  const flags = {};
  const pos = [];

  for (let i = 0; i < args.length; i++) {
    const tok = String(args[i]);
    if (tok === '--') {
      pos.push(...args.slice(i + 1).map(String));
      break;
    }
    if (!tok.startsWith('--') || tok === '-') {
      pos.push(tok);
      continue;
    }
    const eqIdx = tok.indexOf('=');
    const key = eqIdx >= 0 ? tok.slice(2, eqIdx) : tok.slice(2);
    const inlineVal = eqIdx >= 0 ? tok.slice(eqIdx + 1) : null;

    if (boolSet.has(key)) {
      if (inlineVal === null) {
        flags[key] = true;
      } else if (/^(true|1|yes)$/i.test(inlineVal)) {
        flags[key] = true;
      } else if (/^(false|0|no)$/i.test(inlineVal)) {
        flags[key] = false;
      } else {
        return { ok: false, pos, flags, error: '布尔选项 --' + key + ' 不接受值 ' + JSON.stringify(inlineVal) };
      }
      continue;
    }

    if (strSet.has(key)) {
      if (inlineVal !== null) {
        flags[key] = inlineVal;
      } else {
        if (i + 1 >= args.length) {
          return { ok: false, pos, flags, error: '选项 --' + key + ' 缺少参数值' };
        }
        flags[key] = String(args[++i]);
      }
      continue;
    }

    return { ok: false, pos, flags, error: '未知选项: ' + tok };
  }

  return { ok: true, pos, flags, error: '' };
}

function parseBoolToken(val) {
  const s = String(val ?? '').trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return null;
}

function resolveStage(cfg, stageName, opts = {}) {
  if (typeof registryMod.resolveStagePlan === 'function') {
    return registryMod.resolveStagePlan(cfg, stageName, opts);
  }
  return resolveDivergePlan(cfg, opts);
}

function formatStageLineupEntry(stObj, fallbackText = '默认（按配置）') {
  if (!stObj) return fallbackText;
  if (typeof stObj === 'string') return stObj;
  let base = stObj.model ? (stObj.seat + ':' + stObj.model) : (stObj.seat || fallbackText);
  if (stObj.effort && stObj.seat) base += '@' + stObj.effort;
  const extras = [];
  if (stObj.count !== undefined && stObj.count !== null) extras.push('count=' + stObj.count);
  if (stObj.use_dead_ends !== undefined && stObj.use_dead_ends !== null) {
    extras.push('use_dead_ends=' + Boolean(stObj.use_dead_ends));
  }
  return extras.length ? (base + ' (' + extras.join(', ') + ')') : base;
}

const USAGE = [
  '用法: research-dispatch <子命令> [参数]',
  '',
  '  初始化与阵容编排：',
  '    init [目录] [--force] [--topic <slug>]       在项目目录生成跨宿主研究流水线骨架（AGENTS.md / seats.json / 模板）',
  '    agents [--json] [--refresh]                  探测本机已安装的 CLI Agent、API 环境变量及可用模型目录',
  '    lineup [--scout <spec>] [--diverge <spec>]   查看或持久化更新项目 dispatch/seats.json 的四阶段阵容与发散策略',
  '           [--scout-effort <lv>] [--diverge-effort <lv>] [--novelty-effort <lv>]',
  '           [--diverge-count <N>] [--use-dead-ends | --no-dead-ends]',
  '           [--review <spec>] [--novelty <spec>] [--reset] [--require-unique-models] [--json]',
  '',
  '  全链路科研流水线（S0 → S6）：',
  '    scout <调研方向> [篇数=5] [--cards <dir>]    [S0] 派工文献调研（LaTeX/Markdown 优先），逐张校验文献卡',
  '          [--agent <seat[:model]>] [--pool] [--dry]',
  '    check-paper <card.md> [--json]               [S0] 校验单张文献卡 YAML 结构与必填字段',
  '    pool [--cards <dir>] [--out <file>] [--dry]  [S0] 汇总合格文献卡生成 _pool.md（坏卡移入 rejected/）',
  '    repro-watch <baseline_dir> [--log <file>]    [S1] 校验基线数据哈希与复现训练日志心跳',
  '    diverge <方向> [条数] [--topic <slug>]       [S2] 调用选定 Agent 结合文献池、基线与可选 dead-ends.md 发散候选',
  '            [--baseline <dir>] [--pool <file>] [--dead-ends <file> | --no-dead-ends] [--agent <seat[:model]>] [--dry]',
  '    briefs <raw.md> [--topic <slug>]             [S3] 校验溯源与单条自包含性，拆分为盲审工单',
  '           [--baseline <dir>] [--out <dir>] [--force] [--allow-reanchor]',
  '    plan <工单> [--review <spec>]                [S4] 免费打印本轮评审计划（JSON），不调用任何模型',
  '    run <工单> [--dry] [--review <spec>]         [S4] 仓外临时目录隔离跑完整一轮多 Agent 盲审落卡',
  '    summary [--topic <slug>] [--out <file>]      [S4] 生成跨工单各票裁决、五维均分排序与核心理由对比总表 _summary.md',
  '            [--sort rank|id] [--no-write] [--json]',
  '    status [--topic <slug>] [--json]             [S5] 盘点待人工写 verdict-<id>.md 或未派工的工单',
  '    novelty <工单路径或ID> [--topic <slug>]      [S4.5] 推式单单隔离派工前置查重并自动运行 check-novelty 闸门',
  '            [--pool <file>] [--out <file>] [--agent <seat[:model]>] [--dry]',
  '    check-novelty <report.md> [--json]           [S4.5] 校验入围候选的前置新颖度查重报告',
  '    pilot-stats <armA> <armB>                    [S4.5] 计算 Pilot 双臂配对准确率、2σ MDE 与合规子集偏差',
  '                [--compliant-field <k>] [--json]',
  '    check-contract <contract.md> [--record]      [S6] 校验实验与消融契约并写入 5 列 CHANGELOG.md 哈希冻结',
  '                   [--re-record --reason <text>]',
  '',
  '  底层诊断与模型工具：',
  '    seats | review-models | stages | stage-exec <scout|diverge|review|novelty> | stage-model <scout|diverge|review|novelty>',
  '    norm-model <串> | model-family <串> | dsh-live | dsh-tag | qoder-tag | qoder-self',
  '    seat-token <座位> | argv <座位> | resolve-model <显式> <配置文件> <正则> <字段>',
  '',
  '退出码: 0 正常 / 1 内容不合规或降级或用法错 / 2 基础设施或输入缺失 / 3 显式异构门禁下塌缩作废 / 8 基线锚点不合格',
].join('\n');

export async function main(argv) {
  const cmd = argv[0] || '';
  const rest = argv.slice(1);
  const root = rootDir();

  if (cmd === '' || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(USAGE + '\n');
    return 0;
  }

  // ── 1) init ─────────────────────────────────────────────────────────────
  if (cmd === 'init') {
    const p = parseCliFlags(rest, { booleans: ['force', 'json'], strings: ['topic'] });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    if (p.pos.length > 1) {
      process.stderr.write('用法: dispatch.mjs init [目标目录] [--force] [--topic <slug>]\n');
      return 1;
    }
    const envRoot = String(process.env.DSH_DISPATCH_ROOT || '').trim();
    const targetDir = p.pos[0]
      ? path.resolve(process.cwd(), p.pos[0])
      : (envRoot ? path.resolve(envRoot) : path.resolve(process.cwd()));
    let res;
    try {
      res = initProject(targetDir, {
        force: Boolean(p.flags.force),
        topic: p.flags.topic || null,
      });
    } catch (e) {
      process.stderr.write('✗ ' + (e && e.message ? e.message : String(e)) + '\n');
      return 1;
    }
    if (p.flags.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else {
      process.stdout.write('✓ 已初始化研究项目目录: ' + targetDir + '\n');
      if (Array.isArray(res.created) && res.created.length > 0) {
        process.stdout.write('  新建文件 (' + res.created.length + '):\n');
        for (const f of res.created) process.stdout.write('    + ' + f + '\n');
      }
      if (Array.isArray(res.skipped) && res.skipped.length > 0) {
        process.stdout.write('  保留已有文件 (' + res.skipped.length + '，传 --force 可覆盖):\n');
        for (const f of res.skipped) process.stdout.write('    = ' + f + '\n');
      }
      process.stdout.write('  下一步：运行 npx research-dispatch agents 查看可用模型，再用 npx research-dispatch lineup 编排阵容。\n');
    }
    return res.rc !== undefined ? res.rc : (res.ok === false ? 1 : 0);
  }

  // ── 2) agents ───────────────────────────────────────────────────────────
  if (cmd === 'agents') {
    const p = parseCliFlags(rest, { booleans: ['json', 'refresh'] });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    await refreshAgyModelsCache({ force: Boolean(p.flags.refresh), timeoutMs: 6000 });
    const res = discoverAgents(root);
    if (p.flags.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return 0;
    }
    process.stdout.write('本机可用 Agent 与模型目录：\n');
    for (const a of res.agents) {
      const mark = a.installed ? '✓' : '·';
      if (a.kind === 'api') {
        const keys = (a.configured_keys && a.configured_keys.length) ? a.configured_keys.join(', ') : '未检测到 API Key 环境变量';
        const def = a.default_model ? (' · 默认模型: ' + a.default_model) : '';
        process.stdout.write('  [' + mark + '] api      (' + keys + def + ')\n');
      } else {
        const def = a.default_model || (a.installed ? '按 CLI 默认' : '未安装');
        const cand = (a.models && a.models.length)
          ? (' · 候选(' + a.models.length + '): ' + a.models.slice(0, 6).join(', ') + (a.models.length > 6 ? ' …' : ''))
          : '';
        process.stdout.write('  [' + mark + '] ' + a.id.padEnd(8, ' ') + ' 默认: ' + def + cand + '\n');
      }
    }
    if (res.lineup) {
      const revStr = Array.isArray(res.lineup.review) && res.lineup.review.length > 0
        ? res.lineup.review.map((r) => (r.model ? (r.seat + ':' + r.model) : r.seat) + (r.effort ? ('@' + r.effort) : '')).join(', ')
        : res.lineup.default_backends.join(', ');
      const scoutStr = formatStageLineupEntry(res.lineup.scout, '默认（跟随发散/配置）');
      const divStr = formatStageLineupEntry(res.lineup.diverge, '默认（按配置）');
      const novStr = formatStageLineupEntry(res.lineup.novelty, '默认（跟随发散/配置）');
      process.stdout.write('\n当前项目阵容 (' + res.config + ')：\n');
      process.stdout.write('  调研 (scout)  : ' + scoutStr + '\n');
      process.stdout.write('  发散 (diverge): ' + divStr + '\n');
      process.stdout.write('  评审 (review) : ' + revStr + '\n');
      process.stdout.write('  查重 (novelty): ' + novStr + '\n');
      process.stdout.write('  强制异构门禁  : ' + (res.lineup.require_unique_models ? '开启 (require_unique_models=true)' : '关闭 (默认允许同模型自由组合)') + '\n');
    }
    return 0;
  }

  // ── 3) lineup ───────────────────────────────────────────────────────────
  if (cmd === 'lineup') {
    // 兼容布尔选项带显式 true/false 参数值（如 `--require-unique-models false`、`--use-dead-ends false`）
    const normRest = [];
    for (let i = 0; i < rest.length; i++) {
      const tok = String(rest[i]);
      if ((tok === '--require-unique-models' || tok === '--use-dead-ends') && i + 1 < rest.length && parseBoolToken(rest[i + 1]) !== null) {
        normRest.push(tok + '=' + rest[i + 1]);
        i += 1;
      } else {
        normRest.push(tok);
      }
    }
    const p = parseCliFlags(normRest, {
      booleans: ['reset', 'json', 'require-unique-models', 'no-require-unique-models', 'use-dead-ends', 'no-dead-ends'],
      strings: ['scout', 'scout-effort', 'diverge', 'diverge-effort', 'diverge-count', 'review', 'novelty', 'novelty-effort'],
    });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    if (p.flags['use-dead-ends'] === true && p.flags['no-dead-ends'] === true) {
      process.stderr.write('✗ --use-dead-ends 与 --no-dead-ends 不能同时指定\n');
      return 1;
    }

    let divergeCount;
    if (p.flags['diverge-count'] !== undefined) {
      const n = Number(p.flags['diverge-count']);
      if (!Number.isInteger(n) || n < 1 || n > 50) {
        process.stderr.write('✗ --diverge-count 必须是 1..50 的整数，实得: ' + JSON.stringify(p.flags['diverge-count']) + '\n');
        return 1;
      }
      divergeCount = n;
    }

    let useDeadEnds;
    if (p.flags['no-dead-ends']) {
      useDeadEnds = false;
    } else if (p.flags['use-dead-ends'] !== undefined) {
      useDeadEnds = Boolean(p.flags['use-dead-ends']);
    }

    let requireUniqueModels;
    if (p.flags['no-require-unique-models']) {
      requireUniqueModels = false;
    } else if (p.flags['require-unique-models'] !== undefined) {
      requireUniqueModels = Boolean(p.flags['require-unique-models']);
    }

    const hasMutation = p.flags.scout !== undefined
      || p.flags['scout-effort'] !== undefined
      || p.flags.diverge !== undefined
      || p.flags['diverge-effort'] !== undefined
      || divergeCount !== undefined
      || useDeadEnds !== undefined
      || p.flags.review !== undefined
      || p.flags.novelty !== undefined
      || p.flags['novelty-effort'] !== undefined
      || Boolean(p.flags.reset)
      || requireUniqueModels !== undefined;

    if (hasMutation) {
      const updated = updateLineup(root, {
        scout: p.flags.scout,
        scoutEffort: p.flags['scout-effort'],
        diverge: p.flags.diverge,
        divergeEffort: p.flags['diverge-effort'],
        divergeCount,
        useDeadEnds,
        review: p.flags.review,
        novelty: p.flags.novelty,
        noveltyEffort: p.flags['novelty-effort'],
        reset: Boolean(p.flags.reset),
        requireUniqueModels,
      });
      if (p.flags.json) {
        process.stdout.write(JSON.stringify(updated, null, 2) + '\n');
      } else {
        process.stdout.write('✓ 已更新项目阵容配置: ' + updated.file + '\n');
        const ln = updated.lineup || {};
        const rev = Array.isArray(ln.review)
          ? ln.review.map((r) => (r.model ? (r.seat + ':' + r.model) : r.seat) + (r.effort ? ('@' + r.effort) : '')).join(', ')
          : updated.default_backends.join(', ');
        process.stdout.write('  调研座位 (scout)  : ' + formatStageLineupEntry(ln.scout, '默认（跟随发散/配置）') + '\n');
        process.stdout.write('  发散座位 (diverge): ' + formatStageLineupEntry(ln.diverge, '默认（按配置）') + '\n');
        process.stdout.write('  评审阵容 (review) : ' + rev + '\n');
        process.stdout.write('  查重座位 (novelty): ' + formatStageLineupEntry(ln.novelty, '默认（跟随发散/配置）') + '\n');
        process.stdout.write('  require_unique_models: ' + String(Boolean(updated.policy && updated.policy.require_unique_models)) + '\n');
      }
      return 0;
    }

    const cfg = loadConfig(root);
    const scoutRes = resolveStage(cfg, 'scout');
    const divRes = resolveDivergePlan(cfg);
    const planRes = resolveExecutionPlan(cfg);
    const novRes = resolveStage(cfg, 'novelty');
    const out = {
      config: cfg.__file,
      source: planRes.source,
      require_unique_models: Boolean(cfg.policy && cfg.policy.require_unique_models === true),
      scout: scoutRes.ok ? { source: scoutRes.source, seat: scoutRes.seatId, model: scoutRes.model || '', effort: scoutRes.effort || '' } : { error: scoutRes.error },
      diverge: divRes.ok ? {
        source: divRes.source,
        seat: divRes.seatId,
        model: divRes.model || '',
        effort: divRes.effort || '',
        count: divRes.defaultCount ?? 10,
        use_dead_ends: divRes.defaultUseDeadEnds !== false,
      } : { error: divRes.error },
      review: planRes.ok ? planRes.slots : [],
      novelty: novRes.ok ? { source: novRes.source, seat: novRes.seatId, model: novRes.model || '', effort: novRes.effort || '' } : { error: novRes.error },
      ...(planRes.ok ? {} : { error: planRes.error }),
    };
    if (p.flags.json) {
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    } else {
      process.stdout.write('当前生效阵容 (' + cfg.__file + ')：\n');
      if (scoutRes.ok) {
        process.stdout.write('  调研 (source=' + scoutRes.source + '): '
          + scoutRes.seatId + (scoutRes.model ? (':' + scoutRes.model) : '') + (scoutRes.effort ? ('@' + scoutRes.effort) : '') + '\n');
      } else {
        process.stderr.write('  ✗ 调研配置异常: ' + scoutRes.error + '\n');
      }
      if (divRes.ok) {
        process.stdout.write('  发散 (source=' + divRes.source + '): '
          + divRes.seatId + (divRes.model ? (':' + divRes.model) : '') + (divRes.effort ? ('@' + divRes.effort) : '')
          + ' [count=' + (divRes.defaultCount ?? 10) + ', use_dead_ends=' + String(divRes.defaultUseDeadEnds !== false) + ']\n');
      } else {
        process.stderr.write('  ✗ 发散配置异常: ' + divRes.error + '\n');
      }
      if (planRes.ok) {
        process.stdout.write('  评审 (source=' + planRes.source + '): '
          + planRes.slots.map((s) => (s.model ? (s.tag + '[' + s.seat + ':' + s.model + (s.effort ? '@' + s.effort : '') + ']') : (s.tag + (s.effort ? '@' + s.effort : '')))).join(', ') + '\n');
      } else {
        process.stderr.write('  ✗ 评审计划异常: ' + planRes.error + '\n');
      }
      if (novRes.ok) {
        process.stdout.write('  查重 (source=' + novRes.source + '): '
          + novRes.seatId + (novRes.model ? (':' + novRes.model) : '') + (novRes.effort ? ('@' + novRes.effort) : '') + '\n');
      } else {
        process.stderr.write('  ✗ 查重配置异常: ' + novRes.error + '\n');
      }
      process.stdout.write('  require_unique_models: ' + String(out.require_unique_models) + '\n');
    }
    return planRes.ok && divRes.ok && scoutRes.ok && novRes.ok ? 0 : 2;
  }

  // ── 4) scout / check-paper / pool (S0) ──────────────────────────────────
  if (cmd === 'scout') {
    const p = parseCliFlags(rest, {
      booleans: ['pool', 'dry'],
      strings: ['cards', 'out', 'agent', 'effort'],
    });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    if (p.pos.length === 0) {
      process.stderr.write('用法: dispatch.mjs scout <调研方向> [篇数=5] [--cards <dir>] [--agent <seat[:model][@effort]>] [--effort <level>] [--pool] [--dry]\n');
      return 1;
    }
    if (p.pos.length > 2) {
      process.stderr.write('!! scout 最多接受两个位置参数：<调研方向> [篇数]，多余参数：' + p.pos.slice(2).join(' ') + '\n');
      return 1;
    }
    return await runScout({
      root,
      query: p.pos[0],
      count: p.pos[1],
      cardsDir: p.flags.cards,
      outFile: p.flags.out,
      agent: p.flags.agent,
      effort: p.flags.effort,
      assemblePool: Boolean(p.flags.pool),
      dry: Boolean(p.flags.dry),
    });
  }

  if (cmd === 'check-paper') {
    const p = parseCliFlags(rest, { booleans: ['json'] });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    if (!p.pos[0]) {
      process.stderr.write('用法: dispatch.mjs check-paper <文献卡.md> [--json]\n');
      return 1;
    }
    const cardAbs = resolveUserPath(root, p.pos[0]);
    const res = checkPaperCard(cardAbs);
    const rc = res.rc !== undefined ? res.rc : (res.ok ? 0 : 1);
    if (p.flags.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return rc;
    }
    if (res.stdout) process.stdout.write(String(res.stdout).replace(/\n?$/, '\n'));
    if (res.stderr) process.stderr.write(String(res.stderr).replace(/\n?$/, '\n'));
    if (res.ok && !res.stdout) {
      process.stdout.write('✓ 文献卡校验通过: ' + p.pos[0] + '\n');
    }
    return rc;
  }

  if (cmd === 'pool') {
    const p = parseCliFlags(rest, { booleans: ['dry', 'json'], strings: ['cards', 'out'] });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    const res = assemblePaperPool(root, {
      cardsDir: p.flags.cards || 'papers/cards',
      outFile: p.flags.out || 'papers/cards/_pool.md',
      dry: Boolean(p.flags.dry),
    });
    const rc = res.rc !== undefined ? res.rc : (res.ok ? 0 : 1);
    if (p.flags.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return rc;
    }
    if (res.stdout) process.stdout.write(String(res.stdout).replace(/\n?$/, '\n'));
    if (res.stderr) process.stderr.write(String(res.stderr).replace(/\n?$/, '\n'));
    if (res.ok && !res.stdout) {
      process.stdout.write('✓ 文献池组装完成: 合格 ' + (res.validCount ?? 0) + ' 张 → ' + (res.outPath || p.flags.out || 'papers/cards/_pool.md') + '\n');
    }
    return rc;
  }

  // ── 5) diverge (S2) ─────────────────────────────────────────────────────
  if (cmd === 'diverge') {
    const p = parseCliFlags(rest, {
      booleans: ['dry', 'no-baseline', 'no-dead-ends', 'use-dead-ends'],
      strings: ['topic', 'baseline', 'pool', 'dead-ends', 'agent', 'effort'],
    });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    if (p.flags['dead-ends'] !== undefined && p.flags['no-dead-ends']) {
      process.stderr.write('✗ --no-dead-ends 与 --dead-ends 不能同时指定（前者启用纯空白发散模式，后者显式挂载死胡同文件）\n');
      return 1;
    }
    if (p.flags['use-dead-ends'] && p.flags['no-dead-ends']) {
      process.stderr.write('✗ --use-dead-ends 与 --no-dead-ends 不能同时指定\n');
      return 1;
    }
    if (p.pos.length === 0) {
      process.stderr.write('用法: dispatch.mjs diverge <方向描述> [条数=10] [--topic <slug>] [--baseline <dir>] [--pool <file>] [--dead-ends <file> | --no-dead-ends] [--agent <seat[:model][@effort]>] [--effort <level>] [--dry]\n');
      return 1;
    }
    if (p.pos.length > 2) {
      process.stderr.write('!! diverge 最多接受两个位置参数：<方向描述> [条数]，多余参数：' + p.pos.slice(2).join(' ') + '\n');
      return 1;
    }
    return await runDiverge({
      root,
      direction: p.pos[0],
      count: p.pos[1],
      topic: p.flags.topic,
      baselineDir: p.flags.baseline,
      noBaseline: Boolean(p.flags['no-baseline']),
      poolFile: p.flags.pool,
      deadEndsFile: p.flags['dead-ends'],
      noDeadEnds: p.flags['no-dead-ends'] ? true : undefined,
      useDeadEnds: p.flags['use-dead-ends'] ? true : undefined,
      agent: p.flags.agent,
      effort: p.flags.effort,
      dry: Boolean(p.flags.dry),
    });
  }

  // ── 6) briefs (S3) ──────────────────────────────────────────────────────
  if (cmd === 'briefs') {
    const p = parseCliFlags(rest, {
      booleans: ['force', 'allow-reanchor', 'allow-no-provenance', 'json'],
      strings: ['baseline', 'topic', 'out'],
    });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    if (!p.pos[0]) {
      process.stderr.write('用法: dispatch.mjs briefs <raw-pool.md> [--topic <slug>] [--baseline <dir>] [--out <dir>] [--force] [--allow-reanchor]\n');
      return 1;
    }
    const rawAbs = resolveUserPath(root, p.pos[0]);
    const res = makeBriefs(root, rawAbs, {
      baselineDir: p.flags.baseline || null,
      topic: p.flags.topic || null,
      outDir: p.flags.out || null,
      force: Boolean(p.flags.force),
      allowReanchor: Boolean(p.flags['allow-reanchor']),
      allowNoProvenance: Boolean(p.flags['allow-no-provenance']),
    });
    const rc = res.rc !== undefined ? res.rc : (res.ok ? 0 : 1);
    if (p.flags.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return rc;
    }
    if (res.stdout) process.stdout.write(String(res.stdout).replace(/\n?$/, '\n'));
    if (res.stderr) process.stderr.write(String(res.stderr).replace(/\n?$/, '\n'));
    if (res.ok && !res.stdout) {
      process.stdout.write('✓ 已拆出工单 ' + ((res.created && res.created.length) || 0) + ' 份 → ' + (res.outDir || '') + '\n');
    }
    return rc;
  }

  // ── 7) run & plan (S4) ──────────────────────────────────────────────────
  if (cmd === 'run') {
    const p = parseCliFlags(rest, {
      booleans: ['dry', 'calibration'],
      strings: ['review'],
    });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    if (p.pos.length === 0) {
      process.stderr.write('用法: dispatch.mjs run <工单>\n');
      return 1;
    }
    if (p.pos.length > 1) {
      process.stdout.write('!! 只接受一个工单，多出来的是：' + p.pos.slice(1).join(' ') + '\n');
      process.stdout.write('   一条命令扇一单：for f in a.md b.md; do npx research-dispatch run "$f"; done\n');
      process.stdout.write('   （静默取第一个 = 第二单的票根本没生成，而退出码照样是 0）\n');
      return 1;
    }
    return await run({
      root,
      briefArg: p.pos[0],
      dry: p.flags.dry ? true : undefined,
      calibration: p.flags.calibration ? true : undefined,
      reviewSpec: p.flags.review,
    });
  }

  if (cmd === 'plan') {
    const p = parseCliFlags(rest, { strings: ['review'] });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    const brief = p.pos[0];
    if (!brief) {
      process.stderr.write('用法: dispatch.mjs plan <工单>\n');
      return 1;
    }
    const cfg = loadConfig(root);
    const briefAbs = path.isAbsolute(brief) ? brief : path.join(root, brief);
    const planRes = resolveExecutionPlan(cfg, p.flags.review !== undefined ? { reviewSpec: p.flags.review } : {});
    if (!planRes.ok) {
      process.stderr.write('✗ ' + planRes.error + '\n');
      return 2;
    }
    const plan = [];
    const provenNorms = [];
    for (const sl of planRes.slots) {
      const be = sl.seat;
      const seat = findSeat(cfg, be);
      if (!seat) {
        plan.push({ slot: sl.tag, seat: be, error: 'unknown-seat' });
        continue;
      }
      const voteModel = sl.model || '';
      const effKind = seatKindOf(seat);
      const identity = seatIdentity(seat, {
        seat: sl.tag,
        payloadSha: process.env.FANOUT_PAYLOAD_SHA || '',
        voteModel,
      });
      const norm = normModel(identity);
      const proven = Boolean(norm) && norm !== 'unknown-check-config';
      if (proven) provenNorms.push(norm);
      const entry = {
        slot: sl.tag,
        seat: be,
        ...(voteModel ? { requested_model: voteModel } : {}),
        ...(sl.effort ? { effort: sl.effort } : {}),
        kind: seat.kind,
        effective_kind: effKind,
        enabled: seat.enabled !== false,
        executor: effKind === 'cli' ? (seat.command || 'cli') : effKind,
        identity,
        proven,
      };
      if (effKind === 'cli') {
        entry.argv_template = seat.argv;
        entry.patch = seat.patch_env ? (process.env[seat.patch_env] || seat.patch_default || '') : (seat.patch_default || '');
      }
      if (effKind === 'delivery') {
        entry.body_env = seatEnvName(seat, 'body_env', sl.tag) || (sl.tag.toUpperCase() + '_BODY');
        entry.declared_env = seatEnvName(seat, 'model_env', sl.tag) || (sl.tag.toUpperCase() + '_MODEL');
      }
      plan.push(entry);
    }
    const uniqProven = new Set(provenNorms);
    const sharedModels = provenNorms.length >= 2 && uniqProven.size < provenNorms.length;
    const requireUniqueModels = Boolean(
      (cfg.policy && cfg.policy.require_unique_models === true)
      || process.env.REQUIRE_UNIQUE_MODELS === '1'
    );
    process.stdout.write(JSON.stringify({
      root,
      brief: briefAbs,
      config: cfg.__file,
      source: planRes.source,
      require_unique_models: requireUniqueModels,
      shared_models: sharedModels,
      ...(planRes.skippedVotes.length ? { skipped_votes: planRes.skippedVotes } : {}),
      ...(planRes.duplicateVotes.length ? { duplicate_votes: planRes.duplicateVotes } : {}),
      plan,
    }, null, 2) + '\n');
    return 0;
  }

  // ── 8) summary & status (S4 / S5) ───────────────────────────────────────
  if (cmd === 'summary') {
    const p = parseCliFlags(rest, {
      booleans: ['no-write', 'json'],
      strings: ['topic', 'out', 'sort'],
    });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    const sortBy = p.flags.sort !== undefined ? String(p.flags.sort).trim() : 'rank';
    if (sortBy !== 'rank' && sortBy !== 'id') {
      process.stderr.write('✗ --sort 仅支持 rank 或 id，实得: ' + JSON.stringify(p.flags.sort) + '\n');
      return 1;
    }
    const res = summarizeTopic(root, {
      topic: p.flags.topic || null,
      writeFile: !p.flags['no-write'],
      outPath: p.flags.out || null,
      sortBy,
    });
    if (p.flags.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return res.rc ?? 0;
    }
    process.stdout.write(String(res.markdown || '').replace(/\n?$/, '\n'));
    if (!p.flags['no-write'] && res.outPath) {
      const rel = path.relative(root, res.outPath).replace(/\\/g, '/');
      process.stdout.write('\n✓ 横向对比总表已写入: ' + (rel.startsWith('..') ? res.outPath : rel) + '\n');
    }
    return res.rc ?? 0;
  }

  if (cmd === 'status') {
    const p = parseCliFlags(rest, { booleans: ['json'], strings: ['topic'] });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    const res = scanPendingVerdicts(root, { topic: p.flags.topic || null });
    if (p.flags.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else {
      process.stdout.write(String(res.report || '') + '\n');
    }
    return res.rc;
  }

  // ── 9) novelty / check-novelty / pilot-stats (S4.5) ─────────────────────
  if (cmd === 'novelty') {
    const p = parseCliFlags(rest, {
      booleans: ['dry'],
      strings: ['topic', 'pool', 'out', 'agent', 'effort'],
    });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    if (p.pos.length === 0) {
      process.stderr.write('用法: dispatch.mjs novelty <工单路径或ID> [--topic <slug>] [--pool <file>] [--out <file>] [--agent <seat[:model][@effort]>] [--effort <level>] [--dry]\n');
      return 1;
    }
    if (p.pos.length > 1) {
      process.stderr.write('!! novelty 只接受单个工单路径或工单 ID，多余参数：' + p.pos.slice(1).join(' ') + '\n');
      return 1;
    }
    return await runNovelty({
      root,
      brief: p.pos[0],
      topic: p.flags.topic,
      poolFile: p.flags.pool,
      outFile: p.flags.out,
      agent: p.flags.agent,
      effort: p.flags.effort,
      dry: Boolean(p.flags.dry),
    });
  }

  if (cmd === 'check-novelty') {
    const p = parseCliFlags(rest, { booleans: ['json'] });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    if (!p.pos[0]) {
      process.stderr.write('用法: dispatch.mjs check-novelty <查重报告.md> [--json]\n');
      return 1;
    }
    const repAbs = resolveUserPath(root, p.pos[0]);
    const res = checkNoveltyReport(repAbs);
    const rc = res.rc !== undefined ? res.rc : (res.ok ? 0 : 1);
    if (p.flags.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return rc;
    }
    if (res.stdout) process.stdout.write(String(res.stdout).replace(/\n?$/, '\n'));
    if (res.stderr) process.stderr.write(String(res.stderr).replace(/\n?$/, '\n'));
    if (res.ok && !res.stdout) {
      process.stdout.write('✓ 查重报告校验通过: ' + p.pos[0] + '\n');
    }
    return rc;
  }

  if (cmd === 'pilot-stats') {
    const p = parseCliFlags(rest, {
      booleans: ['json', 'check-prompt'],
      strings: ['compliant-field', 'id-field', 'item-field', 'correct-field', 'prompt-field', 'bootstrap', 'seed'],
    });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    if (p.pos.length < 2) {
      process.stderr.write('用法: dispatch.mjs pilot-stats <armA.jsonl> <armB.jsonl> [--compliant-field <k>] [--json]\n');
      return 1;
    }
    const armAAbs = resolveUserPath(root, p.pos[0]);
    const armBAbs = resolveUserPath(root, p.pos[1]);
    let stats;
    try {
      stats = computePairedStats(armAAbs, armBAbs, {
        idField: p.flags['id-field'] || 'id',
        itemField: p.flags['item-field'] || null,
        correctField: p.flags['correct-field'] || 'correct',
        promptField: p.flags['prompt-field'] || 'prompt',
        compliantField: p.flags['compliant-field'] || null,
        bootstrapIters: p.flags.bootstrap !== undefined ? Number(p.flags.bootstrap) : 1000,
        seed: p.flags.seed !== undefined ? Number(p.flags.seed) : 42,
        checkPromptMatch: Boolean(p.flags['check-prompt']),
      });
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        process.stderr.write('✗ 找不到输入文件: ' + e.message + '\n');
        return 2;
      }
      process.stderr.write('✗ ' + (e && e.message ? e.message : String(e)) + '\n');
      return 1;
    }
    if (p.flags.json) {
      process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
    } else {
      process.stdout.write(formatPairedStatsReport(stats));
    }
    return 0;
  }

  // ── 10) check-contract & repro-watch (S6 / S1) ──────────────────────────
  if (cmd === 'check-contract') {
    const p = parseCliFlags(rest, {
      booleans: ['record', 're-record', 'json'],
      strings: ['reason'],
    });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    if (!p.pos[0]) {
      process.stderr.write('用法: dispatch.mjs check-contract <契约文件.md> [--record] [--re-record --reason <原因>]\n');
      return 1;
    }
    const conAbs = resolveUserPath(root, p.pos[0]);
    const res = checkContractFile(conAbs, {
      rootDir: root,
      record: Boolean(p.flags.record),
      reRecord: Boolean(p.flags['re-record']),
      reason: p.flags.reason || '',
    });
    const rc = res.rc !== undefined ? res.rc : (res.ok ? 0 : 1);
    if (p.flags.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return rc;
    }
    if (res.stdout) process.stdout.write(String(res.stdout).replace(/\n?$/, '\n'));
    if (res.stderr) process.stderr.write(String(res.stderr).replace(/\n?$/, '\n'));
    if (res.ok && !res.stdout) {
      process.stdout.write('✓ 契约校验通过' + (res.sha12 ? (' (sha12:' + res.sha12 + ')') : '') + ': ' + p.pos[0] + '\n');
    }
    return rc;
  }

  if (cmd === 'repro-watch') {
    const p = parseCliFlags(rest, {
      booleans: ['json'],
      strings: ['log', 'max-stale'],
    });
    if (!p.ok) {
      process.stderr.write('✗ ' + p.error + '\n');
      return 1;
    }
    if (!p.pos[0]) {
      process.stderr.write('用法: dispatch.mjs repro-watch <基线目录> [--log <日志文件>] [--max-stale <秒>]\n');
      return 1;
    }
    const baseAbs = resolveUserPath(root, p.pos[0]);
    const logAbs = p.flags.log ? resolveUserPath(root, p.flags.log) : null;
    const res = watchRepro(root, baseAbs, {
      logPath: logAbs,
      maxStaleSec: p.flags['max-stale'] !== undefined ? Number(p.flags['max-stale']) : 900,
    });
    const rc = res.rc !== undefined ? res.rc : (res.ok ? 0 : 1);
    if (p.flags.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return rc;
    }
    if (res.stdout) process.stdout.write(String(res.stdout).replace(/\n?$/, '\n'));
    if (res.stderr) process.stderr.write(String(res.stderr).replace(/\n?$/, '\n'));
    return rc;
  }

  // ── 11) 兼容底层座位与模型诊断命令 ───────────────────────────────────────
  if (cmd === 'seats') {
    const cfg = loadConfig(root);
    const planRes = resolveExecutionPlan(cfg);
    const rows = cfg.seats.map((s) => ({
      id: s.id,
      kind: s.kind,
      executor: seatKindOf(s),
      enabled: s.enabled !== false,
      identity: seatIdentity(s, {
        seat: s.id,
        payloadSha: process.env.FANOUT_PAYLOAD_SHA || '',
        voteModel: planRes.voteModels.get(s.id) || '',
      }),
    }));
    process.stdout.write(JSON.stringify({
      config: cfg.__file,
      default_backends: cfg.default_backends,
      effective_default_backends: planRes.ok ? planRes.backendList : [],
      effective_slots: planRes.ok ? planRes.slots : [],
      require_unique_models: Boolean(cfg.policy && cfg.policy.require_unique_models === true),
      ...(planRes.ok ? {} : { plan_error: planRes.error }),
      settings_source: dshOverrides().source,
      seats: rows,
    }, null, 2) + '\n');
    return 0;
  }

  if (cmd === 'stages' || cmd === 'stage-exec' || cmd === 'stage-model') {
    let cfg = null;
    try { cfg = loadConfig(root); } catch { cfg = null; }
    const ov = dshOverrides({ forceProfileRead: true }).config || {};

    const parseOvVotes = (rawVotes) => String(rawVotes || '')
      .split(/[;,]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => {
        const idx = t.indexOf(':');
        return idx >= 0
          ? { executor: t.slice(0, idx).trim(), model: t.slice(idx + 1).trim() }
          : { executor: t, model: '' };
      })
      .filter((x) => x.executor);

    const resolveDiagnosticStage = (st) => {
      if (cfg) {
        if (st === 'review') {
          const rp = resolveExecutionPlan(cfg);
          if (!rp.ok) return { stage: 'review', executor: '', model: '', slots: [], source: rp.source || 'error' };
          return {
            stage: 'review',
            executor: rp.slots.map((s) => s.seat).join(','),
            model: rp.slots.map((s) => s.model || '').filter(Boolean).join(','),
            effort: rp.slots.map((s) => s.effort || '').filter(Boolean).join(','),
            slots: rp.slots,
            source: rp.source,
          };
        }
        if (st === 'diverge') {
          const dp = resolveDivergePlan(cfg);
          return {
            stage: 'diverge',
            executor: dp.ok ? dp.seatId : '',
            model: dp.ok ? (dp.model || '') : '',
            effort: dp.ok ? (dp.effort || '') : '',
            count: dp.defaultCount ?? 10,
            use_dead_ends: dp.defaultUseDeadEnds !== false,
            source: dp.source || 'default',
          };
        }
        if (st === 'scout' || st === 'novelty') {
          const sp = resolveStage(cfg, st);
          return {
            stage: st,
            executor: sp.ok ? sp.seatId : '',
            model: sp.ok ? (sp.model || '') : '',
            effort: sp.ok ? (sp.effort || '') : '',
            source: sp.source || 'default',
          };
        }
      }

      const legacyOp = (stageKey) => {
        for (const seg of String(ov.stageOpinions || '').split(';')) {
          const [k, ex, ...tail] = seg.trim().split(':');
          if ((k || '').trim() === stageKey && (ex || '').trim()) {
            return { executor: ex.trim(), model: tail.join(':').trim() };
          }
        }
        return { executor: '', model: '' };
      };
      if (st === 'scout') {
        const fb = legacyOp('scout');
        return { stage: 'scout', executor: String(ov.scoutCommand || '').trim() || fb.executor, model: String(ov.scoutModel || '').trim() || fb.model };
      }
      if (st === 'diverge') {
        const fb = legacyOp('diverge');
        return { stage: 'diverge', executor: String(ov.divergeCommand || '').trim() || fb.executor, model: String(ov.divergeModel || '').trim() || fb.model };
      }
      if (st === 'review') {
        const vs = parseOvVotes(ov.reviewVotes);
        return {
          stage: 'review',
          executor: vs.map((v) => v.executor).join(','),
          model: vs.map((v) => v.model).filter(Boolean).join(','),
        };
      }
      if (st === 'novelty') {
        const fb = legacyOp('novelty');
        return { stage: 'novelty', executor: String(ov.noveltyCommand || '').trim() || fb.executor, model: String(ov.noveltyModel || '').trim() || fb.model };
      }
      const fbOther = legacyOp(st);
      return { stage: st, executor: fbOther.executor, model: fbOther.model };
    };

    if (cmd === 'stages') {
      if (cfg || ov.scoutCommand || ov.divergeCommand || ov.reviewVotes || ov.noveltyCommand) {
        const rows = ['scout', 'diverge', 'review', 'novelty'].map((s) => resolveDiagnosticStage(s));
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
        return 0;
      }
      const raw = String(ov.stageOpinions || '');
      const rows = raw.split(';').map((t) => t.trim()).filter(Boolean).map((t) => {
        const [stage, executor, ...tail] = t.split(':');
        return {
          stage: (stage || '').trim(),
          executor: (executor || '').trim(),
          model: tail.join(':').trim(),
        };
      });
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return 0;
    }

    const stage = String(rest[0] || '').trim();
    const info = resolveDiagnosticStage(stage);
    if (cmd === 'stage-exec') {
      process.stdout.write((info.executor || '') + '\n');
      return 0;
    }
    process.stdout.write((info.model || '') + '\n');
    return 0;
  }

  if (cmd === 'review-models') {
    const cfg = loadConfig(root);
    process.stdout.write(reviewModels(cfg).join('\n') + '\n');
    return 0;
  }

  if (cmd === 'resolve-model') {
    const [explicit, file, pattern, cut] = rest;
    const cutNum = cut === undefined || cut === '' ? 2 : Number(cut);
    process.stdout.write(resolveModel(explicit || '', expandHome(file || ''), pattern || '', cutNum) + '\n');
    return 0;
  }

  if (cmd === 'dsh-live') { process.stdout.write(dshLiveModel() + '\n'); return 0; }
  if (cmd === 'norm-model') { process.stdout.write(normModel(rest[0] || '') + '\n'); return 0; }
  if (cmd === 'model-family') { process.stdout.write(modelFamily(rest[0] || '') + '\n'); return 0; }
  if (cmd === 'dsh-tag') { process.stdout.write(dshTag() + '\n'); return 0; }
  if (cmd === 'qoder-tag') { process.stdout.write(qoderTag() + '\n'); return 0; }
  if (cmd === 'qoder-self') { process.stdout.write(qoderSelfModel() + '\n'); return 0; }

  if (cmd === 'seat-token') {
    const seatName = rest[0] || '';
    let seatDef = null;
    try {
      const cfg = loadConfig(root);
      seatDef = findSeat(cfg, seatName);
    } catch { /* 无座位表时退回默认约定 */ }
    process.stdout.write(seatAttestToken(seatName, process.env.FANOUT_PAYLOAD_SHA || '', seatDef) + '\n');
    return 0;
  }

  if (cmd === 'argv') {
    const cfg = loadConfig(root);
    const seat = findSeat(cfg, rest[0] || '');
    if (!seat) { process.stderr.write('没有这个座位\n'); return 2; }
    process.stdout.write(buildArgv(seat, {
      workersDir: 'workers',
      tmp: '/tmp/x',
      payloadText: 'PAYLOAD',
      patch: 'dispatch/dsh-review.patch.yml',
    }).join('\n') + '\n');
    return 0;
  }

  process.stderr.write('✗ 未知子命令: ' + JSON.stringify(cmd) + ' —— 是命令名写错，不是环境问题\n');
  process.stderr.write(USAGE + '\n');
  return 2;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
  }
}

if (isDirectExecution()) {
  let code = 2;
  try {
    code = await main(process.argv.slice(2));
  } catch (e) {
    if (e && (e.code === 'NO_CONFIG' || e.code === 'BAD_CONFIG')) {
      process.stderr.write('✗ ' + e.message + '\n');
    } else {
      process.stderr.write('✗ 未预期异常（按基础设施不可用退 2）：' + (e && e.stack ? e.stack : String(e)) + '\n');
    }
  }
  process.exitCode = code;
}
