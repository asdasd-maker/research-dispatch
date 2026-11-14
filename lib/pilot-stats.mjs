// 纯 Node 配对实验统计与合规子集对照组件（零第三方依赖，Node >= 20）。
//
// 核心方法论：
//   1. 配对检验（McNemar / 题级成对差值标准误）：在同一 (样本, rollout) 单元上比较双臂差异，
//      避免边际二项标准误掩盖真实配对信号，直接给出当前样本集上的实测 2σ MDE（最小可检出效应）。
//   2. 合规子集同题配对对照（防合规率选择性偏差）：当实验臂存在格式合规率过滤（compliantField）时，
//      严禁拿“实验臂仅合规样本准确率”去比“对照臂全量准确率”（合规样本天然偏向简单题）；
//      必须将对照臂同步收敛至完全相同的合规样本子集做同题配对比较，并显式量化选择性偏差。
import fs from 'node:fs';

function roundTo(val, digits = 4) {
  if (!Number.isFinite(val)) return null;
  const f = 10 ** digits;
  return Math.round(val * f) / f;
}

// 确定性种子伪随机数生成器（Mulberry32），确保自助法置信区间 100% 可复现
function mulberry32(seed) {
  let a = (Number(seed) || 42) >>> 0;
  return function nextRand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadRecords(input, armLabel) {
  if (Array.isArray(input)) {
    return input.map((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        throw new Error(armLabel + ' 第 ' + (i + 1) + ' 条记录不是对象');
      }
      return r;
    });
  }

  if (typeof input !== 'string' || !input.trim()) {
    throw new Error(armLabel + ' 输入必须是文件路径或对象数组');
  }

  let raw = '';
  try {
    raw = fs.readFileSync(input, 'utf8');
  } catch (e) {
    const err = new Error('无法读取 ' + armLabel + ' 文件 (' + input + '): ' + ((e && e.message) || e));
    err.code = 'ENOENT';
    throw err;
  }

  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (!trimmed) throw new Error(armLabel + ' 文件为空: ' + input);

  // 支持标准 JSON 数组或包装对象
  if (trimmed.startsWith('[') || (trimmed.startsWith('{') && !trimmed.includes('\n{'))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      for (const k of ['rows', 'records', 'items', 'data']) {
        if (Array.isArray(parsed[k])) return parsed[k];
      }
    } catch {
      // 回退按 JSONL 逐行解析
    }
  }

  const rows = [];
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    try {
      const obj = JSON.parse(ln);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('不是 JSON 对象');
      }
      rows.push(obj);
    } catch (e) {
      throw new Error(armLabel + ' JSONL 解析失败（第 ' + (i + 1) + ' 行）: ' + ((e && e.message) || e));
    }
  }
  return rows;
}

function extractCellKey(rec, idx, idField) {
  if (idField && rec[idField] !== undefined && rec[idField] !== null && String(rec[idField]).trim() !== '') {
    const baseId = String(rec[idField]).trim();
    if (rec.rollout !== undefined && rec.rollout !== null && !baseId.includes('::')) {
      return baseId + '::' + String(rec.rollout);
    }
    return baseId;
  }
  if (rec.dataset !== undefined && rec.row_index !== undefined) {
    return String(rec.dataset) + '::' + String(rec.row_index) + '::' + String(rec.rollout ?? 0);
  }
  for (const alt of ['cell_id', 'sample_id', 'question_id', 'item_id', 'problem_id', 'uid']) {
    if (rec[alt] !== undefined && rec[alt] !== null && String(rec[alt]).trim() !== '') {
      const baseId = String(rec[alt]).trim();
      if (rec.rollout !== undefined && rec.rollout !== null) {
        return baseId + '::' + String(rec.rollout);
      }
      return baseId;
    }
  }
  throw new Error('第 ' + (idx + 1) + ' 条记录缺少配对主键字段 "' + idField + '"');
}

function extractItemKey(rec, cellKey, itemField) {
  if (itemField && rec[itemField] !== undefined && rec[itemField] !== null) {
    return String(rec[itemField]);
  }
  for (const k of ['question_id', 'item_id', 'problem_id']) {
    if (rec[k] !== undefined && rec[k] !== null) return String(rec[k]);
  }
  if (rec.dataset !== undefined && rec.row_index !== undefined) {
    return String(rec.dataset) + '::' + String(rec.row_index);
  }
  if (cellKey.includes('::')) {
    return cellKey.slice(0, cellKey.lastIndexOf('::'));
  }
  return cellKey;
}

