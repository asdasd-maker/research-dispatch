// 实时遥测账本、DSH 工作区智能发现、S0→S6 全链路盘面与 /swarm 拓扑星图聚合器（v2.3.0，纯 Node 零依赖）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  checkAnchor,
  extractCardVerdict,
  isInsideRoot,
  locateCardYaml,
  maskSecrets,
  parseVerdictText,
  parseYamlCardMapping,
  readFileInsideRoot,
  summarizeTopic,
} from './validators.mjs';
import { withExclusiveFileLock } from './file-lock.mjs';
import {
  assemblePaperPool,
  checkContractFile,
  checkNoveltyReport,
  initProject,
} from './workflow.mjs';
import {
  findSeat,
  loadConfig,
  resolveDivergePlan,
  resolveExecutionPlan,
  resolveStagePlan,
  seatIdentity,
  seatEffortCapability,
} from './registry.mjs';
import { embeddedModelEffort, normalizeEffort } from './models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const DISPATCH_BIN = path.join(PACKAGE_ROOT, 'bin', 'dispatch.mjs');

export const TELEMETRY_REL = '.research-dispatch/telemetry.json';
const MAX_RUNS = 36;
const WORKER_STALE_MS = 2 * 60 * 60 * 1000;
const DIMS = ['novelty', 'feasibility', 'baseline_fit', 'impl_cost', 'expected_gain'];
const RESERVED_IDEAS_DIRS = new Set(['_flat', 'briefs', 'cards', 'archive', 'stale', 'rejected', '.superseded']);

function sha12Text(text) {
  return crypto.createHash('sha256').update(String(text || '').replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 12);
}

function sha12Buf(buf) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8')).digest('hex').slice(0, 12);
}

function cleanModelName(raw) {
  const s = String(raw || '').replace(/-from-.*$|-explicit$|-manual-attested$/, '').trim();
  return s && s !== 'unknown-check-config' ? s : '';
}

function readUtf8Safe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function writeAtomicLf(dest, content) {
  const lf = String(content || '').replace(/\r\n/g, '\n');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  fs.writeFileSync(tmp, lf, 'utf8');
  try {
    fs.renameSync(tmp, dest);
  } catch {
    try {
      fs.copyFileSync(tmp, dest);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }
  }
}

function withFileLock(lockPath, fn, { timeoutMs = 2000 } = {}) {
  return withExclusiveFileLock(lockPath, fn, { timeoutMs });
}

function truncPreview(text, maxChars = 3600) {
  const clean = maskSecrets(String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim());
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars) + '\n\n…（预览已截断，完整内容见磁盘原文件）';
}

export function isDshProfileDir(dirPath) {
  const norm = String(dirPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return /(?:^|\/)\.dsh\/profiles(?:\/|$)/i.test(norm);
}

export function inspectWorkspaceMarkers(dirPath) {
  const p = String(dirPath || '').trim();
  if (!p || isDshProfileDir(p)) {
    return { exists: false, isResearch: false, hasSeats: false, paperCount: 0 };
  }
  let st = null;
  try { st = fs.statSync(p); } catch { st = null; }
  if (!st || !st.isDirectory()) {
    return { exists: false, isResearch: false, hasSeats: false, paperCount: 0 };
  }
  const hasSeats = fs.existsSync(path.join(p, 'dispatch', 'seats.json'));
  const cardsDir = path.join(p, 'papers', 'cards');
  let paperCount = 0;
  try {
    if (fs.existsSync(cardsDir) && fs.statSync(cardsDir).isDirectory()) {
      paperCount = fs.readdirSync(cardsDir).filter((f) => f.endsWith('.md') && f !== '_pool.md' && !f.startsWith('.')).length;
    }
  } catch { paperCount = 0; }
  const hasIdeas = fs.existsSync(path.join(p, 'ideas'));
  const hasContracts = fs.existsSync(path.join(p, 'contract'));
  const isResearch = Boolean(hasSeats || paperCount > 0 || hasIdeas || hasContracts);
  return { exists: true, isResearch, hasSeats, paperCount };
}

export function discoverDshWorkspaces(dshHome) {
  const root = String(dshHome || '').trim();
  if (!root) return [];
  const wsJsonPath = path.join(root, 'storages', 'workspace.json');
  if (!fs.existsSync(wsJsonPath)) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(wsJsonPath, 'utf8'));
  } catch {
    return [];
  }
  const table = (parsed && parsed.tables && parsed.tables.workspaces) || {};
  const orderIds = Array.isArray(parsed && parsed.global && parsed.global.workspaceIds)
    ? parsed.global.workspaceIds
    : Object.keys(table);
  const seenKeys = new Set();
  const rows = [];

  const pushEntry = (ent, orderIdx) => {
    if (!ent || typeof ent !== 'object') return;
    const rawPath = String(ent.path || '').trim();
    if (!rawPath || isDshProfileDir(rawPath)) return;
    const resolved = path.resolve(rawPath);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seenKeys.has(key)) return;
    const markers = inspectWorkspaceMarkers(resolved);
    if (!markers.exists) return;
    seenKeys.add(key);
    rows.push({
      path: resolved,
      name: String(ent.name || path.basename(resolved) || resolved).trim(),
      isResearch: markers.isResearch,
      hasSeats: markers.hasSeats,
      paperCount: markers.paperCount,
      updatedAt: Number(ent.updatedAt) || 0,
      orderIdx,
    });
  };

  orderIds.forEach((id, idx) => pushEntry(table[id], idx));
  Object.values(table).forEach((ent, idx) => pushEntry(ent, orderIds.length + idx));

  rows.sort((a, b) => {
    if (a.hasSeats !== b.hasSeats) return a.hasSeats ? -1 : 1;
    if (a.isResearch !== b.isResearch) return a.isResearch ? -1 : 1;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return a.orderIdx - b.orderIdx;
  });

  return rows.map(({ path: p, name, isResearch, hasSeats, paperCount }) => ({
    dir: p,
    path: p,
    name,
    isResearch,
    hasSeats,
    paperCount,
  }));
}

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

export function readTelemetryLedger(repoRoot, { persistStale = false } = {}) {
  const root = path.resolve(String(repoRoot || '.'));
  const file = path.join(root, TELEMETRY_REL);
  if (!isInsideRoot(root, file) || !fs.existsSync(file)) {
    return { version: 1, runs: [] };
  }
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { version: 1, runs: [] };
  }
  const runs = Array.isArray(data && data.runs) ? data.runs : [];
  const now = Date.now();
  let dirty = false;

  for (const r of runs) {
    if (!r || typeof r !== 'object') continue;
    const workers = Array.isArray(r.workers) ? r.workers : [];
    for (const w of workers) {
      if (!w || w.status !== 'working') continue;
      const started = Number(w.startedAt || r.startedAt || 0);
      const expired = started > 0 && (now - started > WORKER_STALE_MS);
      const checkPid = w.pid || r.pid;
      const dead = checkPid ? !isPidAlive(checkPid) : expired;
      if (dead || expired) {
        w.status = 'interrupted';
        w.finishedAt = now;
        if (started > 0) w.durationMs = Math.max(0, now - started);
        dirty = true;
      }
    }
    if (r.status === 'working') {
      const started = Number(r.startedAt || 0);
      const expired = started > 0 && (now - started > WORKER_STALE_MS);
      const hostDead = r.pid ? !isPidAlive(r.pid) : false;
      const anyActiveWorker = workers.some((w) => w && w.status === 'working');
      if ((hostDead && !anyActiveWorker) || expired) {
        for (const w of workers) {
          if (w && (w.status === 'queued' || w.status === 'working')) {
            w.status = 'interrupted';
            w.finishedAt = now;
          }
        }
        r.status = 'interrupted';
        r.finishedAt = now;
        if (started > 0) r.durationMs = Math.max(0, now - started);
        dirty = true;
      }
    }
  }

  if (dirty && persistStale) {
    try {
      writeAtomicLf(file, JSON.stringify({ version: 1, runs: runs.slice(0, MAX_RUNS) }, null, 2) + '\n');
    } catch { /* 只读场景忽略回写异常 */ }
  }
  return { version: 1, runs };
}

function mutateTelemetryLedger(repoRoot, mutator) {
  const root = path.resolve(String(repoRoot || '.'));
  const file = path.join(root, TELEMETRY_REL);
  if (!isInsideRoot(root, file)) {
    throw new Error('遥测账本路径越出项目根目录: ' + file);
  }
  const lockFile = file + '.lock';
  return withFileLock(lockFile, () => {
    const ledger = readTelemetryLedger(root, { persistStale: false });
    const res = mutator(ledger);
    writeAtomicLf(file, JSON.stringify({ version: 1, runs: ledger.runs.slice(0, MAX_RUNS) }, null, 2) + '\n');
    return res;
  });
}

export function startRunTelemetry(repoRoot, info = {}) {
  try {
    const now = Date.now();
    const stage = String(info.stage || 'S4');
    const runId = String(info.runId || (stage.replace(/[^A-Za-z0-9]/g, '') + '-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6)));
    const entry = {
      runId,
      stage,
      topic: String(info.topic || 'default'),
      targetId: String(info.targetId || ''),
      title: String(info.title || stage),
      pid: info.pid || process.pid,
      status: 'working',
      startedAt: now,
      finishedAt: null,
      durationMs: null,
      rc: null,
      outputRel: '',
      note: '',
      inputs: Array.isArray(info.inputs) ? info.inputs.map((x) => ({
        label: String((x && x.label) || ''),
        rel: String((x && x.rel) || ''),
        sha: String((x && x.sha) || ''),
      })) : [],
      workers: Array.isArray(info.workers) ? info.workers.map((w) => ({
        tag: String((w && (w.tag || w.seat)) || 'worker'),
        seat: String((w && w.seat) || 'worker'),
        model: String((w && w.model) || ''),
        effort: String((w && w.effort) || ''),
        requestedEffort: String((w && (w.requestedEffort !== undefined ? w.requestedEffort : w.effort)) || ''),
        effectiveEffort: String((w && (w.effectiveEffort !== undefined ? w.effectiveEffort : '')) || ''),
        sandbox: String((w && w.sandbox) || 'os.tmpdir()'),
        status: String((w && w.status) || 'queued'),
        pid: (w && w.pid) || null,
        startedAt: (w && w.startedAt) || null,
        finishedAt: null,
        durationMs: null,
        verdict: '',
        score25: null,
        outputRel: '',
        error: '',
      })) : [],
    };
    const inheritedLaunchId = String(process.env.DSH_DISPATCH_LAUNCH_ID || '').trim();
    mutateTelemetryLedger(repoRoot, (ledger) => {
      ledger.runs = [
        entry,
        ...ledger.runs.filter((r) => r && r.runId !== runId && (!inheritedLaunchId || r.runId !== inheritedLaunchId)),
      ].slice(0, MAX_RUNS);
    });
    return runId;
  } catch {
    return '';
  }
}

export function updateWorkerTelemetry(repoRoot, runId, slotTag, patch = {}) {
  if (!runId || !slotTag) return;
  try {
    mutateTelemetryLedger(repoRoot, (ledger) => {
      const run = ledger.runs.find((r) => r && r.runId === runId);
      if (!run) return;
      run.workers = Array.isArray(run.workers) ? run.workers : [];
      let worker = run.workers.find((w) => w && w.tag === slotTag);
      if (!worker) {
        worker = {
          tag: String(slotTag),
          seat: String(patch.seat || slotTag.replace(/[0-9]+$/, '') || slotTag),
          model: String(patch.model || ''),
          effort: String(patch.effort || ''),
          requestedEffort: String(patch.requestedEffort || patch.effort || ''),
          effectiveEffort: String(patch.effectiveEffort || ''),
          sandbox: String(patch.sandbox || 'os.tmpdir()'),
          status: 'queued',
          pid: null,
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          verdict: '',
          score25: null,
          outputRel: '',
          error: '',
        };
        run.workers.push(worker);
      }
      if (patch.status !== undefined) worker.status = String(patch.status);
      if (patch.seat !== undefined) worker.seat = String(patch.seat);
      if (patch.model !== undefined && patch.model !== '') worker.model = cleanModelName(patch.model) || String(patch.model);
      if (patch.effort !== undefined) worker.effort = String(patch.effort || '');
      if (patch.requestedEffort !== undefined) worker.requestedEffort = String(patch.requestedEffort || '');
      if (patch.effectiveEffort !== undefined) worker.effectiveEffort = String(patch.effectiveEffort || '');
      if (patch.sandbox !== undefined) worker.sandbox = String(patch.sandbox);
      if (patch.pid !== undefined) worker.pid = patch.pid;
      if (patch.startedAt !== undefined) worker.startedAt = patch.startedAt;
      if (patch.finishedAt !== undefined) worker.finishedAt = patch.finishedAt;
      if (worker.startedAt && worker.finishedAt) {
        worker.durationMs = Math.max(0, Number(worker.finishedAt) - Number(worker.startedAt));
      }
      if (patch.verdict !== undefined) worker.verdict = String(patch.verdict || '');
      if (patch.score25 !== undefined) worker.score25 = patch.score25;
      if (patch.outputRel !== undefined) worker.outputRel = String(patch.outputRel || '');
      if (patch.error !== undefined) worker.error = maskSecrets(String(patch.error || '')).slice(0, 240);
    });
  } catch { /* ignore */ }
}

export function finishRunTelemetry(repoRoot, runId, patch = {}) {
  if (!runId) return;
  try {
    mutateTelemetryLedger(repoRoot, (ledger) => {
      const run = ledger.runs.find((r) => r && r.runId === runId);
      if (!run || (run.status !== 'working' && !patch.force)) return;
      const now = Date.now();
      const rc = patch.rc !== undefined ? patch.rc : 0;
      run.status = String(patch.status || (rc === 0 ? 'done' : 'failed'));
      run.rc = rc;
      run.finishedAt = now;
      if (run.startedAt) run.durationMs = Math.max(0, now - Number(run.startedAt));
      if (patch.outputRel !== undefined) run.outputRel = String(patch.outputRel || '');
      if (patch.note !== undefined) run.note = String(patch.note || '');
      for (const w of run.workers || []) {
        if (!w) continue;
        if (w.status === 'queued') w.status = 'skipped';
        else if (w.status === 'working') {
          w.status = rc === 0 ? 'done' : 'failed';
          w.finishedAt = now;
          if (w.startedAt) w.durationMs = Math.max(0, now - Number(w.startedAt));
        }
      }
    });
  } catch { /* ignore */ }
}

export function readProjectLineupSummary(repoRoot, seatsFile = 'dispatch/seats.json') {
  const describeSlot = (seatId, model, rawEffort, cfgObj = null) => {
    const cleanSeat = String(seatId || 'codex').trim() || 'codex';
    const cleanModel = String(model || '').trim();
    const resolvedModel = cleanModel || (cfgObj ? (() => {
      const seatObj = findSeat(cfgObj, cleanSeat);
      return seatObj ? cleanModelName(seatIdentity(seatObj, { seat: cleanSeat, payloadSha: '', voteModel: '', useDshPatch: false })) : '';
    })() : '');
    const effSource = cleanModel || resolvedModel;
    const emb = embeddedModelEffort(effSource);
    const seatObj = cfgObj ? findSeat(cfgObj, cleanSeat) : null;
    const cap = seatEffortCapability(seatObj || cleanSeat);
    const effort = emb ? '' : normalizeEffort(rawEffort);
    return {
      seat: cleanSeat,
      model: cleanModel,
      resolvedModel,
      effort,
      embeddedEffort: emb,
      supportsEffort: Boolean(cap.supported),
    };
  };

  const fallback = {
    configured: false,
    scout: describeSlot('codex', '', ''),
    diverge: { ...describeSlot('codex', '', ''), count: 10, useDeadEnds: true },
    review: [{ tag: 'codex', ...describeSlot('codex', '', '') }],
    novelty: describeSlot('codex', '', ''),
  };
  if (!repoRoot) return fallback;
  let cfg = null;
  try {
    cfg = loadConfig(repoRoot, seatsFile || 'dispatch/seats.json', { useDshPatch: false });
  } catch {
    return fallback;
  }

  const sc = resolveStagePlan(cfg, 'scout', { useDshPatch: false });
  const dv = resolveDivergePlan(cfg, { useDshPatch: false });
  const rv = resolveExecutionPlan(cfg, { useDshPatch: false });
  const nv = resolveStagePlan(cfg, 'novelty', { useDshPatch: false });

  const scoutSeat = sc.ok ? sc.seatId : 'codex';
  const scoutModel = sc.ok ? (sc.model || '') : '';
  const scoutEffort = sc.ok ? (sc.effort || '') : '';
  const divSeat = dv.ok ? dv.seatId : 'codex';
  const divModel = dv.ok ? (dv.model || '') : '';
  const divEffort = dv.ok ? (dv.effort || '') : '';
  const novSeat = nv.ok ? nv.seatId : 'codex';
  const novModel = nv.ok ? (nv.model || '') : '';
  const novEffort = nv.ok ? (nv.effort || '') : '';
  const reviewSlots = (rv.ok && Array.isArray(rv.slots) && rv.slots.length > 0)
    ? rv.slots.map((s) => ({
      tag: s.tag || s.seat,
      ...describeSlot(s.seat, s.model || '', s.effort || '', cfg),
    }))
    : fallback.review;

  return {
    configured: true,
    scout: describeSlot(scoutSeat, scoutModel, scoutEffort, cfg),
    diverge: {
      ...describeSlot(divSeat, divModel, divEffort, cfg),
      count: dv.defaultCount || 10,
      useDeadEnds: dv.defaultUseDeadEnds !== false,
    },
    review: reviewSlots,
    novelty: describeSlot(novSeat, novModel, novEffort, cfg),
  };
}

function parseMetaAttrs(firstLine) {
  const out = {};
  const m = String(firstLine || '').match(/^<!--\s*(?:meta|manifest)\s+([\s\S]*?)\s*-->/);
  if (!m) return out;
  const tokens = m[1].split(/\s+/);
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq > 0) {
      out[tok.slice(0, eq)] = tok.slice(eq + 1);
    }
  }
  return out;
}

