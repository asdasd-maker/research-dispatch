#!/usr/bin/env node
// 分派层的唯一入口。规划（谁去评、用哪个模型）与落地（调用、落卡、汇总）都在这里，
// 一次调用做完 —— 调用方（dispatch/fanout.sh 这层壳、或 DSH 里的插件调用）不再各持一半状态。
//
// 用法：
//   node lib/../bin/dispatch.mjs run <工单路径>          # 等价于旧的 bash dispatch/fanout.sh
//   node bin/dispatch.mjs plan <工单路径>               # 只打印本轮计划（JSON），不调用任何模型
//   node bin/dispatch.mjs seats                         # 打印生效的座位表
//   node bin/dispatch.mjs review-models                 # 三行模型身份（供 dispatch/models.sh）
//   node bin/dispatch.mjs norm-model <串>               # 归一化（同 dispatch/models.sh）
//   node bin/dispatch.mjs model-family <串>             # 家族名
//   node bin/dispatch.mjs dsh-tag | qoder-tag | qoder-self
//   node bin/dispatch.mjs seat-token <座位名>
//
// 仓库根由本文件位置推出（bin → 插件包 → plugin/ → 仓库根），可用 DSH_DISPATCH_ROOT 覆盖。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { run } from '../lib/run.mjs';
import { loadConfig, findSeat, seatIdentity, buildArgv, reviewModels, effectiveDefaultBackends, dshOverrides, seatKindOf } from '../lib/registry.mjs';
import { normModel, modelFamily, dshTag, qoderTag, qoderSelfModel, seatAttestToken, resolveModel, dshLiveModel, expandHome } from '../lib/models.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(here, '..', '..', '..');

function rootDir() {
  if (process.env.DSH_DISPATCH_ROOT) return path.resolve(process.env.DSH_DISPATCH_ROOT);
  // 三层顺序，避免"装在全局/npx 跑时把仓库根认成 npm 全局目录"这类误判（旧版只有第 2 层）：
  //   1) 当前工作目录已有 dispatch/seats.json —— 用户就在自己的项目里跑，这是最常见也最该赢的
  //   2) 本文件位置推导：monorepo 里 plugin/<pkg>/bin → 仓库根；npm 里 node_modules/<pkg>/bin → 项目根
  //   3) 都没有配置时回退当前目录，让报错信息指向用户真正应该创建配置的地方
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'dispatch', 'seats.json'))) return cwd;
  if (fs.existsSync(path.join(DEFAULT_ROOT, 'dispatch', 'seats.json'))) return DEFAULT_ROOT;
  return cwd;
}