function extractNumericOutcome(rec, correctField, armLabel, key) {
  let raw = rec[correctField];
  if (raw === undefined && correctField === 'correct') {
    for (const fallback of ['is_correct', 'score', 'acc', 'correct2', 'passed']) {
      if (rec[fallback] !== undefined) {
        raw = rec[fallback];
        break;
      }
    }
  }
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const low = raw.trim().toLowerCase();
    if (low === 'true') return 1;
    if (low === 'false') return 0;
    const num = Number(low);
    if (Number.isFinite(num)) return num;
  }
  throw new Error(armLabel + ' 样本 "' + key + '" 缺少合法数值/布尔读数 "' + correctField + '"（实得 ' + JSON.stringify(raw) + '）');
}

function isCompliantValue(val) {
  if (val === undefined || val === null) return false;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val > 0;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    return s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'null' && s !== 'none';
  }
  return Boolean(val);
}

function calcBootstrapCi95Pp(itemDiffs, iters, seed) {
  const m = itemDiffs.length;
  if (m === 0 || !Number.isInteger(iters) || iters <= 0) return null;
  if (m === 1) {
    const only = roundTo(itemDiffs[0] * 100, 4);
    return [only, only];
  }
  const rng = mulberry32(seed);
  const means = new Array(iters);
  for (let b = 0; b < iters; b++) {
    let sum = 0;
    for (let i = 0; i < m; i++) {
      const pick = Math.floor(rng() * m);
      sum += itemDiffs[pick];
    }
    means[b] = (sum / m) * 100;
  }
  means.sort((x, y) => x - y);
  const loIdx = Math.max(0, Math.min(iters - 1, Math.floor(0.025 * iters)));
  const hiIdx = Math.max(0, Math.min(iters - 1, Math.ceil(0.975 * iters) - 1));
  return [roundTo(means[loIdx], 4), roundTo(means[hiIdx], 4)];
}

function summarizePairedCells(cells, { bootstrapIters = 1000, seed = 42 } = {}) {
  const n = cells.length;
  if (n === 0) {
    return {
      n_pairs: 0,
      n_items: 0,
      mean_a_pp: 0,
      mean_b_pp: 0,
      delta_pp: 0,
      fix: 0,
      break: 0,
      both_correct: 0,
      both_wrong: 0,
      se_pp: 0,
      se_sample_pp: 0,
      mde_2sigma_pp: 0,
      z: null,
      mcnemar_chi2: null,
      bootstrap_ci95_pp: null,
    };
  }

  let sumA = 0;
  let sumB = 0;
  let fix = 0;
  let brk = 0;
  let bothPos = 0;
  let bothZero = 0;
  let allBinary = true;

  for (const c of cells) {
    sumA += c.a;
    sumB += c.b;
    if ((c.a !== 0 && c.a !== 1) || (c.b !== 0 && c.b !== 1)) {
      allBinary = false;
    }
    if (c.b > c.a) fix++;
    else if (c.a > c.b) brk++;
    else if (c.a >= 0.5 && c.b >= 0.5) bothPos++;
    else bothZero++;
  }

  const meanA = sumA / n;
  const meanB = sumB / n;
  const delta = meanB - meanA;

  let varSum = 0;
  for (const c of cells) {
    const d = (c.b - c.a) - delta;
    varSum += d * d;
  }
  const sampleVar = n > 1 ? varSum / (n - 1) : 0;
  const seSample = Math.sqrt(sampleVar / n);
  const seMcNemar = (fix + brk) > 0 ? Math.sqrt(fix + brk) / n : 0;
  const sePrimary = allBinary ? seMcNemar : seSample;

  // 按题聚合（每个 item 内对多次 rollout 取均值，用于簇级自助法置信区间）
  const itemGroups = new Map();
  for (const c of cells) {
    if (!itemGroups.has(c.itemKey)) itemGroups.set(c.itemKey, []);
    itemGroups.get(c.itemKey).push(c);
  }
  const itemDiffs = [];
  for (const grp of itemGroups.values()) {
    let ga = 0;
    let gb = 0;
    for (const g of grp) {
      ga += g.a;
      gb += g.b;
    }
    itemDiffs.push((gb - ga) / grp.length);
  }

  const ci95 = calcBootstrapCi95Pp(itemDiffs, bootstrapIters, seed);

  return {
    n_pairs: n,
    n_items: itemGroups.size,
    mean_a_pp: roundTo(meanA * 100, 4),
    mean_b_pp: roundTo(meanB * 100, 4),
    delta_pp: roundTo(delta * 100, 4),
    fix,
    break: brk,
    both_correct: bothPos,
    both_wrong: bothZero,
    se_pp: roundTo(sePrimary * 100, 4),
    se_sample_pp: roundTo(seSample * 100, 4),
    mde_2sigma_pp: roundTo(2 * sePrimary * 100, 4),
    z: sePrimary > 0 ? roundTo(delta / sePrimary, 3) : null,
    mcnemar_chi2: allBinary && (fix + brk) > 0
      ? roundTo(((fix - brk) ** 2) / (fix + brk), 3)
      : null,
    bootstrap_ci95_pp: ci95,
  };
}