function parseReviewCardDetails(cardPath, ideaId, root = null) {
  let raw = '';
  if (root) {
    const rd = readFileInsideRoot(root, cardPath, { maxBytes: 128 * 1024 });
    if (!rd.ok) return null;
    raw = rd.text;
  } else {
    raw = readUtf8Safe(cardPath);
  }
  const firstLine = (raw.split(/\r?\n/, 1)[0] || '').trim();
  const meta = parseMetaAttrs(firstLine);
  const base = path.basename(cardPath, '.md');
  const tag = base.startsWith(ideaId + '.') ? base.slice(ideaId.length + 1) : base;
  const seat = tag.replace(/[0-9]+$/, '') || tag;
  const model = cleanModelName(meta.model || meta.declared || '') || seat;

  let dims = null;
  let dimReasons = null;
  let score25 = null;
  let verdict = '';
  let confidence = '';
  let note = '';

  try {
    const ex = extractCardVerdict(raw);
    if (ex && ex.found && ex.data && typeof ex.data === 'object') {
      const obj = ex.data;
      verdict = String(ex.verdict || obj.verdict || '').trim().toLowerCase();
      confidence = obj.confidence !== undefined && obj.confidence !== null ? String(obj.confidence).trim() : '';
      const scObj = (obj.scores && typeof obj.scores === 'object') ? obj.scores : obj;
      const parsedDims = {};
      const parsedReasons = {};
      let sum = 0;
      let count = 0;
      for (const d of DIMS) {
        const rawEntry = scObj[d];
        const v = (rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry))
          ? Number(rawEntry.score)
          : Number(rawEntry);
        if (Number.isFinite(v) && v >= 1 && v <= 5) {
          parsedDims[d] = v;
          sum += v;
          count += 1;
        }
        if (rawEntry && typeof rawEntry === 'object' && rawEntry.reason) {
          parsedReasons[d] = String(rawEntry.reason).replace(/\s+/g, ' ').trim();
        }
      }
      if (count > 0) {
        dims = parsedDims;
        dimReasons = Object.keys(parsedReasons).length > 0 ? parsedReasons : null;
        // 仅当五维完整齐全时才计算 /25 总分，残缺维度绝不按比例折算伪造满分
        score25 = count === DIMS.length ? Math.round(sum * 10) / 10 : null;
      }
      const kr = (verdict === 'kill' && obj.kill_reason && typeof obj.kill_reason !== 'boolean')
        ? String(obj.kill_reason).replace(/\s+/g, ' ').trim()
        : '';
      note = String(
        kr
        || obj.one_line
        || obj.summary
        || obj.key_strength
        || obj.rationale
        || (dimReasons && Object.values(dimReasons)[0])
        || ''
      ).replace(/\s+/g, ' ').trim();
    }
  } catch { /* ignore */ }

  return {
    tag,
    seat,
    model,
    sha: meta.sha || '',
    ts: meta.ts || '',
    dims,
    dimReasons,
    score25,
    verdict,
    confidence,
    note: note.slice(0, 160),
    preview: truncPreview(raw),
  };
}

function humanIdeaCode(ideaId) {
  const raw = String(ideaId || '').trim();
  if (!raw) return '候选方案';
  const m = raw.match(/^idea[_-]?0*(\d+)$/i);
  if (m) return '方案 ' + m[1];
  return raw.replace(/\.md$/i, '').replace(/[_-]+/g, ' ');
}

function cleanIdeaTitleText(ideaId, title) {
  let t = String(title || '').trim();
  if (!t) return '';
  if (ideaId) {
    const esc = String(ideaId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp('^' + esc + '\\s*[:：—–-]\\s*', 'i'), '').trim();
    if (t.toLowerCase() === String(ideaId).toLowerCase()) return '';
  }
  return t.replace(/^idea[_-]?0*\d+\s*[:：—–-]\s*/i, '').trim();
}

