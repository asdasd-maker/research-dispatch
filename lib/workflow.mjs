// 全链路纯 Node 确定性科研工作流闸门与项目脚手架（v2.0.0，Node >= 20，零外部依赖）：
//   1. checkPaperCard        —— 文献卡结构、字段、反占位符与前后散文边界校验（含 [D-11] 修复）
//   2. assemblePaperPool     —— 文献池确定性排序拼装与坏卡单次报错隔离（含 [D-12] 修复）
//   3. serializeIdeaPool     —— 发散候选池带防注入溯源头序列化（含 [D-8] 修复）
//   4. verifyPoolProvenance  —— 发散池正文 isha 与基线 bsha 双重指纹对账
//   5. makeBriefs            —— 按课题拆单、自包含跨条引用拦截、量化预测与 2σ 判据核验、旧单留痕
//   6. checkNoveltyReport    —— 前置查重报告结构与检索凭据硬校验
//   7. checkContractFile     —— 研究契约结构、非空消融表、CRLF 归一 sha12、5 列账本与版本链校验（含 [D-2]/[D-9] 修复）
//   8. watchRepro            —— 基线数据 sha256 对账与训练/复现日志活性巡检（含 [D-10] 修复）
//   9. initProject           —— 跨宿主一键生成全套科研工作流目录、角色与模板骨架
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  checkAnchor,
  isInsideRoot,
  tooThinReason,
} from './validators.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');

function sha256Hex(bufOrStr, len = 64) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, len);
}

function sha12(bufOrStr) {
  return sha256Hex(bufOrStr, 12);
}

function todayIsoDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function writeFileLfAtomic(destPath, content) {
  const lf = String(content).replace(/\r\n/g, '\n');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, lf, 'utf8');
  try {
    fs.renameSync(tmp, destPath);
  } catch {
    try {
      fs.copyFileSync(tmp, destPath);
      fs.unlinkSync(tmp);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
  }
}

function moveFileSafe(srcPath, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  try {
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    fs.renameSync(srcPath, destPath);
  } catch {
    fs.copyFileSync(srcPath, destPath);
    fs.unlinkSync(srcPath);
  }
}

// ── 数值与阈值语境统一判据（移植自 numcheck.py，补齐前导“第/表/图/式”交叉引用剥离）────────
const CROSS_REF_RE = new RegExp(
  '(?:'
  + '(?:第\\s*)?[0-9\\uFF10-\\uFF19]+(?:[.．][0-9\\uFF10-\\uFF19]+)*\\s*(?:小节|节|章|图|表|条|项|行|式|页|卷|版|附录)'
  + '|(?:小节|节|章|图|表|式|附录|section|sec\\.?|figure|fig\\.?|table|tab\\.?|eq\\.?)\\s*[0-9\\uFF10-\\uFF19]+(?:[.．][0-9\\uFF10-\\uFF19]+)*'
  + ')',
  'gi',
);
const THRESHOLD_CTX_RE = new RegExp(
  '(?:≥|≤|>=|<=|>|<|→|->|⟶|⇒|↑|↓|±|%|％'
  + '|[+\\-−\\uFF0D][\\s]*[0-9\\uFF10-\\uFF19]'
  + '|[0-9\\uFF10-\\uFF19][\\s]*(?:个点|个百分点|pp\\b|倍|秒|分钟|小时|步|epoch|iter|ms|fps|帧)'
  + '|以上|以下|以内|不低于|不超过|至少|降至|升到|降到|达到'
  + '|超过|高于|低于|超出|大于|小于|不少于|不多于|突破|不足)',
  'i',
);

export function hasAnyNumber(text) {
  const stripped = String(text || '').replace(CROSS_REF_RE, '');
  return /[0-9\uFF10-\uFF19]/.test(stripped);
}

export function hasThresholdNumber(text) {
  const s = String(text || '');
  return THRESHOLD_CTX_RE.test(s) && hasAnyNumber(s);
}

// ── 轻量确定性 YAML 子集解析器（支持文献卡与查重报告的标量、块标量与对象数组）──────
function stripInlineYamlComment(val) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < val.length; i += 1) {
    const ch = val[i];
    if (ch === "'" && !inDouble) {
      if (inSingle && val[i + 1] === "'") {
        i += 1;
        continue;
      }
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      let bs = 0;
      for (let j = i - 1; j >= 0 && val[j] === '\\'; j -= 1) bs += 1;
      if (bs % 2 === 0) inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(val[i - 1])) {
        return val.slice(0, i).trim();
      }
    }
  }
  return val.trim();
}

function parseYamlScalar(rawVal) {
  const s = stripInlineYamlComment(String(rawVal ?? '').trim());
  if (!s) return null;

  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"')) {
      throw new Error(`双引号字符串未闭合: ${s.slice(0, 40)}`);
    }
    let inner = s.slice(1, -1);
    inner = inner
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    return inner;
  }

  if (s.startsWith("'")) {
    if (s.length < 2 || !s.endsWith("'")) {
      throw new Error(`单引号字符串未闭合: ${s.slice(0, 40)}`);
    }
    return s.slice(1, -1).replace(/''/g, "'");
  }

  const low = s.toLowerCase();
  if (low === 'null' || low === '~') return null;
  if (low === 'true') return true;
  if (low === 'false') return false;
  if (s === '[]') return [];
  if (s === '{}') return {};

  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    const items = [];
    let cur = '';
    let inS = false;
    let inD = false;
    for (let i = 0; i < inner.length; i += 1) {
      const c = inner[i];
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      if (c === ',' && !inS && !inD) {
        items.push(parseYamlScalar(cur));
        cur = '';
      } else {
        cur += c;
      }
    }
    if (cur.trim()) items.push(parseYamlScalar(cur));
    return items;
  }

  if (/^[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }

  return s;
}

function dedentLines(rawText) {
  const lines = String(rawText || '').replace(/\r\n/g, '\n').split('\n');
  let minPad = Infinity;
  for (const ln of lines) {
    if (!ln.trim() || ln.trim().startsWith('#')) continue;
    const pad = ln.match(/^[ ]*/)[0].length;
    if (pad < minPad) minPad = pad;
  }
  if (!Number.isFinite(minPad) || minPad === 0) return lines;
  return lines.map((ln) => (ln.length >= minPad ? ln.slice(minPad) : ln.trimStart()));
}

function parseStructuredYaml(rawYaml) {
  const lines = dedentLines(rawYaml);
  const data = {};
  const seenKeys = new Set();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      i += 1;
      continue;
    }
    if (/^\t/.test(line)) {
      throw new Error(`第 ${i + 1} 行使用了 Tab 缩进（YAML 要求使用空格）`);
    }
    const indent = line.match(/^[ ]*/)[0].length;
    if (indent > 0) {
      throw new Error(`第 ${i + 1} 行缩进异常或混入了非键值对散文: ${trimmed.slice(0, 40)}`);
    }

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) {
      throw new Error(`第 ${i + 1} 行不是合法的 YAML 顶级键值: ${trimmed.slice(0, 40)}`);
    }
    const key = kv[1];
    const restRaw = kv[2];
    if (seenKeys.has(key)) {
      throw new Error(`重复的 YAML 顶级字段: ${key}`);
    }
    seenKeys.add(key);

    const restClean = stripInlineYamlComment(restRaw);

    // 1) 块标量 | 或 >
    if (/^[|>][+-]?[0-9]*$/.test(restClean)) {
      const fold = restClean.startsWith('>');
      i += 1;
      const blockLines = [];
      let blockIndent = null;
      while (i < lines.length) {
        const bl = lines[i];
        if (!bl.trim()) {
          blockLines.push('');
          i += 1;
          continue;
        }
        const bi = bl.match(/^[ ]*/)[0].length;
        if (bi === 0) break;
        if (blockIndent === null) blockIndent = bi;
        blockLines.push(bl.slice(Math.min(bi, blockIndent)));
        i += 1;
      }
      const joined = fold
        ? blockLines.map((x) => x.trim()).filter(Boolean).join(' ')
        : blockLines.join('\n').trim();
      data[key] = joined;
      continue;
    }

    // 2) 行内非空值
    if (restClean !== '') {
      data[key] = parseYamlScalar(restRaw);
      i += 1;
      continue;
    }

    // 3) 空值后观察缩进块（可能是数组 `- ...`、嵌套键值或真 null）
    i += 1;
    let nextIdx = i;
    while (nextIdx < lines.length && (!lines[nextIdx].trim() || lines[nextIdx].trim().startsWith('#'))) {
      nextIdx += 1;
    }
    if (nextIdx >= lines.length) {
      data[key] = null;
      i = nextIdx;
      continue;
    }
    const nextIndent = lines[nextIdx].match(/^[ ]*/)[0].length;
    const nextTrim = lines[nextIdx].trim();

    if (nextIndent === 0 && !nextTrim.startsWith('-')) {
      data[key] = null;
      continue;
    }

    if (nextTrim.startsWith('-')) {
      const list = [];
      i = nextIdx;
      const listBaseIndent = lines[i].match(/^[ ]*/)[0].length;
      while (i < lines.length) {
        const l = lines[i];
        const lt = l.trim();
        if (!lt || lt.startsWith('#')) {
          i += 1;
          continue;
        }
        const li = l.match(/^[ ]*/)[0].length;
        if (li < listBaseIndent) break;
        if (li === listBaseIndent && !lt.startsWith('-')) break;
        if (li > listBaseIndent && list.length === 0) {
          throw new Error(`第 ${i + 1} 行列表缩进不对齐`);
        }

        const itemMatch = l.match(/^[ ]*-(?:[ ]+(.*))?$/);
        if (!itemMatch) break;
        const firstPart = (itemMatch[1] || '').trim();
        i += 1;

        // 检查第一行是否是 `k: v` 对象项，或下一行有更深缩进的子字段
        const inlineObjMatch = firstPart.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        let hasChildProps = false;
        let peek = i;
        while (peek < lines.length && (!lines[peek].trim() || lines[peek].trim().startsWith('#'))) {
          peek += 1;
        }
        if (peek < lines.length) {
          const pi = lines[peek].match(/^[ ]*/)[0].length;
          if (pi > listBaseIndent && !lines[peek].trim().startsWith('-')) {
            hasChildProps = true;
          }
        }

        if (inlineObjMatch || (!firstPart && hasChildProps)) {
          const obj = {};
          if (inlineObjMatch) {
            obj[inlineObjMatch[1]] = parseYamlScalar(inlineObjMatch[2]);
          }
          while (i < lines.length) {
            const cl = lines[i];
            const ct = cl.trim();
            if (!ct || ct.startsWith('#')) {
              i += 1;
              continue;
            }
            const ci = cl.match(/^[ ]*/)[0].length;
            if (ci <= listBaseIndent) break;
            const ckv = ct.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
            if (!ckv) {
              throw new Error(`第 ${i + 1} 行列表对象属性格式非法: ${ct.slice(0, 40)}`);
            }
            obj[ckv[1]] = parseYamlScalar(ckv[2]);
            i += 1;
          }
          list.push(obj);
        } else {
          list.push(parseYamlScalar(firstPart));
        }
      }
      data[key] = list;
      continue;
    }

    // 嵌套简单映射
    const nested = {};
    i = nextIdx;
    while (i < lines.length) {
      const nl = lines[i];
      const nt = nl.trim();
      if (!nt || nt.startsWith('#')) {
        i += 1;
        continue;
      }
      const ni = nl.match(/^[ ]*/)[0].length;
      if (ni === 0) break;
      const nkv = nt.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!nkv) {
        throw new Error(`第 ${i + 1} 行嵌套映射格式非法: ${nt.slice(0, 40)}`);
      }
      nested[nkv[1]] = parseYamlScalar(nkv[2]);
      i += 1;
    }
    data[key] = nested;
  }

  return data;
}

