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
    'DSH_DISPATCH_CONFIG', 'DSH_DISPATCH_SETTINGS', 'RESEARCH_DISPATCH_DIAG',
    'BACKENDS', 'DRY', 'CALIBRATION', 'API_VOTES', 'ALLOW_DOOMED_PLAN',
    'CODEX_MODEL', 'CLAUDE_MODEL', 'DSH_MODEL', 'API_MODEL',
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
