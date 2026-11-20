// v2.0.0 全链路纯 Node 科研工作流引擎端到端自检（零外部网络、零 Python/Bash、不碰工作树）。
//
//   node plugin/research-dispatch/test/workflow.selftest.mjs
//
// 重点覆盖：
//   1. 仓外临时沙箱物理隔离：项目根放含哨兵密语的 AGENTS.md / CLAUDE.md，实测 Worker cwd 位于 os.tmpdir()，
//      向上遍历文件系统根全路径 0 命中项目指令，且执行完毕自动清理临时沙箱目录。
//   2. Agent 与模型全自由编排：同 Agent 多票（codex:m1,codex:m2 → codex1.md + codex2.md 不互踩、dsh 多票 patch 隔离）、
//      跨 Agent 同模型默认 rc=0 / status=OK / shared_models 留痕不毁票、显式 require_unique_models:true 严格拦截。
//   3. DSH 作用域隔离：存在 ~/.dsh/profiles/desktop/cordis.patch.yml 时，普通 CLI 严格以项目 dispatch/seats.json
//      为唯一真源；仅显式开启 DSH_DISPATCH_USE_PATCH=1 或宿主 useDshPatch:true 时读取面板补丁且不改写磁盘 seats.json。
//   4. S0→S6 全链路纯 Node 子命令闭环：init → agents → lineup → check-paper & pool → repro-watch →
//      diverge（挂载 ≤60 行截断 dead-ends.md，跑非 kimi 执行器 claude，防 meta 注入）→ briefs（ideas/<topic>/ 命名空间 +
//      拦跨条引用 + 2σ 收益门槛 + .superseded 归档）→ plan & run → summary（生成 _summary.md）& status（含孤儿未跑工单）→
//      check-novelty → pilot-stats（McNemar 2σ MDE + 合规子集同题配对防幸存者偏差）→
//      check-contract --record（5 列 CHANGELOG.md、拦空消融表、CRLF/LF 同哈希、v1→v2 版本链与 --re-record --reason）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const BIN = path.join(SRC, 'bin', 'dispatch.mjs');

const ft = await import(pathToFileURL(path.join(SRC, 'lib', 'flow-tools.mjs')).href);
const wf = await import(pathToFileURL(path.join(SRC, 'lib', 'workflow.mjs')).href);
const ps = await import(pathToFileURL(path.join(SRC, 'lib', 'pilot-stats.mjs')).href);
const val = await import(pathToFileURL(path.join(SRC, 'lib', 'validators.mjs')).href);
const runMod = await import(pathToFileURL(path.join(SRC, 'lib', 'run.mjs')).href);
const { buildDshModelOverrideFiles } = runMod;
const tel = await import(pathToFileURL(path.join(SRC, 'lib', 'telemetry.mjs')).href);

let checks = 0;
let fails = 0;
const ok = (m) => { checks++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { checks++; fails++; console.log('  \x1b[31m✗\x1b[0m ' + m); };
const t = (name, fn) => { try { fn(); ok(name); } catch (e) { bad(name + ' —— ' + ((e && e.message) || e)); } };
const ta = async (name, fn) => { try { await fn(); ok(name); } catch (e) { bad(name + ' —— ' + ((e && e.message) || e)); } };

const TMP_DIRS = [];
function mkTmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-wf-' + tag + '-'));
  TMP_DIRS.push(d);
  return d;
}

function cleanEnv(root, extra = {}) {
  const env = { ...process.env };
  for (const k of [
    'DSH_DISPATCH_BASH', 'RESEARCH_DISPATCH_BASH', 'DSH_DISPATCH_ROOT',
    'DSH_DISPATCH_CONFIG', 'DSH_DISPATCH_SETTINGS', 'DSH_DISPATCH_USE_PATCH',
    'RESEARCH_DISPATCH_DIAG', 'BACKENDS', 'REVIEW_LINEUP', 'DRY', 'CALIBRATION',
    'API_VOTES', 'ALLOW_DOOMED_PLAN', 'REQUIRE_UNIQUE_MODELS', 'CODEX_MODEL',
    'CLAUDE_MODEL', 'AGY_MODEL', 'AGY_CFG', 'AGY_MODELS_CACHE', 'GEMINI_MODEL', 'DSH_MODEL', 'API_MODEL', 'OPENAI_BASE_URL',
    'OPENAI_API_KEY', 'DIVERGE_CMD', 'DIVERGE_MODEL', 'BASELINE', 'DEAD_ENDS', 'NO_DEAD_ENDS', 'TOPIC',
  ]) {
    delete env[k];
  }
  const fakeHome = extra.__fakeHome || path.join(root, '.wf-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const copyExtra = { ...extra };
  delete copyExtra.__fakeHome;
  Object.assign(env, {
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    DSH_HOME: path.join(fakeHome, '.dsh'),
    AGY_SKIP_LIVE_MODELS: '1',
    ...copyExtra,
  });
  for (const k of Object.keys(env)) {
    if (env[k] === undefined || env[k] === null) delete env[k];
  }
  return env;
}

function runCli(cwd, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(cwd, extraEnv),
    timeout: 60000,
    windowsHide: true,
  });
  return { rc: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: (r.stdout || '') + (r.stderr || '') };
}

function runCliAsync(cwd, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: cleanEnv(cwd, extraEnv),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (rc) => resolve({ rc, stdout, stderr, out: stdout + stderr }));
  });
}

function validReviewCard(ideaId, verdict = 'go', tagNote = '') {
  return [
    '独立审阅评述：锚点对齐清晰。' + tagNote,
    '',
    '```yaml',
    'idea_id: ' + ideaId,
    'novelty:',
    '  score: 4',
    '  reason: "针对验证段与直觉段优势解耦给出明确反事实梯度项，区别于常规温度缩放。"',
    'feasibility:',
    '  score: 4',
    '  reason: "单机 40 步先导实验即可跑出配对差值与 2σ MDE，工程改动集中在损失函数。"',
    'baseline_fit:',
    '  score: 5',
    '  reason: "严格对齐基线 78.4%±0.3% 的同题评测协议与超参。"',
    'impl_cost:',
    '  score: 4',
    '  reason: "仅新增约 35 行配对优势掩码计算，无需额外采样器。"',
    'expected_gain:',
    '  score: 4',
    '  reason: "预期 +1.5% 超过 2σ 最小可检出效应（0.6%），具备可证伪统计功效。"',
    'verdict: ' + verdict,
    'kill_reason: ' + (verdict === 'kill' ? '"与既有优势归一化等价，无独立梯度贡献。"' : 'null'),
    'confidence: 0.85',
    'missing_info: []',
    '```',
    '',
  ].join('\n');
}

function startMockChatServer(handler) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const out = handler(parsed, req);
          res.writeHead(out.status || 200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(out.json));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({
        baseUrl: 'http://127.0.0.1:' + addr.port + '/v1',
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
    srv.on('error', reject);
  });
}