function cleanOutsideProse(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*---+[ \t]*$/gm, '')
    .replace(/^[\s\-*#>.`]+/gm, '')
    .trim();
}

// ── 1) checkPaperCard ──────────────────────────────────────────────────────────
const PAPER_FIELDS = ['paper_id', 'title', 'venue', 'code_url', 'abstract_zh', 'intro_key', 'relevance'];
const PAPER_PROSE_FIELDS = new Set(['title', 'abstract_zh', 'intro_key', 'relevance']);
const ALLOWED_VENUES = new Set([
  'cvpr', 'iccv', 'eccv', 'neurips', 'icml', 'iclr', 'acl',
  'emnlp', 'naacl', 'kdd', 'aaai', 'ijcai', 'jmlr', 'tmlr', 'tpami',
  'arxiv', 'other',
]);

function expectStemId(filePath) {
  let stem = path.basename(String(filePath || ''));
  stem = stem.replace(/\.rejected$/i, '').replace(/\.md$/i, '');
  return stem || null;
}

function validatePaperCardObject(data, idx) {
  const probs = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return [`第 ${idx} 张卡解析结果不是键值映射`];
  }
  for (const f of PAPER_FIELDS) {
    const v = data[f];
    const s = v === null || v === undefined ? '' : String(v).trim();
    if (!s) {
      const hint = f === 'code_url' ? '（无开源代码请显式写 none，漏答与『没有』严格区分）' : '';
      probs.push(`第 ${idx} 张卡缺字段 ${f}${hint}`);
    } else if (PAPER_PROSE_FIELDS.has(f) && tooThinReason(s)) {
      probs.push(`第 ${idx} 张卡字段 ${f} 只是占位符或空骨架（${JSON.stringify(s)}）`);
    }
  }

  const codeUrl = data.code_url === null || data.code_url === undefined ? '' : String(data.code_url).trim();
  if (codeUrl && codeUrl.toLowerCase() !== 'none') {
    if (/<[^>]+>/.test(codeUrl) || /^(?:todo|tbd|n\/a|na|待补|待定|\?|-)$/i.test(codeUrl)) {
      probs.push(`第 ${idx} 张卡 code_url 为模板占位符: ${JSON.stringify(codeUrl)}`);
    } else if (!/^https?:\/\/\S+$/i.test(codeUrl)) {
      probs.push(`第 ${idx} 张卡 code_url 非法: ${JSON.stringify(codeUrl)}（须为 http(s):// 仓库链接或显式写 none）`);
    }
  }

  const venue = data.venue === null || data.venue === undefined ? '' : String(data.venue).trim().toLowerCase();
  if (venue && !ALLOWED_VENUES.has(venue)) {
    probs.push(
      `第 ${idx} 张卡 venue 非法: ${JSON.stringify(data.venue)}`
      + '（须为 CVPR/ICCV/ECCV/NeurIPS/ICML/ICLR/ACL/EMNLP/NAACL/KDD/AAAI/IJCAI/JMLR/TMLR/TPAMI/arXiv/other 之一）',
    );
  }
  return probs;
}

export function checkPaperCard(cardPath) {
  const target = String(cardPath || '').trim();
  if (!target) {
    return { ok: false, rc: 2, data: null, stderr: '未提供文献卡文件路径' };
  }
  let st;
  try {
    st = fs.statSync(target);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: false, rc: 2, data: null, stderr: `找不到文件: ${target}` };
    }
    return { ok: false, rc: 3, data: null, stderr: `校验器读取文件状态异常: ${e.message || e}` };
  }
  if (!st.isFile()) {
    return { ok: false, rc: 2, data: null, stderr: `路径不是普通文件: ${target}` };
  }

  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (e) {
    return { ok: false, rc: 3, data: null, stderr: `校验器读取文件异常: ${e.message || e}` };
  }

  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const body = normalized.replace(/<!--[\s\S]*?-->/g, '');
  if (body.trim().length < 40) {
    const msg = `正文只有 ${body.trim().length} 字符，疑似被截断`;
    return { ok: false, rc: 1, data: null, problems: [msg], stderr: `✗ ${path.basename(target)}\n  · ${msg}` };
  }

  const probs = [];
  const blocks = [];

  const fenceRe = /```(?:yaml|yml)?[ \t]*\n([\s\S]*?)```/gi;
  const fences = [];
  let m;
  while ((m = fenceRe.exec(normalized)) !== null) {
    fences.push({ start: m.index, end: m.index + m[0].length, inner: m[1] });
  }

  if (fences.length > 0) {
    // [D-11] 修复：同时拦截首围栏之前、围栏之间、末围栏之后的超长夹带散文
    const prefixProse = cleanOutsideProse(normalized.slice(0, fences[0].start));
    if (prefixProse.length > 30) {
      probs.push(`卡片之前夹带了 ${prefixProse.length} 字额外散文（阈值 30，契约要求只输出 YAML 卡）：${prefixProse.slice(0, 50).replace(/\n/g, ' ')}…`);
    }
    for (let i = 0; i < fences.length; i += 1) {
      blocks.push(fences[i].inner);
      if (i + 1 < fences.length) {
        const midProse = cleanOutsideProse(normalized.slice(fences[i].end, fences[i + 1].start));
        if (midProse.length > 30) {
          probs.push(`第 ${i + 1} 与第 ${i + 2} 张卡之间夹带了 ${midProse.length} 字额外散文（阈值 30）`);
        }
      }
    }
    const suffixProse = cleanOutsideProse(normalized.slice(fences[fences.length - 1].end));
    if (suffixProse.length > 30) {
      probs.push(`卡片之后还有 ${suffixProse.length} 字额外正文（阈值 30，契约要求只输出卡）：${suffixProse.slice(0, 50).replace(/\n/g, ' ')}…`);
    }
  } else {
    // 无围栏裸 YAML：按独立 `---` 切分，[D-11] 严拒任何不含 paper_id 的非空额外分段
    const strippedComments = normalized.replace(/<!--[\s\S]*?-->/g, '');
    const rawParts = strippedComments.split(/^[ \t]*---[ \t]*$/m);
    const nonEmptyParts = rawParts.filter((p) => p.trim().length > 0);
    if (nonEmptyParts.length === 0) {
      const msg = '找不到任何含 paper_id 的 YAML 卡';
      return { ok: false, rc: 1, data: null, problems: [msg], stderr: `✗ ${path.basename(target)}\n  · ${msg}` };
    }
    for (let idx = 0; idx < nonEmptyParts.length; idx += 1) {
      const seg = nonEmptyParts[idx];
      if (!/^[ \t]*paper_id[ \t]*:/m.test(seg)) {
        probs.push(`第 ${idx + 1} 个 '---' 分段缺少 paper_id（禁止在裸 YAML 卡前后附加散文或空分段）`);
      } else {
        blocks.push(seg);
      }
    }
  }

  if (blocks.length === 0) {
    const allProbs = probs.length ? probs : ['找不到任何含 paper_id 的 YAML 卡'];
    return {
      ok: false,
      rc: 1,
      data: null,
      problems: allProbs,
      stderr: `✗ ${path.basename(target)}\n${allProbs.map((p) => `  · ${p}`).join('\n')}`,
    };
  }

  const parsedCards = [];
  const ids = [];
  for (let i = 0; i < blocks.length; i += 1) {
    let parsed;
    try {
      parsed = parseStructuredYaml(blocks[i]);
    } catch (e) {
      probs.push(`第 ${i + 1} 张卡 YAML 解析失败: ${e.message || e}`);
      continue;
    }
    parsedCards.push(parsed);
    const pid = parsed && parsed.paper_id !== undefined && parsed.paper_id !== null
      ? String(parsed.paper_id).trim()
      : '';
    ids.push(pid);
    probs.push(...validatePaperCardObject(parsed, i + 1));
  }

  if (parsedCards.length === 0) {
    const allProbs = probs.length ? probs : ['没有一张卡能被解析'];
    return {
      ok: false,
      rc: 1,
      data: null,
      problems: allProbs,
      stderr: `✗ ${path.basename(target)}\n${allProbs.map((p) => `  · ${p}`).join('\n')}`,
    };
  }

  const wantId = expectStemId(target);
  const isPoolFile = wantId === '_pool' || (wantId && wantId.startsWith('_pool.'));
  if (wantId && !isPoolFile) {
    if (parsedCards.length > 1) {
      probs.push(`单篇文献卡文件只允许包含 1 张卡（当前含 ${parsedCards.length} 张）`);
    } else if (ids[0] && ids[0] !== wantId) {
      probs.push(`paper_id "${ids[0]}" 与文件名 "${wantId}" 不符 —— 一篇一卡且文件名唯一才能防池内重号`);
    }
  }

  const nonEmptyIds = ids.filter(Boolean);
  if (new Set(nonEmptyIds).size !== nonEmptyIds.length) {
    probs.push('同一文件内出现重复 paper_id');
  }

  if (probs.length > 0) {
    return {
      ok: false,
      rc: 1,
      data: parsedCards.length === 1 ? parsedCards[0] : parsedCards,
      cards: parsedCards,
      problems: probs,
      stderr: `✗ ${path.basename(target)}\n${probs.map((p) => `  · ${p}`).join('\n')}`,
    };
  }

  return {
    ok: true,
    rc: 0,
    data: parsedCards.length === 1 ? parsedCards[0] : parsedCards,
    cards: parsedCards,
    problems: [],
    stdout: `✓ ${path.basename(target)}`,
    stderr: '',
  };
}

