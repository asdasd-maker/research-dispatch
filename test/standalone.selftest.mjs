// 独立净室端到端与 P0~P2 全量回归自检（零外部网络、零 Python/Bash 桩脚本、不碰工作树）。
//
//   node plugin/research-dispatch/test/standalone.selftest.mjs
//
// 覆盖重点：
//   1. README 3 步净室开箱全链路（无 dispatch/*.{sh,py}、无 roles/reviewer.md、无 DSH_DISPATCH_BASH）
//   2. 纯 Node validators.mjs 六大能力边界（checkAnchor / extractCardVerdict / checkCardFile / scanPendingVerdicts / maskSecrets / apiChatCompletion）
//   3. 本地回环 HTTP Mock 下的纯 Node API 多座异构出票、P0-4 自定义 API 座名白名单、choices:null 防崩与 sk-* 脱敏
//   4. P0-3 面板契约、P0-5 同模型塌缩归一化、P0-6 PARTIAL 退 1、P1-1 防伪、P1-2 点号 ID 拦截、P1-7 增量 VOID 保卡、P1-8 超长工单与超时树清理、P2-8 安全导入
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

const validators = await import(pathToFileURL(path.join(SRC, 'lib', 'validators.mjs')).href);
const ft = await import(pathToFileURL(path.join(SRC, 'lib', 'flow-tools.mjs')).href);
const models = await import(pathToFileURL(path.join(SRC, 'lib', 'models.mjs')).href);
const registry = await import(pathToFileURL(path.join(SRC, 'lib', 'registry.mjs')).href);
const { run, buildDshModelOverrideFiles, quoteWinCmdToken } = await import(pathToFileURL(path.join(SRC, 'lib', 'run.mjs')).href);

let checks = 0;
let fails = 0;
const ok = (m) => { checks++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { checks++; fails++; console.log('  \x1b[31m✗\x1b[0m ' + m); };
const t = (name, fn) => { try { fn(); ok(name); } catch (e) { bad(name + ' —— ' + (e && e.message)); } };
const ta = async (name, fn) => { try { await fn(); ok(name); } catch (e) { bad(name + ' —— ' + (e && e.message)); } };

const TMP_DIRS = [];
function mkTmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-standalone-' + tag + '-'));
  TMP_DIRS.push(d);
  return d;
}

function validCardMarkdown(ideaId, verdict = 'go', extraReason = '') {
  return [
    '对工单的扼要独立评述：基线数值清晰，证伪边界明确。' + extraReason,
    '',
    '```yaml',
    'idea_id: ' + ideaId,
    'novelty:',
    '  score: 4',
    '  reason: "余弦温度缩放切入最后两个 stage 的校准特征层，区别于常规后处理温度标定。"',
    'feasibility:',
    '  score: 4',
    '  reason: "单卡 CIFAR-100 200 epochs 对照可在数小时内跑完 3 seeds，无额外数据依赖。"',
    'baseline_fit:',
    '  score: 5',
    '  reason: "直接对齐 ResNet-50 78.4%±0.2% 基线，训练超参保持严格一致。"',
    'impl_cost:',
    '  score: 4',
    '  reason: "仅替换分类头前特征归一化层，改动集中且易回滚。"',
    'expected_gain:',
    '  score: 3',
    '  reason: "ECE 下降 ≥1.5% 的预期合理，Top-1 波动可控。"',
    'verdict: ' + verdict,
    'kill_reason: ' + (verdict === 'kill' ? '"证伪条件在既有文献中已被证伪，无需重跑。"' : 'null'),
    'confidence: 0.8',
    'missing_info: []',
    'top_risk: "温度参数在训练早期可能引起梯度幅值抖动，需监控前 10 个 epoch。"',
    'next_minimal_action: "先在单 seed 上验证前 20 epochs 损失曲线稳定性，再跑满 3 seeds。"',
    '```',
    '',
  ].join('\n');
}

function cleanChildEnv(root, extra = {}) {
  const env = { ...process.env };
  for (const k of [
    'DSH_DISPATCH_BASH', 'RESEARCH_DISPATCH_BASH', 'DSH_DISPATCH_ROOT',
    'DSH_DISPATCH_CONFIG', 'DSH_DISPATCH_SETTINGS', 'DSH_DISPATCH_USE_PATCH', 'RESEARCH_DISPATCH_DIAG',
    'BACKENDS', 'REVIEW_LINEUP', 'SCOUT_AGENT', 'DIVERGE_AGENT', 'NOVELTY_AGENT',
    'DRY', 'CALIBRATION', 'API_VOTES', 'ALLOW_DOOMED_PLAN',
    'CODEX_MODEL', 'CLAUDE_MODEL', 'GEMINI_MODEL', 'KIMI_MODEL', 'DSH_MODEL', 'API_MODEL',
    'CODEX_CFG', 'CLAUDE_CFG', 'GEMINI_CFG', 'KIMI_CFG', 'DSH_SETTINGS', 'DSH_PROFILE', 'GEMINI_CLI_PKG_DIR',
    'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'QODER_SEAT_MODEL', 'QODER_ATTEST_SHA',
    'MANUAL1_BODY', 'MANUAL1_MODEL', 'MANUAL1_SHA', 'MANUAL2_MODEL', 'MANUAL2_SHA',
  ]) {
    delete env[k];
  }
  const fakeHome = path.join(root, '.clean-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  Object.assign(env, {
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    DSH_HOME: path.join(fakeHome, '.dsh'),
    DSH_DISPATCH_SETTINGS: path.join(fakeHome, 'nonexistent-cordis.patch.yml'),
    ...extra,
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
    env: cleanChildEnv(cwd, extraEnv),
    timeout: 60000,
    windowsHide: true,
  });
  return { rc: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: (r.stdout || '') + (r.stderr || '') };
}

