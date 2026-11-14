// 评审位、调研位、发散位与查重位"当前生效模型身份"的单一解析与本机模型探测实现（v2.1.2）。
//
// 模型身份有两个核心消费方：
//   1. 派工（写卡片 meta 头并记录模型先验）；
//   2. 阶段计划与阵容发现（判断发散位是否与评审位同族、自动发现本机已安装 Agent 的全部可用模型）。
// 两端共享同一份解析与归一化逻辑，防止配置格式演进导致判据静默漂移。
//
// 支持的环境变量：
//   CODEX_CFG / CLAUDE_CFG / AGY_CFG / KIMI_CFG / DSH_SETTINGS      覆盖默认配置文件路径
//   CODEX_MODEL / CLAUDE_MODEL / AGY_MODEL / KIMI_MODEL / DSH_MODEL 显式模型名（走 -explicit 分支）
//   QODER_SEAT_MODEL / QODER_ATTEST_SHA                             自报座位模型与 payload 绑定指纹
//   MANUAL<N>_MODEL / MANUAL<N>_SHA                                 署名票模型与 payload 绑定指纹
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseScalarValue, parseNamedEntryConfig } from './settings-file.mjs';

export function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return homeDir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return homeDir() + p.slice(1);
  return p;
}

function dshRootDir() {
  return String(process.env.DSH_HOME || '').trim() || path.join(homeDir(), '.dsh');
}

function compileConfigRegex(pattern) {
  try {
    return new RegExp(String(pattern || ''), 'gm');
  } catch (e) {
    const err = new Error('座位表 identity.pattern 正则语法非法：' + JSON.stringify(pattern) + '（' + e.message + '）');
    err.code = 'BAD_CONFIG';
    throw err;
  }
}

function validateCutField(field) {
  const idx = Number(field);
  if (!Number.isInteger(idx) || idx < 1) {
    const err = new Error('座位表 identity.cut_field 必须是 ≥1 的整数，实得：' + JSON.stringify(field));
    err.code = 'BAD_CONFIG';
    throw err;
  }
  return idx;
}

// 等价于 `grep -oE <pattern> <file> | tail -1 | cut -d'"' -f<field>`；
// 对 .toml 配置文件仅扫描首个 `[table]` 段头之前的顶层键值，避免子表模型覆盖顶层默认模型。
function grepLastCut(file, pattern, field) {
  const re = compileConfigRegex(pattern);
  const idx = validateCutField(field);

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  let scopeText = text;
  if (/\.toml$/i.test(String(file || ''))) {
    const lines = text.split(/\r?\n/);
    const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
    const topLines = (firstTable >= 0 ? lines.slice(0, firstTable) : lines)
      .filter((l) => !/^\s*#/.test(l));
    scopeText = topLines.join('\n');
  }

  const all = scopeText.match(re);
  if (!all || all.length === 0) return '';
  const parts = all[all.length - 1].split('"');
  return parts[idx - 1] === undefined ? '' : parts[idx - 1].trim();
}

/**
 * $1=显式值 $2=配置文件 $3=正则 $4=cut 字段
 *
 * 三种返回值严格区分：
 *   <name>-explicit          环境变量或阵容显式指定模型（不解析配置文件）
 *   <name>-from-config       从配置文件回读成功
 *   unknown-check-config     文件缺失，或文件存在但未命中模型行（后者向 stderr 告警）
 */
export function resolveModel(explicit, cfgFile, pattern, field) {
  const exp = String(explicit || '').trim();
  if (pattern !== undefined && pattern !== '') compileConfigRegex(pattern);
  if (field !== undefined) validateCutField(field);
  if (exp) return exp + '-explicit';
  if (!cfgFile) return 'unknown-check-config';

  let exists = false;
  try {
    exists = fs.statSync(cfgFile).isFile();
  } catch {
    exists = false;
  }
  if (!exists) return 'unknown-check-config';

  const v = grepLastCut(cfgFile, pattern, field);
  if (v) return v + '-from-config';
  process.stderr.write('⚠ resolve_model：配置文件存在但没有匹配到模型行（格式漂移？）—— ' + cfgFile + '\n');
  return 'unknown-check-config';
}

function extractGeminiModelFromJson(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  if (typeof parsed.model === 'string' && parsed.model.trim()) return parsed.model.trim();
  if (parsed.model && typeof parsed.model === 'object') {
    const nested = parsed.model.name || parsed.model.id || parsed.model.default || '';
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  for (const k of ['defaultModel', 'selectedModel']) {
    if (typeof parsed[k] === 'string' && parsed[k].trim()) return parsed[k].trim();
  }
  if (parsed.env && typeof parsed.env === 'object' && typeof parsed.env.GEMINI_MODEL === 'string' && parsed.env.GEMINI_MODEL.trim()) {
    return parsed.env.GEMINI_MODEL.trim();
  }
  return '';
}

function extractAgyModelFromJson(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  if (typeof parsed.model === 'string' && parsed.model.trim()) return parsed.model.trim();
  if (parsed.model && typeof parsed.model === 'object') {
    const nested = parsed.model.name || parsed.model.id || parsed.model.default || '';
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  for (const k of ['defaultModel', 'selectedModel']) {
    if (typeof parsed[k] === 'string' && parsed[k].trim()) return parsed[k].trim();
  }
  if (parsed.env && typeof parsed.env === 'object' && typeof parsed.env.AGY_MODEL === 'string' && parsed.env.AGY_MODEL.trim()) {
    return parsed.env.AGY_MODEL.trim();
  }
  return '';
}

export function agyModelsCacheCandidates(cfgFileOverride = '') {
  const explicitCache = String(process.env.AGY_MODELS_CACHE || '').trim();
  if (explicitCache.toLowerCase() === 'none') return [];
  if (explicitCache) return [path.resolve(expandHome(explicitCache))];
  const baseCfg = expandHome(cfgFileOverride || process.env.AGY_CFG || '~/.gemini/antigravity-cli/settings.json');
  if (!baseCfg) return [];
  const cfgDir = path.dirname(baseCfg);
  return [
    path.join(cfgDir, 'cache', 'models_cache.json'),
    path.join(cfgDir, 'models_cache.json'),
  ];
}

export function readAgyModelsCache(cfgFileOverride = '') {
  const cands = agyModelsCacheCandidates(cfgFileOverride);
  for (const file of cands) {
    try {
      if (!fs.statSync(file).isFile()) continue;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const models = [];
      const push = (v) => {
        const s = String(v || '').trim();
        if (s && !/\s/.test(s) && s !== 'unknown-check-config' && !models.includes(s)) models.push(s);
      };
      let defaultModel = '';
      let updatedAt = 0;
      if (Array.isArray(raw)) {
        for (const it of raw) {
          if (typeof it === 'string') push(it);
          else if (it && typeof it === 'object') push(it.slug || it.id || it.model || it.name);
        }
      } else if (raw && typeof raw === 'object') {
        if (typeof raw.defaultModel === 'string' && raw.defaultModel.trim()) {
          defaultModel = raw.defaultModel.trim();
          push(defaultModel);
        }
        if (Number.isFinite(Number(raw.updatedAt))) updatedAt = Number(raw.updatedAt);
        if (Array.isArray(raw.models)) {
          for (const it of raw.models) {
            if (typeof it === 'string') push(it);
            else if (it && typeof it === 'object') push(it.slug || it.id || it.model || it.name);
          }
        }
      }
      if (!defaultModel && models.length > 0) defaultModel = models[0];
      if (models.length > 0 || defaultModel) {
        return { file, exists: true, updatedAt, defaultModel, models };
      }
    } catch { /* 单个缓存文件不可读继续 */ }
  }
  return { file: cands[0] || '', exists: false, updatedAt: 0, defaultModel: '', models: [] };
}

export function parseAgyModelsOutput(stdout) {
  const models = [];
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const clean = rawLine.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!clean || clean.startsWith('#') || clean.startsWith('-')) continue;
    if (/^(?:fetching|usage|flags|available|error|warning)\b/i.test(clean)) continue;
    const cols = clean.split(/\t|\s{2,}/);
    const id = String(cols[0] || '').trim();
    if (!id || /\s/.test(id) || id.endsWith(':')) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/\[\]:-]*$/.test(id)) continue;
    if (!models.includes(id)) models.push(id);
  }
  return {
    defaultModel: models[0] || '',
    models,
  };
}