// ── 2) assemblePaperPool ───────────────────────────────────────────────────────
export function assemblePaperPool(
  rootDir,
  { cardsDir = 'papers/cards', outFile = 'papers/cards/_pool.md', dry = false } = {},
) {
  const root = path.resolve(String(rootDir || process.cwd()));
  const cardsAbs = path.isAbsolute(cardsDir) ? path.resolve(cardsDir) : path.resolve(root, cardsDir);
  const outAbs = path.isAbsolute(outFile) ? path.resolve(outFile) : path.resolve(root, outFile);

  if (!isInsideRoot(root, cardsAbs)) {
    return {
      ok: false,
      rc: 2,
      validCount: 0,
      rejectedCount: 0,
      outPath: outAbs,
      stdout: '',
      stderr: `cardsDir 越出项目根目录: ${cardsDir}`,
    };
  }
  if (!isInsideRoot(root, outAbs)) {
    return {
      ok: false,
      rc: 2,
      validCount: 0,
      rejectedCount: 0,
      outPath: outAbs,
      stdout: '',
      stderr: `outFile 越出项目根目录: ${outFile}`,
    };
  }

  let entries = [];
  try {
    entries = fs.readdirSync(cardsAbs, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return {
        ok: false,
        rc: 2,
        validCount: 0,
        rejectedCount: 0,
        outPath: outAbs,
        stdout: '',
        stderr: `${cardsDir} 目录不存在 —— 请先按 roles/scout.md 检索并生成文献卡`,
      };
    }
    return {
      ok: false,
      rc: 3,
      validCount: 0,
      rejectedCount: 0,
      outPath: outAbs,
      stdout: '',
      stderr: `读取文献卡目录失败: ${e.message || e}`,
    };
  }

  const outBase = path.basename(outAbs);
  const cardFiles = entries
    .filter((ent) => ent.isFile() && ent.name.endsWith('.md') && ent.name !== '_pool.md' && ent.name !== outBase && !ent.name.startsWith('.'))
    .map((ent) => ent.name)
    .sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)));

  if (cardFiles.length === 0) {
    return {
      ok: false,
      rc: 2,
      validCount: 0,
      rejectedCount: 0,
      outPath: outAbs,
      stdout: '',
      stderr: `${cardsDir} 下没有任何文献卡（*.md）—— 请先按 roles/scout.md 产出文献卡`,
    };
  }

  const outLines = [];
  const errLines = [];
  const validPaths = [];
  let rejectedCount = 0;
  let hasValidatorCrash = false;

  for (const name of cardFiles) {
    const full = path.join(cardsAbs, name);
    const chk = checkPaperCard(full);
    if (chk.rc === 3) {
      errLines.push(`!! 校验器自身异常(rc=3)于 ${name}: ${chk.stderr}`);
      hasValidatorCrash = true;
      continue;
    }
    if (!chk.ok) {
      rejectedCount += 1;
      if (dry) {
        errLines.push(`!! ${name} 不合格（DRY：不移动，真跑将移入 rejected/），不进池`);
      } else {
        const dest = path.join(cardsAbs, 'rejected', `${name}.rejected`);
        try {
          moveFileSafe(full, dest);
          // [D-12] 修复：每张不合格坏卡移入 rejected/ 时严格只报告一次
          errLines.push(`!! ${name} 不合格 → 已移入 rejected/${name}.rejected，不进池`);
        } catch (e) {
          errLines.push(`!! ${name} 不合格，且移入 rejected/ 失败（${e.message || e}）—— 本轮作废`);
          return {
            ok: false,
            rc: 3,
            validCount: validPaths.length,
            rejectedCount,
            outPath: outAbs,
            stdout: outLines.join('\n'),
            stderr: errLines.join('\n'),
          };
        }
      }
      if (chk.stderr) {
        errLines.push(...chk.stderr.split('\n').map((l) => `   ${l}`));
      }
      continue;
    }
    validPaths.push(full);
  }

  if (hasValidatorCrash) {
    errLines.push('!! 本轮作废（校验器 rc=3）：不拼装 _pool.md');
    return {
      ok: false,
      rc: 3,
      validCount: validPaths.length,
      rejectedCount,
      outPath: outAbs,
      stdout: outLines.join('\n'),
      stderr: errLines.join('\n'),
    };
  }

  if (validPaths.length === 0) {
    errLines.push(`!! ${cardFiles.length} 张文献卡全部不合格 → 没有可进池的文献`);
    return {
      ok: false,
      rc: 1,
      validCount: 0,
      rejectedCount,
      outPath: outAbs,
      stdout: outLines.join('\n'),
      stderr: errLines.join('\n'),
    };
  }

  const outRel = path.relative(root, outAbs).replace(/\\/g, '/');
  if (dry) {
    outLines.push(`== [dry] 将拼装 ${validPaths.length}/${cardFiles.length} 张合格卡 → ${outRel}（预演不动盘）`);
  } else {
    try {
      const header = `<!-- _pool assembled by research-dispatch · valid=${validPaths.length}/${cardFiles.length} -->\n\n`;
      const chunks = validPaths.map((p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim());
      const poolContent = `${header}${chunks.join('\n\n---\n\n')}\n`;
      writeFileLfAtomic(outAbs, poolContent);
      outLines.push(`== 文献池已拼装 → ${outRel}（合格 ${validPaths.length}/${cardFiles.length}，隔离 ${rejectedCount}）`);
    } catch (e) {
      errLines.push(`!! 写入 ${outRel} 失败: ${e.message || e}`);
      return {
        ok: false,
        rc: 3,
        validCount: validPaths.length,
        rejectedCount,
        outPath: outAbs,
        stdout: outLines.join('\n'),
        stderr: errLines.join('\n'),
      };
    }
  }

  if (rejectedCount > 0) {
    errLines.push(`-- 有 ${rejectedCount} 张残卡已被隔离，池子已生成但返回 rc=1 提醒核查`);
  }

  return {
    ok: rejectedCount === 0,
    rc: rejectedCount > 0 ? 1 : 0,
    validCount: validPaths.length,
    rejectedCount,
    outPath: outAbs,
    stdout: outLines.join('\n'),
    stderr: errLines.join('\n'),
  };
}

// ── 3) serializeIdeaPool & verifyPoolProvenance ────────────────────────────────
const RESERVED_META_KEY_RE = /\b(role|model|input|isha|topic|requested|got_ideas|baseline|bsha|dead_ends_sha|warn)=/gi;

function sanitizePoolMetaToken(val, fallback = '') {
  const cleaned = String(val ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/-->/g, '--%3E')
    .replace(/<!--/g, '%3C!--')
    .replace(RESERVED_META_KEY_RE, '$1%3D')
    .trim()
    .replace(/\s+/g, '_');
  return cleaned || fallback;
}

export function serializeIdeaPool({
  role = 'diverger',
  model = 'unknown',
  input = 'papers/cards/_pool.md',
  inputName,
  baseline = 'none',
  bsha = 'none',
  isha,
  topic = '',
  requested = '',
  gotIdeas,
  got_ideas: gotIdeasSnake,
  deadEndsSha = '',
  warn = '',
  warnShort = false,
  warnSameFamily = '',
  body = '',
} = {}) {
  const cleanBody = String(body ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/, '');
  const rest = `\n${cleanBody}\n`;
  const computedIsha = sha12(Buffer.from(rest, 'utf8'));
  const finalIsha = isha ? sanitizePoolMetaToken(isha, computedIsha) : computedIsha;

  const effInput = inputName !== undefined && inputName !== null && String(inputName) !== ''
    ? inputName
    : input;
  const effGot = gotIdeas !== undefined ? gotIdeas : gotIdeasSnake;

  const parts = [
    `role=${sanitizePoolMetaToken(role, 'diverger')}`,
    `model=${sanitizePoolMetaToken(model, 'unknown')}`,
    `input=${sanitizePoolMetaToken(effInput, 'papers/cards/_pool.md')}`,
    `isha=${finalIsha}`,
    `topic=${sanitizePoolMetaToken(topic, 'default')}`,
  ];

  if (requested !== undefined && requested !== null && String(requested) !== '') {
    parts.push(`requested=${sanitizePoolMetaToken(requested)}`);
  }
  if (effGot !== undefined && effGot !== null && String(effGot) !== '') {
    parts.push(`got_ideas=${sanitizePoolMetaToken(effGot)}`);
  }

  parts.push(`baseline=${sanitizePoolMetaToken(baseline, 'none')}`);
  parts.push(`bsha=${sanitizePoolMetaToken(bsha, 'none')}`);

  if (deadEndsSha) {
    parts.push(`dead_ends_sha=${sanitizePoolMetaToken(deadEndsSha)}`);
  }

  // 合并并去重 warn 标记（每项清洗防注入）
  const warnSet = new Set();
  if (warnShort) warnSet.add('short_pool');
  if (warnSameFamily) warnSet.add(String(warnSameFamily).trim());
  if (warn) {
    for (const piece of String(warn).split(/[,\s]+/)) {
      const t = piece.trim();
      if (t) warnSet.add(t);
    }
  }
  for (const w of warnSet) {
    const safeW = sanitizePoolMetaToken(w);
    if (safeW) parts.push(`warn=${safeW}`);
  }

  const metaLine = `<!-- meta ${parts.join(' ')} -->`;
  return `${metaLine}\n${rest}`;
}

