// DSH 设置面板写下的值 —— CLI 侧的唯一读法。
//
// 为什么 CLI 要读这一层：设置卡片保存的是 **DSH 设置文档**（profile 的 cordis.patch.yml
// 里 id=research-dispatch 那条 entry 的 config）。而 CLI 是 bash 起的独立进程，它看不到
// DSH 的内存状态。若只读 dispatch/seats.json，就会出现「面板改了、CLI 没变」——
// 除非面板保存后插件恰好被重新挂载。所以这里把"DHS 写下的事实"读出来，作为最高优先级的
// 覆盖层；seats.json 退为"没有 DSH 时的默认值"。
//
// 读取位置（按优先级）：
//   1. 环境变量 DSH_DISPATCH_SETTINGS 指向的 cordis.patch.yml（测试与多 profile 用）
//   2. $HOME/.dsh/profiles/<DSH_PROFILE 或 desktop>/cordis.patch.yml
//   3. $HOME/.dsh/profiles/*/cordis.patch.yml 里最近修改、且含本条目的一份
//
// 只解析我们自己的那一条 entry 的 config，且只认扁平标量（defaultBackends / reviewVotes /
// divergeModel 都是标量）。不是通用 YAML 解析器，也不打算是 —— 通用解析器要依赖，
// 而这道闸门不该为一个面板引入依赖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENTRY_ID = 'research-dispatch';

function homeDir() {
  return process.env.HOME || os.homedir();
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 从一份 cordis.patch.yml 里取出本条目 config 的扁平标量。
 * @returns {Record<string, unknown> | null} 没有本条目时返回 null
 */
export function parseEntryConfig(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  let inEntry = false;
  let inConfig = false;
  let found = false;
  const cfg = {};
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    // 新的 entry 头（列 0 的 "- "）
    if (/^-\s/.test(raw)) {
      const idm = raw.match(/^-\s+id:\s*(.+)$/);
      // 与 models.mjs 同一类：行尾注释（`- id: research-dispatch # xxx`）不是 id 的一部分，
      // 不剥掉就会判成"本命名空间未注册"，表现是设置页说"连不上/没有可编辑项"。
      const entryId = idm ? idm[1].trim().replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '') : '';
      inEntry = entryId === ENTRY_ID;
      inConfig = false;
      if (inEntry) found = true;
      continue;
    }
    if (!inEntry) continue;
    if (/^\s{2}config:\s*$/.test(raw)) { inConfig = true; continue; }
    if (inConfig) {
      const m = raw.match(/^\s{4}([A-Za-z_][\w-]*):\s*(.*)$/);
      if (m) {
        let v = m[2].trim();
        if (v === '' || v === '""' || v === "''") v = '';
        else v = v.replace(/^['"]|['"]$/g, '');
        cfg[m[1]] = v;
        continue;
      }
      // 缩进退回到 2 格 = config 段结束
      if (/^\s{0,2}\S/.test(raw)) inConfig = false;
    }
  }
  return found ? cfg : null;
}

function profileCandidates() {
  const home = homeDir();
  const explicit = process.env.DSH_DISPATCH_SETTINGS;
  if (explicit) return [explicit];
  const named = process.env.DSH_PROFILE || 'desktop';
  const primary = path.join(home, '.dsh', 'profiles', named, 'cordis.patch.yml');
  const out = [primary];
  const dir = path.join(home, '.dsh', 'profiles');
  try {
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d, 'cordis.patch.yml');
      if (p !== primary) out.push(p);
    }
  } catch { /* 没有 profiles 目录：只剩 primary */ }
  return out;
}

/**
 * 读取面板写入的覆盖值。
 * @returns {{ source: string|null, config: Record<string, unknown> }}
 */
export function readDshOverrides() {
  const cands = profileCandidates();
  let best = null;
  for (const p of cands) {
    const text = readText(p);
    if (text === null) continue;
    const cfg = parseEntryConfig(text);
    if (!cfg) continue;
    if (p === cands[0]) return { source: p, config: cfg };
    // 其余 profile 里只有一份含本条目时也认，取最近修改的
    try {
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { m, source: p, config: cfg };
    } catch { best = best || { m: 0, source: p, config: cfg }; }
  }
  return best ? { source: best.source, config: best.config } : { source: null, config: {} };
}

/** 该字段是否被面板显式覆盖（空串视为"不覆盖"）。 */
export function overrideOf(config, key) {
  const v = config ? config[key] : undefined;
  if (v === undefined || v === null) return '';
  return String(v).trim();
}
