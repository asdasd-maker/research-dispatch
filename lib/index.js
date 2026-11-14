// DSH 兼容插件层（v2.1.0）：暴露宿主设置命名空间 Config、统一探测本机五类 CLI 执行者与模型、
// 写穿同步面板阵容至 dispatch/seats.json（lineup），并注册 research_dispatch 向导工具。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as registry from './registry.mjs';
import { probeAgentModelsFromConfigs, homeDir } from './models.mjs';
import { registerFlowTools, bashInfo } from './flow-tools.mjs';

export const STAGE_EXEC_IDS = ['codex', 'claude', 'dsh', 'gemini', 'kimi'];

export function plainValue(v) {
  if (v && typeof v === 'object' && typeof v.get === 'function') {
    try { return v.get(); } catch { return v; }
  }
  return v;
}

function schemaShim() {
  const field = () => {
    let hasDefault = false;
    let defaultVal;
    const patterns = [];
    const meta = {};
    const self = {
      meta,
      description: (d) => { meta.description = d; return self; },
      default: (v) => { hasDefault = true; defaultVal = v; meta.default = v; return self; },
      extra: (k, v) => { meta[k] = v; return self; },
      required: () => { meta.required = true; return self; },
      hidden: () => { meta.hidden = true; return self; },
      note: (n) => { meta.note = n; return self; },
      pattern: (re, message) => {
        const compiled = re instanceof RegExp ? re : new RegExp(String(re));
        patterns.push({ re: compiled, message: message || ('格式不匹配 ' + compiled) });
        return self;
      },
      _eval: (raw, key) => {
        const val = raw === undefined ? (hasDefault ? defaultVal : undefined) : raw;
        if (val !== undefined && val !== null) {
          const str = String(plainValue(val));
          for (const p of patterns) {
            if (!p.re.test(str)) {
              throw new TypeError((key ? key + '：' : '') + p.message);
            }
          }
        }
        return val;
      },
    };
    return self;
  };
  const object = (shape) => {
    let defaultObj = {};
    const schema = (value) => {
      if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
        throw new TypeError('Config 期望接收对象');
      }
      const src = value || defaultObj || {};
      const out = { ...src };
      for (const [k, sub] of Object.entries(shape || {})) {
        if (sub && typeof sub._eval === 'function') {
          const evaluated = sub._eval(src[k], k);
          if (evaluated !== undefined || Object.prototype.hasOwnProperty.call(src, k)) {
            out[k] = evaluated;
          }
        }
      }
      return out;
    };
    schema.dict = shape;
    schema.description = () => schema;
    schema.extra = () => schema;
    schema.default = (d) => { defaultObj = d || {}; return schema; };
    return schema;
  };
  return { object, string: field, number: field, boolean: field, union: field, const: field };
}

function dshRoot() {
  return String(process.env.DSH_HOME || '').trim() || path.join(homeDir(), '.dsh');
}

