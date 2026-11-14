// DSH 设置面板覆盖层读取器（仅在 DSH 宿主或显式开启时生效）。
//
// 跨宿主单一真源原则（v2.0.0）：
//   项目根目录 dispatch/seats.json 是所有宿主（Antigravity / Claude Code / Codex / Cursor / CLI / DSH）
//   共享的单一配置真源。DSH 面板保存在 cordis.patch.yml（id=research-dispatch 条目的 config 段）的覆盖值
//   仅在满足以下任一显式条件时叠加读取（见 isDshPatchActive）：
//     1. 调用方显式传入 opts.useDshPatch === true（如 DSH 宿主插件入口 lib/index.js）
//     2. 显式设置环境变量 DSH_DISPATCH_USE_PATCH=1
//     3. 显式设置环境变量 DSH_DISPATCH_SETTINGS=<设置文件路径>（单测与显式覆盖环境）
//   在终端或其它 Agent 宿主中直接运行 CLI 时绝不暗读 ~/.dsh/profiles/*/cordis.patch.yml。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENTRY_ID = 'research-dispatch';

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function dshRootDir() {
  return String(process.env.DSH_HOME || '').trim() || path.join(homeDir(), '.dsh');
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 解析单行 YAML 标量：支持双引号转义、单引号转义、未加引号行尾 # 注释剥离。
 * 若遇到多行块标量头（| / >- 等），返回对象 { block: '|' | '>' } 供上层收集缩进行。
 */
export function parseScalarValue(rawVal) {
  const trimmed = String(rawVal ?? '').trim();
  if (!trimmed || trimmed === '~' || trimmed === 'null') return '';
  const blockMatch = trimmed.match(/^([|>])[-+0-9]*(?:\s+#.*)?$/);
  if (blockMatch) return { block: blockMatch[1] };

  if (trimmed.startsWith('"')) {
    const m = trimmed.match(/^"((?:\\.|[^"\\])*)"(?:\s+#.*)?$/);
    if (m) {
      const inner = m[1];
      let out = '';
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch !== '\\') { out += ch; continue; }
        i++;
        if (i >= inner.length) break;
        const esc = inner[i];
        if (esc === 'n') out += '\n';
        else if (esc === 'r') out += '\r';
        else if (esc === 't') out += '\t';
        else if (esc === '"') out += '"';
        else if (esc === '\\') out += '\\';
        else if (esc === '/') out += '/';
        else if (esc === 'u' && /^[0-9a-fA-F]{4}$/.test(inner.slice(i + 1, i + 5))) {
          out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 5), 16));
          i += 4;
        } else out += esc;
      }
      return out;
    }
    return trimmed.slice(1).replace(/"$/, '');
  }

  if (trimmed.startsWith("'")) {
    const m = trimmed.match(/^'((?:''|[^'])*)'(?:\s+#.*)?$/);
    if (m) return m[1].replace(/''/g, "'");
    return trimmed.slice(1).replace(/'$/, '');
  }

  // 未加引号标量：仅剥离前面带空白的 `# 注释`（保留紧贴非空白字符的 #，如 URL anchor）
  return trimmed.replace(/\s+#.*$/, '').trim();
}

/**
 * 从 cordis.patch.yml 文本中提取指定 id 条目的扁平 config 键值对象。
 * 兼容任意属性顺序（例如 `- enabled: true` 在前、`  id: <targetId>` 在后，或 `config:` 在 `id:` 之前），
 * 并兼容 js-yaml 对长字符串自动折行的 `>-` / `|-` 块标量。
 *
 * @param {string} text
 * @param {string} targetId
 * @returns {Record<string, string> | null}
 */