function parseBriefSummary(briefPath, ideaId, rawTextOverride = null) {
  const raw = rawTextOverride !== null ? String(rawTextOverride) : readUtf8Safe(briefPath);
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  const meta = parseMetaAttrs(lines[0] || '');
  const sha = sha12Text(raw);
  let title = '';
  const ideaSectionIdx = raw.search(/^###[ \t]*Idea\b/m);
  const ideaSlice = ideaSectionIdx >= 0 ? raw.slice(ideaSectionIdx) : raw;
  const idTitle = ideaSlice.match(/^\*\*ID\*\*\s*[:：]\s*idea_[0-9A-Za-z_-]+\s*(?:[—\-:：]\s*(.+))?$/im)
    || ideaSlice.match(/^###\s*idea_[0-9A-Za-z_-]+\s*[—\-:：]\s*([^\r\n]+)/im)
    || ideaSlice.match(/^###\s*Idea\s*[—\-:：]\s*([^\r\n]+)/m);
  if (idTitle && idTitle[1] && idTitle[1].trim()) {
    title = idTitle[1].trim();
  }
  if (!title) {
    const hyp = ideaSlice.match(/^[ \t]*(?:[-+*][ \t]+)?(?:\*\*)?(?:核心机制|一句话想法|核心改动|假设|Hypothesis|Title|标题)(?:\*\*)?[ \t]*[:：][ \t]*(.+)$/im);
    if (hyp && hyp[1] && hyp[1].trim()) title = hyp[1].trim();
  }
  return {
    ideaId,
    title: (title || ideaId).slice(0, 72),
    anchor: meta.anchor || 'none',
    isha: meta.isha || meta.pool || '',
    bsha: meta.bsha || '',
    sha,
    preview: truncPreview(raw),
  };
}

function parseVerdictDecision(verdictPath, root = null, shaOpts = {}) {
  if (!verdictPath || !fs.existsSync(verdictPath)) {
    return { exists: false, decision: 'pending', stale: false, recordedBriefSha: '', preview: '' };
  }
  let raw = '';
  if (root) {
    // 读取完整裁决正文（与 summarizeTopic 保持同口径，杜绝 64 KiB 截断遗漏尾部冲突 brief_sha）
    const rd = readFileInsideRoot(root, verdictPath, { maxBytes: 4 * 1024 * 1024 });
    if (!rd.ok || rd.truncated) {
      return { exists: false, decision: 'pending', stale: false, recordedBriefSha: '', preview: '' };
    }
    raw = rd.text;
  } else {
    raw = readUtf8Safe(verdictPath);
  }
  const parsed = parseVerdictText(raw, shaOpts);
  return {
    exists: true,
    decision: parsed.decision || 'pending',
    stale: Boolean(parsed.stale),
    recordedBriefSha: parsed.recordedBriefSha || '',
    preview: truncPreview(raw),
  };
}

function parseNoveltySummary(novPath, root = null) {
  if (!novPath || !fs.existsSync(novPath)) return null;
  let raw = '';
  let realNovPath = novPath;
  if (root) {
    const rd = readFileInsideRoot(root, novPath, { maxBytes: 256 * 1024 });
    if (!rd.ok || rd.truncated) return null;
    raw = rd.text;
    realNovPath = rd.realPath || novPath;
  } else {
    raw = readUtf8Safe(novPath);
  }
  // 与 CLI check-novelty 严格共用同一真源校验器与解析结果（杜绝二次扫描 YAML 产生风险口径分叉）
  const chk = checkNoveltyReport(realNovPath);
  if (!chk || !chk.ok || !chk.data || typeof chk.data !== 'object') return null;

  const meta = parseMetaAttrs(raw.split(/\r?\n/, 1)[0] || '');
  const obj = chk.data;
  const rawRisk = String(obj.duplication_risk || '').trim().toLowerCase();
  const risk = ['low', 'mid', 'high'].includes(rawRisk) ? rawRisk : '';
  const confidence = obj.confidence !== undefined && obj.confidence !== null ? String(obj.confidence).trim() : '';
  const closestCount = Array.isArray(obj.closest_works) ? obj.closest_works.length : 0;
  const note = String(obj.recommendation || obj.differentiation || obj.note || '').replace(/\s+/g, ' ').trim();
  if (!risk) return null;
  const rel = root ? path.relative(path.resolve(root), path.resolve(novPath)).replace(/\\/g, '/') : '';
  return {
    rel,
    briefRel: meta.brief || '',
    briefSha: (meta.brief_sha || meta.sha || '').toLowerCase(),
    risk,
    confidence,
    closestCount,
    seat: meta.seat || '',
    model: cleanModelName(meta.model || ''),
    sha: meta.sha || '',
    note: note.slice(0, 140),
    preview: truncPreview(raw),
  };
}

// 统一解析课题目录：严格区分 initProject() 生成的 ideas/default/ 与历史平铺目录 ideas/（绝不跨课题静默改道）
function resolveTopicDirRel(root, cleanTopic) {
  const t = String(cleanTopic || '').trim();
  if (t === '_flat') return 'ideas';
  if (t && t !== 'default') return 'ideas/' + t;
  const namedDefaultDir = path.join(root, 'ideas', 'default');
  const hasNamedDefault = fs.existsSync(namedDefaultDir) && (() => {
    try { return fs.statSync(namedDefaultDir).isDirectory(); } catch { return false; }
  })();
  return hasNamedDefault ? 'ideas/default' : 'ideas';
}

function discoverTopics(root, { includeFlat = false } = {}) {
  const ideasDir = path.join(root, 'ideas');
  const topics = [];
  if (!fs.existsSync(ideasDir)) {
    return [{ id: 'default', label: '默认课题', archived: false, dirRel: 'ideas', briefCount: 0, rawCount: 0 }];
  }

  const countTopicStats = (dirAbs) => {
    let briefCount = 0;
    let rawCount = 0;
    let latestMtime = 0;
    try {
      const bDir = path.join(dirAbs, 'briefs');
      if (fs.existsSync(bDir) && fs.statSync(bDir).isDirectory()) {
        for (const f of fs.readdirSync(bDir)) {
          if (f.endsWith('.md') && !f.startsWith('.')) {
            briefCount += 1;
            const mt = fs.statSync(path.join(bDir, f)).mtimeMs;
            if (mt > latestMtime) latestMtime = mt;
          }
        }
      }
      for (const f of fs.readdirSync(dirAbs)) {
        if (f.startsWith('raw-') && f.endsWith('.md')) {
          rawCount += 1;
          const mt = fs.statSync(path.join(dirAbs, f)).mtimeMs;
          if (mt > latestMtime) latestMtime = mt;
        }
      }
    } catch { /* ignore */ }
    return { briefCount, rawCount, latestMtime };
  };

  // 1) Active named topics under ideas/<slug>
  try {
    for (const ent of fs.readdirSync(ideasDir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.') || RESERVED_IDEAS_DIRS.has(ent.name.toLowerCase())) continue;
      const abs = path.join(ideasDir, ent.name);
      const st = countTopicStats(abs);
      topics.push({
        id: ent.name,
        label: ent.name,
        archived: false,
        dirRel: 'ideas/' + ent.name,
        ...st,
      });
    }
  } catch { /* ignore */ }

  // 2) Flat root ideas/briefs or ideas/raw-*.md（若已存在 ideas/default/ 目录则平铺根分配 _flat 避免双 default 碰撞）
  const hasNamedDefault = topics.some((t) => t.id === 'default');
  const rootStats = countTopicStats(ideasDir);
  if (rootStats.briefCount > 0 || rootStats.rawCount > 0 || topics.length === 0 || includeFlat) {
    topics.push({
      id: hasNamedDefault ? '_flat' : 'default',
      label: hasNamedDefault ? '根目录平铺课题' : '默认主课题',
      archived: false,
      dirRel: 'ideas',
      ...rootStats,
    });
  }

  // 3) Archived historical rounds under ideas/archive/<slug>
  const archDir = path.join(ideasDir, 'archive');
  try {
    if (fs.existsSync(archDir) && fs.statSync(archDir).isDirectory()) {
      for (const ent of fs.readdirSync(archDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        const abs = path.join(archDir, ent.name);
        const st = countTopicStats(abs);
        if (st.briefCount > 0 || st.rawCount > 0) {
          topics.push({
            id: 'archive/' + ent.name,
            label: ent.name + '（历史归档）',
            archived: true,
            dirRel: 'ideas/archive/' + ent.name,
            ...st,
          });
        }
      }
    }
  } catch { /* ignore */ }

  topics.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    if ((b.briefCount > 0) !== (a.briefCount > 0)) return b.briefCount > 0 ? 1 : -1;
    if (b.latestMtime !== a.latestMtime) return b.latestMtime - a.latestMtime;
    return a.id.localeCompare(b.id);
  });

  return topics;
}

function buildTopologyGraph({
  focusStage,
  focusIdea,
  ideas,
  papers,
  hasPool,
  poolSha12,
  poolPreview,
  baselines,
  rawPools,
  deadEndsCount,
  deadEndsPreview,
  contracts,
  lineup,
  activeRun,
  topicInfo,
}) {
  const nodes = [];
  const edges = [];
  const addNode = (n) => { nodes.push(n); return n.id; };
  const addEdge = (from, to, status = 'ready', label = '') => {
    edges.push({
      id: from + '->' + to,
      from,
      to,
      status,
      label,
      animated: status === 'working',
    });
  };
  const ySpread = (count, idx, minY = 92, maxY = 428) => {
    if (count <= 1) return Math.round((minY + maxY) / 2);
    return Math.round(minY + ((maxY - minY) * idx) / (count - 1));
  };

  if (focusStage === 'S0') {
    const scoutRun = activeRun && activeRun.stage === 'S0' ? activeRun : null;
    const in1 = addNode({
      id: 's0-role',
      col: 0,
      x: 118,
      y: 165,
      kind: 'input',
      title: '文献调研契约',
      subtitle: 'LaTeX / HTML 源码优先',
      badge: 'roles/scout.md',
      status: 'done',
      inspect: {
        title: 'S0 文献调研契约（源码优先）',
        kindLabel: '推式角色指令',
        fileRel: 'roles/scout.md',
        metaRows: [
          ['优先级策略', 'arXiv TeX/HTML/Markdown 优先，无源码才回退 PDF'],
          ['沙箱模式', '独立临时目录 os.tmpdir() 物理隔离'],
        ],
        preview: '优先获取 arXiv LaTeX/TeX 源码或 HTML/Markdown，自动按 === CARD: <slug>.md === 切分多张文献卡并逐张经 checkPaperCard 校验。',
      },
    });
    const in2 = addNode({
      id: 's0-dedup',
      col: 0,
      x: 118,
      y: 345,
      kind: 'input',
      title: '已入库去重索引',
      subtitle: papers.length + ' 篇既有文献卡',
      badge: 'papers/cards/',
      status: papers.length > 0 ? 'done' : 'ready',
      inspect: {
        title: '已收录文献卡片清单（共 ' + papers.length + ' 篇）',
        kindLabel: 'S0 文献库',
        fileRel: 'papers/cards',
        metaRows: [['合格文献卡', papers.length + ' 张']],
        preview: papers.slice(0, 25).map((p) => '• ' + p.id + (p.venue ? ' [' + p.venue + ']' : '') + ' — ' + p.title).join('\n') || '暂无已入库文献卡',
      },
    });
    const hub = addNode({
      id: 's0-hub',
      col: 1,
      x: 342,
      y: 255,
      kind: 'hub',
      title: 'Scout 调研派工器',
      subtitle: '推式装填 · 自动切卡校验',
      badge: scoutRun ? '运行中' : '就绪',
      status: scoutRun ? 'working' : (papers.length > 0 ? 'done' : 'ready'),
      inspect: {
        title: 'Scout 文献调研调度中心',
        kindLabel: '主控调度节点',
        fileRel: 'papers/cards',
        metaRows: [
          ['默认执行座位', lineup.scout.seat + ' · ' + (lineup.scout.resolvedModel || '默认模型')],
          ['门禁校验器', 'checkPaperCard + assemblePaperPool'],
        ],
        actions: ['pool'],
        preview: '每次调研在系统临时空沙箱内独立执行，合格卡写入 papers/cards/<slug>.md，坏卡自动隔离至 rejected/。',
      },
    });
    addEdge(in1, hub, scoutRun ? 'working' : 'done');
    addEdge(in2, hub, scoutRun ? 'working' : 'done');

    const wStatus = scoutRun ? 'working' : (papers.length > 0 ? 'done' : 'ready');
    const scoutEffortLabel = lineup.scout.embeddedEffort
      ? ('随模型 (' + lineup.scout.embeddedEffort + ')')
      : (lineup.scout.effort || '默认');
    const workerNode = addNode({
      id: 's0-worker',
      col: 2,
      x: 590,
      y: papers.length > 0 ? 150 : 255,
      kind: 'worker',
      seat: (scoutRun && scoutRun.workers[0] && scoutRun.workers[0].seat) || lineup.scout.seat,
      model: (scoutRun && scoutRun.workers[0] && scoutRun.workers[0].model) || lineup.scout.resolvedModel || '默认模型',
      effort: (scoutRun && scoutRun.workers[0] && scoutRun.workers[0].effort) || lineup.scout.effort || lineup.scout.embeddedEffort || '',
      sandbox: 'os.tmpdir()',
      title: ((scoutRun && scoutRun.workers[0] && scoutRun.workers[0].seat) || lineup.scout.seat) + ' · 调研员',
      subtitle: (scoutRun && scoutRun.workers[0] && scoutRun.workers[0].model) || lineup.scout.resolvedModel || '默认模型',
      badge: scoutRun ? '检索中' : '仓外沙箱',
      status: wStatus,
      startedAt: scoutRun ? scoutRun.startedAt : null,
      inspect: {
        title: '文献调研 Worker（' + lineup.scout.seat + '）',
        kindLabel: '独立沙箱 Worker',
        fileRel: 'papers/cards',
        metaRows: [
          ['执行工具', lineup.scout.seat],
          ['模型身份', lineup.scout.resolvedModel || '跟随工具默认'],
          ['思考强度', scoutEffortLabel],
          ['物理隔离', 'os.tmpdir() 空沙箱（零主控记忆污染）'],
        ],
        preview: scoutRun ? ('正在执行调研任务：' + scoutRun.title) : '空闲待命；可在命令行或主控会话发起新一轮定向文献调研。',
      },
    });
    addEdge(hub, workerNode, wStatus, '推式 Prompt');

    const samplePapers = papers.slice(0, 3);
    const outPool = addNode({
      id: 's0-pool',
      col: 3,
      x: 848,
      y: 255,
      kind: 'gate',
      title: '领域文献池 _pool.md',
      subtitle: hasPool ? ('已装配 ' + papers.length + ' 篇 · sha ' + poolSha12.slice(0, 8)) : '尚未拼装 _pool.md',
      badge: hasPool ? 'POOL READY' : '待汇总',
      status: hasPool ? 'done' : 'pending',
      inspect: {
        title: '领域专家上下文池 papers/cards/_pool.md',
        kindLabel: 'S0 出口产物',
        fileRel: 'papers/cards/_pool.md',
        sha: poolSha12,
        metaRows: [
          ['入池卡片数', papers.length + ' 篇'],
          ['池文件状态', hasPool ? '已生成（可直接喂给 S2 发散）' : '待生成'],
        ],
        actions: ['pool'],
        preview: poolPreview || '尚未生成 _pool.md，点击下方「汇总文献池」即可一键拼装。',
      },
    });
    addEdge(workerNode, outPool, hasPool ? 'done' : wStatus);

    samplePapers.forEach((p, idx) => {
      const pid = addNode({
        id: 's0-paper-' + idx,
        col: 2,
        x: 590,
        y: 265 + idx * 82,
        kind: 'artifact',
        title: p.id.slice(0, 26),
        subtitle: (p.venue ? p.venue + ' · ' : '') + p.title.slice(0, 26),
        badge: p.hasCode ? '含开源代码' : '文献卡',
        status: 'done',
        inspect: {
          title: p.title || p.id,
          kindLabel: '单篇结构化文献卡',
          fileRel: p.rel,
          metaRows: [
            ['paper_id', p.id],
            ['发表会议/来源', p.venue || '—'],
            ['开源代码', p.codeUrl || 'none'],
          ],
          preview: p.preview,
        },
      });
      addEdge(hub, pid, 'done');
      addEdge(pid, outPool, hasPool ? 'done' : 'ready');
    });

    return { focusStage, focusIdeaId: focusIdea ? focusIdea.ideaId : '', nodes, edges };
  }

  if (focusStage === 'S1') {
    const inNode = addNode({
      id: 's1-in',
      col: 0,
      x: 118,
      y: 255,
      kind: 'input',
      title: '窄选 Top 3–5 近邻工作',
      subtitle: '锁定公开指标与开源代码',
      badge: 'S0 → S1',
      status: papers.length > 0 ? 'done' : 'ready',
      inspect: {
        title: '基线选型输入（来自 S0 文献池）',
        kindLabel: '上游输入',
        fileRel: 'papers/cards/_pool.md',
        metaRows: [['候选文献卡', papers.length + ' 篇']],
        preview: poolPreview || '从文献池窄选有开源代码的顶会工作建立复现锚点。',
      },
    });
    const hub = addNode({
      id: 's1-hub',
      col: 1,
      x: 342,
      y: 255,
      kind: 'hub',
      title: 'repro-watch 复现巡检',
      subtitle: '数据集 sha256 + 训练心跳',
      badge: baselines.length + ' 个基线',
      status: baselines.some((b) => b.signed) ? 'done' : 'ready',
      inspect: {
        title: 'S1 基线复现与锚点核验闸门',
        kindLabel: '确定性闸门',
        fileRel: 'baselines',
        metaRows: [
          ['基线目录总数', String(baselines.length)],
          ['已签 SIGNOFF: PASS', String(baselines.filter((b) => b.signed).length)],
        ],
        preview: '复现不是为了验证别人，而是为后续所有 Idea 建立不可篡改的定量尺子（REPRO.md §3 复现表 + §4 人类签字 SIGNOFF: PASS + BRIEF_BLOCK.md）。',
      },
    });
    addEdge(inNode, hub, baselines.length > 0 ? 'done' : 'ready');

    const gate = addNode({
      id: 's1-gate',
      col: 3,
      x: 848,
      y: 255,
      kind: 'gate',
      title: '人类签字验收锚点',
      subtitle: baselines.some((b) => b.signed) ? 'SIGNOFF: PASS 已就绪' : '等待签下 SIGNOFF: PASS',
      badge: baselines.filter((b) => b.signed).length + '/' + baselines.length + ' 已签',
      status: baselines.some((b) => b.signed) ? 'done' : 'pending',
      inspect: {
        title: '人类基线签字闸门（SIGNOFF: PASS）',
        kindLabel: '人类唯一验收权',
        fileRel: baselines[0] ? (baselines[0].rel + '/REPRO.md') : 'baselines/TEMPLATE.REPRO.md',
        metaRows: [['验收规则', 'REPRO.md §3 含真实复现数值 + §4 签 SIGNOFF: PASS + BRIEF_BLOCK.md 数值一致']],
        preview: baselines[0] ? baselines[0].reproPreview : '暂无基线目录；请基于 baselines/TEMPLATE.REPRO.md 创建复现记录。',
      },
    });

    const list = baselines.length > 0 ? baselines.slice(0, 4) : [{ name: '待创建基线', rel: 'baselines', signed: false, metricSummary: '基于 TEMPLATE.REPRO.md 建立', preview: '' }];
    list.forEach((b, idx) => {
      const bid = addNode({
        id: 's1-base-' + idx,
        col: 2,
        x: 590,
        y: ySpread(list.length, idx, 110, 400),
        kind: 'artifact',
        title: b.name,
        subtitle: b.metricSummary || b.rel,
        badge: b.signed ? 'SIGNOFF: PASS' : '未签字',
        status: b.signed ? 'done' : 'pending',
        sha: b.bsha || '',
        inspect: {
          title: '基线锚点：' + b.name,
          kindLabel: b.signed ? '已签字基线尺子' : '待验收基线',
          fileRel: b.rel + '/BRIEF_BLOCK.md',
          sha: b.bsha || '',
          metaRows: [
            ['目录路径', b.rel],
            ['验收状态', b.signed ? '已通过 checkAnchor（SIGNOFF: PASS）' : '未完成签字或缺少数值'],
          ],
          preview: b.preview || b.reproPreview || '',
        },
      });
      addEdge(hub, bid, b.signed ? 'done' : 'ready');
      addEdge(bid, gate, b.signed ? 'done' : 'pending');
    });

    return { focusStage, focusIdeaId: focusIdea ? focusIdea.ideaId : '', nodes, edges };
  }

  if (focusStage === 'S2') {
    const divRun = activeRun && activeRun.stage === 'S2' ? activeRun : null;
    const signedBase = baselines.find((b) => b.signed) || baselines[0] || null;
    const inPool = addNode({
      id: 's2-pool',
      col: 0,
      x: 118,
      y: 130,
      kind: 'input',
      title: '领域文献池 _pool.md',
      subtitle: papers.length + ' 篇文献卡 · sha ' + (poolSha12 ? poolSha12.slice(0, 8) : 'none'),
      badge: hasPool ? '已挂载' : '缺失',
      status: hasPool ? 'done' : 'pending',
      sha: poolSha12,
      inspect: {
        title: '发散输入 ①：领域文献池 _pool.md',
        kindLabel: '推式输入源',
        fileRel: 'papers/cards/_pool.md',
        sha: poolSha12,
        metaRows: [['入池文献数', papers.length + ' 篇']],
        preview: poolPreview,
      },
    });
    const inBase = addNode({
      id: 's2-base',
      col: 0,
      x: 118,
      y: 255,
      kind: 'input',
      title: signedBase ? ('基线尺子 ' + signedBase.name) : '基线尺子 BRIEF_BLOCK',
      subtitle: signedBase ? (signedBase.signed ? 'SIGNOFF: PASS · bsha ' + signedBase.bsha.slice(0, 8) : '尚未签字') : '可选挂载',
      badge: signedBase && signedBase.signed ? '已锁尺子' : '未指定',
      status: signedBase && signedBase.signed ? 'done' : 'ready',
      sha: signedBase ? signedBase.bsha : '',
      inspect: {
        title: '发散输入 ②：基线锚点 BRIEF_BLOCK.md',
        kindLabel: '推式输入源',
        fileRel: signedBase ? (signedBase.rel + '/BRIEF_BLOCK.md') : 'baselines',
        sha: signedBase ? signedBase.bsha : '',
        metaRows: [['对齐要求', '每条候选 Idea 必须对齐该基线指标口径并给出 ≥2σ 量化预测']],
        preview: signedBase ? signedBase.preview : '未挂载基线尺子',
      },
    });
    const inDead = addNode({
      id: 's2-dead',
      col: 0,
      x: 118,
      y: 380,
      kind: 'input',
      title: lineup.diverge.useDeadEnds ? '禁入死胡同 dead-ends' : '纯空白零锚定模式',
      subtitle: lineup.diverge.useDeadEnds ? ('挂载前 ≤60 行（当前 ' + deadEndsCount + ' 条）') : '跳过历史讨论与否决锚定',
      badge: lineup.diverge.useDeadEnds ? '防踩坑开启' : '--no-dead-ends',
      status: 'done',
      inspect: {
        title: lineup.diverge.useDeadEnds ? '发散输入 ③：负知识死胡同清单（dead-ends.md）' : '纯空白发散模式（跳过 dead-ends.md）',
        kindLabel: '双模式策略开关',
        fileRel: topicInfo.dirRel + '/dead-ends.md',
        metaRows: [
          ['当前模式', lineup.diverge.useDeadEnds ? '常规挂载已证伪方向（最多前 60 行）' : '纯空白零历史锚定模式'],
          ['单轮默认条数', lineup.diverge.count + ' 条'],
        ],
        preview: deadEndsPreview || '当前死胡同清单为空。',
      },
    });

    const hub = addNode({
      id: 's2-hub',
      col: 1,
      x: 342,
      y: 255,
      kind: 'hub',
      title: 'Diverge 候选装填器',
      subtitle: '默认单轮 ' + lineup.diverge.count + ' 条 · 禁跨条串写',
      badge: divRun ? '生成中' : (rawPools.length + ' 份候选池'),
      status: divRun ? 'working' : (rawPools.length > 0 ? 'done' : 'ready'),
      inspect: {
        title: 'S2 候选发散调度器',
        kindLabel: '主控调度节点',
        fileRel: topicInfo.dirRel,
        metaRows: [
          ['执行座位', lineup.diverge.seat + ' · ' + (lineup.diverge.resolvedModel || '默认模型')],
          ['单轮条数', lineup.diverge.count + ' 条'],
          ['上下文洁净度', '仅含 roles/diverger.md + _pool.md + BRIEF_BLOCK + 可选 dead-ends'],
        ],
        preview: '发散模型与评审模型分席隔离，运行于 os.tmpdir() 空沙箱，严禁读取主控记忆或历史会话。',
      },
    });
    addEdge(inPool, hub, divRun ? 'working' : 'done');
    addEdge(inBase, hub, divRun ? 'working' : 'done');
    addEdge(inDead, hub, divRun ? 'working' : 'done');

    const divEffortLabel = lineup.diverge.embeddedEffort
      ? ('随模型 (' + lineup.diverge.embeddedEffort + ')')
      : (lineup.diverge.effort || '默认');
    const wNode = addNode({
      id: 's2-worker',
      col: 2,
      x: 590,
      y: rawPools.length > 0 ? 155 : 255,
      kind: 'worker',
      seat: lineup.diverge.seat,
      model: lineup.diverge.resolvedModel || '默认模型',
      effort: lineup.diverge.effort || lineup.diverge.embeddedEffort || '',
      sandbox: 'os.tmpdir()',
      title: lineup.diverge.seat + ' · 发散员',
      subtitle: lineup.diverge.resolvedModel || '默认模型',
      badge: divRun ? '发散中' : '仓外沙箱',
      status: divRun ? 'working' : (rawPools.length > 0 ? 'done' : 'ready'),
      startedAt: divRun ? divRun.startedAt : null,
      inspect: {
        title: '发散 Worker（' + lineup.diverge.seat + '）',
        kindLabel: '独立沙箱 Worker',
        fileRel: topicInfo.dirRel,
        metaRows: [
          ['座位 / 模型', lineup.diverge.seat + ' · ' + (lineup.diverge.resolvedModel || '默认模型')],
          ['思考强度', divEffortLabel],
          ['沙箱隔离', 'os.tmpdir() 独立临时目录'],
        ],
        preview: divRun ? ('正在生成候选池：' + divRun.title) : '最近共落盘 ' + rawPools.length + ' 份 raw-*.md 候选池。',
      },
    });
    addEdge(hub, wNode, divRun ? 'working' : (rawPools.length > 0 ? 'done' : 'ready'), '推式输入');

    const outBriefs = addNode({
      id: 's2-briefs-gate',
      col: 3,
      x: 848,
      y: 255,
      kind: 'gate',
      title: 'S3 拆单与自包含闸门',
      subtitle: ideas.length > 0 ? ('已拆出 ' + ideas.length + ' 张独立工单') : 'briefs 校验 2σ 判据与零串写',
      badge: ideas.length + ' 工单',
      status: ideas.length > 0 ? 'done' : 'ready',
      inspect: {
        title: 'S3 按课题拆单闸门（makeBriefs）',
        kindLabel: '确定性闸门',
        fileRel: topicInfo.dirRel + '/briefs',
        metaRows: [
          ['出处指纹核对', '重算对账 isha 与 bsha'],
          ['硬性拦截项', '跨条引用 idea_XX / 无数值空话预测 / <2σ 噪音判据'],
        ],
        preview: ideas.map((it) => '• ' + it.ideaId + ' — ' + it.title).join('\n') || '待运行 briefs 拆单生成独立工单。',
      },
    });
    addEdge(wNode, outBriefs, ideas.length > 0 ? 'done' : 'ready');

    rawPools.slice(0, 2).forEach((rp, idx) => {
      const rid = addNode({
        id: 's2-raw-' + idx,
        col: 2,
        x: 590,
        y: 280 + idx * 96,
        kind: 'artifact',
        title: rp.name.slice(0, 26),
        subtitle: '实得 ' + (rp.got || '?') + ' 条 · ' + (rp.model || 'diverger'),
        badge: 'isha ' + (rp.isha ? rp.isha.slice(0, 6) : 'ok'),
        status: 'done',
        sha: rp.isha,
        inspect: {
          title: '候选想法池：' + rp.name,
          kindLabel: 'S2 落盘产物',
          fileRel: rp.rel,
          sha: rp.isha,
          metaRows: [
            ['发散模型', rp.model || '—'],
            ['条数（实得/请求）', (rp.got || '?') + ' / ' + (rp.requested || '?')],
            ['基线指纹 bsha', rp.bsha || 'none'],
          ],
          preview: rp.preview,
        },
      });
      addEdge(hub, rid, 'done');
      addEdge(rid, outBriefs, ideas.length > 0 ? 'done' : 'ready');
    });

    return { focusStage, focusIdeaId: focusIdea ? focusIdea.ideaId : '', nodes, edges };
  }

  if (focusStage === 'S4.5') {
    const target = focusIdea || ideas[0] || null;
    const novRun = activeRun && activeRun.stage === 'S4.5' ? activeRun : null;
    const nov = target ? target.novelty : null;
    const inBrief = addNode({
      id: 's45-brief',
      col: 0,
      x: 118,
      y: 165,
      kind: 'input',
      title: target ? humanIdeaCode(target.ideaId) : '入围方案',
      subtitle: target ? (cleanIdeaTitleText(target.ideaId, target.title) || humanIdeaCode(target.ideaId)).slice(0, 26) : '票面占优候选',
      badge: target ? '入围方案' : 'S4 → S4.5',
      status: target ? 'done' : 'ready',
      sha: target ? target.sha : '',
      inspect: {
        title: target ? ('待查重：' + humanIdeaCode(target.ideaId) + (cleanIdeaTitleText(target.ideaId, target.title) ? (' · ' + cleanIdeaTitleText(target.ideaId, target.title)) : '')) : '待选定入围方案',
        kindLabel: '查重输入',
        fileRel: target ? target.briefRel : '',
        sha: target ? target.sha : '',
        metaRows: [['隔离约束', '仅读取当前唯一方案与文献池，避免混入其它候选']],
        preview: target ? target.preview : '先完成拆单与盲审，再对排名前列的候选启动前置查重。',
      },
    });
    const inPool = addNode({
      id: 's45-pool',
      col: 0,
      x: 118,
      y: 345,
      kind: 'input',
      title: '文献库对照',
      subtitle: papers.length + ' 篇已入库文献',
      badge: '文献池',
      status: hasPool ? 'done' : 'ready',
      inspect: {
        title: '本地文献库对照',
        kindLabel: '推式输入源',
        fileRel: 'papers/cards/_pool.md',
        sha: poolSha12,
        metaRows: [['文献数量', papers.length + ' 篇']],
        preview: poolPreview,
      },
    });
    const hub = addNode({
      id: 's45-hub',
      col: 1,
      x: 342,
      y: 255,
      kind: 'hub',
      title: '前置查重与探针调度',
      subtitle: '防撞车排查 + ≤2h 机制探针',
      badge: novRun ? '查重中' : 'S4.5',
      status: novRun ? 'working' : (nov ? 'done' : 'ready'),
      inspect: {
        title: 'S4.5 前置查重 + ≤2h 诊断探针',
        kindLabel: '主控调度节点',
        fileRel: 'papers/novelty',
        metaRows: [
          ['默认查重座位', lineup.novelty.seat + ' · ' + (lineup.novelty.resolvedModel || '默认模型')],
          ['统计探针工具', 'pilot-stats（同单元配对标准误 + 2σ MDE + 合规子集同题检验）'],
        ],
        actions: target && !topicInfo.archived ? ['run-novelty'] : [],
        ideaId: target ? target.ideaId : '',
        preview: '正式投入长时 GPU 训练前，先用单单隔离查重排查已发表撞车风险，并用 ≤2h 微探针验证机制前提。',
      },
    });
    addEdge(inBrief, hub, novRun ? 'working' : 'done');
    addEdge(inPool, hub, novRun ? 'working' : 'done');

    const novEffortLabel = lineup.novelty.embeddedEffort
      ? ('随模型 (' + lineup.novelty.embeddedEffort + ')')
      : (lineup.novelty.effort || '默认');
    const wNov = addNode({
      id: 's45-worker-nov',
      col: 2,
      x: 590,
      y: 175,
      kind: 'worker',
      seat: (nov && nov.seat) || lineup.novelty.seat,
      model: (nov && nov.model) || lineup.novelty.resolvedModel || '默认模型',
      effort: lineup.novelty.effort || lineup.novelty.embeddedEffort || '',
      sandbox: 'os.tmpdir()',
      title: ((nov && nov.seat) || lineup.novelty.seat) + ' · 查重员',
      subtitle: nov ? ('撞车风险: ' + nov.risk.toUpperCase()) : (lineup.novelty.resolvedModel || '定向查新 Worker'),
      badge: novRun ? '核查中' : (nov ? ('risk: ' + nov.risk) : '待派工'),
      status: novRun ? 'working' : (nov ? 'done' : 'ready'),
      startedAt: novRun ? novRun.startedAt : null,
      inspect: {
        title: (nov && nov.rel)
          ? ('查重报告：' + nov.rel)
          : (target ? ('查重报告：papers/novelty/' + target.ideaId + '.md') : '前置查重 Worker'),
        kindLabel: '独立沙箱查重卡',
        fileRel: (nov && nov.rel)
          ? nov.rel
          : (target ? ('papers/novelty/' + target.ideaId + '.md') : 'papers/novelty'),
        sha: nov ? nov.sha : '',
        metaRows: [
          ['撞车风险等级', nov ? nov.risk : '尚未运行'],
          ['近邻文献数', nov ? (nov.closestCount + ' 篇') : '—'],
          ['执行模型', (nov && nov.model) || lineup.novelty.resolvedModel || '默认'],
          ['思考强度', novEffortLabel],
        ],
        actions: target && !topicInfo.archived ? ['run-novelty'] : [],
        ideaId: target ? target.ideaId : '',
        preview: nov ? nov.preview : '尚未生成该工单的查重报告；可点击下方「发起前置查重」一键运行。',
      },
    });
    const wPilot = addNode({
      id: 's45-worker-pilot',
      col: 2,
      x: 590,
      y: 345,
      kind: 'artifact',
      title: '≤2h 诊断探针 pilot-stats',
      subtitle: '配对 Δ 越过 2σ MDE 检验',
      badge: '统计闸门',
      status: 'ready',
      inspect: {
        title: '配对诊断探针统计闸门（pilot-stats）',
        kindLabel: '确定性统计检验',
        fileRel: 'experiments',
        metaRows: [
          ['配对标准误', '同题/同单元配对差值 Bootstrap 标准误'],
          ['偏差防护', '强制 --compliant-field 同题合规子集对照，排除难易存活偏差'],
        ],
        preview: '运行命令示例：\nnode plugin/research-dispatch/bin/dispatch.mjs pilot-stats runs/armA.jsonl runs/armB.jsonl --compliant-field compliant',
      },
    });
    addEdge(hub, wNov, novRun ? 'working' : (nov ? 'done' : 'ready'), '单单隔离');
    addEdge(hub, wPilot, 'ready', '双臂 JSONL');

    const gate = addNode({
      id: 's45-gate',
      col: 3,
      x: 848,
      y: 255,
      kind: 'gate',
      title: 'S5 人类终裁台',
      subtitle: target ? ('当前裁决: ' + target.verdict.toUpperCase()) : '汇总评审 + 查重 + 探针',
      badge: target && target.verdict !== 'pending' ? target.verdict.toUpperCase() : '待拍板',
      status: target && target.verdict !== 'pending' ? 'done' : 'pending',
      verdict: target ? target.verdict : 'pending',
      inspect: {
        title: target ? ('人类终裁闸门：' + target.ideaId) : '人类唯一裁决权闸门',
        kindLabel: '硬约束 #2 · 人类拍板',
        fileRel: target ? target.verdictRel : '',
        canVerdict: Boolean(target && !topicInfo.archived),
        ideaId: target ? target.ideaId : '',
        currentVerdict: target ? target.verdict : 'pending',
        metaRows: [
          ['盲审均分', target && target.meanScore25 !== null ? (target.meanScore25 + ' / 25') : '—'],
          ['查重风险', nov ? nov.risk : '未查重'],
          ['当前状态', target ? target.verdict.toUpperCase() : 'pending'],
        ],
        preview: (target && target.verdictPreview) || '审阅盲审五维均分、查重报告与探针读数后，由人类在此拍板 GO / REVISE / KILL。',
      },
    });
    addEdge(wNov, gate, nov ? 'done' : 'ready');
    addEdge(wPilot, gate, 'ready');

    return { focusStage, focusIdeaId: target ? target.ideaId : '', nodes, edges };
  }

  if (focusStage === 'S6') {
    const goIdeas = ideas.filter((i) => i.verdict === 'go');
    const inGo = addNode({
      id: 's6-go',
      col: 0,
      x: 118,
      y: 255,
      kind: 'input',
      title: '人类 GO 放行工单',
      subtitle: goIdeas.length > 0 ? (goIdeas.map((g) => g.ideaId).join(', ')) : '需先在 S5 签下决定: go',
      badge: goIdeas.length + ' 项放行',
      status: goIdeas.length > 0 ? 'done' : 'pending',
      inspect: {
        title: '已获人类 GO 裁决的候选工单',
        kindLabel: '立项前置条件',
        fileRel: topicInfo.dirRel,
        metaRows: [['已放行 GO 数量', String(goIdeas.length)]],
        preview: goIdeas.map((g) => '• ' + g.ideaId + ' (' + (g.meanScore25 ?? '—') + '/25) — ' + g.title).join('\n') || '暂无决定为 go 的工单；禁止跨过人类裁决直接立项长训。',
      },
    });
    const hub = addNode({
      id: 's6-hub',
      col: 1,
      x: 342,
      y: 255,
      kind: 'hub',
      title: 'Research Contract 契约台',
      subtitle: 'S1..Sn / 独立 F1..Fn / 非空消融表',
      badge: contracts.length + ' 份契约',
      status: contracts.some((c) => c.valid) ? 'done' : 'ready',
      inspect: {
        title: 'S6 研究契约结构与反事后合理化门禁',
        kindLabel: '硬约束 #4 · 契约冻结',
        fileRel: 'contract/TEMPLATE.md',
        metaRows: [
          ['必填要素', '数值化 Hypothesis + 四项实现锚点 + 成功信号 S + 独立失败信号 F + 非空消融预期表'],
          ['变更规则', '开跑后严禁改指标迎合结果；迭代假设必须新建 .v2.md 并登记 CHANGELOG'],
        ],
        preview: '正式训练前先把什么算成功、什么算失败写死，并由 check-contract --record 将 sha12 指纹记入 contract/CHANGELOG.md。',
      },
    });
    addEdge(inGo, hub, goIdeas.length > 0 ? 'done' : 'pending');

    const readSafeInRepo = (relPath, maxBytes = 64 * 1024) => {
      if (!topicInfo || !topicInfo.rootAbs) return '';
      const abs = path.join(topicInfo.rootAbs, relPath);
      const rd = fs.existsSync(abs) ? readFileInsideRoot(topicInfo.rootAbs, abs, { maxBytes }) : { ok: false };
      return rd.ok ? rd.text : '';
    };

    const gate = addNode({
      id: 's6-changelog',
      col: 3,
      x: 848,
      y: 255,
      kind: 'gate',
      title: 'CHANGELOG 指纹锁死',
      subtitle: contracts.filter((c) => c.frozen).length + ' 份已登记 sha12',
      badge: contracts.some((c) => c.frozen) ? 'FROZEN' : '待冻结',
      status: contracts.some((c) => c.frozen) ? 'done' : 'pending',
      inspect: {
        title: '契约冻结账本 contract/CHANGELOG.md',
        kindLabel: '不可篡改指纹账本',
        fileRel: 'contract/CHANGELOG.md',
        metaRows: [['已登记冻结契约', contracts.filter((c) => c.frozen).length + ' 份']],
        preview: truncPreview(readSafeInRepo('contract/CHANGELOG.md', 64 * 1024)) || '尚未冻结任何正式实验契约。',
      },
    });

    const cList = contracts.length > 0
      ? contracts.slice(0, 4)
      : [{ id: 'TEMPLATE', rel: 'contract/TEMPLATE.md', valid: false, frozen: false, sha12: '', preview: readSafeInRepo('contract/TEMPLATE.md', 32 * 1024) }];
    cList.forEach((c, idx) => {
      const cid = addNode({
        id: 's6-contract-' + idx,
        col: 2,
        x: 590,
        y: ySpread(cList.length, idx, 120, 390),
        kind: 'artifact',
        title: c.id,
        subtitle: c.frozen ? ('已冻结 · sha ' + c.sha12.slice(0, 8)) : (c.valid ? '结构合格 · 待 --record' : '契约模板 / 草稿'),
        badge: c.frozen ? 'FROZEN' : 'DRAFT',
        status: c.frozen ? 'done' : 'ready',
        sha: c.sha12,
        inspect: {
          title: '研究契约：' + c.rel,
          kindLabel: c.frozen ? '已冻结正式契约' : '契约草稿 / 模板',
          fileRel: c.rel,
          sha: c.sha12,
          metaRows: [
            ['结构门禁 checkContractFile', c.valid ? '通过' : '待补齐数值信号或消融表'],
            ['CHANGELOG 冻结对账', c.frozen ? ('已锁死 (' + c.sha12 + ')') : '未登记'],
          ],
          preview: truncPreview(c.preview),
        },
      });
      addEdge(hub, cid, c.valid ? 'done' : 'ready');
      addEdge(cid, gate, c.frozen ? 'done' : 'pending');
    });

    return { focusStage, focusIdeaId: focusIdea ? focusIdea.ideaId : '', nodes, edges };
  }

  // Default & Signature View: S3 / S4 / S5 — Multi-Agent Isolated Blind Review `/swarm` Star Fan-Out!
  const target = focusIdea || ideas[0] || null;
  const revRun = activeRun && activeRun.stage === 'S4' && (!target || activeRun.targetId === target.ideaId)
    ? activeRun
    : null;

  const readReviewerSafe = () => {
    if (!topicInfo || !topicInfo.rootAbs) return '';
    const abs = path.join(topicInfo.rootAbs, 'roles', 'reviewer.md');
    const rd = fs.existsSync(abs) ? readFileInsideRoot(topicInfo.rootAbs, abs, { maxBytes: 32 * 1024 }) : { ok: false };
    return rd.ok ? rd.text : '';
  };

  const inRole = addNode({
    id: 's4-in-role',
    col: 0,
    x: 118,
    y: 126,
    kind: 'input',
    title: '盲审角色契约',
    subtitle: '五维 1–5 打分 · 散文 ≤30 字',
    badge: 'roles/reviewer.md',
    status: 'done',
    inspect: {
      title: '推式输入 ①：评审员角色契约 roles/reviewer.md',
      kindLabel: '推式输入源',
      fileRel: 'roles/reviewer.md',
      metaRows: [
        ['五维正向计分', 'novelty / feasibility / baseline_fit / impl_cost / expected_gain（满分 25）'],
        ['反嘴炮门禁', 'YAML 块外散文超过 30 字直接拒收进 rejected/'],
      ],
      preview: truncPreview(readReviewerSafe() || '独立五维打分角色契约（单票单卡，禁止模型互审）。'),
    },
  });

  const anchorLabel = target ? target.anchor : (baselines[0] ? baselines[0].rel : 'none');
  const matchedBase = baselines.find((b) => b.rel === anchorLabel || b.name === anchorLabel) || baselines[0] || null;
  const inAnchor = addNode({
    id: 's4-in-anchor',
    col: 0,
    x: 118,
    y: 255,
    kind: 'input',
    title: matchedBase ? ('基线锚点 ' + matchedBase.name) : '基线定量尺子',
    subtitle: matchedBase && matchedBase.signed ? ('SIGNOFF: PASS · bsha ' + (target && target.bsha ? target.bsha.slice(0, 8) : matchedBase.bsha.slice(0, 8))) : '独立校准 / 待签字',
    badge: matchedBase && matchedBase.signed ? '已验尺子' : 'anchor',
    status: matchedBase && matchedBase.signed ? 'done' : 'ready',
    sha: (target && target.bsha) || (matchedBase && matchedBase.bsha) || '',
    inspect: {
      title: '推式输入 ②：基线定量锚点（' + (matchedBase ? matchedBase.rel : anchorLabel) + '）',
      kindLabel: '推式输入源',
      fileRel: matchedBase ? (matchedBase.rel + '/BRIEF_BLOCK.md') : 'baselines',
      sha: (target && target.bsha) || (matchedBase && matchedBase.bsha) || '',
      metaRows: [
        ['anchor 标记', anchorLabel],
        ['签字验收', matchedBase && matchedBase.signed ? 'SIGNOFF: PASS' : '未关联或校准豁免'],
      ],
      preview: matchedBase ? matchedBase.preview : '工单内嵌 ### Baseline 定量对照段。',
    },
  });

  const inBrief = addNode({
    id: 's4-in-brief',
    col: 0,
    x: 118,
    y: 384,
    kind: 'input',
    title: target ? humanIdeaCode(target.ideaId) : '待生成方案',
    subtitle: target ? (cleanIdeaTitleText(target.ideaId, target.title) || humanIdeaCode(target.ideaId)).slice(0, 26) : '每次独立评审单个方案',
    badge: target ? '候选方案' : '物理隔离',
    status: target ? 'done' : 'pending',
    sha: target ? target.sha : '',
    inspect: {
      title: target ? (humanIdeaCode(target.ideaId) + ' · ' + (cleanIdeaTitleText(target.ideaId, target.title) || humanIdeaCode(target.ideaId))) : '尚无候选方案',
      kindLabel: '候选方案',
      fileRel: target ? target.briefRel : (topicInfo.dirRel + '/briefs'),
      sha: target ? target.sha : '',
      pushedInputs: target ? [
        'roles/reviewer.md（五维盲审标尺）',
        target.briefRel + '（sha=' + target.sha + '，含内嵌 ### Baseline）',
        '已物理屏蔽：AGENTS.md / lessons.md / 其它候选方案 / 其它评审员选票',
      ] : [],
      metaRows: target ? [
        ['方案编号', humanIdeaCode(target.ideaId)],
        ['综合排名', target.rank ? ('#' + target.rank + '（均分 ' + target.meanScore25 + '/25）') : '待汇总'],
      ] : [],
      actions: target && !topicInfo.archived ? ['run-brief', 'run-novelty'] : [],
      ideaId: target ? target.ideaId : '',
      preview: target ? target.preview : '当前课题下暂无候选方案；可切换课题或先运行发散与拆单。',
    },
  });

  const targetValidCards = target ? target.cards.filter((c) => c.valid) : [];
  const hubStatus = revRun
    ? 'working'
    : (targetValidCards.length > 0 ? 'done' : (target && target.cards.length > 0 ? 'pending' : 'ready'));
  const hub = addNode({
    id: 's4-hub',
    col: 1,
    x: 342,
    y: 255,
    kind: 'hub',
    title: '多票盲审',
    subtitle: revRun ? '正在逐票独立派发评审' : '逐票独立盲审',
    badge: target
      ? (targetValidCards.length > 0 ? (targetValidCards.length + ' 票') : (target.cards.length > 0 ? '0 有效票' : (lineup.review.length + ' 席')))
      : (lineup.review.length + ' 席'),
    status: hubStatus,
    inspect: {
      title: '多票盲审调度',
      kindLabel: '独立盲审调度',
      fileRel: target ? target.manifestRel : 'dispatch/seats.json',
      sha: target ? target.sha : '',
      pushedInputs: [
        '仅向每个子进程显式注入：roles/reviewer.md + 当前唯一目标方案',
        '子进程 cwd 强制置于系统 os.tmpdir()/rd-worker-* 空沙箱（脱离 .git 树）',
        '严禁多模型互相辩论收敛，每张卡独立过 checkCardFile 门禁后汇总',
      ],
      metaRows: [
        ['当前方案', target ? (humanIdeaCode(target.ideaId) + ' · ' + (cleanIdeaTitleText(target.ideaId, target.title) || '').slice(0, 24)) : '无'],
        ['运行状态', (target && target.manifestStatus) || '待运行'],
        ['评审席位', String(lineup.review.length) + ' 席'],
      ],
      actions: target && !topicInfo.archived ? ['run-brief', 'summary'] : [],
      ideaId: target ? target.ideaId : '',
      preview: (target && target.manifestPreview) || '点击「启动多票盲审」即可按当前编排阵容对该方案发起独立盲审。',
    },
  });
  addEdge(inRole, hub, hubStatus);
  addEdge(inAnchor, hub, hubStatus);
  addEdge(inBrief, hub, hubStatus);

  // Determine worker fan-out slots:
  // 1) If a live run is active for this target, merge live telemetry workers + existing cards;
  // 2) Else if target has completed review cards, show all completed cards (plus any active lock indicator);
  // 3) Else show the configured lineup.review slots as ready preview nodes!
  let workerItems = [];
  if (revRun && Array.isArray(revRun.workers) && revRun.workers.length > 0) {
    const cardByTag = new Map((target ? target.cards : []).map((c) => [c.tag, c]));
    workerItems = revRun.workers.map((w) => {
      const card = cardByTag.get(w.tag);
      const lineMatch = lineup.review.find((sl) => sl.tag === w.tag || sl.seat === w.seat);
      return {
        tag: w.tag,
        seat: w.seat,
        model: (card && card.model) || cleanModelName(w.model) || w.seat,
        effort: normalizeEffort(w.effort) || (lineMatch ? lineMatch.effort : ''),
        embeddedEffort: embeddedModelEffort((card && card.model) || w.model) || (lineMatch ? lineMatch.embeddedEffort : ''),
        sandbox: w.sandbox || 'os.tmpdir()',
        status: w.status === 'done' || (card && card.valid) ? 'done' : (card ? 'pending' : w.status),
        startedAt: w.startedAt,
        durationMs: w.durationMs,
        score25: card && card.valid ? card.score25 : w.score25,
        dims: card ? card.dims : null,
        dimReasons: card ? card.dimReasons : null,
        verdict: (card && card.valid && card.verdict) || w.verdict || '',
        confidence: card ? card.confidence : '',
        note: (card && card.valid ? card.note : (card ? ('未通过核验：' + (card.excludedReason || 'invalid')) : '')) || w.error || '',
        fileRel: card ? card.rel : w.outputRel,
        sha: card ? card.sha : (target ? target.sha : ''),
        preview: card ? card.preview : ('Worker 状态：' + w.status + (w.error ? '\n错误：' + w.error : '')),
      };
    });
  } else if (target && target.cards.length > 0) {
    workerItems = target.cards.map((c) => {
      const lineMatch = lineup.review.find((sl) => sl.tag === c.tag || sl.seat === c.seat);
      return {
        tag: c.tag,
        seat: c.seat,
        model: c.model,
        effort: lineMatch ? lineMatch.effort : '',
        embeddedEffort: embeddedModelEffort(c.model) || (lineMatch ? lineMatch.embeddedEffort : ''),
        sandbox: 'os.tmpdir()',
        status: c.valid ? 'done' : 'pending',
        startedAt: null,
        durationMs: null,
        score25: c.valid ? c.score25 : null,
        dims: c.dims,
        dimReasons: c.dimReasons || null,
        verdict: c.valid ? c.verdict : 'invalid',
        confidence: c.confidence,
        note: c.valid ? c.note : ('未通过核验：' + (c.excludedReason || 'invalid')),
        fileRel: c.rel,
        sha: c.sha,
        preview: c.preview,
      };
    });
  } else {
    workerItems = lineup.review.map((sl) => ({
      tag: sl.tag,
      seat: sl.seat,
      model: sl.resolvedModel || sl.model || '默认模型',
      effort: sl.effort || '',
      embeddedEffort: sl.embeddedEffort || '',
      sandbox: 'os.tmpdir()',
      status: target && target.locked ? 'working' : 'ready',
      startedAt: null,
      durationMs: null,
      score25: null,
      dims: null,
      verdict: '',
      confidence: '',
      note: '待派工盲审槽位（物理隔离沙箱）',
      fileRel: '',
      sha: target ? target.sha : '',
      preview: '预设盲审席位：' + sl.tag + '（' + sl.seat + ' · ' + (sl.resolvedModel || sl.model || '工具默认模型') + '）。\n启动盲审后将在系统临时空沙箱内独立打分。',
    }));
  }

  const summaryHasVerifiedRank = Boolean(target && targetValidCards.length > 0 && target.rank !== null);
  const summaryNode = addNode({
    id: 's4-summary',
    col: 3,
    x: 848,
    y: 172,
    kind: 'artifact',
    title: '综合排名榜',
    subtitle: summaryHasVerifiedRank && target.meanScore25 !== null
      ? ('第 ' + target.rank + ' 名 · 均分 ' + target.meanScore25 + '/25')
      : (ideas.some((i) => i.rank !== null && i.meanScore25 !== null) ? '按五维总分降序' : '待评审后汇总'),
    badge: summaryHasVerifiedRank && target.meanScore25 !== null ? (target.meanScore25 + '/25') : '排名',
    status: summaryHasVerifiedRank ? 'done' : (target && target.cards.length > 0 ? 'pending' : 'ready'),
    inspect: {
      title: '跨方案五维综合排名榜',
      kindLabel: 'S4 汇总榜单',
      fileRel: topicInfo.dirRel + '/_summary.md',
      metaRows: [
        ['计分规则', '五维 1–5 正向计分，满分 25 自动降序'],
        ['候选方案数', String(ideas.length)],
      ],
      actions: !topicInfo.archived && ideas.length > 0 ? ['summary'] : [],
      preview: topicInfo.summaryPreview || ideas.map((it, idx) => '#' + (idx + 1) + ' ' + humanIdeaCode(it.ideaId) + ' — ' + (it.meanScore25 !== null ? (it.meanScore25 + '/25') : '待评') + ' [' + it.verdict.toUpperCase() + '] ' + (cleanIdeaTitleText(it.ideaId, it.title) || '')).join('\n'),
    },
  });

  const verdictStatus = target
    ? (target.verdict === 'pending' ? 'pending' : 'done')
    : 'ready';
  const verdictNode = addNode({
    id: 's5-human-gate',
    col: 3,
    x: 848,
    y: 348,
    kind: 'gate',
    title: '人类裁决',
    subtitle: target
      ? (target.verdict === 'pending'
        ? (humanIdeaCode(target.ideaId) + ' · 待拍板')
        : (humanIdeaCode(target.ideaId) + ' · ' + target.verdict.toUpperCase()))
      : '等待人类拍板',
    badge: target ? (target.verdict === 'pending' ? '待裁决' : target.verdict.toUpperCase()) : '待拍板',
    status: verdictStatus,
    verdict: target ? target.verdict : 'pending',
    inspect: {
      title: target ? (humanIdeaCode(target.ideaId) + (cleanIdeaTitleText(target.ideaId, target.title) ? (' · ' + cleanIdeaTitleText(target.ideaId, target.title)) : '')) : '人类裁决',
      kindLabel: '人类拍板',
      fileRel: target ? target.verdictRel : topicInfo.dirRel,
      canVerdict: Boolean(target && !topicInfo.archived),
      ideaId: target ? target.ideaId : '',
      currentVerdict: target ? target.verdict : 'pending',
      dims: target ? target.meanDims : null,
      score25: target ? target.meanScore25 : null,
      metaRows: target ? [
        ['当前方案', humanIdeaCode(target.ideaId)],
        ['五维总均分', target.meanScore25 !== null ? (target.meanScore25 + ' / 25（共 ' + target.cards.length + ' 票）') : '暂无有效票'],
        ['票型分布', 'GO ' + target.voteCounts.go + ' · REVISE ' + target.voteCounts.revise + ' · KILL ' + target.voteCounts.kill],
        ['查重状态', target.novelty ? ('已查重（' + target.novelty.risk + '）') : '未查重'],
        ['人工裁决', target.verdict === 'pending' ? '待拍板' : target.verdict.toUpperCase()],
      ] : [['规则', '最终 GO / REVISE / KILL 必须由人类拍板']],
      preview: (target && target.verdictPreview) || '审阅五维评分与查重结果后，在下方完成人类裁决。',
    },
  });
  addEdge(summaryNode, verdictNode, summaryHasVerifiedRank ? 'done' : 'ready', '呈交裁决');

  const shownWorkers = workerItems.slice(0, 6);
  shownWorkers.forEach((w, idx) => {
    const wEffortLabel = w.embeddedEffort
      ? ('随模型 (' + w.embeddedEffort + ')')
      : (w.effort || '默认');
    const wid = addNode({
      id: 's4-worker-' + w.tag + '-' + idx,
      col: 2,
      x: 590,
      y: ySpread(shownWorkers.length, idx, 88, 432),
      kind: 'worker',
      seat: w.seat,
      model: w.model,
      effort: w.effort || w.embeddedEffort || '',
      sandbox: w.sandbox,
      title: w.tag === w.seat ? (w.seat + ' · 盲审席') : (w.tag + ' · ' + w.seat),
      subtitle: w.model + (w.effort ? (' · ' + w.effort) : ''),
      badge: w.status === 'working'
        ? '盲审中'
        : (w.score25 !== null ? (w.score25 + '/25 · ' + (w.verdict || '').toUpperCase()) : (w.verdict ? w.verdict.toUpperCase() : '沙箱席位')),
      status: w.status,
      startedAt: w.startedAt,
      durationMs: w.durationMs,
      score25: w.score25,
      dims: w.dims,
      verdict: w.verdict,
      sha: w.sha,
      inspect: {
        title: '盲审席位 Worker：' + w.tag + '（' + w.model + '）',
        kindLabel: '仓外沙箱盲审票',
        fileRel: w.fileRel || '',
        sha: w.sha || '',
        dims: w.dims,
        dimReasons: w.dimReasons || null,
        score25: w.score25,
        verdict: w.verdict,
        pushedInputs: [
          'roles/reviewer.md',
          (target ? target.briefRel : 'brief') + (w.sha ? ' (sha=' + w.sha + ')' : ''),
          '沙箱目录：' + w.sandbox + '（与其它评审员物理隔离、互不可见）',
        ],
        metaRows: [
          ['席位标签 / 工具', w.tag + ' (' + w.seat + ')'],
          ['实测模型身份', w.model || '—'],
          ['思考强度', wEffortLabel],
          ['运行状态', w.status],
          ['五维总分', w.score25 !== null ? (w.score25 + ' / 25') : '—'],
          ['单票建议', w.verdict ? (w.verdict.toUpperCase() + (w.confidence ? ' (conf=' + w.confidence + ')' : '')) : '—'],
        ],
        preview: w.preview,
      },
    });
    const edgeInStatus = w.status === 'working' ? 'working' : (w.status === 'done' ? 'done' : (w.status === 'failed' ? 'failed' : 'ready'));
    addEdge(hub, wid, edgeInStatus, idx === 0 ? '隔离沙箱' : '');
    addEdge(wid, summaryNode, (w.status === 'done' && summaryHasVerifiedRank) ? 'done' : (w.status === 'working' ? 'working' : 'ready'));
  });

  return {
    focusStage: ['S3', 'S4', 'S5'].includes(focusStage) ? focusStage : 'S4',
    focusIdeaId: target ? target.ideaId : '',
    nodes,
    edges,
  };
}

export function buildSwarmSnapshot(repoRoot, opts = {}) {
  const root = path.resolve(String(repoRoot || '.'));
  const repoName = path.basename(root) || root;
  const markers = inspectWorkspaceMarkers(root);
  const seatsFile = String(opts.seatsFile || 'dispatch/seats.json').trim() || 'dispatch/seats.json';
  const lineup = readProjectLineupSummary(root, seatsFile);
  const ledger = readTelemetryLedger(root);
  const workingRuns = ledger.runs.filter((r) => r && r.status === 'working');
  const anyActiveRun = workingRuns[0] || null;

  // 1) S0 Literature Cards & Pool（全部经 readFileInsideRoot 受限读取，阻断单文件符号链接越界）
  const cardsDir = path.join(root, 'papers', 'cards');
  const papers = [];
  if (markers.exists && isInsideRoot(root, cardsDir) && fs.existsSync(cardsDir)) {
    try {
      for (const f of fs.readdirSync(cardsDir).sort()) {
        if (!f.endsWith('.md') || f === '_pool.md' || f.startsWith('.')) continue;
        const abs = path.join(cardsDir, f);
        const rd = readFileInsideRoot(root, abs, { maxBytes: 32 * 1024 });
        if (!rd.ok) continue;
        const txt = rd.text;
        const titleM = txt.match(/^[ \t]*title[ \t]*:[ \t]*(.+)$/m);
        const venueM = txt.match(/^[ \t]*venue[ \t]*:[ \t]*(.+)$/m);
        const codeM = txt.match(/^[ \t]*code_url[ \t]*:[ \t]*(.+)$/m);
        const codeUrl = codeM ? codeM[1].trim().replace(/^["']|["']$/g, '') : 'none';
        papers.push({
          id: f.slice(0, -3),
          rel: 'papers/cards/' + f,
          title: titleM ? titleM[1].trim().replace(/^["']|["']$/g, '') : f.slice(0, -3),
          venue: venueM ? venueM[1].trim().replace(/^["']|["']$/g, '') : '',
          codeUrl,
          hasCode: Boolean(codeUrl && codeUrl.toLowerCase() !== 'none' && codeUrl.toLowerCase() !== 'null'),
          preview: truncPreview(txt, 2200),
        });
      }
    } catch { /* ignore */ }
  }
  const poolAbs = path.join(cardsDir, '_pool.md');
  const poolRead = markers.exists && fs.existsSync(poolAbs) ? readFileInsideRoot(root, poolAbs, { maxBytes: 256 * 1024 }) : { ok: false };
  const hasPool = poolRead.ok;
  const poolRaw = hasPool ? poolRead.text : '';
  const poolSha12 = hasPool ? sha12Text(poolRaw) : '';

  // 2) S1 Baselines（仅对通过锚点校验且真实路径在仓内的基线生成原文预览，防软链越界泄露）
  const baselinesDir = path.join(root, 'baselines');
  const baselines = [];
  if (markers.exists && isInsideRoot(root, baselinesDir) && fs.existsSync(baselinesDir)) {
    try {
      for (const ent of fs.readdirSync(baselinesDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith('.') || /^TEMPLATE/i.test(ent.name)) continue;
        const rel = 'baselines/' + ent.name;
        const abs = path.join(baselinesDir, ent.name);
        const chk = checkAnchor(root, rel);
        const signed = Boolean(chk && chk.ok);
        let bbRaw = '';
        let reproRaw = '';
        if (signed) {
          const bbRead = readFileInsideRoot(root, path.join(abs, 'BRIEF_BLOCK.md'), { maxBytes: 32 * 1024 });
          if (bbRead.ok) bbRaw = bbRead.text;
          const reproRead = readFileInsideRoot(root, path.join(abs, 'REPRO.md'), { maxBytes: 32 * 1024 });
          if (reproRead.ok) reproRaw = reproRead.text;
        }
        const metricLine = bbRaw.split(/\r?\n/).find((l) => /[0-9]/.test(l) && !l.startsWith('#') && !l.startsWith('<!--')) || '';
        baselines.push({
          name: ent.name,
          rel,
          signed,
          statusError: signed ? '' : String((chk && chk.stderr) || '').trim().slice(0, 240),
          bsha: bbRaw ? sha12Text(bbRaw) : '',
          metricSummary: metricLine.replace(/^[*\-\s|]+/, '').trim().slice(0, 42),
          preview: signed ? truncPreview(bbRaw, 2400) : '',
          reproPreview: signed ? truncPreview(reproRaw, 2400) : '',
        });
      }
    } catch { /* ignore */ }
  }

  // 3) Topics & Active Topic Selection
  const includeFlat = opts.topic === '_flat' || workingRuns.some((r) => r && r.topic === '_flat');
  const topics = markers.exists
    ? discoverTopics(root, { includeFlat })
    : [{ id: 'default', label: '默认课题', archived: false, dirRel: 'ideas', briefCount: 0, rawCount: 0 }];
  let chosenTopic = topics.find((t) => t.id === opts.topic) || null;
  if (!chosenTopic && anyActiveRun && anyActiveRun.topic) {
    chosenTopic = topics.find((t) => t.id === anyActiveRun.topic) || null;
  }
  if (!chosenTopic) {
    chosenTopic = topics.find((t) => !t.archived && (t.briefCount > 0 || t.rawCount > 0))
      || topics.find((t) => t.briefCount > 0 || t.rawCount > 0)
      || topics[0];
  }

  const runMatchesChosenTopic = (r) => {
    if (!r) return false;
    if (r.stage === 'S0') return true;
    const runTopic = String(r.topic || '').trim();
    if (!runTopic) return true;
    if (runTopic === chosenTopic.id) return true;
    // 仅当平铺目录本身代表 default 课题（不存在独立 ideas/default/ 导致 id 变为 _flat）时，才匹配 default
    if (runTopic === 'default' && chosenTopic.id === 'default' && chosenTopic.dirRel === 'ideas') return true;
    return false;
  };
  const topicWorkingRuns = workingRuns.filter((r) => runMatchesChosenTopic(r));
  const activeRun = topicWorkingRuns[0] || null;
  const activeWorkerCount = topicWorkingRuns.reduce((sum, r) => {
    const cnt = (r.workers || []).filter((w) => w && w.status === 'working').length;
    return sum + (cnt || 1);
  }, 0);

  const topicDirAbs = path.join(root, chosenTopic.dirRel);
  const sumRead = fs.existsSync(path.join(topicDirAbs, '_summary.md'))
    ? readFileInsideRoot(root, path.join(topicDirAbs, '_summary.md'), { maxBytes: 64 * 1024 })
    : { ok: false };
  const summaryRaw = sumRead.ok ? sumRead.text : '';
  const deadEndsAbs = fs.existsSync(path.join(topicDirAbs, 'dead-ends.md'))
    ? path.join(topicDirAbs, 'dead-ends.md')
    : path.join(root, 'ideas', 'dead-ends.md');
  const deadEndsRead = fs.existsSync(deadEndsAbs)
    ? readFileInsideRoot(root, deadEndsAbs, { maxBytes: 64 * 1024 })
    : { ok: false };
  const deadEndsRaw = deadEndsRead.ok ? deadEndsRead.text : '';
  const deadEndsCount = deadEndsRaw
    .split(/\r?\n/)
    .filter((l) => /^\s*[-*0-9]/.test(l.trim()) && !l.includes('示例')).length;

  // 4) S2 Raw Idea Pools in Topic
  const rawPools = [];
  if (markers.exists && isInsideRoot(root, topicDirAbs) && fs.existsSync(topicDirAbs)) {
    try {
      for (const f of fs.readdirSync(topicDirAbs).sort().reverse()) {
        if (!f.startsWith('raw-') || !f.endsWith('.md')) continue;
        const abs = path.join(topicDirAbs, f);
        const rd = readFileInsideRoot(root, abs, { maxBytes: 128 * 1024 });
        if (!rd.ok) continue;
        const raw = rd.text;
        const meta = parseMetaAttrs(raw.split(/\r?\n/, 1)[0] || '');
        rawPools.push({
          name: f,
          rel: chosenTopic.dirRel + '/' + f,
          model: cleanModelName(meta.model || ''),
          requested: meta.requested || '',
          got: meta.got_ideas || meta.got || String((raw.match(/^###[ \t]+idea_/gm) || []).length || ''),
          isha: meta.isha || '',
          bsha: meta.bsha || '',
          preview: truncPreview(raw, 2800),
        });
      }
    } catch { /* ignore */ }
  }

  // 5) S3 Briefs + S4 Review Cards + S4.5 Novelty + S5 Verdicts
  const briefsDirAbs = path.join(topicDirAbs, 'briefs');
  const topicCardsDirAbs = path.join(topicDirAbs, 'cards');
  const ideaIdSet = new Set();
  if (markers.exists && isInsideRoot(root, briefsDirAbs) && fs.existsSync(briefsDirAbs)) {
    try {
      for (const f of fs.readdirSync(briefsDirAbs)) {
        if (f.endsWith('.md') && !f.startsWith('.')) ideaIdSet.add(f.slice(0, -3));
      }
    } catch { /* ignore */ }
  }
  if (markers.exists && isInsideRoot(root, topicCardsDirAbs) && fs.existsSync(topicCardsDirAbs)) {
    try {
      for (const f of fs.readdirSync(topicCardsDirAbs)) {
        if (f.endsWith('.manifest')) ideaIdSet.add(f.slice(0, -'.manifest'.length));
      }
    } catch { /* ignore */ }
  }

  // 复用 CLI 官方 summarizeTopic 结果作为唯一排名与有效票真源（消除桌面与 _summary.md 名次口径分叉）
  const officialSummary = markers.exists
    ? summarizeTopic(root, {
        briefsDir: chosenTopic.dirRel + '/briefs',
        cardsDir: chosenTopic.dirRel + '/cards',
        ideasDir: chosenTopic.dirRel,
        writeFile: false,
      })
    : null;
  const officialById = new Map();
  const officialOrderIdx = new Map();
  if (officialSummary && officialSummary.ok && Array.isArray(officialSummary.items)) {
    officialSummary.items.forEach((it, idx) => {
      officialById.set(it.rawId || it.id, it);
      officialOrderIdx.set(it.rawId || it.id, idx);
    });
  }

  const topicSlugForNov = (chosenTopic.dirRel && chosenTopic.dirRel.startsWith('ideas/') && !chosenTopic.archived)
    ? chosenTopic.id
    : '';

  const ideas = [];
  for (const ideaId of [...ideaIdSet]) {
    const briefAbs = path.join(briefsDirAbs, ideaId + '.md');
    const briefRel = chosenTopic.dirRel + '/briefs/' + ideaId + '.md';
    // [P2 #1] 读取完整 brief 字节以计算准确的 raw/LF 指纹（不截断在 128KiB），仅在展示预览时截断
    const briefRead = fs.existsSync(briefAbs) ? readFileInsideRoot(root, briefAbs, { maxBytes: 4 * 1024 * 1024 }) : { ok: false };
    const hasBrief = Boolean(briefRead.ok && !briefRead.truncated);
    const briefRawSha = hasBrief ? sha12Buf(briefRead.buf) : '';
    const briefInfo = hasBrief
      ? parseBriefSummary(briefAbs, ideaId, briefRead.text)
      : { ideaId, title: ideaId, anchor: 'none', isha: '', bsha: '', sha: '', preview: '' };

    const cards = [];
    let manifestStatus = '';
    let manifestPreview = '';
    const manifestAbs = path.join(topicCardsDirAbs, ideaId + '.manifest');
    const manifestRel = chosenTopic.dirRel + '/cards/' + ideaId + '.manifest';
    if (fs.existsSync(manifestAbs)) {
      const mfRead = readFileInsideRoot(root, manifestAbs, { maxBytes: 32 * 1024 });
      if (mfRead.ok) {
        manifestPreview = truncPreview(mfRead.text, 1800);
        const mm = parseMetaAttrs(manifestPreview.split('\n', 1)[0] || '');
        manifestStatus = mm.status || 'OK';
      }
    }
    const lockAbs = path.join(topicCardsDirAbs, ideaId + '.lock');
    const locked = fs.existsSync(lockAbs);

    const official = officialById.get(ideaId) || null;
    const validSeatMap = new Map();
    if (official && Array.isArray(official.votes)) {
      for (const v of official.votes) {
        validSeatMap.set(v.seat, v);
      }
    }

    if (fs.existsSync(topicCardsDirAbs)) {
      try {
        for (const f of fs.readdirSync(topicCardsDirAbs).sort()) {
          if (!f.startsWith(ideaId + '.') || !f.endsWith('.md')) continue;
          const mid = f.slice(ideaId.length + 1, -3);
          if (!mid || mid.includes('.')) continue;
          const cardAbs = path.join(topicCardsDirAbs, f);
          if (!isInsideRoot(root, cardAbs) || !fs.statSync(cardAbs).isFile()) continue;
          const parsedCard = parseReviewCardDetails(cardAbs, ideaId, root);
          if (!parsedCard) continue;
          const vMeta = validSeatMap.get(mid) || null;
          cards.push({
            ...parsedCard,
            valid: vMeta ? Boolean(vMeta.valid) : false,
            excludedReason: vMeta ? (vMeta.excludedReason || null) : 'unverified_card',
            rel: chosenTopic.dirRel + '/cards/' + f,
          });
        }
      } catch { /* ignore */ }
    }

    const scoredCards = cards.filter((c) => c.valid && c.score25 !== null);
    const meanScore25 = official
      ? official.avgTotal25
      : (scoredCards.length > 0
          ? Math.round((scoredCards.reduce((acc, c) => acc + c.score25, 0) / scoredCards.length) * 100) / 100
          : null);
    const meanDims = scoredCards.length > 0 ? {} : null;
    if (meanDims) {
      for (const d of DIMS) {
        const vals = scoredCards.map((c) => c.dims && c.dims[d]).filter(Number.isFinite);
        meanDims[d] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0;
      }
    }

    const voteCounts = official && official.counts
      ? { go: official.counts.go, revise: official.counts.revise, kill: official.counts.kill }
      : { go: 0, revise: 0, kill: 0 };

    const verdictRel = chosenTopic.dirRel + '/verdict-' + ideaId + '.md';
    const verdictInfo = parseVerdictDecision(
      path.join(topicDirAbs, 'verdict-' + ideaId + '.md'),
      root,
      { expectedBriefSha: briefInfo.sha, expectedRawSha: briefRawSha, briefMissing: !hasBrief },
    );

    const topicNovCand = topicSlugForNov
      ? path.join(root, 'papers', 'novelty', topicSlugForNov, ideaId + '.md')
      : path.join(root, 'papers', 'novelty', '_flat', ideaId + '.md');
    const novCand1 = path.join(root, 'papers', 'novelty', ideaId + '.md');
    const novCand2 = path.join(root, 'papers', 'novelty', 'novelty-' + ideaId + '.md');
    const hasOtherActiveTopicSameBriefSha = (shaToken) => {
      if (!shaToken) return false;
      for (const other of topics) {
        if (!other || other.archived || other.dirRel === chosenTopic.dirRel) continue;
        const otherBriefAbs = path.join(root, other.dirRel, 'briefs', ideaId + '.md');
        if (!fs.existsSync(otherBriefAbs)) continue;
        const rd = readFileInsideRoot(root, otherBriefAbs);
        if (!rd.ok) continue;
        if (sha12Text(rd.text) === shaToken || sha12Buf(rd.buf) === shaToken) {
          return true;
        }
      }
      return false;
    };
    const matchNoveltyCandidate = (candAbs, requireBriefMatch = true) => {
      if (!hasBrief) return null;
      if (!candAbs || !fs.existsSync(candAbs) || !isInsideRoot(root, candAbs)) return null;
      const parsed = parseNoveltySummary(candAbs, root);
      if (!parsed) return null;
      // 无论位于课题专属目录还是共享根目录，只要报告显式声明了 brief= 就必须精确匹配当前工单路径，杜绝跨课题串单
      if (parsed.briefRel) {
        if (parsed.briefRel !== briefRel) return null;
      } else if (requireBriefMatch) {
        if (!parsed.briefSha || (parsed.briefSha !== briefInfo.sha && parsed.briefSha !== briefRawSha)) {
          return null;
        }
        // 共享根目录无 brief= 的历史报告若同时匹配多个活跃课题的同 ID 同指纹工单，归属存在歧义，拒绝误归功
        if (hasOtherActiveTopicSameBriefSha(parsed.briefSha)) {
          return null;
        }
      }
      if (parsed.briefSha && parsed.briefSha !== briefInfo.sha && parsed.briefSha !== briefRawSha) return null;
      return parsed;
    };
    const novelty = matchNoveltyCandidate(topicNovCand, false)
      || matchNoveltyCandidate(novCand1, true)
      || matchNoveltyCandidate(novCand2, true);

    ideas.push({
      ideaId,
      hasBrief,
      isCalibration: /^(?:smoke|calib)_/i.test(ideaId),
      title: briefInfo.title,
      briefRel: hasBrief ? briefRel : '',
      manifestRel,
      manifestStatus: official ? official.manifestStatus : manifestStatus,
      manifestBriefMismatch: Boolean(official && official.manifestBriefMismatch),
      manifestPreview,
      verdictRel,
      anchor: briefInfo.anchor,
      isha: briefInfo.isha,
      bsha: briefInfo.bsha,
      sha: briefInfo.sha,
      rawSha: briefRawSha,
      preview: briefInfo.preview,
      locked,
      cards,
      meanScore25,
      meanDims,
      voteCounts,
      novelty,
      verdict: verdictInfo.decision,
      verdictExists: verdictInfo.exists,
      verdictStale: Boolean(verdictInfo.stale),
      verdictPreview: verdictInfo.preview,
      rank: official ? official.rank : null,
    });
  }

  ideas.sort((a, b) => {
    const ia = officialOrderIdx.has(a.ideaId) ? officialOrderIdx.get(a.ideaId) : Number.MAX_SAFE_INTEGER;
    const ib = officialOrderIdx.has(b.ideaId) ? officialOrderIdx.get(b.ideaId) : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    if (a.isCalibration !== b.isCalibration) return a.isCalibration ? 1 : -1;
    return a.ideaId.localeCompare(b.ideaId, undefined, { numeric: true });
  });

  // 6) Novelty Reports Total（仅统计有效查重报告，严格排除 rejected/stale/.superseded 等隔离目录）& S6 Contracts
  let totalNoveltyFiles = 0;
  const IGNORED_NOVELTY_SUBDIRS = new Set(['rejected', 'stale', '.superseded']);
  const novDir = path.join(root, 'papers', 'novelty');
  if (markers.exists && isInsideRoot(root, novDir) && fs.existsSync(novDir)) {
    try {
      for (const ent of fs.readdirSync(novDir, { withFileTypes: true })) {
        if (ent.name.startsWith('.') || ent.name.startsWith('last_novelty-')) continue;
        if (ent.isFile() && ent.name.endsWith('.md')) {
          const parsed = parseNoveltySummary(path.join(novDir, ent.name), root);
          if (parsed) totalNoveltyFiles += 1;
        } else if (ent.isDirectory() && !IGNORED_NOVELTY_SUBDIRS.has(ent.name)) {
          const subAbs = path.join(novDir, ent.name);
          if (!isInsideRoot(root, subAbs)) continue;
          for (const sub of fs.readdirSync(subAbs, { withFileTypes: true })) {
            if (sub.isFile() && sub.name.endsWith('.md') && !sub.name.startsWith('.') && !sub.name.startsWith('last_novelty-')) {
              const parsed = parseNoveltySummary(path.join(subAbs, sub.name), root);
              if (parsed) totalNoveltyFiles += 1;
            }
          }
        }
      }
    } catch { totalNoveltyFiles = 0; }
  }

  const contractDir = path.join(root, 'contract');
  const contracts = [];
  if (markers.exists && isInsideRoot(root, contractDir) && fs.existsSync(contractDir)) {
    try {
      for (const f of fs.readdirSync(contractDir).sort()) {
        if (!f.endsWith('.md') || f === 'TEMPLATE.md' || f === 'CHANGELOG.md' || f.startsWith('.')) continue;
        const abs = path.join(contractDir, f);
        // [P1 #10] 拒绝契约目录内的符号链接别名，防止未登记链接借用目标文件名的冻结状态
        let isSym = false;
        try { isSym = fs.lstatSync(abs).isSymbolicLink(); } catch { isSym = false; }
        const rd = !isSym ? readFileInsideRoot(root, abs, { maxBytes: 32 * 1024 }) : { ok: false, error: '契约文件不得使用符号链接别名' };
        if (!rd.ok || path.basename(rd.realPath) !== f) {
          contracts.push({
            id: f.slice(0, -3),
            rel: 'contract/' + f,
            valid: false,
            frozen: false,
            sha12: '',
            registeredSha: null,
            shaMatch: false,
            preview: '',
            error: rd.error || '契约文件名与真实目标不一致（禁止符号链接别名）',
          });
          continue;
        }
        const chk = checkContractFile(abs, { rootDir: root, record: false });
        const cSha = (chk && chk.sha12) || sha12Text(rd.text);
        const valid = Boolean(chk && chk.ok);
        const frozen = Boolean(valid && chk && chk.frozen === true && chk.shaMatch === true);
        contracts.push({
          id: f.slice(0, -3),
          rel: 'contract/' + f,
          valid,
          frozen,
          sha12: cSha,
          registeredSha: (chk && chk.registeredSha) || null,
          shaMatch: Boolean(chk && chk.shaMatch),
          preview: truncPreview(rd.text, 4000),
        });
      }
    } catch { /* ignore */ }
  }

  const realIdeas = ideas.filter((i) => !i.isCalibration);
  const readableRealIdeas = realIdeas.filter((i) => i.hasBrief);
  const validVoteCountOf = (it) => (it.voteCounts ? (it.voteCounts.go + it.voteCounts.revise + it.voteCounts.kill) : 0);
  const rankedRealIdeas = readableRealIdeas.filter((i) => i.rank !== null);
  const reviewedIdeas = readableRealIdeas.filter((i) => validVoteCountOf(i) > 0);
  const topicNoveltyCount = readableRealIdeas.filter((i) => Boolean(i.novelty)).length;
  const decidedIdeas = readableRealIdeas.filter((i) => i.verdict !== 'pending');
  const pendingVerdictCount = reviewedIdeas.filter((i) => i.verdict === 'pending').length;
  const topRankedIdea = rankedRealIdeas[0] || null;
  const topIdea = topRankedIdea || reviewedIdeas[0] || readableRealIdeas[0] || realIdeas[0] || ideas[0] || null;

  const activeRunForTopic = (stageId) => topicWorkingRuns.some((r) => r && r.stage === stageId);

  const stages = [
    {
      id: 'S0',
      code: 'S0',
      title: '文献调研',
      sub: '源码优先建池',
      badge: papers.length > 0 ? (papers.length + ' 篇卡') : '待调研',
      status: activeRunForTopic('S0') ? 'working' : (hasPool ? 'done' : (papers.length > 0 ? 'ready' : 'empty')),
    },
    {
      id: 'S1',
      code: 'S1',
      title: '基线复现',
      sub: 'SIGNOFF 尺子',
      badge: baselines.some((b) => b.signed) ? (baselines.filter((b) => b.signed).length + ' 已签字') : (baselines.length ? (baselines.length + ' 待签') : '待建锚'),
      status: baselines.some((b) => b.signed) ? 'done' : (baselines.length > 0 ? 'pending' : 'empty'),
    },
    {
      id: 'S2',
      code: 'S2',
      title: '候选发散',
      sub: '双模式候选池',
      badge: rawPools.length > 0 ? (rawPools.length + ' 份池') : ('默认 ' + lineup.diverge.count + ' 条'),
      status: activeRunForTopic('S2') ? 'working' : (rawPools.length > 0 ? 'done' : 'empty'),
    },
    {
      id: 'S3',
      code: 'S3',
      title: '隔离拆单',
      sub: '2σ 判据把关',
      badge: readableRealIdeas.length > 0 ? (readableRealIdeas.length + ' 张工单') : '待拆单',
      status: readableRealIdeas.length > 0 ? 'done' : 'empty',
    },
    {
      id: 'S4',
      code: 'S4',
      title: '多票盲审',
      sub: '沙箱扇出评议',
      badge: topRankedIdea && topRankedIdea.meanScore25 !== null
        ? ('#1 ' + topRankedIdea.meanScore25 + '/25')
        : (lineup.review.length + ' 票阵容'),
      status: activeRunForTopic('S4') || ideas.some((i) => i.locked)
        ? 'working'
        : (rankedRealIdeas.length > 0 ? 'done' : (readableRealIdeas.length > 0 ? 'ready' : 'empty')),
    },
    {
      id: 'S4.5',
      code: 'S4.5',
      title: '查重与探针',
      sub: '防撞车 + 2σ 探针',
      badge: topicNoveltyCount > 0 ? (topicNoveltyCount + ' 份查重') : '待核查',
      status: activeRunForTopic('S4.5') ? 'working' : (topicNoveltyCount > 0 ? 'done' : 'empty'),
    },
    {
      id: 'S5',
      code: 'S5',
      title: '人类拍板',
      sub: '唯一裁决闸门',
      badge: pendingVerdictCount > 0
        ? (pendingVerdictCount + ' 待拍板')
        : (decidedIdeas.length > 0 ? (decidedIdeas.length + ' 已裁决') : '待呈交'),
      status: pendingVerdictCount > 0 ? 'pending' : (decidedIdeas.length > 0 ? 'done' : 'empty'),
    },
    {
      id: 'S6',
      code: 'S6',
      title: '契约冻结',
      sub: 'CHANGELOG 锁死',
      badge: contracts.some((c) => c.frozen) ? (contracts.filter((c) => c.frozen).length + ' 已冻结') : '待立项',
      status: contracts.some((c) => c.frozen) ? 'done' : (contracts.length > 0 ? 'ready' : 'empty'),
    },
  ];

  const validStages = ['S0', 'S1', 'S2', 'S3', 'S4', 'S4.5', 'S5', 'S6'];
  let focusStage = validStages.includes(opts.focusStage) ? opts.focusStage : '';
  if (!focusStage) {
    if (activeRun && validStages.includes(activeRun.stage)) focusStage = activeRun.stage;
    else if (ideas.length > 0 || lineup.configured) focusStage = 'S4';
    else if (papers.length > 0) focusStage = 'S0';
    else focusStage = 'S4';
  }

  let focusIdea = null;
  if (opts.focusIdeaId) {
    focusIdea = ideas.find((i) => i.ideaId === opts.focusIdeaId) || null;
  }
  if (!focusIdea && activeRun && activeRun.targetId) {
    focusIdea = ideas.find((i) => i.ideaId === activeRun.targetId) || null;
  }
  if (!focusIdea) focusIdea = topIdea;

  const graph = buildTopologyGraph({
    focusStage,
    focusIdea,
    ideas,
    papers,
    hasPool,
    poolSha12,
    poolPreview: truncPreview(poolRaw, 2600),
    baselines,
    rawPools,
    deadEndsCount,
    deadEndsPreview: truncPreview(deadEndsRaw, 2200),
    contracts,
    lineup,
    activeRun,
    topicInfo: {
      ...chosenTopic,
      rootAbs: root,
      summaryPreview: truncPreview(summaryRaw, 3200),
    },
  });

  return {
    ok: true,
    repoRoot: root,
    repoName,
    initialized: Boolean(markers.hasSeats || markers.isResearch),
    hasSeats: markers.hasSeats,
    lineup,
    topics: topics.map(({ id, label, archived, briefCount, rawCount }) => ({ id, label, archived, briefCount, rawCount })),
    activeTopic: chosenTopic.id,
    activeTopicArchived: chosenTopic.archived,
    baselines: baselines.map(({ name, rel, signed, metricSummary }) => ({ name, rel, signed, metricSummary })),
    contracts: contracts.map(({ id, rel, valid, frozen, sha12, registeredSha, shaMatch }) => ({
      id,
      rel,
      valid,
      frozen,
      sha12,
      registeredSha,
      shaMatch,
    })),
    stages,
    ideas: ideas.map((it) => ({
      ideaId: it.ideaId,
      isCalibration: it.isCalibration,
      rank: it.rank,
      title: it.title,
      sha: it.sha,
      meanScore25: it.meanScore25,
      voteCount: validVoteCountOf(it),
      rawCardCount: it.cards.length,
      voteCounts: it.voteCounts,
      verdict: it.verdict,
      verdictStale: Boolean(it.verdictStale),
      hasNovelty: Boolean(it.novelty),
      noveltyRisk: it.novelty ? it.novelty.risk : '',
      locked: it.locked,
    })),
    activeRun: activeRun ? {
      runId: activeRun.runId,
      stage: activeRun.stage,
      topic: activeRun.topic,
      targetId: activeRun.targetId,
      title: activeRun.title,
      startedAt: activeRun.startedAt,
      workers: activeRun.workers,
    } : null,
    recentRuns: ledger.runs.slice(0, 8).map((r) => ({
      runId: r.runId,
      stage: r.stage,
      topic: r.topic,
      targetId: r.targetId,
      title: r.title,
      status: r.status,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      note: r.note,
      workerCount: Array.isArray(r.workers) ? r.workers.length : 0,
    })),
    pendingVerdictCount,
    activeWorkerCount,
    graph,
    updatedAt: Date.now(),
  };
}

export function writeHumanVerdict(repoRoot, {
  topic = 'default',
  ideaId = '',
  decision = '',
  note = '',
  appendDeadEnd = false,
  deadEndSummary = '',
  expectedBriefSha = '',
  requireBriefSha = false,
} = {}) {
  const root = path.resolve(String(repoRoot || '.'));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, error: '项目目录不存在：' + root };
  }
  const dec = String(decision || '').trim().toLowerCase();
  if (!['go', 'revise', 'kill'].includes(dec)) {
    return { ok: false, error: '裁决决定必须是 go、revise 或 kill' };
  }
  const cleanIdea = String(ideaId || '').trim();
  if (!cleanIdea || !/^[A-Za-z0-9_-]+$/.test(cleanIdea)) {
    return { ok: false, error: '非法的工单编号：' + ideaId };
  }
  const cleanTopic = String(topic || 'default').trim();
  if (cleanTopic.startsWith('archive/')) {
    return { ok: false, error: '历史归档轮次仅供只读查阅，请切换至当前活跃课题后再签写裁决' };
  }
  if (cleanTopic !== 'default' && cleanTopic !== '_flat' && cleanTopic !== '' && (!/^[A-Za-z0-9._-]+$/.test(cleanTopic) || cleanTopic === '.' || cleanTopic === '..')) {
    return { ok: false, error: '非法的课题名称：' + cleanTopic };
  }

  const dirRel = resolveTopicDirRel(root, cleanTopic, cleanIdea);
  const briefRel = dirRel + '/briefs/' + cleanIdea + '.md';
  const briefAbs = path.join(root, briefRel);
  const briefRead = readFileInsideRoot(root, briefAbs);
  if (!briefRead.ok) {
    return {
      ok: false,
      statusCode: 404,
      code: 'BRIEF_NOT_FOUND',
      error: '目标工单不存在或路径越界（' + briefRel + '），拒绝写入孤立裁决',
    };
  }
  const currentBriefSha = sha12Text(briefRead.text);
  const currentRawSha = sha12Buf(briefRead.buf);
  const cleanExpectedSha = String(expectedBriefSha || '').trim().toLowerCase();
  if (requireBriefSha && !cleanExpectedSha) {
    return {
      ok: false,
      statusCode: 400,
      code: 'BRIEF_SHA_REQUIRED',
      currentBriefSha,
      error: '缺少工单指纹 expectedBriefSha，请刷新页面核对当前工单版本后再提交裁决',
    };
  }
  if (cleanExpectedSha && cleanExpectedSha !== currentBriefSha && cleanExpectedSha !== currentRawSha) {
    return {
      ok: false,
      statusCode: 409,
      code: 'BRIEF_CHANGED',
      currentBriefSha,
      error: '目标工单 ' + cleanIdea + ' 在你审阅期间已被修订（期望指纹 ' + cleanExpectedSha + '，当前 ' + currentBriefSha + '），已中止落盘并保留你的草稿，请刷新核对新版工单后再提交',
    };
  }

  const verdictRel = dirRel + '/verdict-' + cleanIdea + '.md';
  const verdictAbs = path.join(root, verdictRel);
  if (!isInsideRoot(root, verdictAbs)) {
    return { ok: false, error: '裁决路径越界' };
  }

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const humanNote = String(note || '').replace(/\r\n?/g, '\n').trim()
    || (dec === 'go'
      ? '盲审五维表现与可行性核验通过，批准进入 S6 研究契约冻结环节。'
      : dec === 'revise'
        ? '核心机制有潜力但实验判据或基线衔接存在短板，退回修订后加 --force 重新拆单。'
        : '增益预期或可行性不成立，予以否决并沉淀负知识。');
  // 备注逐行以 Markdown 引用前缀落盘，原文一字不丢，同时彻底阻断备注内 `## 终裁` / `决定:` / `brief_sha:` 劫持正式裁决
  const quotedNote = humanNote
    .split('\n')
    .map((line) => (line.length > 0 ? '> ' + line : '>'))
    .join('\n');

  const body = [
    '# 人类裁决单：' + cleanIdea,
    '',
    '决定: ' + dec,
    '时间: ' + nowIso,
    '课题: ' + (cleanTopic || 'default'),
    'brief_sha: ' + currentBriefSha,
    '',
    '## 人类拍板意见',
    '',
    quotedNote,
    '',
  ].join('\n');

  try {
    writeAtomicLf(verdictAbs, body);
  } catch (e) {
    return {
      ok: false,
      statusCode: 500,
      code: 'WRITE_FAILED',
      error: '裁决文件落盘失败：' + String((e && e.message) || e),
    };
  }

  let appendedDeadEnd = false;
  let deadEndError = '';
  if (dec === 'kill' && appendDeadEnd) {
    const summaryLine = String(deadEndSummary || note || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
    if (summaryLine) {
      const deadRel = dirRel + '/dead-ends.md';
      const deadAbs = path.join(root, deadRel);
      if (isInsideRoot(root, deadAbs)) {
        try {
          withExclusiveFileLock(deadAbs + '.lock', () => {
            if (!isInsideRoot(root, deadAbs)) {
              throw new Error('dead-ends.md 路径越界');
            }
            let existing = '# 禁入死胡同清单（dead-ends）\n\n';
            if (fs.existsSync(deadAbs)) {
              // 严格读取原文件，读取失败直接抛错，严禁回退为空串覆盖历史记录
              const rawExisting = fs.readFileSync(deadAbs, 'utf8');
              existing = rawExisting.replace(/\r\n/g, '\n').replace(/\s*$/, '\n');
            }
            const dateTag = nowIso.slice(0, 10);
            const bullet = '- [' + dateTag + ' · ' + cleanIdea + '] ' + summaryLine + '\n';
            writeAtomicLf(deadAbs, existing + bullet);
          }, { purpose: 'dead-ends', timeoutMs: 2500, staleMs: 30000 });
          appendedDeadEnd = true;
        } catch (e) {
          deadEndError = 'dead-ends.md 追加失败：' + String((e && e.message) || e);
        }
      } else {
        deadEndError = 'dead-ends.md 路径越界，已跳过沉淀';
      }
    }
  }

  return {
    ok: true,
    verdictRel,
    decision: dec,
    briefSha: currentBriefSha,
    appendedDeadEnd,
    ...(deadEndError ? { deadEndError } : {}),
  };
}

export function triggerDispatchAction(repoRoot, {
  seatsFile = 'dispatch/seats.json',
  kind = '',
  topic = 'default',
  ideaId = '',
} = {}) {
  const root = path.resolve(String(repoRoot || '.'));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, error: '项目目录不存在：' + root };
  }
  const cleanTopic = String(topic || '').trim();
  if (cleanTopic.startsWith('archive/')) {
    return { ok: false, error: '历史归档轮次不支持重新派工，请切换至活跃课题' };
  }
  if (
    cleanTopic !== ''
    && cleanTopic !== 'default'
    && cleanTopic !== '_flat'
    && (!/^[A-Za-z0-9._-]+$/.test(cleanTopic) || cleanTopic === '.' || cleanTopic === '..')
  ) {
    return { ok: false, statusCode: 400, error: '非法的课题名称：' + cleanTopic };
  }

  if (kind === 'init') {
    const topicOpt = cleanTopic && cleanTopic !== 'default' && cleanTopic !== '_flat' ? cleanTopic : null;
    try {
      const res = initProject(root, { force: false, topic: topicOpt });
      return {
        ok: Boolean(res && res.ok !== false),
        mode: 'sync',
        message: '科研工作流目录骨架已就绪',
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  if (kind === 'pool') {
    const res = assemblePaperPool(root, {});
    if (!res || res.rc !== 0) {
      return { ok: false, error: String((res && (res.stderr || res.stdout)) || '汇总文献池失败').trim() };
    }
    return {
      ok: true,
      mode: 'sync',
      message: String(res.stdout || '已重新拼装 papers/cards/_pool.md').replace(/^==\s*/, '').trim(),
    };
  }

  if (kind === 'summary') {
    const dirRel = resolveTopicDirRel(root, cleanTopic);
    const res = summarizeTopic(root, {
      briefsDir: dirRel + '/briefs',
      cardsDir: dirRel + '/cards',
      ideasDir: dirRel,
      outPath: dirRel + '/_summary.md',
      writeFile: true,
    });
    if (!res || !res.ok) {
      return { ok: false, error: String((res && res.stderr) || '汇总榜单失败').trim() };
    }
    return {
      ok: true,
      mode: 'sync',
      message: '已按五维总分重新生成降序排行榜 _summary.md',
    };
  }

  if (kind === 'run-brief' || kind === 'run-novelty') {
    const cleanIdea = String(ideaId || '').trim();
    if (!cleanIdea || !/^[A-Za-z0-9_-]+$/.test(cleanIdea)) {
      return { ok: false, error: '请先选择有效的目标工单 idea_XX' };
    }
    const topicKey = cleanTopic || 'default';
    const stageKey = kind === 'run-brief' ? 'S4' : 'S4.5';
    const dirRel = resolveTopicDirRel(root, topicKey, cleanIdea);
    const briefRel = dirRel + '/briefs/' + cleanIdea + '.md';
    const briefAbs = path.join(root, briefRel);
    if (!isInsideRoot(root, briefAbs) || !fs.existsSync(briefAbs)) {
      return { ok: false, error: '找不到目标工单文件：' + briefRel };
    }

    const cliTopicArg = dirRel.startsWith('ideas/') ? dirRel.slice('ideas/'.length) : '';
    const args = kind === 'run-brief'
      ? [DISPATCH_BIN, 'run', briefRel]
      : [DISPATCH_BIN, 'novelty', cleanIdea, ...(cliTopicArg ? ['--topic', cliTopicArg] : [])];

    const telemetryFile = path.join(root, TELEMETRY_REL);
    const lockFile = telemetryFile + '.lock';
    if (!isInsideRoot(root, telemetryFile)) {
      return { ok: false, error: '遥测账本路径越界' };
    }
    try {
      return withFileLock(lockFile, () => {
        const ledger = readTelemetryLedger(root, { persistStale: false });
        const conflict = ledger.runs.find((r) => (
          r && r.status === 'working'
          && String(r.topic || 'default') === topicKey
          && String(r.stage || '') === stageKey
          && r.targetId === cleanIdea
        ));
        if (conflict) {
          return {
            ok: false,
            statusCode: 409,
            error: '课题 ' + topicKey + ' 的工单 ' + cleanIdea + ' 当前已有同阶段任务正在运行中，请等待本轮完成',
          };
        }

        // 先落盘占位记录（写入失败则中止且不拉起子进程），成功后再 spawn 并回写 pid
        const now = Date.now();
        const launchRunId = 'launch-' + stageKey.replace(/[^A-Za-z0-9]/g, '') + '-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        const placeholder = {
          runId: launchRunId,
          stage: stageKey,
          topic: topicKey,
          targetId: cleanIdea,
          title: kind === 'run-brief' ? ('S4 多票盲审 · ' + cleanIdea) : ('S4.5 前置查重 · ' + cleanIdea),
          pid: process.pid,
          status: 'working',
          startedAt: now,
          finishedAt: null,
          durationMs: null,
          rc: null,
          outputRel: '',
          note: '后台调度进程启动中',
          inputs: [],
          workers: [],
        };
        const reservedRuns = [placeholder, ...ledger.runs].slice(0, MAX_RUNS);
        writeAtomicLf(telemetryFile, JSON.stringify({ version: 1, runs: reservedRuns }, null, 2) + '\n');

        const rollbackPlaceholder = () => {
          try {
            writeAtomicLf(telemetryFile, JSON.stringify({ version: 1, runs: ledger.runs }, null, 2) + '\n');
            return '';
          } catch (rbErr) {
            return '（占位回滚失败：' + String((rbErr && rbErr.message) || rbErr) + '）';
          }
        };

        let child = null;
        try {
          child = spawn(process.execPath, args, {
            cwd: root,
            env: {
              ...process.env,
              DSH_DISPATCH_ROOT: root,
              DSH_DISPATCH_LAUNCH_ID: launchRunId,
              ...(seatsFile && seatsFile !== 'dispatch/seats.json' ? { DSH_DISPATCH_CONFIG: seatsFile } : {}),
            },
            stdio: 'ignore',
            windowsHide: true,
            detached: process.platform !== 'win32',
          });
        } catch (spawnErr) {
          const rbNote = rollbackPlaceholder();
          return { ok: false, error: '后台进程启动失败：' + String((spawnErr && spawnErr.message) || spawnErr) + rbNote };
        }
        // 立即挂载异步 error 监听器，防止 spawn 返回无 PID 句柄后异步抛出未捕获 error 崩溃宿主
        if (child && typeof child.on === 'function') {
          child.on('error', (spawnAsyncErr) => {
            try {
              mutateTelemetryLedger(root, (lg) => {
                lg.runs = (lg.runs || []).filter((r) => r && r.runId !== launchRunId);
              });
            } catch (cleanErr) {
              console.error(
                '[research-dispatch] 后台进程异步错误后清理遥测占位失败:',
                String((spawnAsyncErr && spawnAsyncErr.message) || spawnAsyncErr),
                '→',
                String((cleanErr && cleanErr.message) || cleanErr),
              );
            }
          });
        }
        if (!child || !child.pid) {
          const rbNote = rollbackPlaceholder();
          return { ok: false, error: '后台进程未能成功启动' + rbNote };
        }
        if (typeof child.unref === 'function') child.unref();

        placeholder.pid = child.pid;
        try {
          writeAtomicLf(telemetryFile, JSON.stringify({ version: 1, runs: reservedRuns }, null, 2) + '\n');
        } catch (pidErr) {
          // 回写子进程 PID 失败时尝试撤销占位避免留下宿主 PID 假运行态，并透出明确告警
          const rbNote = rollbackPlaceholder();
          return {
            ok: true,
            mode: 'async',
            pid: child.pid,
            warning: '子进程已启动但回写占位 PID 失败：' + String((pidErr && pidErr.message) || pidErr) + rbNote,
            message: kind === 'run-brief'
              ? ('已启动工单 ' + cleanIdea + ' 的沙箱多票盲审（等待子进程接管遥测）')
              : ('已启动工单 ' + cleanIdea + ' 的单单隔离前置查重（等待子进程接管遥测）'),
          };
        }

        return {
          ok: true,
          mode: 'async',
          pid: child.pid,
          message: kind === 'run-brief'
            ? ('已启动工单 ' + cleanIdea + ' 的沙箱多票盲审，拓扑图将实时追踪进度')
            : ('已启动工单 ' + cleanIdea + ' 的单单隔离前置查重'),
        };
      });
    } catch (e) {
      return { ok: false, error: '后台进程启动失败：' + String((e && e.message) || e) };
    }
  }

  return { ok: false, error: '不支持的操作类型：' + kind };
}