async function loadSchema() {
  try {
    return (await import('@deepseek-ai/schemastery')).default;
  } catch { /* 继续查找 profile 目录 */ }
  const root = dshRoot();
  const profilesDir = path.join(root, 'profiles');
  const activeProfile = String(process.env.DSH_PROFILE || '').trim() || 'desktop';
  const cands = [
    path.join(profilesDir, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
    path.join(profilesDir, activeProfile, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
    path.join(profilesDir, 'desktop', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
  ];
  try {
    for (const d of fs.readdirSync(profilesDir)) {
      cands.push(path.join(profilesDir, d, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'));
    }
  } catch { /* profiles 目录不存在时跳过 */ }
  for (const c of [...new Set(cands)]) {
    try {
      if (fs.existsSync(c)) return (await import(pathToFileURL(c).href)).default;
    } catch { /* 单个候选不可读时继续 */ }
  }
  return schemaShim();
}

const z = await loadSchema();

export const name = 'research-dispatch';
export const inject = [];

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(here, '..');

export function resolveDefaultRepoRoot() {
  const envRoot = String(process.env.DSH_DISPATCH_ROOT || '').trim();
  if (envRoot) return path.resolve(envRoot);
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'dispatch', 'seats.json'))) return cwd;
  const parentTwo = path.resolve(PACKAGE_ROOT, '..', '..');
  if (fs.existsSync(path.join(parentTwo, 'dispatch', 'seats.json'))) return parentTwo;
  const inNodeModules = path.basename(path.dirname(PACKAGE_ROOT)) === 'node_modules';
  const normParent = parentTwo.replace(/\\/g, '/');
  if (inNodeModules && !/\/\.dsh\/profiles(\/|$)/i.test(normParent)) {
    return parentTwo;
  }
  return cwd;
}
export const DEFAULT_REPO_ROOT = resolveDefaultRepoRoot();

function cleanDetectedModel(tag) {
  const s = String(tag || '').replace(/-from-.*$|-explicit$|-manual-attested$/, '').trim();
  return s && s !== 'unknown-check-config' ? s : '';
}

// 统一复用 discoverAgents() / probeAgentModelsFromConfigs() 探测本机五类真实 CLI 执行者与候选模型。
// 覆盖 codex / claude / dsh / gemini / kimi（不含 api 与无对应座位的 subagent）。
function buildExecutorSnapshot() {
  let byId = null;
  try {
    const disc = registry.discoverAgents(null, { useDshPatch: false });
    if (disc && Array.isArray(disc.agents)) {
      byId = new Map(disc.agents.map((a) => [a.id, a]));
    }
  } catch { byId = null; }

  let probed = null;
  if (!byId) {
    try { probed = probeAgentModelsFromConfigs() || {}; } catch { probed = {}; }
  }

  const catalog = STAGE_EXEC_IDS.map((id) => {
    const list = [];
    const add = (m) => {
      const s = cleanDetectedModel(m);
      if (s && !list.includes(s)) list.push(s);
    };
    const ag = byId && byId.get(id);
    if (ag) {
      add(ag.default_model);
      for (const m of ag.models || []) add(m);
    } else if (probed && probed[id]) {
      add(probed[id].defaultModel);
      for (const m of probed[id].models || []) add(m);
    }
    return id + ':' + list.join('|');
  }).join(';');

  const status = STAGE_EXEC_IDS.map((id) => {
    const ag = byId && byId.get(id);
    return id + ':' + (ag && ag.installed ? '1' : '0');
  }).join(';');

  return { catalog, status };
}

export function executorCatalog() {
  return buildExecutorSnapshot().catalog;
}

// 编码本机五类 CLI 执行者的 PATH 安装状态（1=已安装，0=未检测到命令）。
export function executorStatus() {
  return buildExecutorSnapshot().status;
}

const INITIAL_EXEC_SNAPSHOT = buildExecutorSnapshot();

export const Config = z.object({
  repoRoot: z.string()
    .description('科研项目文件夹路径（保存后阵容会自动同步至该项目的配置中）。留空默认自动探测')
    .default(DEFAULT_REPO_ROOT)
    .extra('volatile', true),
  seatsFile: z.string()
    .description('座位表相对路径（相对于项目根）；默认 dispatch/seats.json')
    .default('dispatch/seats.json')
    .pattern(
      /^(?!.*(?:^|[\\/])\.\.(?:$|[\\/]))(?![/\\]|[A-Za-z]:)(?!.*[\\/]$).+\.json$/,
      '必须是仓库内的相对路径、不含 ..、以 .json 结尾',
    )
    .extra('volatile', true),
  scoutCommand: z.string()
    .description('文献调研环节（S0）执行工具（codex / claude / dsh / gemini / kimi）。留空按项目默认阵容运行')
    .default('')
    .extra('volatile', true),
  scoutModel: z.string()
    .description('文献调研环节模型名。留空使用所选工具自身默认模型')
    .default('')
    .extra('volatile', true),
  divergeCommand: z.string()
    .description('想法发散环节（S2）执行工具（codex / claude / dsh / gemini / kimi）。留空按项目默认阵容运行')
    .default('')
    .extra('volatile', true),
  divergeModel: z.string()
    .description('想法发散环节模型名。留空使用所选工具自身默认模型')
    .default('')
    .extra('volatile', true),
  divergeCount: z.string()
    .description('想法发散单轮默认产出条数（1–50，默认 10；留空跟随项目配置）')
    .default('')
    .extra('volatile', true),
  divergeUseDeadEnds: z.string()
    .description('想法发散历史死胡同过滤（true 常规挂载已证伪方向 / false 纯空白零历史锚定；留空跟随项目配置）')
    .default('')
    .extra('volatile', true),
  reviewVotes: z.string()
    .description('评审票（逗号分隔）：工具:模型。支持同工具多票与自由模型组合；留空按项目默认阵容运行')
    .default('')
    .extra('volatile', true),
  noveltyCommand: z.string()
    .description('前置查重环节（S4.5）执行工具（codex / claude / dsh / gemini / kimi）。留空按项目默认阵容运行')
    .default('')
    .extra('volatile', true),
  noveltyModel: z.string()
    .description('前置查重环节模型名。留空使用所选工具自身默认模型')
    .default('')
    .extra('volatile', true),
  executorCatalog: z.string()
    .description('只读：宿主探测的五类工具与候选模型目录（格式 exec:model1|model2;…）')
    .default(INITIAL_EXEC_SNAPSHOT.catalog)
    .extra('volatile', true),
  executorStatus: z.string()
    .description('只读：宿主探测的五类工具命令安装状态（格式 codex:1;claude:1;dsh:1;gemini:1;kimi:1）')
    .default(INITIAL_EXEC_SNAPSHOT.status)
    .extra('volatile', true),
  otherStages: z.string()
    .description('历史兼容字段（面板不展示）')
    .default('')
    .extra('volatile', true),
  stageOpinions: z.string()
    .description('历史兼容字段（面板不展示）')
    .default('')
    .extra('volatile', true),
});

function diag(msg) {
  const raw = String(process.env.RESEARCH_DISPATCH_DIAG || '').trim();
  if (!raw || raw === '0' || raw.toLowerCase() === 'false') return;
  const target = (raw === '1' || raw.toLowerCase() === 'true')
    ? path.join(dshRoot(), 'research-dispatch-diag.log')
    : raw;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, '[' + new Date().toISOString() + '] ' + msg + '\n');
  } catch { /* 诊断写盘失败不影响主流程 */ }
}