function runCliAsync(cwd, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: cleanChildEnv(cwd, extraEnv),
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

try {
  // ── 1) README 3 步净室开箱全链路（零外部脚本、零 roles/reviewer.md、零 DSH_DISPATCH_BASH）──
  console.log('── 1) 净室 README 3 步开箱全链路（P0-2 / GP-03 / GP-06 / GP-12）');
  const ws = mkTmp('quickstart');
  t('无 seats.json 时 stage-model / stage-exec / stages 正常退 0，plan 无参先报用法退 1（GP-12）', () => {
    assert.equal(runCli(ws, ['stage-model', 'diverge']).rc, 0);
    assert.equal(runCli(ws, ['stage-exec', 'diverge']).rc, 0);
    assert.equal(runCli(ws, ['stages']).rc, 0);
    const pNoArg = runCli(ws, ['plan']);
    assert.equal(pNoArg.rc, 1, 'plan 无参应退 1，实得 ' + pNoArg.rc + ': ' + pNoArg.out);
    assert.ok(pNoArg.out.includes('用法: dispatch.mjs plan'));
  });

  // 按 README 第 1 步拷入 examples/seats.example.json 并手写普通工单（不建 roles/ 与 dispatch/*.sh）
  fs.mkdirSync(path.join(ws, 'dispatch'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'ideas', 'briefs'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'ideas', 'cards'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'workers'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'examples', 'seats.example.json'), path.join(ws, 'dispatch', 'seats.json'));
  fs.writeFileSync(path.join(ws, 'ideas', 'briefs', 'idea_01.md'), [
    '<!-- meta role=brief idea=idea_01 anchor=none -->',
    '## 待评审材料（唯一输入）',
    '',
    '### Baseline',
    'ResNet-50 在 CIFAR-100 Top-1 准确率为 78.4%（3 seeds 均值 ±0.2%）。',
    '',
    '### Idea',
    '**ID**: idea_01',
    '- 假设：余弦温度缩放可使 ECE 下降 ≥1.5%。',
    '',
  ].join('\n'));
  // 同时验证不写 <!-- meta 头部的纯手写工单在轻量模式下同样畅通
  fs.writeFileSync(path.join(ws, 'ideas', 'briefs', 'handwritten.md'), [
    '## 待评审材料',
    '### Baseline',
    'F1 = 84.2%',
    '### Idea',
    '测试纯手写无 meta 注释工单。',
  ].join('\n'));

  await ta('净室 classify 认领为 ours，status 走内置 scanPendingVerdicts 返回 ok:true, rc:0', async () => {
    const c = await ft.dispatchFlow({ action: 'classify' }, { repoRoot: ws });
    assert.equal(c.ok, true);
    assert.equal(c.class, 'ours');
    const s = await ft.dispatchFlow({ action: 'status' }, { repoRoot: ws });
    assert.equal(s.ok, true);
    assert.equal(s.rc, 0);
    assert.equal(s.has_pending, false);
  });

  t('seats.example.json 开箱可用：manual1/manual2 未配时 identity 为 unknown-check-config 且 proven=false（GP-06）', () => {
    const seatsRes = runCli(ws, ['seats']);
    assert.equal(seatsRes.rc, 0, seatsRes.out);
    const parsedSeats = JSON.parse(seatsRes.stdout);
    const m1 = parsedSeats.seats.find((s) => s.id === 'manual1');
    assert.ok(m1, '应包含 manual1 示例座');
    assert.equal(m1.identity, 'unknown-check-config');

    const planM1 = runCli(ws, ['plan', 'ideas/briefs/idea_01.md'], { BACKENDS: 'manual1 manual2' });
    assert.equal(planM1.rc, 0, planM1.out);
    const pJson = JSON.parse(planM1.stdout);
    assert.equal(pJson.plan.length, 2);
    assert.equal(pJson.plan[0].proven, false, '未配置的 manual1 绝不能谎报 proven:true');
    assert.equal(pJson.plan[0].declared_env, 'MANUAL1_MODEL');
    assert.equal(pJson.plan[1].proven, false);
    assert.equal(pJson.plan[1].declared_env, 'MANUAL2_MODEL', '{SEAT_UPPER} 模板应对 manual2 展开为 MANUAL2_MODEL');
  });

  await ta('净室无 roles/reviewer.md 时 DRY=1 run 与 preview 自动回退内置 examples/reviewer.md 并退 0', async () => {
    // 准备一个开启纯 Node API 座的配置（带假凭据即可通过 DRY 预演，零联网）
    const dryCfg = JSON.parse(fs.readFileSync(path.join(ws, 'dispatch', 'seats.json'), 'utf8'));
    const apiSeat = dryCfg.seats.find((s) => s.id === 'api');
    apiSeat.enabled = true;
    delete dryCfg.lineup;
    dryCfg.default_backends = ['api'];
    const customSeatsRel = 'dispatch/seats.api-dry.json';
    fs.writeFileSync(path.join(ws, customSeatsRel), JSON.stringify(dryCfg, null, 2));

    const r1 = runCli(ws, ['run', 'ideas/briefs/idea_01.md'], {
      DSH_DISPATCH_CONFIG: customSeatsRel,
      DRY: '1',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      OPENAI_API_KEY: 'sk-dryrun-placeholder-key',
      API_MODEL: 'deepseek/deepseek-chat',
    });
    assert.equal(r1.rc, 0, '净室 DRY=1 应退 0，实得 ' + r1.rc + '：\n' + r1.out);

    // 验证独立轻量模式下缺带数值的 ### Baseline 仍按契约退 8；且 BRIEF_BLOCK 含 #/## 一二级标题不被误截断
    fs.writeFileSync(path.join(ws, 'ideas', 'briefs', 'idea_nobase.md'), '<!-- meta role=brief idea=idea_nobase anchor=none -->\n### Idea\n**ID**: idea_nobase\n');
    assert.equal(runCli(ws, ['run', 'ideas/briefs/idea_nobase.md'], { DSH_DISPATCH_CONFIG: customSeatsRel, DRY: '1' }).rc, 8);
    fs.writeFileSync(path.join(ws, 'ideas', 'briefs', 'idea_h1base.md'), [
      '<!-- meta role=brief idea=idea_h1base anchor=none -->',
      '### Baseline',
      '# Baseline：MMDiT 视频生成基线',
      '## 指标口径',
      '已复现 FVD = 415（±5）',
      '### Idea',
      '**ID**: idea_h1base',
    ].join('\n'));
    assert.equal(runCli(ws, ['run', 'ideas/briefs/idea_h1base.md'], {
      DSH_DISPATCH_CONFIG: customSeatsRel,
      DRY: '1',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      OPENAI_API_KEY: 'sk-dryrun-placeholder-key',
      API_MODEL: 'deepseek/deepseek-chat',
    }).rc, 0, 'Baseline 内嵌 # / ## 标题绝不能截断数值检查');
    fs.rmSync(path.join(ws, 'ideas', 'briefs', 'idea_nobase.md'), { force: true });
    fs.rmSync(path.join(ws, 'ideas', 'briefs', 'idea_h1base.md'), { force: true });
    assert.ok(r1.out.includes('examples/reviewer.md'), '应提示回退内置 examples/reviewer.md，实得：\n' + r1.out);

    const rHand = runCli(ws, ['run', 'ideas/briefs/handwritten.md'], {
      DSH_DISPATCH_CONFIG: customSeatsRel,
      DRY: '1',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      OPENAI_API_KEY: 'sk-dryrun-placeholder-key',
      API_MODEL: 'deepseek/deepseek-chat',
    });
    assert.equal(rHand.rc, 0, '纯手写无 meta 工单在 require_anchor:false 下也应畅通退 0：\n' + rHand.out);

    // 验证 dispatchFlow preview 直接进程内调用 run()
    const prevBase = process.env.OPENAI_BASE_URL;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
    process.env.OPENAI_API_KEY = 'sk-dryrun-placeholder-key';
    try {
      const pv = await ft.dispatchFlow(
        { action: 'preview', brief: 'ideas/briefs/idea_01.md', calibration: 'false' },
        { repoRoot: ws, seatsFile: customSeatsRel },
      );
      assert.equal(pv.ok, true, '内置 preview 应返回 ok:true：' + JSON.stringify(pv));
      assert.equal(pv.rc, 0);
    } finally {
      if (prevBase === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = prevBase;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    }
  });

  // ── 2) 纯 Node validators.mjs 完备性核验 ───────────────────────────────
  console.log('── 2) 纯 Node validators.mjs 边界与契约（P0-2 / P1-9）');
  t('checkAnchor：smoke_ 校准优先豁免、none 放行、越界退 2、缺 REPRO 退 4、未签字退 1、已签字退 0', () => {
    const aRoot = mkTmp('anchor');
    // 无 baselines 目录时 smoke_01 + calibration:true 直接豁免退 0
    assert.equal(validators.checkAnchor(aRoot, 'baselines/missing', { briefId: 'smoke_01', calibration: true }).rc, 0);
    assert.equal(validators.checkAnchor(aRoot, 'none').rc, 0);
    assert.equal(validators.checkAnchor(aRoot, '../outside').rc, 2);
    assert.equal(validators.checkAnchor(aRoot, 'baselines/missing').rc, 4);

    const bDir = path.join(aRoot, 'baselines', 'b1');
    fs.mkdirSync(bDir, { recursive: true });
    fs.writeFileSync(path.join(bDir, 'REPRO.md'), [
      '## 3. 关键指标',
      '| metric | 论文报告 | 我复现 | 容差 | 判定 |',
      '|---|---|---|---|---|',
      '| top1 | 78.4 | 78.3 | ±0.2 | ok |',
      '## 4. 人验收签字',
      'SIGNOFF: ________',
    ].join('\n'));
    assert.equal(validators.checkAnchor(aRoot, 'baselines/b1').rc, 1);

    fs.writeFileSync(path.join(bDir, 'REPRO.md'), [
      '## 3. 关键指标',
      '| metric | 论文报告 | 我复现 | 容差 | 判定 |',
      '|---|---|---|---|---|',
      '| top1 | 78.4 | 78.3 | ±0.2 | ok |',
      '## 4. 人验收签字',
      'SIGNOFF: PASS (verified)',
    ].join('\n'));
    const passRes = validators.checkAnchor(aRoot, 'baselines/b1');
    assert.equal(passRes.ok, true);
    assert.equal(passRes.rc, 0);
  });

  t('extractCardVerdict：免疫围栏前散文与多行标量内伪 verdict，支持流式映射并拒收未闭合围栏（DT-02）', () => {
    const tricky = [
      '前言讨论：如果只看表面可能会写 verdict: go，但下面看严密分析。',
      '```yaml',
      'idea_id: old_draft',
      'verdict: go',
      '```',
      '修正后的最终裁决如下：',
      '```yaml',
      'idea_id: idea_01',
      'novelty:',
      '  score: 2',
      '  reason: |',
      '    不能给 verdict: go，因为基线对比缺失。',
      'verdict: "KILL" # 行尾注释',
      '```',
    ].join('\n');
    const ex = validators.extractCardVerdict(tricky);
    assert.equal(ex.found, true);
    assert.equal(ex.verdict, 'kill');
    assert.equal(ex.data.idea_id, 'idea_01');

    const flow = validators.extractCardVerdict('```yaml\n{idea_id: idea_02, verdict: Revise}\n```');
    assert.equal(flow.verdict, 'revise');

    const unclosed = validators.extractCardVerdict('```yaml\nidea_id: idea_01\nverdict: go\n');
    assert.equal(unclosed.found, false, '未闭合截断围栏不应放行');
  });

  t('checkCardFile：合规卡退 0；布尔分值 / 占位符 / 错 ID / 缺 kill_reason / 尾部超长散文退 1；缺失文件退 2', () => {
    const cDir = mkTmp('cards');
    const goodPath = path.join(cDir, 'idea_01.codex.md');
    fs.writeFileSync(goodPath, validCardMarkdown('idea_01', 'go'));
    const g = validators.checkCardFile(goodPath);
    assert.equal(g.ok, true, g.stderr);
    assert.equal(g.rc, 0);

    // 布尔分值 yes
    const boolPath = path.join(cDir, 'idea_01.bool.md');
    fs.writeFileSync(boolPath, validCardMarkdown('idea_01', 'go').replace('score: 4', 'score: yes'));
    const bRes = validators.checkCardFile(boolPath);
    assert.equal(bRes.rc, 1);
    assert.ok(bRes.stderr.includes('✗'));

    // 占位符理由
    const todoPath = path.join(cDir, 'idea_01.todo.md');
    fs.writeFileSync(todoPath, validCardMarkdown('idea_01', 'go').replace(/reason: "[^"]+"/, 'reason: "TODO"'));
    assert.equal(validators.checkCardFile(todoPath).rc, 1);

    // idea_id 与文件名不一致
    const wrongIdPath = path.join(cDir, 'idea_99.codex.md');
    fs.writeFileSync(wrongIdPath, validCardMarkdown('idea_01', 'go'));
    assert.equal(validators.checkCardFile(wrongIdPath).rc, 1);

    // kill 缺 kill_reason
    const noKillReason = path.join(cDir, 'idea_01.kill.md');
    fs.writeFileSync(noKillReason, validCardMarkdown('idea_01', 'kill').replace(/^kill_reason:.*$/m, 'kill_reason: null'));
    assert.equal(validators.checkCardFile(noKillReason).rc, 1);

    // 围栏后超 30 字散文
    const chatty = path.join(cDir, 'idea_01.chatty.md');
    fs.writeFileSync(chatty, validCardMarkdown('idea_01', 'go') + '\n补充一段超过三十个字符的客套总结散文，这在严苛契约下必须被拒收。\n');
    assert.equal(validators.checkCardFile(chatty).rc, 1);

    // 文件不存在
    assert.equal(validators.checkCardFile(path.join(cDir, 'missing.md')).rc, 2);
  });

  t('maskSecrets：完整脱敏 Bearer / sk-* / rk-* / api_key= / URL 内嵌密码', () => {
    const raw = 'Authorization: Bearer sk-test-proj-AbCdEfGh1234567890 api_key="rk-9876543210abcdef" https://user:mySecretPass@api.example.com/v1';
    const masked = validators.maskSecrets(raw);
    assert.ok(!masked.includes('sk-test-proj-AbCdEfGh1234567890'));
    assert.ok(!masked.includes('rk-9876543210abcdef'));
    assert.ok(!masked.includes('mySecretPass'));
    assert.ok(masked.includes('[REDACTED]'));
  });

  // ── 3) 本地 HTTP Mock 纯 Node API 端到端出票 + P0-4 + P0-6 + 密钥脱敏 ──
  console.log('── 3) 纯 Node 内置 HTTP API 多座评审全链路（P0-4 / P0-6 / P1-10）');
  await ta('自定义 API 座名异构双票 → rc=0 落盘通过；模板裁决算未决 → 真实裁决清零；401 密钥脱敏；choices:null 退 2；PARTIAL 退 1', async () => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const auth = String(req.headers.authorization || '');
        if (auth.includes('sk-trigger-401-secret9999')) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid key sk-trigger-401-secret9999 in ' + auth } }));
          return;
        }
        const parsed = JSON.parse(body || '{}');
        if (parsed.model === 'broken/null-choices') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'cmpl-null', choices: null }));
          return;
        }
        const verdict = parsed.model.includes('claude') ? 'revise' : 'go';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'cmpl-ok',
          choices: [{ finish_reason: 'stop', message: { content: validCardMarkdown('idea_01', verdict) } }],
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = 'http://127.0.0.1:' + port + '/v1';

    try {
      const apiWs = mkTmp('api-e2e');
      fs.mkdirSync(path.join(apiWs, 'dispatch'), { recursive: true });
      fs.mkdirSync(path.join(apiWs, 'ideas', 'briefs'), { recursive: true });
      fs.mkdirSync(path.join(apiWs, 'ideas', 'cards'), { recursive: true });
      fs.writeFileSync(path.join(apiWs, 'ideas', 'briefs', 'idea_01.md'), [
        '<!-- meta role=brief idea=idea_01 anchor=none -->',
        '### Baseline',
        'Top-1 = 78.4%',
        '### Idea',
        '**ID**: idea_01',
      ].join('\n'));

      // P0-4：两个非 'api' 字面量的自定义纯 Node API 座（无 script 字段！）
      fs.writeFileSync(path.join(apiWs, 'dispatch', 'seats.json'), JSON.stringify({
        version: 1,
        paths: { cards_dir: 'ideas/cards', workers_dir: 'workers', require_anchor: false },
        default_backends: ['deepseek_api', 'claude_api'],
        seats: [
          {
            id: 'deepseek_api',
            kind: 'api',
            enabled: true,
            base_env_default: 'MOCK_BASE_URL',
            key_env_default: 'MOCK_KEY_1',
            model: { env: 'MOCK_MDL_1', default: 'deepseek/deepseek-r1' },
            votes: { env: 'API_VOTES', default: 1 },
            temperature: { env: 'API_TEMPERATURE', default: '0.3' },
            identity: { kind: 'api' },
          },
          {
            id: 'claude_api',
            kind: 'api',
            enabled: true,
            base_env_default: 'MOCK_BASE_URL',
            key_env_default: 'MOCK_KEY_2',
            model: { env: 'MOCK_MDL_2', default: 'anthropic/claude-sonnet-4' },
            votes: { env: 'API_VOTES', default: 1 },
            temperature: { env: 'API_TEMPERATURE', default: '0.3' },
            identity: { kind: 'api' },
          },
        ],
      }, null, 2));

      // 3a) 双座全通 → rc=0，两张自定义名卡片落盘，不被 buildWhitelist 误杀！
      const okRun = await runCliAsync(apiWs, ['run', 'ideas/briefs/idea_01.md'], {
        MOCK_BASE_URL: baseUrl,
        MOCK_KEY_1: 'sk-valid-key-alpha-12345678',
        MOCK_KEY_2: 'sk-valid-key-beta-12345678',
      });
      assert.equal(okRun.rc, 0, '双纯 Node API 座应退 0，实得 ' + okRun.rc + '：\n' + okRun.out);
      assert.ok(fs.existsSync(path.join(apiWs, 'ideas', 'cards', 'idea_01.deepseek_api.md')));
      assert.ok(fs.existsSync(path.join(apiWs, 'ideas', 'cards', 'idea_01.claude_api.md')));
      const man1 = fs.readFileSync(path.join(apiWs, 'ideas', 'cards', 'idea_01.manifest'), 'utf8');
      assert.ok(man1.includes('status=OK'), man1);
      assert.ok(man1.includes('priors: claude-sonnet-4 deepseek-r1'), man1);

      // 3b) scanPendingVerdicts：未写 verdict 时 rc=1；写模板态仍 rc=1；写明确决定后 rc=0
      assert.equal(validators.scanPendingVerdicts(apiWs).rc, 1);
      fs.writeFileSync(path.join(apiWs, 'ideas', 'verdict-idea_01.md'), '决定: go | revise | kill\n');
      assert.equal(validators.scanPendingVerdicts(apiWs).rc, 1, '模板占位符不应算作已完成裁决');
      fs.writeFileSync(path.join(apiWs, 'ideas', 'verdict-idea_01.md'), '决定: go\n理由：双票异构先验支持推进。\n');
      assert.equal(validators.scanPendingVerdicts(apiWs).rc, 0, '明确裁决后待办应清零');

      // 3c) P0-6：第二座缺 API_KEY 跳过 → PARTIAL(1/2) 必须退 rc=1（绝不能静默退 0！）
      fs.rmSync(path.join(apiWs, 'ideas', 'cards'), { recursive: true, force: true });
      fs.mkdirSync(path.join(apiWs, 'ideas', 'cards'), { recursive: true });
      const partialRun = await runCliAsync(apiWs, ['run', 'ideas/briefs/idea_01.md'], {
        MOCK_BASE_URL: baseUrl,
        MOCK_KEY_1: 'sk-valid-key-alpha-12345678',
      });
      assert.equal(partialRun.rc, 1, 'P0-6：PARTIAL(1/2) 降级轮必须退 1，实得 ' + partialRun.rc + '：\n' + partialRun.out);
      const manPartial = fs.readFileSync(path.join(apiWs, 'ideas', 'cards', 'idea_01.manifest'), 'utf8');
      assert.ok(manPartial.includes('status=PARTIAL(1/2)'), manPartial);

      // 3d) HTTP 401 回显密钥 → .err 落盘必须被 maskSecrets 脱敏
      fs.rmSync(path.join(apiWs, 'ideas', 'cards'), { recursive: true, force: true });
      fs.mkdirSync(path.join(apiWs, 'ideas', 'cards'), { recursive: true });
      const errRun = await runCliAsync(apiWs, ['run', 'ideas/briefs/idea_01.md'], {
        BACKENDS: 'deepseek_api',
        MOCK_BASE_URL: baseUrl,
        MOCK_KEY_1: 'sk-trigger-401-secret9999',
      });
      assert.equal(errRun.rc, 2);
      const errFile = path.join(apiWs, 'ideas', 'cards', 'idea_01.deepseek_api.err');
      assert.ok(fs.existsSync(errFile), '失败时应保留 .err 诊断文件');
      const errContent = fs.readFileSync(errFile, 'utf8');
      assert.ok(!errContent.includes('sk-trigger-401-secret9999'), '.err 文件严禁残留明文 sk-* 密钥：' + errContent);
      assert.ok(errContent.includes('[REDACTED]'));

      // 3e) choices: null 畸形响应 → 安全退 2，不抛 TypeError 栈
      fs.rmSync(path.join(apiWs, 'ideas', 'cards'), { recursive: true, force: true });
      fs.mkdirSync(path.join(apiWs, 'ideas', 'cards'), { recursive: true });
      const nullChoicesRun = await runCliAsync(apiWs, ['run', 'ideas/briefs/idea_01.md'], {
        BACKENDS: 'deepseek_api',
        MOCK_BASE_URL: baseUrl,
        MOCK_KEY_1: 'sk-valid-key-alpha-12345678',
        MOCK_MDL_1: 'broken/null-choices',
      });
      assert.equal(nullChoicesRun.rc, 2);
      assert.ok(!/TypeError/.test(nullChoicesRun.out), nullChoicesRun.out);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // ── 4) P0-3 / P0-5 / P1 / P2 核心回归防线 ─────────────────────────────
  console.log('── 4) P0-3 面板契约、P0-5 防塌缩、P1 防伪/保卡/超长工单/超时回收与 P2-8 安全导入');
  t('P0-5：normModel 统一剥除 -manual-attested 与多层路由前缀及大小写（防同模型伪装异构）', () => {
    assert.equal(models.normModel('openai/gpt-5'), 'gpt-5');
    assert.equal(models.normModel('gpt-5-from-config'), 'gpt-5');
    assert.equal(models.normModel('gpt-5-manual-attested'), 'gpt-5');
    assert.equal(models.normModel('dsh:openrouter/openai/GPT-5-explicit'), 'gpt-5');
    assert.equal(models.modelFamily('magpie-anthropic/claude-sonnet-4-20250514'), 'claude');
  });

  t('P0-3 & GP-03：cordis.patch.yml 支持 repoRoot/seatsFile；reviewVotes 全为无效座退 2；dsh/api 面板选模一致透传至 plan 与 run', () => {
    const pWs = mkTmp('panel');
    const altCaller = mkTmp('caller-empty');
    fs.mkdirSync(path.join(pWs, 'custom-cfg'), { recursive: true });
    fs.mkdirSync(path.join(pWs, 'ideas', 'briefs'), { recursive: true });
    fs.writeFileSync(path.join(pWs, 'ideas', 'briefs', 'idea_01.md'), '### Baseline\nAcc 80%\n### Idea\nx\n');
    fs.writeFileSync(path.join(pWs, 'custom-cfg', 'my-seats.json'), JSON.stringify({
      version: 1,
      paths: { cards_dir: 'ideas/cards', workers_dir: 'workers', require_anchor: false },
      default_backends: ['codex', 'claude'],
      seats: [
        { id: 'codex', kind: 'cli', enabled: true, command: 'node', argv: ['-v'], identity: { kind: 'config', explicit_env: 'CODEX_MODEL' } },
        { id: 'dsh', kind: 'cli', enabled: true, command: 'node', argv: ['-v'], identity: { kind: 'settings' } },
        { id: 'api', kind: 'api', enabled: true, base_env_default: 'OPENAI_BASE_URL', key_env_default: 'OPENAI_API_KEY', model: { env: 'API_MODEL', default: 'deepseek-chat' }, votes: { env: 'API_VOTES', default: 1 }, temperature: { env: 'API_TEMPERATURE', default: '0.5' }, identity: { kind: 'api' } },
        {
          id: 'manual1',
          kind: 'delivery',
          enabled: true,
          seat_pattern: 'manual[0-9]+',
          body_env: '{SEAT_UPPER}_BODY',
          model_env: '{SEAT_UPPER}_MODEL',
          attest_sha_env: '{SEAT_UPPER}_SHA',
          identity: { kind: 'manual' },
        },
      ],
    }, null, 2));

    // 1) 面板配了不存在座位的 subagent → plan 与 run 均 fail-closed 退 2，绝不静默回退跑默认付费座！
    const badPatch = path.join(pWs, 'bad.patch.yml');
    fs.writeFileSync(badPatch, [
      '- id: research-dispatch',
      '  config:',
      '    repoRoot: ' + JSON.stringify(pWs),
      '    seatsFile: custom-cfg/my-seats.json',
      '    reviewVotes: "subagent:magpie/glm-5"',
    ].join('\n'));
    assert.equal(runCli(altCaller, ['plan', 'ideas/briefs/idea_01.md'], { DSH_DISPATCH_SETTINGS: badPatch }).rc, 2);
    assert.equal(runCli(altCaller, ['run', 'ideas/briefs/idea_01.md'], { DSH_DISPATCH_SETTINGS: badPatch, DRY: '1' }).rc, 2);

    // 2) 面板配 dsh:magpie/glm-5,api:openai/gpt-5 → 在无关目录 altCaller 下通过 repoRoot+seatsFile 定位并精确注入双座模型
    const goodPatch = path.join(pWs, 'good.patch.yml');
    fs.writeFileSync(goodPatch, [
      '- id: research-dispatch # 行尾注释兼容',
      '  config:',
      '    seatsFile: custom-cfg/my-seats.json',
      '    repoRoot: ' + JSON.stringify(pWs),
      '    reviewVotes: "dsh:magpie/glm-5,api:openai/gpt-5"',
    ].join('\n'));
    const pl = runCli(altCaller, ['plan', 'ideas/briefs/idea_01.md'], { DSH_DISPATCH_SETTINGS: goodPatch });
    assert.equal(pl.rc, 0, pl.out);
    const plObj = JSON.parse(pl.stdout);
    assert.equal(plObj.plan.length, 2);
    assert.equal(plObj.plan[0].seat, 'dsh');
    assert.equal(plObj.plan[0].identity, 'magpie/glm-5-explicit');
    assert.equal(plObj.plan[1].seat, 'api');
    assert.equal(plObj.plan[1].identity, 'openai/gpt-5');

    // 3) P0-3 真机契约：buildDshModelOverrideFiles 写入 patch 的 agent-default-model.config.model 必须是剥去 provider/ 的 bareModel（防 UNKNOWN_MODEL）
    const ovDir = path.join(pWs, 'dsh-ov');
    fs.mkdirSync(ovDir, { recursive: true });
    const ov = buildDshModelOverrideFiles(ovDir, '', 'jiyuan/glm-5-override');
    const ovPatchTxt = fs.readFileSync(ov.patchFile, 'utf8');
    const ovSettingsTxt = fs.readFileSync(ov.settingsFile, 'utf8');
    assert.ok(ovPatchTxt.includes('provider: "jiyuan"'), ovPatchTxt);
    assert.ok(ovPatchTxt.includes('model: "glm-5-override"'), 'patch 中 model 必须为 bareModel，实得：\n' + ovPatchTxt);
    assert.ok(!ovPatchTxt.includes('jiyuan/glm-5-override'), 'patch 严禁带 provider/ 前缀触发 pi-ai UNKNOWN_MODEL');
    assert.ok(!ovPatchTxt.includes('reasoningEffort'), '不应注入 reasoningEffort: null');
    assert.ok(ovSettingsTxt.includes('model: "glm-5-override"'), ovSettingsTxt);

    // 4) models.dshLiveModel 未设 DSH_PROFILE 时按 headless → 根 cordis.patch.yml → desktop 回退
    const fakeDshHome = path.join(pWs, 'fake-dsh-home');
    fs.mkdirSync(path.join(fakeDshHome, 'profiles', 'desktop'), { recursive: true });
    fs.mkdirSync(path.join(fakeDshHome, 'profiles', 'headless'), { recursive: true });
    fs.writeFileSync(path.join(fakeDshHome, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: agent-default-model\n  config:\n    provider: desk\n    model: m-desk\n');
    const prevDshHome = process.env.DSH_HOME;
    const prevDshProfile = process.env.DSH_PROFILE;
    const prevDshSettings = process.env.DSH_SETTINGS;
    try {
      process.env.DSH_HOME = fakeDshHome;
      delete process.env.DSH_PROFILE;
      delete process.env.DSH_SETTINGS;
      assert.equal(models.dshLiveModel(), 'desk/m-desk');
      fs.writeFileSync(path.join(fakeDshHome, 'cordis.patch.yml'), '- id: agent-default-model\n  config:\n    provider: rootp\n    model: m-root\n');
      assert.equal(models.dshLiveModel(), 'rootp/m-root');
      fs.writeFileSync(path.join(fakeDshHome, 'profiles', 'headless', 'cordis.patch.yml'), '- id: agent-default-model\n  config:\n    provider: headp\n    model: m-head\n');
      assert.equal(models.dshLiveModel(), 'headp/m-head');
    } finally {
      if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome;
      if (prevDshProfile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = prevDshProfile;
      if (prevDshSettings === undefined) delete process.env.DSH_SETTINGS; else process.env.DSH_SETTINGS = prevDshSettings;
    }
  });

  t('P0-5 预检防线：CLI(gpt-5) + API(openai/gpt-5) 同模型伪装双座在开跑前被拒退 2', () => {
    const cWs = mkTmp('collapse');
    fs.mkdirSync(path.join(cWs, 'dispatch'), { recursive: true });
    fs.mkdirSync(path.join(cWs, 'ideas', 'briefs'), { recursive: true });
    fs.writeFileSync(path.join(cWs, 'ideas', 'briefs', 'idea_01.md'), '### Baseline\nAcc 80%\n### Idea\nx\n');
    fs.writeFileSync(path.join(cWs, 'dispatch', 'seats.json'), JSON.stringify({
      version: 1,
      paths: { require_anchor: false },
      default_backends: ['codex', 'api'],
      seats: [
        { id: 'codex', kind: 'cli', enabled: true, command: 'node', argv: ['-v'], identity: { kind: 'config', explicit_env: 'CODEX_MODEL' } },
        { id: 'api', kind: 'api', enabled: true, base_env_default: 'OPENAI_BASE_URL', key_env_default: 'OPENAI_API_KEY', model: { env: 'API_MODEL', default: 'openai/gpt-5' }, votes: { env: 'API_VOTES', default: 1 }, temperature: { env: 'API_TEMPERATURE', default: '0.5' }, identity: { kind: 'api' } },
        {
          id: 'manual1',
          kind: 'delivery',
          enabled: true,
          seat_pattern: 'manual[0-9]+',
          body_env: '{SEAT_UPPER}_BODY',
          model_env: '{SEAT_UPPER}_MODEL',
          attest_sha_env: '{SEAT_UPPER}_SHA',
          identity: { kind: 'manual' },
        },
      ],
    }, null, 2));
    // v2.0.0 默认 require_unique_models: false：跨 Agent 共享同模型默认放行，仅显式设 REQUIRE_UNIQUE_MODELS=1 时拦截退 2
    const planShared = runCli(cWs, ['plan', 'ideas/briefs/idea_01.md'], {
      CODEX_MODEL: 'gpt-5',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      OPENAI_API_KEY: 'sk-test-123456789',
    });
    assert.equal(planShared.rc, 0, 'v2.0.0 默认允许跨 Agent 同模型组合，plan 应退 0：\n' + planShared.out);
    assert.equal(JSON.parse(planShared.stdout).require_unique_models, false);

    const res = runCli(cWs, ['run', 'ideas/briefs/idea_01.md'], {
      CODEX_MODEL: 'gpt-5',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      OPENAI_API_KEY: 'sk-test-123456789',
      REQUIRE_UNIQUE_MODELS: '1',
    });
    assert.equal(res.rc, 2, '显式开启 REQUIRE_UNIQUE_MODELS=1 时，同模型伪装双座必须在预检阶段退 2：\n' + res.out);
    assert.ok(res.out.includes('独立先验'), res.out);
  });

  t('P1-2：seat.id 含点号（如 qwen2.5）或越界字符被 loadConfig 当场拦截报 BAD_CONFIG', () => {
    const badWs = mkTmp('bad-id');
    fs.mkdirSync(path.join(badWs, 'dispatch'), { recursive: true });
    fs.writeFileSync(path.join(badWs, 'dispatch', 'seats.json'), JSON.stringify({
      version: 1,
      seats: [{ id: 'qwen2.5', kind: 'cli', command: 'node' }],
    }));
    assert.throws(() => registry.loadConfig(badWs), (e) => e && e.code === 'BAD_CONFIG');
  });

  t('P1-1 & P1-7 & P1-8：防 meta 字段注入伪造先验、增量补票 VOID 保留已采纳真卡、超 24KB argv 工单在 workers_dir 正常落卡', () => {
    const mWs = mkTmp('meta-void-large');
    fs.mkdirSync(path.join(mWs, 'dispatch'), { recursive: true });
    fs.mkdirSync(path.join(mWs, 'ideas', 'briefs'), { recursive: true });
    fs.mkdirSync(path.join(mWs, 'ideas', 'cards'), { recursive: true });
    fs.mkdirSync(path.join(mWs, 'workers'), { recursive: true });

    // 写一个用 node 执行的真实 CLI 出卡脚本（同时验证子进程 cwd === workers_dir 且 >24KB 工单不报 ENAMETOOLONG）
    const emitterScript = path.join(mWs, 'emit-card.mjs');
    fs.writeFileSync(emitterScript, [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const cwdBase = path.basename(process.cwd());',
      'if (cwdBase !== "workers") { console.error("wrong cwd: " + process.cwd()); process.exit(9); }',
      'const card = ' + JSON.stringify(validCardMarkdown('idea_big', 'go')) + ';',
      'process.stdout.write(card);',
    ].join('\n'));

    // 构造 > 28KB 的大工单以压测 Windows CreateProcessW >24KB 保护
    const hugePadding = '背景实验数据记录行：CIFAR-100 baseline calibration bin details 0.1234.\n'.repeat(450);
    const briefPath = path.join(mWs, 'ideas', 'briefs', 'idea_big.md');
    fs.writeFileSync(briefPath, '<!-- meta role=brief idea=idea_big anchor=none -->\n### Baseline\nTop-1 = 78.4%\n' + hugePadding + '### Idea\n**ID**: idea_big\n');
    assert.ok(fs.statSync(briefPath).size > 26000, '测试工单应大于 26KB');

    fs.writeFileSync(path.join(mWs, 'dispatch', 'seats.json'), JSON.stringify({
      version: 1,
      paths: { cards_dir: 'ideas/cards', workers_dir: 'workers', require_anchor: false },
      default_backends: ['seat_a'],
      seats: [
        {
          id: 'seat_a',
          kind: 'cli',
          enabled: true,
          command: process.execPath,
          argv: [emitterScript, '{payload}'],
          payload_position: 'argv',
          output: 'stdout',
          identity: { kind: 'config', explicit_env: 'SEAT_A_MODEL' },
        },
        {
          id: 'seat_b',
          kind: 'cli',
          enabled: true,
          command: process.execPath,
          argv: [emitterScript, '{payload}'],
          payload_position: 'argv',
          output: 'stdout',
          identity: { kind: 'config', explicit_env: 'SEAT_B_MODEL' },
        },
        {
          id: 'qoder',
          kind: 'delivery',
          enabled: true,
          body_env: 'QODER_BODY',
          model_env: 'QODER_SEAT_MODEL',
          attest_sha_env: 'QODER_ATTEST_SHA',
          identity: { kind: 'selfdeclared' },
        },
        {
          id: 'manual1',
          kind: 'delivery',
          enabled: true,
          seat_pattern: 'manual[0-9]+',
          body_env: '{SEAT_UPPER}_BODY',
          model_env: '{SEAT_UPPER}_MODEL',
          attest_sha_env: '{SEAT_UPPER}_SHA',
          identity: { kind: 'manual' },
        },
      ],
    }, null, 2));

    // 首轮：seat_a 跑 >26KB argv 工单，验证 workers_dir 隔离与大工单落盘成功
    const r1 = runCli(mWs, ['run', 'ideas/briefs/idea_big.md'], {
      BACKENDS: 'seat_a',
      SEAT_A_MODEL: 'openai/gpt-5',
    });
    assert.equal(r1.rc, 0, '超 26KB argv 工单应正常出卡退 0，实得 ' + r1.rc + '：\n' + r1.out);
    const adoptedCard = path.join(mWs, 'ideas', 'cards', 'idea_big.seat_a.md');
    assert.ok(fs.existsSync(adoptedCard));

    // 次轮默认（v2.0.0 require_unique_models: false）：双座排入计划且共享同模型先验时退 0，status=OK 且记 shared_models: 1/2 unique
    const r2Default = runCli(mWs, ['run', 'ideas/briefs/idea_big.md'], {
      BACKENDS: 'seat_a seat_b',
      SEAT_A_MODEL: 'openai/gpt-5',
      SEAT_B_MODEL: 'gpt-5',
    });
    assert.equal(r2Default.rc, 0, 'v2.0.0 默认同模型不毁票应退 0，实得 ' + r2Default.rc + '：\n' + r2Default.out);
    assert.ok(fs.existsSync(path.join(mWs, 'ideas', 'cards', 'idea_big.seat_b.md')), '默认模式下同模型新卡应正常保留');
    const sharedManifest = fs.readFileSync(path.join(mWs, 'ideas', 'cards', 'idea_big.manifest'), 'utf8');
    assert.ok(sharedManifest.includes('status=OK') && sharedManifest.includes('shared_models: 1/2 unique'), 'manifest 应记 status=OK 与 shared_models：\n' + sharedManifest);
    fs.rmSync(path.join(mWs, 'ideas', 'cards', 'idea_big.seat_b.md'), { force: true });

    // 次轮严格模式（P1-7 REQUIRE_UNIQUE_MODELS=1）：单座增量补票跑 seat_b，触发运行时 VOID 但保留首轮已采纳真卡
    const r2 = runCli(mWs, ['run', 'ideas/briefs/idea_big.md'], {
      BACKENDS: 'seat_b',
      SEAT_B_MODEL: 'gpt-5',
      REQUIRE_UNIQUE_MODELS: '1',
    });
    assert.equal(r2.rc, 3, '开启 REQUIRE_UNIQUE_MODELS=1 时运行时双票同模型塌缩应退 3（VOID），实得 ' + r2.rc + '：\n' + r2.out);
    assert.ok(fs.existsSync(adoptedCard), 'P1-7：首轮已采纳的合法付费真卡绝不能被后续轮次的 VOID 连坐销毁！');
    assert.ok(!fs.existsSync(path.join(mWs, 'ideas', 'cards', 'idea_big.seat_b.md')), '本轮冲突新卡应被移入 rejected/*.void');

    // P1-1 & 预检防线：双未证身份座（qoder + manual1）在预检阶段退 2；单座自报注入 " ts=" 绝不能伪造 priors 或骗出 status=OK
    const qBody = path.join(mWs, 'qoder-body.md');
    const now = new Date(Date.now() + 5000);
    fs.writeFileSync(qBody, validCardMarkdown('idea_big', 'kill'));
    fs.utimesSync(qBody, now, now);
    fs.rmSync(adoptedCard, { force: true });
    const rPreflightBlock = runCli(mWs, ['run', 'ideas/briefs/idea_big.md'], {
      BACKENDS: 'qoder manual1',
      QODER_BODY: qBody,
      QODER_SEAT_MODEL: 'forged-prior ts=1',
      REQUIRE_UNIQUE_MODELS: '1',
    });
    assert.equal(rPreflightBlock.rc, 2, '开启 REQUIRE_UNIQUE_MODELS=1 时双未证身份座未开逃生口必须在预检阶段退 2');

    const rForge = runCli(mWs, ['run', 'ideas/briefs/idea_big.md'], {
      BACKENDS: 'qoder',
      QODER_BODY: qBody,
      QODER_SEAT_MODEL: 'forged-prior ts=1',
    });
    assert.equal(rForge.rc, 0);
    const forgeManifest = fs.readFileSync(path.join(mWs, 'ideas', 'cards', 'idea_big.manifest'), 'utf8');
    assert.ok(forgeManifest.includes('status=UNPROVEN-IDENTITY(1)'), 'P1-1：注入 " ts=" 绝不能骗出 status=OK，实得：\n' + forgeManifest);
    assert.ok(forgeManifest.includes('priors: none'), 'P1-1：伪造串绝不能混入 priors，实得：\n' + forgeManifest);
  });

  await ta('P0-1 超时整树回收 & P2-8 import("./bin/dispatch.mjs") 零副作用', async () => {
    const tWs = mkTmp('timeout-import');
    fs.mkdirSync(path.join(tWs, 'dispatch'), { recursive: true });
    fs.mkdirSync(path.join(tWs, 'ideas', 'briefs'), { recursive: true });
    fs.mkdirSync(path.join(tWs, 'ideas', 'cards'), { recursive: true });
    fs.mkdirSync(path.join(tWs, 'workers'), { recursive: true });
    const slowCli = path.join(tWs, 'slow-cli.mjs');
    const orphanMarker = path.join(tWs, 'ORPHAN_CLI');
    fs.writeFileSync(slowCli, [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      'const child = spawn(process.execPath, ["-e", "setTimeout(() => fs.writeFileSync(' + JSON.stringify(orphanMarker) + ', \'1\'), 1200)"], { stdio: "inherit" });',
      'setTimeout(() => {}, 10000);',
    ].join('\n'));
    fs.writeFileSync(path.join(tWs, 'ideas', 'briefs', 'idea_to.md'), '### Baseline\nAcc 80%\n### Idea\n**ID**: idea_to\n');
    fs.writeFileSync(path.join(tWs, 'dispatch', 'seats.json'), JSON.stringify({
      version: 1,
      paths: { cards_dir: 'ideas/cards', workers_dir: 'workers', require_anchor: false },
      default_backends: ['slow'],
      seats: [{
        id: 'slow',
        kind: 'cli',
        enabled: true,
        command: process.execPath,
        argv: [slowCli],
        payload_position: 'stdin',
        output: 'stdout',
        identity: { kind: 'config', explicit_env: 'SLOW_MODEL' },
      }],
    }, null, 2));

    const prevSlow = process.env.SLOW_MODEL;
    process.env.SLOW_MODEL = 'gpt-5';
    const t0 = Date.now();
    let rc = 0;
    try {
      rc = await run({
        root: tWs,
        briefArg: 'ideas/briefs/idea_to.md',
        seatTimeoutMs: 250,
        noExitCode: true,
        captureOnly: true,
      });
    } finally {
      if (prevSlow === undefined) delete process.env.SLOW_MODEL; else process.env.SLOW_MODEL = prevSlow;
    }
    const elapsed = Date.now() - t0;
    assert.equal(rc, 2, 'CLI 座位超时零产出应退 2');
    assert.ok(elapsed < 3000, '250ms 超时不应被挂起进程拖住：' + elapsed + 'ms');
    await new Promise((r) => setTimeout(r, 1600));
    assert.ok(!fs.existsSync(orphanMarker), 'Windows/POSIX 孙进程树应被一并清理，不应写出 ORPHAN_CLI');

    // P2-8：作为模块 import bin/dispatch.mjs 时不应触发 main() 或篡改 process.exitCode
    const beforeExit = process.exitCode;
    const binMod = await import(pathToFileURL(BIN).href);
    assert.equal(typeof binMod.main, 'function');
    assert.equal(process.exitCode, beforeExit, 'import bin/dispatch.mjs 不应污染 process.exitCode');
  });

  t('P0-1 Windows .cmd 包装器三连防线：有/无 Git Bash 下识别纯 .cmd、含空格括号目录不崩、多行工单零截断且特殊元字符透传', () => {
    assert.equal(typeof quoteWinCmdToken, 'function');
    if (process.platform !== 'win32') {
      // 非 Windows 平台仅校验转义函数契约
      assert.equal(quoteWinCmdToken('C:\\My Tools (v2)\\dsh.cmd', true), '"C:\\My Tools (v2)\\dsh.cmd"');
      return;
    }
    const wWs = mkTmp('wincmd');
    const spaceBin = path.join(wWs, 'My Tools (v2)');
    fs.mkdirSync(spaceBin, { recursive: true });
    fs.mkdirSync(path.join(wWs, 'dispatch'), { recursive: true });
    fs.mkdirSync(path.join(wWs, 'ideas', 'briefs'), { recursive: true });
    fs.mkdirSync(path.join(wWs, 'ideas', 'cards'), { recursive: true });
    fs.mkdirSync(path.join(wWs, 'workers'), { recursive: true });

    const helperMjs = path.join(spaceBin, 'cmd-seat-worker.mjs');
    fs.writeFileSync(helperMjs, [
      'import fs from "node:fs";',
      'const stdinTxt = fs.readFileSync(0, "utf8");',
      'const files = fs.readdirSync(process.cwd()).filter((f) => f.startsWith(".review_payload_"));',
      'if (!stdinTxt.includes("MULTI_LINE_TAIL_MARKER") || files.length === 0) {',
      '  console.error("missing multiline payload on stdin/sandbox:", { stdinLen: stdinTxt.length, files });',
      '  process.exit(12);',
      '}',
      'const sbTxt = fs.readFileSync(files[0], "utf8");',
      'if (!sbTxt.includes("MULTI_LINE_TAIL_MARKER")) { console.error("truncated sandbox payload"); process.exit(13); }',
      'const flagIdx = process.argv.indexOf("--meta-check");',
      'const gotMeta = flagIdx >= 0 ? process.argv[flagIdx + 1] : "";',
      'if (gotMeta !== "a&b|c<d>e^f 100% %PATH%") { console.error("meta mangled:", gotMeta); process.exit(14); }',
      'process.stdout.write(' + JSON.stringify(validCardMarkdown('idea_cmd', 'go')) + ');',
    ].join('\n'));
    fs.writeFileSync(
      path.join(spaceBin, 'onlycmd.cmd'),
      '@echo off\r\n"' + process.execPath + '" "%~dp0cmd-seat-worker.mjs" %*\r\n',
    );

    fs.writeFileSync(path.join(wWs, 'ideas', 'briefs', 'idea_cmd.md'), [
      '<!-- meta role=brief idea=idea_cmd anchor=none -->',
      '### Baseline',
      'ResNet-50 Top-1 = 78.4%',
      '### Idea',
      '**ID**: idea_cmd',
      '第二行关键实验约束：MULTI_LINE_TAIL_MARKER',
    ].join('\n'));

    fs.writeFileSync(path.join(wWs, 'dispatch', 'seats.json'), JSON.stringify({
      version: 1,
      paths: { cards_dir: 'ideas/cards', workers_dir: 'workers', require_anchor: false },
      default_backends: ['claude'],
      seats: [{
        id: 'claude',
        kind: 'cli',
        enabled: true,
        command: 'onlycmd',
        argv: ['-p', '{payload}', '--meta-check', 'a&b|c<d>e^f 100% %PATH%'],
        payload_position: 'argv',
        output: 'stdout',
        identity: { kind: 'config', explicit_env: 'CLAUDE_MODEL' },
      }],
    }, null, 2));

    // 场景 A：宿主存在 Git Bash 时，纯 .cmd（无同名无后缀脚本）仍须被识别并经 cmd.exe 完整跑通出卡
    const rWithBash = runCli(wWs, ['run', 'ideas/briefs/idea_cmd.md'], {
      PATH: spaceBin + ';' + (process.env.PATH || ''),
      CLAUDE_MODEL: 'claude-sonnet-4-5',
    });
    assert.equal(rWithBash.rc, 0, '有 Git Bash 时纯 .cmd 座位应退 0 出卡，实得 ' + rWithBash.rc + '：\n' + rWithBash.out);
    assert.ok(fs.existsSync(path.join(wWs, 'ideas', 'cards', 'idea_cmd.claude.md')));

    // 场景 B：纯 Windows 无 Git Bash（PATH 仅含含空格目录 + System32）同样退 0 出卡且多行工单零截断
    fs.rmSync(path.join(wWs, 'ideas', 'cards'), { recursive: true, force: true });
    fs.mkdirSync(path.join(wWs, 'ideas', 'cards'), { recursive: true });
    const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const rNoBash = runCli(wWs, ['run', 'ideas/briefs/idea_cmd.md'], {
      PATH: spaceBin + ';' + sys32,
      CLAUDE_MODEL: 'claude-sonnet-4-5',
      DSH_DISPATCH_BASH: 'C:\\nonexistent\\bash.exe',
    });
    assert.equal(rNoBash.rc, 0, '无 Git Bash 纯 Windows 下含空格目录 .cmd + 多行工单应退 0，实得 ' + rNoBash.rc + '：\n' + rNoBash.out);
    assert.ok(fs.existsSync(path.join(wWs, 'ideas', 'cards', 'idea_cmd.claude.md')));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5) v2.1.0 深度模型探测、Kimi 输出格式、四阶段阵容解析与面板写穿同步回归
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n── 5) v2.1.0 深度模型探测、四阶段阵容解析与面板写穿同步回归 ────────');

  t('v2.1.0 probeAgentModelsFromConfigs：五类 CLI 深度模型发现、DSH 路由防丢前缀与零密钥泄露', () => {
    const pDir = mkTmp('v21-probe');
    const savedEnv = {};
    const envKeys = [
      'HOME', 'USERPROFILE', 'DSH_HOME', 'DSH_SETTINGS', 'DSH_PROFILE',
      'CODEX_CFG', 'CODEX_MODEL', 'CLAUDE_CFG', 'CLAUDE_MODEL',
      'AGY_CFG', 'AGY_MODEL', 'AGY_MODELS_CACHE', 'AGY_SKIP_LIVE_MODELS',
      'GEMINI_CFG', 'GEMINI_MODEL', 'GEMINI_CLI_PKG_DIR',
      'KIMI_CFG', 'KIMI_MODEL', 'DSH_MODEL', 'API_MODEL',
    ];
    for (const k of envKeys) savedEnv[k] = process.env[k];

    try {
      const fakeHome = path.join(pDir, 'home');
      const codexDir = path.join(fakeHome, '.codex');
      const claudeDir = path.join(fakeHome, '.claude');
      const geminiDir = path.join(fakeHome, '.gemini');
      const agyDir = path.join(geminiDir, 'antigravity-cli');
      const kimiDir = path.join(fakeHome, '.kimi');
      const dshDir = path.join(fakeHome, '.dsh');
      const mockGemPkg = path.join(pDir, 'mock-gemini-cli');
      for (const d of [
        codexDir, claudeDir, geminiDir, path.join(agyDir, 'cache'), kimiDir,
        path.join(dshDir, 'storages'),
        path.join(dshDir, 'profiles', 'desktop'),
        path.join(mockGemPkg, 'bundle'),
      ]) {
        fs.mkdirSync(d, { recursive: true });
      }

      // 1) codex: config.toml + models_cache.json + cc-switch-model-catalog.json
      fs.writeFileSync(path.join(codexDir, 'config.toml'), [
        'model = "gpt-5.4"',
        '[profiles.fast]',
        'model = "o4-mini"',
      ].join('\n'));
      fs.writeFileSync(path.join(codexDir, 'models_cache.json'), JSON.stringify({
        models: [
          { slug: 'gpt-5-codex', description: 'cached' },
          { id: 'o3-pro' },
        ],
      }));
      fs.writeFileSync(path.join(codexDir, 'cc-switch-model-catalog.json'), JSON.stringify([
        { id: 'codex-cc-1' },
        'codex-cc-2',
      ]));

      // 2) claude: settings.json env.*MODEL 全族提取 + 严禁泄露密钥
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'sk-ant-mocksecret-9999999999999999',
          ANTHROPIC_API_KEY: 'sk-ant-mockkey-8888888888888888',
          ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5-fable',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-3-5',
          CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sub-4',
          ANTHROPIC_SMALL_FAST_MODEL: 'claude-fast-mini',
          INVALID_SPACE_MODEL: 'not a valid id',
        },
        availableModels: ['claude-avail-1', { id: 'claude-avail-2' }],
      }, null, 2));

      // 3) kimi: 顶层 default_model + [models.<id>] 节名剥引号（忽略子表内上游裸 model 键）
      fs.writeFileSync(path.join(kimiDir, 'config.toml'), [
        'default_model = "sensenova/glm-5.2"',
        '',
        '[models."sensenova/kimi-k3"]',
        'provider = "sensenova"',
        'model = "kimi-k3"',
        '',
        "[models.'moonshot/kimi-k2-thinking']",
        'provider = "moonshot"',
        'model = "kimi-k2-thinking"',
      ].join('\n'));

      // 4) agy (Antigravity CLI): ~/.gemini/antigravity-cli/settings.json + cache/models_cache.json + TSV 解析
      fs.writeFileSync(path.join(agyDir, 'settings.json'), JSON.stringify({
        model: 'gemini-4-carbon-high',
      }));
      fs.writeFileSync(path.join(agyDir, 'cache', 'models_cache.json'), JSON.stringify({
        updatedAt: '2026-11-14T15:00:00.000Z',
        defaultModel: 'gemini-4-carbon-medium',
        models: [
          'gemini-4-carbon-medium',
          'gemini-4-carbon-high',
          'claude-opus-5-5-high',
          'gpt-oss-120b-medium',
        ],
      }));

      // 4b) gemini (旧版兼容): settings.json + @google/gemini-cli 包内常量扫描（过滤 none/embedding/computer-use）+ 6 项兜底
      fs.writeFileSync(path.join(geminiDir, 'settings.json'), JSON.stringify({
        model: { name: 'gemini-custom-local' },
      }));
      fs.writeFileSync(path.join(mockGemPkg, 'bundle', 'chunk-models.js'), [
        'export const PREVIEW_GEMINI_3_1_MODEL = "gemini-3.1-pro-preview-pkg";',
        'export const LATEST_GEMINI_FLASH_MODEL = "gemini-flash-latest";',
        'export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";',
        'export const PREVIEW_GEMINI_COMPUTER_USE_MODEL = "gemini-2.5-computer-use-preview";',
        'export const SECONDARY_GEMINI_MODEL = "none";',
      ].join('\n'));

      // 5) dsh: settings.yaml 含多层斜杠路由 + storages 裸 enabledModelIds/hiddenModels + cordis.patch.yml llm-pi-ai
      fs.writeFileSync(path.join(dshDir, 'settings.yaml'), [
        'agent-default-model:',
        '  provider: magpie',
        '  model: auto/deepseek-v4.1-flash',
      ].join('\n'));
      fs.writeFileSync(path.join(dshDir, 'storages', 'opendesign-models.json'), JSON.stringify({
        catalogModels: [
          { id: 'deepseek-v4.1-flash' },
          { id: 'disabled-model' },
          { id: 'hidden-model' },
        ],
        enabledModelIds: ['deepseek-v4.1-flash', 'hidden-model'],
        hiddenModels: ['hidden-model'],
      }));
      fs.writeFileSync(path.join(dshDir, 'storages', 'workbuddy-models.json'), JSON.stringify({
        enabledModelIds: ['glm-5.3'],
      }));
      fs.writeFileSync(path.join(dshDir, 'profiles', 'desktop', 'cordis.patch.yml'), [
        '- id: llm-pi-ai',
        '  enabled: true',
        '  config:',
        '    providers:',
        '      magpie:',
        '        apiKey: sk-secret-never-read-777777777777',
        '        models:',
        '          - id: auto/qwen3-coder',
        '          - id: magpie/already-qualified',
        '      disabled-prov:',
        '        enabled: false',
        '        models:',
        '          - id: should-not-appear',
      ].join('\n'));

      for (const k of envKeys) delete process.env[k];
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      process.env.DSH_HOME = dshDir;
      process.env.GEMINI_CLI_PKG_DIR = mockGemPkg;

      const probed = models.probeAgentModelsFromConfigs();
      const serialized = JSON.stringify(probed);
      assert.ok(!serialized.includes('sk-ant-') && !serialized.includes('sk-secret-never-read'),
        '探测结果严禁包含任何密钥明文');

      // codex 校验
      assert.equal(probed.codex.defaultModel, 'gpt-5.4');
      for (const m of ['gpt-5.4', 'o4-mini', 'gpt-5-codex', 'o3-pro', 'codex-cc-1', 'codex-cc-2']) {
        assert.ok(probed.codex.models.includes(m), 'codex 缺失模型: ' + m);
      }

      // claude 校验
      assert.equal(probed.claude.defaultModel, 'claude-sonnet-4-5');
      for (const m of [
        'glm-5-fable', 'claude-opus-4-1', 'claude-sonnet-4-5',
        'claude-haiku-3-5', 'claude-sub-4', 'claude-fast-mini',
        'claude-avail-1', 'claude-avail-2',
      ]) {
        assert.ok(probed.claude.models.includes(m), 'claude 缺失模型: ' + m);
      }
      assert.ok(!probed.claude.models.some((x) => /\s/.test(x)), '含空白字符的值不应混入模型列表');

      // kimi 校验
      assert.equal(probed.kimi.defaultModel, 'sensenova/glm-5.2');
      assert.deepEqual(probed.kimi.models, [
        'sensenova/glm-5.2',
        'sensenova/kimi-k3',
        'moonshot/kimi-k2-thinking',
      ]);

      // agy 校验（有实测缓存时严格按 settings.json + models_cache.json 精准输出；无缓存时兜底补入 AGY_FALLBACK_MODELS）
      assert.equal(probed.agy.defaultModel, 'gemini-4-carbon-high');
      assert.deepEqual(probed.agy.models, [
        'gemini-4-carbon-high',
        'gemini-4-carbon-medium',
        'claude-opus-5-5-high',
        'gpt-oss-120b-medium',
      ]);
      const parsedTsv = models.parseAgyModelsOutput([
        'Fetching available models...',
        'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
        'claude-opus-5-5-high\tClaude Opus 5.5 (Thinking)',
      ].join('\n'));
      assert.deepEqual(parsedTsv, {
        defaultModel: 'gemini-4-carbon-medium',
        models: ['gemini-4-carbon-medium', 'claude-opus-5-5-high'],
      });
      fs.writeFileSync(path.join(agyDir, 'settings.json'), JSON.stringify({ vimMode: false }));
      assert.equal(models.agyConfigModel(), 'gemini-4-carbon-medium-from-config', 'settings.json 未配 model 时应回退 models_cache.json 的首行默认模型来源标记');
      assert.equal(models.probeAgentModelsFromConfigs().agy.defaultModel, 'gemini-4-carbon-medium');
      fs.unlinkSync(path.join(agyDir, 'cache', 'models_cache.json'));
      const probedNoCache = models.probeAgentModelsFromConfigs();
      assert.ok(probedNoCache.agy.models.includes('gemini-4-argon-high'), '无 models_cache.json 时应回退合并 AGY_FALLBACK_MODELS');

      // gemini 旧版兼容校验
      assert.equal(probed.gemini.defaultModel, 'gemini-custom-local');
      for (const m of [
        'gemini-custom-local',
        'gemini-3.1-pro-preview-pkg',
        'gemini-flash-latest',
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-3.1-pro-preview',
        'gemini-3-pro-preview',
        'gemini-3-flash-preview',
      ]) {
        assert.ok(probed.gemini.models.includes(m), 'gemini 缺失模型: ' + m);
      }
      for (const banned of ['none', 'gemini-embedding-001', 'gemini-2.5-computer-use-preview']) {
        assert.ok(!probed.gemini.models.includes(banned), 'gemini 应过滤非对话模型: ' + banned);
      }

      // dsh 校验：多层斜杠路由补齐 magpie/ 前缀 + storages enabledModelIds 裸名兼容 + llm-pi-ai 合并
      assert.equal(models.dshLiveModel(), 'magpie/auto/deepseek-v4.1-flash');
      assert.equal(probed.dsh.defaultModel, 'magpie/auto/deepseek-v4.1-flash');
      for (const m of [
        'magpie/auto/deepseek-v4.1-flash',
        'opendesign/deepseek-v4.1-flash',
        'workbuddy/glm-5.3',
        'magpie/auto/qwen3-coder',
        'magpie/already-qualified',
      ]) {
        assert.ok(probed.dsh.models.includes(m), 'dsh 缺失模型: ' + m);
      }
      assert.ok(!probed.dsh.models.includes('opendesign/disabled-model'), '未启用的 catalog 模型应被过滤');
      assert.ok(!probed.dsh.models.includes('opendesign/hidden-model'), 'hiddenModels 应被过滤');
      assert.ok(!probed.dsh.models.includes('disabled-prov/should-not-appear'), '禁用 provider 的模型不应被采集');

      // profilePatchModel 同样支持 provider + 含斜杠 model 且防双拼
      fs.unlinkSync(path.join(dshDir, 'settings.yaml'));
      fs.writeFileSync(path.join(dshDir, 'cordis.patch.yml'), [
        '- id: agent-default-model',
        '  config:',
        '    provider: magpie',
        '    model: auto/deepseek-v4.1-flash',
      ].join('\n'));
      assert.equal(models.dshLiveModel(), 'magpie/auto/deepseek-v4.1-flash');

      // DSH_SETTINGS 自定义覆盖单测隔离：不串读 profile 与 storages
      const isolatedSettings = path.join(pDir, 'custom-isolated-settings.yaml');
      fs.writeFileSync(isolatedSettings, [
        'agent-default-model:',
        '  provider: magpie',
        '  model: magpie/auto/no-double-prefix',
      ].join('\n'));
      process.env.DSH_SETTINGS = isolatedSettings;
      assert.equal(models.dshLiveModel(), 'magpie/auto/no-double-prefix');
      assert.deepEqual(models.readDshCatalogModels(), []);
    } finally {
      for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
  });

  t('v2.1.2 BUILT_IN_CLI_SEATS.{agy,kimi} 与 examples/seats.example.json：text 输出格式与四阶段 lineup 示例', () => {
    const agyBuiltIn = registry.BUILT_IN_CLI_SEATS.agy;
    assert.ok(agyBuiltIn && agyBuiltIn.command === 'agy' && Array.isArray(agyBuiltIn.argv));
    const agyFmtIdx = agyBuiltIn.argv.indexOf('--output-format');
    assert.ok(agyFmtIdx >= 0 && agyBuiltIn.argv[agyFmtIdx + 1] === 'text', '内置 agy 座位必须使用 --output-format text');
    assert.ok(agyBuiltIn.argv.includes('--disable-slash-commands'), '内置 agy 座位应禁用斜杠命令防误触');

    const kimiBuiltIn = registry.BUILT_IN_CLI_SEATS.kimi;
    assert.ok(kimiBuiltIn && Array.isArray(kimiBuiltIn.argv));
    const fmtIdx = kimiBuiltIn.argv.indexOf('--output-format');
    assert.ok(fmtIdx >= 0 && kimiBuiltIn.argv[fmtIdx + 1] === 'text', '内置 kimi 座位必须使用 --output-format text');
    assert.ok(!kimiBuiltIn.argv.includes('stream-json'), '内置 kimi 座位不应残留 stream-json');

    const exDir = mkTmp('v21-example');
    fs.mkdirSync(path.join(exDir, 'dispatch'), { recursive: true });
    fs.copyFileSync(
      path.join(SRC, 'examples', 'seats.example.json'),
      path.join(exDir, 'dispatch', 'seats.json'),
    );
    const exCfg = registry.loadConfig(exDir, undefined, { useDshPatch: false });
    const exKimi = registry.findSeat(exCfg, 'kimi');
    assert.ok(exKimi && exKimi.argv.includes('text') && !exKimi.argv.includes('stream-json'));
    for (const cliId of ['codex', 'claude', 'dsh', 'agy', 'kimi']) {
      const s = registry.findSeat(exCfg, cliId);
      assert.ok(s && s.enabled === true, 'examples/seats.example.json 中真实 CLI 座 ' + cliId + ' 默认应为 enabled: true');
    }
    assert.equal(registry.findSeat(exCfg, 'api').enabled, false);
    assert.equal(registry.findSeat(exCfg, 'manual1').enabled, false);
    assert.ok(exCfg.lineup && exCfg.lineup.scout && exCfg.lineup.diverge && Array.isArray(exCfg.lineup.review) && exCfg.lineup.novelty);
    assert.equal(exCfg.lineup.diverge.count, 10);
    assert.equal(exCfg.lineup.diverge.use_dead_ends, true);
    assert.ok(registry.findSeat(exCfg, 'api') && registry.findSeat(exCfg, 'manual1'));
  });

  t('v2.1.0 resolveStagePlan 与 resolveDivergePlan：完整优先级链及发散策略默认值', () => {
    const stDir = mkTmp('v21-stage');
    const patchPath = path.join(stDir, 'cordis.patch.yml');
    const saved = {
      SCOUT_AGENT: process.env.SCOUT_AGENT,
      DIVERGE_AGENT: process.env.DIVERGE_AGENT,
      NOVELTY_AGENT: process.env.NOVELTY_AGENT,
      DSH_DISPATCH_SETTINGS: process.env.DSH_DISPATCH_SETTINGS,
    };

    try {
      delete process.env.SCOUT_AGENT;
      delete process.env.DIVERGE_AGENT;
      delete process.env.NOVELTY_AGENT;
      delete process.env.DSH_DISPATCH_SETTINGS;

      const baseCfg = {
        version: 2,
        default_backends: ['codex', 'claude'],
        seats: [
          { id: 'codex', kind: 'cli', command: 'codex', argv: ['exec'], enabled: true },
          { id: 'claude', kind: 'cli', command: 'claude', argv: ['-p', '{payload}'], enabled: true },
          { id: 'dsh', kind: 'cli', command: 'dsh', argv: ['{payload}'], enabled: true },
        ],
        lineup: {
          diverge: { seat: 'claude', model: 'claude-sonnet-4-5', count: 14, use_dead_ends: false },
        },
      };

      // 1) 非法阶段名显式拒收
      const badStage = registry.resolveStagePlan(baseCfg, 'unknown-stage');
      assert.equal(badStage.ok, false);
      assert.equal(badStage.code, 'BAD_STAGE');

      // 2) lineup.scout 未配时自动回退 lineup.diverge，再回退 default_backends[0]
      const scoutFallbackDiv = registry.resolveStagePlan(baseCfg, 'scout', { useDshPatch: false });
      assert.equal(scoutFallbackDiv.ok, true);
      assert.equal(scoutFallbackDiv.seatId, 'claude');
      assert.equal(scoutFallbackDiv.model, 'claude-sonnet-4-5');
      assert.equal(scoutFallbackDiv.source, 'lineup-diverge');

      const noLineupCfg = { ...baseCfg, lineup: {} };
      const novFallbackDef = registry.resolveStagePlan(noLineupCfg, 'novelty', { useDshPatch: false });
      assert.equal(novFallbackDef.ok, true);
      assert.equal(novFallbackDef.seatId, 'codex');
      assert.equal(novFallbackDef.source, 'default');

      // 3) lineup[stageName] 优先于 lineup.diverge
      const fourStageCfg = {
        ...baseCfg,
        lineup: {
          scout: { seat: 'gemini', model: 'gemini-2.5-pro' },
          diverge: { seat: 'kimi', model: 'sensenova/glm-5.2', count: 16, use_dead_ends: false },
          novelty: { seat: 'dsh', model: 'magpie/auto/qwen3-coder' },
        },
      };
      const sLineup = registry.resolveStagePlan(fourStageCfg, 'scout', { useDshPatch: false });
      assert.equal(sLineup.ok, true);
      assert.equal(sLineup.seatId, 'gemini');
      assert.equal(sLineup.model, 'gemini-2.5-pro');
      assert.equal(sLineup.source, 'lineup');

      const dLineup = registry.resolveDivergePlan(fourStageCfg, { useDshPatch: false });
      assert.equal(dLineup.ok, true);
      assert.equal(dLineup.seatId, 'kimi');
      assert.equal(dLineup.model, 'sensenova/glm-5.2');
      assert.equal(dLineup.defaultCount, 16);
      assert.equal(dLineup.defaultUseDeadEnds, false);

      // 4) DSH 面板激活时覆盖 lineup（未激活时不生效）
      fs.writeFileSync(patchPath, [
        '- id: research-dispatch',
        '  config:',
        '    scoutCommand: codex',
        '    scoutModel: gpt-5.4',
        '    divergeCommand: claude',
        '    divergeModel: claude-opus-4-1',
        '    divergeCount: "22"',
        '    divergeUseDeadEnds: "true"',
        '    noveltyCommand: kimi',
        '    noveltyModel: sensenova/kimi-k3',
      ].join('\n'));
      process.env.DSH_DISPATCH_SETTINGS = patchPath;

      const sPanel = registry.resolveStagePlan(fourStageCfg, 'scout', { useDshPatch: true });
      assert.equal(sPanel.seatId, 'codex');
      assert.equal(sPanel.model, 'gpt-5.4');
      assert.equal(sPanel.source, 'panel');

      const dPanel = registry.resolveDivergePlan(fourStageCfg, { useDshPatch: true });
      assert.equal(dPanel.seatId, 'claude');
      assert.equal(dPanel.model, 'claude-opus-4-1');
      assert.equal(dPanel.source, 'panel');
      assert.equal(dPanel.defaultCount, 22);
      assert.equal(dPanel.defaultUseDeadEnds, true);

      const nPanel = registry.resolveStagePlan(fourStageCfg, 'novelty', { useDshPatch: true });
      assert.equal(nPanel.seatId, 'kimi');
      assert.equal(nPanel.model, 'sensenova/kimi-k3');
      assert.equal(nPanel.source, 'panel');

      // 5) 环境变量 <STAGE>_AGENT 优先于面板，opts.agent 最高优
      process.env.SCOUT_AGENT = 'kimi:moonshot/kimi-k2';
      const sEnv = registry.resolveStagePlan(fourStageCfg, 'scout', { useDshPatch: true });
      assert.equal(sEnv.seatId, 'kimi');
      assert.equal(sEnv.model, 'moonshot/kimi-k2');
      assert.equal(sEnv.source, 'env');

      const sArg = registry.resolveStagePlan(fourStageCfg, 'scout', { agent: 'dsh:magpie/top', useDshPatch: true });
      assert.equal(sArg.seatId, 'dsh');
      assert.equal(sArg.model, 'magpie/top');
      assert.equal(sArg.source, 'arg');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  t('v2.1.0 updateLineup / discoverAgents / syncPanelLineupToSeats：四阶段持久化与写穿边界保护', () => {
    const syncRoot = mkTmp('v21-sync');

    // 1) 座位表缺失时 syncPanelLineupToSeats 静默返回 missing 不抛错
    const missRes = registry.syncPanelLineupToSeats(syncRoot, 'dispatch/seats.json', { scoutCommand: 'codex' });
    assert.equal(missRes.ok, false);
    assert.equal(missRes.synced, false);
    assert.equal(missRes.reason, 'missing');

    // 2) 越界路径安全拒绝不抛错
    const escapeRes = registry.syncPanelLineupToSeats(syncRoot, '../outside.json', { scoutCommand: 'codex' });
    assert.equal(escapeRes.ok, false);
    assert.equal(escapeRes.synced, false);
    assert.equal(escapeRes.reason, 'bad-path');

    // 3) 初始座位表含手写 model_override 与历史 enabled:false 座位；面板全空默认值时不产生冗余写盘
    const seatsAbs = path.join(syncRoot, 'dispatch', 'seats.json');
    fs.mkdirSync(path.dirname(seatsAbs), { recursive: true });
    fs.writeFileSync(seatsAbs, JSON.stringify({
      version: 2,
      default_backends: ['codex', 'claude'],
      seats: [
        { id: 'codex', kind: 'cli', command: 'codex', argv: ['exec'], enabled: true, model_override: 'preserve-custom-override' },
        { id: 'claude', kind: 'cli', command: 'claude', argv: ['-p', '{payload}'], enabled: false },
        { id: 'dsh', kind: 'cli', command: 'dsh', argv: ['{payload}'], enabled: false },
      ],
    }, null, 2) + '\n');
    const beforeRaw = fs.readFileSync(seatsAbs, 'utf8');

    const noopRes = registry.syncPanelLineupToSeats(syncRoot, 'dispatch/seats.json', {
      scoutCommand: '',
      scoutModel: '',
      divergeCommand: '',
      divergeModel: '',
      divergeCount: '10',
      divergeUseDeadEnds: 'true',
      reviewVotes: '',
      noveltyCommand: '',
      noveltyModel: '',
    });
    assert.equal(noopRes.ok, true);
    assert.equal(noopRes.synced, false);
    assert.equal(fs.readFileSync(seatsAbs, 'utf8'), beforeRaw, '面板全空默认态不应触碰原 seats.json');

    // 4) 面板非空四阶段写穿同步：自动补入 agy/kimi 座位，更新 lineup + default_backends，严禁改动 model_override
    const writeRes = registry.syncPanelLineupToSeats(syncRoot, 'dispatch/seats.json', {
      scoutCommand: { get: () => 'agy' },
      scoutModel: { get: () => 'gemini-4-carbon-high' },
      divergeCommand: 'kimi',
      divergeModel: 'sensenova/glm-5.2',
      divergeCount: '18',
      divergeUseDeadEnds: 'false',
      reviewVotes: 'codex:gpt-5.4,claude:claude-sonnet-4-5',
      noveltyCommand: 'claude',
      noveltyModel: 'claude-opus-4-1',
    });
    assert.equal(writeRes.ok, true);
    assert.equal(writeRes.synced, true);

    const syncedJson = JSON.parse(fs.readFileSync(seatsAbs, 'utf8'));
    assert.equal(syncedJson.seats[0].model_override, 'preserve-custom-override', '严禁触碰手写 model_override');
    assert.equal(syncedJson.seats.find((s) => s.id === 'claude').enabled, true, 'syncPanelLineupToSeats 选中的既有停用座位应自动置为 enabled: true');
    assert.equal(syncedJson.seats.find((s) => s.id === 'dsh').enabled, false, '未被面板选中的停用座位保持原状');
    assert.ok(syncedJson.seats.some((s) => s.id === 'agy' && s.argv.includes('text')) && syncedJson.seats.some((s) => s.id === 'kimi' && s.argv.includes('text')));
    assert.deepEqual(syncedJson.lineup, {
      scout: { seat: 'agy', model: 'gemini-4-carbon-high' },
      diverge: { seat: 'kimi', model: 'sensenova/glm-5.2', count: 18, use_dead_ends: false },
      review: [
        { seat: 'codex', model: 'gpt-5.4' },
        { seat: 'claude', model: 'claude-sonnet-4-5' },
      ],
      novelty: { seat: 'claude', model: 'claude-opus-4-1' },
    });
    assert.deepEqual(syncedJson.default_backends, ['codex', 'claude']);

    // 相同快照二次同步应返回 synced: false（零无谓写盘）
    const idempRes = registry.syncPanelLineupToSeats(syncRoot, 'dispatch/seats.json', {
      scoutCommand: 'agy',
      scoutModel: 'gemini-4-carbon-high',
      divergeCommand: 'kimi',
      divergeModel: 'sensenova/glm-5.2',
      divergeCount: '18',
      divergeUseDeadEnds: 'false',
      reviewVotes: 'codex:gpt-5.4,claude:claude-sonnet-4-5',
      noveltyCommand: 'claude',
      noveltyModel: 'claude-opus-4-1',
    });
    assert.equal(idempRes.ok, true);
    assert.equal(idempRes.synced, false);

    // 5) updateLineup 与 discoverAgents 完整覆盖四阶段读写、停用座自动激活与 reset
    registry.updateLineup(syncRoot, {
      scout: 'dsh:magpie/auto/qwen3-coder',
      diverge: 'agy:gemini-4-argon-high',
      divergeCount: 12,
      useDeadEnds: true,
      review: 'codex:gpt-5.4,kimi:sensenova/glm-5.2',
      novelty: 'kimi:sensenova/glm-5.2',
      requireUniqueModels: true,
    });
    const afterUpdateJson = JSON.parse(fs.readFileSync(seatsAbs, 'utf8'));
    assert.equal(afterUpdateJson.seats.find((s) => s.id === 'dsh').enabled, true, '被选入 lineup 的既有停用座位应自动置为 enabled: true');
    const disc = registry.discoverAgents(syncRoot, { useDshPatch: false });
    assert.equal(disc.ok, true);
    assert.deepEqual(disc.lineup.scout, { seat: 'dsh', model: 'magpie/auto/qwen3-coder' });
    assert.deepEqual(disc.lineup.diverge, { seat: 'agy', model: 'gemini-4-argon-high', count: 12, use_dead_ends: true });
    assert.equal(disc.lineup.review.length, 2);
    assert.deepEqual(disc.lineup.novelty, { seat: 'kimi', model: 'sensenova/glm-5.2' });
    assert.equal(disc.lineup.require_unique_models, true);

    registry.updateLineup(syncRoot, { reset: true });
    const discReset = registry.discoverAgents(syncRoot, { useDshPatch: false });
    assert.equal(discReset.lineup.scout, null);
    assert.equal(discReset.lineup.diverge, null);
    assert.equal(discReset.lineup.review, null);
    assert.equal(discReset.lineup.novelty, null);
    assert.equal(discReset.lineup.require_unique_models, false);

    // 6) v2.3.1 思考强度 effort 全链路解析、DSH 覆盖保护、写穿同步与不支持席位安全忽略
    assert.equal(models.embeddedModelEffort('gemini-4-carbon-high'), 'high');
    assert.equal(models.embeddedModelEffort('kimi-k2-thinking'), 'thinking');
    assert.equal(models.embeddedModelEffort('gpt-5'), '');

    registry.syncPanelLineupToSeats(syncRoot, 'dispatch/seats.json', {
      scoutCommand: 'codex',
      scoutModel: 'gpt-5',
      scoutEffort: 'high',
      divergeCommand: 'claude',
      divergeModel: 'claude-sonnet-4-5',
      divergeEffort: 'xhigh',
      reviewVotes: 'codex:gpt-5@medium,agy:gemini-4-carbon-high@low,kimi:kimi-k2.5@high',
      noveltyCommand: 'agy',
      noveltyModel: 'claude-opus-5-5',
      noveltyEffort: 'high',
    });
    const effJson = JSON.parse(fs.readFileSync(seatsAbs, 'utf8'));
    assert.deepEqual(effJson.lineup.scout, { seat: 'codex', model: 'gpt-5', effort: 'high' });
    assert.equal(effJson.lineup.diverge.effort, 'xhigh');
    assert.equal(effJson.lineup.review[0].effort, 'medium');
    assert.equal(effJson.lineup.review[1].effort, undefined, '内置 *-high 模型不写入覆盖 effort');
    assert.deepEqual(effJson.lineup.novelty, { seat: 'agy', model: 'claude-opus-5-5', effort: 'high' });

    const effCfg = registry.loadConfig(syncRoot, 'dispatch/seats.json', { useDshPatch: false });
    const effRevPlan = registry.resolveExecutionPlan(effCfg, { useDshPatch: false });
    assert.equal(effRevPlan.slots[0].effort, 'medium');
    assert.equal(effRevPlan.slots[1].effort, '');
    const exampleCfg = registry.loadConfig(SRC, 'examples/seats.example.json', { useDshPatch: false });
    const codexEffArgv = registry.buildArgv(registry.findSeat(exampleCfg, 'codex'), { env: { CODEX_MODEL: 'gpt-5', CODEX_EFFORT: 'high' }, tmp: '/t', workersDir: '/w', payloadText: 'P' });
    assert.ok(codexEffArgv.includes('-c') && codexEffArgv.includes('model_reasoning_effort=high'), 'codex optional_args 透传 model_reasoning_effort：' + JSON.stringify(codexEffArgv));
    const claudeEffArgv = registry.buildArgv(registry.findSeat(exampleCfg, 'claude'), { env: { CLAUDE_MODEL: 'claude-sonnet-4-5', CLAUDE_EFFORT: 'xhigh' }, tmp: '/t', workersDir: '/w', payloadText: 'P' });
    assert.ok(claudeEffArgv.includes('--effort') && claudeEffArgv.includes('xhigh'), 'claude optional_args 透传 --effort：' + JSON.stringify(claudeEffArgv));
    const agyEffArgv = registry.buildArgv(registry.findSeat(exampleCfg, 'agy'), { env: { AGY_MODEL: 'claude-sonnet-4-6', AGY_EFFORT: 'medium' }, tmp: '/t', workersDir: '/w', payloadText: 'P' });
    assert.ok(agyEffArgv.includes('--effort') && agyEffArgv.includes('medium'), 'agy optional_args 透传 --effort：' + JSON.stringify(agyEffArgv));
    const codexArgvWithEffort = registry.buildArgv(
      { id: 'codex', kind: 'cli', command: 'codex', argv: ['exec', '{optional_args}', '-'], optional_args: [] },
      { env: { CODEX_EFFORT: 'high' }, workersDir: '/w', tmp: '/t', payloadText: 'P' },
    );
    assert.ok(codexArgvWithEffort.includes('-c') && codexArgvWithEffort.includes('model_reasoning_effort=high'), 'codex 自动兜底注入 -c model_reasoning_effort=high：' + JSON.stringify(codexArgvWithEffort));
    const kimiArgvIgnored = registry.buildArgv(
      registry.findSeat(effCfg, 'kimi'),
      { env: { KIMI_MODEL: 'kimi-k2.5', KIMI_EFFORT: 'high' }, workersDir: '/w', tmp: '/t', payloadText: 'P' },
    );
    assert.ok(!kimiArgvIgnored.includes('--effort') && !kimiArgvIgnored.includes('high'), 'kimi 不支持席位安全忽略 effort：' + JSON.stringify(kimiArgvIgnored));

    // DSH buildDshModelOverrideFiles 在 catalog 声明受限 reasoningEfforts 时安全过滤，无 catalog 且显式传入时正常写入
    const prevHomeEff = process.env.DSH_HOME;
    const prevProfEff = process.env.DSH_PROFILE;
    try {
      const fakeDsh = mkTmp('dsh-eff');
      process.env.DSH_HOME = fakeDsh;
      process.env.DSH_PROFILE = 'headless';
      fs.mkdirSync(path.join(fakeDsh, 'profiles', 'headless'), { recursive: true });
      fs.writeFileSync(path.join(fakeDsh, 'profiles', 'headless', 'cordis.patch.yml'), [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      magpie:',
        '        models:',
        '          - id: deepseek-v4.1-flash',
        '            reasoningEfforts:',
        '              low: low',
        '              high: high',
        '              max: max',
        '          - id: glm-5.3',
      ].join('\n'));
      const dshDir = mkTmp('dsh-out');
      const ovHigh = buildDshModelOverrideFiles(dshDir, '', 'magpie/deepseek-v4.1-flash', 'dsh1', 'high');
      assert.ok(fs.readFileSync(ovHigh.patchFile, 'utf8').includes('reasoningEffort: "high"'));
      const ovXhigh = buildDshModelOverrideFiles(dshDir, '', 'magpie/deepseek-v4.1-flash', 'dsh2', 'xhigh');
      assert.ok(fs.readFileSync(ovXhigh.patchFile, 'utf8').includes('reasoningEffort: "max"'), 'xhigh 映射为声明的 max');
      const ovUnsup = buildDshModelOverrideFiles(dshDir, '', 'magpie/glm-5.3', 'dsh3', 'high');
      assert.ok(!fs.readFileSync(ovUnsup.patchFile, 'utf8').includes('reasoningEffort'), '未声明 reasoningEfforts 的模型安全跳过避免 UNSUPPORTED_REASONING_EFFORT');
    } finally {
      if (prevHomeEff === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHomeEff;
      if (prevProfEff === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = prevProfEff;
    }
  });

} finally {
  for (const d of TMP_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }
}

console.log();
if (fails > 0) {
  console.log('✗ ' + fails + '/' + checks + ' 条断言失守 —— 独立净室集成不可信');
  process.exit(1);
}
console.log('全部 ' + checks + ' 条断言通过（standalone 净室全链路与 P0~P2 回归，零联网零外部桩）');
