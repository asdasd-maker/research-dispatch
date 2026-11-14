// 评审位与发散位"当前生效模型身份"的单一解析与本机模型探测实现。
//
// 模型身份有两个核心消费方：
//   1. 派工（写卡片 meta 头并记录模型先验）；
//   2. 发散与阵容发现（判断发散位是否与评审位同族、自动发现本机已安装 Agent 的可用模型）。
// 两端共享同一份解析与归一化逻辑，防止配置格式演进导致判据静默漂移。
//
// 支持的环境变量：
//   CODEX_CFG / CLAUDE_CFG / GEMINI_CFG / KIMI_CFG / DSH_SETTINGS   覆盖默认配置文件路径
//   CODEX_MODEL / CLAUDE_MODEL / GEMINI_MODEL / KIMI_MODEL / DSH_MODEL  显式模型名（走 -explicit 分支）
//   QODER_SEAT_MODEL / QODER_ATTEST_SHA                             自报座位模型与 payload 绑定指纹
//   MANUAL<N>_MODEL / MANUAL<N>_SHA                                 署名票模型与 payload 绑定指纹
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

/**
 * Gemini CLI 模型身份解析：兼容 settings.json 中 `"model": "gemini-2.5-pro"` 与嵌套对象 `"model": { "name": "..." }`。
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

  if (!mdl) return '';
  return mdl.includes('/') ? mdl : (prov || '?') + '/' + mdl;
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
    const prov = String(cfg.provider || '').trim();
    const mdl = String(cfg.model || '').trim();
    if (!mdl) continue;
    return mdl.includes('/') ? mdl : (prov || '?') + '/' + mdl;
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

function collectDshStorageModels(node, out, depth, provPrefix) {
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
      collectDshStorageModels(item, out, depth + 1, provPrefix);
    }
    return;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) collectDshStorageModels(v, out, depth + 1, provPrefix);
  }
}

function readDshCatalogModels() {
  const out = [];
  const dir = path.join(dshRootDir(), 'storages');
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
        const stem = f.replace(/\.json$/, '')
          .replace(/-(models|prod-catalog|intl-catalog|cn-catalog|global-catalog|[a-z]*-catalog)$/, '')
          .replace(/-(intl|prod|cn|global)$/, '');
        collectDshStorageModels(j, out, 0, stem);
        if (Array.isArray(j.enabledModelIds) && j.enabledModelIds.length > 0) {
          const allow = new Set(j.enabledModelIds.map(String));
          for (let i = out.length - 1; i >= before; i--) if (!allow.has(out[i])) out.splice(i, 1);
        }
        if (Array.isArray(j.hiddenModels) && j.hiddenModels.length > 0) {
          const deny = new Set(j.hiddenModels.map(String));
          for (let i = out.length - 1; i >= before; i--) if (deny.has(out[i])) out.splice(i, 1);
        }
      } catch { /* 单文件损坏忽略 */ }
    }
  } catch { /* 无 storages 目录 */ }
  return [...new Set(out)];
}

/**
 * 静默探测本机各 Agent 配置文件与常见 API 环境变量中的默认模型与候选模型列表（零报错、绝不泄露密钥明文）。
 */
export function probeAgentModelsFromConfigs() {
  const pushUniq = (arr, v) => {
    const s = String(v || '').trim();
    if (s && s !== 'unknown-check-config' && !arr.includes(s)) arr.push(s);
  };

  // 1) codex (~/.codex/config.toml 顶层 model 与 [profiles.*] 下的 model)
  const codexCfg = expandHome(process.env.CODEX_CFG || '~/.codex/config.toml');
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
        const m = trimmed.match(/^model\s*=\s*"([^"]+)"/);
        if (m && m[1]) {
          if (!inSubTable && !codexDefault) codexDefault = m[1].trim();
          pushUniq(codexModels, m[1]);
        }
      }
    }
  } catch { /* 无 codex 配置 */ }

  // 2) claude (~/.claude/settings.json)
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
          const envObj = parsed.env && typeof parsed.env === 'object' ? parsed.env : {};
          const primary = envObj.ANTHROPIC_MODEL || parsed.model || '';
          if (typeof primary === 'string' && primary.trim() && !claudeDefault) {
            claudeDefault = primary.trim();
          }
          pushUniq(claudeModels, primary);
          pushUniq(claudeModels, parsed.model);
          for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
            if (typeof envObj[k] === 'string') pushUniq(claudeModels, envObj[k]);
          }
          if (Array.isArray(parsed.availableModels)) {
            for (const m of parsed.availableModels) {
              if (typeof m === 'string') pushUniq(claudeModels, m);
              else if (m && typeof m === 'object') pushUniq(claudeModels, m.id || m.name || m.model);
            }
          }
        }
      } catch {
        const v = grepLastCut(claudeCfg, '"(ANTHROPIC_MODEL|model)"\\s*:\\s*"[^"]*"', 4);
        if (v && !claudeDefault) claudeDefault = v;
        pushUniq(claudeModels, v);
      }
    }
  } catch { /* 无 claude 配置 */ }

  // 3) dsh (~/.dsh/settings.yaml / profiles / storages)
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

  // 4) gemini (~/.gemini/settings.json)
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

  // 5) kimi (~/.kimi/config.toml)
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
        const secMatch = trimmed.match(/^\[models\.([^\]]+)\]/);
        if (secMatch && secMatch[1]) {
          inSubTable = true;
          pushUniq(kimiModels, secMatch[1].replace(/^["']|["']$/g, ''));
          continue;
        }
        if (/^\[.+\]/.test(trimmed)) {
          inSubTable = true;
          continue;
        }
        const dm = trimmed.match(/^(?:default_model|model)\s*=\s*"([^"]+)"/);
        if (dm && dm[1]) {
          if (!inSubTable && !kimiDefault) kimiDefault = dm[1].trim();
          pushUniq(kimiModels, dm[1]);
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