function makeLoggers(ctx) {
  const TAG = '[research-dispatch] ';
  let sink = null;
  try {
    if (ctx && typeof ctx.logger === 'function') sink = ctx.logger('research-dispatch');
  } catch { /* 取具名 Logger 失败则退下一档 */ }
  if (!sink || typeof sink.info !== 'function') {
    sink = ctx && ctx.logger && typeof ctx.logger.info === 'function' ? ctx.logger : null;
  }
  const emit = (level, msg) => {
    const line = TAG + msg;
    const fn = sink && typeof sink[level] === 'function' ? sink[level] : null;
    if (fn) {
      try { fn.call(sink, line); return; } catch { /* 落回 console */ }
    }
    if (level === 'error') console.error(line); else console.log(line);
  };
  return { info: (m) => emit('info', m), error: (m) => emit('error', m) };
}

const PANEL_SYNC_KEYS = [
  'scoutCommand',
  'scoutModel',
  'divergeCommand',
  'divergeModel',
  'divergeCount',
  'divergeUseDeadEnds',
  'reviewVotes',
  'noveltyCommand',
  'noveltyModel',
];

export function apply(ctx, config = {}) {
  const cfgObj = config && typeof config === 'object' ? config : {};
  const _lg = makeLoggers(ctx);
  const log = (m) => _lg.info(m);
  const say = (m) => _lg.error(m);

  const repoRootOf = (src = cfgObj) => {
    const envRoot = String(process.env.DSH_DISPATCH_ROOT || '').trim();
    if (envRoot) return path.resolve(envRoot);
    const configured = String(plainValue(src.repoRoot) || '').trim();
    if (configured) return path.resolve(configured);
    return resolveDefaultRepoRoot();
  };
  const seatsFileOf = (src = cfgObj) => {
    const sf = String(plainValue(src.seatsFile) || '').trim();
    return sf || 'dispatch/seats.json';
  };
  const repoRootNow = () => repoRootOf(cfgObj);
  const seatsFileNow = () => seatsFileOf(cfgObj);

  const syncPanelNow = (maybeNext) => {
    const syncFn = registry.syncPanelLineupToSeats;
    if (typeof syncFn !== 'function') return null;
    const hasOverrideObj = Boolean(
      maybeNext
      && typeof maybeNext === 'object'
      && !Array.isArray(maybeNext)
      && (PANEL_SYNC_KEYS.some((k) => k in maybeNext) || 'repoRoot' in maybeNext || 'seatsFile' in maybeNext)
    );
    const src = hasOverrideObj ? { ...cfgObj, ...maybeNext } : cfgObj;
    const panelSnapshot = {};
    for (const k of PANEL_SYNC_KEYS) {
      const raw = plainValue(src[k]);
      if (raw !== undefined && raw !== null) {
        panelSnapshot[k] = String(raw);
      }
    }
    try {
      const res = syncFn(repoRootOf(src), seatsFileOf(src), panelSnapshot);
      if (res && res.synced) {
        log('面板阵容已写穿同步至 ' + res.file);
        diag('synced-lineup ' + res.file);
      }
      return res;
    } catch (e) {
      const errText = String((e && e.message) || e);
      say('面板阵容写穿同步失败：' + errText);
      diag('sync-lineup-error ' + errText);
      return null;
    }
  };

  syncPanelNow();

  let offVolatile = null;
  if (ctx && typeof ctx.on === 'function') {
    try {
      const sub = ctx.on('loader/volatile-update', syncPanelNow);
      if (typeof sub === 'function') offVolatile = sub;
    } catch (e) {
      diag('volatile-hook-error ' + ((e && e.message) || e));
    }
  }

  try {
    const cfg = registry.loadConfig(repoRootNow(), seatsFileNow(), { useDshPatch: true });
    log('座位表 ' + cfg.__file + ' 已加载（面板保存将自动同步 lineup）：'
      + cfg.seats.map((s) => s.id).join(' '));
    diag('loaded ' + cfg.__file);
  } catch (e) {
    const errText = String((e && e.message) || e);
    say('座位表加载失败（research_dispatch 仍会注册，待初始化或修复配置后自动恢复）：' + errText);
    diag('config-error ' + errText);
  }

  let activeOff = null;
  const disposeActive = () => {
    const fn = activeOff;
    activeOff = null;
    if (typeof fn === 'function') {
      try { fn(); } catch { /* 已卸载 */ }
    }
  };

  const disposeAll = () => {
    disposeActive();
    const fnV = offVolatile;
    offVolatile = null;
    if (typeof fnV === 'function') {
      try { fnV(); } catch { /* 已解绑 */ }
    }
  };

  const flowRegister = (tools, via) => {
    if (!tools || typeof tools.register !== 'function') return null;
    try {
      disposeActive();
      const off = registerFlowTools(
        { tools },
        {
          useDshPatch: true,
          getRepoRoot: () => repoRootNow(),
          get repoRoot() { return repoRootNow(); },
          getSeatsFile: () => seatsFileNow(),
          get seatsFile() { return seatsFileNow(); },
        },
      );
      activeOff = typeof off === 'function' ? off : null;
      let seen = null;
      try {
        if (typeof tools.schemas === 'function') {
          const arr = tools.schemas();
          if (Array.isArray(arr)) seen = arr.some((d) => d && d.name === 'research_dispatch');
        }
      } catch { /* 读回失败不阻断注册 */ }
      if (seen === false) {
        say('research_dispatch 注册后未出现在工具表读回里——注册可能未生效');
        diag('flow-tool-readback-miss via=' + via);
      }
      log('research_dispatch 向导工具已注册（via ' + via + '；useDshPatch=true）');
      diag('flow-tool-registered via=' + via);
      try {
        const bi = bashInfo();
        if (!bi.ok) log('Git Bash 未就绪（v2.1.0 全链路纯 Node 内核照常可用；仅自定义外部 .sh 脚本需 Git Bash，reason=' + bi.reason + '）');
        for (const w of bi.warnings || []) { log('Git Bash 解析留痕：' + w); diag('bash-warn ' + w); }
      } catch { /* 留痕失败不影响注册 */ }
      return activeOff || (() => {});
    } catch (e2) {
      say('research_dispatch 工具注册失败：' + ((e2 && e2.message) || e2));
      diag('flow-tool-register-error ' + ((e2 && e2.message) || e2));
      return null;
    }
  };

  let directToolsRef = null;
  try {
    const tools = ctx && typeof ctx.get === 'function' ? ctx.get('tools') : null;
    if (tools && typeof tools.register === 'function') {
      if (flowRegister(tools, 'direct')) directToolsRef = tools;
    }
  } catch (e3) {
    diag('flow-tool-get-error ' + ((e3 && e3.message) || e3));
  }

  if (ctx && typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (scope) => {
      const injectedTools = scope && scope.tools;
      if (!injectedTools || typeof injectedTools.register !== 'function') return;
      if (directToolsRef && directToolsRef === injectedTools && activeOff) {
        const onDirectScopeDispose = () => {
          directToolsRef = null;
          disposeActive();
        };
        if (scope && typeof scope.on === 'function') scope.on('dispose', onDirectScopeDispose);
        else if (scope && typeof scope.effect === 'function') scope.effect(() => onDirectScopeDispose);
        return;
      }
      directToolsRef = null;
      const off = flowRegister(injectedTools, 'inject');
      if (!off) return;
      const onInjectScopeDispose = () => {
        if (activeOff === off) activeOff = null;
        try { if (typeof off === 'function') off(); } catch { /* 已卸载 */ }
      };
      if (scope && typeof scope.on === 'function') scope.on('dispose', onInjectScopeDispose);
      else if (scope && typeof scope.effect === 'function') scope.effect(() => onInjectScopeDispose);
    });
  } else if (!directToolsRef) {
    say('宿主无 tools 通道：research_dispatch 向导工具不可用（技能会显式提示）');
    diag('flow-tool-no-tools-channel');
  }

  if (ctx && typeof ctx.on === 'function') {
    ctx.on('dispose', disposeAll);
  } else if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => disposeAll);
  }
}

export default { name, inject, Config, apply };