export function verifyPoolProvenance(
  poolText,
  { baselineBriefBlockPath = null, poolInputPath = null } = {},
) {
  let rawStr = '';
  if (Buffer.isBuffer(poolText)) {
    rawStr = poolText.toString('utf8');
  } else if (poolText && typeof poolText === 'object' && typeof poolText.text === 'string') {
    rawStr = poolText.text;
  } else {
    rawStr = String(poolText ?? '');
  }

  const normalized = rawStr.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const nlIdx = normalized.indexOf('\n');
  const firstLine = nlIdx >= 0 ? normalized.slice(0, nlIdx) : normalized;
  const rest = nlIdx >= 0 ? normalized.slice(nlIdx + 1) : '';
  const actualIsha = sha12(Buffer.from(rest, 'utf8'));

  const m = firstLine.match(/^\s*<!--\s*meta\s+role=diverger\b([\s\S]*?)-->\s*$/);
  if (!m) {
    const msg = "池子首行没有 'meta role=diverger' 出处行 —— 无从对账";
    return {
      ok: false,
      rc: 8,
      status: 'no-meta',
      meta: null,
      actualIsha,
      expectedBsha: null,
      problems: [msg],
      stderr: msg,
    };
  }

  const inner = m[1];
  const meta = { role: 'diverger', warns: [] };
  const tokenRe = /(?:^|\s)([A-Za-z0-9_]+)=(\S+)/g;
  let tm;
  while ((tm = tokenRe.exec(inner)) !== null) {
    const k = tm[1];
    const v = tm[2];
    if (k === 'warn') {
      meta.warns.push(v);
      meta.warn = meta.warns.join(',');
    } else if (meta[k] === undefined) {
      // 只采信首次出现的保留键，彻底阻断尾部同名键覆盖
      meta[k] = v;
    }
  }

  const missing = [];
  if (!meta.bsha) missing.push('bsha');
  if (!meta.isha) missing.push('isha');
  if (missing.length > 0) {
    const msg = `池子首行有 'meta role=diverger'，但缺指纹字段 ${missing.join('/')} —— 留壳去指纹同样无从对账`;
    return {
      ok: false,
      rc: 8,
      status: 'missing-fields',
      missing,
      meta,
      actualIsha,
      expectedBsha: null,
      problems: [msg],
      stderr: msg,
    };
  }

  const problems = [];
  if (meta.isha !== actualIsha) {
    problems.push(`池子正文指纹不匹配：发散时 ${meta.isha} ≠ 当前实算 ${actualIsha}（发散后池子正文被改动）`);
  }

  let expectedBsha = null;
  if (baselineBriefBlockPath) {
    if (!fs.existsSync(baselineBriefBlockPath) || !fs.statSync(baselineBriefBlockPath).isFile()) {
      const msg = `找不到基线 BRIEF_BLOCK.md: ${baselineBriefBlockPath}`;
      return {
        ok: false,
        rc: 8,
        status: 'missing-baseline',
        meta,
        actualIsha,
        expectedBsha: null,
        problems: [msg],
        stderr: msg,
      };
    }
    const rawBb = fs.readFileSync(baselineBriefBlockPath);
    const rawBbSha = sha12(rawBb);
    const lfBbSha = sha12(Buffer.from(rawBb.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
    expectedBsha = rawBbSha;
    if (meta.bsha !== rawBbSha && meta.bsha !== lfBbSha) {
      problems.push(`baseline 段指纹不匹配：池子记 ${meta.bsha} ≠ 当前 BRIEF_BLOCK.md 实算 ${rawBbSha}`);
    }
  }

  if (poolInputPath && meta.input) {
    const wantBase = path.basename(String(poolInputPath));
    const gotBase = path.basename(String(meta.input));
    if (wantBase && gotBase && wantBase !== gotBase) {
      problems.push(`输入文献池文件名不匹配：池子记 ${meta.input} ≠ 指定 ${poolInputPath}`);
    }
  }

  return {
    ok: problems.length === 0,
    rc: problems.length === 0 ? 0 : 8,
    status: problems.length === 0 ? 'ok' : 'mismatch',
    meta,
    actualIsha,
    expectedBsha,
    problems,
    stderr: problems.join('；'),
  };
}

// ── 4) makeBriefs ──────────────────────────────────────────────────────────────
function extractIdeaField(body, fieldName) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^[ \\t]*(?:[-*+][ \\t]*)?(?:\\*\\*)?[ \\t]*${escaped}[ \\t]*(?:\\*\\*)?[ \\t]*[：:][ \\t]*(.*)$`, 'mi');
  const m = String(body || '').match(re);
  return m ? m[1].trim() : null;
}

function parseSignedFloat(pat, text) {
  const m = String(text || '').match(pat);
  if (!m) return null;
  const norm = m[1].replace(/\u2212/g, '-').replace(/\uFF0D/g, '-');
  const val = Number(norm);
  return Number.isFinite(val) ? val : null;
}

export function makeBriefs(
  rootDir,
  rawPoolPath,
  {
    baselineDir = null,
    topic = null,
    outDir = null,
    force = false,
    dry = false,
    allowReanchor = false,
    allowNoProvenance = false,
  } = {},
) {
  const root = path.resolve(String(rootDir || process.cwd()));
  const effDry = Boolean(dry) || process.env.DRY === '1';
  const effAllowReanchor = Boolean(allowReanchor) || process.env.ALLOW_REANCHOR === '1';
  const effAllowNoProv = Boolean(allowNoProvenance) || process.env.ALLOW_NO_PROVENANCE === '1';

  const cleanTopic = topic !== null && topic !== undefined ? String(topic).trim() : '';
  if (cleanTopic && (!/^[A-Za-z0-9._-]+$/.test(cleanTopic) || cleanTopic === '.' || cleanTopic === '..')) {
    return {
      ok: false,
      rc: 1,
      created: [],
      rejected: [],
      outDir: '',
      stdout: '',
      stderr: `非法的 --topic 课题名: ${JSON.stringify(cleanTopic)}`,
    };
  }

  const rawArg = String(rawPoolPath || '').trim();
  if (!rawArg) {
    return {
      ok: false,
      rc: 1,
      created: [],
      rejected: [],
      outDir: '',
      stdout: '',
      stderr: '用法: briefs <raw-pool.md> [--topic <slug>] [--baseline <dir>]',
    };
  }
  const srcAbs = path.isAbsolute(rawArg) ? path.resolve(rawArg) : path.resolve(root, rawArg);
  if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) {
    return {
      ok: false,
      rc: 1,
      created: [],
      rejected: [],
      outDir: '',
      stdout: '',
      stderr: `找不到 idea 池文件: ${rawPoolPath}`,
    };
  }

  const targetOutAbs = outDir
    ? (path.isAbsolute(outDir) ? path.resolve(outDir) : path.resolve(root, outDir))
    : (cleanTopic ? path.join(root, 'ideas', cleanTopic, 'briefs') : path.join(root, 'ideas', 'briefs'));

  if (!isInsideRoot(root, targetOutAbs)) {
    return {
      ok: false,
      rc: 2,
      created: [],
      rejected: [],
      outDir: targetOutAbs,
      stdout: '',
      stderr: `输出目录越出项目根目录: ${outDir}`,
    };
  }
  const targetOutRel = path.relative(root, targetOutAbs).replace(/\\/g, '/');

  // 1) 基线锚点与 BRIEF_BLOCK.md 校验（兼容有基线锚定与 anchor=none 无锚探索）
  const rawBaseArg = baselineDir !== null && baselineDir !== undefined ? String(baselineDir).trim() : '';
  const hasBaselineArg = Boolean(rawBaseArg && rawBaseArg.toLowerCase() !== 'none');

  let bbAbs = null;
  let anchorLabel = 'none';
  let bsha = 'none';
  let baselineText = '无已签字复现基线（anchor=none 轻量探索轮，基准参考 Δ = 0.00pp；送入重实验前须在最小证伪实验中实测对照并核定 2σ 噪声底）。';

  if (hasBaselineArg) {
    const baseAbs = path.isAbsolute(rawBaseArg) ? path.resolve(rawBaseArg) : path.resolve(root, rawBaseArg);
    if (!isInsideRoot(root, baseAbs)) {
      return {
        ok: false,
        rc: 2,
        created: [],
        rejected: [],
        outDir: targetOutRel,
        stdout: '',
        stderr: `baseline 目录越出项目根目录: ${rawBaseArg}`,
      };
    }
    anchorLabel = path.relative(root, baseAbs).replace(/\\/g, '/').replace(/\/+$/, '');
    bbAbs = path.join(baseAbs, 'BRIEF_BLOCK.md');
    if (!fs.existsSync(bbAbs) || !fs.statSync(bbAbs).isFile()) {
      return {
        ok: false,
        rc: 8,
        created: [],
        rejected: [],
        outDir: targetOutRel,
        stdout: '',
        stderr: `找不到共享基线块: ${anchorLabel}/BRIEF_BLOCK.md`,
      };
    }
    const bbBuf = fs.readFileSync(bbAbs);
    if (bbBuf.byteLength < 200) {
      return {
        ok: false,
        rc: 8,
        created: [],
        rejected: [],
        outDir: targetOutRel,
        stdout: '',
        stderr: `${anchorLabel}/BRIEF_BLOCK.md 不足 200 字节（实得 ${bbBuf.byteLength} 字节）—— 基线过薄会导致盲审缺乏统一口径`,
      };
    }
    const bbContent = bbBuf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
    if (/^[ \t]*###[ \t]+Idea\b/im.test(bbContent)) {
      return {
        ok: false,
        rc: 8,
        created: [],
        rejected: [],
        outDir: targetOutRel,
        stdout: '',
        stderr: `${anchorLabel}/BRIEF_BLOCK.md 内含非法的 '### Idea' 子标题 —— 会截断后续工单结构`,
      };
    }
    const ac = checkAnchor(root, anchorLabel);
    if (ac.rc === 2) {
      return {
        ok: false,
        rc: 2,
        created: [],
        rejected: [],
        outDir: targetOutRel,
        stdout: '',
        stderr: ac.stderr || `基线锚点检查器报错: ${anchorLabel}`,
      };
    }
    if (!ac.ok) {
      return {
        ok: false,
        rc: 8,
        created: [],
        rejected: [],
        outDir: targetOutRel,
        stdout: '',
        stderr: `${ac.stderr}\n  ↑ 未通过签字验收的基线不能拆单进盲审`,
      };
    }
    bsha = sha12(Buffer.from(bbContent.replace(/\r\n/g, '\n'), 'utf8'));
    baselineText = bbContent;
  }

  // 2) 池子出处对账（isha + bsha）
  const srcBuf = fs.readFileSync(srcAbs);
  const prov = verifyPoolProvenance(srcBuf, { baselineBriefBlockPath: bbAbs });

  let metaWarnToken = '';
  const outLines = [];
  const errLines = [];

  if (prov.status === 'no-meta' || prov.status === 'missing-fields') {
    if (!effAllowNoProv) {
      return {
        ok: false,
        rc: 8,
        created: [],
        rejected: [],
        outDir: targetOutRel,
        stdout: '',
        stderr: `✗ ${prov.stderr}\n  若确需导入历史无头池子，请显式传 --allow-no-provenance（工单将留 warn=no-provenance 痕）`,
      };
    }
    metaWarnToken = 'no-provenance';
    outLines.push('⚠ --allow-no-provenance 已显式放行：工单 meta 将记 warn=no-provenance');
  } else {
    // 若未传 --baseline，但池子本身带了非 none 的基线 bsha，同样属于锚点错配
    const extraMismatch = (!hasBaselineArg && prov.meta && prov.meta.bsha && prov.meta.bsha !== 'none')
      ? [`池子发散时绑定了基线 (${prov.meta.baseline || prov.meta.bsha})，拆单时不能漏传 --baseline`]
      : [];
    const allProvProbs = [...prov.problems, ...extraMismatch];
    if (allProvProbs.length > 0) {
      if (!effAllowReanchor) {
        return {
          ok: false,
          rc: 8,
          created: [],
          rejected: [],
          outDir: targetOutRel,
          stdout: '',
          stderr: `✗ 出处对账未通过：${allProvProbs.join('；')}\n  正解：按当前基线重跑 diverge；确需跨基线复用请显式传 --allow-reanchor`,
        };
      }
      metaWarnToken = 'provenance-mismatch';
      outLines.push('⚠ --allow-reanchor 已显式强过：工单 meta 将记 warn=provenance-mismatch');
    }
  }

  // 3) 切分 ### idea_NN 并逐条校验
  const rawText = srcBuf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const parts = rawText.split(/^(?=[ \t]*#{2,4}[ \t]*idea_\d+\b)/m);
  const ideas = new Map();
  const order = [];

  for (let idx = 1; idx < parts.length; idx += 1) {
    const seg = parts[idx];
    const hm = seg.match(/^[ \t]*#{2,4}[ \t]*(idea_\d+)\b([^\n]*)/);
    if (!hm) continue;
    const iid = hm[1];
    const restLine = hm[2] || '';
    if (ideas.has(iid)) {
      return {
        ok: false,
        rc: 1,
        created: [],
        rejected: [],
        outDir: targetOutRel,
        stdout: '',
        stderr: `✗ 编号重复 ${iid}（同一池子内出现两次）→ 拒绝整轮拆单`,
      };
    }
    const cleanTitle = restLine.trim().replace(/^[｜|:\-—\s]+/, '').trim();
    const ideaBody = seg.slice(hm[0].length).trim();
    ideas.set(iid, { title: cleanTitle, body: ideaBody });
    order.push(iid);
  }

  if (order.length === 0) {
    return {
      ok: false,
      rc: 1,
      created: [],
      rejected: [],
      outDir: targetOutRel,
      stdout: '',
      stderr: "✗ 池子里一条 idea 都没解析到（期望包含 '### idea_NN <标题>' 分节）",
    };
  }

  const created = [];
  const skipped = [];
  const rejected = [];
  const warned = [];
  const superseded = [];
  const hypSignatures = new Map();

  for (const iid of order) {
    const { title, body } = ideas.get(iid);
    try {
      const hyp = extractIdeaField(body, '假设');
      const method = extractIdeaField(body, '做法');
      const pred = extractIdeaField(body, '预测');
      const miss = [];
      if (!hyp) miss.push('假设');
      if (!method) miss.push('做法');
      if (!pred) miss.push('预测');
      if (miss.length > 0) {
        rejected.push({ id: iid, reason: `缺必填段 ${miss.join('/')}（不向盲审投喂半成品）` });
        continue;
      }

      const falsifier = extractIdeaField(body, '最小证伪实验');
      if (!falsifier) {
        warned.push({ id: iid, reason: '缺少『最小证伪实验』段' });
      }

      if (!hasAnyNumber(pred)) {
        rejected.push({ id: iid, reason: '『预测』缺少可证伪数值（纯章节图表交叉引用如“见 3.2 节”不算数值）' });
        continue;
      }

      if (body.length < 120) {
        rejected.push({ id: iid, reason: `正文只有 ${body.length} 字符（不足 120），疑似被截断` });
        continue;
      }

      const blockLines = [
        '## 待评审材料（唯一输入）',
        '',
        '### Baseline',
        baselineText,
        '',
        '### Idea',
        `**ID**: ${iid}`,
      ];
      if (title) blockLines.push(`**标题**: ${title}`);
      blockLines.push('', body);
      const briefBody = `${blockLines.join('\n')}\n`;

      // 单条自包含与串写硬校验：拦截跨条引用其它 idea_XX 或“同上一条/见上一条”
      const mentionedIds = Array.from(new Set(briefBody.match(/\bidea_\d+\b/g) || []));
      const foreignIds = mentionedIds.filter((x) => x !== iid).sort();
      if (foreignIds.length > 0) {
        rejected.push({
          id: iid,
          reason: `跨条引用污染：正文引用了其他候选 [${foreignIds.join(', ')}] —— 每份盲审工单必须 100% 独立自包含`,
        });
        continue;
      }
      if (/(?:同|见|参见|沿用|照搬)\s*上一?条/.test(body)) {
        rejected.push({
          id: iid,
          reason: '跨条引用违规：正文出现“同上一条/见上一条”指代 —— 盲审员无法看到其他候选工单',
        });
        continue;
      }

      // 40 字假设前缀去重防撞车
      const hypSig = hyp.replace(/\s+/g, '').slice(0, 40);
      if (hypSignatures.has(hypSig)) {
        rejected.push({
          id: iid,
          reason: `与 ${hypSignatures.get(hypSig)} 的『假设』前 40 字完全相同，疑似重复候选撞车`,
        });
        continue;
      }
      hypSignatures.set(hypSig, iid);

      // 主读数与 2σ 噪声底判据核验
      const readout = extractIdeaField(body, '主读数');
      const judge = extractIdeaField(body, '判据');
      if (!readout) {
        rejected.push({ id: iid, reason: '缺『主读数』字段（须以 acc 或 cost 开头声明交付指标）' });
        continue;
      }
      if (!judge) {
        rejected.push({ id: iid, reason: '缺『判据』字段（未声明 2σ 噪声底或可比成本判据）' });
        continue;
      }

      const kind = readout.trim().split(/\s+/)[0].toLowerCase();
      if (kind === 'acc' || kind === 'score' || kind === '分数') {
        const gain = parseSignedFloat(/([+\u2212\uFF0D-]?[0-9]+(?:\.[0-9]+)?)\s*pp/i, readout);
        const floor = parseSignedFloat(/2\s*(?:σ|sigma|se)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*pp/i, judge);
        if (gain === null) {
          rejected.push({ id: iid, reason: '『主读数』为 acc 型但缺少可解析的 ±X.XXpp 变化量' });
          continue;
        }
        if (floor === null) {
          rejected.push({ id: iid, reason: '『判据』缺少 2σ=Y.YYpp 噪声下限声明' });
          continue;
        }
        if (gain < floor) {
          const signStr = gain >= 0 ? `+${gain.toFixed(2)}` : gain.toFixed(2);
          rejected.push({
            id: iid,
            reason: `预测增益 ${signStr}pp < 自报判据 2σ=${floor.toFixed(2)}pp —— 落在统计噪声带内，不送审`,
          });
          continue;
        }
      } else if (kind === 'cost') {
        if (!hasAnyNumber(judge)) {
          rejected.push({ id: iid, reason: '『主读数』为 cost 型但『判据』未提供可量化数值门槛' });
          continue;
        }
      } else {
        rejected.push({ id: iid, reason: `『主读数』必须以 acc 或 cost 开头（实得 ${JSON.stringify(kind)}）` });
        continue;
      }

      // warn 严格置于 anchor= 之前，保证 anchor=... --> 尾部路径（即使含空格）可无损解析
      const warnSlot = metaWarnToken ? ` warn=${metaWarnToken}` : '';
      const poolBase = sanitizePoolMetaToken(path.basename(srcAbs), 'raw.md');
      const metaHeader = `<!-- meta role=brief idea=${iid} bsha=${bsha} pool=${poolBase}${warnSlot} anchor=${anchorLabel} -->\n`;

      const outFileAbs = path.join(targetOutAbs, `${iid}.md`);
      const outFileRel = path.relative(root, outFileAbs).replace(/\\/g, '/');

      if (fs.existsSync(outFileAbs) && !force) {
        skipped.push(`${iid}（已存在；如需覆盖并归档旧单请传 --force）`);
        continue;
      }

      if (effDry) {
        created.push(outFileRel);
        continue;
      }

      fs.mkdirSync(targetOutAbs, { recursive: true });
      if (fs.existsSync(outFileAbs) && force) {
        const supDir = path.join(targetOutAbs, '.superseded');
        fs.mkdirSync(supDir, { recursive: true });
        const oldSha = sha12(fs.readFileSync(outFileAbs));
        const supRel = `${targetOutRel}/.superseded/${iid}.${oldSha}.md`;
        moveFileSafe(outFileAbs, path.join(supDir, `${iid}.${oldSha}.md`));
        superseded.push(`${iid} → ${supRel}`);
      }

      writeFileLfAtomic(outFileAbs, metaHeader + briefBody);
      created.push(outFileRel);
    } catch (e) {
      rejected.push({ id: iid, reason: `单条解析异常: ${e.message || e}` });
    }
  }

  outLines.push(`解析到 ${order.length} 条候选，baseline 段共享 ${Buffer.byteLength(baselineText, 'utf8')} 字节 → ${targetOutRel}`);
  for (const c of created) outLines.push(`  ✓ ${c}${effDry ? ' [dry]' : ''}`);
  for (const s of skipped) outLines.push(`  ⏭ ${s}`);
  for (const sup of superseded) outLines.push(`  🗄 旧件留痕: ${sup}`);
  for (const w of warned) outLines.push(`  ⚠ ${w.id}: ${w.reason}`);
  for (const r of rejected) errLines.push(`  ✗ ${r.id}: ${r.reason}`);
  outLines.push(`可送审 ${created.length} 条；被拦 ${rejected.length} 条；警告 ${warned.length} 条`);

  if (created.length === 0) {
    errLines.push('✗ 一条工单都未产出 —— 按退出码契约返回 rc=1');
    return {
      ok: false,
      rc: 1,
      created,
      skipped,
      superseded,
      warned,
      rejected,
      outDir: targetOutRel,
      stdout: outLines.join('\n'),
      stderr: errLines.join('\n'),
    };
  }

  return {
    ok: true,
    rc: 0,
    created,
    skipped,
    superseded,
    warned,
    rejected,
    outDir: targetOutRel,
    stdout: outLines.join('\n'),
    stderr: errLines.join('\n'),
  };
}

// ── 5) checkNoveltyReport ──────────────────────────────────────────────────────
const NOVELTY_RISKS = new Set(['low', 'mid', 'high']);
const NOVELTY_SRC_RE = /arxiv|semantic\s*scholar|google\s*scholar|crossref|openalex|pubmed|scopus|web\s*of\s*science|openreview|acl\s*anthology|dblp|mcp|websearch|检索式|检索词|检索渠道|关键词|数据库|搜索引擎/i;
const NOVELTY_NEG_CONCL_RE = /未|没有|未见|未发现|零结果|无直接|no\s+(?:direct|prior|related|close)|not\s+found|none\s+found/i;

export function checkNoveltyReport(reportPath) {
  const target = String(reportPath || '').trim();
  if (!target) {
    return { ok: false, rc: 2, data: null, stderr: '未提供查重报告文件路径' };
  }
  let st;
  try {
    st = fs.statSync(target);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: false, rc: 2, data: null, stderr: `找不到文件: ${target}` };
    }
    return { ok: false, rc: 3, data: null, stderr: `读取查重报告状态异常: ${e.message || e}` };
  }
  if (!st.isFile()) {
    return { ok: false, rc: 2, data: null, stderr: `路径不是普通文件: ${target}` };
  }

  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (e) {
    return { ok: false, rc: 3, data: null, stderr: `读取查重报告异常: ${e.message || e}` };
  }

  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const body = normalized.replace(/<!--[\s\S]*?-->/, '');
  if (body.trim().length < 30) {
    const msg = `正文只有 ${body.trim().length} 字符，疑似被截断`;
    return { ok: false, rc: 1, data: null, problems: [msg], stderr: `✗ ${path.basename(target)}\n  · ${msg}` };
  }

  let yamlBlock = null;
  let prefix = '';
  let suffix = '';
  const fm = body.match(/```(?:yaml|yml)?[ \t]*\n([\s\S]*?)```/i);
  if (fm) {
    yamlBlock = fm[1];
    prefix = body.slice(0, fm.index);
    suffix = body.slice(fm.index + fm[0].length);
  } else {
    const lines = body.split('\n');
    const startIdx = lines.findIndex((l) => /^[ \t]*idea_id[ \t]*:/.test(l));
    if (startIdx < 0) {
      const msg = '找不到 idea_id: 行（查重报告未按 YAML 契约输出）';
      return { ok: false, rc: 1, data: null, problems: [msg], stderr: `✗ ${path.basename(target)}\n  · ${msg}` };
    }
    prefix = lines.slice(0, startIdx).join('\n');
    yamlBlock = lines.slice(startIdx).join('\n');
  }

  let data;
  try {
    data = parseStructuredYaml(yamlBlock);
  } catch (e) {
    const msg = `YAML 解析失败: ${e.message || e}`;
    return { ok: false, rc: 1, data: null, problems: [msg], stderr: `✗ ${path.basename(target)}\n  · ${msg}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const msg = '查重报告解析结果不是键值映射';
    return { ok: false, rc: 1, data: null, problems: [msg], stderr: `✗ ${path.basename(target)}\n  · ${msg}` };
  }

  const probs = [];
  const rawStem = expectStemId(target);
  const canonicalWant = rawStem ? rawStem.replace(/^novelty[-_]/i, '') : null;
  const gotId = data.idea_id === null || data.idea_id === undefined ? '' : String(data.idea_id).trim();
  if (canonicalWant && !gotId) {
    probs.push(`缺 idea_id（文件名推出应为 ${canonicalWant}）—— 报告无法归属到具体候选`);
  } else if (canonicalWant && gotId !== canonicalWant && gotId !== rawStem) {
    probs.push(`idea_id 与文件名不符：文件指向 ${canonicalWant}，报告写 ${gotId}`);
  }

  const risk = data.duplication_risk === null || data.duplication_risk === undefined
    ? ''
    : String(data.duplication_risk).trim().toLowerCase();
  if (!NOVELTY_RISKS.has(risk)) {
    probs.push(`duplication_risk 非法: ${JSON.stringify(data.duplication_risk)}（要求 low / mid / high）`);
  }

  const works = data.closest_works;
  if (works !== undefined && works !== null && !Array.isArray(works)) {
    probs.push('closest_works 必须是列表（无相近工作时写 []）');
  }
  const hasTitledWork = Array.isArray(works) && works.some(
    (w) => w && typeof w === 'object' && !Array.isArray(w)
      && String(w.title || '').trim().length > 0
      && !tooThinReason(String(w.title || '').trim()),
  );

  if (NOVELTY_RISKS.has(risk) && !hasTitledWork) {
    const noteText = typeof data.note === 'string' ? data.note : String(data.note ?? '');
    const srcOk = NOVELTY_SRC_RE.test(noteText);
    const conclOk = NOVELTY_NEG_CONCL_RE.test(noteText);
    if (risk === 'high') {
      probs.push('duplication_risk=high 但 closest_works 未给出任何具名论文标题 —— 高撞车判定必须附真实出处');
    } else if (!srcOk || !conclOk) {
      probs.push(
        'closest_works 为空时，note 必须同时写明检索源（arXiv / Semantic Scholar / 关键词等）与未检出直接前人工作的明确结论',
      );
    }
  }

  const conf = data.confidence;
  if (typeof conf === 'boolean' || conf === null || conf === undefined || String(conf).trim() === '') {
    probs.push(`confidence 非法: ${JSON.stringify(conf)}（要求 0.0~1.0 数值，不接受布尔值或空值）`);
  } else if (typeof conf === 'string' && /^(?:yes|no|true|false)$/i.test(conf.trim())) {
    probs.push(`confidence 非法: ${JSON.stringify(conf)}（要求 0.0~1.0 数值）`);
  } else {
    const numConf = Number(conf);
    if (!Number.isFinite(numConf) || numConf < 0.0 || numConf > 1.0) {
      probs.push(`confidence 非法: ${JSON.stringify(conf)}（要求落在 [0.0, 1.0] 闭区间）`);
    }
  }

  const preProse = cleanOutsideProse(prefix);
  if (preProse.length > 30) {
    probs.push(`报告之前夹带了 ${preProse.length} 字额外散文（阈值 30，契约要求只输出 YAML 块）`);
  }
  const sufProse = cleanOutsideProse(suffix);
  if (sufProse.length > 30) {
    probs.push(`报告之后还有 ${sufProse.length} 字额外正文（阈值 30，契约要求只输出报告）：${sufProse.slice(0, 50).replace(/\n/g, ' ')}…`);
  }

  if (probs.length > 0) {
    return {
      ok: false,
      rc: 1,
      data,
      problems: probs,
      stderr: `✗ ${path.basename(target)}\n${probs.map((p) => `  · ${p}`).join('\n')}`,
    };
  }

  return {
    ok: true,
    rc: 0,
    data,
    problems: [],
    stdout: `✓ ${path.basename(target)}`,
    stderr: '',
  };
}