function findAgyExecutableOnPath() {
  const isWin = process.platform === 'win32';
  const rawPath = String(process.env.PATH || process.env.Path || '');
  const dirs = rawPath.split(isWin ? ';' : ':');
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    const binDir = d.trim().replace(/^"|"$/g, '');
    if (!binDir) continue;
    for (const ext of exts) {
      const cand = path.join(binDir, 'agy' + ext);
      try {
        if (fs.statSync(cand).isFile()) return cand;
      } catch { /* 继续 */ }
    }
  }
  return '';
}

let _agyRefreshInFlight = null;

/**
 * 异步调用 `agy models` 刷新本地模型缓存（`~/.gemini/antigravity-cli/cache/models_cache.json`）：
 *   - 缓存未过期时毫秒级直接返回，零子进程；
 *   - 在 `AGY_SKIP_LIVE_MODELS=1`、`DRY=1` 或未初始化 `antigravity-cli` 的隔离沙箱中自动跳过，绝不联网阻塞单测。
 */
export async function refreshAgyModelsCache(opts = {}) {
  const force = Boolean(opts.force);
  const ttlMs = Number.isFinite(Number(opts.ttlMs)) ? Number(opts.ttlMs) : 15 * 60 * 1000;
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 6000;
  const cfgOverride = String(opts.cfgFile || '').trim();

  const cached = readAgyModelsCache(cfgOverride);
  if (!force && cached.exists && cached.models.length > 0 && cached.updatedAt > 0 && (Date.now() - cached.updatedAt) < ttlMs) {
    return { ok: true, cached: true, defaultModel: cached.defaultModel, models: cached.models, file: cached.file };
  }

  if (String(process.env.AGY_SKIP_LIVE_MODELS || '').trim() === '1' || String(process.env.DRY || '').trim() === '1') {
    return { ok: false, skipped: true, defaultModel: cached.defaultModel, models: cached.models, file: cached.file };
  }

  const cands = agyModelsCacheCandidates(cfgOverride);
  if (!cands.length) {
    return { ok: false, skipped: true, defaultModel: '', models: [], file: '' };
  }

  const hasCustomTarget = Boolean(opts.bin || cfgOverride || process.env.AGY_CFG || process.env.AGY_MODELS_CACHE);
  if (!force && !hasCustomTarget) {
    const agyCliDir = expandHome('~/.gemini/antigravity-cli');
    if (!fs.existsSync(agyCliDir)) {
      return { ok: false, skipped: true, defaultModel: cached.defaultModel, models: cached.models, file: cached.file };
    }
  }

  const bin = String(opts.bin || '').trim() || findAgyExecutableOnPath();
  if (!bin) {
    return { ok: false, installed: false, defaultModel: cached.defaultModel, models: cached.models, file: cached.file };
  }

  if (_agyRefreshInFlight && !opts.bin && !cfgOverride) {
    return _agyRefreshInFlight;
  }

  const runProbe = new Promise((resolve) => {
    const isWinCmd = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(bin);
    const spawnBin = isWinCmd ? (process.env.ComSpec || 'cmd.exe') : bin;
    const spawnArgs = isWinCmd ? ['/d', '/s', '/c', '"' + bin + '" models'] : ['models'];
    let stdout = '';
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };

    let child;
    try {
      child = spawn(spawnBin, spawnArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: isWinCmd,
      });
    } catch {
      return finish({ ok: false, installed: false, defaultModel: cached.defaultModel, models: cached.models, file: cached.file });
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
      finish({ ok: false, timeout: true, defaultModel: cached.defaultModel, models: cached.models, file: cached.file });
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
    }
    child.on('error', () => {
      clearTimeout(timer);
      finish({ ok: false, error: true, defaultModel: cached.defaultModel, models: cached.models, file: cached.file });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseAgyModelsOutput(stdout);
      if (code === 0 && parsed.models.length > 0) {
        const dest = cands[0];
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const tmp = dest + '.' + process.pid + '.' + Date.now() + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify({
            updatedAt: Date.now(),
            defaultModel: parsed.defaultModel,
            models: parsed.models,
          }, null, 2) + '\n', 'utf8');
          try {
            fs.renameSync(tmp, dest);
          } catch {
            fs.copyFileSync(tmp, dest);
            try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
          }
        } catch { /* 缓存写盘失败不影响当次返回 */ }
        return finish({ ok: true, cached: false, defaultModel: parsed.defaultModel, models: parsed.models, file: dest });
      }
      return finish({ ok: false, exitCode: code, defaultModel: cached.defaultModel, models: cached.models, file: cached.file });
    });
  });

  if (!opts.bin && !cfgOverride) {
    _agyRefreshInFlight = runProbe.finally(() => { _agyRefreshInFlight = null; });
    return _agyRefreshInFlight;
  }
  return runProbe;
}

