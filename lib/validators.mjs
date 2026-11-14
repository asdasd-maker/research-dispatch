// 纯 Node 内置校验、课题汇总与轻量执行组件（零第三方依赖，Node >= 20）。
//
// 提供独立运行与全链路闭环所需的七项核心能力：
//   1. checkAnchor         —— 基线锚点（REPRO.md 复现值与人工签字）校验
//   2. extractCardVerdict  —— 仅从卡片最后一个 YAML 块做结构化解析提取 verdict
//   3. checkCardFile       —— 评审卡片结构、分值类型、反占位符与尾部散文校验
//   4. scanPendingVerdicts —— 待裁决 / 未汇总 / 无产出 / 未派工孤儿单 / 证据漂移扫描（支持多课题）
//   5. summarizeTopic      —— 跨工单横向对比 Markdown 总表生成（_summary.md）
//   6. maskSecrets         —— 错误日志与诊断文本中的 API 密钥脱敏
//   7. apiChatCompletion   —— 基于原生 fetch 的 OpenAI 兼容 /chat/completions 调用
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIMS = ['novelty', 'feasibility', 'baseline_fit', 'impl_cost', 'expected_gain'];
const VERDICTS = new Set(['go', 'revise', 'kill']);
const PLACEHOLDERS = new Set([
  'todo', 'tbd', 'n/a', 'na', 'none', 'null', '同上', '同前', '略', '无',
  '-', '?', '待补', '待定', '占位',
]);
const PUNCT_RE = /[\s\-—_.,，。:：;；/\\|()（）[\]【】*、…！!?？~]+/g;
const RESERVED_IDEAS_SUBDIRS = new Set(['briefs', 'cards', 'archive', 'stale', 'rejected', '.superseded']);