// ── 6) checkContractFile ───────────────────────────────────────────────────────
const CHANGELOG_HEADER = [
  '# CHANGELOG',
  '',
  '契约变更只允许追加，不允许修改已冻结的契约。请通过 `npx research-dispatch check-contract <contract.md> --record` 自动登记指纹。',
  '',
  '| 日期 | 文件 | v1 → v2 | 改了什么 | 为什么 |',
  '|---|---|---|---|---|',
  '',
].join('\n');

function extractContractSection(text, secNum) {
  const re = new RegExp(`^##[ \\t]*(?:§[ \\t]*)?${secNum}(?:\\.|\\b)[^\\n]*\\n([\\s\\S]*?)(?=^##[ \\t]|(?![\\s\\S]))`, 'm');
  const m = text.match(re);
  return m ? m[1] : null;
}

// 精准识别契约中的 `<exp_id>` / `<M>` / `<具体机制改动 X>` 等模板占位符，
// 同时放行 `<= -1.5pp` ... `>= 3.0pp`、`< 0.35` ... `> +1.5pp`、`->`、`p<0.05`、`loss<tau` 等数学比较与箭头。
const CONTRACT_PLACEHOLDER_RE = /(?<![A-Za-z0-9_])<(?=[A-Za-z_\u4e00-\u9fff])[^<>`\r\n=；。]{0,120}[A-Za-z0-9_\u4e00-\u9fff)）]>/;

function isContractPlaceholder(val) {
  const s = String(val ?? '').trim();
  if (!s) return true;
  const unquoted = s.replace(/^`+|`+$/g, '').trim();
  if (!unquoted) return true;
  if (/^[_/`—\-.\s]+$/.test(unquoted)) return true;
  if (CONTRACT_PLACEHOLDER_RE.test(unquoted)) return true;
  if (/^(?:todo|tbd|n\/a|na|待补|待定|占位|yyyy-mm-dd)$/i.test(unquoted)) return true;
  return false;
}