/**
 * Antigravity CLI (`agy`) 模型身份解析：优先显式指定 > settings.json > 本地 models_cache.json 默认首项。
 */
export function agyConfigModel(explicit = '', cfgFileOverride = '') {
  const exp = String(explicit || '').trim();
  if (exp) return exp + '-explicit';
  const cfgFile = expandHome(cfgFileOverride || process.env.AGY_CFG || '~/.gemini/antigravity-cli/settings.json');
  if (cfgFile) {
    try {
      if (fs.statSync(cfgFile).isFile()) {
        const raw = fs.readFileSync(cfgFile, 'utf8');
        try {
          const parsed = JSON.parse(raw);
          const v = extractAgyModelFromJson(parsed);
          if (v) return v + '-from-config';
        } catch {
          const v = grepLastCut(cfgFile, '"model"\\s*:\\s*"[^"]*"', 4);
          if (v) return v + '-from-config';
        }
      }
    } catch { /* 继续回退缓存 */ }
  }
  const cached = readAgyModelsCache(cfgFileOverride);
  if (cached.defaultModel) return cached.defaultModel + '-from-config';
  return 'unknown-check-config';
}

/**
 * Gemini CLI 模型身份解析（旧版兼容保留）：兼容 settings.json 中 `"model": "gemini-2.5-pro"` 与嵌套对象 `"model": { "name": "..." }`。
 */
export function geminiConfigModel(explicit = '', cfgFileOverride = '') {
  const exp = String(explicit || '').trim();
  if (exp) return exp + '-explicit';
  const cfgFile = expandHome(cfgFileOverride || process.env.GEMINI_CFG || '~/.gemini/settings.json');
  if (!cfgFile) return 'unknown-check-config';
  let raw;
  try {
    if (!fs.statSync(cfgFile).isFile()) return 'unknown-check-config';
    raw = fs.readFileSync(cfgFile, 'utf8');
  } catch {
    return 'unknown-check-config';
  }
  try {
    const parsed = JSON.parse(raw);
    const v = extractGeminiModelFromJson(parsed);
    if (v) return v + '-from-config';
  } catch {
    const v = grepLastCut(cfgFile, '"model"\\s*:\\s*"[^"]*"', 4);
    if (v) return v + '-from-config';
  }
  return 'unknown-check-config';
}

function formatDshProviderModel(prov, mdl) {
  const p = String(prov || '').trim();
  const m = String(mdl || '').trim();
  if (!m) return '';
  if (p) return m.startsWith(p + '/') ? m : p + '/' + m;
  return m.includes('/') ? m : '?/' + m;
}