try {
  // ══════════════════════════════════════════════════════════════════════════
  // 1) 仓外临时沙箱物理隔离实证（防 Worker 向上遍历偷看项目根 AGENTS.md / CLAUDE.md）
  // ══════════════════════════════════════════════════════════════════════════
  console.log('── 1) 仓外临时沙箱物理隔离（os.tmpdir() 越仓防偷看 + 自动清理）');
  t('Worker 子进程 cwd 位于 os.tmpdir()，向上遍历至磁盘根无法读到项目根 AGENTS.md/CLAUDE.md，且跑完清理沙箱', () => {
    const isoWs = mkTmp('sandbox-isolation');
    const SENTINEL = 'SENTINEL_ROOT_SECRET_DO_NOT_LEAK_9918';
    fs.writeFileSync(path.join(isoWs, 'AGENTS.md'), '# Root Host Instructions\n' + SENTINEL + '\n', 'utf8');
    fs.writeFileSync(path.join(isoWs, 'CLAUDE.md'), '@AGENTS.md\n' + SENTINEL + '\n', 'utf8');
    fs.mkdirSync(path.join(isoWs, 'dispatch'), { recursive: true });
    fs.mkdirSync(path.join(isoWs, 'ideas', 'briefs'), { recursive: true });
    fs.mkdirSync(path.join(isoWs, 'ideas', 'cards'), { recursive: true });

    const probeOut = path.join(isoWs, 'worker-probe.json');
    const workerScript = path.join(isoWs, 'spy-worker.mjs');
    fs.writeFileSync(workerScript, [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const cwd = process.cwd();',
      'const foundFiles = [];',
      'let leaked = false;',
      'let cur = cwd;',
      'while (true) {',
      '  for (const name of ["AGENTS.md", "CLAUDE.md"]) {',
      '    const p = path.join(cur, name);',
      '    if (fs.existsSync(p)) {',
      '      const txt = fs.readFileSync(p, "utf8");',
      '      foundFiles.push(p);',
      '      if (txt.includes(' + JSON.stringify(SENTINEL) + ')) leaked = true;',
      '    }',
      '  }',
      '  const parent = path.dirname(cur);',
      '  if (parent === cur) break;',
      '  cur = parent;',
      '}',
      'fs.writeFileSync(' + JSON.stringify(probeOut) + ', JSON.stringify({ cwd, foundFiles, leaked }), "utf8");',
      'if (leaked) { console.error("LEAKED PROJECT AGENTS/CLAUDE!"); process.exit(19); }',
      'process.stdout.write(' + JSON.stringify(validReviewCard('idea_iso', 'go')) + ');',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(isoWs, 'ideas', 'briefs', 'idea_iso.md'), [
      '<!-- meta role=brief idea=idea_iso anchor=none -->',
      '### Baseline',
      'ResNet-50 Top-1 = 78.4% (±0.3%)',
      '### Idea',
      '**ID**: idea_iso',
      '验证仓外沙箱物理隔离。',
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(isoWs, 'dispatch', 'seats.json'), JSON.stringify({
      version: 2,
      paths: { cards_dir: 'ideas/cards', require_anchor: false },
      default_backends: ['codex'],
      seats: [{
        id: 'codex',
        kind: 'cli',
        enabled: true,
        command: process.execPath,
        argv: [workerScript],
        payload_position: 'stdin',
        output: 'stdout',
        identity: { kind: 'config', explicit_env: 'CODEX_MODEL' },
      }],
    }, null, 2), 'utf8');

    const res = runCli(isoWs, ['run', 'ideas/briefs/idea_iso.md'], { CODEX_MODEL: 'gpt-5-codex' });
    assert.equal(res.rc, 0, '沙箱评审应退 0，实得 ' + res.rc + '：\n' + res.out);
    assert.ok(fs.existsSync(probeOut), 'spy-worker 应写出探测结果');
    const probe = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
    const normCwd = path.resolve(probe.cwd).toLowerCase();
    const normRoot = path.resolve(isoWs).toLowerCase();
    const normTmp = path.resolve(os.tmpdir()).toLowerCase();
    assert.ok(normCwd.startsWith(normTmp), 'Worker cwd 必须位于 os.tmpdir() 内，实得：' + probe.cwd);
    assert.ok(!normCwd.startsWith(normRoot), 'Worker cwd 严禁落在项目目录树内，实得：' + probe.cwd);
    assert.equal(probe.leaked, false, '向上遍历绝不能读到项目根哨兵指令');
    assert.equal(fs.existsSync(probe.cwd), false, 'run 结束后仓外临时沙箱目录应已被自动清理：' + probe.cwd);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2) Agent 与模型全自由编排（同 Agent 多票不覆盖 + 跨 Agent 同模型默认放行 + 严格模式可开）
  // ══════════════════════════════════════════════════════════════════════════
  console.log('── 2) Agent 与模型自由编排（同 Agent 多票 + 跨 Agent 同模型留痕 + 严格策略）');
  await ta('lineup 写盘 → 同 Agent 双票 (codex:m1,codex:m2) 产出 codex1.md + codex2.md 零互踩；跨 Agent 同模型记 shared_models；strict 模式拦截', async () => {
    const freeWs = mkTmp('free-orchestration');
    fs.mkdirSync(path.join(freeWs, 'dispatch'), { recursive: true });
    fs.mkdirSync(path.join(freeWs, 'ideas', 'briefs'), { recursive: true });
    fs.mkdirSync(path.join(freeWs, 'ideas', 'cards'), { recursive: true });

    const multiWorker = path.join(freeWs, 'multi-codex.mjs');
    fs.writeFileSync(multiWorker, [
      'const m = process.env.CODEX_MODEL || "unset";',
      'process.stdout.write(' + JSON.stringify(validReviewCard('idea_free', 'go', ' [m=')) + '.replace("[m=", "[m=" + m + "]"));',
    ].join('\n'), 'utf8');

    const srv = await startMockChatServer((body) => ({
      json: {
        model: body.model || 'openai/gpt-5',
        choices: [{ message: { content: validReviewCard('idea_free', 'revise', ' [api]') } }],
      },
    }));

    try {
      fs.writeFileSync(path.join(freeWs, 'dispatch', 'seats.json'), JSON.stringify({
        version: 2,
        policy: { require_unique_models: false },
        paths: { cards_dir: 'ideas/cards', require_anchor: false },
        default_backends: ['codex'],
        seats: [
          {
            id: 'codex',
            kind: 'cli',
            enabled: true,
            command: process.execPath,
            argv: [multiWorker],
            payload_position: 'stdin',
            output: 'stdout',
            optional_args: [{ env: 'CODEX_MODEL', argv: ['-m', '{env}'] }],
            identity: { kind: 'config', explicit_env: 'CODEX_MODEL' },
          },
          {
            id: 'api',
            kind: 'api',
            enabled: true,
            base_env_default: 'OPENAI_BASE_URL',
            key_env_default: 'OPENAI_API_KEY',
            model: { env: 'API_MODEL', default: 'openai/gpt-5' },
            votes: { env: 'API_VOTES', default: 1 },
            temperature: { env: 'API_TEMPERATURE', default: '0.3' },
            identity: { kind: 'api' },
          },
        ],
      }, null, 2), 'utf8');

      fs.writeFileSync(path.join(freeWs, 'ideas', 'briefs', 'idea_free.md'), [
        '<!-- meta role=brief idea=idea_free anchor=none -->',
        '### Baseline',
        'Acc = 78.4% (±0.3%)',
        '### Idea',
        '**ID**: idea_free',
        '自由编排测试工单。',
      ].join('\n'), 'utf8');

      // 2a) lineup --review codex:model-alpha,codex:model-beta 持久化并派发双槽位
      const lr = runCli(freeWs, ['lineup', '--review', 'codex:model-alpha,codex:model-beta', '--diverge', 'codex:model-div']);
      assert.equal(lr.rc, 0, 'lineup 设置同 Agent 双票应退 0：\n' + lr.out);
      const savedSeats = JSON.parse(fs.readFileSync(path.join(freeWs, 'dispatch', 'seats.json'), 'utf8'));
      assert.equal(savedSeats.lineup.review.length, 2);
      assert.equal(savedSeats.lineup.diverge.seat, 'codex');

      const rMulti = runCli(freeWs, ['run', 'ideas/briefs/idea_free.md']);
      assert.equal(rMulti.rc, 0, '同 Agent 双不同模型票应退 0：\n' + rMulti.out);
      const c1 = path.join(freeWs, 'ideas', 'cards', 'idea_free.codex1.md');
      const c2 = path.join(freeWs, 'ideas', 'cards', 'idea_free.codex2.md');
      assert.ok(fs.existsSync(c1) && fs.existsSync(c2), '必须分别落盘 codex1.md 与 codex2.md 不互踩');
      assert.ok(fs.readFileSync(c1, 'utf8').includes('model=model-alpha-explicit'));
      assert.ok(fs.readFileSync(c2, 'utf8').includes('model=model-beta-explicit'));
      const mMulti = fs.readFileSync(path.join(freeWs, 'ideas', 'cards', 'idea_free.manifest'), 'utf8');
      assert.ok(mMulti.includes('status=OK') && mMulti.includes('votes: codex1 codex2'), mMulti);

      // 2b) DSH 多票临时补丁文件 slotTag 隔离 + <provider>/ 前缀剥除校验
      const dshTmp = mkTmp('dsh-slots');
      const basePatch = path.join(dshTmp, 'base.patch.yml');
      fs.writeFileSync(basePatch, 'plugins:\n  agent-tools:\n    disabled: true\n', 'utf8');
      const ov1 = buildDshModelOverrideFiles(dshTmp, basePatch, 'cline-pass/qwen3.8-max', 'dsh1');
      const ov2 = buildDshModelOverrideFiles(dshTmp, basePatch, 'qoder/deepseek-v4', 'dsh2');
      assert.notEqual(ov1.patchFile, ov2.patchFile, 'dsh1 与 dsh2 的临时补丁路径必须独立不互踩');
      assert.ok(fs.readFileSync(ov1.patchFile, 'utf8').includes('model: "qwen3.8-max"'), 'patch model 必须剥除 cline-pass/ 前缀');
      assert.ok(fs.readFileSync(ov2.patchFile, 'utf8').includes('model: "deepseek-v4"'), 'patch model 必须剥除 qoder/ 前缀');

      // 2c) 跨 Agent 同模型（codex:gpt-5 + api:openai/gpt-5）默认放行不毁票，manifest 记录 shared_models
      fs.rmSync(path.join(freeWs, 'ideas', 'cards'), { recursive: true, force: true });
      fs.mkdirSync(path.join(freeWs, 'ideas', 'cards'), { recursive: true });
      runCli(freeWs, ['lineup', '--review', 'codex:gpt-5,api:openai/gpt-5']);
      const rShared = await runCliAsync(freeWs, ['run', 'ideas/briefs/idea_free.md'], {
        OPENAI_BASE_URL: srv.baseUrl,
        OPENAI_API_KEY: 'sk-test-free-orchestration',
      });
      assert.equal(rShared.rc, 0, '跨 Agent 同模型在 v2.0.0 默认应退 0：\n' + rShared.out);
      assert.ok(fs.existsSync(path.join(freeWs, 'ideas', 'cards', 'idea_free.codex.md')));
      assert.ok(fs.existsSync(path.join(freeWs, 'ideas', 'cards', 'idea_free.api.md')));
      const mShared = fs.readFileSync(path.join(freeWs, 'ideas', 'cards', 'idea_free.manifest'), 'utf8');
      assert.ok(mShared.includes('status=OK') && mShared.includes('shared_models: 1/2 unique'), mShared);

      // 2d) 在 seats.json 显式配置 policy.require_unique_models: true 时，plan 标出 shared_models:true，run 预检退 2 拦截
      const strictCfg = JSON.parse(fs.readFileSync(path.join(freeWs, 'dispatch', 'seats.json'), 'utf8'));
      strictCfg.policy = { require_unique_models: true };
      fs.writeFileSync(path.join(freeWs, 'dispatch', 'seats.json'), JSON.stringify(strictCfg, null, 2), 'utf8');
      const rStrictPlan = runCli(freeWs, ['plan', 'ideas/briefs/idea_free.md'], {
        OPENAI_BASE_URL: srv.baseUrl,
        OPENAI_API_KEY: 'sk-test-free-orchestration',
      });
      assert.equal(rStrictPlan.rc, 0);
      const spJson = JSON.parse(rStrictPlan.stdout);
      assert.equal(spJson.require_unique_models, true);
      assert.equal(spJson.shared_models, true);

      const rStrictRun = runCli(freeWs, ['run', 'ideas/briefs/idea_free.md'], {
        OPENAI_BASE_URL: srv.baseUrl,
        OPENAI_API_KEY: 'sk-test-free-orchestration',
      });
      assert.equal(rStrictRun.rc, 2, 'policy.require_unique_models:true 时 run 同模型双票预检必须退 2：\n' + rStrictRun.out);
    } finally {
      await srv.close();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3) DSH 作用域隔离（普通 CLI 不受 ~/.dsh/.../cordis.patch.yml 暗中劫持）
  // ══════════════════════════════════════════════════════════════════════════
  console.log('── 3) DSH 作用域隔离（普通 CLI 严守 seats.json，仅 DSH 模式读取补丁）');
  await ta('存在 ~/.dsh/profiles/desktop/cordis.patch.yml 时普通 CLI 完全忽略，DSH 模式按需读取且不改写磁盘 seats.json', async () => {
    const scopeWs = mkTmp('dsh-scope');
    const fakeHome = path.join(scopeWs, 'mock-user-home');
    const dshDesktopDir = path.join(fakeHome, '.dsh', 'profiles', 'desktop');
    fs.mkdirSync(dshDesktopDir, { recursive: true });
    fs.writeFileSync(path.join(dshDesktopDir, 'cordis.patch.yml'), [
      'plugins:',
      '  - id: research-dispatch',
      '    config:',
      '      reviewVotes: "claude:hijacked-by-dsh-patch"',
      '      divergeCommand: "gemini"',
      '      divergeModel: "hijacked-gemini-model"',
    ].join('\n'), 'utf8');

    const initRes = runCli(scopeWs, ['init'], { __fakeHome: fakeHome });
    assert.equal(initRes.rc, 0, initRes.out);
    runCli(scopeWs, ['lineup', '--review', 'codex:project-codex-v2', '--diverge', 'claude:project-claude-v2'], { __fakeHome: fakeHome });
    const seatsDiskBefore = fs.readFileSync(path.join(scopeWs, 'dispatch', 'seats.json'), 'utf8');

    fs.mkdirSync(path.join(scopeWs, 'ideas', 'briefs'), { recursive: true });
    fs.writeFileSync(path.join(scopeWs, 'ideas', 'briefs', 'idea_scope.md'), [
      '<!-- meta role=brief idea=idea_scope anchor=none -->',
      '### Baseline',
      'F1 = 81.2% (±0.2%)',
      '### Idea',
      '**ID**: idea_scope',
      '作用域隔离校验。',
    ].join('\n'), 'utf8');

    // 普通 CLI 调用：必须严格读 seats.json 里的 codex:project-codex-v2 与 claude:project-claude-v2
    const normalPlan = runCli(scopeWs, ['plan', 'ideas/briefs/idea_scope.md'], { __fakeHome: fakeHome });
    assert.equal(normalPlan.rc, 0, normalPlan.out);
    const np = JSON.parse(normalPlan.stdout);
    assert.equal(np.source, 'lineup', '普通 CLI 必须走项目 lineup 而非 DSH 补丁');
    assert.equal(np.plan[0].seat, 'codex');
    assert.equal(np.plan[0].identity, 'project-codex-v2-explicit');

    const normalLineup = runCli(scopeWs, ['lineup', '--json'], { __fakeHome: fakeHome });
    assert.equal(normalLineup.rc, 0, normalLineup.out);
    const nlJson = JSON.parse(normalLineup.stdout);
    assert.equal(nlJson.diverge.source, 'lineup', '普通 CLI 发散配置必须来自项目 lineup 而非 DSH 补丁');
    assert.equal(nlJson.diverge.seat, 'claude');
    assert.equal(nlJson.diverge.model, 'project-claude-v2');

    // 显式开启 DSH_DISPATCH_USE_PATCH=1：才读取 DSH 面板补丁，且磁盘 seats.json 纹丝不动
    const dshPlan = runCli(scopeWs, ['plan', 'ideas/briefs/idea_scope.md'], {
      __fakeHome: fakeHome,
      DSH_DISPATCH_USE_PATCH: '1',
    });
    assert.equal(dshPlan.rc, 0, dshPlan.out);
    const dp = JSON.parse(dshPlan.stdout);
    assert.equal(dp.source, 'panel');
    assert.equal(dp.plan[0].seat, 'claude');
    assert.equal(dp.plan[0].identity, 'hijacked-by-dsh-patch-explicit');

    const dshLineup = runCli(scopeWs, ['lineup', '--json'], { __fakeHome: fakeHome, DSH_DISPATCH_USE_PATCH: '1' });
    const dlJson = JSON.parse(dshLineup.stdout);
    assert.equal(dlJson.diverge.seat, 'gemini');
    assert.equal(dlJson.diverge.model, 'hijacked-gemini-model');
    assert.equal(fs.readFileSync(path.join(scopeWs, 'dispatch', 'seats.json'), 'utf8'), seatsDiskBefore, 'DSH 模式绝不篡改项目 dispatch/seats.json');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4) S0 → S6 全链路纯 Node 子命令端到端闭环
  // ══════════════════════════════════════════════════════════════════════════
  console.log('── 4) S0 → S6 全链路纯 Node 端到端闭环（init → pool → repro → diverge → briefs → run → summary → novelty → pilot-stats → contract）');
  const e2eWs = mkTmp('full-s0-s6');
  const TOPIC = 'rlvr-calib';

  t('S0 init --topic & agents：一键生成 13 份跨宿主标准骨架，二次执行默认跳过不覆盖，agents --json 正常探测', () => {
    const rInit = runCli(e2eWs, ['init', '--topic', TOPIC]);
    assert.equal(rInit.rc, 0, 'init 应退 0：\n' + rInit.out);
    const expectedFiles = [
      'AGENTS.md',
      'CLAUDE.md',
      'dispatch/seats.json',
      'roles/diverger.md',
      'roles/scout.md',
      'roles/reviewer.md',
      'roles/novelty.md',
      'baselines/TEMPLATE.REPRO.md',
      'baselines/TEMPLATE.BRIEF_BLOCK.md',
      'contract/TEMPLATE.md',
      'contract/CHANGELOG.md',
      'skills/research-flow/SKILL.md',
      'ideas/' + TOPIC + '/dead-ends.md',
    ];
    for (const rel of expectedFiles) {
      assert.ok(fs.existsSync(path.join(e2eWs, rel)), 'init 缺少预期文件：' + rel);
    }
    assert.ok(fs.readFileSync(path.join(e2eWs, 'CLAUDE.md'), 'utf8').trim().startsWith('@AGENTS.md'), 'CLAUDE.md 首行必须通过 @AGENTS.md 桥接');
    const seatsV2 = JSON.parse(fs.readFileSync(path.join(e2eWs, 'dispatch', 'seats.json'), 'utf8'));
    assert.equal(seatsV2.version, 2);
    assert.equal(seatsV2.policy.require_unique_models, false);

    // 用户手改 AGENTS.md 后再次跑 init（无 --force）绝不覆盖
    fs.appendFileSync(path.join(e2eWs, 'AGENTS.md'), '\n<!-- USER_CUSTOM_NOTE -->\n', 'utf8');
    const rInit2 = runCli(e2eWs, ['init', '--topic', TOPIC]);
    assert.equal(rInit2.rc, 0);
    assert.ok(fs.readFileSync(path.join(e2eWs, 'AGENTS.md'), 'utf8').includes('USER_CUSTOM_NOTE'), '无 --force 时 init 绝不能覆盖用户已改文件');

    const rAgents = runCli(e2eWs, ['agents', '--json']);
    assert.equal(rAgents.rc, 0, rAgents.out);
    const agJson = JSON.parse(rAgents.stdout);
    assert.ok(Array.isArray(agJson.agents) && agJson.agents.some((a) => a.id === 'codex') && agJson.agents.some((a) => a.id === 'agy'));
  });

  await ta('dispatchFlow agents 动作：向导工具直接返回 Agent 可用性列表', async () => {
    const r = await ft.dispatchFlow({ action: 'agents' }, { repoRoot: e2eWs });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.agents) && r.agents.length >= 5);
  });

  t('S1 check-paper & pool：拦截缺字段/超长散文/裸 --- 多段块（[D-11]），pool 隔离坏卡且单卡错误只报一次（[D-12]）', () => {
    const cardsDir = path.join(e2eWs, 'papers', 'cards');
    fs.mkdirSync(cardsDir, { recursive: true });

    const goodCard1 = [
      '<!-- meta role=scout via=host-search -->',
      '```yaml',
      'paper_id: "calibrated-adv-2026"',
      'title: "Calibrated Advantage Estimation for Multimodal Reasoning"',
      'venue: "ICLR"',
      'code_url: "https://github.com/example/calibrated-adv"',
      'abstract_zh: "提出在组内相对奖励上做方差自适应裁剪，显著降低长链退化。"',
      'intro_key: "直接对长链与短链混算组均值会把格式长度偏差混入策略梯度。"',
      'relevance: "为本课题配对优势解耦提供了方差下界对照。"',
      '```',
      '',
    ].join('\n');
    const goodCard2 = [
      '```yaml',
      'paper_id: "paired-rollout-2025"',
      'title: "Paired Rollout Diagnostics in Verifiable Math RL"',
      'venue: "NeurIPS"',
      'code_url: "none"',
      'abstract_zh: "证明同题配对 McNemar 标准误比边际二项标准误灵敏三倍以上。"',
      'intro_key: "小效应被边际抽样噪声淹没是先导实验误杀真机制的主因。"',
      'relevance: "支撑我们采用同题配对 2σ MDE 作为送审门槛。"',
      '```',
      '',
    ].join('\n');
    const badExtraDocCard = [
      '---',
      'paper_id: "bad_doc"',
      'title: "Broken Multi Doc Card"',
      'venue: "arXiv"',
      'code_url: "none"',
      'abstract_zh: "第一段合法但后面跟了多余文档块。"',
      'intro_key: "测试裸分隔线多块拦截。"',
      'relevance: "应被判不合规隔离。"',
      '---',
      'extra_injected_key: "should_fail_d11"',
      '---',
    ].join('\n');

    fs.writeFileSync(path.join(cardsDir, 'calibrated-adv-2026.md'), goodCard1, 'utf8');
    fs.writeFileSync(path.join(cardsDir, 'paired-rollout-2025.md'), goodCard2, 'utf8');
    const badPath = path.join(cardsDir, 'bad_doc.md');
    fs.writeFileSync(badPath, badExtraDocCard, 'utf8');

    assert.equal(runCli(e2eWs, ['check-paper', 'papers/cards/calibrated-adv-2026.md']).rc, 0);
    assert.equal(runCli(e2eWs, ['check-paper', 'papers/cards/bad_doc.md']).rc, 1, '含多余 --- 块的文献卡必须退 1');

    // 第 1 次 pool：含 1 张坏卡时将其隔离至 rejected/*.rejected、生成 _pool.md 并返回 rc=1 提醒核查；且隔离通知只报 1 次（[D-12]）
    const rPool1 = runCli(e2eWs, ['pool']);
    assert.equal(rPool1.rc, 1, '含坏卡隔离时 pool 应退 1 提醒，同时写出 _pool.md');
    assert.ok(fs.existsSync(path.join(cardsDir, '_pool.md')), '应写出 papers/cards/_pool.md');
    assert.ok(!fs.existsSync(badPath) && fs.existsSync(path.join(cardsDir, 'rejected', 'bad_doc.md.rejected')),
      '坏卡应移入 papers/cards/rejected/bad_doc.md.rejected');
    const quarantineNoticeLines = rPool1.stderr.split('\n').filter((l) => l.includes('已移入 rejected/bad_doc.md.rejected'));
    assert.equal(quarantineNoticeLines.length, 1, '[D-12] 同一张坏卡的隔离通知只应打印 1 次：\n' + rPool1.stderr);

    // 第 2 次 pool：坏卡已隔离，全池洁净退 0
    const rPool2 = runCli(e2eWs, ['pool']);
    assert.equal(rPool2.rc, 0, '坏卡隔离后再次组装全池洁净应退 0：\n' + rPool2.out);
  });

  t('S2 repro-watch + 基线签字：缺失日志文件退 2（[D-10]），忽略模板 sha256sum 占位词，真实数据哈希 + 鲜活日志退 0', () => {
    const bDir = path.join(e2eWs, 'baselines', 'b1');
    fs.mkdirSync(path.join(bDir, 'data'), { recursive: true });
    const dataFile = path.join(bDir, 'data', 'val.jsonl');
    const dataBytes = '{"id":1,"q":"2+2","a":"4"}\n';
    fs.writeFileSync(dataFile, dataBytes, 'utf8');
    const dataSha = crypto.createHash('sha256').update(dataBytes, 'utf8').digest('hex');

    // 写入带 CRLF 行尾的 BRIEF_BLOCK.md 与 REPRO.md（顺带压测跨平台 CRLF bsha 一致性！）
    fs.writeFileSync(path.join(bDir, 'BRIEF_BLOCK.md'), [
      '### Baseline 锚点（baselines/b1）',
      '- 模型与评测集：Qwen-Math-1.5B on ValSet (N=1000)',
      '- 复现主指标：acc = 78.40%（标准误 ±0.30%，2σ=0.60pp，详见 REPRO.md §3.1）',
      '- 训练预算：单卡 40 steps，seed=42',
    ].join('\r\n') + '\r\n', 'utf8');

    fs.writeFileSync(path.join(bDir, 'REPRO.md'), [
      '# 基线复现记录',
      '## 1. 环境与命令',
      '参考命令：`sha256sum <data.tar>`（模板说明行不应被误抓为文件名）',
      '## 2. 数据校验',
      dataSha + '  data/val.jsonl',
      '## 3. 关键指标',
      '| metric | 论文报告 | 我复现 | 容差 | 判定 |',
      '|---|---|---|---|---|',
      '| acc | 78.50% | 78.40% | ±0.30% | PASS |',
      '## 4. 人验收签字',
      'SIGNOFF: PASS',
    ].join('\r\n') + '\r\n', 'utf8');

    const rMissingLog = runCli(e2eWs, ['repro-watch', 'baselines/b1', '--log', 'baselines/b1/nonexistent.log']);
    assert.equal(rMissingLog.rc, 2, '[D-10] 指向不存在日志时必须退 2，实得 ' + rMissingLog.rc);

    const logFile = path.join(bDir, 'train.log');
    fs.writeFileSync(logFile, 'step=10 loss=0.412\nstep=40 acc=78.40%\n', 'utf8');
    const rOk = runCli(e2eWs, ['repro-watch', 'baselines/b1', '--log', 'baselines/b1/train.log']);
    assert.equal(rOk.rc, 0, '真实数据 sha256 对齐且日志鲜活时 repro-watch 应退 0：\n' + rOk.out);
  });

  t('S3 diverge：挂载 ≤60 行截断 dead-ends.md，跑非 kimi 执行器（claude），防 meta 注入（[D-8]），写出 ideas/<topic>/raw-*.md', () => {
    // 构造 75 行倒序 dead-ends.md（最新死胡同在前 60 行，超限旧行在 61..75 行被自动截断）
    const deLines = ['# 本方向已知死胡同（倒序，最新在上）'];
    for (let i = 1; i <= 74; i++) {
      deLines.push('- 死胡同 #' + String(i).padStart(2, '0')
        + (i === 5 ? ' RECENT_TOP_KEEP_MARKER' : '')
        + (i === 72 ? ' OVERFLOW_TAIL_DROP_MARKER' : ''));
    }
    fs.writeFileSync(path.join(e2eWs, 'ideas', TOPIC, 'dead-ends.md'), deLines.join('\n') + '\n', 'utf8');

    const divProbe = path.join(e2eWs, 'diverge-probe.json');
    const mockClaudeDiverger = path.join(e2eWs, 'mock-claude-diverger.mjs');
    fs.writeFileSync(mockClaudeDiverger, [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'import os from "node:os";',
      'const pIdx = process.argv.indexOf("-p");',
      'const prompt = pIdx >= 0 ? process.argv[pIdx + 1] : fs.readFileSync(0, "utf8");',
      'fs.writeFileSync(' + JSON.stringify(divProbe) + ', JSON.stringify({',
      '  cwd: process.cwd(),',
      '  inTmp: path.resolve(process.cwd()).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()),',
      '  hasRecentKeep: prompt.includes("RECENT_TOP_KEEP_MARKER"),',
      '  hasOverflowDrop: prompt.includes("OVERFLOW_TAIL_DROP_MARKER"),',
      '  hasBaseline: prompt.includes("78.40%"),',
      '}), "utf8");',
      'process.stdout.write([',
      '  "### idea_01 配对验证段残差优势门控",',
      '  "- 假设：仅对同题 rollout 中第二段与第一段判定不一致的样本赋予残差优势权重，可消除长链均值混杂并放大有效纠错梯度。",',
      '  "- 做法：固定主干与采样超参不变，在优势计算层识别首末段不一致单元并施加残差门控权重，其余一致单元保持原组均值。",',
      '  "- 最小证伪实验：在 1000 题验证集上跑 40 步先导对比，测量同题配对 fix/break 净增益。",',
      '  "- 预测：验证集准确率由 78.40% 提升 +1.50pp，且格式合规率波动不超过 1.0pp。",',
      '  "- 主读数：acc +1.50pp（ValSet 主指标）",',
      '  "- 判据：2σ=0.60pp",',
      '  "- 若失败说明什么：若配对 Δ < +0.60pp，说明首末段不一致单元主要是随机采样噪声而非可学习纠错信号。",',
      '  "",',
      '  "### idea_02 首答高置信非对称 KL 护栏",',
      '  "- 假设：对首答低熵高置信样本施加非对称 KL 护栏，可显著抑制验证段把已答对样本改错的逆向破坏（break）。",',
      '  "- 做法：按首段输出 token 熵中位数分桶，对低熵桶验证段施加单侧 KL 惩罚，其余训练步数与学习率严格保持基线设置。",',
      '  "- 最小证伪实验：单卡 40 步微训练后统计同题配对 break 计数与总准确率变化。",',
      '  "- 预测：验证集准确率提升 +1.20pp，break 计数下降至少 25%。",',
      '  "- 主读数：acc +1.20pp（ValSet 主指标）",',
      '  "- 判据：2σ=0.60pp",',
      '  "- 若失败说明什么：若 break 未降或总增益落入 0.60pp 噪声带，说明改错并非源于低熵过拟合。",',
      '  "",',
      '  "### idea_03 跨条引用违规候选",',
      '  "- 假设：同上一条 idea_01 的残差门控假设，把温度从 0.7 调为 0.8 可进一步增加多样性。",',
      '  "- 做法：沿用上一条模块改动并把采样温度提高 0.1，其余设置不变以观察验证集变化。",',
      '  "- 最小证伪实验：跑 40 步对比 idea_01。",',
      '  "- 预测：验证集准确率提升 +1.60pp。",',
      '  "- 主读数：acc +1.60pp",',
      '  "- 判据：2σ=0.60pp",',
      '  "- 若失败说明什么：温度微调无独立机制。",',
      '  "",',
      '  "### idea_04 低于两倍标准误噪声带候选",',
      '  "- 假设：把学习率线性预热从 5 步延长到 8 步能微弱平滑早期梯度抖动。",',
      '  "- 做法：仅将 warmup_steps 参数由 5 改为 8，其余损失函数、数据顺序与 40 步预算完全不变。",',
      '  "- 最小证伪实验：跑单卡 40 步测量验证集差异。",',
      '  "- 预测：验证集准确率提升 +0.35pp。",',
      '  "- 主读数：acc +0.35pp",',
      '  "- 判据：2σ=0.60pp",',
      '  "- 若失败说明什么：低于两倍标准误无法区分随机波动。",',
      '].join("\\n"));',
    ].join('\n'), 'utf8');

    const cfg = JSON.parse(fs.readFileSync(path.join(e2eWs, 'dispatch', 'seats.json'), 'utf8'));
    const claudeSeat = cfg.seats.find((s) => s.id === 'claude');
    claudeSeat.command = process.execPath;
    claudeSeat.argv = [mockClaudeDiverger, '-p', '{payload}', '{optional_args}'];
    claudeSeat.enabled = true;
    fs.writeFileSync(path.join(e2eWs, 'dispatch', 'seats.json'), JSON.stringify(cfg, null, 2), 'utf8');

    // 故意在 --agent 模型段附带 "-->" 压测 [D-8] meta 注释注入净化
    const rDiv = runCli(e2eWs, [
      'diverge', '可验证奖励下验证段与直觉段配对解耦', '4',
      '--topic', TOPIC,
      '--baseline', 'baselines/b1',
      '--pool', 'papers/cards/_pool.md',
      '--agent', 'claude:claude-sonnet-4-5-->',
    ]);
    assert.equal(rDiv.rc, 0, '非 kimi 执行器 claude 发散应退 0：\n' + rDiv.out);
    assert.ok(rDiv.out.includes('前 60 行'), '超过 60 行的 dead-ends.md 应输出截断提示');

    const probe = JSON.parse(fs.readFileSync(divProbe, 'utf8'));
    assert.equal(probe.inTmp, true, 'diverge 子进程同样必须在 os.tmpdir() 仓外沙箱运行');
    assert.equal(probe.hasRecentKeep, true, '前 60 行最新负知识应完整喂入发散提示词');
    assert.equal(probe.hasOverflowDrop, false, '第 60 行之后的超限旧行应被截除防负向锚定过载');
    assert.equal(probe.hasBaseline, true, '已签字 BRIEF_BLOCK.md 应自动注入发散提示词');

    const rawFiles = fs.readdirSync(path.join(e2eWs, 'ideas', TOPIC)).filter((f) => f.startsWith('raw-') && f.endsWith('.md'));
    assert.equal(rawFiles.length, 1, '应在 ideas/<topic>/ 下生成 1 份 raw-*.md');
    const rawContent = fs.readFileSync(path.join(e2eWs, 'ideas', TOPIC, rawFiles[0]), 'utf8');
    const firstLine = rawContent.split('\n')[0];
    assert.ok(firstLine.startsWith('<!-- meta role=diverger ') && firstLine.endsWith(' -->'), '首行必须是闭合单行 meta 注释：' + firstLine);
    assert.equal((firstLine.match(/-->/g) || []).length, 1, '[D-8] 模型名中的 --> 必须被净化转义，严禁提前闭合注释');
  });

  t('S4 briefs：拆单进 ideas/<topic>/briefs/、拦截跨条引用 (idea_03) 与 <2σ 噪声候选 (idea_04)、--force 归档 .superseded', () => {
    const rawFiles = fs.readdirSync(path.join(e2eWs, 'ideas', TOPIC)).filter((f) => f.startsWith('raw-') && f.endsWith('.md'));
    const rawRel = 'ideas/' + TOPIC + '/' + rawFiles[0];

    const rBriefs = runCli(e2eWs, ['briefs', rawRel, '--topic', TOPIC, '--baseline', 'baselines/b1']);
    assert.equal(rBriefs.rc, 0, '合法候选存在时 briefs 应拆出合格工单并退 0：\n' + rBriefs.out);

    const briefsDir = path.join(e2eWs, 'ideas', TOPIC, 'briefs');
    assert.ok(fs.existsSync(path.join(briefsDir, 'idea_01.md')), 'idea_01 应通过拆单');
    assert.ok(fs.existsSync(path.join(briefsDir, 'idea_02.md')), 'idea_02 应通过拆单');
    assert.ok(!fs.existsSync(path.join(briefsDir, 'idea_03.md')), '含跨条引用「同上一条 / idea_01」的 idea_03 必须被拒');
    assert.ok(!fs.existsSync(path.join(briefsDir, 'idea_04.md')), '主读数 +0.35pp < 2σ(0.60pp) 的 idea_04 必须被拒');

    // 验证 --force 将旧工单归档至 .superseded/
    const rForce = runCli(e2eWs, ['briefs', rawRel, '--topic', TOPIC, '--baseline', 'baselines/b1', '--force']);
    assert.equal(rForce.rc, 0, rForce.out);
    const supDir = path.join(briefsDir, '.superseded');
    assert.ok(fs.existsSync(supDir) && fs.readdirSync(supDir).some((f) => f.includes('idea_01')), '--force 重拆时旧工单应归档进 .superseded/');
  });

  await ta('S5 plan → run → summary → status：自动路由至 ideas/<topic>/cards/，生成 _summary.md，检出孤儿未跑工单与人工裁决闭环', async () => {
    const mockClaudeReviewer = path.join(e2eWs, 'mock-claude-reviewer.mjs');
    fs.writeFileSync(mockClaudeReviewer, [
      'process.stdout.write(' + JSON.stringify(validReviewCard('idea_01', 'go')) + ');',
    ].join('\n'), 'utf8');

    const srv = await startMockChatServer((body) => ({
      json: {
        model: body.model || 'deepseek/deepseek-r1',
        choices: [{ message: { content: validReviewCard('idea_01', 'revise') } }],
      },
    }));

    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(e2eWs, 'dispatch', 'seats.json'), 'utf8'));
      const claudeSeat = cfg.seats.find((s) => s.id === 'claude');
      claudeSeat.command = process.execPath;
      claudeSeat.argv = [mockClaudeReviewer];
      claudeSeat.payload_position = 'stdin';
      const apiSeat = cfg.seats.find((s) => s.id === 'api');
      apiSeat.enabled = true;
      cfg.lineup = {
        review: [
          { seat: 'claude', model: 'claude-sonnet-4-5' },
          { seat: 'api', model: 'deepseek/deepseek-r1' },
        ],
        diverge: { seat: 'claude', model: 'claude-sonnet-4-5' },
      };
      fs.writeFileSync(path.join(e2eWs, 'dispatch', 'seats.json'), JSON.stringify(cfg, null, 2), 'utf8');

      const briefRel = 'ideas/' + TOPIC + '/briefs/idea_01.md';
      const rRun = await runCliAsync(e2eWs, ['run', briefRel], {
        OPENAI_BASE_URL: srv.baseUrl,
        OPENAI_API_KEY: 'sk-test-e2e-key',
      });
      assert.equal(rRun.rc, 0, '双异构席位评审应退 0：\n' + rRun.out);
      assert.ok(fs.existsSync(path.join(e2eWs, 'ideas', TOPIC, 'cards', 'idea_01.claude.md')),
        '工单位于 ideas/<topic>/briefs/ 时应自动将卡片写至 ideas/<topic>/cards/');
      assert.ok(fs.existsSync(path.join(e2eWs, 'ideas', TOPIC, 'cards', 'idea_01.api.md')));

      // status 应报 idea_01 待裁决 (rc=1)，且把尚未送审的 idea_02 列入 unrun 孤儿工单（[D-15]）
      const stBefore = await ft.dispatchFlow({ action: 'status', topic: TOPIC }, { repoRoot: e2eWs });
      assert.equal(stBefore.ok, true);
      assert.equal(stBefore.rc, 1, '尚未写 verdict-idea_01.md 时 status 应退 1');
      assert.equal(stBefore.has_pending, true);
      assert.ok(stBefore.buckets && Array.isArray(stBefore.buckets.unrun) && stBefore.buckets.unrun.some((u) => JSON.stringify(u).includes('idea_02')),
        '[D-15] 未跑评审的孤儿工单 idea_02 必须被 status 检出：' + JSON.stringify(stBefore.buckets));

      // summary 生成横向对比总表 ideas/<topic>/_summary.md
      const rSum1 = runCli(e2eWs, ['summary', '--topic', TOPIC]);
      assert.equal(rSum1.rc, 0, rSum1.out);
      const sumPath = path.join(e2eWs, 'ideas', TOPIC, '_summary.md');
      assert.ok(fs.existsSync(sumPath), '应写出 ideas/<topic>/_summary.md');
      const sumMd1 = fs.readFileSync(sumPath, 'utf8');
      assert.ok(sumMd1.includes('idea_01') && sumMd1.includes('go') && sumMd1.includes('revise'), sumMd1);

      // 人工写入 verdict-idea_01.md 后，status 待裁决清零 (rc=0)，且 dispatchFlow summary 同步刷新人工结论
      fs.writeFileSync(path.join(e2eWs, 'ideas', TOPIC, 'verdict-idea_01.md'), [
        '# 人工裁决：idea_01',
        '- 决定: go',
        '- 理由: 两票均认可配对验证段残差优势机制，进入 40 步先导实验。',
      ].join('\n'), 'utf8');

      const stAfter = runCli(e2eWs, ['status', '--topic', TOPIC]);
      assert.equal(stAfter.rc, 0, '人工落槌后待裁决清零应退 0：\n' + stAfter.out);

      const flowSum = await ft.dispatchFlow({ action: 'summary', topic: TOPIC }, { repoRoot: e2eWs });
      assert.equal(flowSum.ok, true);
      assert.ok(flowSum.report.includes('go'), '刷新后的 _summary.md 应体现人工裁决 go');
    } finally {
      await srv.close();
    }
  });

  t('S5.5 check-novelty：拦截 high 空引用、拦截 low 无检索源空引用、拦截布尔 confidence，放行严谨新颖度复核卡', () => {
    const novDir = path.join(e2eWs, 'papers', 'novelty');
    fs.mkdirSync(novDir, { recursive: true });

    const badHighEmpty = [
      '```yaml',
      'idea_id: "bad_high"',
      'duplication_risk: high',
      'closest_works: []',
      'polish: "none"',
      'note: "高度撞车。"',
      'confidence: 0.8',
      '```',
    ].join('\n');
    fs.writeFileSync(path.join(novDir, 'bad_high.md'), badHighEmpty, 'utf8');
    assert.equal(runCli(e2eWs, ['check-novelty', 'papers/novelty/bad_high.md']).rc, 1, 'duplication_risk=high 却 closest_works:[] 必须退 1');

    const badLowNoSearch = [
      '```yaml',
      'idea_id: "bad_low"',
      'duplication_risk: low',
      'closest_works: []',
      'polish: "none"',
      'note: "目前没人做过类似方法。"',
      'confidence: 0.8',
      '```',
    ].join('\n');
    fs.writeFileSync(path.join(novDir, 'bad_low.md'), badLowNoSearch, 'utf8');
    assert.equal(runCli(e2eWs, ['check-novelty', 'papers/novelty/bad_low.md']).rc, 1, 'duplication_risk=low 空列表未交代检索源与阴性结论必须退 1');

    const badBoolConf = [
      '```yaml',
      'idea_id: "bad_bool"',
      'duplication_risk: low',
      'closest_works: []',
      'polish: "none"',
      'note: "经 arXiv 与 Semantic Scholar 检索未发现同类配对残差门控。"',
      'confidence: true',
      '```',
    ].join('\n');
    fs.writeFileSync(path.join(novDir, 'bad_bool.md'), badBoolConf, 'utf8');
    assert.equal(runCli(e2eWs, ['check-novelty', 'papers/novelty/bad_bool.md']).rc, 1, '布尔 confidence 必须退 1');

    const goodNovelty = [
      '```yaml',
      'idea_id: "idea_01"',
      'duplication_risk: low',
      'closest_works:',
      '  - title: "Paired Rollout Diagnostics in Verifiable Math RL"',
      '    venue: "NeurIPS"',
      '    year: 2025',
      '    url: "https://arxiv.org/abs/2602.00202"',
      '    overlap: "同样使用同题 rollout 首末段差异信号"',
      '    difference: "该文仅作离线评测探针，未构造在线非对称策略梯度门控"',
      'polish: "在实验契约中固定离线评测探针为控制臂 A"',
      'note: "检索渠道：arXiv + Semantic Scholar（关键词 paired rollout residual advantage）；未发现直接同构训练机制。"',
      'confidence: 0.85',
      '```',
    ].join('\n');
    fs.writeFileSync(path.join(novDir, 'idea_01.md'), goodNovelty, 'utf8');
    const rNovOk = runCli(e2eWs, ['check-novelty', 'papers/novelty/idea_01.md']);
    assert.equal(rNovOk.rc, 0, '合规新颖度报告应退 0：\n' + rNovOk.out);
  });

  t('S6a pilot-stats：精确复现 McNemar 配对 2σ MDE 四位小数读数，并纠偏合规子集幸存者偏差', () => {
    // (1) 用 n=13920, fix=287, break=84 精确对账配对统计公式（diff=1.4583pp, se=0.1384pp, mde_2sigma=0.2767pp, z=10.539, chi2=111.075）
    const rowsA = [];
    const rowsB = [];
    for (let i = 0; i < 13920; i++) {
      let ca = 0;
      let cb = 0;
      if (i < 287) { ca = 0; cb = 1; }
      else if (i < 287 + 84) { ca = 1; cb = 0; }
      else if (i < 8000) { ca = 1; cb = 1; }
      else { ca = 0; cb = 0; }
      const itemId = 'q_' + Math.floor(i / 8);
      const rollout = i % 8;
      rowsA.push({ id: itemId, rollout, correct: ca });
      rowsB.push({ id: itemId, rollout, correct: cb });
    }
    const exact = ps.computePairedStats(rowsA, rowsB, { bootstrapIters: 200, seed: 42 });
    assert.equal(exact.ok, true);
    assert.equal(exact.n_pairs, 13920);
    assert.equal(exact.fix, 287);
    assert.equal(exact.break, 84);
    assert.equal(exact.delta_pp, 1.4583);
    assert.equal(exact.se_pp, 0.1384);
    assert.equal(exact.mde_2sigma_pp, 0.2767);
    assert.equal(exact.z, 10.539);
    assert.equal(exact.mcnemar_chi2, 111.075);

    // (2) CLI 实测合规子集幸存者偏差纠偏：
    //     前 50 题简单题（B 合规=1）：Arm A 80% (40/50)，Arm B 78% (39/50) → 真同题差值 = -2.0pp（净退步！）
    //     后 50 题困难题（B 合规=0）：Arm A 20% (10/50)，Arm B 20% (10/50) → 全量 Arm A = 50.0%
    //     若错误地拿「Arm B 合规准确率 78%」比「Arm A 全量 50%」，会幻觉出 +28.0pp 假阳性增益！
    const expDir = path.join(e2eWs, 'experiments', 'idea_01');
    fs.mkdirSync(expDir, { recursive: true });
    const armALines = [];
    const armBLines = [];
    for (let i = 0; i < 100; i++) {
      const id = 'item_' + String(i).padStart(3, '0');
      if (i < 50) {
        armALines.push(JSON.stringify({ id, correct: i < 40 ? 1 : 0 }));
        armBLines.push(JSON.stringify({ id, correct: i < 39 ? 1 : 0, format_ok: 1 }));
      } else {
        armALines.push(JSON.stringify({ id, correct: i < 60 ? 1 : 0 }));
        armBLines.push(JSON.stringify({ id, correct: i < 60 ? 1 : 0, format_ok: 0 }));
      }
    }
    fs.writeFileSync(path.join(expDir, 'armA.jsonl'), armALines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(expDir, 'armB.jsonl'), armBLines.join('\n') + '\n', 'utf8');

    const rStats = runCli(e2eWs, [
      'pilot-stats',
      'experiments/idea_01/armA.jsonl',
      'experiments/idea_01/armB.jsonl',
      '--compliant-field', 'format_ok',
      '--json',
    ]);
    assert.equal(rStats.rc, 0, 'pilot-stats CLI 应退 0：\n' + rStats.out);
    const stJson = JSON.parse(rStats.stdout);
    assert.equal(stJson.compliant_subset.compliance_rate_pp, 50);
    assert.equal(stJson.compliant_subset.paired.delta_pp, -2, '同题合规子集真实差值必须算为 -2.0pp');
    assert.equal(stJson.compliant_subset.naive_unpaired_delta_pp, 28, '应如实揭示未配对全量对比造成的 +28.0pp 假象');
    assert.equal(stJson.compliant_subset.selection_bias_pp, 30, '选择性偏差应精确量化为 +30.0pp');
  });

  t('S6b check-contract --record：拦空消融行（[D-9]）、CRLF/LF 同 sha12（[D-2]）、写 5 列 CHANGELOG.md、强校验 v1→v2 与 --re-record --reason', () => {
    const cDir = path.join(e2eWs, 'contract');
    fs.mkdirSync(cDir, { recursive: true });

    const buildContractLines = (verLabel, emptyAblation = false) => [
      '# Research Contract (idea_01.' + verLabel + ')',
      '',
      '## §0 元信息',
      '- **exp_id**: idea_01',
      '- **关联工单与裁决**: ideas/' + TOPIC + '/briefs/idea_01.md / ideas/' + TOPIC + '/verdict-idea_01.md (go)',
      '- **baseline**: baselines/b1',
      '- **数据集与 split**: ValSet (train_10k / val_1k, N=1000)',
      '- **冻结日期**: 2026-11-13',
      '',
      '## §1 Hypothesis（可证伪因果假设）',
      '当在优势计算层施加首末段不一致残差门控时，ValSet 同题配对准确率相对基线 78.40% 提升 >= +1.20pp（跨过 2σ = 0.60pp），且格式合规率退化 <= 1.0pp。',
      '',
      '## §2 四个实现锚点',
      '- **超参**: lr=1e-6, temperature=0.7, residual_alpha=0.5, rollouts=8（零额外网格搜索）',
      '- **metric 定义**: ValSet (N=1000) 同题配对准确率与首末段 fix/break 净差，严禁事后切换分母',
      '- **计算预算**: 单卡 A100 训练 40 steps（上限 <= 2.0 GPUh）',
      '- **代码对应**: trainer/advantage.py::compute_residual_gate(alpha=0.5)',
      '',
      '## §3 成功信号 S（上线前锁死）',
      '- **S1**: ValSet 同题配对增益 Δ >= +1.20pp（且配对 z >= 2.0）。',
      '- **S2**: 同题纠错比 fix/break >= 2.0，且 break 比例 <= 1.5%。',
      '',
      '## §4 失败信号 F（独立止损线）',
      '- **F1**: 前 15 步训练损失发散 > 2.5 或格式合规率跌破 <= 70.0% 时立即停机止损。',
      '- **F2**: 即使总分微涨 +0.3pp，若首末段 fix 计数变化 <= +5 条则判定残差机制未生效。',
      '',
      '## §5 必做消融（Ablation）',
      '| ablation | 预期看到什么 | 若看到相反结果说明什么 |',
      '|---|---|---|',
      emptyAblation
        ? '| A1 |   |   |'
        : '| A1: 随机 20% 样本施加同等权重 | 增益回落至噪声带内（|Δ| < 0.60pp） | 收益仅来自梯度方差放大而非首末段不一致信号 |',
      '',
      '## §6 防事后合理化条款',
      '严格按 §3 与 §4 对号入座，禁止事后剔除难例或更换分母。',
    ];

    // 1) 空消融占位行 | A1 |  |  | 必须被拒（[D-9]）
    const badCPath = path.join(cDir, 'idea_01_bad.v1.md');
    fs.writeFileSync(badCPath, buildContractLines('v1', true).join('\n') + '\n', 'utf8');
    assert.equal(runCli(e2eWs, ['check-contract', 'contract/idea_01_bad.v1.md']).rc, 1, '[D-9] 空消融表占位行必须退 1');

    // 2) CRLF 与 LF 内容必须算出逐字符一致的 sha12（[D-2]）
    const validV1Lines = buildContractLines('v1', false);
    const lfPath = path.join(cDir, 'idea_01.v1.md');
    const crlfPath = path.join(cDir, 'idea_01_crlf.v1.md');
    fs.writeFileSync(lfPath, validV1Lines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(crlfPath, validV1Lines.join('\r\n') + '\r\n', 'utf8');
    const cLf = wf.checkContractFile(lfPath, { rootDir: e2eWs });
    const cCrlf = wf.checkContractFile(crlfPath, { rootDir: e2eWs });
    assert.equal(cLf.ok, true, cLf.stderr);
    assert.equal(cCrlf.ok, true, cCrlf.stderr);
    assert.equal(cLf.sha12, cCrlf.sha12, '[D-2] CRLF 与 LF 契约必须算出相同 sha12');
    fs.rmSync(crlfPath, { force: true });
    fs.rmSync(badCPath, { force: true });

    // 3) 跳号直接登记 .v2.md（无 v1 在册）必须被拦退 1
    const v2Path = path.join(cDir, 'idea_01.v2.md');
    fs.writeFileSync(v2Path, buildContractLines('v2', false).join('\n') + '\n- 补充高温度消融 A2。\n', 'utf8');
    const rJumpV2 = runCli(e2eWs, ['check-contract', 'contract/idea_01.v2.md', '--record', '--reason', '跳号测试']);
    assert.equal(rJumpV2.rc, 1, '未登记 v1 前直接登记 v2 必须被拒退 1');

    // 4) 正常登记 v1 → 写入 5 列 CHANGELOG.md
    const rRecV1 = runCli(e2eWs, ['check-contract', 'contract/idea_01.v1.md', '--record']);
    assert.equal(rRecV1.rc, 0, '登记 v1 契约应退 0：\n' + rRecV1.out);
    const clAfterV1 = fs.readFileSync(path.join(cDir, 'CHANGELOG.md'), 'utf8');
    assert.ok(/\|\s*日期\s*\|\s*文件\s*\|\s*v1 → v2\s*\|\s*改了什么\s*\|\s*为什么\s*\|/.test(clAfterV1), 'CHANGELOG 表头必须为标准 5 列：\n' + clAfterV1);
    assert.ok(clAfterV1.includes('idea_01.v1.md') && clAfterV1.includes(cLf.sha12), 'CHANGELOG 应记录文件名与 sha12');

    // 5) 重复 --record 同版本无 --re-record 退 2；--re-record 缺 --reason 退 2
    assert.equal(runCli(e2eWs, ['check-contract', 'contract/idea_01.v1.md', '--record']).rc, 2);
    assert.equal(runCli(e2eWs, ['check-contract', 'contract/idea_01.v1.md', '--re-record']).rc, 2);

    // 6) v1 已在册后，带 --reason 登记 v2 成功退 0 且追加 v1 → v2 变更记录
    const rRecV2 = runCli(e2eWs, [
      'check-contract', 'contract/idea_01.v2.md',
      '--record',
      '--reason', '先导日志显示高温度下 KL 波动需单独增加 A2 消融受控',
    ]);
    assert.equal(rRecV2.rc, 0, 'v1 在册且附带 --reason 时登记 v2 应退 0：\n' + rRecV2.out);
    const clAfterV2 = fs.readFileSync(path.join(cDir, 'CHANGELOG.md'), 'utf8');
    assert.ok(clAfterV2.includes('v1 → v2') && clAfterV2.includes('先导日志显示高温度下 KL 波动需单独增加 A2 消融受控'), clAfterV2);
  });

  t('S6c [V2-BUG-1] 官方 TEMPLATE.CONTRACT.md 填值实测：拦截未填 <...> 占位符，放行 <= / >= / < / > / -> 数学比较', () => {
    const tplRaw = fs.readFileSync(path.join(SRC, 'examples', 'templates', 'TEMPLATE.CONTRACT.md'), 'utf8');
    const cDir = path.join(e2eWs, 'contract');

    // 1) 未填值的原样模板必须被拒并检出多节占位符
    const rawTplPath = path.join(cDir, 'raw_tpl.v1.md');
    fs.writeFileSync(rawTplPath, tplRaw, 'utf8');
    const rRaw = wf.checkContractFile(rawTplPath, { rootDir: e2eWs });
    assert.equal(rRaw.ok, false, '未填值的官方契约模板必须被拒');
    assert.equal(rRaw.rc, 1);
    assert.ok(rRaw.stderr.includes('exp_id') && rRaw.stderr.includes('Hypothesis') && rRaw.stderr.includes('失败信号'), rRaw.stderr);

    // 2) 按官方模板填妥所有 <...> 占位符，保留 F1 中的 `<= -1.5pp` ... `>= 3.0pp`、§1 中的 `< 0.35 ... > +1.5pp` 与 `->`
    const filledFromTpl = tplRaw
      .replace(/<exp_id>/g, 'exp_math_ineq')
      .replace(/<topic>/g, TOPIC)
      .replace(/<idea_id>/g, 'idea_01')
      .replace(/baselines\/<baseline_name>/g, 'baselines/b1')
      .replace(/<dataset_name> \(<train_split> \/ <eval_split>, N=<count>\)/g, 'ValSet (train_10k / val_1k, N=1000)')
      .replace(/YYYY-MM-DD/g, '2026-11-14')
      .replace(
        /当把 `<具体机制改动 X>`[\s\S]*?退化不超过 `<= Z\.Zpp`。/,
        '当熵阈值 < 0.35 时触发自适应门控路由（满足 loss<tau 且 p<0.05），主指标由 78.4% -> 80.2%（准确率增益 > +1.5pp，显著跨过配对噪声底 `2σ = 0.60pp`），且格式退化 `<= 1.0pp`。',
      )
      .replace(/<完整列出[^>]+>/g, 'lr=1e-6, temp=0.7, tau=0.35, rollouts=8（零额外网格搜索）')
      .replace(/<精确定义[^>]+>/g, 'ValSet (N=1000) 同题配对准确率与合规分母口径固定')
      .replace(/<训练步数[^>]+>/g, '单卡 A100 40 steps / <= 2.0 GPUh')
      .replace(/<精确到[^>]+>/g, 'trainer/advantage.py::compute_entropy_gate')
      .replace(/\+X\.Xpp/g, '+1.50pp')
      .replace(/<mechanism_metric>/g, 'fix_break_ratio')
      .replace(/\+A\.App/g, '+1.20pp')
      .replace(/B\.B/g, '2.0')
      .replace(/<M>/g, '200')
      .replace(/-X\.Xpp/g, '-1.5pp')
      .replace(/Y\.Ypp/g, '3.0pp')
      .replace(/<threshold>/g, '+0.15')
      .replace(/X\.Xpp/g, '1.0pp')
      .replace(/<一句话[^>]+>/g, '熵门控在同等预算下消除低置信样本的反向梯度污染');

    const filledPath = path.join(cDir, 'exp_math_ineq.v1.md');
    fs.writeFileSync(filledPath, filledFromTpl, 'utf8');
    const rFilled = runCli(e2eWs, ['check-contract', 'contract/exp_math_ineq.v1.md']);
    assert.equal(rFilled.rc, 0, '[V2-BUG-1] 按官方模板填妥后含 `<= -1.5pp` ... `>= 3.0pp` 与 `< 0.35 ... > +1.5pp` 的契约必须退 0：\n' + rFilled.out);
    fs.rmSync(rawTplPath, { force: true });
  });

  t('S6d [V2-BUG-2] init 生成的 dsh 座位（optional_args 及缺省 patch_env）完整透传模型覆盖补丁并合并相对 DSH_PATCH', () => {
    const dshWs = mkTmp('dsh-patch-override');
    assert.equal(runCli(dshWs, ['init', '--topic', 'dshcheck']).rc, 0);

    // 在临时 bin 目录安装跨平台假 dsh CLI（记录每次调用的 argv、cwd、--patch 文件正文与 DSH_SETTINGS 正文）
    const fakeBinDir = path.join(dshWs, '.fake-bin');
    const logDir = path.join(dshWs, '.dsh-invocations');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });

    const mockDshMjs = path.join(fakeBinDir, 'mock-dsh.mjs');
    fs.writeFileSync(mockDshMjs, [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const args = process.argv.slice(2);',
      'const patchIndices = [];',
      'args.forEach((a, idx) => { if (a === "--patch") patchIndices.push(idx); });',
      'const patchArg = patchIndices.length > 0 ? args[patchIndices[0] + 1] : "";',
      'const patchBody = (patchArg && fs.existsSync(patchArg)) ? fs.readFileSync(patchArg, "utf8") : null;',
      'const settingsFile = process.env.DSH_SETTINGS || "";',
      'const settingsBody = (settingsFile && fs.existsSync(settingsFile)) ? fs.readFileSync(settingsFile, "utf8") : null;',
      'const recFile = path.join(' + JSON.stringify(logDir) + ', "call-" + Date.now() + "-" + process.pid + "-" + Math.random().toString(36).slice(2, 6) + ".json");',
      'fs.writeFileSync(recFile, JSON.stringify({ args, patchCount: patchIndices.length, patchArg, patchBody, settingsFile, settingsBody }), "utf8");',
      'process.stdout.write(' + JSON.stringify(validReviewCard('idea_dsh', 'go')) + ');',
    ].join('\n'), 'utf8');

    // 同时放置无扩展名 sh 脚本（供 Git Bash command -v 命中）与 Windows .cmd 包装器（供无 Bash 纯 cmd 命中）
    const posixShim = path.join(fakeBinDir, 'dsh');
    fs.writeFileSync(posixShim, '#!/usr/bin/env sh\nexec "' + process.execPath.replace(/\\/g, '/') + '" "' + mockDshMjs.replace(/\\/g, '/') + '" "$@"\n', { mode: 0o755 });
    if (process.platform === 'win32') {
      fs.writeFileSync(
        path.join(fakeBinDir, 'dsh.cmd'),
        '@"' + process.execPath + '" "' + mockDshMjs + '" %*\r\n',
        'utf8',
      );
    }

    fs.mkdirSync(path.join(dshWs, 'ideas', 'dshcheck', 'briefs'), { recursive: true });
    const briefRel = 'ideas/dshcheck/briefs/idea_dsh.md';
    fs.writeFileSync(path.join(dshWs, briefRel), [
      '<!-- meta role=brief idea=idea_dsh anchor=none -->',
      '### Baseline',
      'Acc = 60.0% (2σ = 1.0pp)',
      '### Idea',
      '**ID**: idea_dsh',
      '测试 init 模板 dsh 多票补丁透传与 base patch 合并。',
    ].join('\n'), 'utf8');

    const pathSep = process.platform === 'win32' ? ';' : ':';
    const pathWithDsh = fakeBinDir + pathSep + (process.env.PATH || process.env.Path || '');

    // 场景 A：init 原生 seats.json（无 DSH_PATCH）下跑同座双票 dsh:jiyuan/glm-5.3,dsh:qoder/deepseek-v4
    assert.equal(runCli(dshWs, ['lineup', '--review', 'dsh:jiyuan/glm-5.3,dsh:qoder/deepseek-v4']).rc, 0);
    const rRunA = runCli(dshWs, ['run', briefRel], { PATH: pathWithDsh, Path: pathWithDsh });
    assert.equal(rRunA.rc, 0, 'init 模板下 dsh 同座双模型出票应退 0：\n' + rRunA.out);

    const callsA = fs.readdirSync(logDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf8')));
    assert.equal(callsA.length, 2, '应触发 2 次独立 dsh 调用');
    for (const c of callsA) {
      assert.equal(c.patchCount, 1, '每次 dsh 调用必须恰好携带 1 次 --patch：' + JSON.stringify(c.args));
      assert.ok(c.patchBody && c.patchBody.includes('agent-default-model'), '传给 dsh 的 --patch 文件必须包含 agent-default-model 覆盖块');
      assert.ok(c.settingsBody && c.settingsBody.includes('agent-default-model:'), '必须同步注入隔离的 DSH_SETTINGS');
    }
    assert.ok(callsA.some((c) => c.patchBody.includes('provider: "jiyuan"') && c.patchBody.includes('model: "glm-5.3"')));
    assert.ok(callsA.some((c) => c.patchBody.includes('provider: "qoder"') && c.patchBody.includes('model: "deepseek-v4"')));

    // 场景 B：删掉 seat.patch_env（模拟旧版纯 optional_args 配置）+ 传入相对路径 DSH_PATCH=dispatch/dsh-review.patch.yml
    for (const f of fs.readdirSync(logDir)) fs.rmSync(path.join(logDir, f), { force: true });
    fs.rmSync(path.join(dshWs, 'ideas', 'dshcheck', 'cards'), { recursive: true, force: true });

    const basePatchRel = 'dispatch/dsh-review.patch.yml';
    fs.writeFileSync(path.join(dshWs, basePatchRel), '- id: agent-instructions\n  disabled: true\n', 'utf8');

    const seatsPath = path.join(dshWs, 'dispatch', 'seats.json');
    const seatsJson = JSON.parse(fs.readFileSync(seatsPath, 'utf8'));
    const dshSeat = seatsJson.seats.find((s) => s.id === 'dsh');
    delete dshSeat.patch_env;
    fs.writeFileSync(seatsPath, JSON.stringify(seatsJson, null, 2) + '\n', 'utf8');

    assert.equal(runCli(dshWs, ['lineup', '--review', 'dsh:jiyuan/glm-5.3']).rc, 0);
    const rRunB = runCli(dshWs, ['run', briefRel], {
      PATH: pathWithDsh,
      Path: pathWithDsh,
      DSH_PATCH: basePatchRel,
    });
    assert.equal(rRunB.rc, 0, '带相对 DSH_PATCH 的 dsh:provider/model 应退 0：\n' + rRunB.out);

    const callsB = fs.readdirSync(logDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf8')));
    assert.equal(callsB.length, 1);
    assert.equal(callsB[0].patchCount, 1, 'optional_args 模式下不得丢失或重复 --patch');
    assert.ok(
      callsB[0].patchBody
      && callsB[0].patchBody.includes('agent-instructions')
      && callsB[0].patchBody.includes('provider: "jiyuan"')
      && callsB[0].patchBody.includes('model: "glm-5.3"'),
      '[V2-BUG-2] 生成的覆盖补丁必须合并用户相对 DSH_PATCH 与模型覆盖：\n' + callsB[0].patchBody,
    );

    // 场景 C：母仓 {patch} 占位符风格座位同样只传 1 次 --patch 且合并 patch_default
    for (const f of fs.readdirSync(logDir)) fs.rmSync(path.join(logDir, f), { force: true });
    fs.rmSync(path.join(dshWs, 'ideas', 'dshcheck', 'cards'), { recursive: true, force: true });
    const seatsJsonC = JSON.parse(fs.readFileSync(seatsPath, 'utf8'));
    const dshSeatC = seatsJsonC.seats.find((s) => s.id === 'dsh');
    dshSeatC.argv = ['--profile', 'headless', '--patch', '{patch}', '{payload}'];
    delete dshSeatC.optional_args;
    dshSeatC.patch_env = 'DSH_PATCH';
    dshSeatC.patch_default = basePatchRel;
    fs.writeFileSync(seatsPath, JSON.stringify(seatsJsonC, null, 2) + '\n', 'utf8');

    const rRunC = runCli(dshWs, ['run', briefRel], { PATH: pathWithDsh, Path: pathWithDsh });
    assert.equal(rRunC.rc, 0, '{patch} 占位符风格座位应退 0：\n' + rRunC.out);
    const callsC = fs.readdirSync(logDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf8')));
    assert.equal(callsC.length, 1);
    assert.equal(callsC[0].patchCount, 1, '{patch} 风格座位不得重复追加 --patch');
    assert.ok(callsC[0].patchBody.includes('agent-instructions') && callsC[0].patchBody.includes('model: "glm-5.3"'));
  });

  t('S7a [Polish-A/C] init 脚手架模板契约：scout 强制 LaTeX/Markdown 优先于 PDF，reviewer 明确五维 1-5 正向极性（impl_cost=5 轻量省算力）', () => {
    const scoutMd = fs.readFileSync(path.join(e2eWs, 'roles', 'scout.md'), 'utf8');
    assert.ok(
      scoutMd.includes('LaTeX') && scoutMd.includes('Markdown') && scoutMd.includes('PDF'),
      'roles/scout.md 必须明确 arXiv LaTeX / HTML / Markdown 优先、无源码才回退 PDF 的获取规则',
    );
    assert.ok(
      /回退.*PDF|才.*PDF/.test(scoutMd),
      'roles/scout.md 必须限定 PDF 仅作为无 LaTeX/HTML/Markdown 时的回退手段',
    );

    const revInit = fs.readFileSync(path.join(e2eWs, 'roles', 'reviewer.md'), 'utf8');
    const revRolesTpl = fs.readFileSync(path.join(SRC, 'examples', 'roles', 'reviewer.md'), 'utf8');
    const revLegacyTpl = fs.readFileSync(path.join(SRC, 'examples', 'reviewer.md'), 'utf8');
    assert.equal(revInit, revRolesTpl, 'init 写出的 roles/reviewer.md 必须与 examples/roles/reviewer.md 一致');
    assert.equal(revRolesTpl, revLegacyTpl, 'examples/roles/reviewer.md 与 examples/reviewer.md 必须保持零漂移同步');
    assert.ok(
      revInit.includes('25') && /impl_cost[\s\S]*5\s*=.*轻量/.test(revInit) && /1\s*=.*侵入/.test(revInit),
      'roles/reviewer.md 必须明确五维统一正向计分（满分 25）及 impl_cost 正向极性（5=轻量省算力，1=侵入重昂贵）',
    );

    const agentsInit = fs.readFileSync(path.join(e2eWs, 'AGENTS.md'), 'utf8');
    const skillInit = fs.readFileSync(path.join(e2eWs, 'skills', 'research-flow', 'SKILL.md'), 'utf8');
    assert.ok(agentsInit.includes('--no-dead-ends') && agentsInit.includes('--sort rank|id'), 'AGENTS.md 模板必须同步 --no-dead-ends 与 --sort rank|id');
    assert.ok(skillInit.includes('--no-dead-ends') && skillInit.includes('25'), 'SKILL.md 必须同步 --no-dead-ends 与 /25 正向总均分');
  });

  t('S7b [Polish-B] diverge 默认 10 条 + --no-dead-ends 纯空白发散模式：即使存在课题与全局 dead-ends.md 也零注入、不写 dead_ends_sha，且与 --dead-ends 互斥', () => {
    const blankWs = mkTmp('blank-diverge');
    const bTopic = 'blank-exp';
    assert.equal(runCli(blankWs, ['init', '--topic', bTopic]).rc, 0);

    // 准备文献池 _pool.md（模拟前期调研结果）
    const poolDir = path.join(blankWs, 'papers', 'cards');
    fs.mkdirSync(poolDir, { recursive: true });
    fs.writeFileSync(path.join(poolDir, '_pool.md'), [
      '<!-- _pool assembled by research-dispatch · valid=1/1 -->',
      '```yaml',
      'paper_id: "clean-survey-2026"',
      'title: "Pure Survey Context Without Historical Anchor"',
      'venue: "ICML"',
      'code_url: "none"',
      'abstract_zh: "仅提供纯粹调研事实供空白发散。"',
      'intro_key: "避免历史死胡同讨论锚定模型思维。"',
      'relevance: "核心调研对照。"',
      '```',
      '',
    ].join('\n'), 'utf8');

    // 同时写入课题级与全局级 dead-ends.md（带哨兵标记），验证 --no-dead-ends 完全跳过两者
    fs.writeFileSync(
      path.join(blankWs, 'ideas', bTopic, 'dead-ends.md'),
      '# 课题负知识\n- TOPIC_DEAD_END_SENTINEL_991：禁止使用某某旧路线\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(blankWs, 'ideas', 'dead-ends.md'),
      '# 全局负知识\n- GLOBAL_DEAD_END_SENTINEL_882：全局历史否决讨论\n',
      'utf8',
    );

    // 1) 同时传 --dead-ends 与 --no-dead-ends 必须立即报错退 1
    const rConflict = runCli(blankWs, [
      'diverge', '空白模式互斥校验',
      '--topic', bTopic,
      '--dead-ends', 'ideas/dead-ends.md',
      '--no-dead-ends',
    ]);
    assert.equal(rConflict.rc, 1, '--dead-ends 与 --no-dead-ends 冲突时必须退 1：\n' + rConflict.out);

    // 2) 不传条数参数 + 传 --no-dead-ends：默认请求 10 条，且 Prompt 零死胡同内容注入
    const blankProbe = path.join(blankWs, 'blank-probe.json');
    const mockBlankDiverger = path.join(blankWs, 'mock-blank-diverger.mjs');
    fs.writeFileSync(mockBlankDiverger, [
      'import fs from "node:fs";',
      'const pIdx = process.argv.indexOf("-p");',
      'const prompt = pIdx >= 0 ? process.argv[pIdx + 1] : fs.readFileSync(0, "utf8");',
      'fs.writeFileSync(' + JSON.stringify(blankProbe) + ', JSON.stringify({ prompt }), "utf8");',
      'process.stdout.write([',
      '  "### idea_01 零锚定纯空白机制候选",',
      '  "- 假设：直接在隐空间做正交投影可消除跨步冗余。",',
      '  "- 做法：在残差连接前插入无参数 Householder 正交化层，其余超参不变。",',
      '  "- 最小证伪实验：单卡跑 30 步对比正交前后梯度余弦相似度与验证准确率。",',
      '  "- 预测：验证集准确率提升 +1.80pp。",',
      '  "- 主读数：acc +1.80pp",',
      '  "- 判据：2σ=0.60pp",',
      '  "- 若失败说明什么：若增益 < +0.60pp 说明冗余不在正交方向。",',
      '].join("\\n"));',
    ].join('\n'), 'utf8');

    const cfg = JSON.parse(fs.readFileSync(path.join(blankWs, 'dispatch', 'seats.json'), 'utf8'));
    const claudeSeat = cfg.seats.find((s) => s.id === 'claude');
    claudeSeat.command = process.execPath;
    claudeSeat.argv = [mockBlankDiverger, '-p', '{payload}', '{optional_args}'];
    claudeSeat.enabled = true;
    fs.writeFileSync(path.join(blankWs, 'dispatch', 'seats.json'), JSON.stringify(cfg, null, 2), 'utf8');

    const rBlank = runCli(blankWs, [
      'diverge', '零历史锚定空白探索方向',
      '--topic', bTopic,
      '--no-baseline',
      '--no-dead-ends',
      '--agent', 'claude:claude-sonnet-4-5',
    ]);
    assert.equal(rBlank.rc, 0, '--no-dead-ends 纯空白发散应退 0：\n' + rBlank.out);
    assert.ok(rBlank.out.includes('--no-dead-ends'), '日志应明确提示启用了 --no-dead-ends 纯空白发散模式');

    const { prompt: receivedPrompt } = JSON.parse(fs.readFileSync(blankProbe, 'utf8'));
    assert.ok(receivedPrompt.includes('产出条数：10'), '省略条数参数时默认发散条数必须为 10：\n' + receivedPrompt);
    assert.ok(receivedPrompt.includes('clean-survey-2026'), '空白发散必须正常包含文献池调研内容');
    assert.ok(!receivedPrompt.includes('TOPIC_DEAD_END_SENTINEL_991'), '--no-dead-ends 严禁注入课题 dead-ends.md');
    assert.ok(!receivedPrompt.includes('GLOBAL_DEAD_END_SENTINEL_882'), '--no-dead-ends 严禁回退注入全局 dead-ends.md');
    assert.ok(!receivedPrompt.includes('已证伪机制与禁入死胡同'), '--no-dead-ends 严禁拼入死胡同章节标题');

    const rawFiles = fs.readdirSync(path.join(blankWs, 'ideas', bTopic)).filter((f) => f.startsWith('raw-') && f.endsWith('.md'));
    assert.equal(rawFiles.length, 1);
    const metaLine = fs.readFileSync(path.join(blankWs, 'ideas', bTopic, rawFiles[0]), 'utf8').split('\n')[0];
    assert.ok(metaLine.includes('requested=10'), 'raw 池 meta 必须记录默认 requested=10：' + metaLine);
    assert.ok(!metaLine.includes('dead_ends_sha='), '--no-dead-ends 产物 meta 不得含 dead_ends_sha：' + metaLine);
  });

  t('S7c [Polish-C] summary 五维正向总分(/25)汇总与自动降序 Ranking：默认 --sort rank 排 #1..#K，UNRUN/校准单置尾不占名次，支持 --sort id', () => {
    const rankWs = mkTmp('summary-rank');
    const rTopic = 'rank-exp';
    assert.equal(runCli(rankWs, ['init', '--topic', rTopic]).rc, 0);

    const briefsDir = path.join(rankWs, 'ideas', rTopic, 'briefs');
    const cardsDir = path.join(rankWs, 'ideas', rTopic, 'cards');
    fs.mkdirSync(briefsDir, { recursive: true });
    fs.mkdirSync(cardsDir, { recursive: true });

    const briefShaOf = (id) => {
      const txt = fs.readFileSync(path.join(briefsDir, id + '.md'), 'utf8').replace(/\r\n/g, '\n');
      return crypto.createHash('sha256').update(txt, 'utf8').digest('hex').slice(0, 12);
    };

    const writeScoredVote = (id, seatTag, model, verdict, scores5d, conf) => {
      const [nov, fea, fit, cost, gain] = scores5d;
      const body = [
        '<!-- meta role=reviewer seat=' + seatTag + ' model=' + model + ' sha=' + briefShaOf(id) + ' -->',
        '```yaml',
        'idea_id: ' + id,
        'novelty: {score: ' + nov + ', reason: "新颖度评估"}',
        'feasibility: {score: ' + fea + ', reason: "可行性评估"}',
        'baseline_fit: {score: ' + fit + ', reason: "基线契合度"}',
        'impl_cost: {score: ' + cost + ', reason: "正向经济性评分"}',
        'expected_gain: {score: ' + gain + ', reason: "预期增益"}',
        'verdict: ' + verdict,
        'kill_reason: ' + (verdict === 'kill' ? '"致命缺陷"' : 'null'),
        'confidence: ' + conf,
        'missing_info: []',
        '```',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(cardsDir, id + '.' + seatTag + '.md'), body, 'utf8');
    };

    const writeManifest = (id, seatsSpec) => {
      const seatTags = String(seatsSpec).split(',').map((s) => s.split('=')[0].trim()).filter(Boolean).join(' ');
      fs.writeFileSync(path.join(cardsDir, id + '.manifest'), [
        '<!-- manifest schema=2 idea=' + id + ' sha=' + briefShaOf(id) + ' status=OK -->',
        'status: OK',
        'votes: ' + seatTags,
        'seats: ' + seatsSpec,
        '',
      ].join('\n'), 'utf8');
    };

    for (const id of ['idea_01', 'idea_02', 'idea_03', 'idea_04', 'smoke_01']) {
      fs.writeFileSync(path.join(briefsDir, id + '.md'), '<!-- meta role=brief idea=' + id + ' anchor=none -->\n### Idea\n' + id + '\n', 'utf8');
    }

    // idea_01：1 go (20/25) + 1 kill (10/25) → avgTotal25 = 15.00 → 应排 #3
    writeScoredVote('idea_01', 'codex', 'gpt-5', 'go', [4, 4, 4, 4, 4], 0.80);
    writeScoredVote('idea_01', 'claude', 'claude-sonnet-4-5', 'kill', [2, 2, 2, 2, 2], 0.80);
    writeManifest('idea_01', 'codex=gpt-5,claude=claude-sonnet-4-5');

    // idea_02：2 go (19/25 + 19/25) → avgTotal25 = 19.00 → 应排 #2（同为 2 go，总均分低于 idea_03）
    writeScoredVote('idea_02', 'codex', 'gpt-5', 'go', [4, 4, 4, 3, 4], 0.85);
    writeScoredVote('idea_02', 'claude', 'claude-sonnet-4-5', 'go', [4, 4, 4, 3, 4], 0.85);
    writeManifest('idea_02', 'codex=gpt-5,claude=claude-sonnet-4-5');

    // idea_03：2 go (23/25 + 22/25) → avgTotal25 = 22.50 (avg5d = 4.50) → 应排 #1！
    writeScoredVote('idea_03', 'codex', 'gpt-5', 'go', [5, 5, 4, 5, 4], 0.90);
    writeScoredVote('idea_03', 'claude', 'claude-sonnet-4-5', 'go', [5, 4, 4, 5, 4], 0.90);
    writeManifest('idea_03', 'codex=gpt-5,claude=claude-sonnet-4-5');

    // idea_04：仅工单未跑盲审（UNRUN）→ rank=null，置尾显示 —
    // smoke_01：校准单即使满分 25/25 也不参与正式候选排名（rank=null，置尾显示 —）
    writeScoredVote('smoke_01', 'codex', 'gpt-5', 'go', [5, 5, 5, 5, 5], 0.99);
    writeScoredVote('smoke_01', 'claude', 'claude-sonnet-4-5', 'go', [5, 5, 5, 5, 5], 0.99);
    writeManifest('smoke_01', 'codex=gpt-5,claude=claude-sonnet-4-5');

    // 顺带验证 Markdown 加粗列表人工裁决 `- **决定**: **go**` 能被 summary 识别
    fs.writeFileSync(path.join(rankWs, 'ideas', rTopic, 'verdict-idea_03.md'), '# 裁决\n- **决定**: **go**\n', 'utf8');

    // 1) 编程接口核查：默认 sortBy='rank'
    const sumObj = val.summarizeTopic(rankWs, { topic: rTopic, writeFile: false });
    assert.equal(sumObj.ok, true);
    assert.equal(sumObj.sortBy, 'rank');
    assert.deepEqual(
      sumObj.items.map((it) => it.id),
      ['idea_03', 'idea_02', 'idea_01', 'idea_04', 'smoke_01'],
      '默认应按五维 /25 均分降序为主序（平分按 go 降序 → kill 升序）排定正式工单，UNRUN 与校准单置尾',
    );
    assert.equal(sumObj.items[0].rank, 1);
    assert.equal(sumObj.items[0].avgTotal25, 22.5);
    assert.equal(sumObj.items[0].avg5d, 4.5);
    assert.equal(sumObj.items[0].humanVerdict, 'go');
    assert.equal(sumObj.items[1].rank, 2);
    assert.equal(sumObj.items[1].avgTotal25, 19);
    assert.equal(sumObj.items[2].rank, 3);
    assert.equal(sumObj.items[2].avgTotal25, 15);
    assert.equal(sumObj.items[3].rank, null, 'UNRUN 工单不得分配名次');
    assert.equal(sumObj.items[4].rank, null, 'smoke_* 校准工单不得抢占正式候选名次');

    // 2) CLI 默认 `summary --topic rank-exp` 落盘核查
    const rSumRank = runCli(rankWs, ['summary', '--topic', rTopic]);
    assert.equal(rSumRank.rc, 0, rSumRank.out);
    const mdRank = fs.readFileSync(path.join(rankWs, 'ideas', rTopic, '_summary.md'), 'utf8');
    const idx3 = mdRank.indexOf('| #1 | `idea_03` |');
    const idx2 = mdRank.indexOf('| #2 | `idea_02` |');
    const idx1 = mdRank.indexOf('| #3 | `idea_01` |');
    const idx4 = mdRank.indexOf('| — | `idea_04` |');
    const idxSmoke = mdRank.indexOf('| — | `smoke_01` |');
    assert.ok(idx3 > 0 && idx2 > idx3 && idx1 > idx2 && idx4 > idx1 && idxSmoke > idx1, '落盘 _summary.md 行顺序必须严格为 #1 → #2 → #3 → 未排项：\n' + mdRank);
    assert.ok(mdRank.includes('22.50') && mdRank.includes('19.00') && mdRank.includes('15.00'), '_summary.md 必须输出 /25 五维总均分');

    // 3) CLI `--sort id` 切换为工单编号自然序，同时保留各自名次与 /25 均分
    const rSumId = runCli(rankWs, ['summary', '--topic', rTopic, '--sort', 'id']);
    assert.equal(rSumId.rc, 0, rSumId.out);
    const mdId = fs.readFileSync(path.join(rankWs, 'ideas', rTopic, '_summary.md'), 'utf8');
    const idPos1 = mdId.indexOf('| #3 | `idea_01` |');
    const idPos2 = mdId.indexOf('| #2 | `idea_02` |');
    const idPos3 = mdId.indexOf('| #1 | `idea_03` |');
    const idPos4 = mdId.indexOf('| — | `idea_04` |');
    assert.ok(idPos1 > 0 && idPos2 > idPos1 && idPos3 > idPos2 && idPos4 > idPos3, '--sort id 应按编号自然序排列且保留各自 #名次：\n' + mdId);

    // 4) 非法 --sort 参数必须退 1
    const rBadSort = runCli(rankWs, ['summary', '--topic', rTopic, '--sort', 'bogus']);
    assert.equal(rBadSort.rc, 1, '非法 --sort 值必须退 1');
  });

  t('S8 [v2.1.0] 四阶段 lineup 编排 + stages/stage-exec/stage-model + scout & novelty CLI 全闭环', () => {
    const v21Ws = mkTmp('v21-cli-loop');
    const v21Topic = 'v21-loop';

    // 1) init 创建 papers/novelty 目录
    const rInit = runCli(v21Ws, ['init', '--topic', v21Topic]);
    assert.equal(rInit.rc, 0, rInit.out);
    assert.ok(fs.existsSync(path.join(v21Ws, 'papers', 'novelty')), 'init 应创建 papers/novelty 目录');

    // 互斥参数拦截
    const rConflict = runCli(v21Ws, ['lineup', '--use-dead-ends', '--no-dead-ends']);
    assert.equal(rConflict.rc, 1, '--use-dead-ends 与 --no-dead-ends 同时指定应退 1');

    // 2) 四阶段 lineup 一次性写入 scout / diverge(count=8, no-dead-ends) / review / novelty
    const rLineup = runCli(v21Ws, [
      'lineup',
      '--scout', 'agy:gemini-4-carbon-high',
      '--diverge', 'codex:gpt-5',
      '--diverge-count', '8',
      '--no-dead-ends',
      '--review', 'codex:gpt-5,claude:claude-sonnet-4-5',
      '--novelty', 'claude:claude-sonnet-4-5',
      '--json',
    ]);
    assert.equal(rLineup.rc, 0, rLineup.out);
    const luJson = JSON.parse(rLineup.stdout);
    assert.deepEqual(luJson.lineup.scout, { seat: 'agy', model: 'gemini-4-carbon-high' });
    assert.deepEqual(luJson.lineup.diverge, { seat: 'codex', model: 'gpt-5', count: 8, use_dead_ends: false });
    assert.deepEqual(luJson.lineup.novelty, { seat: 'claude', model: 'claude-sonnet-4-5' });

    // 3) stages / stage-exec / stage-model 四阶段全对齐
    const rStages = runCli(v21Ws, ['stages']);
    assert.equal(rStages.rc, 0, rStages.out);
    const stagesArr = JSON.parse(rStages.stdout);
    assert.deepEqual(stagesArr.map((s) => s.stage), ['scout', 'diverge', 'review', 'novelty']);
    assert.equal(runCli(v21Ws, ['stage-exec', 'scout']).stdout.trim(), 'agy');
    assert.equal(runCli(v21Ws, ['stage-model', 'scout']).stdout.trim(), 'gemini-4-carbon-high');
    assert.equal(runCli(v21Ws, ['stage-exec', 'diverge']).stdout.trim(), 'codex');
    assert.equal(runCli(v21Ws, ['stage-model', 'diverge']).stdout.trim(), 'gpt-5');
    assert.equal(runCli(v21Ws, ['stage-exec', 'review']).stdout.trim(), 'codex,claude');
    assert.equal(runCli(v21Ws, ['stage-exec', 'novelty']).stdout.trim(), 'claude');
    assert.equal(runCli(v21Ws, ['stage-model', 'novelty']).stdout.trim(), 'claude-sonnet-4-5');

    // 4) 挂载本地无联网 Mock CLI 实跑 scout → diverge(继承 count=8 & no-dead-ends) → briefs → novelty
    const mockWorker = path.join(v21Ws, 'mock-v21-worker.mjs');
    fs.writeFileSync(mockWorker, [
      'import fs from "node:fs";',
      'const role = process.env.V21_MOCK_ROLE || "";',
      'if (role === "scout") {',
      '  process.stdout.write([',
      '    "=== CARD: latex-first-2026.md ===",',
      '    "```yaml",',
      '    "paper_id: latex-first-2026",',
      '    "title: \\"LaTeX Source Priority for Literature Grounding\\"",',
      '    "venue: ICLR",',
      '    "code_url: https://github.com/example/latex-first",',
      '    "abstract_zh: \\"利用 arXiv e-print 源码抽取精确公式锚点，避免双栏 PDF 断行失真。\\"",',
      '    "intro_key: \\"PDF OCR 会破坏上下标与表格对齐。\\"",',
      '    "relevance: \\"为本轮 S0 自动建卡提供高质量文献底座。\\"",',
      '    "```",',
      '  ].join("\\n"));',
      '} else if (role === "diverge") {',
      '  process.stdout.write([',
      '    "### idea_01 基于源码锚点的验证段门控",',
      '    "- 假设：在配对验证段引入源码级结构门控可将 ValSet 准确率提升 +1.40pp。",',
      '    "- 做法：保持主干与采样超参不变，仅替换验证段门控权重计算。",',
      '    "- 最小证伪实验：单卡 40 步先导对比测量同题配对增益。",',
      '    "- 预测：ValSet 准确率从 78.00% 升至 79.40%（+1.40pp）。",',
      '    "- 主读数：acc +1.40pp",',
      '    "- 判据：2σ=0.60pp",',
      '    "- 若失败说明什么：配对增益 < 0.60pp 说明门控未捕获有效信号。",',
      '  ].join("\\n"));',
      '} else if (role === "novelty") {',
      '  process.stdout.write([',
      '    "```yaml",',
      '    "idea_id: \\"idea_01\\"",',
      '    "duplication_risk: low",',
      '    "closest_works:",',
      '    "  - title: \\"LaTeX Source Priority for Literature Grounding\\"",',
      '    "    venue: \\"ICLR\\"",',
      '    "    year: 2026",',
      '    "    url: \\"https://arxiv.org/abs/2601.12345\\"",',
      '    "    overlap: \\"同属结构化锚点方向\\"",',
      '    "    difference: \\"该文面向文献解析，未涉及 RL 验证段配对门控\\"",',
      '    "polish: \\"在契约中锁定配对 2σ=0.60pp 门槛\\"",',
      '    "note: \\"经 arXiv 与 Semantic Scholar 检索确认低撞车风险。\\"",',
      '    "confidence: 0.88",',
      '    "```",',
      '  ].join("\\n"));',
      '}',
    ].join('\n'), 'utf8');

    const cfg = JSON.parse(fs.readFileSync(path.join(v21Ws, 'dispatch', 'seats.json'), 'utf8'));
    for (const id of ['agy', 'codex', 'claude']) {
      const s = cfg.seats.find((x) => x.id === id);
      s.command = process.execPath;
      s.argv = [mockWorker, '-p', '{payload}'];
      s.payload_position = 'argv';
      s.output = 'stdout';
      s.enabled = true;
    }
    fs.writeFileSync(path.join(v21Ws, 'dispatch', 'seats.json'), JSON.stringify(cfg, null, 2), 'utf8');

    // 准备已签字 baseline 与一个故意放入的 dead-ends.md（验证 lineup no-dead-ends 生效）
    const bDir = path.join(v21Ws, 'baselines', 'b1');
    fs.mkdirSync(bDir, { recursive: true });
    fs.writeFileSync(path.join(bDir, 'BRIEF_BLOCK.md'), [
      '### Baseline 锚点（baselines/b1）',
      '- 模型与数据集：Qwen-Math-1.5B on ValSet (N=1000, 8 rollouts/item)',
      '- 已验收主指标：acc = 78.00%（配对标准误 ±0.30%，2σ = 0.60pp，详见 REPRO.md §3）',
      '- 训练预算与控制条件：单卡 A100 训练 40 steps，lr=1e-6，temperature=0.7，seed=42，严禁修改评测分母或采样轮数。',
    ].join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(bDir, 'REPRO.md'), '## 3. 关键指标\n| metric | 论文报告 | 我复现 | 容差 | 判定 |\n|---|---|---|---|---|\n| acc | 78.0 | 78.0 | ±0.3 | ok |\n## 4. 人验收签字\nSIGNOFF: PASS\n', 'utf8');
    fs.writeFileSync(path.join(v21Ws, 'ideas', v21Topic, 'dead-ends.md'), '- DEAD_END_IGNORED_BY_LINEUP\n', 'utf8');

    const rScout = runCli(v21Ws, ['scout', 'LaTeX source priority', '1', '--pool'], { V21_MOCK_ROLE: 'scout' });
    assert.equal(rScout.rc, 0, 'scout --pool 应退 0：\n' + rScout.out);
    assert.ok(fs.existsSync(path.join(v21Ws, 'papers', 'cards', 'latex-first-2026.md')));
    assert.ok(fs.existsSync(path.join(v21Ws, 'papers', 'cards', '_pool.md')));

    const rDiv = runCli(v21Ws, ['diverge', '结构化锚点配对门控', '--topic', v21Topic, '--baseline', 'baselines/b1'], { V21_MOCK_ROLE: 'diverge' });
    assert.equal(rDiv.rc, 0, 'diverge 应退 0：\n' + rDiv.out);
    const rawFile = fs.readdirSync(path.join(v21Ws, 'ideas', v21Topic)).find((f) => f.startsWith('raw-') && f.endsWith('.md'));
    const rawHead = fs.readFileSync(path.join(v21Ws, 'ideas', v21Topic, rawFile), 'utf8').split('\n')[0];
    assert.ok(rawHead.includes('requested=8') && !rawHead.includes('dead_ends_sha='), '应继承 lineup 的 count=8 与 no-dead-ends：' + rawHead);

    const rBriefs = runCli(v21Ws, ['briefs', 'ideas/' + v21Topic + '/' + rawFile, '--topic', v21Topic, '--baseline', 'baselines/b1']);
    assert.equal(rBriefs.rc, 0, rBriefs.out);

    const rNov = runCli(v21Ws, ['novelty', 'idea_01', '--topic', v21Topic], { V21_MOCK_ROLE: 'novelty' });
    assert.equal(rNov.rc, 0, 'novelty idea_01 应退 0：\n' + rNov.out);
    assert.ok(fs.existsSync(path.join(v21Ws, 'papers', 'novelty', 'idea_01.md')));
    assert.equal(runCli(v21Ws, ['check-novelty', 'papers/novelty/idea_01.md']).rc, 0);

    // v2.2.0 遥测账本与 /swarm 拓扑快照聚合闭环校验
    const ledger = tel.readTelemetryLedger(v21Ws);
    assert.ok(Array.isArray(ledger.runs) && ledger.runs.length >= 3, 'scout / diverge / novelty 均应落盘遥测账本记录');
    const stagesSeen = new Set(ledger.runs.map((r) => r.stage));
    assert.ok(stagesSeen.has('S0') && stagesSeen.has('S2') && stagesSeen.has('S4.5'), '遥测账本应完整记录 S0 / S2 / S4.5 各阶段运行');
    const swarmSnap = tel.buildSwarmSnapshot(v21Ws, { topic: v21Topic, focusStage: 'S4.5', focusIdeaId: 'idea_01' });
    assert.equal(swarmSnap.ok, true);
    assert.equal(swarmSnap.stages.length, 8, 'S0→S6 八阶段流水线轨完整');
    assert.ok(swarmSnap.graph.nodes.length >= 4 && swarmSnap.graph.edges.length >= 3, 'S4.5 拓扑图节点与连线完整');
    const vRes = tel.writeHumanVerdict(v21Ws, { topic: v21Topic, ideaId: 'idea_01', decision: 'go', note: '配对探针通过' });
    assert.equal(vRes.ok, true);
    const swarmAfterGo = tel.buildSwarmSnapshot(v21Ws, { topic: v21Topic, focusStage: 'S6', focusIdeaId: 'idea_01' });
    assert.ok(swarmAfterGo.ideas.some((i) => i.ideaId === 'idea_01' && i.verdict === 'go'), '人类拍板 GO 后拓扑盘面实时同步');

    // v2.3.1 CLI 全阶段 effort 编排与 --dry 透传 / kimi 安全忽略回归
    const rEffLineup = runCli(v21Ws, [
      'lineup',
      '--scout', 'codex:gpt-5',
      '--scout-effort', 'high',
      '--diverge', 'claude:claude-sonnet-4-5@xhigh',
      '--review', 'codex:gpt-5@medium,agy:gemini-4-carbon-high,kimi:kimi-k2.5@high',
      '--novelty', 'agy:claude-opus-4-6@high',
      '--json',
    ]);
    assert.equal(rEffLineup.rc, 0, rEffLineup.out);
    const effUpd = JSON.parse(rEffLineup.stdout);
    assert.equal(effUpd.lineup.scout.effort, 'high');
    assert.equal(effUpd.lineup.diverge.effort, 'xhigh');
    assert.equal(effUpd.lineup.review[0].effort, 'medium');
    assert.equal(effUpd.lineup.novelty.effort, 'high');

    const rPlanEff = runCli(v21Ws, ['plan', 'ideas/' + v21Topic + '/briefs/idea_01.md']);
    assert.equal(rPlanEff.rc, 0, rPlanEff.out);
    const planEffObj = JSON.parse(rPlanEff.stdout);
    assert.equal(planEffObj.plan[0].effort, 'medium');

    const rDryScoutEff = runCli(v21Ws, ['scout', 'test query', '1', '--dry']);
    assert.equal(rDryScoutEff.rc, 0, rDryScoutEff.out);
    assert.ok(rDryScoutEff.stdout.includes('effort=high'), 'scout --dry 应透传 effort=high：\n' + rDryScoutEff.out);

    const rDryDivEff = runCli(v21Ws, ['diverge', 'test dir', '5', '--topic', v21Topic, '--baseline', 'baselines/b1', '--dry']);
    assert.equal(rDryDivEff.rc, 0, rDryDivEff.out);
    assert.ok(rDryDivEff.stdout.includes('effort=xhigh'), 'diverge --dry 应透传 effort=xhigh：\n' + rDryDivEff.out);

    // 不支持的 kimi 座位即使传入 effort 也安全忽略不报错
    const rDryKimiEff = runCli(v21Ws, ['scout', 'test query', '1', '--agent', 'kimi:kimi-k2.5', '--effort', 'high', '--dry']);
    assert.equal(rDryKimiEff.rc, 0, '不支持的 kimi 传 effort 应安全忽略退 0：\n' + rDryKimiEff.out);
    const kimiDryLine = rDryKimiEff.stdout.split(/\r?\n/).find((l) => l.includes('[dry]')) || '';
    assert.ok(rDryKimiEff.stdout.includes('已安全忽略') && !kimiDryLine.includes('effort='), 'kimi --dry 应给出安全忽略提示且不透传 effort：\n' + rDryKimiEff.out);
  });

  await ta('S9 [Codex 复审 4 批闭环回归] 排序冲突样本 / 严格验票 / 裁决版本锁 / 桌面 S6 冻结真源 / 重复票位 / Pilot 状态 / effort 清除', async () => {
    const regMod = await import('../lib/registry.mjs');
    const regWs = mkTmp('codex-audit-reg');
    const rTopic = 'audit-verify';
    assert.equal(runCli(regWs, ['init', '--topic', rTopic]).rc, 0);
    assert.ok(fs.existsSync(path.join(regWs, 'dispatch', 'dsh-review.patch.yml')), 'P2-23：init 应同时生成 dispatch/dsh-review.patch.yml');

    // 1) N19 & P1-09 & N11：少 go 高 /25 分 应排在 多 go 低 /25 分 之前；缺维卡、失配 SHA、UNKNOWN manifest 不入榜且桌面与 CLI 名次完全一致
    const bDir = path.join(regWs, 'ideas', rTopic, 'briefs');
    const cDir = path.join(regWs, 'ideas', rTopic, 'cards');
    const writeB = (id, text) => {
      const body = '<!-- meta role=brief idea=' + id + ' anchor=none -->\n### Idea\n' + text + '\n';
      fs.writeFileSync(path.join(bDir, id + '.md'), body, 'utf8');
      return crypto.createHash('sha256').update(body.replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 12);
    };
    const writeCard = (id, tag, verdict, scores, extraMeta = '') => {
      const [n, f, fit, c, g] = scores;
      const dimLines = [];
      if (n !== null) dimLines.push('novelty: {score: ' + n + ', reason: "新颖度充分"}');
      if (f !== null) dimLines.push('feasibility: {score: ' + f + ', reason: "实现可行"}');
      if (fit !== null) dimLines.push('baseline_fit: {score: ' + fit + ', reason: "贴合基线"}');
      if (c !== null) dimLines.push('impl_cost: {score: ' + c + ', reason: "轻量低成本"}');
      if (g !== null) dimLines.push('expected_gain: {score: ' + g + ', reason: "预期收益明确"}');
      fs.writeFileSync(path.join(cDir, id + '.' + tag + '.md'), [
        '<!-- meta backend=' + tag + ' model=gpt-5' + (extraMeta ? ' ' + extraMeta : '') + ' -->',
        '```yaml',
        'idea_id: ' + id,
        ...dimLines,
        'verdict: ' + verdict,
        'kill_reason: ' + (verdict === 'kill' ? '"明确证伪缺陷"' : 'null'),
        'confidence: 0.85',
        'missing_info: []',
        '```',
        '',
      ].join('\n'), 'utf8');
    };

    const sha01 = writeB('idea_01', '少 go 高分候选');
    const sha02 = writeB('idea_02', '多 go 低分候选');
    const sha03 = writeB('idea_03', '缺维坏卡候选');
    const sha04 = writeB('idea_04', '失配 SHA 候选');
    const sha05 = writeB('idea_05', '未知状态 manifest 候选');

    // idea_01: 1 go (23/25)
    writeCard('idea_01', 'codex', 'go', [5, 5, 4, 5, 4], 'sha=' + sha01);
    fs.writeFileSync(path.join(cDir, 'idea_01.manifest'), '<!-- manifest schema=2 idea=idea_01 sha=' + sha01 + ' status=OK(single-vote codex) -->\nvotes: codex\n', 'utf8');

    // idea_02: 2 go (18/25 + 18/25 = 18/25)
    writeCard('idea_02', 'codex', 'go', [4, 4, 3, 4, 3], 'sha=' + sha02);
    writeCard('idea_02', 'claude', 'go', [4, 3, 4, 4, 3], 'sha=' + sha02);
    fs.writeFileSync(path.join(cDir, 'idea_02.manifest'), '<!-- manifest schema=2 idea=idea_02 sha=' + sha02 + ' status=OK -->\nvotes: codex claude\n', 'utf8');

    // idea_03: 仅缺 1 维（4 维）→ checkCardFile 拒收，不得计 go 票也不得上榜
    writeCard('idea_03', 'codex', 'go', [5, 5, 5, 5, null], 'sha=' + sha03);
    fs.writeFileSync(path.join(cDir, 'idea_03.manifest'), '<!-- manifest schema=2 idea=idea_03 sha=' + sha03 + ' status=OK -->\nvotes: codex\n', 'utf8');

    // idea_04: manifest sha 与当前 brief sha 不一致 → 不得上榜
    writeCard('idea_04', 'codex', 'go', [5, 5, 5, 5, 5], 'sha=' + sha04);
    fs.writeFileSync(path.join(cDir, 'idea_04.manifest'), '<!-- manifest schema=2 idea=idea_04 sha=deadbeef0000 status=OK -->\nvotes: codex\n', 'utf8');

    // idea_05: manifest status=UNKNOWN → 不得上榜
    writeCard('idea_05', 'codex', 'go', [5, 5, 5, 5, 5], 'sha=' + sha05);
    fs.writeFileSync(path.join(cDir, 'idea_05.manifest'), '<!-- manifest schema=2 idea=idea_05 sha=' + sha05 + ' status=UNKNOWN -->\nvotes: codex\n', 'utf8');

    const sum = val.summarizeTopic(regWs, { topic: rTopic, writeFile: false });
    assert.equal(sum.ok, true);
    const byId = new Map(sum.items.map((x) => [x.rawId, x]));
    assert.equal(byId.get('idea_01').rank, 1, '1 go @ 23/25 应按 /25 主序排在 2 go @ 18/25 前面（#1）');
    assert.equal(byId.get('idea_02').rank, 2, '2 go @ 18/25 应排 #2');
    assert.equal(byId.get('idea_03').rank, null, '仅含缺维卡的候选不得获得名次');
    assert.equal(byId.get('idea_03').counts.go, 0, '缺维卡不得计入 go 票数');
    assert.equal(byId.get('idea_04').rank, null, 'manifest brief SHA 失配候选不得上榜');
    assert.equal(byId.get('idea_05').rank, null, 'status=UNKNOWN 候选不得上榜');

    const snap = tel.buildSwarmSnapshot(regWs, { topic: rTopic });
    const snapById = new Map(snap.ideas.map((x) => [x.ideaId, x]));
    assert.equal(snapById.get('idea_01').rank, 1, 'N11：桌面快照排名必须与 CLI summarizeTopic 完全一致');
    assert.equal(snapById.get('idea_02').rank, 2);
    assert.equal(snapById.get('idea_03').rank, null);
    assert.equal(snapById.get('idea_04').rank, null);
    assert.equal(snapById.get('idea_05').rank, null);

    // 2) N2：裁决必须绑定存在的工单与审阅时 briefSha
    const vMissing = tel.writeHumanVerdict(regWs, { topic: rTopic, ideaId: 'idea_99', decision: 'go' });
    assert.equal(vMissing.ok, false);
    assert.equal(vMissing.code, 'BRIEF_NOT_FOUND');

    const vStale = tel.writeHumanVerdict(regWs, { topic: rTopic, ideaId: 'idea_01', decision: 'go', expectedBriefSha: '000000000000' });
    assert.equal(vStale.ok, false);
    assert.equal(vStale.code, 'BRIEF_CHANGED');

    const vOk = tel.writeHumanVerdict(regWs, { topic: rTopic, ideaId: 'idea_01', decision: 'go', expectedBriefSha: snapById.get('idea_01').sha });
    assert.equal(vOk.ok, true);
    assert.ok(fs.readFileSync(path.join(regWs, vOk.verdictRel), 'utf8').includes('brief_sha: ' + vOk.briefSha));

    // 3) P1-13 & N3：§5 中的 SIGNOFF: PASS 不得通过 checkAnchor；同内容未登记的另一契约文件在桌面不得显示已冻结
    const badBase = path.join(regWs, 'baselines', 'bad-s5');
    fs.mkdirSync(badBase, { recursive: true });
    fs.writeFileSync(path.join(badBase, 'REPRO.md'), [
      '## §3 关键指标',
      '| Metric | 论文 | 我复现 | 容差 |',
      '|---|---|---|---|',
      '| Acc | 78.4 | 78.4 | 0.3 |',
      '## §4 人工签字',
      '尚未签字',
      '## §5 备注',
      'SIGNOFF: PASS',
      '',
    ].join('\n'), 'utf8');
    assert.equal(val.checkAnchor(regWs, 'baselines/bad-s5').ok, false, 'P1-13：§5 中的 SIGNOFF: PASS 绝不得算 §4 已签字');

    const cTemplate = [
      '## §0 元信息',
      '- exp_id: exp_freeze_check',
      '- baseline: none',
      '- 数据集与 split: MathVista testmini (1000)',
      '## §1 Hypothesis',
      '采用门控剪枝后 Acc >= 79.6% (+1.2pp)。',
      '## §2 实现锚点',
      '- 超参: lr=1e-6, kl=0.01',
      '- metric: MathVista Acc',
      '- 计算预算: 4xA800 2h',
      '- 代码对应: train/gate.py',
      '## §3 成功信号',
      '- S1: MathVista Acc >= 79.6%（越过 2σ = 0.6pp）',
      '## §4 失败信号',
      '- F1: 推理合规率下降超过 3.0pp 或长度膨胀 >= 25%',
      '## §5 Ablation 消融预期',
      '| Ablation | 预期看到什么 | 若看到相反结果说明什么 |',
      '|---|---|---|',
      '| 去掉熵门控 | Acc 跌回 78.4% | 说明收益来自训练步数而非熵门控 |',
      '## §6 防事后合理化条款',
      '开跑前锁定，不动成功线。',
      '',
    ].join('\n');
    const c1 = path.join(regWs, 'contract', 'exp_a.v1.md');
    const c2 = path.join(regWs, 'contract', 'exp_clone.v1.md');
    fs.writeFileSync(c1, cTemplate, 'utf8');
    fs.writeFileSync(c2, cTemplate, 'utf8');
    assert.equal(wf.checkContractFile(c1, { rootDir: regWs, record: true }).ok, true);
    const snapC = tel.buildSwarmSnapshot(regWs, { topic: rTopic });
    const sc1 = snapC.contracts.find((x) => x.id === 'exp_a.v1');
    const sc2 = snapC.contracts.find((x) => x.id === 'exp_clone.v1');
    assert.equal(sc1 && sc1.frozen, true, '已登记的 exp_a.v1 应显示已冻结');
    assert.equal(sc2 && sc2.frozen, false, 'N3：内容相同但未登记的 exp_clone.v1 绝不得被桌面判为已冻结');

    // 非法非路径基线名在 checkContractFile 中必须报错
    const cBadBase = path.join(regWs, 'contract', 'exp_badbase.v1.md');
    fs.writeFileSync(cBadBase, cTemplate.replace('- baseline: none', '- baseline: nonexistent_baseline_slug'), 'utf8');
    assert.equal(wf.checkContractFile(cBadBase, { rootDir: regWs, record: false }).ok, false, 'P1-13：不存在的基线词条必须被拒');

    // 4) N5：不同 seat 显式重复票位 ID（忽略大小写）被拦截
    const cfgObj = regMod.loadConfig(regWs);
    cfgObj.lineup = { review: [{ id: 'Vote', seat: 'codex' }, { id: 'vote', seat: 'claude' }] };
    const dupPlan = regMod.resolveExecutionPlan(cfgObj, { useDshPatch: false });
    assert.equal(dupPlan.ok, false, 'N5：大小写等价的重复显式票位 ID 必须被拦');

    // 5) P1-15：非法 effort 显式报错，default 置 effortCleared=true
    cfgObj.lineup = { scout: { seat: 'codex', model: 'gpt-5', effort: 'high' } };
    const badEff = regMod.resolveStagePlan(cfgObj, 'scout', { effort: 'turbo-invalid', useDshPatch: false });
    assert.equal(badEff.ok, false);
    assert.equal(badEff.code, 'INVALID_EFFORT');
    const clrEff = regMod.resolveStagePlan(cfgObj, 'scout', { effort: 'default', useDshPatch: false });
    assert.equal(clrEff.ok, true);
    assert.equal(clrEff.effort, '');
    assert.equal(clrEff.effortCleared, true);

    // 6) N8, N12, N18：Pilot 统计零增益/恒差/单题簇与内部字段清理
    const zeroA = Array.from({ length: 8 }, (_, i) => ({ item_id: 'q' + i, rollout_id: 0, correct: 1, compliant: true }));
    const zeroStats = ps.computePairedStats(zeroA, zeroA, { compliantField: 'compliant' });
    assert.equal(zeroStats.mde_status, 'ZERO_EFFECT');
    assert.equal(zeroStats.exceeds_2sigma_mde, false);
    assert.equal('_raw_delta' in zeroStats.generation, false);
    assert.equal('_raw_delta' in zeroStats.compliant_subset.paired, false, 'N18：合规子集不得泄出 _raw_delta');

    const constA = Array.from({ length: 6 }, (_, i) => ({ item_id: 'q' + i, rollout_id: 0, score: 0.25 }));
    const constB = Array.from({ length: 6 }, (_, i) => ({ item_id: 'q' + i, rollout_id: 0, score: 0.50 }));
    const constStats = ps.computePairedStats(constA, constB);
    assert.equal(constStats.mde_status, 'SE_UNESTIMABLE', 'N12：零 SE 非零恒差应返回 SE_UNESTIMABLE');
    assert.ok(!ps.formatPairedStatsReport(constStats).includes('BELOW_MDE'), 'N12：零 SE 非零恒差报告不得称作 BELOW_MDE');

    const singleItemA = Array.from({ length: 16 }, (_, r) => ({ item_id: 'only_q', rollout: r, correct: 0 }));
    const singleItemB = Array.from({ length: 16 }, (_, r) => ({ item_id: 'only_q', rollout: r, correct: 1 }));
    const singleStats = ps.computePairedStats(singleItemA, singleItemB);
    assert.equal(singleStats.bootstrap_ci95_pp, null, 'N8：单独立题簇不得伪造 [100,100] 跨题 CI');
    assert.equal(singleStats.item_level_mde_status, 'SE_UNESTIMABLE', 'N8：单独立题簇跨题门槛应为 SE_UNESTIMABLE');
  });

  await ta('S10 [Codex 终审放行门槛全覆盖] P0 无脚本 preview / 缺失证据 fail-closed / 模板与过期裁决 / 统一文件锁 / 默认课题对齐 / 极小效应量', async () => {
    const fl = await import('../lib/file-lock.mjs');
    const regMod = await import('../lib/registry.mjs');

    // 1) P0 #1：默认桌面 preview 即使工作区含 dispatch/anchor_check.sh 与 dispatch/check_card.py，也绝不执行
    const p0Ws = mkTmp('p0-no-ws-scripts');
    assert.equal(runCli(p0Ws, ['init', '--topic', 'sec-demo']).rc, 0);
    const p0SeatsPath = path.join(p0Ws, 'dispatch', 'seats.json');
    const p0Seats = JSON.parse(fs.readFileSync(p0SeatsPath, 'utf8'));
    p0Seats.default_backends = ['node_seat'];
    p0Seats.lineup = { ...(p0Seats.lineup || {}), review: [{ seat: 'node_seat', model: '' }] };
    p0Seats.seats.push({
      id: 'node_seat',
      kind: 'cli',
      enabled: true,
      command: process.execPath,
      argv: ['-e', 'process.exit(0)'],
      payload_position: 'stdin',
      output: 'stdout',
      identity: { kind: 'static', model: 'mock-node-1' },
    });
    fs.writeFileSync(p0SeatsPath, JSON.stringify(p0Seats, null, 2) + '\n', 'utf8');
    const p0Base = path.join(p0Ws, 'baselines', 'sec-base');
    fs.mkdirSync(p0Base, { recursive: true });
    fs.writeFileSync(path.join(p0Base, 'BRIEF_BLOCK.md'), '# Baseline Anchor\nAcc=70.0\n', 'utf8');
    fs.writeFileSync(path.join(p0Base, 'REPRO.md'), [
      '## §3 关键指标',
      '| Metric | 论文 | 我复现 | 容差 |',
      '|---|---|---|---|',
      '| Acc | 70.0 | 70.0 | 0.2 |',
      '## §4 人工签字',
      'SIGNOFF: PASS',
      '',
    ].join('\n'), 'utf8');
    const p0BriefRel = 'ideas/sec-demo/briefs/idea_01.md';
    fs.writeFileSync(
      path.join(p0Ws, p0BriefRel),
      '<!-- meta role=brief idea=idea_01 anchor=baselines/sec-base -->\n### Baseline\nAcc = 70.0\n\n### Idea\n验证 preview 不执行工作区脚本\n',
      'utf8',
    );
    const p0Sentinel = path.join(p0Ws, 'P0_SCRIPT_EXECUTED');
    fs.writeFileSync(
      path.join(p0Ws, 'dispatch', 'anchor_check.sh'),
      '#!/usr/bin/env bash\necho PWNED > "' + p0Sentinel.replace(/\\/g, '/') + '"\nexit 0\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(p0Ws, 'dispatch', 'check_card.py'),
      'open(' + JSON.stringify(p0Sentinel) + ', "w").write("PWNED")\n',
      'utf8',
    );
    const prevRes = await ft.dispatchFlow(
      { action: 'preview', brief: p0BriefRel },
      { repoRoot: p0Ws, useDshPatch: false },
    );
    assert.equal(prevRes.ok, true, 'P0 #1：纯 Node preview 应成功通过内置 checkAnchor，实得：' + JSON.stringify(prevRes));
    assert.equal(fs.existsSync(p0Sentinel), false, 'P0 #1：默认 preview 绝不得执行工作区 dispatch/anchor_check.sh 或 check_card.py');

    // 2) P1 #1 & #2：正对照合格卡正常上榜；缺 sha、votes: none（含诊断行）、VOID、缺失 brief 一律 fail-closed（rank=null, go=0）
    const p1Ws = mkTmp('p1-fail-closed');
    assert.equal(runCli(p1Ws, ['init', '--topic', 'fc']).rc, 0);
    const fcBriefs = path.join(p1Ws, 'ideas', 'fc', 'briefs');
    const fcCards = path.join(p1Ws, 'ideas', 'fc', 'cards');
    const mkCardText = (id, extraMeta = '') => [
      '<!-- meta role=reviewer seat=codex model=gpt-5' + (extraMeta ? ' ' + extraMeta : '') + ' -->',
      '```yaml',
      'idea_id: ' + id,
      'novelty: {score: 5, reason: "创新切入机制清晰且区别于现有基线"}',
      'feasibility: {score: 5, reason: "单卡两小时内可完成探针复核"}',
      'baseline_fit: {score: 5, reason: "零侵入挂载当前复现基线"}',
      'impl_cost: {score: 5, reason: "仅修改不到五十行代码"}',
      'expected_gain: {score: 5, reason: "预期收益明确越过两倍噪声下限"}',
      'verdict: go',
      'kill_reason: null',
      'confidence: 0.9',
      'missing_info: []',
      '```',
      '',
    ].join('\n');

    // 正对照 idea_valid：合格卡 + 匹配 sha + OK + votes: codex -> 必须真实获得 rank=1, go=1
    const okText = '<!-- meta role=brief idea=idea_valid -->\n### Idea\n正对照合格方案\n';
    const okSha = crypto.createHash('sha256').update(okText, 'utf8').digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(fcBriefs, 'idea_valid.md'), okText, 'utf8');
    fs.writeFileSync(path.join(fcCards, 'idea_valid.codex.md'), mkCardText('idea_valid', 'sha=' + okSha), 'utf8');
    fs.writeFileSync(path.join(fcCards, 'idea_valid.manifest'), '<!-- manifest schema=2 idea=idea_valid sha=' + okSha + ' status=OK -->\nvotes: codex\ncodex → verdict: go\n', 'utf8');

    // idea_nosha: manifest 和 card 都缺 sha
    fs.writeFileSync(path.join(fcBriefs, 'idea_nosha.md'), '<!-- meta role=brief idea=idea_nosha -->\n### Idea\nA\n', 'utf8');
    fs.writeFileSync(path.join(fcCards, 'idea_nosha.codex.md'), mkCardText('idea_nosha'), 'utf8');
    fs.writeFileSync(path.join(fcCards, 'idea_nosha.manifest'), '<!-- manifest schema=2 idea=idea_nosha status=OK -->\nvotes: codex\n', 'utf8');

    // idea_novotes: manifest sha 对但 votes: none 且带诊断行 `codex → verdict: go`（绝不可回退诊断行恢复有效票）
    const nvText = '<!-- meta role=brief idea=idea_novotes -->\n### Idea\nB\n';
    const nvSha = crypto.createHash('sha256').update(nvText, 'utf8').digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(fcBriefs, 'idea_novotes.md'), nvText, 'utf8');
    fs.writeFileSync(path.join(fcCards, 'idea_novotes.codex.md'), mkCardText('idea_novotes', 'sha=' + nvSha), 'utf8');
    fs.writeFileSync(path.join(fcCards, 'idea_novotes.manifest'), '<!-- manifest schema=2 idea=idea_novotes sha=' + nvSha + ' status=OK -->\nvotes: none\ncodex → verdict: go\n', 'utf8');

    // idea_void: status=VOID(...) 即使 sha 匹配且 votes 登记也不得计有效票
    const vdText = '<!-- meta role=brief idea=idea_void -->\n### Idea\nC\n';
    const vdSha = crypto.createHash('sha256').update(vdText, 'utf8').digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(fcBriefs, 'idea_void.md'), vdText, 'utf8');
    fs.writeFileSync(path.join(fcCards, 'idea_void.codex.md'), mkCardText('idea_void', 'sha=' + vdSha), 'utf8');
    fs.writeFileSync(path.join(fcCards, 'idea_void.manifest'), '<!-- manifest schema=2 idea=idea_void sha=' + vdSha + ' status=VOID(same-model) -->\nvotes: codex\n', 'utf8');

    // idea_orphan: 缺失 brief，只有 card + manifest（也不得计入 S3 工单数）
    fs.writeFileSync(path.join(fcCards, 'idea_orphan.codex.md'), mkCardText('idea_orphan', 'sha=111122223333'), 'utf8');
    fs.writeFileSync(path.join(fcCards, 'idea_orphan.manifest'), '<!-- manifest schema=2 idea=idea_orphan sha=111122223333 status=OK -->\nvotes: codex\n', 'utf8');

    // idea_s2_missing_votes: schema=2 缺失 votes: 行，仅保留 seats: codex → 不得回退上榜
    const mvText = '<!-- meta role=brief idea=idea_s2_missing_votes -->\n### Idea\nD\n';
    const mvSha = crypto.createHash('sha256').update(mvText, 'utf8').digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(fcBriefs, 'idea_s2_missing_votes.md'), mvText, 'utf8');
    fs.writeFileSync(path.join(fcCards, 'idea_s2_missing_votes.codex.md'), mkCardText('idea_s2_missing_votes', 'sha=' + mvSha), 'utf8');
    fs.writeFileSync(path.join(fcCards, 'idea_s2_missing_votes.manifest'), '<!-- manifest schema=2 idea=idea_s2_missing_votes sha=' + mvSha + ' status=OK -->\nseats: codex\n', 'utf8');

    // idea_bad_ok: 未闭合状态 OK(incomplete → 不得上榜
    const boText = '<!-- meta role=brief idea=idea_bad_ok -->\n### Idea\nE\n';
    const boSha = crypto.createHash('sha256').update(boText, 'utf8').digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(fcBriefs, 'idea_bad_ok.md'), boText, 'utf8');
    fs.writeFileSync(path.join(fcCards, 'idea_bad_ok.codex.md'), mkCardText('idea_bad_ok', 'sha=' + boSha), 'utf8');
    fs.writeFileSync(path.join(fcCards, 'idea_bad_ok.manifest'), '<!-- manifest schema=2 idea=idea_bad_ok sha=' + boSha + ' status=OK(incomplete -->\nvotes: codex\n', 'utf8');

    const fcSum = val.summarizeTopic(p1Ws, { topic: 'fc', writeFile: false });
    const fcMap = new Map(fcSum.items.map((x) => [x.rawId, x]));
    assert.equal(fcMap.get('idea_valid').rank, 1, 'P1 #1 正对照：合格卡应排 #1');
    assert.equal(fcMap.get('idea_valid').counts.go, 1, 'P1 #1 正对照：合格卡应计 1 go');
    for (const k of ['idea_nosha', 'idea_novotes', 'idea_void', 'idea_orphan', 'idea_s2_missing_votes', 'idea_bad_ok']) {
      assert.equal(fcMap.get(k).rank, null, 'P1 #1/#2：' + k + ' 不得上榜');
      assert.equal(fcMap.get(k).counts.go, 0, 'P1 #1/#2：' + k + ' 不得计入有效 go 票');
    }

    // 非法非 YAML 普通 Markdown 及伪造 duplication_risk: clear 不得点亮 S4.5；真实合格 mid 报告应点亮 S4.5；VOID 轮不得让 S4 排名节点变 done
    fs.mkdirSync(path.join(p1Ws, 'papers', 'novelty', 'fc'), { recursive: true });
    fs.writeFileSync(path.join(p1Ws, 'papers', 'novelty', 'notes.md'), '# 随手笔记\n非查重 YAML\n', 'utf8');
    fs.writeFileSync(
      path.join(p1Ws, 'papers', 'novelty', 'fc', 'idea_nosha.md'),
      '<!-- meta role=novelty idea=idea_nosha brief=ideas/fc/briefs/idea_nosha.md -->\n```yaml\nduplication_risk: clear\n```\n',
      'utf8',
    );
    const fcSnapBefore = tel.buildSwarmSnapshot(p1Ws, { topic: 'fc', focusIdeaId: 'idea_void' });
    const s3Stg = fcSnapBefore.stages.find((s) => s.id === 'S3');
    const s45StgBefore = fcSnapBefore.stages.find((s) => s.id === 'S4.5');
    const voidSummaryNode = fcSnapBefore.graph.nodes.find((n) => n.id === 's4-summary');
    assert.equal(s3Stg.badge, '6 张工单', 'P1 #2：无 brief 孤件 idea_orphan 不得计入 S3 工单数');
    assert.equal(s45StgBefore.status, 'empty', 'P1 #2：不合格 clear YAML 不得点亮 S4.5 查重阶段');
    assert.notEqual(voidSummaryNode && voidSummaryNode.status, 'done', 'P1 #2：VOID 轮不得令 S4 排名节点显示 done');

    fs.writeFileSync(
      path.join(p1Ws, 'papers', 'novelty', 'fc', 'idea_valid.md'),
      [
        '<!-- meta role=novelty idea=idea_valid brief=ideas/fc/briefs/idea_valid.md brief_sha=' + okSha + ' -->',
        '```yaml',
        'idea_id: idea_valid',
        'searched_sources: ["arXiv", "Semantic Scholar"]',
        'closest_works:',
        '  - title: "Related Gating Work"',
        '    venue_year: "ICLR 2025"',
        '    url_or_arxiv: "https://arxiv.org/abs/2501.00001"',
        '    overlap: "同属门控思路但目标函数与条件变量不同"',
        'duplication_risk: mid',
        'differentiation: "本方案仅在视觉残差通道引入双阈值门控并保持主干冻结"',
        'recommendation: "补做与该文的同预算对比实验后可推进"',
        'confidence: 0.8',
        '```',
        '',
      ].join('\n'),
      'utf8',
    );
    const fcSnapAfter = tel.buildSwarmSnapshot(p1Ws, { topic: 'fc' });
    const s45StgAfter = fcSnapAfter.stages.find((s) => s.id === 'S4.5');
    assert.equal(s45StgAfter.status, 'done', 'P1 #2：通过 checkNoveltyReport 的合格 mid 报告必须正常点亮 S4.5');

    // 3) P1 #3：模板行、正文代码块示例、空/损坏 brief_sha、双勾选、已删 brief 均拦截；真实历史归档 verdict 全数可读
    const tplV = val.parseVerdictText('决定: go | revise | kill\n\n```md\nDecision: go\n```\n');
    assert.equal(tplV.decision, null, 'P1 #3：未填模板 + 正文代码块示例绝不得误判为 go');
    const emptyShaV = val.parseVerdictText('决定: go\nbrief_sha:\n', { expectedBriefSha: 'cccc2222dddd' });
    assert.equal(emptyShaV.decision, null, 'P1 #3：空的 brief_sha: 行必须判 corruptSha 并拒认');
    assert.equal(emptyShaV.corruptSha, true);
    const dualCbV = val.parseVerdictText('☑ go  ☑ kill\n');
    assert.equal(dualCbV.decision, null, 'P1 #3：同时勾选多个决定复选框不得返回任意单值');
    const badShaV = val.parseVerdictText('决定: go\nbrief_sha: corrupted-sha!\n', { expectedBriefSha: 'cccc2222dddd' });
    assert.equal(badShaV.decision, null, 'P1 #3：格式损坏的 brief_sha 不得跳过漂移检查');
    assert.equal(badShaV.corruptSha, true);
    const missBriefV = val.parseVerdictText('决定: go\nbrief_sha: cccc2222dddd\n', { expectedBriefSha: '', briefMissing: true });
    assert.equal(missBriefV.decision, null, 'P1 #3：brief 已删除时旧裁决不得再算已裁决');
    const staleV = val.parseVerdictText('决定: go\nbrief_sha: aaaa1111bbbb\n', { expectedBriefSha: 'cccc2222dddd' });
    assert.equal(staleV.decision, null, 'P1 #3：brief_sha 漂移的旧裁决不得再作为有效裁决');
    assert.equal(staleV.stale, true, 'P1 #3：brief_sha 漂移应标记 stale=true');

    // 验证真实仓内历史归档裁决（含 ## 决定 章节 + 无语言围栏）18/18 全部可读，杜绝回归
    const realArchiveDir = path.resolve(SRC, '..', '..', 'ideas', 'archive', 'papo-3b');
    if (fs.existsSync(realArchiveDir)) {
      const archVerdicts = fs.readdirSync(realArchiveDir).filter((f) => /^verdict-idea_.*\.md$/i.test(f));
      assert.ok(archVerdicts.length >= 18, '应存在 18 份仓内历史归档裁决样本');
      const expectedRevise = new Set(['verdict-idea_10.md', 'verdict-idea_20.md']);
      for (const vf of archVerdicts) {
        const parsedArch = val.parseVerdictText(fs.readFileSync(path.join(realArchiveDir, vf), 'utf8'));
        const wantDec = expectedRevise.has(vf) ? 'revise' : 'kill';
        assert.equal(parsedArch.decision, wantDec, 'P1 #3：历史归档裁决 ' + vf + ' 应解析为最终裁决 ' + wantDec + '（含 verdict-idea_15 终裁 kill）');
      }
    }
    // P1 #3 细化回归：带语言标注围栏、裸围栏内空 brief_sha、显式行与复选框冲突均必须拒判为 null
    assert.equal(
      val.parseVerdictText('## 决定\n```text\n决定: go\n```\n').decision,
      null,
      'P1 #3：带语言标注的 ```text 代码块不得解析为有效决定',
    );
    assert.equal(
      val.parseVerdictText('## 决定\n```\n决定: go\nbrief_sha:\n```\n', { expectedBriefSha: 'abcdef123456' }).decision,
      null,
      'P1 #3：裸围栏内出现空 brief_sha: 时不得忽略占位指纹',
    );
    assert.equal(
      val.parseVerdictText('Decision: go\n- ☑ go\n- ☑ kill\n').decision,
      null,
      'P1 #3：显式决定行与多选复选框冲突时必须拒判为 null',
    );
    assert.equal(
      val.parseVerdictText('Decision: go\n- [x] kill\n').decision,
      null,
      'P1 #3：显式 Decision: go 与 Markdown 复选框 - [x] kill 冲突时必须拒判为 null',
    );
    assert.equal(
      val.parseVerdictText('☐ go ☑ kill\n').decision,
      'kill',
      'P1 #3：单行 ☐ go ☑ kill 必须解析为 kill 而非误把 ☑ 当作 go 的后缀',
    );

    // 4) P1 #4：file-lock 宽限期防误抢占、nonce 严格匹配释放、死进程接管
    const lockDir = mkTmp('p1-file-lock');
    const lkPath = path.join(lockDir, 'sample.lock');
    fs.writeFileSync(lkPath, '', 'utf8'); // 刚创建的空锁（模拟写入中）
    const freshCheck = fl.inspectLockStale(lkPath, { corruptGraceMs: 5000 });
    assert.equal(freshCheck, '', 'P1 #4：宽限期内的空锁绝不得被判为损坏抢占');
    const oldTs = new Date(Date.now() - 10000);
    fs.utimesSync(lkPath, oldTs, oldTs);
    assert.ok(fl.inspectLockStale(lkPath, { corruptGraceMs: 1000 }).includes('空锁'), 'P1 #4：超过宽限期的空锁应识别为陈旧锁');
    fs.unlinkSync(lkPath);

    const acq = fl.acquireExclusiveLock(lkPath, { purpose: 'test', timeoutMs: 200 });
    assert.equal(acq.ok, true);
    assert.equal(fl.releaseExclusiveLock(lkPath, ''), false, 'P1 #4：空 nonce 绝不得释放他人/自身锁');
    assert.equal(fl.releaseExclusiveLock(lkPath, 'wrong-nonce'), false, 'P1 #4：错误 nonce 绝不得释放锁');
    assert.equal(fs.existsSync(lkPath), true);
    assert.equal(fl.releaseExclusiveLock(lkPath, acq.nonce), true, 'P1 #4：匹配 nonce 才可释放锁');
    assert.equal(fs.existsSync(lkPath), false);

    // 死进程锁接管
    fs.writeFileSync(lkPath, JSON.stringify({ pid: 999999, nonce: 'dead1', ts: Date.now() - 10000, purpose: 'dead' }) + '\n', 'utf8');
    const takeOver = fl.acquireExclusiveLock(lkPath, { purpose: 'takeover', timeoutMs: 500 });
    assert.equal(takeOver.ok, true, 'P1 #4：死 PID 锁应被串行安全接管');
    assert.equal(fl.releaseExclusiveLock(lkPath, takeOver.nonce), true);

    // P1 #4：残留空 .reap 文件与死 PID .dead 二级抢占文件均能自动回收，不永久 BUSY
    const deadPayload = JSON.stringify({ pid: 999998, at: Date.now() - 10000, nonce: 'dead2' }) + '\n';
    fs.writeFileSync(lkPath, deadPayload, 'utf8');
    const deadRec = fl.readLockRecord(lkPath);
    const deadFp = crypto.createHash('sha256').update([
      deadRec.ino || 0, Math.round(deadRec.mtimeMs || 0), deadRec.size || 0,
      deadRec.pid || 0, deadRec.at || 0, deadRec.nonce || '',
      deadRec.empty ? '1' : '0', deadRec.corrupt ? '1' : '0',
    ].join('|'), 'utf8').digest('hex').slice(0, 16);
    const reapPath = lkPath + '.reap.' + deadFp;
    fs.writeFileSync(reapPath, '', 'utf8');
    const backDate = new Date(Date.now() - 10000);
    fs.utimesSync(reapPath, backDate, backDate);
    const reapRec = fl.readLockRecord(reapPath);
    const reapFp = crypto.createHash('sha256').update([
      reapRec.ino || 0, Math.round(reapRec.mtimeMs || 0), reapRec.size || 0,
      reapRec.pid || 0, reapRec.at || 0, reapRec.nonce || '',
      reapRec.empty ? '1' : '0', reapRec.corrupt ? '1' : '0',
    ].join('|'), 'utf8').digest('hex').slice(0, 16);
    const metaDeadPath = reapPath + '.dead.' + reapFp;
    fs.writeFileSync(metaDeadPath, JSON.stringify({ pid: 999997, at: Date.now() - 10000, nonce: 'deadmeta' }) + '\n', 'utf8');
    // 第一次尝试会清理死 .dead 与空 .reap，第二次即可成功接管原死锁
    const firstTry = fl.acquireExclusiveLock(lkPath, { corruptGraceMs: 1000 });
    const secondTry = firstTry.ok ? firstTry : fl.acquireExclusiveLock(lkPath, { corruptGraceMs: 1000 });
    assert.equal(secondTry.ok, true, 'P1 #4：超宽限空 .reap 与死 PID .dead 文件应可自愈回收并接管原死锁');
    assert.equal(fl.releaseExclusiveLock(lkPath, secondTry.nonce), true);

    // 5) P1 #5：summarizeTopic 与 dispatchFlow status 均拒绝路径穿越 topic
    const badTopicSum = val.summarizeTopic(p1Ws, { topic: '../escape', writeFile: false });
    assert.equal(badTopicSum.ok, false, 'P1 #5：summarizeTopic 必须拦截含 .. 的 topic 路径穿越');
    const badTopicStatus = await ft.dispatchFlow({ action: 'status', topic: '../escape' }, { repoRoot: p1Ws, useDshPatch: false });
    assert.equal(badTopicStatus.ok, false, 'P1 #5：desktop status 必须拦截含 .. 的 topic 路径穿越');
    assert.equal(badTopicStatus.reason, 'bad-args');

    // 6) P1 #10：从未冻结过的契约使用 --re-record 必须失败
    const cNever = path.join(p1Ws, 'contract', 'exp_never.v1.md');
    fs.writeFileSync(cNever, [
      '## §0 元信息\n- exp_id: exp_never\n- baseline: none\n- 数据集与 split: MME (200)',
      '## §1 Hypothesis\nAcc >= 80.0% (+2.0pp)。',
      '## §2 实现锚点\n- 超参: lr=1e-6\n- metric: Acc\n- 计算预算: 1xA800 1h\n- 代码对应: train.py',
      '## §3 成功信号\n- S1: Acc >= 80.0%',
      '## §4 失败信号\n- F1: 长度膨胀 >= 20%',
      '## §5 Ablation 消融预期\n| Ablation | 预期 | 相反说明 |\n|---|---|---|\n| 去掉组件 | Acc 回落 | 无效 |',
      '## §6 防事后合理化条款\n锁定。',
      '',
    ].join('\n'), 'utf8');
    const rrUnfrozen = wf.checkContractFile(cNever, { rootDir: p1Ws, reRecord: true, reason: '尝试跳过首冻' });
    assert.equal(rrUnfrozen.ok, false, 'P1 #10：未首次冻结的契约绝不允许 --re-record');

    // 7) P1 #12：默认 initProject() 生成 ideas/default/ 时，桌面快照与写裁决全链路对齐
    const defWs = mkTmp('p1-default-topic');
    wf.initProject(defWs, { force: false }); // 默认创建 ideas/default/briefs/
    const defBrief = '<!-- meta role=brief idea=idea_01 anchor=none -->\n### Idea\n默认课题测试\n';
    const defSha = crypto.createHash('sha256').update(defBrief, 'utf8').digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(defWs, 'ideas', 'default', 'briefs', 'idea_01.md'), defBrief, 'utf8');
    const defSnap = tel.buildSwarmSnapshot(defWs, { topic: 'default' });
    assert.ok(defSnap.ideas.some((it) => it.ideaId === 'idea_01'), 'P1 #12：discoverTopics 应正确读取 ideas/default/briefs/idea_01.md');
    const defVerd = tel.writeHumanVerdict(defWs, {
      topic: 'default',
      ideaId: 'idea_01',
      decision: 'go',
      expectedBriefSha: defSha,
      requireBriefSha: true,
    });
    assert.equal(defVerd.ok, true, 'P1 #12：ideas/default 下的工单可正常落盘裁决');
    assert.equal(defVerd.verdictRel, 'ideas/default/verdict-idea_01.md');

    // P1 #6：ideas/default/ 存在时，仅存在于平铺 ideas/briefs/ 的工单绝不被 default 课题静默跨目录写入
    fs.mkdirSync(path.join(defWs, 'ideas', 'briefs'), { recursive: true });
    const flatOnlyBrief = '<!-- meta role=brief idea=idea_flat_only anchor=none -->\n### Idea\n平铺独有工单\n';
    const flatOnlySha = crypto.createHash('sha256').update(flatOnlyBrief, 'utf8').digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(defWs, 'ideas', 'briefs', 'idea_flat_only.md'), flatOnlyBrief, 'utf8');
    const crossVerd = tel.writeHumanVerdict(defWs, {
      topic: 'default',
      ideaId: 'idea_flat_only',
      decision: 'go',
      expectedBriefSha: flatOnlySha,
      requireBriefSha: true,
    });
    assert.equal(crossVerd.ok, false, 'P1 #6：default 课题绝不得跨目录改道写平铺工单裁决');
    assert.equal(crossVerd.code, 'BRIEF_NOT_FOUND');

    // P2 #1：超 140 KiB 长 brief 在快照与写裁决间 SHA 完全一致，不误报 BRIEF_CHANGED
    const longBrief = '<!-- meta role=brief idea=idea_long anchor=none -->\n### Idea\n超长工单\n' + 'A'.repeat(150 * 1024) + '\n';
    fs.writeFileSync(path.join(defWs, 'ideas', 'default', 'briefs', 'idea_long.md'), longBrief, 'utf8');
    const longSnap = tel.buildSwarmSnapshot(defWs, { topic: 'default' });
    const longItem = longSnap.ideas.find((it) => it.ideaId === 'idea_long');
    const longVerd = tel.writeHumanVerdict(defWs, {
      topic: 'default',
      ideaId: 'idea_long',
      decision: 'go',
      expectedBriefSha: longItem && longItem.sha,
      requireBriefSha: true,
    });
    assert.equal(longVerd.ok, true, 'P2 #1：超过 128 KiB 的长 brief 快照指纹与写裁决全文指纹必须完全一致');

    // 8) P2 #13 & P2 #3：极小非零效应量不误判 ZERO_EFFECT；双臂题簇键不一致或显式空串均报错
    const tinyA = Array.from({ length: 8 }, (_, i) => ({ item_id: 'q' + i, rollout_id: 0, score: 0.5 }));
    const tinyB = Array.from({ length: 8 }, (_, i) => ({ item_id: 'q' + i, rollout_id: 0, score: 0.5 + (i % 2 === 0 ? 2e-8 : 3e-8) }));
    const tinyStats = ps.computePairedStats(tinyA, tinyB);
    assert.equal(tinyStats.item_level_mde_status, 'EXCEEDS_MDE', 'P2 #13：未舍入极小正向题簇差值应判 EXCEEDS_MDE 而非 ZERO_EFFECT');
    assert.equal('_raw_delta' in tinyStats.item_level, false, 'P2 #13：item_level 不得泄漏 _raw_delta');

    assert.throws(() => {
      ps.computePairedStats(
        [{ id: 'row1', item_id: 'qA', correct: 0 }, { id: 'row2', item_id: 'qB', correct: 1 }],
        [{ id: 'row1', item_id: 'qX', correct: 1 }, { id: 'row2', item_id: 'qB', correct: 1 }],
      );
    }, /题簇键不一致/, 'N8：双臂同样本 ID 对应不同题簇键时应显式报错');

    assert.throws(() => {
      ps.computePairedStats(
        [{ id: 'row1', item_id: '', correct: 0 }, { id: 'row2', item_id: '', correct: 1 }],
        [{ id: 'row1', item_id: '', correct: 1 }, { id: 'row2', item_id: '', correct: 1 }],
      );
    }, /不能为空值/, 'P2 #3：显式空串 item_id 不得将多题错误合并为 n_items=1');

    assert.throws(() => {
      ps.computePairedStats(
        [{ id: '::0', correct: 0 }, { id: '::1', correct: 1 }],
        [{ id: '::0', correct: 1 }, { id: '::1', correct: 1 }],
      );
    }, /前缀为空/, 'P2 #3：复合主键前缀为空（如 ::0）必须报错而非合并入空题簇');

    // 9) P2 #5 & P2 #14：updateLineup 与运行期 resolveExecutionPlan/resolveStagePlan 均拒绝非法 @effort，同时保留 @20241022
    assert.throws(() => {
      regMod.updateLineup(defWs, { scoutEffort: 'ultra-mega' });
    }, /思考强度值非法/, 'P2 #14：updateLineup 传入非法思考强度必须抛出 BAD_CONFIG 而非静默清空');
    assert.throws(() => {
      regMod.updateLineup(defWs, { scout: 'codex:gpt-5@hgh' });
    }, /非法的 @思考强度/, 'P2 #5：内联拼错 @hgh 必须报错而不得吞进模型名');
    const dateModelRes = regMod.updateLineup(defWs, { scout: 'claude:claude-3-5-sonnet@20241022' });
    assert.equal(dateModelRes.lineup.scout.model, 'claude-3-5-sonnet@20241022', 'P2 #5：合法云模型日期后缀 @20241022 必须保留');
    const defCfg = regMod.loadConfig(defWs);
    const badRevPlan = regMod.resolveExecutionPlan(defCfg, { reviewSpec: 'codex:gpt-5@hgh', useDshPatch: false });
    assert.equal(badRevPlan.ok, false, 'P2 #5：resolveExecutionPlan 必须拒绝拼错的内联 @hgh');
    assert.equal(badRevPlan.code, 'INVALID_EFFORT');
    const badStgPlan = regMod.resolveStagePlan(defCfg, 'scout', { agent: 'codex:gpt-5@hgh', useDshPatch: false });
    assert.equal(badStgPlan.ok, false, 'P2 #5：resolveStagePlan 必须拒绝拼错的内联 @hgh');
    assert.equal(badStgPlan.code, 'INVALID_EFFORT');

    // 10) 终审清零补强回归（P1 #1 / P1 #2 / P1 #6 / New P1-B / P2-3 / P3）
    // P1 #1：首行空行后的 schema=2 manifest 缺失 votes: 仍必须拒绝计票与排名
    const p1LeadWs = mkTmp('p1-lead-blank-manifest');
    wf.initProject(p1LeadWs, { topic: 'leadcheck', force: false });
    const leadBrief = '<!-- meta role=brief idea=idea_01 anchor=none -->\n### Idea\n首行空行清单回归\n';
    const leadSha = crypto.createHash('sha256').update(leadBrief, 'utf8').digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(p1LeadWs, 'ideas', 'leadcheck', 'briefs', 'idea_01.md'), leadBrief, 'utf8');
    fs.mkdirSync(path.join(p1LeadWs, 'ideas', 'leadcheck', 'cards'), { recursive: true });
    fs.writeFileSync(path.join(p1LeadWs, 'ideas', 'leadcheck', 'cards', 'idea_01.codex.md'), [
      '<!-- meta backend=codex model=gpt-5 sha=' + leadSha + ' -->',
      '```yaml',
      'idea_id: idea_01',
      'novelty: {score: 5, reason: "ok"}',
      'feasibility: {score: 5, reason: "ok"}',
      'baseline_fit: {score: 5, reason: "ok"}',
      'impl_cost: {score: 5, reason: "ok"}',
      'expected_gain: {score: 5, reason: "ok"}',
      'verdict: go',
      'kill_reason: null',
      'confidence: 0.9',
      'missing_info: []',
      '```',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(
      path.join(p1LeadWs, 'ideas', 'leadcheck', 'cards', 'idea_01.manifest'),
      '\n<!-- manifest schema=2 idea=idea_01 sha=' + leadSha + ' status=OK -->\nseats: codex\n',
      'utf8',
    );
    const leadSum = val.summarizeTopic(p1LeadWs, { topic: 'leadcheck', writeFile: false });
    assert.equal(leadSum.items[0].rank, null, 'P1 #1：带前导空行的 schema=2 manifest 缺 votes: 不得上榜');
    assert.equal(leadSum.items[0].counts.go, 0, 'P1 #1：带前导空行的 schema=2 manifest 缺 votes: 不得计票');

    // P1 #2：含多个 YAML 代码块的查重报告必须被 checkNoveltyReport 拒收（杜绝高/低风险口径分裂）
    const multiYamlNov = path.join(p1LeadWs, 'papers', 'novelty', 'idea_01.md');
    fs.mkdirSync(path.dirname(multiYamlNov), { recursive: true });
    fs.writeFileSync(multiYamlNov, [
      '<!-- meta role=novelty idea=idea_01 brief=ideas/leadcheck/briefs/idea_01.md sha=' + leadSha + ' -->',
      '```yaml',
      'idea_id: "idea_01"',
      'duplication_risk: low',
      'closest_works: []',
      'polish: "none"',
      'note: "arXiv 检索未发现撞车工作"',
      'confidence: 0.8',
      '```',
      '```yaml',
      'duplication_risk: high',
      '```',
      '',
    ].join('\n'), 'utf8');
    assert.equal(wf.checkNoveltyReport(multiYamlNov).ok, false, 'P1 #2：多 YAML 块查重报告必须被 checkNoveltyReport 拦截');

    // P1 #6：runNovelty 拒绝 --topic 与工单路径所属课题冲突，且 --out 指向无 brief= 的已存在文件时拒绝覆盖
    const conflictNovRc = await runMod.runNovelty({
      root: p1LeadWs,
      brief: 'ideas/leadcheck/briefs/idea_01.md',
      topic: 'other_topic',
      dry: true,
      noExitCode: true,
      captureOnly: true,
    });
    assert.equal(conflictNovRc, 1, 'P1 #6：--topic 与工单路径所属课题冲突必须失败退 1');
    const unrelatedOut = path.join(p1LeadWs, 'papers', 'novelty', 'unrelated.md');
    fs.writeFileSync(unrelatedOut, '# 外部已有笔记（无 brief= 归属头）\n', 'utf8');
    const overwriteNovRc = await runMod.runNovelty({
      root: p1LeadWs,
      brief: 'ideas/leadcheck/briefs/idea_01.md',
      outFile: 'papers/novelty/unrelated.md',
      dry: true,
      noExitCode: true,
      captureOnly: true,
    });
    assert.equal(overwriteNovRc, 2, 'P1 #6：--out 指向缺少 brief= 归属头的已存在文件时必须拒绝覆盖（rc=2）');
    assert.ok(fs.readFileSync(unrelatedOut, 'utf8').includes('外部已有笔记'), 'P1 #6：被拒覆盖的无关文件原文必须完好');

    // New P1-B：CHANGELOG.md 非普通文件（如目录占位）时 checkContractFile 必须拦截退 2
    const badClWs = mkTmp('p1b-bad-changelog');
    wf.initProject(badClWs, { force: false });
    const badClPath = path.join(badClWs, 'contract', 'CHANGELOG.md');
    if (fs.existsSync(badClPath)) fs.unlinkSync(badClPath);
    fs.mkdirSync(badClPath);
    const badClContract = path.join(badClWs, 'contract', 'exp_cl.v1.md');
    fs.writeFileSync(badClContract, [
      '## §0 元信息\n- exp_id: exp_cl\n- baseline: none\n- 数据集与 split: MME (200)',
      '## §1 Hypothesis\nAcc >= 80.0% (+2.0pp)。',
      '## §2 实现锚点\n- 超参: lr=1e-6\n- metric: Acc\n- 计算预算: 1xA800 1h\n- 代码对应: train.py',
      '## §3 成功信号\n- S1: Acc >= 80.0%',
      '## §4 失败信号\n- F1: 长度膨胀 >= 20%',
      '## §5 Ablation 消融预期\n| Ablation | 预期 | 相反说明 |\n|---|---|---|\n| 去掉组件 | Acc 回落 | 无效 |',
      '## §6 防事后合理化条款\n锁定。',
      '',
    ].join('\n'), 'utf8');
    const badClRes = wf.checkContractFile(badClContract, { rootDir: badClWs, record: true });
    assert.equal(badClRes.ok, false, 'New P1-B：CHANGELOG.md 为非普通文件时 checkContractFile 必须拒写');
    assert.equal(badClRes.rc, 2);

    // P2-3：课题 A 运行中任务不污染课题 B 快照/拓扑，且未上榜时不将 worker->summary 边标为 done
    const isoWs = mkTmp('p2-topic-active-run');
    wf.initProject(isoWs, { topic: 'topic_a', force: false });
    wf.initProject(isoWs, { topic: 'topic_b', force: false });
    fs.writeFileSync(path.join(isoWs, 'ideas', 'topic_a', 'briefs', 'idea_01.md'), '<!-- meta role=brief idea=idea_01 anchor=none -->\n### Idea\n课题A\n', 'utf8');
    fs.writeFileSync(path.join(isoWs, 'ideas', 'topic_b', 'briefs', 'idea_01.md'), '<!-- meta role=brief idea=idea_01 anchor=none -->\n### Idea\n课题B\n', 'utf8');
    const runAId = tel.startRunTelemetry(isoWs, {
      stage: 'S4',
      topic: 'topic_a',
      targetId: 'idea_01',
      workers: [{ tag: 'codex', seat: 'codex', status: 'working', startedAt: Date.now() }],
    });
    assert.ok(runAId);
    const snapB = tel.buildSwarmSnapshot(isoWs, { topic: 'topic_b' });
    assert.equal(snapB.activeRun, null, 'P2-3：课题 A 的运行中任务不得泄漏为课题 B 的 activeRun');
    const stageS4B = snapB.stages.find((s) => s.id === 'S4');
    assert.notEqual(stageS4B && stageS4B.status, 'working', 'P2-3：课题 A 运行中不得把课题 B 的 S4 阶段标为 working');
    tel.finishRunTelemetry(isoWs, runAId, { status: 'done', rc: 0 });

    // P3：bootstrapIters=0 且 n_items>=2 时报告区分“已关闭自助法”，不再误报“独立题簇不足 2 题”
    const noBootStats = ps.computePairedStats(tinyA, tinyB, { bootstrapIters: 0 });
    const noBootReport = ps.formatPairedStatsReport(noBootStats);
    assert.ok(noBootReport.includes('已关闭自助法'), 'P3：bootstrapIters=0 时应报告“已关闭自助法”');
    assert.ok(!noBootReport.includes('独立题簇不足 2 题'), 'P3：n_items>=2 且 bootstrapIters=0 时不得误报题簇不足 2 题');

    // 11) Codex 终审二轮 15 项全清零回归（~~~ 多块 / 备注防劫持 / 评审票防覆盖 / 大小写课题 / 专属目录防串单 / default vs _flat / 冲突 votes / 对象 effort）
    // P1 #2 & P3：~~~ 围栏追加第二个高风险块必须因“检测到 2 个代码块”被拒收（文件名与 idea_id 完全一致，排除文件名不匹配干扰）
    const tildeDir = path.join(p1LeadWs, 'papers', 'novelty', 'tilde_case');
    fs.mkdirSync(tildeDir, { recursive: true });
    const tildeNov = path.join(tildeDir, 'idea_01.md');
    fs.writeFileSync(tildeNov, [
      '<!-- meta role=novelty idea=idea_01 brief=ideas/leadcheck/briefs/idea_01.md sha=' + leadSha + ' -->',
      '```yaml',
      'idea_id: "idea_01"',
      'duplication_risk: low',
      'closest_works: []',
      'polish: "none"',
      'note: "arXiv 检索未发现撞车工作"',
      'confidence: 0.8',
      '```',
      '~~~yaml',
      'duplication_risk: high',
      '~~~',
      '',
    ].join('\n'), 'utf8');
    const tildeRes = wf.checkNoveltyReport(tildeNov);
    assert.equal(tildeRes.ok, false, 'P1 #2：追加 ~~~ 围栏高风险块必须被 checkNoveltyReport 拦截');
    assert.ok(
      Array.isArray(tildeRes.problems) && tildeRes.problems.some((p) => p.includes('检测到 2 个代码块')),
      'P3：tilde 多块测试必须精准命中“检测到 2 个代码块”错误：' + JSON.stringify(tildeRes.problems),
    );

    // 新 P1 #1：writeHumanVerdict 备注含 `## 终裁` + `决定: go` + `brief_sha:` 绝不得改写人类正式裁决 kill
    const injVerdRes = tel.writeHumanVerdict(defWs, {
      topic: 'default',
      ideaId: 'idea_01',
      decision: 'kill',
      note: '引用历史讨论：\n## 终裁\n决定: go\nbrief_sha: 000000000000\n',
      expectedBriefSha: defSha,
      requireBriefSha: true,
    });
    assert.equal(injVerdRes.ok, true);
    const injVerdParsed = val.parseVerdictText(fs.readFileSync(path.join(defWs, injVerdRes.verdictRel), 'utf8'), { expectedBriefSha: defSha });
    assert.equal(injVerdParsed.decision, 'kill', '新 P1 #1：备注含 ## 终裁 与 决定: go 时重新解析必须仍为 kill');
    assert.equal(injVerdParsed.stale, false, '新 P1 #1：备注内 brief_sha 文本不得污染正式指纹');

    // P1 #6 & 新 P1 #2：Windows 大写 IDEAS/ 路径仍拦错误 --topic；非 dry 模式 --out 指向同工单评审票必须拒写并释放锁
    if (process.platform === 'win32') {
      const upperConflictRc = await runMod.runNovelty({
        root: p1LeadWs,
        brief: 'IDEAS/leadcheck/briefs/idea_01.md',
        topic: 'other_topic',
        dry: true,
        noExitCode: true,
        captureOnly: true,
      });
      assert.equal(upperConflictRc, 1, 'P1 #6：Windows 下 IDEAS/... 大小写变体不得绕过错误 --topic 拒绝');
    }
    const reviewCardPath = path.join(p1LeadWs, 'ideas', 'leadcheck', 'cards', 'idea_01.codex.md');
    fs.writeFileSync(
      reviewCardPath,
      '<!-- meta backend=codex brief=ideas/leadcheck/briefs/idea_01.md sha=' + leadSha + ' model=gpt-5 -->\nreview-card-sentinel\n',
      'utf8',
    );
    const reviewOverwriteRc = await runMod.runNovelty({
      root: p1LeadWs,
      brief: 'ideas/leadcheck/briefs/idea_01.md',
      outFile: 'ideas/leadcheck/cards/idea_01.codex.md',
      dry: false,
      noExitCode: true,
      captureOnly: true,
    });
    assert.equal(reviewOverwriteRc, 2, '新 P1 #2：novelty --out 指向同工单评审票（缺 role=novelty）必须拒写退 2');
    assert.ok(fs.readFileSync(reviewCardPath, 'utf8').includes('review-card-sentinel'), '新 P1 #2：同工单评审票原文必须完好');
    assert.equal(
      fs.existsSync(path.join(p1LeadWs, 'ideas', 'leadcheck', 'cards', '.idea_01.codex.md.lock')),
      false,
      'P1 #6：显式 --out 拒写后必须清理目标锁不残留',
    );

    // 新 P1 #3：课题专属目录内若放入 brief= 指向另一课题的同内容同 SHA 查重报告，绝不得串单生效
    const sameBriefBody = '<!-- meta role=brief idea=idea_01 anchor=none -->\n### Idea\n同内容跨课题测试\n';
    const sameBriefSha = crypto.createHash('sha256').update(sameBriefBody, 'utf8').digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(isoWs, 'ideas', 'topic_a', 'briefs', 'idea_01.md'), sameBriefBody, 'utf8');
    fs.writeFileSync(path.join(isoWs, 'ideas', 'topic_b', 'briefs', 'idea_01.md'), sameBriefBody, 'utf8');
    const crossNovDir = path.join(isoWs, 'papers', 'novelty', 'topic_b');
    fs.mkdirSync(crossNovDir, { recursive: true });
    fs.writeFileSync(path.join(crossNovDir, 'idea_01.md'), [
      '<!-- meta role=novelty idea=idea_01 brief=ideas/topic_a/briefs/idea_01.md sha=' + sameBriefSha + ' -->',
      '```yaml',
      'idea_id: "idea_01"',
      'duplication_risk: low',
      'closest_works: []',
      'polish: "none"',
      'note: "arXiv 检索未发现撞车工作"',
      'confidence: 0.85',
      '```',
      '',
    ].join('\n'), 'utf8');
    const snapCrossB = tel.buildSwarmSnapshot(isoWs, { topic: 'topic_b' });
    const crossBItem = snapCrossB.ideas.find((x) => x.ideaId === 'idea_01');
    assert.equal(crossBItem && crossBItem.hasNovelty, false, '新 P1 #3：topic_b 目录内 brief=ideas/topic_a/... 的报告绝不得误认作 topic_b 已查重');

    // P2-3：同时存在 ideas/default/ 与平铺 ideas/briefs/ 时，default 运行态不得泄漏到 _flat 快照
    const runDefId = tel.startRunTelemetry(defWs, {
      stage: 'S4',
      topic: 'default',
      targetId: 'idea_01',
      workers: [{ tag: 'codex', seat: 'codex', status: 'working', startedAt: Date.now() }],
    });
    assert.ok(runDefId);
    const snapFlat = tel.buildSwarmSnapshot(defWs, { topic: '_flat' });
    assert.equal(snapFlat.activeRun, null, 'P2-3：命名 default 课题运行态绝不得泄漏到 _flat 快照');
    assert.equal(snapFlat.activeWorkerCount, 0, 'P2-3：_flat 快照 activeWorkerCount 必须为 0');
    const flatS4 = snapFlat.stages.find((s) => s.id === 'S4');
    assert.notEqual(flatS4 && flatS4.status, 'working', 'P2-3：_flat 快照 S4 阶段不得显示 working');
    tel.finishRunTelemetry(defWs, runDefId, { status: 'done', rc: 0 });

    // 新 P2 #1：schema=2 manifest 含冲突 votes: codex 与 votes: none 必须整单拒票
    fs.writeFileSync(
      path.join(p1LeadWs, 'ideas', 'leadcheck', 'cards', 'idea_01.manifest'),
      '<!-- manifest schema=2 idea=idea_01 sha=' + leadSha + ' status=OK -->\nvotes: codex\nvotes: none\n',
      'utf8',
    );
    const conflictVotesSum = val.summarizeTopic(p1LeadWs, { topic: 'leadcheck', writeFile: false });
    assert.equal(conflictVotesSum.items[0].rank, null, '新 P2 #1：冲突 votes: 行不得上榜');
    assert.equal(conflictVotesSum.items[0].counts.go, 0, '新 P2 #1：冲突 votes: 行不得计票');

    // 新 P2 #4：对象形式 lineup.review 中错误 effort 必须返回 INVALID_EFFORT 而非静默降级
    const badObjCfg = regMod.loadConfig(defWs);
    badObjCfg.lineup = { review: [{ seat: 'codex', effort: 'hgh' }] };
    const badObjPlan = regMod.resolveExecutionPlan(badObjCfg, { useDshPatch: false });
    assert.equal(badObjPlan.ok, false, '新 P2 #4：对象形式 lineup.review 非法 effort 必须报错');
    assert.equal(badObjPlan.code, 'INVALID_EFFORT');

    // 12) 终审三轮 14 项全清零回归（_flat 保留 / 默认子目录防覆写 / 单 ```yaml 围栏 / 反向复选框 / 冲突 votes status / 三层死守卫自愈 / none|off 与面板写穿校验 / 共享根歧义拦截）
    // P1 #1：禁止将 _flat / archive / briefs / cards 作为命名课题创建，且历史 ideas/_flat 目录不与平铺 _flat 撞名
    assert.throws(() => wf.initProject(mkTmp('res-flat'), { topic: '_flat' }), /保留目录|非法/, 'P1 #1：initProject 必须拒绝 --topic _flat');
    assert.throws(() => wf.initProject(mkTmp('res-arch'), { topic: 'archive' }), /保留目录|非法/, 'P1 #1：initProject 必须拒绝 --topic archive');
    const badBriefsTopic = wf.makeBriefs(defWs, 'ideas/raw.md', { topic: '_flat' });
    assert.equal(badBriefsTopic.ok, false, 'P1 #1：makeBriefs 必须拒绝 --topic _flat');
    const badDivTopicRc = await runMod.runDiverge({ root: defWs, direction: 'test', topic: '_flat', dry: true, noExitCode: true, captureOnly: true });
    assert.equal(badDivTopicRc, 1, 'P1 #1：runDiverge 必须拒绝 --topic _flat');
    fs.mkdirSync(path.join(defWs, 'ideas', '_flat', 'briefs'), { recursive: true });
    const snapNoDupFlat = tel.buildSwarmSnapshot(defWs, { topic: '_flat' });
    const flatTopicsCount = snapNoDupFlat.topics.filter((t) => t.id === '_flat').length;
    assert.equal(flatTopicsCount, 1, 'P1 #1：即使磁盘残留 ideas/_flat/，discoverTopics 中 _flat 也必须全局唯一且指向平铺根目录');

    // P1 #2：默认路由下 papers/novelty/<topic>/idea_01.md 若已被评审票/无关文件占用，必须拒写退 2 且不残留锁
    const defSubNovDir = path.join(p1LeadWs, 'papers', 'novelty', 'leadcheck');
    fs.mkdirSync(defSubNovDir, { recursive: true });
    const defSubNovPath = path.join(defSubNovDir, 'idea_01.md');
    fs.writeFileSync(
      defSubNovPath,
      '<!-- meta backend=codex brief=ideas/leadcheck/briefs/idea_01.md sha=' + leadSha + ' model=gpt-5 -->\nsubdir-review-sentinel\n',
      'utf8',
    );
    const defSubOverwriteRc = await runMod.runNovelty({
      root: p1LeadWs,
      brief: 'ideas/leadcheck/briefs/idea_01.md',
      dry: false,
      noExitCode: true,
      captureOnly: true,
    });
    assert.equal(defSubOverwriteRc, 2, 'P1 #2：默认子目录已存在非查重报告文件时 runNovelty 必须拒写退 2');
    assert.ok(fs.readFileSync(defSubNovPath, 'utf8').includes('subdir-review-sentinel'), 'P1 #2：被保护的子目录文件原文必须完好');
    assert.equal(
      fs.existsSync(path.join(defSubNovDir, '.idea_01.md.lock')),
      false,
      'P1 #2：默认子目录拒写后必须释放锁文件',
    );

    // P1 #5：checkNoveltyReport 必须拒绝无围栏纯 YAML 与单 ~~~ 围栏
    const rawNovDir = path.join(p1LeadWs, 'papers', 'novelty', 'raw_case');
    fs.mkdirSync(rawNovDir, { recursive: true });
    const rawNovPath = path.join(rawNovDir, 'idea_01.md');
    fs.writeFileSync(rawNovPath, [
      'idea_id: "idea_01"',
      'duplication_risk: low',
      'closest_works: []',
      'polish: "none"',
      'note: "arXiv 检索未发现撞车工作"',
      'confidence: 0.8',
      '',
    ].join('\n'), 'utf8');
    assert.equal(wf.checkNoveltyReport(rawNovPath).ok, false, 'P1 #5：无代码块围栏的裸 YAML 查重报告必须被拒收');
    const onlyTildeDir = path.join(p1LeadWs, 'papers', 'novelty', 'only_tilde');
    fs.mkdirSync(onlyTildeDir, { recursive: true });
    const onlyTildePath = path.join(onlyTildeDir, 'idea_01.md');
    fs.writeFileSync(onlyTildePath, [
      '~~~yaml',
      'idea_id: "idea_01"',
      'duplication_risk: low',
      'closest_works: []',
      'polish: "none"',
      'note: "arXiv 检索未发现撞车工作"',
      'confidence: 0.8',
      '~~~',
      '',
    ].join('\n'), 'utf8');
    assert.equal(wf.checkNoveltyReport(onlyTildePath).ok, false, 'P1 #5：单 ~~~ 围栏查重报告必须被拒收（仅接受 ```yaml）');

    // P1 #6：parseVerdictText 反向勾选 go ☑ kill ☐ 与多形态复选框精确解析
    assert.equal(val.parseVerdictText('# 裁决\n\ngo ☑  kill ☐\n').decision, 'go', 'P1 #6：反向勾选 go ☑ kill ☐ 必须解析为 go');
    assert.equal(val.parseVerdictText('# 裁决\n\ngo ☐  revise ☑  kill ☐\n').decision, 'revise', 'P1 #6：反向勾选中间项必须解析为 revise');
    assert.equal(val.parseVerdictText('# 裁决\n\n☐ go  ☑ kill\n').decision, 'kill', 'P1 #6：正向勾选 ☐ go ☑ kill 必须解析为 kill');
    assert.equal(val.parseVerdictText('# 裁决\n\n☐ go ☑\n').decision, null, 'P1 #6：同词前后未选+已选冲突必须判空');
    assert.equal(val.parseVerdictText('# 裁决\n\n☑ go ☐\n').decision, null, 'P1 #6：同词前后已选+未选冲突必须判空');
    assert.equal(val.parseVerdictText('# 裁决\n\nDecision: go\n- [x] kill\n').decision, null, 'P1 #6：Decision 与复选框冲突必须判空');

    // P2 #1 & New P2 #1：scanPendingVerdicts 拒绝冲突 votes: manifest（rc=1）且对仓外 ideas 目录联接 fail-closed（rc=1）
    const conflictStatusRes = val.scanPendingVerdicts(p1LeadWs, { topic: 'leadcheck' });
    assert.equal(conflictStatusRes.rc, 1, 'New P2 #1：含冲突 votes: codex / votes: none 的 manifest 必须让 status 返回 rc=1');
    assert.ok(conflictStatusRes.buckets.unchecked.includes('idea_01'), 'New P2 #1：冲突 votes: 轮次必须计入 unchecked 桶');
    if (process.platform === 'win32') {
      const escStatusWs = mkTmp('p2-ideas-escape');
      const escOutDir = mkTmp('p2-ideas-outside');
      fs.symlinkSync(escOutDir, path.join(escStatusWs, 'ideas'), 'junction');
      const escStatusRes = val.scanPendingVerdicts(escStatusWs);
      assert.equal(escStatusRes.rc, 1, 'P2-1：ideas 指向仓外联接时 scanPendingVerdicts 必须 fail-closed 退 1');
      assert.ok(escStatusRes.buckets.unchecked.includes('ideas'), 'P2-1：ideas 越界必须记录至 unchecked 桶');
    }

    // New P2 #3：file-lock 预置三层死亡残留（lock + .reap + .dead + 内层 .reap 守卫）也能自动自愈拿锁
    const lockMod = await import('../lib/file-lock.mjs');
    const lockWs = mkTmp('p2-deep-dead-lock');
    const lockPath = path.join(lockWs, 'target.lock');
    const deadPid = 99999991;
    const writeDeadRec = (p, tag) => {
      fs.writeFileSync(p, JSON.stringify({ pid: deadPid, at: Date.now() - 60000, nonce: tag }) + '\n', 'utf8');
      const r = lockMod.readLockRecord(p);
      const key = [r.ino || 0, Math.round(r.mtimeMs || 0), r.size || 0, r.pid || 0, r.at || 0, r.nonce || '', r.empty ? '1' : '0', r.corrupt ? '1' : '0'].join('|');
      return crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
    };
    const fp0 = writeDeadRec(lockPath, 'dead-lock');
    const claimPath = lockPath + '.reap.' + fp0;
    const cfp = writeDeadRec(claimPath, 'dead-claim');
    const metaPath = claimPath + '.dead.' + cfp;
    const mfp = writeDeadRec(metaPath, 'dead-meta');
    const guardPath = metaPath + '.reap.' + mfp;
    writeDeadRec(guardPath, 'dead-guard');
    let acquiredInside = false;
    lockMod.withExclusiveFileLock(lockPath, () => { acquiredInside = true; }, { timeoutMs: 3000, retryMs: 25 });
    assert.equal(acquiredInside, true, 'New P2 #3：即使内层 .dead.<cfp>.reap.<mfp> 守卫也归属死亡进程，锁必须自动自愈拿锁而非永久 BUSY');

    // New P2 #4：对象 effort='none'/'off' 对齐合法清空；syncPanelLineupToSeats 严拒非法 effort 且不落盘篡改 seats.json
    const tokNone = regMod.parseSlotSpecToken({ seat: 'codex', effort: 'none' });
    const tokOff = regMod.parseSlotSpecToken({ seat: 'codex', effort: 'off' });
    assert.equal(tokNone.effort, '', 'New P2 #4：对象 effort="none" 应合法清空');
    assert.equal(tokNone.invalidEffort, undefined, 'New P2 #4：对象 effort="none" 不得报 invalidEffort');
    assert.equal(tokOff.effort, '', 'New P2 #4：对象 effort="off" 应合法清空');
    assert.equal(tokOff.invalidEffort, undefined, 'New P2 #4：对象 effort="off" 不得报 invalidEffort');
    const seatsBeforeBadSync = fs.readFileSync(path.join(defWs, 'dispatch', 'seats.json'), 'utf8');
    const badPanelSync1 = regMod.syncPanelLineupToSeats(defWs, 'dispatch/seats.json', { reviewVotes: [{ seat: 'codex', effort: 'hgh' }] });
    assert.equal(badPanelSync1.ok, false, 'New P2 #4：面板写穿对象 reviewVotes 非法 effort 必须拒收');
    assert.equal(badPanelSync1.code, 'INVALID_EFFORT');
    const badPanelSync2 = regMod.syncPanelLineupToSeats(defWs, 'dispatch/seats.json', { scoutCommand: 'codex', scoutEffort: 'hgh' });
    assert.equal(badPanelSync2.ok, false, 'New P2 #4：面板写穿 scoutEffort 非法值必须拒收');
    assert.equal(badPanelSync2.code, 'INVALID_EFFORT');
    assert.equal(fs.readFileSync(path.join(defWs, 'dispatch', 'seats.json'), 'utf8'), seatsBeforeBadSync, 'New P2 #4：非法面板配置拒收后绝不得篡改磁盘 seats.json');

    // New P2（共享根目录歧义）：topic_a 与 topic_b 均含同 ID 同 SHA 工单，共享根 papers/novelty/idea_01.md 无 brief= 时双方均不得误归功
    fs.rmSync(path.join(isoWs, 'papers', 'novelty'), { recursive: true, force: true });
    fs.mkdirSync(path.join(isoWs, 'papers', 'novelty'), { recursive: true });
    fs.writeFileSync(path.join(isoWs, 'papers', 'novelty', 'idea_01.md'), [
      '<!-- meta role=novelty idea=idea_01 sha=' + sameBriefSha + ' -->',
      '```yaml',
      'idea_id: "idea_01"',
      'duplication_risk: low',
      'closest_works: []',
      'polish: "none"',
      'note: "arXiv 检索未发现撞车工作"',
      'confidence: 0.85',
      '```',
      '',
    ].join('\n'), 'utf8');
    const snapAmbA = tel.buildSwarmSnapshot(isoWs, { topic: 'topic_a' });
    const snapAmbB = tel.buildSwarmSnapshot(isoWs, { topic: 'topic_b' });
    assert.equal(snapAmbA.ideas.find((x) => x.ideaId === 'idea_01')?.hasNovelty, false, 'New P2：无 brief= 共享根查重报告在多课题同 SHA 歧义时不得归功 topic_a');
    assert.equal(snapAmbB.ideas.find((x) => x.ideaId === 'idea_01')?.hasNovelty, false, 'New P2：无 brief= 共享根查重报告在多课题同 SHA 歧义时不得归功 topic_b');

    // 13) 终审精简清单收口回归（真实现有 YAML flow mapping 报告 / novelty --topic _flat / effort=off / summary 根外目录拦截 / 首次平铺 S2 遥测可见）
    // (a) 本仓真实历史报告 papers/novelty/idea_12.md（含 YAML 行内映射 `- { venue, title, why_close }`）必须通过 checkNoveltyReport
    const realIdea12Nov = path.resolve(SRC, '..', '..', 'papers', 'novelty', 'idea_12.md');
    if (fs.existsSync(realIdea12Nov)) {
      const r12 = wf.checkNoveltyReport(realIdea12Nov);
      assert.equal(r12.ok, true, '收口 1：仓内真实查重报告 papers/novelty/idea_12.md 必须通过 checkNoveltyReport：' + r12.stderr);
      assert.equal(Array.isArray(r12.data?.closest_works) && r12.data.closest_works.length, 5, '收口 1：YAML flow mapping 应解析出全部 5 篇 closest_works');
      assert.ok(String(r12.data.closest_works[0]?.title || '').length > 0, '收口 1：每篇 flow mapping 必须解析出 title');
    }

    // (b) novelty idea_flat_only --topic _flat 按 ID 定位必须命中平铺 ideas/briefs/idea_flat_only.md（不得误查 ideas/_flat/briefs/）
    const flatNovRc = await runMod.runNovelty({
      root: defWs,
      brief: 'idea_flat_only',
      topic: '_flat',
      dry: true,
      noExitCode: true,
      captureOnly: true,
    });
    assert.equal(flatNovRc, 0, '收口 2：novelty <id> --topic _flat 必须命中平铺 ideas/briefs/<id>.md 并预演通过');

    // (c) effort='off' 阶段清空一致，且对象显式 effort='off' 不被 model@high 回填
    const offStagePlan = regMod.resolveStagePlan(badObjCfg, 'scout', { effort: 'off', useDshPatch: false });
    assert.equal(offStagePlan.ok, true, '收口 3：resolveStagePlan 必须接受 effort="off" 合法清空');
    assert.equal(offStagePlan.effortCleared, true, '收口 3：effort="off" 必须置 effortCleared=true');
    const tokOffOverride = regMod.parseSlotSpecToken({ seat: 'codex', model: 'gpt-5@high', effort: 'off' });
    assert.equal(tokOffOverride.model, 'gpt-5', '收口 3：应剥除 model 尾部 @high');
    assert.equal(tokOffOverride.effort, '', '收口 3：显式 effort="off" 绝不得被 model@high 回填成 high');

    // (d) summarizeTopic(writeFile: false) 传入仓外 briefsDir 必须拦截退 2
    const outsideSum = val.summarizeTopic(defWs, { briefsDir: '../outside-briefs', writeFile: false });
    assert.equal(outsideSum.ok, false, '收口 4：summarizeTopic(writeFile:false) 必须拒绝仓外 briefsDir');
    assert.equal(outsideSum.rc, 2);

    // (e) 仅存在 ideas/default/、平铺尚无文件时，首次平铺 S2 运行期间桌面快照可见 _flat 与 activeRun
    const freshFlatWs = mkTmp('flat-first-s2');
    wf.initProject(freshFlatWs, { topic: 'default', force: false });
    const flatS2Id = tel.startRunTelemetry(freshFlatWs, {
      stage: 'S2',
      topic: '_flat',
      targetId: '_flat',
      workers: [{ tag: 'codex', seat: 'codex', status: 'working', startedAt: Date.now() }],
    });
    const snapFreshFlat = tel.buildSwarmSnapshot(freshFlatWs);
    assert.ok(snapFreshFlat.topics.some((t) => t.id === '_flat'), '收口 6：首次平铺 S2 运行时 discoverTopics 必须暴露 _flat 课题');
    assert.equal(snapFreshFlat.activeRun && snapFreshFlat.activeRun.topic, '_flat', '收口 6：桌面快照应自动聚焦正在运行的首次平铺 S2 任务');
    tel.finishRunTelemetry(freshFlatWs, flatS2Id, { status: 'done', rc: 0 });
  });

} finally {
  for (const d of TMP_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略清理异常 */ }
  }
}

console.log();
if (fails > 0) {
  console.log('✗ ' + fails + '/' + checks + ' 条断言失守 —— v2.0.0 全链路工作流自检未通过');
  process.exit(1);
}
console.log('全部 ' + checks + ' 条断言通过（workflow v2.0.0 全链路纯 Node 闭环与沙箱隔离，零联网零外部桩）');