export function parseNamedEntryConfig(text, targetId = ENTRY_ID) {
  if (!text) return null;
  const rawLines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines = rawLines.filter((l) => l.trim() && !l.trim().startsWith('#'));

  for (let start = 0; start < lines.length; start++) {
    const headMatch = lines[start].match(/^(\s*)-(?:\s+(.*))?$/);
    if (!headMatch) continue;
    const baseIndent = headMatch[1].length;
    const propIndent = baseIndent + 2;
    const cfgIndent = baseIndent + 4;

    // 收集属于当前列表项的行（后续缩进严格大于 baseIndent 的行）
    const itemLines = [lines[start]];
    for (let j = start + 1; j < lines.length; j++) {
      const lead = lines[j].match(/^(\s*)/)[1].length;
      if (lead <= baseIndent) break;
      itemLines.push(lines[j]);
    }

    let entryId = '';
    let inConfig = false;
    const cfg = {};

    const handleEntryProp = (key, rest) => {
      if (key === 'config') {
        const trimmedRest = rest.trim();
        if (!trimmedRest || trimmedRest.startsWith('#')) {
          inConfig = true;
        } else if (/^\{\s*\}(?:\s+#.*)?$/.test(trimmedRest)) {
          inConfig = false;
        } else {
          inConfig = false;
        }
      } else {
        inConfig = false;
        if (key === 'id') {
          const parsed = parseScalarValue(rest);
          entryId = typeof parsed === 'string' ? parsed : '';
        }
      }
    };

    for (let i = 0; i < itemLines.length; i++) {
      const raw = itemLines[i];
      if (i === 0) {
        const firstRest = (headMatch[2] || '').trim();
        const pm = firstRest.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (pm) handleEntryProp(pm[1], pm[2]);
        continue;
      }

      const lead = raw.match(/^(\s*)/)[1].length;
      const body = raw.slice(lead);

      if (lead === propIndent && !body.startsWith('-')) {
        const pm = body.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (pm) {
          handleEntryProp(pm[1], pm[2]);
          continue;
        }
      }

      if (!inConfig) continue;

      if (lead < cfgIndent) {
        inConfig = false;
        continue;
      }

      if (lead === cfgIndent && !body.startsWith('-')) {
        const km = body.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
        if (km) {
          const k = km[1];
          const parsed = parseScalarValue(km[2]);
          if (parsed && typeof parsed === 'object' && parsed.block) {
            const chunk = [];
            while (i + 1 < itemLines.length && itemLines[i + 1].match(/^(\s*)/)[1].length > cfgIndent) {
              chunk.push(itemLines[i + 1].trim());
              i++;
            }
            cfg[k] = chunk.join(parsed.block === '>' ? ' ' : '\n').trim();
          } else if (parsed === '' && !km[2].trim()) {
            const chunk = [];
            while (i + 1 < itemLines.length && itemLines[i + 1].match(/^(\s*)/)[1].length > cfgIndent) {
              chunk.push(itemLines[i + 1].trim());
              i++;
            }
            cfg[k] = chunk.length ? chunk.join(' ') : '';
          } else {
            cfg[k] = typeof parsed === 'string' ? parsed : '';
          }
        }
      }
    }

    if (entryId === targetId) return cfg;
  }

  return null;
}

/**
 * 从一份 cordis.patch.yml 里取出 research-dispatch 条目 config 的扁平标量。
 * @returns {Record<string, unknown> | null} 没有本条目时返回 null
 */
export function parseEntryConfig(text) {
  return parseNamedEntryConfig(text, ENTRY_ID);
}

/**
 * 判断当前上下文是否允许读取 DSH 设置覆盖层（cordis.patch.yml）。
 * 默认（CLI / Antigravity / Claude Code / Codex / Cursor 等宿主）返回 false，严格以项目 dispatch/seats.json 为单一真源。
 */
export function isDshPatchActive(opts = {}) {
  if (opts && (opts.useDshPatch === true || opts.forceProfileRead === true)) return true;
  if (String(process.env.DSH_DISPATCH_USE_PATCH || '').trim() === '1') return true;
  if (String(process.env.DSH_DISPATCH_SETTINGS || '').trim() !== '') return true;
  return false;
}

function profileCandidates() {
  const explicitFile = String(process.env.DSH_DISPATCH_SETTINGS || '').trim();
  if (explicitFile) return { list: [explicitFile], strict: true };

  const dshDir = dshRootDir();
  const explicitProfile = String(process.env.DSH_PROFILE || '').trim();
  if (explicitProfile) {
    return {
      list: [path.join(dshDir, 'profiles', explicitProfile, 'cordis.patch.yml')],
      strict: true,
    };
  }

  const primary = path.join(dshDir, 'profiles', 'desktop', 'cordis.patch.yml');
  const out = [primary];
  const dir = path.join(dshDir, 'profiles');
  try {
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d, 'cordis.patch.yml');
      if (p !== primary) out.push(p);
    }
  } catch { /* 没有 profiles 目录：只剩 primary */ }
  return { list: out, strict: false };
}

/**
 * 读取面板写入的覆盖值（未激活 DSH patch 作用域时直接返回空覆盖）。
 * @param {{ useDshPatch?: boolean, forceProfileRead?: boolean }} [opts]
 * @returns {{ source: string|null, config: Record<string, unknown> }}
 */
export function readDshOverrides(opts = {}) {
  if (!isDshPatchActive(opts)) {
    return { source: null, config: {} };
  }
  const { list: cands, strict } = profileCandidates();
  if (strict) {
    const p = cands[0];
    const text = p ? readText(p) : null;
    if (text === null) return { source: null, config: {} };
    const cfg = parseEntryConfig(text);
    return cfg ? { source: p, config: cfg } : { source: null, config: {} };
  }

  let best = null;
  for (const p of cands) {
    const text = readText(p);
    if (text === null) continue;
    const cfg = parseEntryConfig(text);
    if (!cfg) continue;
    if (p === cands[0]) return { source: p, config: cfg };
    try {
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { m, source: p, config: cfg };
    } catch {
      best = best || { m: 0, source: p, config: cfg };
    }
  }
  return best ? { source: best.source, config: best.config } : { source: null, config: {} };
}

/** 该字段是否被面板显式覆盖（空串视为"不覆盖"）。 */
export function overrideOf(config, key) {
  const v = config ? config[key] : undefined;
  if (v === undefined || v === null) return '';
  return String(v).trim();
}