// ── 1. 敏感凭据脱敏 ─────────────────────────────────────────────────────────
export function maskSecrets(text) {
  let s = String(text ?? '');
  if (!s) return s;
  s = s.replace(/Bearer\s+[^\s"',;)\]}]+/gi, 'Bearer [REDACTED]');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  s = s.replace(/\b(?:rk|pk|ak)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
  s = s.replace(/((?:api[_-]?key|x-api-key|access[_-]?token|authorization)["'\s:=]+)[^\s"',;)\]}]{8,}/gi, '$1[REDACTED]');
  s = s.replace(/(https?:\/\/[^/\s:@]+:)[^/\s@]+(@)/gi, '$1[REDACTED]$2');
  return s;
}

// ── 路径边界校验（大小写盘符兼容 + 真实路径防软链/目录联接越界）──────────────
export function isInsideRoot(rootDir, targetPath) {
  const base = path.resolve(String(rootDir || '.'));
  const target = path.resolve(targetPath);
  const norm = (p) => {
    const clean = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? clean.toLowerCase() : clean;
  };
  const nb = norm(base);
  const nt = norm(target);
  if (nt !== nb && !nt.startsWith(nb + path.sep)) return false;

  // 对已存在的最长祖先路径做 realpath 校验，阻断指向仓外的软链或 Junction
  if (fs.existsSync(base)) {
    let probe = target;
    while (probe && !fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    if (probe && fs.existsSync(probe)) {
      try {
        const rb = norm(fs.realpathSync(base));
        const rp = norm(fs.realpathSync(probe));
        if (rp !== rb && !rp.startsWith(rb + path.sep)) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

function parseNums(s) {
  const m = String(s || '').match(/-?\d+(?:\.\d+)?/g);
  return m ? m.map(Number).filter(Number.isFinite) : [];
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── 2. 锚点校验（对齐 anchor_check 退出码契约：0 通过 / 1 未签字或数值不符 / 2 越界或格式损坏 / 4 缺失）──
export function checkAnchor(rootDir, anchorRel, { briefId = '', calibration = false } = {}) {
  if (calibration && /^(?:smoke|calib)_/.test(String(briefId || ''))) {
    return {
      ok: true,
      rc: 0,
      stdout: '== [calibration] smoke 工单豁免锚点签字检查\n',
      stderr: '',
    };
  }

  const rawRel = String(anchorRel ?? '').trim();
  if (!rawRel || rawRel === 'none') {
    return {
      ok: true,
      rc: 0,
      stdout: '== 无锚点独立工单\n',
      stderr: '',
    };
  }

  const base = path.resolve(String(rootDir || '.'));
  if (path.isAbsolute(rawRel) && !isInsideRoot(base, rawRel)) {
    const msg = '!! 锚点路径越出仓库根：' + rawRel + '\n';
    return { ok: false, rc: 2, stdout: msg, stderr: msg };
  }

  const directDir = path.resolve(base, rawRel);
  if (!isInsideRoot(base, directDir)) {
    const msg = '!! 锚点路径越出仓库根：' + rawRel + '\n';
    return { ok: false, rc: 2, stdout: msg, stderr: msg };
  }

  let anchorDir = directDir;
  if (!fs.existsSync(anchorDir) && !/^baselines[\\/]/i.test(rawRel)) {
    const alt = path.resolve(base, 'baselines', rawRel);
    if (isInsideRoot(base, alt) && fs.existsSync(alt)) anchorDir = alt;
  }
  if (!isInsideRoot(base, anchorDir)) {
    const msg = '!! 锚点路径越出仓库根：' + rawRel + '\n';
    return { ok: false, rc: 2, stdout: msg, stderr: msg };
  }

  let dirStat = null;
  try {
    dirStat = fs.statSync(anchorDir);
  } catch {
    dirStat = null;
  }
  if (!dirStat || !dirStat.isDirectory()) {
    const msg = '!! ' + rawRel + ' 不存在 —— 锚点路径写错或被截断，不是"还没复现"\n';
    return { ok: false, rc: 4, stdout: msg, stderr: msg };
  }

  const reproPath = path.join(anchorDir, 'REPRO.md');
  if (!isInsideRoot(base, reproPath)) {
    const msg = '!! REPRO.md 软链越出仓库根：' + rawRel + '\n';
    return { ok: false, rc: 2, stdout: msg, stderr: msg };
  }
  let reproStat = null;
  try {
    reproStat = fs.statSync(reproPath);
  } catch {
    reproStat = null;
  }
  if (!reproStat || !reproStat.isFile()) {
    const msg = '!! 找不到 ' + rawRel + '/REPRO.md —— 这个 baseline 还没复现证据，不能当锚点\n';
    return { ok: false, rc: 4, stdout: msg, stderr: msg };
  }

  let reproText = '';
  try {
    reproText = fs.readFileSync(reproPath, 'utf8');
  } catch (e) {
    const msg = '!! 无法读取 ' + rawRel + '/REPRO.md：' + ((e && e.message) || e) + '\n';
    return { ok: false, rc: 2, stdout: msg, stderr: msg };
  }

  const lines = reproText.split(/\r?\n/);
  let s3Start = -1;
  let s4Start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (s3Start < 0 && /^##\s*(?:§\s*)?3(?:\.|\b)/.test(lines[i])) s3Start = i;
    else if (s3Start >= 0 && s4Start < 0 && /^##\s*(?:§\s*)?4(?:\.|\b)/.test(lines[i])) s4Start = i;
  }
  if (s3Start < 0) {
    const msg = '!! ' + rawRel + '/REPRO.md 格式损坏：缺少 "## 3." 关键指标章节\n';
    return { ok: false, rc: 2, stdout: msg, stderr: msg };
  }

  const s3Lines = lines.slice(s3Start, s4Start >= 0 ? s4Start : lines.length);
  let headerParsed = false;
  let mineCol = -1;
  let dupMineCol = false;
  let tolCol = -1;
  const pairs = [];

  for (const rawLine of s3Lines) {
    if (!/^\s*\|/.test(rawLine)) continue;
    const cells = rawLine.split('|');
    if (!headerParsed) {
      for (let i = 0; i < cells.length; i++) {
        const key = cells[i].replace(/[\s\u3000]+/g, '');
        if (key === '我复现') {
          if (mineCol >= 0) dupMineCol = true;
          else mineCol = i;
        }
        if (key === '容差') tolCol = i;
      }
      headerParsed = true;
      continue;
    }
    if (rawLine.replace(/[|:\s-]+/g, '') === '') continue;
    const metric = (cells[1] || '').replace(/[\s\u3000]+/g, '');
    if (!metric || metric.toLowerCase() === 'metric') continue;
    const mine = mineCol >= 0 ? (cells[mineCol] || '').replace(/[\s\u3000]+/g, '') : '';
    const tol = tolCol >= 0 ? (cells[tolCol] || '').replace(/[\s\u3000]+/g, '') : '';
    pairs.push({ metric, mine, tol });
  }

  if (!headerParsed || mineCol < 0) {
    const msg = '!! ' + rawRel + '/REPRO.md 格式损坏：§3 缺少包含「我复现」列的指标表格\n';
    return { ok: false, rc: 2, stdout: msg, stderr: msg };
  }
  if (dupMineCol) {
    const msg = '!! ' + rawRel + '/REPRO.md 格式损坏：§3 表头存在重复的「我复现」列\n';
    return { ok: false, rc: 2, stdout: msg, stderr: msg };
  }

  const numericPairs = pairs.filter((p) => /\d/.test(p.mine) && parseNums(p.mine).length > 0);
  if (numericPairs.length === 0) {
    const msg = '!! ' + rawRel + '/REPRO.md §3 的「我复现」列没有任何数值 —— 尚未完成基线复现\n';
    return { ok: false, rc: 1, stdout: msg, stderr: msg };
  }

  const signoffSlice = s4Start >= 0 ? lines.slice(s4Start).join('\n') : reproText;
  if (!/^[ \t]*SIGNOFF:[ \t]*PASS(?:\b|\s|$)/m.test(signoffSlice)) {
    const msg = '!! ' + rawRel + '/REPRO.md §4 未见 "SIGNOFF: PASS" —— 未签字的基线不得用于评审\n';
    return { ok: false, rc: 1, stdout: msg, stderr: msg };
  }

  // 若存在 BRIEF_BLOCK.md，核对指标复现值与容差一致性
  const bbPath = path.join(anchorDir, 'BRIEF_BLOCK.md');
  if (fs.existsSync(bbPath) && isInsideRoot(base, bbPath)) {
    let bbText = '';
    try {
      bbText = fs.readFileSync(bbPath, 'utf8');
    } catch (e) {
      const msg = '!! 无法读取 BRIEF_BLOCK.md：' + ((e && e.message) || e) + '\n';
      return { ok: false, rc: 2, stdout: msg, stderr: msg };
    }
    const bbLines = bbText.split(/\r?\n/);
    for (const p of numericPairs) {
      const val = parseNums(p.mine)[0];
      const tolNums = parseNums(p.tol);
      const tolerance = tolNums.length > 0 ? Math.abs(tolNums[0]) : 1e-9;
      const metricCompact = p.metric.toLowerCase();
      const named = bbLines.filter((l) => l.replace(/[\s\u3000]+/g, '').toLowerCase().includes(metricCompact));
      let matched = false;
      for (const l of named) {
        const cands = parseNums(l);
        if (cands.some((c) => Math.abs(c - val) <= tolerance)) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        const normVal = Number(val.toFixed(6)).toString();
        const wordRe = new RegExp('(?<![0-9.])' + escapeRegExp(normVal) + '(?![0-9.])');
        if (wordRe.test(bbText) || parseNums(bbText).some((c) => Math.abs(c - val) <= 1e-6)) {
          matched = true;
        }
      }
      if (!matched) {
        const msg = '!! BRIEF_BLOCK.md 与 REPRO.md 的锚点数值不一致：metric「' + p.metric + '」（复现值 ' + val + '）\n';
        return { ok: false, rc: 1, stdout: msg, stderr: msg };
      }
    }
  }

  return {
    ok: true,
    rc: 0,
    stdout: '✓ ' + rawRel + ' 锚点就绪：REPRO.md §3 有复现值、§4 已签字\n',
    stderr: '',
  };
}

// ── 纯 Node 严谨 YAML 子集解析器（支持常规映射、单双引号、# 注释、|/> 块标量、列表、流式 {} / []）──
function stripInlineComment(raw) {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inSingle) {
      if (ch === "'" && raw[i + 1] === "'") { i++; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '{' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ']') { if (depth > 0) depth--; continue; }
    if (ch === '#' && depth === 0 && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i).trimEnd();
    }
  }
  if (inSingle || inDouble) throw new SyntaxError('YAML 字符串引号未闭合');
  if (depth !== 0) throw new SyntaxError('YAML 流式括号未闭合');
  return raw.trimEnd();
}

function unquoteDouble(inner) {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') { out += ch; continue; }
    i++;
    if (i >= inner.length) throw new SyntaxError('YAML 转义序列不完整');
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

function splitTopLevel(text, sepChar) {
  const parts = [];
  let start = 0;
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'" && text[i + 1] === "'") { i++; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '{' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth < 0) throw new SyntaxError('YAML 括号不匹配');
      continue;
    }
    if (ch === sepChar && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (inSingle || inDouble) throw new SyntaxError('YAML 引号未闭合');
  if (depth !== 0) throw new SyntaxError('YAML 流式结构未闭合');
  parts.push(text.slice(start));
  return parts;
}

function findMappingColon(line, allowCompact = false) {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'" && line[i + 1] === "'") { i++; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '{' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ']') { if (depth > 0) depth--; continue; }
    if (ch === ':' && depth === 0) {
      const next = line[i + 1];
      if (next === undefined || /\s/.test(next) || (allowCompact && !/[/:\\]/.test(next))) {
        return i;
      }
    }
  }
  return -1;
}

function parseKeyToken(rawKey) {
  const k = rawKey.trim();
  if (!k) throw new SyntaxError('YAML 映射键名为空');
  if (k.startsWith('"') && k.endsWith('"') && k.length >= 2) return unquoteDouble(k.slice(1, -1));
  if (k.startsWith("'") && k.endsWith("'") && k.length >= 2) return k.slice(1, -1).replace(/''/g, "'");
  return k;
}

function parseFlowMapping(inner) {
  const obj = {};
  const trimmed = inner.trim();
  if (!trimmed) return obj;
  const entries = splitTopLevel(trimmed, ',');
  for (const rawEntry of entries) {
    const entry = stripInlineComment(rawEntry).trim();
    if (!entry) continue;
    const colonIdx = findMappingColon(entry, true);
    if (colonIdx < 0) throw new SyntaxError('YAML 流式映射缺少冒号: ' + entry);
    const key = parseKeyToken(entry.slice(0, colonIdx));
    const valStr = entry.slice(colonIdx + 1).trim();
    obj[key] = parseInlineValue(valStr);
  }
  return obj;
}

function parseFlowSequence(inner) {
  const arr = [];
  const trimmed = inner.trim();
  if (!trimmed) return arr;
  const items = splitTopLevel(trimmed, ',');
  for (const rawItem of items) {
    const item = stripInlineComment(rawItem).trim();
    if (!item && items.length > 1 && rawItem.trim() === '') continue;
    arr.push(parseInlineValue(item));
  }
  return arr;
}

function parseInlineValue(rawVal) {
  const cleaned = stripInlineComment(rawVal).trim();
  if (cleaned === '' || /^(?:null|~)$/i.test(cleaned)) return null;
  if (cleaned.startsWith('{')) {
    if (!cleaned.endsWith('}')) throw new SyntaxError('YAML 流式对象未闭合');
    return parseFlowMapping(cleaned.slice(1, -1));
  }
  if (cleaned.startsWith('[')) {
    if (!cleaned.endsWith(']')) throw new SyntaxError('YAML 流式数组未闭合');
    return parseFlowSequence(cleaned.slice(1, -1));
  }
  if (cleaned.startsWith('"')) {
    if (cleaned.length < 2 || !cleaned.endsWith('"')) throw new SyntaxError('YAML 双引号未闭合');
    return unquoteDouble(cleaned.slice(1, -1));
  }
  if (cleaned.startsWith("'")) {
    if (cleaned.length < 2 || !cleaned.endsWith("'")) throw new SyntaxError('YAML 单引号未闭合');
    return cleaned.slice(1, -1).replace(/''/g, "'");
  }
  if (/^(?:true|yes|on)$/i.test(cleaned)) return true;
  if (/^(?:false|no|off)$/i.test(cleaned)) return false;
  if (/^-?(?:0|[1-9]\d*)$/.test(cleaned)) {
    const n = Number(cleaned);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?(?:(?:0|[1-9]\d*)\.\d+|\.\d+)(?:[eE][+-]?\d+)?$/.test(cleaned) || /^-?(?:0|[1-9]\d*)[eE][+-]?\d+$/.test(cleaned)) {
    const f = Number(cleaned);
    if (Number.isFinite(f)) return f;
  }
  return cleaned;
}

function indentOf(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  if (line[n] === '\t') throw new SyntaxError('YAML 缩进不允许使用 Tab 字符');
  return n;
}

function isIgnorableLine(line) {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

function nextMeaningfulIdx(lines, fromIdx) {
  let i = fromIdx;
  while (i < lines.length && isIgnorableLine(lines[i])) i++;
  return i;
}

// 若流式 { 或 [ 跨越多行，合并直到括号闭合
function consumeMultilineFlow(lines, startIdx, initialText) {
  let combined = stripInlineComment(initialText);
  let idx = startIdx;
  const checkBalanced = (s) => {
    let inS = false;
    let inD = false;
    let d = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inS) { if (ch === "'" && s[i + 1] === "'") { i++; continue; } if (ch === "'") inS = false; continue; }
      if (inD) { if (ch === '\\') { i++; continue; } if (ch === '"') inD = false; continue; }
      if (ch === "'") { inS = true; continue; }
      if (ch === '"') { inD = true; continue; }
      if (ch === '{' || ch === '[') d++;
      else if (ch === '}' || ch === ']') d--;
    }
    return !inS && !inD && d === 0;
  };
  while (!checkBalanced(combined)) {
    idx++;
    if (idx >= lines.length) throw new SyntaxError('跨行流式 YAML 结构未闭合');
    if (isIgnorableLine(lines[idx])) continue;
    combined += ' ' + stripInlineComment(lines[idx].trim());
  }
  return { value: parseInlineValue(combined), nextIdx: idx + 1 };
}

function parseBlockScalar(lines, startIdx, parentIndent, header) {
  const m = header.match(/^([|>])(?:([+-])(\d+)?|(\d+)?([+-])?)\s*(?:#.*)?$/);
  if (!m) throw new SyntaxError('非法的块标量头: ' + header);
  const style = m[1];
  const chomp = m[2] || m[5] || '';
  const explicitIndent = m[3] || m[4] ? Number(m[3] || m[4]) : 0;

  const rawChunk = [];
  let idx = startIdx;
  let contentIndent = explicitIndent > 0 ? parentIndent + explicitIndent : -1;

  while (idx < lines.length) {
    const line = lines[idx];
    if (line.trim() === '') {
      rawChunk.push({ empty: true, raw: line });
      idx++;
      continue;
    }
    const ind = indentOf(line);
    if (ind <= parentIndent) break;
    if (contentIndent < 0) contentIndent = ind;
    if (ind < contentIndent) break;
    rawChunk.push({ empty: false, text: line.slice(contentIndent) });
    idx++;
  }

  if (contentIndent < 0) return { value: '', nextIdx: idx };
  const stripped = rawChunk.map((item) => (item.empty ? '' : item.text));
  let trailingEmpty = 0;
  while (stripped.length > 0 && stripped[stripped.length - 1] === '') {
    stripped.pop();
    trailingEmpty++;
  }

  let body = '';
  if (style === '|') {
    body = stripped.join('\n');
  } else {
    const parts = [];
    for (let i = 0; i < stripped.length; i++) {
      const cur = stripped[i];
      if (cur === '') {
        parts.push('\n');
      } else if (parts.length === 0 || parts[parts.length - 1] === '\n') {
        parts.push(cur);
      } else {
        parts.push(' ' + cur);
      }
    }
    body = parts.join('');
  }

  if (chomp === '-') {
    // 去尾换行
  } else if (chomp === '+') {
    body += '\n'.repeat(trailingEmpty + 1);
  } else if (body.length > 0) {
    body += '\n';
  }
  return { value: body, nextIdx: idx };
}

function parseBlockSequence(lines, startIdx, seqIndent) {
  const arr = [];
  let idx = startIdx;
  while (idx < lines.length) {
    idx = nextMeaningfulIdx(lines, idx);
    if (idx >= lines.length) break;
    const line = lines[idx];
    const ind = indentOf(line);
    if (ind < seqIndent) break;
    if (ind > seqIndent) throw new SyntaxError('YAML 列表缩进不一致');
    const rest = line.slice(seqIndent);
    if (!(rest === '-' || rest.startsWith('- ') || rest.startsWith('-\t'))) break;
    const afterDash = rest.slice(1).trim();
    if (!afterDash) {
      const nextIdx = nextMeaningfulIdx(lines, idx + 1);
      if (nextIdx >= lines.length || indentOf(lines[nextIdx]) <= seqIndent) {
        arr.push(null);
        idx = nextIdx;
      } else {
        const childRes = parseBlockNode(lines, nextIdx, indentOf(lines[nextIdx]));
        arr.push(childRes.value);
        idx = childRes.nextIdx;
      }
      continue;
    }
    if (afterDash.startsWith('{') || afterDash.startsWith('[')) {
      const flowRes = consumeMultilineFlow(lines, idx, afterDash);
      arr.push(flowRes.value);
      idx = flowRes.nextIdx;
      continue;
    }
    const colonIdx = findMappingColon(afterDash, false);
    if (colonIdx >= 0) {
      const virtualIndent = seqIndent + 2;
      const virtualFirst = ' '.repeat(virtualIndent) + afterDash;
      const cloned = lines.slice();
      cloned[idx] = virtualFirst;
      const subRes = parseBlockMapping(cloned, idx, virtualIndent);
      arr.push(subRes.value);
      idx = subRes.nextIdx;
      continue;
    }
    arr.push(parseInlineValue(afterDash));
    idx++;
  }
  return { value: arr, nextIdx: idx };
}

function parseBlockMapping(lines, startIdx, mapIndent) {
  const obj = {};
  let idx = startIdx;
  while (idx < lines.length) {
    idx = nextMeaningfulIdx(lines, idx);
    if (idx >= lines.length) break;
    const line = lines[idx];
    const ind = indentOf(line);
    if (ind < mapIndent) break;
    if (ind > mapIndent) throw new SyntaxError('YAML 映射缩进异常: ' + line.trim());

    const content = line.slice(mapIndent);
    if (content === '-' || content.startsWith('- ')) {
      throw new SyntaxError('YAML 映射层出现未归属列表项: ' + content);
    }
    const colonIdx = findMappingColon(content, false);
    if (colonIdx < 0) {
      throw new SyntaxError('YAML 映射行缺少合法键值冒号: ' + content);
    }

    const key = parseKeyToken(content.slice(0, colonIdx));
    const rawRest = content.slice(colonIdx + 1).trim();

    if (!rawRest || rawRest.startsWith('#')) {
      const nextIdx = nextMeaningfulIdx(lines, idx + 1);
      if (nextIdx >= lines.length) {
        obj[key] = null;
        idx = nextIdx;
        continue;
      }
      const nextInd = indentOf(lines[nextIdx]);
      const nextTrim = lines[nextIdx].slice(nextInd);
      const isSeqAtSameIndent = nextInd === mapIndent && (nextTrim === '-' || nextTrim.startsWith('- '));
      if (nextInd > mapIndent || isSeqAtSameIndent) {
        const childRes = isSeqAtSameIndent
          ? parseBlockSequence(lines, nextIdx, nextInd)
          : parseBlockNode(lines, nextIdx, nextInd);
        obj[key] = childRes.value;
        idx = childRes.nextIdx;
      } else {
        obj[key] = null;
        idx = nextIdx;
      }
      continue;
    }

    if (/^[|>](?:[+-]|\d|$|\s|#)/.test(rawRest)) {
      const bs = parseBlockScalar(lines, idx + 1, mapIndent, rawRest);
      obj[key] = bs.value;
      idx = bs.nextIdx;
      continue;
    }

    if (rawRest.startsWith('{') || rawRest.startsWith('[')) {
      const flowRes = consumeMultilineFlow(lines, idx, rawRest);
      obj[key] = flowRes.value;
      idx = flowRes.nextIdx;
      continue;
    }

    obj[key] = parseInlineValue(rawRest);
    idx++;
  }
  return { value: obj, nextIdx: idx };
}

function parseBlockNode(lines, startIdx, baseIndent) {
  const rest = lines[startIdx].slice(baseIndent);
  if (rest === '-' || rest.startsWith('- ')) {
    return parseBlockSequence(lines, startIdx, baseIndent);
  }
  return parseBlockMapping(lines, startIdx, baseIndent);
}

function dedentBlock(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  let minPad = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const pad = l.match(/^ */)[0].length;
    if (pad < minPad) minPad = pad;
  }
  if (!Number.isFinite(minPad) || minPad === 0) return lines;
  return lines.map((l) => (l.length >= minPad ? l.slice(minPad) : l.trimStart()));
}

export function parseYamlCardMapping(yamlText) {
  const lines = dedentBlock(yamlText);
  let firstIdx = nextMeaningfulIdx(lines, 0);
  if (firstIdx < lines.length && /^---(?:\s+#.*|\s*)$/.test(lines[firstIdx].trim())) {
    firstIdx = nextMeaningfulIdx(lines, firstIdx + 1);
  }
  for (let k = lines.length - 1; k >= firstIdx; k--) {
    if (isIgnorableLine(lines[k])) continue;
    if (/^\.\.\.(?:\s+#.*|\s*)$/.test(lines[k].trim())) lines[k] = '';
    break;
  }
  if (firstIdx >= lines.length) throw new SyntaxError('YAML 内容为空');

  const firstTrim = lines[firstIdx].trim();
  if (firstTrim.startsWith('{')) {
    const flowRes = consumeMultilineFlow(lines, firstIdx, firstTrim);
    const trailing = nextMeaningfulIdx(lines, flowRes.nextIdx);
    if (trailing < lines.length) {
      throw new SyntaxError('流式 YAML 映射之后存在多余内容: ' + lines[trailing].trim());
    }
    if (!flowRes.value || typeof flowRes.value !== 'object' || Array.isArray(flowRes.value)) {
      throw new SyntaxError('YAML 根节点不是对象映射');
    }
    return flowRes.value;
  }

  const baseIndent = indentOf(lines[firstIdx]);
  const res = parseBlockMapping(lines, firstIdx, baseIndent);
  const trailing = nextMeaningfulIdx(lines, res.nextIdx);
  if (trailing < lines.length) {
    throw new SyntaxError('YAML 块未完全解析，停在第 ' + (trailing + 1) + ' 行: ' + lines[trailing].trim());
  }
  if (!res.value || typeof res.value !== 'object' || Array.isArray(res.value)) {
    throw new SyntaxError('YAML 根节点不是对象映射');
  }
  return res.value;
}

// 提取卡片中的最后一个 YAML 块与前后缀散文
export function locateCardYaml(rawText, { bareKeyPattern = null } = {}) {
  const body = String(rawText ?? '').replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '');

  // 1) 优先匹配显式标注 ```yaml / ```yml 的最后一个闭合围栏块
  const taggedMatches = [...body.matchAll(/```(?:yaml|yml)[ \t]*\r?\n([\s\S]*?)```/gi)];
  if (taggedMatches.length > 0) {
    const first = taggedMatches[0];
    const last = taggedMatches[taggedMatches.length - 1];
    const prefix = body.slice(0, first.index);
    const suffix = body.slice(last.index + last[0].length);
    if (/```/.test(suffix)) {
      return {
        found: false,
        fenced: true,
        yamlText: '',
        prefix: '',
        suffix: '',
        error: 'YAML 代码围栏之后存在未闭合的代码块，疑似输出截断',
      };
    }
    return {
      found: true,
      fenced: true,
      yamlText: last[1],
      prefix,
      suffix,
      error: null,
    };
  }

  // 2) 其次匹配无语言标签 ``` 的最后一个闭合围栏块
  const bareMatches = [...body.matchAll(/```[ \t]*\r?\n([\s\S]*?)```/g)];
  if (bareMatches.length > 0) {
    const first = bareMatches[0];
    const last = bareMatches[bareMatches.length - 1];
    const prefix = body.slice(0, first.index);
    const suffix = body.slice(last.index + last[0].length);
    if (/```/.test(suffix)) {
      return {
        found: false,
        fenced: true,
        yamlText: '',
        prefix: '',
        suffix: '',
        error: '代码围栏之后存在未闭合的代码块，疑似输出截断',
      };
    }
    return {
      found: true,
      fenced: true,
      yamlText: last[1],
      prefix,
      suffix,
      error: null,
    };
  }

  // 若存在未闭合的 ``` 围栏，直接报截断错误，绝不回退抓取残缺文本
  if (/```(?:yaml|yml)?[ \t]*\r?\n/i.test(body)) {
    return {
      found: false,
      fenced: true,
      yamlText: '',
      prefix: '',
      suffix: '',
      error: 'YAML 代码围栏未闭合，疑似输出截断',
    };
  }

  // 3) 兼容无围栏裸 YAML 卡片（从起始键匹配最长合法 YAML 前缀）
  const keyRe = bareKeyPattern || /(?:^\s*idea_id\s*:|^\s*\{.*?\bidea_id\s*:)/;
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => keyRe.test(l));
  if (start < 0) {
    return {
      found: false,
      fenced: false,
      yamlText: '',
      prefix: '',
      suffix: '',
      error: '找不到 ```yaml 围栏或合法 YAML 起始行',
    };
  }

  const prefix = lines.slice(0, start).join('\n');
  let end = lines.length;
  while (end > start && lines[end - 1].trim() === '') end--;
  for (let cur = end; cur > start; cur--) {
    try {
      parseYamlCardMapping(lines.slice(start, cur).join('\n'));
      return {
        found: true,
        fenced: false,
        yamlText: lines.slice(start, cur).join('\n'),
        prefix,
        suffix: lines.slice(cur).join('\n'),
        error: null,
      };
    } catch {
      // 回退一行重试，剥离紧随裸 YAML 之后的散文尾巴
    }
  }

  return {
    found: true,
    fenced: false,
    yamlText: lines.slice(start).join('\n'),
    prefix,
    suffix: '',
    error: null,
  };
}

// ── 3. 结构化提取卡片 verdict（修复全文行首正则误抓）─────────────────────────
export function extractCardVerdict(cardText) {
  const loc = locateCardYaml(cardText);
  if (!loc.found) {
    return { found: false, data: null, verdict: null, error: loc.error };
  }
  try {
    const data = parseYamlCardMapping(loc.yamlText);
    const rawV = data.verdict;
    const verdict = typeof rawV === 'string' && rawV.trim() ? rawV.trim().toLowerCase() : null;
    return { found: true, data, verdict, error: null };
  } catch (e) {
    return { found: false, data: null, verdict: null, error: String((e && e.message) || e) };
  }
}

export function tooThinReason(reason) {
  const t = String(reason || '').replace(PUNCT_RE, '');
  if (!t) return true;
  if (PLACEHOLDERS.has(t.toLowerCase())) return true;
  return [...t].length < 2;
}

function inferIdeaIdFromPath(cardPath) {
  let stem = path.basename(String(cardPath || ''));
  stem = stem.replace(/\.(?:rejected|void|unknown-seat|no-sha)$/i, '');
  stem = stem.replace(/\.md$/i, '');
  const parts = stem.split('.');
  return parts.length >= 2 ? parts.slice(0, -1).join('.') : null;
}

// ── 4. 评审卡文件校验（rc: 0 合格 / 1 卡片不合规 / 2 文件不存在或不可读）─────
export function checkCardFile(cardPath, { expectedIdeaId = null, minBytes = 200 } = {}) {
  let stat = null;
  try {
    stat = fs.statSync(cardPath);
  } catch {
    return { ok: false, rc: 2, verdict: null, data: null, stderr: '找不到文件: ' + cardPath + '\n' };
  }
  if (!stat.isFile()) {
    return { ok: false, rc: 2, verdict: null, data: null, stderr: '不是普通文件: ' + cardPath + '\n' };
  }

  let raw = '';
  try {
    raw = fs.readFileSync(cardPath, 'utf8');
  } catch (e) {
    return { ok: false, rc: 2, verdict: null, data: null, stderr: '无法读取文件: ' + cardPath + '（' + ((e && e.message) || e) + '）\n' };
  }

  const name = path.basename(cardPath);
  const failCard = (probs, data = null) => ({
    ok: false,
    rc: 1,
    verdict: null,
    data,
    stderr: '  ✗ ' + name + '\n' + probs.map((p) => '      · ' + p).join('\n') + '\n\n1 张卡不合格 —— 不合格不算票\n',
  });

  const body = raw.replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '');
  const trimmedBytes = Buffer.byteLength(body.trim(), 'utf8');
  const threshold = Number.isFinite(Number(minBytes)) && Number(minBytes) > 0 ? Number(minBytes) : 200;
  if (trimmedBytes < threshold) {
    return failCard(['正文只有 ' + trimmedBytes + ' 字节（阈值 ' + threshold + '），疑似被截断']);
  }

  const loc = locateCardYaml(body);
  if (!loc.found) {
    return failCard([loc.error || '找不到合法的 YAML 评审块']);
  }

  let data;
  try {
    data = parseYamlCardMapping(loc.yamlText);
  } catch (e) {
    return failCard(['YAML 解析失败: ' + ((e && e.message) || e)]);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return failCard(['解析结果不是映射，卡片结构不对']);
  }

  const probs = [];
  const want = expectedIdeaId !== null && expectedIdeaId !== undefined
    ? String(expectedIdeaId).trim()
    : inferIdeaIdFromPath(cardPath);
  const got = data.idea_id === undefined || data.idea_id === null || typeof data.idea_id === 'boolean'
    ? ''
    : String(data.idea_id).trim();

  if (want && !got) {
    probs.push('缺 idea_id（应为 ' + want + '）—— 票无法归属到对象，不算票');
  } else if (want && got !== want) {
    probs.push('idea_id 与文件名不符：期望 ' + want + '，卡里写 ' + got + ' —— 评错对象，这张不算票');
  } else if (!want && !got) {
    probs.push('缺 idea_id —— 票无法归属到对象，不算票');
  }

  for (const d of DIMS) {
    const v = data[d];
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      probs.push(d + ' 缺失或不是 {score, reason} 结构');
      continue;
    }
    const s = v.score;
    if (typeof s === 'boolean' || typeof s !== 'number' || !Number.isInteger(s) || s < 1 || s > 5) {
      probs.push(d + '.score 非法: ' + JSON.stringify(s) + '（要求 1-5 整数，不接受布尔值）');
    }
    const rawWhy = v.reason;
    const why = rawWhy === undefined || rawWhy === null || typeof rawWhy === 'boolean' ? '' : String(rawWhy).trim();
    if (!why) {
      probs.push(d + '.reason 为空');
    } else if (tooThinReason(why)) {
      probs.push(d + '.reason 只是占位符/空骨架（' + JSON.stringify(why) + '）—— 有分无据不算一票');
    }
  }

  const rawVerdict = data.verdict;
  const verdict = typeof rawVerdict === 'string' ? rawVerdict.trim().toLowerCase() : '';
  if (!VERDICTS.has(verdict)) {
    probs.push('verdict 非法: ' + JSON.stringify(rawVerdict) + '（要求 go/revise/kill）');
  }

  const rawKr = data.kill_reason;
  const kr = rawKr === undefined || rawKr === null || typeof rawKr === 'boolean' ? '' : String(rawKr).trim();
  if (verdict === 'kill' && (!kr || kr.toLowerCase() === 'null' || kr.toLowerCase() === 'none' || tooThinReason(kr))) {
    probs.push('verdict=kill 但 kill_reason 为空或只是占位符 —— 无据的 kill 不算一票');
  }

  const confRaw = data.confidence;
  let conf = null;
  if (typeof confRaw === 'boolean') {
    probs.push('confidence 非法: ' + JSON.stringify(confRaw) + '（要求 0-1 数值，不接受布尔值）');
  } else {
    const num = typeof confRaw === 'number'
      ? confRaw
      : (typeof confRaw === 'string' && confRaw.trim() !== '' ? Number(confRaw) : NaN);
    if (!Number.isFinite(num) || num < 0 || num > 1) {
      probs.push('confidence 非法: ' + JSON.stringify(confRaw) + '（要求 0-1）');
    } else {
      conf = num;
    }
  }
  if (verdict === 'go' && conf !== null && conf < 0.5) {
    probs.push('go 却只有 confidence=' + conf + ' —— 自相矛盾');
  }

  const tail = loc.suffix.trim().replace(/^[\s\-*#>.`]*/gm, '').trim();
  const tailChars = [...tail].length;
  if (tailChars > 30) {
    probs.push(
      'YAML 之后还有 ' + tailChars + ' 字额外正文（阈值 30，契约要求只输出 YAML）：' +
      tail.slice(0, 50).replace(/\r?\n/g, ' ') + '…'
    );
  }

  if (probs.length > 0) return failCard(probs, data);
  return { ok: true, rc: 0, verdict, data, stderr: '' };
}

// ── 5. 纯 Node 待裁决盘面扫描（支持 topic 命名空间、子课题自动枚举与孤儿 brief 识别）──
function sha12File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

const HUMAN_DECISION_SET = new Set(['go', 'revise', 'kill', 'keep', 'drop', 'rewrite', 'defer']);

function parseHumanDecision(verdictPath) {
  try {
    const text = fs.readFileSync(verdictPath, 'utf8');
    const m1 = text.match(/^[ \t]*(?:#+[ \t]*|[-*+][ \t]*)?(?:\*\*)?(?:决定|Decision|VERDICT)(?:\*\*)?[ \t]*[:：][ \t]*(?:\*\*)?(go|revise|kill|keep|drop|rewrite|defer)(?:\*\*)?[ \t]*(?:[（(#].*)?$/im);
    if (m1) return m1[1].toLowerCase();
    const m2 = text.match(/(?:☑|☒)[ \t]*(go|revise|kill|keep|drop|rewrite|defer)\b|\b(go|revise|kill|keep|drop|rewrite|defer)[ \t]*(?:☑|☒)/i);
    if (m2) return (m2[1] || m2[2]).toLowerCase();
    return null;
  } catch {
    return null;
  }
}

function hasFilledDecision(verdictPath) {
  return parseHumanDecision(verdictPath) !== null;
}

function enumerateTopicScopes(base, { topic = null, briefsDir, cardsDir, ideasDir } = {}) {
  const topicTrim = topic !== null && topic !== undefined ? String(topic).trim() : '';
  const hasExplicitDirs = Boolean(briefsDir || cardsDir || ideasDir);

  if (topicTrim) {
    const relIdeas = ideasDir || path.posix.join('ideas', topicTrim);
    const relBriefs = briefsDir || path.posix.join(relIdeas.replace(/\\/g, '/'), 'briefs');
    const relCards = cardsDir || path.posix.join(relIdeas.replace(/\\/g, '/'), 'cards');
    return [{
      topic: topicTrim,
      prefix: '',
      ideasDir: relIdeas,
      briefsDir: relBriefs,
      cardsDir: relCards,
    }];
  }

  if (hasExplicitDirs) {
    return [{
      topic: '',
      prefix: '',
      ideasDir: ideasDir || 'ideas',
      briefsDir: briefsDir || 'ideas/briefs',
      cardsDir: cardsDir || 'ideas/cards',
    }];
  }

  const scopes = [{
    topic: '',
    prefix: '',
    ideasDir: 'ideas',
    briefsDir: 'ideas/briefs',
    cardsDir: 'ideas/cards',
  }];

  const absRootIdeas = path.resolve(base, 'ideas');
  if (fs.existsSync(absRootIdeas)) {
    let entries = [];
    try { entries = fs.readdirSync(absRootIdeas, { withFileTypes: true }); } catch { entries = []; }
    const subNames = entries
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !RESERVED_IDEAS_SUBDIRS.has(d.name))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    for (const sub of subNames) {
      const subAbs = path.join(absRootIdeas, sub);
      const hasBriefs = fs.existsSync(path.join(subAbs, 'briefs'));
      const hasCards = fs.existsSync(path.join(subAbs, 'cards'));
      if (hasBriefs || hasCards) {
        scopes.push({
          topic: sub,
          prefix: sub + '/',
          ideasDir: path.posix.join('ideas', sub),
          briefsDir: path.posix.join('ideas', sub, 'briefs'),
          cardsDir: path.posix.join('ideas', sub, 'cards'),
        });
      }
    }
  }

  return scopes;
}

function collectBriefIds(absBriefs) {
  if (!fs.existsSync(absBriefs)) return [];
  try {
    if (!fs.statSync(absBriefs).isDirectory()) return [];
    return fs.readdirSync(absBriefs)
      .filter((f) => f.endsWith('.md') && !f.startsWith('.') && !f.includes('_pool') && f !== 'dead-ends.md' && f !== '_summary.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

export function scanPendingVerdicts(rootDir, opts = {}) {
  const { topic = null, briefsDir, cardsDir, ideasDir } = opts || {};
  const base = path.resolve(String(rootDir || '.'));
  const scopes = enumerateTopicScopes(base, { topic, briefsDir, cardsDir, ideasDir });

  const buckets = {
    pending: [],
    unsummarized: [],
    cal_unsummarized: [],
    decided: [],
    voided: [],
    no_output: [],
    calibrated: [],
    drifted: [],
    unchecked: [],
    unrun: [],
  };

  let anyCardsDirExists = false;
  const lines = ['轮次                   status                     等待'];
  const driftRows = [];
  const uncheckedRows = [];
  const unrunRows = [];
  const nowMs = Date.now();

  for (const sc of scopes) {
    const absBriefs = path.resolve(base, sc.briefsDir);
    const absCards = path.resolve(base, sc.cardsDir);
    const absIdeas = path.resolve(base, sc.ideasDir);
    const hasCardsDir = fs.existsSync(absCards) && fs.statSync(absCards).isDirectory();
    if (hasCardsDir) anyCardsDirExists = true;

    const entries = hasCardsDir ? fs.readdirSync(absCards).sort() : [];
    const manifests = entries.filter((f) => f.endsWith('.manifest'));
    const manifestIdSet = new Set(manifests.map((f) => f.slice(0, -'.manifest'.length)));
    const cardIdSet = new Set();

    for (const f of entries) {
      if (!f.endsWith('.md') || f.includes('_pool') || f === '_summary.md') continue;
      const stem = f.slice(0, -3);
      const lastDot = stem.lastIndexOf('.');
      if (lastDot > 0) cardIdSet.add(stem.slice(0, lastDot));
    }

    // 扫描“有 brief 但尚未跑出 .manifest 或卡片”的未派工孤儿单
    const briefIds = collectBriefIds(absBriefs);
    for (const bid of briefIds) {
      if (!manifestIdSet.has(bid) && !cardIdSet.has(bid)) {
        const disp = sc.prefix + bid;
        buckets.unrun.push(disp);
        unrunRows.push('  ' + disp + '  （已有工单 ' + path.posix.join(sc.briefsDir.replace(/\\/g, '/'), bid + '.md') + '，尚未派工出票）');
      }
    }

    if (!hasCardsDir) continue;

    for (const mfName of manifests) {
      const id = mfName.slice(0, -'.manifest'.length);
      const disp = sc.prefix + id;
      const mfPath = path.join(absCards, mfName);
      const mfText = fs.readFileSync(mfPath, 'utf8');
      const stMatch = mfText.match(/ status=(.*?) -->/);
      const st = stMatch && stMatch[1] ? stMatch[1].trim() : '未记录';
      const isCal = /^(?:smoke|calib)_/.test(id);

      if (isCal) {
        buckets.calibrated.push(disp);
        lines.push('  校准 ' + disp.padEnd(18) + ' ' + st);
      }
      if (st.startsWith('VOID')) {
        buckets.voided.push(disp);
        lines.push('  作废 ' + disp.padEnd(18) + ' ' + st + '（不必裁决）');
        continue;
      }
      if (st.startsWith('NO-OUTPUT')) {
        buckets.no_output.push(disp);
        lines.push('  无产出 ' + disp.padEnd(18) + ' ' + st + '（不必裁决：修好后端后重跑）');
        continue;
      }

      const shaMatch = mfText.match(/\bsha=([0-9a-f]+)/);
      const msha = shaMatch ? shaMatch[1] : '';
      const briefPath = path.join(absBriefs, id + '.md');
      const driftReasons = [];
      let uncheckedReason = '';

      if (!msha) {
        uncheckedReason = 'manifest 缺 sha=，指纹无法核对';
      } else if (!fs.existsSync(briefPath)) {
        uncheckedReason = '工单不在盘上（' + path.posix.join(sc.briefsDir.replace(/\\/g, '/'), id + '.md') + '），漂移无法核对';
      } else {
        const bsha = sha12File(briefPath);
        if (bsha !== msha) {
          driftReasons.push('工单已改（记 ' + msha + '，现 ' + bsha + '，本轮未重跑）');
        }
      }

      const votesMatch = mfText.match(/^votes:\s*(.+)$/m);
      const votes = votesMatch
        ? votesMatch[1].trim().split(/\s+/).filter((v) => v && v !== 'none')
        : [];
      const missingVotes = votes.filter((v) => !fs.existsSync(path.join(absCards, id + '.' + v + '.md')));
      if (missingVotes.length > 0) {
        driftReasons.push('votes 里的卡不在盘上: ' + missingVotes.join(' '));
      }

      if (driftReasons.length > 0) {
        buckets.drifted.push(disp);
        driftRows.push('  ' + disp + '  ' + driftReasons.join('；'));
      }
      if (uncheckedReason) {
        buckets.unchecked.push(disp);
        uncheckedRows.push('  ' + disp + '  ' + uncheckedReason);
      }

      if (isCal) continue;

      const verdictPath = path.join(absIdeas, 'verdict-' + id + '.md');
      if (fs.existsSync(verdictPath)) {
        if (hasFilledDecision(verdictPath)) {
          buckets.decided.push(disp);
          continue;
        }
        buckets.pending.push(disp);
        lines.push(disp.padEnd(22) + ' ' + '决定栏仍是模板态'.padEnd(26) + ' （文件在，结论未填）');
        continue;
      }

      let days = 0;
      try {
        days = Math.max(0, Math.floor((nowMs - fs.statSync(mfPath).mtimeMs) / 86400000));
      } catch {
        days = 0;
      }
      buckets.pending.push(disp);
      lines.push(disp.padEnd(22) + ' ' + st.padEnd(26) + ' ' + days + ' 天');
    }

    // 扫描有卡无 manifest 的轮次（按轮次 ID 去重）
    const seenUnsum = new Set();
    for (const f of entries) {
      if (!f.endsWith('.md') || f.includes('_pool') || f === '_summary.md') continue;
      const stem = f.slice(0, -3);
      const lastDot = stem.lastIndexOf('.');
      if (lastDot <= 0) continue;
      const cid = stem.slice(0, lastDot);
      if (seenUnsum.has(cid)) continue;
      if (fs.existsSync(path.join(absCards, cid + '.manifest'))) continue;
      seenUnsum.add(cid);
      const disp = sc.prefix + cid;
      if (/^(?:smoke|calib)_/.test(cid)) {
        buckets.cal_unsummarized.push(disp);
        lines.push(disp.padEnd(22) + ' 无 manifest（校准轮，没汇总完）');
      } else {
        buckets.unsummarized.push(disp);
        lines.push(disp.padEnd(22) + ' 无 manifest（这轮没汇总完）');
      }
    }
  }

  const primaryScope = scopes[0];
  if (!anyCardsDirExists && buckets.unrun.length === 0) {
    const report = '尚未产生评审卡片记录（' + primaryScope.cardsDir + ' 不存在）\n✓ 没有悬空的轮次\n';
    return { ok: true, rc: 0, pendingCount: 0, buckets, report };
  }

  lines.push('');
  lines.push(
    '待裁决 ' + buckets.pending.length +
    ' ／ 未汇总 ' + buckets.unsummarized.length +
    ' ／ 校准轮未汇总 ' + buckets.cal_unsummarized.length +
    ' ／ 已裁决 ' + buckets.decided.length +
    ' ／ 作废 ' + buckets.voided.length +
    ' ／ 无产出 ' + buckets.no_output.length +
    ' ／ 未派工 ' + buckets.unrun.length +
    ' ／ 校准轮 ' + buckets.calibrated.length +
    ' ／ 证据漂移 ' + buckets.drifted.length +
    ' ／ 无法核对 ' + buckets.unchecked.length
  );

  if (buckets.unrun.length > 0) {
    lines.push('→ 未派工孤儿单 ' + buckets.unrun.length + ' 单：已有工单但尚未跑出 .manifest 或评审卡片');
    lines.push(...unrunRows);
  }
  if (buckets.voided.length > 0) {
    lines.push('→ 作废的 ' + buckets.voided.length + ' 轮不必裁决，但等于未跑过：换不同源的模型重跑');
  }
  if (buckets.no_output.length > 0) {
    lines.push('→ 无产出的 ' + buckets.no_output.length + ' 轮：一票都未产出（status=NO-OUTPUT*），修好后端重跑');
  }
  if (buckets.drifted.length > 0) {
    lines.push('→ 证据漂移 ' + buckets.drifted.length + ' 轮：工单指纹或卡片与 manifest 记录不符');
    lines.push(...driftRows);
  }
  if (buckets.unchecked.length > 0) {
    lines.push('→ 无法核对 ' + buckets.unchecked.length + ' 轮：工单或指纹缺失，证据链状态未知');
    lines.push(...uncheckedRows);
  }
  if (buckets.cal_unsummarized.length > 0) {
    lines.push('→ 校准轮未汇总 ' + buckets.cal_unsummarized.length + ' 轮：有卡但无 manifest');
  }

  const needsAttention =
    buckets.pending.length > 0 ||
    buckets.unsummarized.length > 0 ||
    buckets.no_output.length > 0;

  if (needsAttention) {
    lines.push('→ 读 ' + primaryScope.cardsDir + '/<id>.manifest 与各票，由人撰写 ' + primaryScope.ideasDir + '/verdict-<id>.md');
    return {
      ok: true,
      rc: 1,
      pendingCount: buckets.pending.length,
      buckets,
      report: lines.join('\n') + '\n',
    };
  }

  if (buckets.cal_unsummarized.length === 0) {
    lines.push('✓ 没有悬空的轮次');
  }
  return {
    ok: true,
    rc: 0,
    pendingCount: 0,
    buckets,
    report: lines.join('\n') + '\n',
  };
}

// ── 6. 跨工单横向评审总表（解决 20 单逐张翻卡疲劳）──────────────────────────
function extractCardMetaHeader(rawText, fallbackSeat) {
  const firstLine = String(rawText || '').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] || '';
  if (!firstLine.startsWith('<!--')) {
    return { agent: fallbackSeat, model: 'unknown', declared: '' };
  }
  const be = (firstLine.match(/\bbackend=([^\s>]+)/) || [])[1] || fallbackSeat;
  const mdl = (firstLine.match(/\bmodel=([^\s>]+)/) || [])[1] || 'unknown';
  const dec = (firstLine.match(/\bdeclared=([^\s>]+)/) || [])[1] || '';
  return { agent: be, model: dec || mdl, declared: dec };
}

function summarizeCardCoreReason(data, verdict) {
  if (!data || typeof data !== 'object') return 'YAML 解析失败';
  if (verdict === 'kill' && data.kill_reason && typeof data.kill_reason !== 'boolean') {
    const kr = String(data.kill_reason).replace(/\s+/g, ' ').trim();
    if (kr && kr.toLowerCase() !== 'null' && kr.toLowerCase() !== 'none') return kr;
  }
  if (verdict === 'revise' && Array.isArray(data.missing_info) && data.missing_info.length > 0) {
    const firstMiss = String(data.missing_info[0] ?? '').replace(/\s+/g, ' ').trim();
    if (firstMiss) return '需补信息: ' + firstMiss;
  }

  const scored = [];
  for (const d of DIMS) {
    const obj = data[d];
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const s = typeof obj.score === 'number' ? obj.score : NaN;
      const r = obj.reason ? String(obj.reason).replace(/\s+/g, ' ').trim() : '';
      if (r) scored.push({ dim: d, score: Number.isFinite(s) ? s : 3, reason: r });
    }
  }
  if (scored.length === 0) return '—';
  if (verdict === 'go') {
    scored.sort((a, b) => b.score - a.score);
  } else {
    scored.sort((a, b) => a.score - b.score);
  }
  return scored[0].dim + '(' + scored[0].score + '): ' + scored[0].reason;
}

function extractBriefOneLiner(briefPath) {
  try {
    const text = fs.readFileSync(briefPath, 'utf8');
    const titleMatch = text.match(/^\*\*ID\*\*\s*:\s*idea_\d+\s*(?:[—\-:：]\s*(.+))?$/m);
    const hypMatch = text.match(/^[ \t]*(?:[-+*][ \t]+)?(?:\*\*)?(?:假设|Hypothesis)(?:\*\*)?[ \t]*[:：][ \t]*(.+)$/im);
    const title = titleMatch && titleMatch[1] ? titleMatch[1].trim() : '';
    const hyp = hypMatch && hypMatch[1] ? hypMatch[1].trim() : '';
    if (title && hyp) return title + ' —— ' + hyp;
    return title || hyp || '';
  } catch {
    return '';
  }
}

function escapeMdCell(s, maxLen = 96) {
  const clean = String(s ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
  if ([...clean].length <= maxLen) return clean || '—';
  return [...clean].slice(0, maxLen - 1).join('') + '…';
}

export function summarizeTopic(rootDir, opts = {}) {
  const {
    topic = null,
    writeFile = true,
    briefsDir = null,
    cardsDir = null,
    ideasDir = null,
    outPath: explicitOut = null,
    sortBy = undefined,
    sort = undefined,
  } = opts || {};

  const rawSort = sortBy !== undefined && sortBy !== null
    ? sortBy
    : (sort !== undefined && sort !== null ? sort : 'rank');
  const sortMode = String(rawSort).trim().toLowerCase() || 'rank';
  if (sortMode !== 'rank' && sortMode !== 'id') {
    const msg = `summarizeTopic: --sort 仅支持 rank 或 id（当前: ${rawSort}）`;
    return { ok: false, rc: 1, error: msg, stderr: msg + '\n' };
  }

  const base = path.resolve(String(rootDir || '.'));
  const topicTrim = topic !== null && topic !== undefined ? String(topic).trim() : '';
  const scopes = enumerateTopicScopes(base, { topic: topicTrim || null, briefsDir, cardsDir, ideasDir });

  const defaultRelOut = topicTrim
    ? path.posix.join('ideas', topicTrim, '_summary.md')
    : path.posix.join(ideasDir || 'ideas', '_summary.md');
  const resolvedOutPath = explicitOut
    ? (path.isAbsolute(explicitOut) ? explicitOut : path.resolve(base, explicitOut))
    : path.resolve(base, defaultRelOut);

  const items = [];

  for (const sc of scopes) {
    const absBriefs = path.resolve(base, sc.briefsDir);
    const absCards = path.resolve(base, sc.cardsDir);
    const absIdeas = path.resolve(base, sc.ideasDir);

    const idSet = new Set(collectBriefIds(absBriefs));
    const cardFilesByIdea = new Map();

    if (fs.existsSync(absCards) && fs.statSync(absCards).isDirectory()) {
      for (const f of fs.readdirSync(absCards).sort()) {
        if (f.endsWith('.manifest')) {
          idSet.add(f.slice(0, -'.manifest'.length));
          continue;
        }
        if (!f.endsWith('.md') || f.includes('_pool') || f === '_summary.md') continue;
        const stem = f.slice(0, -3);
        const dotIdx = stem.lastIndexOf('.');
        if (dotIdx <= 0) continue;
        const iid = stem.slice(0, dotIdx);
        const seat = stem.slice(dotIdx + 1);
        idSet.add(iid);
        if (!cardFilesByIdea.has(iid)) cardFilesByIdea.set(iid, []);
        cardFilesByIdea.get(iid).push({ seat, filePath: path.join(absCards, f) });
      }
    }

    const sortedIds = [...idSet].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const id of sortedIds) {
      const dispId = sc.prefix + id;
      const briefPath = path.join(absBriefs, id + '.md');
      const hasBrief = fs.existsSync(briefPath);
      const oneLiner = hasBrief ? extractBriefOneLiner(briefPath) : '';

      const mfPath = path.join(absCards, id + '.manifest');
      let manifestStatus = 'UNRUN';
      let sharedModels = '';
      if (fs.existsSync(mfPath)) {
        const mfText = fs.readFileSync(mfPath, 'utf8');
        const stMatch = mfText.match(/ status=(.*?) -->/);
        manifestStatus = stMatch && stMatch[1] ? stMatch[1].trim() : 'UNKNOWN';
        const smMatch = mfText.match(/^shared_models:\s*(.+)$/m);
        if (smMatch) sharedModels = smMatch[1].trim();
      } else if ((cardFilesByIdea.get(id) || []).length > 0) {
        manifestStatus = 'UNSUMMARIZED';
      }

      const votes = [];
      let goCount = 0;
      let reviseCount = 0;
      let killCount = 0;
      const validScaled25 = [];
      const validMean5 = [];
      const validConfs = [];

      for (const cEntry of (cardFilesByIdea.get(id) || [])) {
        const rawCard = fs.readFileSync(cEntry.filePath, 'utf8');
        const meta = extractCardMetaHeader(rawCard, cEntry.seat);
        const ex = extractCardVerdict(rawCard);
        const v = ex.found && ex.verdict ? ex.verdict : 'invalid';
        const isValidVerdict = v === 'go' || v === 'revise' || v === 'kill';
        if (v === 'go') goCount++;
        else if (v === 'revise') reviseCount++;
        else if (v === 'kill') killCount++;
        const coreReason = ex.found ? summarizeCardCoreReason(ex.data, v) : (ex.error || '解析失败');
        const dimScores = {};
        if (ex.found && ex.data) {
          for (const d of DIMS) {
            if (ex.data[d] && typeof ex.data[d].score === 'number' && Number.isFinite(ex.data[d].score)) {
              dimScores[d] = ex.data[d].score;
            }
          }
        }
        const dimVals = Object.values(dimScores);
        let voteSum5d = null;
        let voteAvg5d = null;
        if (isValidVerdict && dimVals.length > 0) {
          const rawSum = dimVals.reduce((acc, x) => acc + x, 0);
          const rawMean = rawSum / dimVals.length;
          const scaled25 = dimVals.length === DIMS.length ? rawSum : rawMean * DIMS.length;
          voteSum5d = Math.round(scaled25 * 100) / 100;
          voteAvg5d = Math.round(rawMean * 100) / 100;
          validScaled25.push(scaled25);
          validMean5.push(rawMean);
        }
        const confVal = (ex.found && ex.data && typeof ex.data.confidence === 'number' && Number.isFinite(ex.data.confidence))
          ? ex.data.confidence
          : null;
        if (isValidVerdict && confVal !== null) {
          validConfs.push(confVal);
        }
        votes.push({
          seat: cEntry.seat,
          agent: meta.agent,
          model: meta.model,
          verdict: v,
          confidence: confVal,
          scores: dimScores,
          sum5d: voteSum5d,
          avg5d: voteAvg5d,
          reason: coreReason,
        });
      }

      const avgTotal25 = validScaled25.length > 0
        ? Math.round((validScaled25.reduce((acc, x) => acc + x, 0) / validScaled25.length) * 100) / 100
        : null;
      const avg5d = validMean5.length > 0
        ? Math.round((validMean5.reduce((acc, x) => acc + x, 0) / validMean5.length) * 100) / 100
        : null;
      const avgConfidence = validConfs.length > 0
        ? Math.round((validConfs.reduce((acc, x) => acc + x, 0) / validConfs.length) * 10000) / 10000
        : null;

      const verdictPath = path.join(absIdeas, 'verdict-' + id + '.md');
      let humanVerdict = '待裁决';
      if (/^(?:smoke|calib)_/.test(id)) {
        humanVerdict = '校准轮';
      } else if (manifestStatus === 'UNRUN') {
        humanVerdict = '未派工';
      } else if (manifestStatus.startsWith('VOID')) {
        humanVerdict = '已作废';
      } else if (fs.existsSync(verdictPath)) {
        const dec = parseHumanDecision(verdictPath);
        humanVerdict = dec ? dec : '模板未填';
      }

      items.push({
        id: dispId,
        rawId: id,
        topic: sc.topic,
        rank: null,
        oneLiner,
        manifestStatus,
        sharedModels,
        counts: { go: goCount, revise: reviseCount, kill: killCount },
        avgTotal25,
        avg5d,
        avgConfidence,
        votes,
        humanVerdict,
      });
    }
  }

  const isRankable = (it) => {
    if (/^(?:smoke|calib)_/.test(it.rawId)) return false;
    if (it.manifestStatus === 'UNRUN' || it.manifestStatus === 'NO-OUTPUT' || it.manifestStatus.startsWith('VOID')) {
      return false;
    }
    return (it.counts.go + it.counts.revise + it.counts.kill) > 0;
  };

  const compareRank = (a, b) => {
    if (b.counts.go !== a.counts.go) return b.counts.go - a.counts.go;
    if (a.counts.kill !== b.counts.kill) return a.counts.kill - b.counts.kill;
    if (b.counts.revise !== a.counts.revise) return b.counts.revise - a.counts.revise;
    const aTot = a.avgTotal25 ?? -1;
    const bTot = b.avgTotal25 ?? -1;
    if (bTot !== aTot) return bTot - aTot;
    const aConf = a.avgConfidence ?? -1;
    const bConf = b.avgConfidence ?? -1;
    if (bConf !== aConf) return bConf - aConf;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  };

  const rankedItems = items.filter(isRankable).sort(compareRank);
  rankedItems.forEach((it, idx) => {
    it.rank = idx + 1;
  });

  const unrankedBucket = (it) => {
    if (/^(?:smoke|calib)_/.test(it.rawId)) return 3;
    if (it.manifestStatus.startsWith('VOID')) return 2;
    return 1;
  };

  if (sortMode === 'rank') {
    const unrankedItems = items
      .filter((it) => it.rank === null)
      .sort((a, b) => {
        const ba = unrankedBucket(a);
        const bb = unrankedBucket(b);
        if (ba !== bb) return ba - bb;
        return a.id.localeCompare(b.id, undefined, { numeric: true });
      });
    items.length = 0;
    items.push(...rankedItems, ...unrankedItems);
  } else {
    items.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  let pendingN = 0;
  let decidedN = 0;
  let unrunN = 0;
  for (const it of items) {
    if (it.humanVerdict === '未派工') unrunN++;
    else if (HUMAN_DECISION_SET.has(String(it.humanVerdict).toLowerCase())) decidedN++;
    else if (it.humanVerdict === '待裁决' || it.humanVerdict === '模板未填') pendingN++;
  }

  const headerLabel = topicTrim || '全盘课题';
  const sortLabel = sortMode === 'rank' ? '综合推荐度降序 (rank)' : '工单编号顺序 (id)';
  const mdLines = [
    '# 课题评审横向汇总 · ' + headerLabel,
    '',
    '> 自动生成：共 **' + items.length + '** 单 · 待裁决 **' + pendingN + '** · 已裁决 **' + decidedN + '** · 未派工 **' + unrunN + '** · 排序：**' + sortLabel + '**',
    '',
    '| 排名 | 工单 ID | 轮次状态 | 五维均分 (/25) | 票型 (G/R/K) | 各票判定 (agent / model → verdict) | 核心一句话理由 / 致命质疑 | 人工裁决 |',
    '|---|---|---|---|---|---|---|---|',
  ];

  if (items.length === 0) {
    mdLines.push('| — | — | — | — | 0/0/0 | 暂无工单或评审卡片 | — | — |');
  } else {
    for (const it of items) {
      const rankCell = it.rank !== null ? '#' + it.rank : '—';
      const scoreCell = it.avgTotal25 !== null && it.avg5d !== null
        ? '**' + it.avgTotal25.toFixed(2) + '** (' + it.avg5d.toFixed(2) + '/5)'
        : '—';
      const voteRatio = it.counts.go + '/' + it.counts.revise + '/' + it.counts.kill;
      const perVoteSummary = it.votes.length > 0
        ? it.votes.map((v) => {
            const scTag = v.sum5d !== null
              ? '[' + (Number.isInteger(v.sum5d) ? String(v.sum5d) : v.sum5d.toFixed(1)) + '/25]'
              : '';
            return v.seat + '(' + v.model + ')→**' + v.verdict + '**' + scTag;
          }).join('; ')
        : '—';
      const primaryCritique = it.votes.length > 0
        ? it.votes.map((v) => '[' + v.seat + '] ' + v.reason).join(' / ')
        : (it.oneLiner || '尚未出票');
      const statusCell = it.sharedModels
        ? it.manifestStatus + ' (shared:' + it.sharedModels + ')'
        : it.manifestStatus;

      mdLines.push(
        '| ' + rankCell +
        ' | `' + escapeMdCell(it.id, 40) + '`' +
        ' | ' + escapeMdCell(statusCell, 40) +
        ' | ' + scoreCell +
        ' | ' + voteRatio +
        ' | ' + escapeMdCell(perVoteSummary, 130) +
        ' | ' + escapeMdCell(primaryCritique, 140) +
        ' | ' + escapeMdCell(it.humanVerdict, 20) + ' |'
      );
    }
  }

  const votedItems = items.filter((it) => it.votes.length > 0);
  if (votedItems.length > 0) {
    mdLines.push('');
    mdLines.push('## 逐单票面速览');
    for (const it of votedItems) {
      mdLines.push('');
      const rankPrefix = it.rank !== null ? '#' + it.rank + ' ' : '';
      mdLines.push('### ' + rankPrefix + it.id + (it.oneLiner ? ' · ' + it.oneLiner : ''));
      const scoreMeta = it.avgTotal25 !== null && it.avg5d !== null
        ? ' · 五维均分：**' + it.avgTotal25.toFixed(2) + '/25** (' + it.avg5d.toFixed(2) + '/5)'
        : '';
      const confMeta = it.avgConfidence !== null
        ? ' · 平均置信度：`' + it.avgConfidence.toFixed(2) + '`'
        : '';
      mdLines.push('- 轮次状态：`' + it.manifestStatus + '`' + scoreMeta + confMeta + ' · 人工裁决：**' + it.humanVerdict + '**');
      for (const v of it.votes) {
        const scParts = DIMS.filter((d) => v.scores[d] !== undefined).map((d) => d[0].toUpperCase() + ':' + v.scores[d]);
        const sumPart = v.sum5d !== null
          ? ' Σ=' + (Number.isInteger(v.sum5d) ? String(v.sum5d) : v.sum5d.toFixed(1)) + '/25'
          : '';
        const scText = scParts.length > 0 ? ' [' + scParts.join(' ') + sumPart + ']' : '';
        const confText = v.confidence !== null && v.confidence !== undefined ? ' (conf=' + v.confidence + ')' : '';
        mdLines.push('  - `' + v.seat + '` (`' + v.model + '`) → **' + v.verdict + '**' + confText + scText + '：' + v.reason);
      }
    }
  }

  const markdown = mdLines.join('\n') + '\n';
  if (writeFile !== false) {
    fs.mkdirSync(path.dirname(resolvedOutPath), { recursive: true });
    fs.writeFileSync(resolvedOutPath, markdown, 'utf8');
  }

  return {
    ok: true,
    rc: 0,
    outPath: resolvedOutPath,
    count: items.length,
    sortBy: sortMode,
    items,
    markdown,
  };
}

// ── 7. 纯 Node OpenAI 兼容 /chat/completions 客户端 ─────────────────────────
function normalizeChatEndpoint(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (b.endsWith('/chat/completions')) return b;
  if (/\/v[1-9]\d*$/i.test(b) || /\/openai$/i.test(b)) return b + '/chat/completions';
  return b + '/v1/chat/completions';
}

export async function apiChatCompletion({
  baseUrl,
  apiKey,
  model,
  payload,
  timeoutMs = 180000,
  maxTokens = 4096,
  temperature = null,
} = {}) {
  const redact = (msg) => {
    let s = maskSecrets(msg);
    if (apiKey && String(apiKey).length >= 6) {
      s = s.split(String(apiKey)).join('[REDACTED]');
    }
    return s;
  };

  if (!baseUrl || !apiKey || !model) {
    return {
      ok: false,
      rc: 3,
      content: '',
      stderr: redact('API 座缺少必填配置（baseUrl / apiKey / model）') + '\n',
    };
  }

  const url = normalizeChatEndpoint(baseUrl);
  const bodyObj = {
    model: String(model),
    max_tokens: Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0 ? Number(maxTokens) : 4096,
    messages: [{ role: 'user', content: String(payload ?? '') }],
  };
  if (temperature !== null && temperature !== undefined && temperature !== '' && Number.isFinite(Number(temperature))) {
    bodyObj.temperature = Number(temperature);
  }

  const ms = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 180000;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + String(apiKey),
      },
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    return {
      ok: false,
      rc: 7,
      content: '',
      stderr: redact('API 请求网络或超时错误: ' + ((e && e.message) || String(e))) + '\n',
    };
  }

  if (!resp.ok) {
    let errText = '';
    try {
      errText = await resp.text();
    } catch {
      errText = '';
    }
    return {
      ok: false,
      rc: 5,
      content: '',
      stderr: redact('HTTP ' + resp.status + ': ' + errText.slice(0, 500)) + '\n',
    };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return {
      ok: false,
      rc: 6,
      content: '',
      stderr: redact('API 响应不是合法 JSON: ' + ((e && e.message) || String(e))) + '\n',
    };
  }

  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray(data.choices) ||
    data.choices.length === 0 ||
    !data.choices[0] ||
    typeof data.choices[0] !== 'object' ||
    !data.choices[0].message ||
    typeof data.choices[0].message !== 'object'
  ) {
    return {
      ok: false,
      rc: 6,
      content: '',
      stderr: redact('API 响应结构异常（choices/message 为空或缺失）: ' + JSON.stringify(data).slice(0, 300)) + '\n',
    };
  }

  const choice = data.choices[0];
  const msg = choice.message;
  const rawContent = Array.isArray(msg.content)
    ? msg.content.map((p) => (p && typeof p === 'object' ? (p.text || '') : String(p || ''))).join('')
    : (typeof msg.content === 'string' ? msg.content : '');
  const content = rawContent.trim();

  if (choice.finish_reason === 'length') {
    return {
      ok: false,
      rc: 6,
      content: '',
      stderr: 'API 回复因达到 max_tokens 上限被截断（finish_reason=length，正文 ' + content.length + ' 字）\n',
    };
  }

  if (!content) {
    return {
      ok: false,
      rc: 6,
      content: '',
      stderr: 'API 回复 content 为空（finish_reason=' + String(choice.finish_reason ?? 'unknown') + '）\n',
    };
  }

  return { ok: true, rc: 0, content, stderr: '' };
}