// 活源①：设置文档 ~/.dsh/settings.yaml 的 agent-default-model 嵌套块。
// 按缩进边界扫描整个顶层块（遇到下一个列 0 顶层键即停），剥离引号与行尾注释并防双拼 provider。
function settingsModel() {
  const defaultSettings = path.join(dshRootDir(), 'settings.yaml');
  const file = expandHome(process.env.DSH_SETTINGS || defaultSettings);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const at = lines.findIndex((l) => /^agent-default-model:\s*(?:#.*)?$/.test(l));
  if (at < 0) return '';

  let prov = '';
  let mdl = '';
  for (let i = at + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (/^\S/.test(raw)) break;
    const m = raw.match(/^\s{2}([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m || /^\s{3}/.test(raw)) continue;
    const val = parseScalarValue(m[2]);
    const s = typeof val === 'string' ? val.trim() : '';
    if (m[1] === 'provider') prov = s;
    else if (m[1] === 'model') mdl = s;
  }

  return formatDshProviderModel(prov, mdl);
}

// 活源②：profile 补丁中 `id: agent-default-model` 的 config.provider / config.model。
// 若显式设了 DSH_PROFILE 则只读对应 profile；未设时按 profiles/headless → 根 cordis.patch.yml → profiles/desktop 依次回退。
function profilePatchModel() {
  const root = dshRootDir();
  const explicit = String(process.env.DSH_PROFILE || '').trim();
  const candidates = explicit
    ? [path.join(root, 'profiles', explicit, 'cordis.patch.yml')]
    : [
        path.join(root, 'profiles', 'headless', 'cordis.patch.yml'),
        path.join(root, 'cordis.patch.yml'),
        path.join(root, 'profiles', 'desktop', 'cordis.patch.yml'),
      ];
  for (const file of candidates) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const cfg = parseNamedEntryConfig(text, 'agent-default-model');
    if (!cfg) continue;
    const formatted = formatDshProviderModel(cfg.provider, cfg.model);
    if (formatted) return formatted;
  }
  return '';
}

function isCustomDshSettingsOverride() {
  const raw = String(process.env.DSH_SETTINGS || '').trim();
  if (!raw) return false;
  const resolved = path.resolve(expandHome(raw));
  const def = path.resolve(path.join(dshRootDir(), 'settings.yaml'));
  if (process.platform === 'win32') return resolved.toLowerCase() !== def.toLowerCase();
  return resolved !== def;
}

// 两个活源按优先级回退；若调用方显式将 DSH_SETTINGS 指向了非默认路径，则严格只读该文件而不串读 profile。
function dshModelWithSource() {
  const s = settingsModel();
  if (s) return { model: s, source: 'settings.yaml' };
  if (isCustomDshSettingsOverride()) return { model: '', source: '' };
  const p = profilePatchModel();
  if (p) return { model: p, source: 'profile-patch' };
  return { model: '', source: '' };
}

export function dshLiveModel() {
  return dshModelWithSource().model;
}

// 归一化掉来源后缀（-from-* / -explicit / -manual-attested）与任意路由/provider 前缀，并统一小写，只比模型本体。
export function normModel(s) {
  return String(s === undefined || s === null ? '' : s)
    .trim()
    .replace(/-from-.*$/, '')
    .replace(/-explicit$/, '')
    .replace(/-manual-attested$/, '')
    .replace(/^(?:dsh:)?.*\//, '')
    .replace(/^dsh:/, '')
    .toLowerCase();
}

// 模型家族名：先剥离来源后缀与多层路由斜杠前缀，再取连字符/下划线前的首段小写族名。
export function modelFamily(s) {
  return normModel(s)
    .replace(/^.*\//, '')
    .replace(/[-_ ].*$/, '');
}

// dsh 写入卡片 meta 的身份标签；不可读时统一返回 unknown-check-config。
export function dshTag() {
  const d = dshModelWithSource();
  return d.model ? 'dsh:' + d.model + '-from-' + d.source : 'unknown-check-config';
}

// 自报类代递座位在无签名绑定时计票侧恒为 unknown-check-config。
export function qoderTag() {
  return 'unknown-check-config';
}

// 同族比对侧读取真实自报名（仅在配置了 QODER_SEAT_MODEL 时返回）。
export function qoderSelfModel() {
  const v = String(process.env.QODER_SEAT_MODEL || '').trim();
  return v ? v + '-from-selfdeclared' : '';
}

/**
 * 署名票（代递座 / manual* 等）的先验标签：
 * 同时满足 ① 给出答者模型名 且 ② 交回与当前轮次一致的 payload sha 时，返回 `<model>-manual-attested`；
 * 其它任何情形统一返回 `unknown-check-config`（绝不返回空串以免污染先验集合）。
 */
export function seatAttestToken(be, payloadSha, seat = null) {
  const env = process.env;
  const seatName = String(be || '').trim();
  if (!seatName) return 'unknown-check-config';

  const up = seatName.toUpperCase();
  const interp = (tpl) => String(tpl || '').replace(/\{SEAT_UPPER\}/g, up).replace(/\{SEAT\}/g, seatName);

  let modelEnv = '';
  let shaEnv = '';
  if (seat && typeof seat === 'object') {
    modelEnv = interp(seat.model_env || '');
    shaEnv = interp(seat.attest_sha_env || seat.sha_env || '');
  }
  if (!modelEnv) {
    modelEnv = seatName === 'qoder' ? 'QODER_SEAT_MODEL' : (/^[A-Za-z0-9_-]+$/.test(seatName) ? up + '_MODEL' : '');
  }
  if (!shaEnv) {
    shaEnv = seatName === 'qoder' ? 'QODER_ATTEST_SHA' : (/^[A-Za-z0-9_-]+$/.test(seatName) ? up + '_SHA' : '');
  }

  const mdl = modelEnv ? String(env[modelEnv] || '').trim() : '';
  const sha = shaEnv ? String(env[shaEnv] || '').trim().toLowerCase() : '';
  const targetSha = String(payloadSha || '').trim().toLowerCase();
  const shaMatch = Boolean(
    mdl
    && sha
    && targetSha
    && (sha === targetSha || (/^[0-9a-f]{64}$/.test(sha) && sha.startsWith(targetSha)))
  );
  if (shaMatch) {
    return mdl.replace(/\s+/g, '_') + '-manual-attested';
  }
  return 'unknown-check-config';
}

function qualifyDshStemModel(stem, rawId) {
  const s = String(rawId || '').trim();
  if (!s || /\s/.test(s)) return '';
  const p = String(stem || '').trim();
  if (!p) return s;
  return s.startsWith(p + '/') ? s : p + '/' + s;
}

function bareDshModelWithoutStem(stem, fullId) {
  const p = String(stem || '').trim();
  const f = String(fullId || '').trim();
  return (p && f.startsWith(p + '/')) ? f.slice(p.length + 1) : f;
}

function collectDshStorageModels(node, out, depth, provPrefix) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === 'object') {
        const id = item.id || item.model || item.modelId || item.route;
        if (typeof id === 'string' && id.trim()) {
          const qualified = qualifyDshStemModel(provPrefix, id);
          if (qualified) out.push(qualified);
        }
      }
      collectDshStorageModels(item, out, depth + 1, provPrefix);
    }
    return;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) collectDshStorageModels(v, out, depth + 1, provPrefix);
  }
}

