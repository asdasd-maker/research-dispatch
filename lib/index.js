// DSH 兼容插件层（v2.0.0）：暴露宿主内设置命名空间 Config、预检座位表、注册 research_dispatch 向导工具。
//
// 作用域边界（对齐跨宿主单一真源原则）：
//   1. 项目根目录 dispatch/seats.json 是所有宿主（Antigravity / Claude Code / Codex / Cursor / 终端 / DSH）
//      共享的单一真源；
//   2. DSH 设置面板保存在 cordis.patch.yml 的配置仅在 DSH 宿主内部叠加生效（向 registerFlowTools 显式传入
//      useDshPatch: true），绝不跨宿主暗中篡改外部 CLI 运行结果。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from './registry.mjs';
import { resolveModel, expandHome, dshLiveModel, homeDir } from './models.mjs';
import { registerFlowTools, bashInfo } from './flow-tools.mjs';

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

function collectModelIds(node, out, depth, provPrefix) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === 'object') {
        const id = item.id || item.model || item.modelId || item.route;
        if (typeof id === 'string' && id.trim()) {
          if (id.includes('/')) out.push(id.trim());
          else if (provPrefix) out.push(provPrefix + '/' + id.trim());
        }
      }
      collectModelIds(item, out, depth + 1, provPrefix);
    }
    return;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) collectModelIds(v, out, depth + 1, provPrefix);
  }
}

function dshCatalogModels() {
  const out = [];
  const dir = path.join(dshRoot(), 'storages');
  const offPrefix = new Set();
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        if (!/(models|catalog)/i.test(f)) continue;
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!j) continue;
        const prefix = (f.match(/^[a-z0-9]+(?:-[a-z0-9]+)*?(?=-(?:models|catalog|prod-catalog|intl-catalog|[a-z]*-catalog)\.json$)/i) || [f.replace(/\.json$/, '')])[0];
        if (j.enabled === false || j.disabled === true) offPrefix.add(prefix);
      } catch { /* 单文件损坏不影响其余 */ }
    }
  } catch { /* 无 storages 目录 */ }
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || !/(models|catalog)/i.test(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!j || j.enabled === false || j.disabled === true) continue;
        const prefix = (f.match(/^[a-z0-9]+(?:-[a-z0-9]+)*?(?=-(?:models|catalog|prod-catalog|intl-catalog|[a-z]*-catalog)\.json$)/i) || [f.replace(/\.json$/, '')])[0];
        if (offPrefix.has(prefix)) continue;
        const before = out.length;
        const stem = f.replace(/\.json$/, '')
          .replace(/-(models|catalog|prod-catalog|intl-catalog|cn-catalog|global-catalog|[a-z]*-catalog)$/, '')
          .replace(/-(intl|prod|cn|global)$/, '');
        collectModelIds(j, out, 0, stem);
        if (Array.isArray(j.enabledModelIds) && j.enabledModelIds.length > 0) {
          const allow = new Set(j.enabledModelIds.map(String));
          for (let i = out.length - 1; i >= before; i--) if (!allow.has(out[i])) out.splice(i, 1);
        }
        if (Array.isArray(j.hiddenModels) && j.hiddenModels.length > 0) {
          const deny = new Set(j.hiddenModels.map(String));
          for (let i = out.length - 1; i >= before; i--) if (deny.has(out[i])) out.splice(i, 1);
        }
      } catch { /* 单文件损坏不影响其余 */ }
    }
  } catch { /* 无 storages 目录 */ }
  return [...new Set(out)];
}

function cleanDetectedModel(tag) {
  const s = String(tag || '').replace(/-from-config$|-explicit$/, '').trim();
  return s && s !== 'unknown-check-config' ? s : '';
}

function detectCodexModels() {
  const out = [];
  const add = (m) => {
    const s = cleanDetectedModel(m);
    if (s && !out.includes(s)) out.push(s);
  };
  try {
    const cfgPath = expandHome(process.env.CODEX_CFG || '~/.codex/config.toml');
    const primary = resolveModel(process.env.CODEX_MODEL || '', cfgPath, '^model = "[^"]*"', 2);
    add(primary);
    if (fs.existsSync(cfgPath)) {
      const txt = fs.readFileSync(cfgPath, 'utf8');
      for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^\s*model\s*=\s*"([^"]+)"/);
        if (m) add(m[1]);
      }
    }
  } catch { /* 无 codex 配置时跳过 */ }
  return out;
}

function detectGeminiModels() {
  const out = [];
  const add = (m) => {
    const s = cleanDetectedModel(m);
    if (s && !out.includes(s)) out.push(s);
  };
  add(process.env.GEMINI_MODEL || '');
  try {
    const cfgPath = expandHome(process.env.GEMINI_CFG || '~/.gemini/settings.json');
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.model === 'string') add(parsed.model);
          else if (parsed.model && typeof parsed.model === 'object') {
            add(parsed.model.name || parsed.model.id || '');
          }
          if (Array.isArray(parsed.models)) {
            for (const item of parsed.models) {
              if (typeof item === 'string') add(item);
              else if (item && typeof item === 'object') add(item.id || item.name || item.model || '');
            }
          }
        }
      } catch {
        add(resolveModel('', cfgPath, '"model"\\s*:\\s*"[^"]*"', 4));
      }
    }
  } catch { /* 无 gemini 配置时跳过 */ }
  return out;
}