function summarizeItemLevel(cells) {
  const itemGroups = new Map();
  for (const c of cells) {
    if (!itemGroups.has(c.itemKey)) itemGroups.set(c.itemKey, []);
    itemGroups.get(c.itemKey).push(c);
  }
  const m = itemGroups.size;
  if (m === 0) {
    return {
      n_items: 0,
      mean_a_pp: 0,
      mean_b_pp: 0,
      delta_pp: 0,
      items_b_better: 0,
      items_a_better: 0,
      se_pp: 0,
      mde_2sigma_pp: 0,
      z: null,
    };
  }

  const xs = [];
  const ys = [];
  const diffs = [];
  let bBetter = 0;
  let aBetter = 0;
  let sumA = 0;
  let sumB = 0;

  for (const grp of itemGroups.values()) {
    let ga = 0;
    let gb = 0;
    for (const g of grp) {
      ga += g.a;
      gb += g.b;
    }
    const ia = ga / grp.length;
    const ib = gb / grp.length;
    const d = ib - ia;
    xs.push(ia);
    ys.push(ib);
    diffs.push(d);
    sumA += ia;
    sumB += ib;
    if (d > 1e-12) bBetter++;
    else if (d < -1e-12) aBetter++;
  }

  const meanA = sumA / m;
  const meanB = sumB / m;
  const meanDiff = meanB - meanA;
  let varSum = 0;
  for (const d of diffs) {
    varSum += (d - meanDiff) ** 2;
  }
  const variance = m > 1 ? varSum / (m - 1) : 0;
  const se = Math.sqrt(variance / m);

  return {
    n_items: m,
    mean_a_pp: roundTo(meanA * 100, 4),
    mean_b_pp: roundTo(meanB * 100, 4),
    delta_pp: roundTo(meanDiff * 100, 4),
    items_b_better: bBetter,
    items_a_better: aBetter,
    se_pp: roundTo(se * 100, 4),
    mde_2sigma_pp: roundTo(2 * se * 100, 4),
    z: se > 0 ? roundTo(meanDiff / se, 3) : null,
  };
}