// 从 cordis.patch.yml 中安全提取 `id: llm-pi-ai` 的 `config.providers.<prov>.models[].id`（严格只读模型 id，绝不接触任何密钥字段）。
function extractLlmPiAiModelsFromPatch(text) {
  if (!text) return [];
  const out = [];
  const rawLines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines = rawLines.filter((l) => l.trim() && !l.trim().startsWith('#'));

  for (let start = 0; start < lines.length; start++) {
    const headMatch = lines[start].match(/^(\s*)-(?:\s+(.*))?$/);
    if (!headMatch) continue;
    const baseIndent = headMatch[1].length;
    const propIndent = baseIndent + 2;

    const itemLines = [lines[start]];
    for (let j = start + 1; j < lines.length; j++) {
      const lead = lines[j].match(/^(\s*)/)[1].length;
      if (lead <= baseIndent) break;
      itemLines.push(lines[j]);
    }

    let entryId = '';
    let entryDisabled = false;
    const checkTopProp = (key, rest) => {
      const parsed = parseScalarValue(rest);
      const val = typeof parsed === 'string' ? parsed.trim() : '';
      if (key === 'id') entryId = val;
      else if (key === 'enabled' && val.toLowerCase() === 'false') entryDisabled = true;
      else if (key === 'disabled' && val.toLowerCase() === 'true') entryDisabled = true;
    };

    const firstRest = (headMatch[2] || '').trim();
    const pm0 = firstRest.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (pm0) checkTopProp(pm0[1], pm0[2]);
    for (let i = 1; i < itemLines.length; i++) {
      const lead = itemLines[i].match(/^(\s*)/)[1].length;
      const body = itemLines[i].slice(lead);
      if (lead === propIndent && !body.startsWith('-')) {
        const pm = body.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (pm) checkTopProp(pm[1], pm[2]);
      }
    }

    if (entryId !== 'llm-pi-ai' || entryDisabled) continue;

    let inConfig = false;
    let configIndent = -1;
    let inProviders = false;
    let providersIndent = -1;
    let provKeyIndent = -1;
    let currentProv = '';
    let provDisabled = false;
    let inModels = false;
    let modelsIndent = -1;
    let modelDashIndent = -1;

    const scanLine = (lead, body) => {
      if (inConfig && lead <= configIndent) {
        inConfig = false;
        inProviders = false;
        inModels = false;
      }
      if (!inConfig) {
        if (lead === propIndent && /^config\s*:\s*(?:#.*)?$/.test(body)) {
          inConfig = true;
          configIndent = lead;
        }
        return;
      }

      if (inProviders && lead <= providersIndent) {
        inProviders = false;
        inModels = false;
        currentProv = '';
      }
      if (!inProviders) {
        if (lead > configIndent && /^providers\s*:\s*(?:#.*)?$/.test(body)) {
          inProviders = true;
          providersIndent = lead;
          provKeyIndent = -1;
          currentProv = '';
          inModels = false;
        }
        return;
      }

      if (provKeyIndent < 0 && lead > providersIndent && !body.startsWith('-')) {
        provKeyIndent = lead;
      }
      if (provKeyIndent > 0 && lead === provKeyIndent && !body.startsWith('-')) {
        const km = body.match(/^([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*:\s*(?:#.*)?$/);
        if (km) {
          const parsedKey = parseScalarValue(km[1]);
          currentProv = typeof parsedKey === 'string' && parsedKey.trim() ? parsedKey.trim() : km[1].trim();
          provDisabled = false;
          inModels = false;
          modelsIndent = -1;
          modelDashIndent = -1;
        } else {
          currentProv = '';
          inModels = false;
        }
        return;
      }

      if (!currentProv || lead <= provKeyIndent) return;

      if (inModels && lead <= modelsIndent) {
        // 注意：YAML 允许列表项 `-` 与父键 `models:` 同缩进（如 `models:\n- id: x`）
        if (!(lead === modelsIndent && body.startsWith('-'))) {
          inModels = false;
          modelsIndent = -1;
          modelDashIndent = -1;
        }
      }

      if (!inModels) {
        if (!body.startsWith('-')) {
          const pm = body.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
          if (pm) {
            if (pm[1] === 'enabled' && String(parseScalarValue(pm[2]) || '').toLowerCase() === 'false') provDisabled = true;
            if (pm[1] === 'disabled' && String(parseScalarValue(pm[2]) || '').toLowerCase() === 'true') provDisabled = true;
            if (pm[1] === 'models' && (!pm[2].trim() || pm[2].trim().startsWith('#'))) {
              inModels = true;
              modelsIndent = lead;
              modelDashIndent = -1;
            }
          }
        }
        return;
      }

      if (provDisabled) return;

      if (body.startsWith('-')) {
        if (modelDashIndent < 0 || lead === modelDashIndent) {
          modelDashIndent = lead;
          const inlineId = body.match(/^-\s+id\s*:\s*(.+)$/);
          if (inlineId) {
            const idVal = parseScalarValue(inlineId[1]);
            const qualified = qualifyDshStemModel(currentProv, typeof idVal === 'string' ? idVal : '');
            if (qualified) out.push(qualified);
            return;
          }
          const flowId = body.match(/^-\s*\{[^}]*\bid\s*:\s*([^,}]+)/);
          if (flowId) {
            const idVal = parseScalarValue(flowId[1]);
            const qualified = qualifyDshStemModel(currentProv, typeof idVal === 'string' ? idVal : '');
            if (qualified) out.push(qualified);
          }
        }
        return;
      }

      if (modelDashIndent >= 0 && lead === modelDashIndent + 2) {
        const propId = body.match(/^id\s*:\s*(.+)$/);
        if (propId) {
          const idVal = parseScalarValue(propId[1]);
          const qualified = qualifyDshStemModel(currentProv, typeof idVal === 'string' ? idVal : '');
          if (qualified) out.push(qualified);
        }
      }
    };

    if (pm0) scanLine(propIndent, firstRest);
    for (let i = 1; i < itemLines.length; i++) {
      const lead = itemLines[i].match(/^(\s*)/)[1].length;
      scanLine(lead, itemLines[i].slice(lead));
    }
  }

  return out;
}

export function readDshCatalogModels() {
  if (isCustomDshSettingsOverride()) return [];
  const out = [];
  const root = dshRootDir();
  const dir = path.join(root, 'storages');
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
      } catch { /* 单文件损坏忽略 */ }
    }
    for (const f of files) {
      if (!/(models|catalog)/i.test(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!j || j.enabled === false || j.disabled === true) continue;
        const prefix = (f.match(/^[a-z0-9]+(?:-[a-z0-9]+)*?(?=-(?:models|catalog|prod-catalog|intl-catalog|[a-z]*-catalog)\.json$)/i) || [f.replace(/\.json$/, '')])[0];
        if (offPrefix.has(prefix)) continue;
        const before = out.length;
        const stem = f.replace(/\.json$/i, '')
          .replace(/-(models|catalog|prod-catalog|intl-catalog|cn-catalog|global-catalog|[a-z0-9]*-catalog)$/i, '')
          .replace(/-(intl|prod|cn|global)$/i, '');
        collectDshStorageModels(j, out, 0, stem);
        if (Array.isArray(j.enabledModelIds)) {
          for (const rawId of j.enabledModelIds) {
            if (typeof rawId === 'string' && rawId.trim()) {
              const qualified = qualifyDshStemModel(stem, rawId);
              if (qualified) out.push(qualified);
            }
          }
        }
        if (Array.isArray(j.enabledModelIds) && j.enabledModelIds.length > 0) {
          const allow = new Set(j.enabledModelIds.map((x) => String(x || '').trim()).filter(Boolean));
          for (let i = out.length - 1; i >= before; i--) {
            const full = out[i];
            const bare = bareDshModelWithoutStem(stem, full);
            if (!allow.has(full) && !allow.has(bare)) out.splice(i, 1);
          }
        }
        if (Array.isArray(j.hiddenModels) && j.hiddenModels.length > 0) {
          const deny = new Set(j.hiddenModels.map((x) => String(x || '').trim()).filter(Boolean));
          for (let i = out.length - 1; i >= before; i--) {
            const full = out[i];
            const bare = bareDshModelWithoutStem(stem, full);
            if (deny.has(full) || deny.has(bare)) out.splice(i, 1);
          }
        }
      } catch { /* 单文件损坏忽略 */ }
    }
  } catch { /* 无 storages 目录 */ }

  // 合并 DSH cordis.patch.yml 中 llm-pi-ai 各 provider 声明的 models[].id
  const explicitProfile = String(process.env.DSH_PROFILE || '').trim();
  const patchCands = [];
  if (explicitProfile) {
    patchCands.push(path.join(root, 'profiles', explicitProfile, 'cordis.patch.yml'));
  } else {
    patchCands.push(
      path.join(root, 'profiles', 'desktop', 'cordis.patch.yml'),
      path.join(root, 'profiles', 'headless', 'cordis.patch.yml'),
      path.join(root, 'cordis.patch.yml'),
    );
    try {
      const profDir = path.join(root, 'profiles');
      for (const d of fs.readdirSync(profDir)) {
        const p = path.join(profDir, d, 'cordis.patch.yml');
        if (!patchCands.includes(p)) patchCands.push(p);
      }
    } catch { /* 无 profiles 目录 */ }
  }
  for (const p of patchCands) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      for (const m of extractLlmPiAiModelsFromPatch(txt)) out.push(m);
    } catch { /* 文件不存在忽略 */ }
  }

  return [...new Set(out)];
}