function extractSectionKeyVal(secText, keyPatterns) {
  if (!secText) return null;
  const lines = secText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 1) Markdown 表格行：| key | value |
    if (trimmed.startsWith('|') && !/^\|[\s:|-]+\|$/.test(trimmed)) {
      const cells = trimmed.split('|').map((c) => c.trim());
      if (cells.length >= 3) {
        const kCell = cells[1].replace(/\*\*/g, '').trim();
        if (keyPatterns.some((re) => re.test(kCell))) {
          return { found: true, value: cells[2] };
        }
      }
    }
    // 2) 列表或键值行：- **key**: value 或 key: value
    const kv = trimmed.match(/^(?:[-*+]\s*)?(?:\*\*)?([^:*\n]+?)(?:\*\*)?\s*[：:]\s*(.*)$/);
    if (kv) {
      const kName = kv[1].trim();
      if (keyPatterns.some((re) => re.test(kName))) {
        return { found: true, value: kv[2].trim() };
      }
    }
  }
  return { found: false, value: '' };
}

function extractSignalItems(secText, prefixLetter) {
  if (!secText) return [];
  const re = new RegExp(
    `^[ \\t]*(?:[-*+][ \\t]*)?(?:\\*\\*)?${prefixLetter}\\d+(?:[（(][^）)\\n]*[）)])?(?:\\*\\*)?[ \\t]*[：:][ \\t]*(.*)$`,
    'gm',
  );
  const items = [];
  let m;
  while ((m = re.exec(secText)) !== null) {
    items.push(m[1].trim());
  }
  return items;
}