// 编码本机探测到的执行者与候选模型（供浏览器设置面板读取）。
// 覆盖 codex / claude / dsh / gemini / api / kimi 六类真实执行者，不含无对应座位的 subagent。
export function executorCatalog() {
  const out = [];
  const push = (id, models) => out.push(id + ':' + models.filter(Boolean).join('|'));
  push('codex', detectCodexModels());
  try {
    const claude = resolveModel(
      process.env.CLAUDE_MODEL || '',
      expandHome(process.env.CLAUDE_CFG || '~/.claude/settings.json'),
      '"(ANTHROPIC_MODEL|model)"\\s*:\\s*"[^"]*"',
      4,
    );
    push('claude', [cleanDetectedModel(claude)]);
  } catch { push('claude', []); }
  let liveDsh = '';
  try { liveDsh = cleanDetectedModel(dshLiveModel()); } catch { liveDsh = ''; }
  const allDsh = dshCatalogModels().filter((x) => x && x !== liveDsh);
  const dshList = liveDsh ? [liveDsh, ...allDsh] : allDsh;
  push('dsh', dshList);
  push('gemini', detectGeminiModels());
  push('api', [String(process.env.API_MODEL || '').trim()].filter(Boolean));
  push('kimi', [String(process.env.KIMI_MODEL || '').trim() || 'sensenova/kimi-k3']);
  return out.join(';');
}

export const Config = z.object({
  repoRoot: z.string()
    .description('工作流项目根目录（含 dispatch/ 与 ideas/）。默认自动探测当前项目根')
    .default(DEFAULT_REPO_ROOT)
    .extra('volatile', true),
  seatsFile: z.string()
    .description('座位表相对路径（相对于仓库根）；默认 dispatch/seats.json')
    .default('dispatch/seats.json')
    .pattern(
      /^(?!.*(?:^|[\\/])\.\.(?:$|[\\/]))(?![/\\]|[A-Za-z]:)(?!.*[\\/]$).+\.json$/,
      '必须是仓库内的相对路径、不含 ..、以 .json 结尾',
    )
    .extra('volatile', true),
  otherStages: z.string()
    .description('历史兼容字段（面板不展示）')
    .default('')
    .extra('volatile', true),
  stageOpinions: z.string()
    .description('历史兼容字段（面板不展示）')
    .default('')
    .extra('volatile', true),
  reviewVotes: z.string()
    .description('评审票（逗号分隔）：执行者:模型。支持同执行者多票与自由模型组合；留空按座位表 lineup / default_backends 运行')
    .default('')
    .extra('volatile', true),
  executorCatalog: z.string()
    .description('只读：宿主探测的可用执行者与模型目录（格式 exec:model1|model2;…）')
    .default(executorCatalog())
    .extra('volatile', true),
  divergeCommand: z.string()
    .description('发散环节执行者（codex / claude / dsh / gemini / api / kimi）。留空按座位表默认安排运行')
    .default('')
    .extra('volatile', true),
  divergeModel: z.string()
    .description('发散环节模型名。留空使用所选执行者自身默认模型')
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

export function apply(ctx, config = {}) {
  const cfgObj = config && typeof config === 'object' ? config : {};
  const _lg = makeLoggers(ctx);
  const log = (m) => _lg.info(m);
  const say = (m) => _lg.error(m);

  const repoRootNow = () => {
    const envRoot = String(process.env.DSH_DISPATCH_ROOT || '').trim();
    if (envRoot) return path.resolve(envRoot);
    const configured = String(plainValue(cfgObj.repoRoot) || '').trim();
    if (configured) return path.resolve(configured);
    return resolveDefaultRepoRoot();
  };
  const seatsFileNow = () => {
    const sf = String(plainValue(cfgObj.seatsFile) || '').trim();
    return sf || 'dispatch/seats.json';
  };

  try {
    const cfg = loadConfig(repoRootNow(), seatsFileNow(), { useDshPatch: true });
    log('座位表 ' + cfg.__file + ' 已加载（DSH 面板覆盖仅在本宿主内生效；跨宿主共享阵容请用 npx research-dispatch lineup 写入 seats.json）：'
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
        if (!bi.ok) log('Git Bash 未就绪（v2.0.0 全链路纯 Node 内核照常可用；仅自定义外部 .sh 脚本需 Git Bash，reason=' + bi.reason + '）');
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
    ctx.on('dispose', disposeActive);
  } else if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => disposeActive);
  }
}

export default { name, inject, Config, apply };