export function computePairedStats(
  armAInput,
  armBInput,
  {
    idField = 'id',
    itemField = null,
    correctField = 'correct',
    promptField = 'prompt',
    compliantField = null,
    bootstrapIters = 1000,
    seed = 42,
    checkPromptMatch = false,
  } = {}
) {
  const rowsA = loadRecords(armAInput, 'armA');
  const rowsB = loadRecords(armBInput, 'armB');

  if (rowsA.length === 0 || rowsB.length === 0) {
    throw new Error('双臂样本不能为空（armA=' + rowsA.length + ', armB=' + rowsB.length + '）');
  }

  const mapA = new Map();
  for (let i = 0; i < rowsA.length; i++) {
    const k = extractCellKey(rowsA[i], i, idField);
    if (mapA.has(k)) throw new Error('armA 存在重复的样本 ID: ' + k);
    mapA.set(k, rowsA[i]);
  }

  const mapB = new Map();
  for (let i = 0; i < rowsB.length; i++) {
    const k = extractCellKey(rowsB[i], i, idField);
    if (mapB.has(k)) throw new Error('armB 存在重复的样本 ID: ' + k);
    mapB.set(k, rowsB[i]);
  }

  let sharedCount = 0;
  const onlyA = [];
  const onlyB = [];
  for (const k of mapA.keys()) {
    if (mapB.has(k)) sharedCount++;
    else if (onlyA.length < 5) onlyA.push(k);
  }
  for (const k of mapB.keys()) {
    if (!mapA.has(k) && onlyB.length < 5) onlyB.push(k);
  }

  if (sharedCount !== mapA.size || sharedCount !== mapB.size) {
    throw new Error(
      'armA 与 armB 样本 ID 不对齐（armA=' + mapA.size +
      ', armB=' + mapB.size +
      ', 交集=' + sharedCount +
      (onlyA.length ? ', 仅armA含:' + onlyA.join(',') : '') +
      (onlyB.length ? ', 仅armB含:' + onlyB.join(',') : '') +
      '）'
    );
  }

  const sortedKeys = [...mapA.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const cells = [];
  let promptChecked = 0;
  let promptMismatches = 0;

  for (const key of sortedKeys) {
    const ra = mapA.get(key);
    const rb = mapB.get(key);
    const scoreA = extractNumericOutcome(ra, correctField, 'armA', key);
    const scoreB = extractNumericOutcome(rb, correctField, 'armB', key);
    const itemKey = extractItemKey(rb, key, itemField) || extractItemKey(ra, key, itemField);

    if (promptField && ra[promptField] !== undefined && rb[promptField] !== undefined) {
      promptChecked++;
      if (String(ra[promptField]) !== String(rb[promptField])) {
        promptMismatches++;
      }
    }

    cells.push({ key, itemKey, a: scoreA, b: scoreB, recA: ra, recB: rb });
  }

  if (checkPromptMatch && promptMismatches > 0) {
    throw new Error('双臂间检测到 ' + promptMismatches + '/' + promptChecked + ' 条样本的 ' + promptField + ' 不一致');
  }

  const generation = summarizePairedCells(cells, { bootstrapIters, seed });
  const itemLevel = summarizeItemLevel(cells);

  let compliantSubset = null;
  if (compliantField) {
    const field = String(compliantField).trim();
    const hasComplianceInA = cells.some((c) => c.recA[field] !== undefined);
    const compCells = [];
    let compCountB = 0;
    let compCountA = 0;

    for (const c of cells) {
      const cb = isCompliantValue(c.recB[field]);
      const ca = hasComplianceInA ? isCompliantValue(c.recA[field]) : true;
      if (cb) compCountB++;
      if (hasComplianceInA && ca) compCountA++;
      if (cb && ca) compCells.push(c);
    }

    const pairedComp = summarizePairedCells(compCells, { bootstrapIters, seed });
    const itemComp = summarizeItemLevel(compCells);
    const naiveUnpairedDeltaPp = compCells.length > 0
      ? roundTo(pairedComp.mean_b_pp - generation.mean_a_pp, 4)
      : null;
    const selectionBiasPp = compCells.length > 0
      ? roundTo(pairedComp.mean_a_pp - generation.mean_a_pp, 4)
      : null;

    compliantSubset = {
      field,
      n_compliant: compCells.length,
      n_total: cells.length,
      compliance_rate_pp: roundTo((compCells.length / cells.length) * 100, 4),
      arm_b_compliance_rate_pp: roundTo((compCountB / cells.length) * 100, 4),
      ...(hasComplianceInA ? { arm_a_compliance_rate_pp: roundTo((compCountA / cells.length) * 100, 4) } : {}),
      naive_unpaired_delta_pp: naiveUnpairedDeltaPp,
      selection_bias_pp: selectionBiasPp,
      paired: pairedComp,
      item_level: itemComp,
    };
  }

  const exceeds2Sigma = Math.abs(generation.delta_pp) >= generation.mde_2sigma_pp && generation.mde_2sigma_pp >= 0;

  return {
    ok: true,
    n_pairs: generation.n_pairs,
    n_items: generation.n_items,
    mean_a_pp: generation.mean_a_pp,
    mean_b_pp: generation.mean_b_pp,
    delta_pp: generation.delta_pp,
    fix: generation.fix,
    break: generation.break,
    both_correct: generation.both_correct,
    both_wrong: generation.both_wrong,
    se_pp: generation.se_pp,
    mde_2sigma_pp: generation.mde_2sigma_pp,
    z: generation.z,
    mcnemar_chi2: generation.mcnemar_chi2,
    bootstrap_ci95_pp: generation.bootstrap_ci95_pp,
    exceeds_2sigma_mde: exceeds2Sigma,
    prompt_checked: promptChecked,
    prompt_mismatches: promptMismatches,
    generation,
    item_level: itemLevel,
    compliant_subset: compliantSubset,
  };
}

function fmtSignedPp(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'N/A';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + 'pp';
}

export function formatPairedStatsReport(stats) {
  if (!stats || typeof stats !== 'object') {
    throw new Error('formatPairedStatsReport 需要传入 computePairedStats 的返回对象');
  }
  const g = stats.generation || stats;
  const it = stats.item_level;
  const ciText = Array.isArray(g.bootstrap_ci95_pp)
    ? '[' + fmtSignedPp(g.bootstrap_ci95_pp[0]) + ', ' + fmtSignedPp(g.bootstrap_ci95_pp[1]) + ']'
    : 'N/A';

  const lines = [
    '# Pilot 配对统计报告（Paired Readout）',
    '',
    '- 配对样本数：`N = ' + g.n_pairs + '`（独立题目数 `M = ' + g.n_items + '`）',
  ];

  if (stats.prompt_checked > 0) {
    lines.push(
      '- Prompt 一致性核查：已比对 `' + stats.prompt_checked + '` 对，不一致 `' + stats.prompt_mismatches + '` 对'
    );
  }

  lines.push(
    '',
    '## 1. 全量同单元配对结果（Generation-Level Paired）',
    '',
    '| 指标 | 数值 |',
    '|---|---|',
    '| 对照臂 (Arm A) | ' + g.mean_a_pp.toFixed(2) + '% |',
    '| 实验臂 (Arm B) | ' + g.mean_b_pp.toFixed(2) + '% |',
    '| 配对差值 Δ (B − A) | **' + fmtSignedPp(g.delta_pp) + '** |',
    '| 纠错 / 改坏 (fix / break) | `' + g.fix + '`（A错B对） / `' + g.break + '`（A对B错） |',
    '| 配对标准误 (Paired SE) | ' + g.se_pp.toFixed(2) + 'pp |',
    '| 最小可检出效应 (2σ MDE) | **' + g.mde_2sigma_pp.toFixed(2) + 'pp** |',
    '| z 统计量 | ' + (g.z === null ? 'N/A' : g.z.toFixed(3)) + ' |',
    '| 95% Bootstrap CI | ' + ciText + ' |',
    '| 噪声门槛判定 (|Δ| ≥ 2σ) | ' + (stats.exceeds_2sigma_mde ? 'PASS（越过噪声下限）' : 'BELOW_MDE（落入配对噪声带）') + ' |',
  );

  if (it && it.n_items > 0) {
    lines.push(
      '',
      '## 2. 题级聚合配对结果（Item-Level Paired, M = ' + it.n_items + '）',
      '',
      '- 题级均值：Arm A `' + it.mean_a_pp.toFixed(2) + '%` vs Arm B `' + it.mean_b_pp.toFixed(2) + '%` → Δ = `' + fmtSignedPp(it.delta_pp) + '`',
      '- 题级优劣：B 占优 `' + it.items_b_better + '` 题 ／ A 占优 `' + it.items_a_better + '` 题',
      '- 题级配对 SE：`' + it.se_pp.toFixed(2) + 'pp` · 题级 `2σ MDE = ' + it.mde_2sigma_pp.toFixed(2) + 'pp`' +
        (it.z !== null ? ' · `z = ' + it.z.toFixed(3) + '`' : ''),
    );
  }

  const cs = stats.compliant_subset;
  if (cs) {
    const cp = cs.paired;
    lines.push(
      '',
      '## 3. 合规子集同题配对对照（防选择性偏差：`compliantField = "' + cs.field + '"`）',
      '',
      '- 合规样本覆盖：`n = ' + cs.n_compliant + ' / ' + cs.n_total + '`（合规率 **' + cs.compliance_rate_pp.toFixed(2) + '%**）',
    );
    if (cs.n_compliant === 0) {
      lines.push('- 警告：合规样本数为 0，无法计算合规子集配对差值。');
    } else {
      lines.push(
        '- 伪差值警示（未配对直接拿 B 合规比 A 全量）：`' + fmtSignedPp(cs.naive_unpaired_delta_pp) + '`' +
          '（含题目难易选择性偏差 `' + fmtSignedPp(cs.selection_bias_pp) + '`）',
        '- **同题配对真实差值**（A 与 B 严格锁定同一合规样本集）：',
        '  - Arm A（同子集）`' + cp.mean_a_pp.toFixed(2) + '%` vs Arm B（同子集）`' + cp.mean_b_pp.toFixed(2) + '%` → **Δ = ' + fmtSignedPp(cp.delta_pp) + '**',
        '  - 子集 `fix = ' + cp.fix + '` / `break = ' + cp.break + '` · 配对 SE `' + cp.se_pp.toFixed(2) + 'pp` · 子集 `2σ MDE = ' + cp.mde_2sigma_pp.toFixed(2) + 'pp`' +
          (cp.z !== null ? ' · `z = ' + cp.z.toFixed(3) + '`' : ''),
      );
    }
  }

  return lines.join('\n') + '\n';
}