function negationSkeleton(line) {
  const noNeg = String(line || '').replace(/(没有|没|未|不|无|无法|缺|非|未能|not\s+|non-?)/gi, '');
  return noNeg.replace(/[0-9\uFF10-\uFF19\s±≥≤><=→+%％.，,。;；:：()（）【】[\]|/\\*~^　`"'-]/g, '').toLowerCase();
}

function findFrozenShaInChangelog(changelogText, fileName) {
  if (!changelogText) return null;
  let lastSha = null;
  const lines = String(changelogText).replace(/\r\n/g, '\n').split('\n');
  for (const ln of lines) {
    const t = ln.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').map((c) => c.trim());
    if (cells.length < 5) continue;

    // 新版 5 列格式：| 日期 | 文件 | FROZEN (sha12:xxxxxxxxxxxx) | 改了什么 | 为什么 |
    if (cells[2] === fileName) {
      const mNew = cells[3].match(/FROZEN\s*\(\s*sha12\s*:\s*([0-9a-f]{12})\s*\)/i);
      if (mNew) {
        lastSha = mNew[1].toLowerCase();
        continue;
      }
    }
    // 兼容旧版 5 列格式：| FROZEN | <fileName> | <12hex> | <date> | <note> |
    if (cells[1] === 'FROZEN' && cells[2] === fileName && /^[0-9a-f]{12}$/i.test(cells[3])) {
      lastSha = cells[3].toLowerCase();
    }
  }
  return lastSha;
}

function parseContractVersionChain(fileName) {
  const m = String(fileName || '').match(/^(.+)\.v(\d+)\.md$/i);
  if (!m) return null;
  return { base: m[1], ver: Number(m[2]) };
}

export function checkContractFile(
  contractPath,
  { rootDir = null, record = false, reRecord = false, reason = '' } = {},
) {
  const target = String(contractPath || '').trim();
  if (!target) {
    return { ok: false, rc: 2, sha12: null, stdout: '', stderr: '未提供契约文件路径' };
  }

  let st;
  try {
    st = fs.statSync(target);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: false, rc: 2, sha12: null, stdout: '', stderr: `找不到契约文件: ${target}` };
    }
    return { ok: false, rc: 3, sha12: null, stdout: '', stderr: `读取契约状态异常: ${e.message || e}` };
  }
  if (!st.isFile()) {
    return { ok: false, rc: 2, sha12: null, stdout: '', stderr: `路径不是契约文件: ${target}` };
  }

  let rawBuf;
  try {
    rawBuf = fs.readFileSync(target);
  } catch (e) {
    return { ok: false, rc: 3, sha12: null, stdout: '', stderr: `读取契约文件异常: ${e.message || e}` };
  }

  // [D-2] 修复 1：计算 sha12 前统一剥除 BOM 并将 \r\n 归一为 \n，杜绝跨平台换行转换误判篡改
  const text = rawBuf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const digest = sha12(Buffer.from(text, 'utf8'));
  const contractAbs = path.resolve(target);
  const contractDir = path.dirname(contractAbs);
  const name = path.basename(contractAbs);
  const changelogAbs = path.join(contractDir, 'CHANGELOG.md');

  const probs = [];

  // §0 元信息
  const sec0 = extractContractSection(text, 0);
  if (sec0 === null) {
    probs.push('缺 §0 元信息节');
  } else {
    const expRow = extractSectionKeyVal(sec0, [/^exp_id$/i]);
    if (!expRow.found) probs.push('§0 缺 exp_id 行');
    else if (isContractPlaceholder(expRow.value)) probs.push('§0 的 exp_id 没填值（模板占位不算）');

    const baseRow = extractSectionKeyVal(sec0, [/^baseline$/i]);
    if (!baseRow.found) {
      probs.push('§0 缺 baseline 行');
    } else if (isContractPlaceholder(baseRow.value)) {
      probs.push('§0 的 baseline 没填值（模板占位不算）');
    } else if (rootDir) {
      const rootAbs = path.resolve(String(rootDir));
      const cleanBaseToken = baseRow.value
        .replace(/[`'"]/g, '')
        .trim()
        .split(/[\s（(]/)[0]
        .replace(/[\\/]+$/, '');
      if (cleanBaseToken && cleanBaseToken.toLowerCase() !== 'none') {
        const candBaseAbs = path.isAbsolute(cleanBaseToken)
          ? path.resolve(cleanBaseToken)
          : path.resolve(rootAbs, cleanBaseToken);
        if (isInsideRoot(rootAbs, candBaseAbs) && fs.existsSync(candBaseAbs) && fs.statSync(candBaseAbs).isDirectory()) {
          const ac = checkAnchor(rootAbs, path.relative(rootAbs, candBaseAbs).replace(/\\/g, '/'));
          if (!ac.ok) {
            probs.push(`§0 指向的基线目录 (${cleanBaseToken}) 未通过 SIGNOFF: PASS 签字验收：${ac.stderr}`);
          }
        }
      }
    }

    const dsRow = extractSectionKeyVal(sec0, [/数据集|dataset|split|benchmark/i]);
    if (!dsRow.found) probs.push('§0 缺 数据集与 split 行');
    else if (isContractPlaceholder(dsRow.value)) probs.push('§0 的 数据集与 split 没填值（模板占位不算）');
  }

  // §1 Hypothesis
  const sec1 = extractContractSection(text, 1);
  if (sec1 === null || !sec1.replace(/#/g, '').trim()) {
    probs.push('缺 §1 Hypothesis 或内容为空');
  } else if (CONTRACT_PLACEHOLDER_RE.test(sec1)) {
    probs.push('§1 Hypothesis 仍残留未替换的 <...> 模板占位符');
  } else if (!hasThresholdNumber(sec1)) {
    probs.push('§1 Hypothesis 没有阈值语境的数值（需含比较符/箭头/±/百分比/单位；纯交叉引用如“见 3.2 节”不算）');
  }

  // §2 四个实现锚点
  const sec2 = extractContractSection(text, 2);
  if (sec2 === null) {
    probs.push('缺 §2 实现锚点节');
  } else {
    const anchors = [
      { label: '超参', pats: [/超参|hyperparam/i] },
      { label: 'metric', pats: [/metric|指标/i] },
      { label: '计算预算', pats: [/计算预算|budget/i] },
      { label: '代码对应', pats: [/代码对应|code/i] },
    ];
    for (const a of anchors) {
      const kv = extractSectionKeyVal(sec2, a.pats);
      if (!kv.found || isContractPlaceholder(kv.value)) {
        probs.push(`§2 的『${a.label}』没有填值 —— 留空或模板占位等于让执行者事后自由裁量`);
      }
    }
  }

  // §3 成功信号 S
  const sec3 = extractContractSection(text, 3);
  const sItems = extractSignalItems(sec3, 'S');
  if (sItems.length === 0) {
    probs.push('缺 §3 成功信号（或一条 S1/S2 信号都没有）');
  }
  sItems.forEach((body, idx) => {
    if (!body || isContractPlaceholder(body)) {
      probs.push(`§3 第 ${idx + 1} 条成功信号为空或仍为模板占位`);
    } else if (!hasThresholdNumber(body)) {
      probs.push(`§3 第 ${idx + 1} 条成功信号没有阈值语境的数值（不接受“有明显提升”，纯交叉引用不算）`);
    }
  });

  // §4 失败信号 F（含非字面反面启发式）
  const sec4 = extractContractSection(text, 4);
  const fItems = extractSignalItems(sec4, 'F');
  if (fItems.length === 0) {
    probs.push('缺 §4 失败信号（或一条 F 信号都没有）—— 独立止损线是契约存在的核心理由');
  }
  fItems.forEach((body, idx) => {
    if (!body || isContractPlaceholder(body)) {
      probs.push(`§4 第 ${idx + 1} 条失败信号为空或仍为模板占位`);
    } else if (!hasThresholdNumber(body)) {
      probs.push(`§4 第 ${idx + 1} 条失败信号没有阈值语境的数值 —— 不可判定的失败信号等于没有`);
    } else {
      const fSkel = negationSkeleton(body);
      if (fSkel && sItems.some((s) => negationSkeleton(s) === fSkel)) {
        probs.push(`§4 第 ${idx + 1} 条失败信号疑似某条成功信号的字面反面 —— 独立失败信号须写独立止损机制或退化指标`);
      }
    }
  });

  // §5 消融表（[D-9] 修复：至少 1 行第 2 列与第 3 列均真实非空且非占位符）
  const sec5 = extractContractSection(text, 5);
  if (sec5 === null) {
    probs.push('缺 §5 Ablation 消融预期节');
  } else {
    const dataRows = sec5
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('|') && !/^\|[\s:|-]+\|$/.test(l))
      .map((l) => l.split('|').map((c) => c.trim()))
      .filter((cells) => cells.length >= 4 && !/ablation/i.test(cells[1]));

    if (dataRows.length === 0) {
      probs.push('§5 ablation 表里一行预期都没有');
    } else {
      const filledRows = dataRows.filter(
        (cells) => !isContractPlaceholder(cells[1])
          && !isContractPlaceholder(cells[2])
          && !isContractPlaceholder(cells[3]),
      );
      if (filledRows.length === 0) {
        probs.push('§5 ablation 表里一行预期都没有（第 2 列『预期看到什么』与第 3 列『若看到相反结果说明什么』均不得留空或保留模板占位）');
      }
    }
  }

  // §6 防事后合理化条款
  const sec6 = extractContractSection(text, 6);
  if (sec6 === null || !sec6.trim()) {
    probs.push('缺 §6 防事后合理化条款节');
  }

  if (probs.length > 0) {
    return {
      ok: false,
      rc: 1,
      sha12: digest,
      problems: probs,
      stdout: '',
      stderr: `✗ ${name}\n${probs.map((p) => `  · ${p}`).join('\n')}\n${name} 不合格 —— 契约不能带病冻结`,
    };
  }

  // 读取同目录 CHANGELOG.md
  let changelogText = '';
  if (fs.existsSync(changelogAbs)) {
    try {
      changelogText = fs.readFileSync(changelogAbs, 'utf8');
    } catch (e) {
      return {
        ok: false,
        rc: 3,
        sha12: digest,
        stdout: '',
        stderr: `读取 CHANGELOG.md 异常: ${e.message || e}`,
      };
    }
  }

  const existingSha = findFrozenShaInChangelog(changelogText, name);

  // [D-2] 修复 2：逐级核查 .vN -> .v(N-1) -> ... -> .v1/.md 完整前驱冻结链，不依赖磁盘文件是否被删改名逃逸
  const verInfo = parseContractVersionChain(name);
  if (verInfo && verInfo.ver >= 2) {
    for (let k = verInfo.ver - 1; k >= 1; k -= 1) {
      if (k >= 2) {
        const prevName = `${verInfo.base}.v${k}.md`;
        const prevSha = findFrozenShaInChangelog(changelogText, prevName);
        if (!prevSha) {
          const msg = `✗ ${name} 是 v${verInfo.ver} 契约，但前驱版本 ${prevName} 在 CHANGELOG.md 中无冻结记录 —— 按逃逸改名拦截`;
          return { ok: false, rc: 1, sha12: digest, stdout: '', stderr: msg };
        }
      } else {
        const v1Dot = `${verInfo.base}.v1.md`;
        const v1Plain = `${verInfo.base}.md`;
        const v1Sha = findFrozenShaInChangelog(changelogText, v1Dot) || findFrozenShaInChangelog(changelogText, v1Plain);
        if (!v1Sha) {
          const msg = `✗ ${name} 是 v${verInfo.ver} 契约，但初始版本（${v1Dot} 或 ${v1Plain}）在 CHANGELOG.md 中无冻结记录 —— 回溯不到已冻结的 v1，按逃逸改名拦截`;
          return { ok: false, rc: 1, sha12: digest, stdout: '', stderr: msg };
        }
      }
    }
  }

  const wantRecord = Boolean(record || reRecord);
  if (wantRecord) {
    if (existingSha !== null && !reRecord) {
      return {
        ok: false,
        rc: 2,
        sha12: digest,
        stdout: '',
        stderr: `✗ ${name} 已有冻结指纹 ${existingSha} —— 拒绝静默重录\n  如需迭代契约请新建 .v2.md；确需原位重录请显式传 --re-record --reason "..."（旧指纹保留留痕）`,
      };
    }
    const cleanReason = String(reason || '').replace(/[\r\n|]+/g, ' ').trim();
    if (reRecord && !cleanReason) {
      return {
        ok: false,
        rc: 2,
        sha12: digest,
        stdout: '',
        stderr: '✗ --re-record 必须同时提供非空 --reason —— 无理由重录等同于事后篡改',
      };
    }

    const verTransition = verInfo && verInfo.ver >= 2
      ? `v${verInfo.ver - 1} → v${verInfo.ver} · FROZEN (sha12:${digest})`
      : `FROZEN (sha12:${digest})`;
    const whatCol = reRecord
      ? '重录冻结指纹'
      : (verInfo && verInfo.ver >= 2 ? `冻结 v${verInfo.ver} 契约` : '首次冻结');
    const whyCol = cleanReason || '—';
    const row = `| ${todayIsoDate()} | ${name} | ${verTransition} | ${whatCol} | ${whyCol} |\n`;

    try {
      if (!fs.existsSync(changelogAbs)) {
        writeFileLfAtomic(changelogAbs, CHANGELOG_HEADER + row);
      } else {
        const curLf = changelogText.replace(/\r\n/g, '\n');
        const sep = curLf.endsWith('\n') ? '' : '\n';
        writeFileLfAtomic(changelogAbs, curLf + sep + row);
      }
    } catch (e) {
      return {
        ok: false,
        rc: 3,
        sha12: digest,
        stdout: '',
        stderr: `写入 CHANGELOG.md 失败: ${e.message || e}`,
      };
    }

    return {
      ok: true,
      rc: 0,
      sha12: digest,
      stdout: `✓ ${name} 结构合格，冻结指纹 ${digest} 已写入 ${changelogAbs}${reRecord ? '（重录理由已留痕，历史记录保留）' : ''}`,
      stderr: '',
    };
  }

  if (existingSha === null) {
    return {
      ok: true,
      rc: 0,
      sha12: digest,
      frozen: false,
      stdout: `✓ ${name} 结构合格（sha12:${digest}，尚未登记冻结 —— 确认无误后用 --record 写入 CHANGELOG.md）`,
      stderr: '',
    };
  }

  if (existingSha !== digest) {
    return {
      ok: false,
      rc: 1,
      sha12: digest,
      expectedSha12: existingSha,
      stdout: '',
      stderr: `✗ ${name} 在冻结后被改动：当前实算 ${digest} ≠ CHANGELOG.md 记录 ${existingSha}\n  硬约束：不允许事后调整成功信号或超参去迎合实验结果；合法变更请新建 .v2.md 并登记原因`,
    };
  }

  return {
    ok: true,
    rc: 0,
    sha12: digest,
    frozen: true,
    stdout: `✓ ${name} 结构合格且冻结指纹对账一致（sha12:${digest}）`,
    stderr: '',
  };
}

// ── 7) watchRepro ──────────────────────────────────────────────────────────────
const PLACEHOLDER_SHA64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function extractReproDataHashes(reproText) {
  const sec2 = extractContractSection(reproText, 2);
  if (!sec2) return [];

  const entries = [];
  const lines = sec2.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // 忽略模板引用说明行、注释示例行与代码块标记
    if (line.startsWith('>') || line.startsWith('#') || line.startsWith('```')) continue;
    if (/sha256sum\s*</i.test(line) || /<[0-9a-zA-Z_.-]*hex/i.test(line)) continue;

    // 匹配标准 `<64hex 或 pre…suf>  <filepath>` 行
    const mPair = line.match(
      /(?:^|[\s`|])([0-9a-fA-F]{64}|[0-9a-fA-F]{4,}(?:…|\.\.\.)[0-9a-fA-F]{4,})[\s*]+([^\s`|#<>]+)(?:[`|\s]|$)/,
    );
    if (mPair) {
      const hashTok = mPair[1].toLowerCase();
      const fileTok = mPair[2].trim();
      if (hashTok === PLACEHOLDER_SHA64) continue;
      entries.push({ wantHash: hashTok, dataPath: fileTok });
    }
  }
  return entries;
}

function matchShaToken(actualHex64, wantTok) {
  const got = actualHex64.toLowerCase();
  const want = wantTok.toLowerCase();
  if (want.includes('…') || want.includes('...')) {
    const [pre, suf] = want.split(/…|\.\.\./);
    return got.startsWith(pre) && got.endsWith(suf);
  }
  return got.startsWith(want);
}

export function watchRepro(
  rootDir,
  anchorDir,
  { logPath = null, maxStaleSec = 900, verifyDataPath = null } = {},
) {
  const root = path.resolve(String(rootDir || process.cwd()));
  const rawAnchor = String(anchorDir || '').trim();
  if (!rawAnchor) {
    return { ok: false, rc: 2, stdout: '', stderr: '未提供基线目录路径' };
  }

  const anchorAbs = path.isAbsolute(rawAnchor) ? path.resolve(rawAnchor) : path.resolve(root, rawAnchor);
  const reproAbs = anchorAbs.toLowerCase().endsWith('.md')
    ? anchorAbs
    : path.join(anchorAbs, 'REPRO.md');
  const baseDirAbs = path.dirname(reproAbs);

  if (!fs.existsSync(reproAbs) || !fs.statSync(reproAbs).isFile()) {
    return {
      ok: false,
      rc: 2,
      stdout: '',
      stderr: `找不到基线复现记录 REPRO.md: ${reproAbs}`,
    };
  }

  // [D-10] 修复：若指定了 logPath 但日志文件不存在或不是普通文件，严格返回 rc: 2（巡检依赖缺失，绝不混淆为 rc: 1 或 0）
  let logAbs = null;
  if (logPath !== null && logPath !== undefined && String(logPath).trim() !== '') {
    const rawLog = String(logPath).trim();
    logAbs = path.isAbsolute(rawLog) ? path.resolve(rawLog) : path.resolve(root, rawLog);
    let lst;
    try {
      lst = fs.statSync(logAbs);
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        return {
          ok: false,
          rc: 2,
          stdout: '',
          stderr: `-- 无法巡检：日志文件不存在 (${rawLog}) —— 巡检前置缺失，退 2`,
        };
      }
      return {
        ok: false,
        rc: 2,
        stdout: '',
        stderr: `-- 无法巡检：无法访问日志文件 (${rawLog}): ${e.message || e}`,
      };
    }
    if (!lst.isFile()) {
      return {
        ok: false,
        rc: 2,
        stdout: '',
        stderr: `-- 无法巡检：日志路径不是普通文件 (${rawLog})`,
      };
    }
  }

  const reproText = fs.readFileSync(reproAbs, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const dataEntries = extractReproDataHashes(reproText);

  if (verifyDataPath) {
    const sec2 = extractContractSection(reproText, 2) || '';
    const cleanLines = sec2
      .split('\n')
      .filter((l) => !l.trim().startsWith('>') && !l.trim().startsWith('#') && !/sha256sum\s*</i.test(l))
      .join('\n');
    const tokMatch = cleanLines.match(/[0-9a-fA-F]{64}|[0-9a-fA-F]{4,}(?:…|\.\.\.)[0-9a-fA-F]{4,}/);
    if (!tokMatch || tokMatch[0].toLowerCase() === PLACEHOLDER_SHA64) {
      return {
        ok: false,
        rc: 2,
        stdout: '',
        stderr: '-- 无法巡检：REPRO.md §2 未记录有效数据 sha256 指纹',
      };
    }
    dataEntries.splice(0, dataEntries.length, { wantHash: tokMatch[0].toLowerCase(), dataPath: String(verifyDataPath) });
  }

  if (dataEntries.length === 0 && !logAbs) {
    return {
      ok: false,
      rc: 2,
      stdout: '',
      stderr: '-- 无法巡检：REPRO.md §2 未记录有效数据 sha256 指纹，且未指定 --log 日志文件',
    };
  }

  const outLines = [];
  const errLines = [];
  let alarm = false;

  for (const item of dataEntries) {
    let dataAbs = path.isAbsolute(item.dataPath)
      ? path.resolve(item.dataPath)
      : path.resolve(root, item.dataPath);
    if (!fs.existsSync(dataAbs)) {
      const altAbs = path.resolve(baseDirAbs, item.dataPath);
      if (fs.existsSync(altAbs)) dataAbs = altAbs;
    }

    if (!fs.existsSync(dataAbs)) {
      errLines.push(`!! 活性异常：数据集文件不存在 (${item.dataPath})`);
      alarm = true;
      continue;
    }
    const dst = fs.statSync(dataAbs);
    if (dst.isDirectory()) {
      return {
        ok: false,
        rc: 2,
        stdout: outLines.join('\n'),
        stderr: `-- 无法巡检：${item.dataPath} 是目录 —— sha256 对账需要单个数据文件或切分清单`,
      };
    }
    const actualHex = sha256Hex(fs.readFileSync(dataAbs), 64);
    if (!matchShaToken(actualHex, item.wantHash)) {
      errLines.push(`!! 活性异常：数据 sha256 不匹配 (${item.dataPath})：期望 ${item.wantHash}，实得 ${actualHex.slice(0, 8)}…${actualHex.slice(-8)}`);
      alarm = true;
    } else {
      outLines.push(`== 数据指纹匹配：${item.dataPath} (${item.wantHash})`);
    }
  }

  let logAgeSec = null;
  if (logAbs) {
    const lst = fs.statSync(logAbs);
    logAgeSec = Math.max(0, Math.floor((Date.now() - lst.mtimeMs) / 1000));
    const limitSec = Number.isFinite(Number(maxStaleSec)) && Number(maxStaleSec) >= 0
      ? Number(maxStaleSec)
      : 900;
    if (logAgeSec > limitSec) {
      errLines.push(`!! 活性异常：日志 ${path.basename(logAbs)} 已 ${logAgeSec}s 无更新（阈值 ${limitSec}s）→ 心跳停摆`);
      alarm = true;
    } else {
      outLines.push(`== 日志心跳健康：${path.basename(logAbs)}（${lst.size} 字节，${logAgeSec}s 前更新，阈值 ${limitSec}s）`);
    }
  }

  return {
    ok: !alarm,
    rc: alarm ? 1 : 0,
    checkedDataCount: dataEntries.length,
    logAgeSec,
    stdout: outLines.join('\n'),
    stderr: errLines.join('\n'),
  };
}

// ── 8) initProject ─────────────────────────────────────────────────────────────
function deadEndsSkeleton(topicSlug) {
  return [
    `# 已证伪机制与禁入死胡同（Topic: ${topicSlug}）`,
    '',
    '> `npx research-dispatch diverge` 会自动读取本文件前 60 行并注入发散提示词，避免多轮候选在同一条已失败机制上打转。',
    '> 请保持精炼列表格式（每条 1–2 行：写清“试过什么改动 → 实测观测到什么反例 → 为什么此路不通”）。',
    '',
    '<!-- 示例（实测证伪后取消注释并按实情填写）：',
    '- [DEAD-01] 单纯放大长度惩罚系数：Pilot 同题配对 Δ = -1.2pp（合规率跌 8pp），截断了必要推理链而非压缩冗余步骤。',
    '-->',
    '',
  ].join('\n');
}

export function initProject(targetDir, { force = false, topic = null } = {}) {
  const destRoot = path.resolve(String(targetDir || process.cwd()));
  const topicSlug = topic !== null && topic !== undefined && String(topic).trim()
    ? String(topic).trim()
    : 'default';
  if (!/^[A-Za-z0-9._-]+$/.test(topicSlug) || topicSlug === '.' || topicSlug === '..') {
    throw new Error(`非法的 --topic 课题名: ${JSON.stringify(topicSlug)}`);
  }

  fs.mkdirSync(destRoot, { recursive: true });
  for (const dirRel of [
    'dispatch',
    'roles',
    'papers/cards',
    'papers/novelty',
    'baselines',
    'contract',
    'skills/research-flow',
    `ideas/${topicSlug}/briefs`,
    `ideas/${topicSlug}/cards`,
  ]) {
    fs.mkdirSync(path.join(destRoot, dirRel), { recursive: true });
  }

  const templateMappings = [
    { src: 'examples/AGENTS.template.md', dest: 'AGENTS.md' },
    { src: 'examples/CLAUDE.template.md', dest: 'CLAUDE.md' },
    { src: 'examples/seats.example.json', dest: 'dispatch/seats.json' },
    { src: 'examples/roles/scout.md', dest: 'roles/scout.md' },
    { src: 'examples/roles/diverger.md', dest: 'roles/diverger.md' },
    { src: 'examples/roles/reviewer.md', dest: 'roles/reviewer.md' },
    { src: 'examples/roles/novelty.md', dest: 'roles/novelty.md' },
    { src: 'examples/templates/TEMPLATE.REPRO.md', dest: 'baselines/TEMPLATE.REPRO.md' },
    { src: 'examples/templates/TEMPLATE.BRIEF_BLOCK.md', dest: 'baselines/TEMPLATE.BRIEF_BLOCK.md' },
    { src: 'examples/templates/TEMPLATE.CONTRACT.md', dest: 'contract/TEMPLATE.md' },
    { src: 'examples/templates/CHANGELOG.CONTRACT.md', dest: 'contract/CHANGELOG.md' },
    { src: 'skills/research-flow/SKILL.md', dest: 'skills/research-flow/SKILL.md' },
  ];

  const created = [];
  const skipped = [];

  for (const item of templateMappings) {
    const srcAbs = path.join(PACKAGE_ROOT, item.src);
    const destAbs = path.join(destRoot, item.dest);
    if (fs.existsSync(destAbs) && !force) {
      skipped.push(item.dest);
      continue;
    }
    const content = fs.readFileSync(srcAbs, 'utf8');
    writeFileLfAtomic(destAbs, content);
    created.push(item.dest);
  }

  const deadEndsRel = `ideas/${topicSlug}/dead-ends.md`;
  const deadEndsAbs = path.join(destRoot, deadEndsRel);
  if (fs.existsSync(deadEndsAbs) && !force) {
    skipped.push(deadEndsRel);
  } else {
    writeFileLfAtomic(deadEndsAbs, deadEndsSkeleton(topicSlug));
    created.push(deadEndsRel);
  }

  return {
    ok: true,
    rc: 0,
    topic: topicSlug,
    created,
    skipped,
  };
}