const AGY_FALLBACK_MODELS = [
  'gemini-4-carbon-medium',
  'gemini-4-carbon-high',
  'gemini-4-carbon-low',
  'gemini-4-argon-medium',
  'gemini-4-argon-high',
  'gemini-4-hydrogen-high',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-opus-5-5-high',
  'claude-opus-5-5-medium',
  'claude-sonnet-5-5-high',
  'claude-sonnet-5-5-medium',
];

const GEMINI_FALLBACK_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
];

let _geminiPkgCache = { key: '', models: [] };

export function scanGeminiCliPackageModels() {
  const pkgCands = [];
  const envPkg = String(process.env.GEMINI_CLI_PKG_DIR || '').trim();
  if (envPkg.toLowerCase() === 'none') return [];
  if (envPkg) {
    pkgCands.push(path.resolve(expandHome(envPkg)));
  } else {
    const isWin = process.platform === 'win32';
    const rawPath = String(process.env.PATH || process.env.Path || '');
    const dirs = rawPath.split(isWin ? ';' : ':');
    const exts = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];
    for (const d of dirs) {
      const binDir = d.trim().replace(/^"|"$/g, '');
      if (!binDir) continue;
      let hitBin = '';
      for (const ext of exts) {
        const cand = path.join(binDir, 'gemini' + ext);
        try {
          if (fs.statSync(cand).isFile()) { hitBin = cand; break; }
        } catch { /* 继续 */ }
      }
      if (!hitBin) continue;
      pkgCands.push(path.join(binDir, 'node_modules', '@google', 'gemini-cli'));
      pkgCands.push(path.resolve(binDir, '..', 'lib', 'node_modules', '@google', 'gemini-cli'));
      try {
        let cur = path.dirname(fs.realpathSync(hitBin));
        for (let up = 0; up < 4; up++) {
          if (path.basename(cur) === 'gemini-cli' && path.basename(path.dirname(cur)) === '@google') {
            pkgCands.push(cur);
            break;
          }
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
      } catch { /* 忽略软链解析失败 */ }
    }
    if (process.env.APPDATA) {
      pkgCands.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@google', 'gemini-cli'));
    }
  }

  const uniqDirs = [...new Set(pkgCands)];
  const activeDirs = [];
  const sigParts = [];
  for (const dir of uniqDirs) {
    try {
      const st = fs.statSync(dir);
      if (st.isDirectory()) {
        activeDirs.push(dir);
        sigParts.push(dir + '@' + String(Math.floor(st.mtimeMs)));
      }
    } catch { /* 目录不存在 */ }
  }

  const cacheKey = sigParts.join('|');
  if (!activeDirs.length) return [];
  if (_geminiPkgCache.key === cacheKey) return [..._geminiPkgCache.models];

  const found = [];
  const pushGem = (constName, id) => {
    const clean = String(id || '').trim();
    if (!clean || clean === 'none') return;
    if (/embedding|computer-use/i.test(clean) || /EMBEDDING|COMPUTER_USE/i.test(constName)) return;
    if (!found.includes(clean)) found.push(clean);
  };

  const constRe = /\b((?:DEFAULT|PREVIEW|BASE|LATEST|LEGACY|SECONDARY)_GEMINI_[A-Z0-9_]*MODEL)\s*=\s*["'](gemini-[a-z0-9.-]+)["']/g;
  const scanJsFile = (jsPath) => {
    try {
      const st = fs.statSync(jsPath);
      if (!st.isFile() || st.size > 16 * 1024 * 1024) return;
      const txt = fs.readFileSync(jsPath, 'utf8');
      if (!txt.includes('_GEMINI_')) return;
      for (const m of txt.matchAll(constRe)) {
        pushGem(m[1], m[2]);
      }
    } catch { /* 忽略不可读文件 */ }
  };

  for (const pkgDir of activeDirs) {
    scanJsFile(path.join(pkgDir, 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'config', 'models.js'));
    scanJsFile(path.resolve(pkgDir, '..', 'gemini-cli-core', 'dist', 'src', 'config', 'models.js'));
    const bundleDir = path.join(pkgDir, 'bundle');
    try {
      const entries = fs.readdirSync(bundleDir).filter((f) => f.endsWith('.js')).sort();
      for (const f of entries) {
        scanJsFile(path.join(bundleDir, f));
      }
    } catch { /* 无 bundle 目录 */ }
    if (found.length > 0) break;
  }

  _geminiPkgCache = { key: cacheKey, models: found };
  return [...found];
}

function readJsonModelEntries(jsonFile, out, pushFn) {
  try {
    if (!fs.statSync(jsonFile).isFile()) return;
    const j = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    const list = Array.isArray(j)
      ? j
      : (j && typeof j === 'object' && Array.isArray(j.models) ? j.models : []);
    for (const item of list) {
      if (typeof item === 'string') {
        pushFn(out, item);
      } else if (item && typeof item === 'object') {
        pushFn(out, item.slug || item.id || item.model || item.name);
      }
    }
  } catch { /* 缓存或目录文件缺失/损坏忽略 */ }
}

/**
 * 静默探测本机各 Agent 配置文件、本地模型缓存与包内模型常量中的默认模型与候选模型列表（零子进程、毫秒级、绝不泄露密钥明文）。
 */
export function probeAgentModelsFromConfigs() {
  const pushUniq = (arr, v) => {
    const s = String(v || '').trim();
    if (s && s !== 'unknown-check-config' && !/\s/.test(s) && !arr.includes(s)) arr.push(s);
  };

  // 1) codex (~/.codex/config.toml 顶层与 [profiles.*] + models_cache.json + cc-switch-model-catalog.json)
  const codexCfg = expandHome(process.env.CODEX_CFG || '~/.codex/config.toml');
  const codexDir = path.dirname(codexCfg);
  const codexModels = [];
  let codexDefault = String(process.env.CODEX_MODEL || '').trim();
  pushUniq(codexModels, codexDefault);
  let codexHasFile = false;
  try {
    if (fs.statSync(codexCfg).isFile()) {
      codexHasFile = true;
      const txt = fs.readFileSync(codexCfg, 'utf8');
      const lines = txt.split(/\r?\n/);
      let inSubTable = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (/^\[.+\]/.test(trimmed)) {
          inSubTable = true;
          continue;
        }
        const m = trimmed.match(/^model\s*=\s*(?:"([^"]+)"|'([^']+)')/);
        const val = m ? (m[1] || m[2] || '').trim() : '';
        if (val) {
          if (!inSubTable && !codexDefault) codexDefault = val;
          pushUniq(codexModels, val);
        }
      }
    }
  } catch { /* 无 codex 配置 */ }
  readJsonModelEntries(path.join(codexDir, 'models_cache.json'), codexModels, pushUniq);
  readJsonModelEntries(path.join(codexDir, 'cc-switch-model-catalog.json'), codexModels, pushUniq);

  // 2) claude (~/.claude/settings.json 的 model、env.*MODEL 与 availableModels)
  const claudeCfg = expandHome(process.env.CLAUDE_CFG || '~/.claude/settings.json');
  const claudeModels = [];
  let claudeDefault = String(process.env.CLAUDE_MODEL || '').trim();
  pushUniq(claudeModels, claudeDefault);
  let claudeHasFile = false;
  try {
    if (fs.statSync(claudeCfg).isFile()) {
      claudeHasFile = true;
      const raw = fs.readFileSync(claudeCfg, 'utf8');
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const envObj = parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env) ? parsed.env : {};
          const envPrimary = typeof envObj.ANTHROPIC_MODEL === 'string' ? envObj.ANTHROPIC_MODEL.trim() : '';
          const topModel = typeof parsed.model === 'string' ? parsed.model.trim() : '';
          const sonnetDef = typeof envObj.ANTHROPIC_DEFAULT_SONNET_MODEL === 'string' ? envObj.ANTHROPIC_DEFAULT_SONNET_MODEL.trim() : '';
          const primary = (envPrimary && !/\s/.test(envPrimary))
            ? envPrimary
            : ((topModel && !/\s/.test(topModel)) ? topModel : ((sonnetDef && !/\s/.test(sonnetDef)) ? sonnetDef : ''));
          if (primary && !claudeDefault) {
            claudeDefault = primary;
          }
          pushUniq(claudeModels, primary);
          pushUniq(claudeModels, topModel);
          pushUniq(claudeModels, envPrimary);
          for (const [k, v] of Object.entries(envObj)) {
            if (!/MODEL$/i.test(k) || /(?:^|_)(?:KEY|TOKEN|SECRET|PASS|AUTH)$/i.test(k)) continue;
            if (typeof v === 'string') {
              const clean = v.trim();
              if (clean && !/\s/.test(clean) && !/^(?:sk|rk)-[A-Za-z0-9_-]{12,}$/.test(clean)) {
                pushUniq(claudeModels, clean);
              }
            }
          }
          if (Array.isArray(parsed.availableModels)) {
            for (const m of parsed.availableModels) {
              if (typeof m === 'string') pushUniq(claudeModels, m);
              else if (m && typeof m === 'object') pushUniq(claudeModels, m.id || m.name || m.model);
            }
          }
          if (!claudeDefault && claudeModels.length > 0) {
            claudeDefault = claudeModels[0];
          }
        }
      } catch {
        const v = grepLastCut(claudeCfg, '"(ANTHROPIC_MODEL|model)"\\s*:\\s*"[^"]*"', 4);
        if (v && !claudeDefault) claudeDefault = v;
        pushUniq(claudeModels, v);
      }
    }
  } catch { /* 无 claude 配置 */ }

  // 3) dsh (~/.dsh/settings.yaml / profiles cordis.patch.yml llm-pi-ai / storages)
  const dshModels = [];
  const dshLive = dshLiveModel();
  const dshDefault = String(process.env.DSH_MODEL || dshLive || '').trim();
  pushUniq(dshModels, dshDefault);
  pushUniq(dshModels, dshLive);
  for (const m of readDshCatalogModels()) pushUniq(dshModels, m);
  let dshHasFile = false;
  try {
    dshHasFile = fs.existsSync(dshRootDir());
  } catch { dshHasFile = false; }

  // 4) agy (~/.gemini/antigravity-cli/settings.json + cache/models_cache.json + 去重兜底列表)
  const agyCfg = expandHome(process.env.AGY_CFG || '~/.gemini/antigravity-cli/settings.json');
  const agyModels = [];
  let agyDefault = String(process.env.AGY_MODEL || '').trim();
  pushUniq(agyModels, agyDefault);
  let agyHasFile = false;
  try {
    if (fs.statSync(agyCfg).isFile()) {
      agyHasFile = true;
      const raw = fs.readFileSync(agyCfg, 'utf8');
      try {
        const parsed = JSON.parse(raw);
        const primary = extractAgyModelFromJson(parsed);
        if (primary && !agyDefault) agyDefault = primary;
        pushUniq(agyModels, primary);
        for (const arrKey of ['models', 'availableModels']) {
          if (parsed && Array.isArray(parsed[arrKey])) {
            for (const item of parsed[arrKey]) {
              if (typeof item === 'string') pushUniq(agyModels, item);
              else if (item && typeof item === 'object') pushUniq(agyModels, item.id || item.name || item.model || item.slug);
            }
          }
        }
      } catch {
        const v = grepLastCut(agyCfg, '"model"\\s*:\\s*"[^"]*"', 4);
        if (v && !agyDefault) agyDefault = v;
        pushUniq(agyModels, v);
      }
    }
  } catch { /* 无 agy 配置 */ }
  const agyCache = readAgyModelsCache();
  if (agyCache.exists) {
    if (agyCache.defaultModel && !agyDefault) agyDefault = agyCache.defaultModel;
    for (const m of agyCache.models) pushUniq(agyModels, m);
  }
  if (!agyCache.exists || agyCache.models.length === 0) {
    for (const m of AGY_FALLBACK_MODELS) pushUniq(agyModels, m);
  }

  // 4b) gemini (旧版兼容保留：~/.gemini/settings.json + @google/gemini-cli 包内常量 + 去重兜底列表)
  const geminiCfg = expandHome(process.env.GEMINI_CFG || '~/.gemini/settings.json');
  const geminiModels = [];
  let geminiDefault = String(process.env.GEMINI_MODEL || '').trim();
  pushUniq(geminiModels, geminiDefault);
  let geminiHasFile = false;
  try {
    if (fs.statSync(geminiCfg).isFile()) {
      geminiHasFile = true;
      const raw = fs.readFileSync(geminiCfg, 'utf8');
      try {
        const parsed = JSON.parse(raw);
        const primary = extractGeminiModelFromJson(parsed);
        if (primary && !geminiDefault) geminiDefault = primary;
        pushUniq(geminiModels, primary);
        if (parsed && Array.isArray(parsed.models)) {
          for (const item of parsed.models) {
            if (typeof item === 'string') pushUniq(geminiModels, item);
            else if (item && typeof item === 'object') pushUniq(geminiModels, item.id || item.name || item.model);
          }
        }
      } catch {
        const v = grepLastCut(geminiCfg, '"model"\\s*:\\s*"[^"]*"', 4);
        if (v && !geminiDefault) geminiDefault = v;
        pushUniq(geminiModels, v);
      }
    }
  } catch { /* 无 gemini 配置 */ }
  for (const m of scanGeminiCliPackageModels()) pushUniq(geminiModels, m);
  for (const m of GEMINI_FALLBACK_MODELS) pushUniq(geminiModels, m);

  // 5) kimi (~/.kimi/config.toml 顶层 default_model/model + [models.<id>] 节名)
  const kimiCfg = expandHome(process.env.KIMI_CFG || '~/.kimi/config.toml');
  const kimiModels = [];
  let kimiDefault = String(process.env.KIMI_MODEL || '').trim();
  pushUniq(kimiModels, kimiDefault);
  let kimiHasFile = false;
  try {
    if (fs.statSync(kimiCfg).isFile()) {
      kimiHasFile = true;
      const txt = fs.readFileSync(kimiCfg, 'utf8');
      let inSubTable = false;
      for (const line of txt.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const secMatch = trimmed.match(/^\[models\.([^\]]+)\]\s*(?:#.*)?$/);
        if (secMatch && secMatch[1]) {
          inSubTable = true;
          const cleanSec = secMatch[1].trim().replace(/^["']|["']$/g, '').trim();
          pushUniq(kimiModels, cleanSec);
          continue;
        }
        if (/^\[.+\]/.test(trimmed)) {
          inSubTable = true;
          continue;
        }
        if (!inSubTable) {
          const dm = trimmed.match(/^(?:default_model|model)\s*=\s*(?:"([^"]+)"|'([^']+)')/);
          const val = dm ? (dm[1] || dm[2] || '').trim() : '';
          if (val) {
            if (!kimiDefault) kimiDefault = val;
            pushUniq(kimiModels, val);
          }
        }
      }
    }
  } catch { /* 无 kimi 配置 */ }

  // 6) api (常见 API Key 与 Base URL 环境变量名称检测，绝不读取/回传任何密钥值)
  const knownKeyVars = [
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'MOONSHOT_API_KEY',
    'KIMI_API_KEY',
    'DASHSCOPE_API_KEY',
    'OPENROUTER_API_KEY',
    'SILICONFLOW_API_KEY',
  ];
  const customKeyVar = String(process.env.API_KEY_ENV || '').trim();
  if (customKeyVar && !knownKeyVars.includes(customKeyVar)) knownKeyVars.unshift(customKeyVar);
  const configuredKeyVars = knownKeyVars.filter((k) => Boolean(String(process.env[k] || '').trim()));

  const knownBaseVars = [
    'OPENAI_BASE_URL',
    'DEEPSEEK_BASE_URL',
    'MOONSHOT_BASE_URL',
    'KIMI_BASE_URL',
    'DASHSCOPE_BASE_URL',
    'OPENROUTER_BASE_URL',
  ];
  const customBaseVar = String(process.env.API_BASE_ENV || '').trim();
  if (customBaseVar && !knownBaseVars.includes(customBaseVar)) knownBaseVars.unshift(customBaseVar);
  const configuredBaseVars = knownBaseVars.filter((k) => Boolean(String(process.env[k] || '').trim()));

  const apiDefault = String(process.env.API_MODEL || '').trim();
  const apiModels = [];
  pushUniq(apiModels, apiDefault);

  return {
    codex: { configFile: codexCfg, configExists: codexHasFile, defaultModel: codexDefault, models: codexModels },
    claude: { configFile: claudeCfg, configExists: claudeHasFile, defaultModel: claudeDefault, models: claudeModels },
    dsh: { configFile: path.join(dshRootDir(), 'settings.yaml'), configExists: dshHasFile, defaultModel: dshDefault, models: dshModels },
    agy: { configFile: agyCfg, configExists: agyHasFile || agyCache.exists, defaultModel: agyDefault, models: agyModels },
    gemini: { configFile: geminiCfg, configExists: geminiHasFile, defaultModel: geminiDefault, models: geminiModels },
    kimi: { configFile: kimiCfg, configExists: kimiHasFile, defaultModel: kimiDefault, models: kimiModels },
    api: {
      configuredKeyVars,
      configuredBaseVars,
      defaultModel: apiDefault,
      models: apiModels,
    },
  };
}