async function main(argv) {
  const cmd = argv[0] || '';
  const rest = argv.slice(1);
  const root = rootDir();

  if (cmd === 'run') {
    if (rest.length === 0) {
      process.stderr.write('用法: dispatch.mjs run <工单>\n');
      return 1;
    }
    if (rest.length > 1) {
      process.stdout.write('!! 只接受一个工单，多出来的是：' + rest.slice(1).join(' ') + '\n');
      process.stdout.write('   一条命令扇一单：for f in a.md b.md; do bash dispatch/fanout.sh "$f"; done\n');
      process.stdout.write('   （静默取第一个 = 第二单的票根本没生成，而退出码照样是 0）\n');
      return 1;
    }
    try {
      return await run({ root, briefArg: rest[0] });
    } catch (e) {
      // 配置坏掉是"基础设施不可用"（退 2），不是"材料不合格"（退 8），也不是普通失败（退 1）：
      // 三种排查方向完全不同，混成一个码会把人支去查工单。
      if (e && (e.code === 'NO_CONFIG' || e.code === 'BAD_CONFIG')) {
        process.stderr.write('✗ ' + e.message + '\n');
        return 2;
      }
      throw e;
    }
  }

  if (cmd === 'plan') {
    const cfg = loadConfig(root);
    const brief = rest[0];
    if (!brief) { process.stderr.write('用法: dispatch.mjs plan <工单>\n'); return 1; }
    const briefAbs = path.isAbsolute(brief) ? brief : path.join(root, brief);
    const backends = (process.env.BACKENDS || (cfg.default_backends || []).join(' ')).split(/\s+/).filter(Boolean);
    const plan = [];
    for (const be of backends) {
      const seat = findSeat(cfg, be);
      if (!seat) { plan.push({ seat: be, error: 'unknown-seat' }); continue; }
      const identity = seatIdentity(seat, { seat: be, payloadSha: process.env.FANOUT_PAYLOAD_SHA || '' });
      const entry = {
        seat: be, kind: seat.kind, enabled: seat.enabled !== false,
        executor: seat.kind === 'cli' ? (seat.command || '') : seat.kind,
        identity, proven: normModel(identity) !== 'unknown-check-config',
      };
      if (seat.kind === 'cli') {
        entry.argv_template = seat.argv;
        entry.patch = seat.patch_env ? (process.env[seat.patch_env] || seat.patch_default || '') : '';
      }
      if (seat.kind === 'delivery') {
        entry.body_env = String(seat.body_env || '').replace('{SEAT_UPPER}', be.toUpperCase());
        entry.declared_env = String(seat.model_env || '').replace('{SEAT_UPPER}', be.toUpperCase());
      }
      plan.push(entry);
    }
    process.stdout.write(JSON.stringify({ root, brief: briefAbs, config: cfg.__file, plan }, null, 2) + '\n');
    return 0;
  }

  if (cmd === 'seats') {
    const cfg = loadConfig(root);
    const rows = cfg.seats.map((s) => ({
      // kind 是座位表里写的；executor 是**实际生效的**执行方式（面板 / executor_override
      // 可以把它改掉）。两个都打出来 —— 只打 kind 会让"面板改成了 subagent"在诊断里看不见，
      // 又是一次"界面与实跑各说一套"。
      id: s.id, kind: s.kind, executor: seatKindOf(s), enabled: s.enabled !== false,
      // payloadSha 走与 seat-token / plan 同一个格子：selfdeclared 座的署名票要拿它裁定
      // "绑没绑上本轮 payload"，这里传空串会让 seat-token 与 seats 对同一座给出两个答案。
      identity: seatIdentity(s, { seat: s.id, payloadSha: process.env.FANOUT_PAYLOAD_SHA || '' }),
    }));
    process.stdout.write(JSON.stringify({
      config: cfg.__file,
      // 文件里的默认值 vs 实际生效值：面板（DSH 设置）优先，这里两个都打出来，
      // 免得"我明明在界面改了"和"seats.json 还是老值"各说一套却谁都看不见。
      default_backends: cfg.default_backends,
      effective_default_backends: effectiveDefaultBackends(cfg),
      settings_source: dshOverrides().source,
      seats: rows,
    }, null, 2) + '\n');
    return 0;
  }

  if (cmd === 'stages') {
    // 供主会话在调度 subagent 前读取：这三环不由 bash 派工，但选择存在这里。
    const ov = dshOverrides().config || {};
    const raw = String(ov.stageOpinions || '');
    const rows = raw.split(';').map((t) => t.trim()).filter(Boolean).map((t) => {
      const [stage, executor, ...rest] = t.split(':');
      return { stage, executor: executor || '', model: rest.join(':') || '' };
    });
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }
  if (cmd === 'stage-exec') {
    const stage = rest[0] || '';
    const ov = dshOverrides().config || {};
    const map = { diverge: 'divergeCommand' };
    const field = map[stage];
    process.stdout.write((field ? String(ov[field] || '').trim() : '') + '\n');
    return 0;
  }
  if (cmd === 'stage-model') {
    // 供 bash 层读取某个环节的模型（目前只有 diverge 在 bash 里真调模型）
    const stage = rest[0] || '';
    const cfg = loadConfig(root);
    const ov = dshOverrides().config || {};
    const map = { diverge: 'divergeModel' };
    const field = map[stage];
    const v = field ? String(ov[field] || '').trim() : '';
    process.stdout.write((v || '') + '\n');
    return 0;
  }
  if (cmd === 'review-models') {
    const cfg = loadConfig(root);
    process.stdout.write(reviewModels(cfg).join('\n') + '\n');
    return 0;
  }
  if (cmd === 'resolve-model') {
    // $1=显式值 $2=配置文件 $3=正则 $4=cut 字段（与旧 bash 函数同签名，供 dispatch/models.sh 转发）
    const [explicit, file, pattern, cut] = rest;
    process.stdout.write(resolveModel(explicit || '', expandHome(file || ''), pattern || '', Number(cut || 2)) + '\n');
    return 0;
  }
  if (cmd === 'dsh-live') { process.stdout.write(dshLiveModel() + '\n'); return 0; }
  if (cmd === 'norm-model') { process.stdout.write(normModel(rest[0] || '') + '\n'); return 0; }
  if (cmd === 'model-family') { process.stdout.write(modelFamily(rest[0] || '') + '\n'); return 0; }
  if (cmd === 'dsh-tag') { process.stdout.write(dshTag() + '\n'); return 0; }
  if (cmd === 'qoder-tag') { process.stdout.write(qoderTag() + '\n'); return 0; }
  if (cmd === 'qoder-self') { process.stdout.write(qoderSelfModel() + '\n'); return 0; }
  if (cmd === 'seat-token') {
    process.stdout.write(seatAttestToken(rest[0] || '', process.env.FANOUT_PAYLOAD_SHA || '') + '\n');
    return 0;
  }
  if (cmd === 'argv') {
    const cfg = loadConfig(root);
    const seat = findSeat(cfg, rest[0] || '');
    if (!seat) { process.stderr.write('没有这个座位\n'); return 2; }
    process.stdout.write(buildArgv(seat, { workersDir: 'workers', tmp: '/tmp/x', payloadText: 'PAYLOAD', patch: 'dispatch/dsh-review.patch.yml' }).join('\n') + '\n');
    return 0;
  }

  process.stderr.write(['用法: dispatch.mjs <run|plan|seats|review-models|norm-model|model-family|dsh-tag|qoder-tag|qoder-self|seat-token|argv>', ''].join('\n'));
  return 2;
}

// 未预期异常一律映射到 2（基础设施不可用）。散到 1 的后果最坏：1 的契约含义是"降级轮、
// 票有效，只是不齐"，人会去读一份根本没写出来的 manifest，而真正的病因只留在栈里。
let code = 2;
try {
  code = await main(process.argv.slice(2));
} catch (e) {
  process.stderr.write('✗ 未预期异常（按基础设施不可用退 2）：' + (e && e.stack ? e.stack : String(e)) + '\n');
}
process.exitCode = code;