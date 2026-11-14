// 实时遥测账本、DSH 工作区智能发现、S0→S6 全链路盘面与 /swarm 拓扑星图聚合器（v2.2.1，纯 Node 零依赖）。
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
  parseYamlCardMapping,
  summarizeTopic,
} from './validators.mjs';
import {
  assemblePaperPool,
  checkContractFile,
  initProject,
} from './workflow.mjs';
import {
  findSeat,
  loadConfig,
  resolveDivergePlan,
  resolveExecutionPlan,
  resolveStagePlan,
  seatIdentity,
} from './registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const DISPATCH_BIN = path.join(PACKAGE_ROOT, 'bin', 'dispatch.mjs');

export const TELEMETRY_REL = '.research-dispatch/telemetry.json';
const MAX_RUNS = 36;
const WORKER_STALE_MS = 2 * 60 * 60 * 1000;
const DIMS = ['novelty', 'feasibility', 'baseline_fit', 'impl_cost', 'expected_gain'];
const RESERVED_IDEAS_DIRS = new Set(['briefs', 'cards', 'archive', 'stale', 'rejected', '.superseded']);

function sha12Text(text) {
  return crypto.createHash('sha256').update(String(text || '').replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 12);
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
      fs.unlinkSync(tmp);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
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

export function readTelemetryLedger(repoRoot) {
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

  if (dirty) {
    try {
      writeAtomicLf(file, JSON.stringify({ version: 1, runs: runs.slice(0, MAX_RUNS) }, null, 2) + '\n');
    } catch { /* 只读场景忽略回写异常 */ }
  }
  return { version: 1, runs };
}

function writeTelemetryRuns(repoRoot, runs) {
  try {
    const root = path.resolve(String(repoRoot || '.'));
    const file = path.join(root, TELEMETRY_REL);
    if (!isInsideRoot(root, file)) return;
    writeAtomicLf(file, JSON.stringify({ version: 1, runs: runs.slice(0, MAX_RUNS) }, null, 2) + '\n');
  } catch { /* 遥测异常绝不打断主流程 */ }
}

export function startRunTelemetry(repoRoot, info = {}) {
  try {
    const root = path.resolve(String(repoRoot || '.'));
    const ledger = readTelemetryLedger(root);
    const now = Date.now();
    const stage = String(info.stage || 'S4');
    const runId = String(info.runId || (stage.replace(/[^A-Za-z0-9]/g, '') + '-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6)));
    const entry = {
      runId,
      stage,
      topic: String(info.topic || 'default'),
      targetId: String(info.targetId || ''),
      title: String(info.title || stage),
      pid: process.pid,
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
    const nextRuns = [entry, ...ledger.runs.filter((r) => r && r.runId !== runId)].slice(0, MAX_RUNS);
    writeTelemetryRuns(root, nextRuns);
    return runId;
  } catch {
    return '';
  }
}

export function updateWorkerTelemetry(repoRoot, runId, slotTag, patch = {}) {
  if (!runId || !slotTag) return;
  try {
    const root = path.resolve(String(repoRoot || '.'));
    const ledger = readTelemetryLedger(root);
    const run = ledger.runs.find((r) => r && r.runId === runId);
    if (!run) return;
    run.workers = Array.isArray(run.workers) ? run.workers : [];
    let worker = run.workers.find((w) => w && w.tag === slotTag);
    if (!worker) {
      worker = {
        tag: String(slotTag),
        seat: String(patch.seat || slotTag.replace(/[0-9]+$/, '') || slotTag),
        model: String(patch.model || ''),
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
    writeTelemetryRuns(root, ledger.runs);
  } catch { /* ignore */ }
}

export function finishRunTelemetry(repoRoot, runId, patch = {}) {
  if (!runId) return;
  try {
    const root = path.resolve(String(repoRoot || '.'));
    const ledger = readTelemetryLedger(root);
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
    writeTelemetryRuns(root, ledger.runs);
  } catch { /* ignore */ }
}

export function readProjectLineupSummary(repoRoot, seatsFile = 'dispatch/seats.json') {
  const fallback = {
    configured: false,
    scout: { seat: 'codex', model: '', resolvedModel: '' },
    diverge: { seat: 'codex', model: '', resolvedModel: '', count: 10, useDeadEnds: true },
    review: [{ tag: 'codex', seat: 'codex', model: '', resolvedModel: '' }],
    novelty: { seat: 'codex', model: '', resolvedModel: '' },
  };
  if (!repoRoot) return fallback;
  let cfg = null;
  try {
    cfg = loadConfig(repoRoot, seatsFile || 'dispatch/seats.json', { useDshPatch: false });
  } catch {
    return fallback;
  }
  const resolveSeatMdl = (seatId, explicitModel) => {
    if (explicitModel) return explicitModel;
    const seatObj = findSeat(cfg, seatId);
    if (!seatObj) return '';
    return cleanModelName(seatIdentity(seatObj, { seat: seatId, payloadSha: '', voteModel: '', useDshPatch: false }));
  };

  const sc = resolveStagePlan(cfg, 'scout', { useDshPatch: false });
  const dv = resolveDivergePlan(cfg, { useDshPatch: false });
  const rv = resolveExecutionPlan(cfg, { useDshPatch: false });
  const nv = resolveStagePlan(cfg, 'novelty', { useDshPatch: false });

  const scoutSeat = sc.ok ? sc.seatId : 'codex';
  const scoutModel = sc.ok ? (sc.model || '') : '';
  const divSeat = dv.ok ? dv.seatId : 'codex';
  const divModel = dv.ok ? (dv.model || '') : '';
  const novSeat = nv.ok ? nv.seatId : 'codex';
  const novModel = nv.ok ? (nv.model || '') : '';
  const reviewSlots = (rv.ok && Array.isArray(rv.slots) && rv.slots.length > 0)
    ? rv.slots.map((s) => ({
      tag: s.tag || s.seat,
      seat: s.seat,
      model: s.model || '',
      resolvedModel: resolveSeatMdl(s.seat, s.model || ''),
    }))
    : fallback.review;

  return {
    configured: true,
    scout: {
      seat: scoutSeat,
      model: scoutModel,
      resolvedModel: resolveSeatMdl(scoutSeat, scoutModel),
    },
    diverge: {
      seat: divSeat,
      model: divModel,
      resolvedModel: resolveSeatMdl(divSeat, divModel),
      count: dv.defaultCount || 10,
      useDeadEnds: dv.defaultUseDeadEnds !== false,
    },
    review: reviewSlots,
    novelty: {
      seat: novSeat,
      model: novModel,
      resolvedModel: resolveSeatMdl(novSeat, novModel),
    },
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

function parseReviewCardDetails(cardPath, ideaId) {
  const raw = readUtf8Safe(cardPath);
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
        const scaled25 = count === DIMS.length ? sum : (sum / count) * DIMS.length;
        score25 = Math.round(scaled25 * 10) / 10;
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

function parseBriefSummary(briefPath, ideaId) {
  const raw = readUtf8Safe(briefPath);
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

function parseVerdictDecision(verdictPath) {
  if (!fs.existsSync(verdictPath)) {
    return { exists: false, decision: 'pending', preview: '' };
  }
  const raw = readUtf8Safe(verdictPath);
  const m = raw.match(/^[ \t>*#-]*决定[ \t]*[:：][ \t]*(go|revise|kill)\b/im)
    || raw.match(/^[ \t]*verdict[ \t]*[:：][ \t]*(go|revise|kill)\b/im);
  return {
    exists: true,
    decision: m ? m[1].toLowerCase() : 'pending',
    preview: truncPreview(raw),
  };
}

function parseNoveltySummary(novPath) {
  if (!novPath || !fs.existsSync(novPath)) return null;
  const raw = readUtf8Safe(novPath);
  const meta = parseMetaAttrs(raw.split(/\r?\n/, 1)[0] || '');
  let risk = '';
  let confidence = '';
  let closestCount = 0;
  let note = '';
  try {
    const loc = locateCardYaml(raw);
    if (loc && loc.found && loc.yamlText) {
      const obj = parseYamlCardMapping(loc.yamlText);
      if (obj && typeof obj === 'object') {
        risk = String(obj.duplication_risk || '').trim().toLowerCase();
        confidence = obj.confidence !== undefined && obj.confidence !== null ? String(obj.confidence).trim() : '';
        if (Array.isArray(obj.closest_works)) closestCount = obj.closest_works.length;
        note = String(obj.recommendation || obj.differentiation || obj.note || '').replace(/\s+/g, ' ').trim();
      }
    }
  } catch { /* ignore */ }
  return {
    risk: risk || 'done',
    confidence,
    closestCount,
    seat: meta.seat || '',
    model: cleanModelName(meta.model || ''),
    sha: meta.sha || '',
    note: note.slice(0, 140),
    preview: truncPreview(raw),
  };
}

function discoverTopics(root) {
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
      if (!ent.isDirectory() || ent.name.startsWith('.') || RESERVED_IDEAS_DIRS.has(ent.name)) continue;
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

  // 2) Flat root ideas/briefs or ideas/raw-*.md
  const rootStats = countTopicStats(ideasDir);
  if (rootStats.briefCount > 0 || rootStats.rawCount > 0 || topics.length === 0) {
    topics.push({
      id: 'default',
      label: '默认主课题',
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
    const workerNode = addNode({
      id: 's0-worker',
      col: 2,
      x: 590,
      y: papers.length > 0 ? 150 : 255,
      kind: 'worker',
      seat: (scoutRun && scoutRun.workers[0] && scoutRun.workers[0].seat) || lineup.scout.seat,
      model: (scoutRun && scoutRun.workers[0] && scoutRun.workers[0].model) || lineup.scout.resolvedModel || '默认模型',
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
      title: '👤 人类签字验收锚点',
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
            ['验收状态', b.signed ? '✓ 已通过 checkAnchor（SIGNOFF: PASS）' : '⚠ 未完成签字或缺少数值'],
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

    const wNode = addNode({
      id: 's2-worker',
      col: 2,
      x: 590,
      y: rawPools.length > 0 ? 155 : 255,
      kind: 'worker',
      seat: lineup.diverge.seat,
      model: lineup.diverge.resolvedModel || '默认模型',
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
      title: target ? ('唯一工单 ' + target.ideaId) : '入围优胜工单',
      subtitle: target ? target.title.slice(0, 26) : '票面占优候选',
      badge: target ? ('sha ' + target.sha.slice(0, 8)) : 'S4 → S4.5',
      status: target ? 'done' : 'ready',
      sha: target ? target.sha : '',
      inspect: {
        title: target ? ('待查重唯一工单：' + target.ideaId) : '待选定入围工单',
        kindLabel: '单单推式隔离输入',
        fileRel: target ? target.briefRel : '',
        sha: target ? target.sha : '',
        metaRows: [['隔离约束', '查重 Worker 仅可见该唯一工单与 _pool.md，严禁横向混入其它候选']],
        preview: target ? target.preview : '先完成 S3 拆单与 S4 盲审，对排名前列的候选启动前置查重。',
      },
    });
    const inPool = addNode({
      id: 's45-pool',
      col: 0,
      x: 118,
      y: 345,
      kind: 'input',
      title: '本地文献池对照',
      subtitle: papers.length + ' 篇已入库卡片',
      badge: 'papers/cards/_pool.md',
      status: hasPool ? 'done' : 'ready',
      inspect: {
        title: '本地文献池对照（_pool.md）',
        kindLabel: '推式输入源',
        fileRel: 'papers/cards/_pool.md',
        sha: poolSha12,
        metaRows: [['文献卡数量', papers.length + ' 篇']],
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

    const wNov = addNode({
      id: 's45-worker-nov',
      col: 2,
      x: 590,
      y: 175,
      kind: 'worker',
      seat: (nov && nov.seat) || lineup.novelty.seat,
      model: (nov && nov.model) || lineup.novelty.resolvedModel || '默认模型',
      sandbox: 'os.tmpdir()',
      title: ((nov && nov.seat) || lineup.novelty.seat) + ' · 查重员',
      subtitle: nov ? ('撞车风险: ' + nov.risk.toUpperCase()) : (lineup.novelty.resolvedModel || '定向查新 Worker'),
      badge: novRun ? '核查中' : (nov ? ('risk: ' + nov.risk) : '待派工'),
      status: novRun ? 'working' : (nov ? 'done' : 'ready'),
      startedAt: novRun ? novRun.startedAt : null,
      inspect: {
        title: target ? ('查重报告：papers/novelty/' + target.ideaId + '.md') : '前置查重 Worker',
        kindLabel: '独立沙箱查重卡',
        fileRel: target ? ('papers/novelty/' + target.ideaId + '.md') : 'papers/novelty',
        sha: nov ? nov.sha : '',
        metaRows: [
          ['撞车风险等级', nov ? nov.risk : '尚未运行'],
          ['近邻文献数', nov ? (nov.closestCount + ' 篇') : '—'],
          ['执行模型', (nov && nov.model) || lineup.novelty.resolvedModel || '默认'],
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
      title: '👤 S5 人类终裁台',
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
        preview: readUtf8Safe(path.join(topicInfo.rootAbs, 'contract', 'CHANGELOG.md')) || '尚未冻结任何正式实验契约。',
      },
    });

    const cList = contracts.length > 0 ? contracts.slice(0, 4) : [{ id: 'TEMPLATE', rel: 'contract/TEMPLATE.md', valid: false, frozen: false, sha12: '', preview: readUtf8Safe(path.join(topicInfo.rootAbs, 'contract', 'TEMPLATE.md')) }];
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
            ['结构门禁 checkContractFile', c.valid ? '✓ 通过' : '待补齐数值信号或消融表'],
            ['CHANGELOG 冻结对账', c.frozen ? ('✓ 已锁死 (' + c.sha12 + ')') : '未登记'],
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
      preview: truncPreview(readUtf8Safe(path.join(topicInfo.rootAbs, 'roles', 'reviewer.md')) || '独立五维打分角色契约（单票单卡，禁止模型互审）。'),
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
    title: target ? ('唯一目标工单 ' + target.ideaId) : '待拆单生成 idea_XX',
    subtitle: target ? target.title.slice(0, 26) : '一次只喂唯一一个 Idea',
    badge: target ? ('sha ' + target.sha.slice(0, 8)) : '物理隔离',
    status: target ? 'done' : 'pending',
    sha: target ? target.sha : '',
    inspect: {
      title: target ? ('推式输入 ③：唯一隔离工单 ' + target.ideaId + ' — ' + target.title) : '尚无候选工单',
      kindLabel: '单方案物理隔离工单',
      fileRel: target ? target.briefRel : (topicInfo.dirRel + '/briefs'),
      sha: target ? target.sha : '',
      pushedInputs: target ? [
        'roles/reviewer.md（五维盲审标尺）',
        target.briefRel + '（sha=' + target.sha + '，含内嵌 ### Baseline）',
        '🚫 已物理屏蔽：AGENTS.md / lessons.md / 其它候选 idea_* / 其它评审员选票',
      ] : [],
      metaRows: target ? [
        ['工单指纹 sha12', target.sha],
        ['候选池溯源 isha', target.isha || '—'],
        ['基线指纹 bsha', target.bsha || '—'],
        ['当前排行榜位次', target.rank ? ('#' + target.rank + '（均分 ' + target.meanScore25 + '/25）') : '待汇总'],
      ] : [],
      actions: target && !topicInfo.archived ? ['run-brief', 'run-novelty'] : [],
      ideaId: target ? target.ideaId : '',
      preview: target ? target.preview : '当前课题下暂无拆单工单；可切换课题（如查看历史归档）或先运行 diverge + briefs。',
    },
  });

  const hubStatus = revRun ? 'working' : (target && target.cards.length > 0 ? 'done' : 'ready');
  const hub = addNode({
    id: 's4-hub',
    col: 1,
    x: 342,
    y: 255,
    kind: 'hub',
    title: '主控盲审扇出器',
    subtitle: revRun ? '正在并行/序列派发沙箱票' : '推式装填 · 仓外沙箱隔离',
    badge: target ? (target.cards.length + ' 票落盘') : (lineup.review.length + ' 席就绪'),
    status: hubStatus,
    inspect: {
      title: '主控盲审调度中心（Coordinator）',
      kindLabel: '推式隔离派工器',
      fileRel: target ? target.manifestRel : 'dispatch/seats.json',
      sha: target ? target.sha : '',
      pushedInputs: [
        '仅向每个子进程显式注入：roles/reviewer.md + 当前唯一目标 brief',
        '子进程 cwd 强制置于系统 os.tmpdir()/rd-worker-* 空沙箱（脱离 .git 树）',
        '严禁多模型互相辩论收敛，每张卡独立过 checkCardFile 门禁后汇总',
      ],
      metaRows: [
        ['当前焦点工单', target ? (target.ideaId + '（' + target.title.slice(0, 28) + '）') : '无'],
        ['manifest 状态', (target && target.manifestStatus) || '待运行'],
        ['编排票位数', String(lineup.review.length)],
      ],
      actions: target && !topicInfo.archived ? ['run-brief', 'summary'] : [],
      ideaId: target ? target.ideaId : '',
      preview: (target && target.manifestPreview) || '点击「启动多票盲审」即可按当前编排阵容对该工单发起独立盲审，实时进度将在此拓扑图中动态点亮。',
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
      return {
        tag: w.tag,
        seat: w.seat,
        model: (card && card.model) || cleanModelName(w.model) || w.seat,
        sandbox: w.sandbox || 'os.tmpdir()',
        status: w.status === 'done' || card ? 'done' : w.status,
        startedAt: w.startedAt,
        durationMs: w.durationMs,
        score25: card ? card.score25 : w.score25,
        dims: card ? card.dims : null,
        dimReasons: card ? card.dimReasons : null,
        verdict: (card && card.verdict) || w.verdict || '',
        confidence: card ? card.confidence : '',
        note: (card && card.note) || w.error || '',
        fileRel: card ? card.rel : w.outputRel,
        sha: card ? card.sha : (target ? target.sha : ''),
        preview: card ? card.preview : ('Worker 状态：' + w.status + (w.error ? '\n错误：' + w.error : '')),
      };
    });
  } else if (target && target.cards.length > 0) {
    workerItems = target.cards.map((c) => ({
      tag: c.tag,
      seat: c.seat,
      model: c.model,
      sandbox: 'os.tmpdir()',
      status: 'done',
      startedAt: null,
      durationMs: null,
      score25: c.score25,
      dims: c.dims,
      dimReasons: c.dimReasons || null,
      verdict: c.verdict,
      confidence: c.confidence,
      note: c.note,
      fileRel: c.rel,
      sha: c.sha,
      preview: c.preview,
    }));
  } else {
    workerItems = lineup.review.map((sl) => ({
      tag: sl.tag,
      seat: sl.seat,
      model: sl.resolvedModel || sl.model || '默认模型',
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

  const summaryNode = addNode({
    id: 's4-summary',
    col: 3,
    x: 848,
    y: 172,
    kind: 'artifact',
    title: '五维降序榜 _summary.md',
    subtitle: target && target.meanScore25 !== null
      ? ('#' + target.rank + ' · 均分 ' + target.meanScore25 + ' / 25')
      : (ideas.some((i) => i.meanScore25 !== null) ? '已按 /25 总分降序排列' : '待盲审出票后汇总'),
    badge: target && target.meanScore25 !== null ? (target.meanScore25 + '/25') : 'RANKING',
    status: target && target.cards.length > 0 ? 'done' : 'ready',
    inspect: {
      title: '跨工单五维 Ranking 总表（_summary.md）',
      kindLabel: 'S4 汇总榜单',
      fileRel: topicInfo.dirRel + '/_summary.md',
      metaRows: [
        ['计分规则', '五维统一 1–5 正向计分（impl_cost=5 代表轻量省算力），总分 /25 自动降序'],
        ['当前课题工单数', String(ideas.length)],
      ],
      actions: !topicInfo.archived && ideas.length > 0 ? ['summary'] : [],
      preview: topicInfo.summaryPreview || ideas.map((it, idx) => '#' + (idx + 1) + ' ' + it.ideaId + ' — ' + (it.meanScore25 !== null ? (it.meanScore25 + '/25') : '待评') + ' [' + it.verdict.toUpperCase() + '] ' + it.title).join('\n'),
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
    title: '👤 人类唯一裁决闸门',
    subtitle: target
      ? (target.verdict === 'pending'
        ? (target.ideaId + ' 待你拍板 GO/REVISE/KILL')
        : (target.ideaId + ' 已裁决：' + target.verdict.toUpperCase()))
      : '禁止多模型互审代替人类拍板',
    badge: target ? (target.verdict === 'pending' ? '待裁决' : target.verdict.toUpperCase()) : 'HUMAN GATE',
    status: verdictStatus,
    verdict: target ? target.verdict : 'pending',
    inspect: {
      title: target ? ('人类裁决单：' + target.verdictRel) : '人类唯一裁决权（硬约束 #2）',
      kindLabel: '硬约束 #2 · 人类拍板',
      fileRel: target ? target.verdictRel : topicInfo.dirRel,
      canVerdict: Boolean(target && !topicInfo.archived),
      ideaId: target ? target.ideaId : '',
      currentVerdict: target ? target.verdict : 'pending',
      dims: target ? target.meanDims : null,
      score25: target ? target.meanScore25 : null,
      metaRows: target ? [
        ['目标工单', target.ideaId + ' — ' + target.title],
        ['五维总均分', target.meanScore25 !== null ? (target.meanScore25 + ' / 25（共 ' + target.cards.length + ' 票）') : '暂无有效票'],
        ['票型分布', 'GO ' + target.voteCounts.go + ' · REVISE ' + target.voteCounts.revise + ' · KILL ' + target.voteCounts.kill],
        ['查重状态', target.novelty ? ('已查重（risk=' + target.novelty.risk + '）') : '未跑查重'],
        ['人工裁决', target.verdict === 'pending' ? '⏳ 待人类拍板' : ('✓ ' + target.verdict.toUpperCase())],
      ] : [['铁律', '多模型盲审票只是判断素材，最终 GO / REVISE / KILL 必须由人类亲自拍板']],
      preview: (target && target.verdictPreview) || '在下方人类裁决台点击 GO / REVISE / KILL 即可原子落盘写入 verdict 文件（若选 KILL 可同步追加一行至 dead-ends.md）。',
    },
  });
  addEdge(summaryNode, verdictNode, target && target.cards.length > 0 ? 'done' : 'ready', '呈交裁决');

  const shownWorkers = workerItems.slice(0, 6);
  shownWorkers.forEach((w, idx) => {
    const wid = addNode({
      id: 's4-worker-' + w.tag + '-' + idx,
      col: 2,
      x: 590,
      y: ySpread(shownWorkers.length, idx, 88, 432),
      kind: 'worker',
      seat: w.seat,
      model: w.model,
      sandbox: w.sandbox,
      title: w.tag === w.seat ? (w.seat + ' · 盲审席') : (w.tag + ' · ' + w.seat),
      subtitle: w.model,
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
          '🔒 沙箱目录：' + w.sandbox + '（与其它评审员物理隔离、互不可见）',
        ],
        metaRows: [
          ['席位标签 / 工具', w.tag + ' (' + w.seat + ')'],
          ['实测模型身份', w.model || '—'],
          ['运行状态', w.status],
          ['五维总分', w.score25 !== null ? (w.score25 + ' / 25') : '—'],
          ['单票建议', w.verdict ? (w.verdict.toUpperCase() + (w.confidence ? ' (conf=' + w.confidence + ')' : '')) : '—'],
        ],
        preview: w.preview,
      },
    });
    const edgeInStatus = w.status === 'working' ? 'working' : (w.status === 'done' ? 'done' : (w.status === 'failed' ? 'failed' : 'ready'));
    addEdge(hub, wid, edgeInStatus, idx === 0 ? '隔离沙箱' : '');
    addEdge(wid, summaryNode, w.status === 'done' ? 'done' : (w.status === 'working' ? 'working' : 'ready'));
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
  const activeRun = ledger.runs.find((r) => r && r.status === 'working') || null;
  const activeWorkerCount = activeRun
    ? (activeRun.workers || []).filter((w) => w && w.status === 'working').length || 1
    : 0;

  // 1) S0 Literature Cards & Pool
  const cardsDir = path.join(root, 'papers', 'cards');
  const papers = [];
  if (markers.exists && isInsideRoot(root, cardsDir) && fs.existsSync(cardsDir)) {
    try {
      for (const f of fs.readdirSync(cardsDir).sort()) {
        if (!f.endsWith('.md') || f === '_pool.md' || f.startsWith('.')) continue;
        const abs = path.join(cardsDir, f);
        if (!fs.statSync(abs).isFile()) continue;
        const txt = readUtf8Safe(abs);
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
  const hasPool = markers.exists && isInsideRoot(root, poolAbs) && fs.existsSync(poolAbs);
  const poolRaw = hasPool ? readUtf8Safe(poolAbs) : '';
  const poolSha12 = hasPool ? sha12Text(poolRaw) : '';

  // 2) S1 Baselines
  const baselinesDir = path.join(root, 'baselines');
  const baselines = [];
  if (markers.exists && isInsideRoot(root, baselinesDir) && fs.existsSync(baselinesDir)) {
    try {
      for (const ent of fs.readdirSync(baselinesDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith('.') || /^TEMPLATE/i.test(ent.name)) continue;
        const rel = 'baselines/' + ent.name;
        const abs = path.join(baselinesDir, ent.name);
        const chk = checkAnchor(root, rel);
        const bbRaw = readUtf8Safe(path.join(abs, 'BRIEF_BLOCK.md'));
        const reproRaw = readUtf8Safe(path.join(abs, 'REPRO.md'));
        const metricLine = bbRaw.split(/\r?\n/).find((l) => /[0-9]/.test(l) && !l.startsWith('#') && !l.startsWith('<!--')) || '';
        baselines.push({
          name: ent.name,
          rel,
          signed: Boolean(chk && chk.ok),
          bsha: bbRaw ? sha12Text(bbRaw) : '',
          metricSummary: metricLine.replace(/^[*\-\s|]+/, '').trim().slice(0, 42),
          preview: truncPreview(bbRaw, 2400),
          reproPreview: truncPreview(reproRaw, 2400),
        });
      }
    } catch { /* ignore */ }
  }

  // 3) Topics & Active Topic Selection
  const topics = markers.exists ? discoverTopics(root) : [{ id: 'default', label: '默认课题', archived: false, dirRel: 'ideas', briefCount: 0, rawCount: 0 }];
  let chosenTopic = topics.find((t) => t.id === opts.topic) || null;
  if (!chosenTopic && activeRun && activeRun.topic) {
    chosenTopic = topics.find((t) => t.id === activeRun.topic) || null;
  }
  if (!chosenTopic) {
    chosenTopic = topics.find((t) => !t.archived && (t.briefCount > 0 || t.rawCount > 0))
      || topics.find((t) => t.briefCount > 0 || t.rawCount > 0)
      || topics[0];
  }

  const topicDirAbs = path.join(root, chosenTopic.dirRel);
  const summaryRaw = readUtf8Safe(path.join(topicDirAbs, '_summary.md'));
  const deadEndsAbs = fs.existsSync(path.join(topicDirAbs, 'dead-ends.md'))
    ? path.join(topicDirAbs, 'dead-ends.md')
    : path.join(root, 'ideas', 'dead-ends.md');
  const deadEndsRaw = isInsideRoot(root, deadEndsAbs) ? readUtf8Safe(deadEndsAbs) : '';
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
        if (!fs.statSync(abs).isFile()) continue;
        const raw = readUtf8Safe(abs);
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

  const ideas = [];
  for (const ideaId of [...ideaIdSet]) {
    const briefAbs = path.join(briefsDirAbs, ideaId + '.md');
    const briefRel = chosenTopic.dirRel + '/briefs/' + ideaId + '.md';
    const hasBrief = fs.existsSync(briefAbs);
    const briefInfo = hasBrief
      ? parseBriefSummary(briefAbs, ideaId)
      : { ideaId, title: ideaId, anchor: 'none', isha: '', bsha: '', sha: '', preview: '' };

    const cards = [];
    let manifestStatus = '';
    let manifestPreview = '';
    const manifestAbs = path.join(topicCardsDirAbs, ideaId + '.manifest');
    const manifestRel = chosenTopic.dirRel + '/cards/' + ideaId + '.manifest';
    if (fs.existsSync(manifestAbs)) {
      manifestPreview = truncPreview(readUtf8Safe(manifestAbs), 1800);
      const mm = parseMetaAttrs(manifestPreview.split('\n', 1)[0] || '');
      manifestStatus = mm.status || 'OK';
    }
    const lockAbs = path.join(topicCardsDirAbs, ideaId + '.lock');
    const locked = fs.existsSync(lockAbs);

    if (fs.existsSync(topicCardsDirAbs)) {
      try {
        for (const f of fs.readdirSync(topicCardsDirAbs).sort()) {
          if (!f.startsWith(ideaId + '.') || !f.endsWith('.md')) continue;
          const mid = f.slice(ideaId.length + 1, -3);
          if (!mid || mid.includes('.')) continue;
          const cardAbs = path.join(topicCardsDirAbs, f);
          if (!fs.statSync(cardAbs).isFile()) continue;
          const parsedCard = parseReviewCardDetails(cardAbs, ideaId);
          cards.push({
            ...parsedCard,
            rel: chosenTopic.dirRel + '/cards/' + f,
          });
        }
      } catch { /* ignore */ }
    }

    const scoredCards = cards.filter((c) => c.score25 !== null);
    const meanScore25 = scoredCards.length > 0
      ? Math.round((scoredCards.reduce((acc, c) => acc + c.score25, 0) / scoredCards.length) * 10) / 10
      : null;
    const meanDims = scoredCards.length > 0 ? {} : null;
    if (meanDims) {
      for (const d of DIMS) {
        const vals = scoredCards.map((c) => c.dims && c.dims[d]).filter(Number.isFinite);
        meanDims[d] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0;
      }
    }

    const voteCounts = { go: 0, revise: 0, kill: 0 };
    for (const c of cards) {
      if (c.verdict === 'go' || c.verdict === 'revise' || c.verdict === 'kill') {
        voteCounts[c.verdict] += 1;
      }
    }

    const verdictRel = chosenTopic.dirRel + '/verdict-' + ideaId + '.md';
    const verdictInfo = parseVerdictDecision(path.join(topicDirAbs, 'verdict-' + ideaId + '.md'));

    const novCand1 = path.join(root, 'papers', 'novelty', ideaId + '.md');
    const novCand2 = path.join(root, 'papers', 'novelty', 'novelty-' + ideaId + '.md');
    const novAbs = fs.existsSync(novCand1) ? novCand1 : (fs.existsSync(novCand2) ? novCand2 : '');
    const novelty = novAbs && isInsideRoot(root, novAbs) ? parseNoveltySummary(novAbs) : null;

    ideas.push({
      ideaId,
      isCalibration: /^(?:smoke|calib)_/i.test(ideaId),
      title: briefInfo.title,
      briefRel: hasBrief ? briefRel : '',
      manifestRel,
      manifestStatus,
      manifestPreview,
      verdictRel,
      anchor: briefInfo.anchor,
      isha: briefInfo.isha,
      bsha: briefInfo.bsha,
      sha: briefInfo.sha,
      preview: briefInfo.preview,
      locked,
      cards,
      meanScore25,
      meanDims,
      voteCounts,
      novelty,
      verdict: verdictInfo.decision,
      verdictExists: verdictInfo.exists,
      verdictPreview: verdictInfo.preview,
      rank: null,
    });
  }

  ideas.sort((a, b) => {
    if (a.isCalibration !== b.isCalibration) return a.isCalibration ? 1 : -1;
    const sa = a.meanScore25 !== null ? a.meanScore25 : -1;
    const sb = b.meanScore25 !== null ? b.meanScore25 : -1;
    if (sb !== sa) return sb - sa;
    return a.ideaId.localeCompare(b.ideaId);
  });
  let rankSeq = 1;
  for (const it of ideas) {
    if (!it.isCalibration) it.rank = rankSeq++;
  }

  // 6) Novelty Reports Total & S6 Contracts
  let totalNoveltyFiles = 0;
  const novDir = path.join(root, 'papers', 'novelty');
  if (markers.exists && isInsideRoot(root, novDir) && fs.existsSync(novDir)) {
    try {
      totalNoveltyFiles = fs.readdirSync(novDir).filter((f) => f.endsWith('.md') && !f.startsWith('.')).length;
    } catch { totalNoveltyFiles = 0; }
  }

  const contractDir = path.join(root, 'contract');
  const changelogRaw = readUtf8Safe(path.join(contractDir, 'CHANGELOG.md'));
  const contracts = [];
  if (markers.exists && isInsideRoot(root, contractDir) && fs.existsSync(contractDir)) {
    try {
      for (const f of fs.readdirSync(contractDir).sort()) {
        if (!f.endsWith('.md') || f === 'TEMPLATE.md' || f === 'CHANGELOG.md' || f.startsWith('.')) continue;
        const abs = path.join(contractDir, f);
        if (!fs.statSync(abs).isFile()) continue;
        const chk = checkContractFile(abs, { rootDir: root, record: false });
        const raw = readUtf8Safe(abs);
        const cSha = (chk && chk.sha12) || sha12Text(raw);
        const frozen = Boolean(cSha && changelogRaw.includes(cSha));
        contracts.push({
          id: f.slice(0, -3),
          rel: 'contract/' + f,
          valid: Boolean(chk && chk.ok),
          frozen,
          sha12: cSha,
          preview: raw,
        });
      }
    } catch { /* ignore */ }
  }

  const realIdeas = ideas.filter((i) => !i.isCalibration);
  const reviewedIdeas = realIdeas.filter((i) => i.cards.length > 0);
  const decidedIdeas = realIdeas.filter((i) => i.verdict !== 'pending');
  const pendingVerdictCount = realIdeas.filter((i) => i.cards.length > 0 && i.verdict === 'pending').length;
  const topIdea = reviewedIdeas[0] || realIdeas[0] || ideas[0] || null;

  const stages = [
    {
      id: 'S0',
      code: 'S0',
      title: '文献调研',
      sub: '源码优先建池',
      badge: papers.length > 0 ? (papers.length + ' 篇卡') : '待调研',
      status: activeRun && activeRun.stage === 'S0' ? 'working' : (hasPool ? 'done' : (papers.length > 0 ? 'ready' : 'empty')),
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
      status: activeRun && activeRun.stage === 'S2' ? 'working' : (rawPools.length > 0 ? 'done' : 'empty'),
    },
    {
      id: 'S3',
      code: 'S3',
      title: '隔离拆单',
      sub: '2σ 判据把关',
      badge: realIdeas.length > 0 ? (realIdeas.length + ' 张工单') : '待拆单',
      status: realIdeas.length > 0 ? 'done' : 'empty',
    },
    {
      id: 'S4',
      code: 'S4',
      title: '多票盲审',
      sub: '沙箱扇出评议',
      badge: topIdea && topIdea.meanScore25 !== null
        ? ('#1 ' + topIdea.meanScore25 + '/25')
        : (lineup.review.length + ' 票阵容'),
      status: (activeRun && activeRun.stage === 'S4') || ideas.some((i) => i.locked)
        ? 'working'
        : (reviewedIdeas.length > 0 ? 'done' : (realIdeas.length > 0 ? 'ready' : 'empty')),
    },
    {
      id: 'S4.5',
      code: 'S4.5',
      title: '查重与探针',
      sub: '防撞车 + 2σ 探针',
      badge: totalNoveltyFiles > 0 ? (totalNoveltyFiles + ' 份查重') : '待核查',
      status: activeRun && activeRun.stage === 'S4.5' ? 'working' : (totalNoveltyFiles > 0 ? 'done' : 'empty'),
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
    stages,
    ideas: ideas.map((it) => ({
      ideaId: it.ideaId,
      isCalibration: it.isCalibration,
      rank: it.rank,
      title: it.title,
      meanScore25: it.meanScore25,
      voteCount: it.cards.length,
      voteCounts: it.voteCounts,
      verdict: it.verdict,
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
  if (cleanTopic !== 'default' && cleanTopic !== '' && (!/^[A-Za-z0-9._-]+$/.test(cleanTopic) || cleanTopic === '.' || cleanTopic === '..')) {
    return { ok: false, error: '非法的课题名称：' + cleanTopic };
  }

  const dirRel = (cleanTopic && cleanTopic !== 'default') ? ('ideas/' + cleanTopic) : 'ideas';
  const verdictRel = dirRel + '/verdict-' + cleanIdea + '.md';
  const verdictAbs = path.join(root, verdictRel);
  if (!isInsideRoot(root, verdictAbs)) {
    return { ok: false, error: '裁决路径越界' };
  }

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const humanNote = String(note || '').replace(/\r\n/g, '\n').trim()
    || (dec === 'go'
      ? '盲审五维表现与可行性核验通过，批准进入 S6 研究契约冻结环节。'
      : dec === 'revise'
        ? '核心机制有潜力但实验判据或基线衔接存在短板，退回修订后加 --force 重新拆单。'
        : '增益预期或可行性不成立，予以否决并沉淀负知识。');

  const body = [
    '# 人类裁决单：' + cleanIdea,
    '',
    '决定: ' + dec,
    '时间: ' + nowIso,
    '课题: ' + (cleanTopic || 'default'),
    '',
    '## 人类拍板意见',
    '',
    humanNote,
    '',
  ].join('\n');
  writeAtomicLf(verdictAbs, body);

  let appendedDeadEnd = false;
  if (dec === 'kill' && appendDeadEnd) {
    const summaryLine = String(deadEndSummary || note || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 180);
    if (summaryLine) {
      const deadRel = dirRel + '/dead-ends.md';
      const deadAbs = path.join(root, deadRel);
      if (isInsideRoot(root, deadAbs)) {
        const existing = fs.existsSync(deadAbs) ? readUtf8Safe(deadAbs).replace(/\r\n/g, '\n').replace(/\s*$/, '\n') : '# 禁入死胡同清单（dead-ends）\n\n';
        const dateTag = nowIso.slice(0, 10);
        const bullet = '- [' + dateTag + ' · ' + cleanIdea + '] ' + summaryLine + '\n';
        writeAtomicLf(deadAbs, existing + bullet);
        appendedDeadEnd = true;
      }
    }
  }

  return {
    ok: true,
    verdictRel,
    decision: dec,
    appendedDeadEnd,
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

  if (kind === 'init') {
    const topicOpt = cleanTopic && cleanTopic !== 'default' ? cleanTopic : null;
    const res = initProject(root, { force: false, topic: topicOpt });
    return {
      ok: Boolean(res && res.ok !== false),
      mode: 'sync',
      message: '科研工作流目录骨架已就绪',
    };
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
    const effTopic = cleanTopic && cleanTopic !== 'default' ? cleanTopic : null;
    const res = summarizeTopic(root, { topic: effTopic, writeFile: true });
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
    const dirRel = (cleanTopic && cleanTopic !== 'default') ? ('ideas/' + cleanTopic) : 'ideas';
    const briefRel = dirRel + '/briefs/' + cleanIdea + '.md';
    const briefAbs = path.join(root, briefRel);
    if (!isInsideRoot(root, briefAbs) || !fs.existsSync(briefAbs)) {
      return { ok: false, error: '找不到目标工单文件：' + briefRel };
    }

    const ledger = readTelemetryLedger(root);
    const conflict = ledger.runs.find((r) => r && r.status === 'working' && r.targetId === cleanIdea);
    if (conflict) {
      return { ok: false, error: '工单 ' + cleanIdea + ' 当前已有任务正在运行中，请等待本轮完成' };
    }

    const args = kind === 'run-brief'
      ? [DISPATCH_BIN, 'run', briefRel]
      : [DISPATCH_BIN, 'novelty', cleanIdea, ...(cleanTopic && cleanTopic !== 'default' ? ['--topic', cleanTopic] : [])];

    try {
      const child = spawn(process.execPath, args, {
        cwd: root,
        env: {
          ...process.env,
          DSH_DISPATCH_ROOT: root,
          ...(seatsFile && seatsFile !== 'dispatch/seats.json' ? { DSH_DISPATCH_CONFIG: seatsFile } : {}),
        },
        stdio: 'ignore',
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      if (typeof child.unref === 'function') child.unref();
      return {
        ok: true,
        mode: 'async',
        pid: child.pid || null,
        message: kind === 'run-brief'
          ? ('已启动工单 ' + cleanIdea + ' 的沙箱多票盲审，拓扑图将实时追踪进度')
          : ('已启动工单 ' + cleanIdea + ' 的单单隔离前置查重'),
      };
    } catch (e) {
      return { ok: false, error: '后台进程启动失败：' + String((e && e.message) || e) };
    }
  }

  return { ok: false, error: '不支持的操作类型：' + kind };
}
