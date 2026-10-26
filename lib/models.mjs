// 评审位"当前生效的是哪个模型"的唯一实现（Node 侧）。
//
// 这份文件是 dispatch/models.sh 的搬家终点：bash 那边只剩一层壳，把调用转到这里。
// 为什么必须只有一个实现（原注释保留）：模型读法有两个消费者 —— 派工（写卡 meta 并做
// 票源塌缩断言）与发散（判断"发散位是不是和某个评审同族"，此前起只留痕不拦）。
// 各读各的迟早漂移，而漂移
// 的表现不是报错，是断言静默放行：断言比对的字符串跟真正在跑的模型不再是同一件事。
//
// 环境变量（与旧版逐字相同，测试夹具靠它们注入假家目录）：
//   CODEX_CFG / CLAUDE_CFG / DSH_SETTINGS   覆盖默认配置文件路径
//   CODEX_MODEL / CLAUDE_MODEL              显式模型名（走 -explicit 分支）
//   QODER_SEAT_MODEL / QODER_ATTEST_SHA     qoder 座自报名与 payload 绑定
//   MANUAL<N>_MODEL / MANUAL<N>_SHA         manual1… 手工票
import fs from 'node:fs';
import os from 'node:os';

export function homeDir() {
  return process.env.HOME || os.homedir();
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return homeDir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return homeDir() + p.slice(1);
  return p;
}

// 等价于 `grep -oE <pattern> <file> | tail -1 | cut -d'"' -f<field>`。
// 用 -o 语义（只取匹配片段）而不是整行：claude 的配置行前后还有别的键。
function grepLastCut(file, pattern, field) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // 文件读不到：与"文件在但样式没命中"必须分开
  }
  const re = new RegExp(pattern, 'gm');
  const all = text.match(re);
  if (!all || all.length === 0) return '';
  const parts = all[all.length - 1].split('"');
  return parts[field - 1] === undefined ? '' : parts[field - 1];
}

/**
 * $1=显式值 $2=配置文件 $3=正则 $4=cut 字段
 *
 * 三种返回值必须能区分，否则会把"解析器过期"误诊成"座没配"：
 *   <name>-explicit          人在环境变量里点名（不解析配置文件）
 *   <name>-from-config       从配置文件回读成功
 *   unknown-check-config     文件不在，或文件在但样式没命中（后者要当场喊出来）
 */
export function resolveModel(explicit, cfgFile, pattern, field) {
  if (explicit) return explicit + '-explicit';
  if (!cfgFile) return 'unknown-check-config';
  let exists = false;
  try {
    exists = fs.statSync(cfgFile).isFile();
  } catch {
    exists = false;
  }
  if (!exists) return 'unknown-check-config';
  const v = grepLastCut(cfgFile, pattern, field);
  if (v) return v + '-from-config';
  process.stderr.write('⚠ resolve_model：配置文件存在但没有匹配到模型行（格式漂移？）—— ' + cfgFile + '\n');
  return 'unknown-check-config';
}

// 活源①：设置文档 ~/.dsh/settings.yaml 的 agent-default-model（provider/model 两行嵌套）。
// 别用 --dump-config：那是 profile 种子配置，会被 settings 层覆盖。
function settingsModel() {
  const file = expandHome(process.env.DSH_SETTINGS || '~/.dsh/settings.yaml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^agent-default-model:/.test(l));
  if (at < 0) return '';
  const block = lines.slice(at, at + 4); // grep -A3：命中行 + 后 3 行
  const pick = (key) => {
    for (const l of block) {
      const m = l.match(new RegExp('^  ' + key + ': (.*)$'));
      if (m) return m[1].trim().split(/\s+/)[0];
    }
    return '';
  };
  const prov = pick('provider');
  const mdl = pick('model');
  if (!mdl) return '';
  return (prov || '?') + '/' + mdl;
}

// 活源②：profile 补丁 ~/.dsh/profiles/<DSH_PROFILE|desktop>/cordis.patch.yml 里
// `- id: agent-default-model` 那条的 config.provider / config.model。
// 新版 DSH 把模型写在这里，~/.dsh/settings.yaml 可能压根不存在（本机实测如此），
// 只读①的结果就是 dsh 座永远 unknown-check-config、三票阵少一票先验。
// 形状与 settings-file.mjs 的 parseEntryConfig 相同（4 空格扁平标量），不直接复用是因为
// 那边只认本插件自己的 entry id，而模型的活源是 agent-default-model。
function profilePatchModel() {
  const named = process.env.DSH_PROFILE || 'desktop';
  const file = homeDir() + '/.dsh/profiles/' + named + '/cordis.patch.yml';
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  let inEntry = false;
  let inConfig = false;
  let prov = '';
  let mdl = '';
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (/^-\s/.test(raw)) {
      const m = raw.match(/^-\s+id:\s*(.+)$/);
      // 行尾注释不属于 id：profile 里实际写的是 `- id: agent-default-model # magpie`，
      // 早先按整串全等比较 → 永远判成"没有这条 entry" → dsh 座身份恒 unknown-check-config，
      // 票源塌缩断言悄悄少一个独立先验（每轮 manifest 记 UNPROVEN-IDENTITY）。剥注释再比。
      const entryId = m ? m[1].trim().replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '') : '';
      inEntry = entryId === 'agent-default-model';
      inConfig = false;
      continue;
    }
    if (!inEntry) continue;
    if (/^\s{2}config:\s*$/.test(raw)) { inConfig = true; continue; }
    if (!inConfig) continue;
    const m = raw.match(/^\s{4}([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) {
      const v = m[2].trim().replace(/^['"]|['"]$/g, '');
      if (m[1] === 'provider') prov = v;
      else if (m[1] === 'model') mdl = v;
      continue;
    }
    if (/^\s{0,2}\S/.test(raw)) inConfig = false;
  }
  if (!mdl) return '';
  // desktop 里 model 已经是 "provider/model" 形态（cline-pass/deepseek-v4.1-...），
  // 再拼一次 provider 就会变成 cline-pass/cline-pass/...，塌缩断言的归一化会当场失灵。
  return mdl.includes('/') ? mdl : (prov || '?') + '/' + mdl;
}

// 两个活源按顺序回退；顺带把"从哪读到的"带出来，免得卡上一律写 -from-settings.yaml。
function dshModelWithSource() {
  const s = settingsModel();
  if (s) return { model: s, source: 'settings.yaml' };
  const p = profilePatchModel();
  if (p) return { model: p, source: 'profile-patch' };
  return { model: '', source: '' };
}

export function dshLiveModel() {
  return dshModelWithSource().model;
}

// 归一化掉来源后缀与 provider 前缀，只比模型本体 —— 塌缩断言用。
export function normModel(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/-from-.*$/, '')
    .replace(/-explicit$/, '')
    .replace(/^dsh:[^/]*\//, '');
}

// 模型家族名：去掉 provider 前缀与版本号，取最前面那段。用于"发散位与评审位同族"的留痕
// （按设计）。
// 这是名字层面的启发式，所以调用方必须把比对结果打出来给人看。
export function modelFamily(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/^[^/]*\//, '')
    .replace(/[-_ ].*$/, '');
}

// dsh 写进卡 meta 的 tag。读不到时归 unknown-check-config，与 resolveModel 的失败输出同轨 ——
// 填 '?/?' 占位时 normModel 剥完剩 '?'，塌缩断言会把一张身份都没证到的票算成独立先验。
export function dshTag() {
  const d = dshModelWithSource();
  return d.model ? 'dsh:' + d.model + '-from-' + d.source : 'unknown-check-config';
}

// qoder 座：计票侧恒为 unknown-check-config —— 自报的身份没有任何东西背书。
export function qoderTag() {
  return 'unknown-check-config';
}

// 比对面一侧给真实自报名：diverge 拿 review_models 逐家比族名，这座填 kimi-k3 时会在
// 同族留痕里被点名（按设计）。
export function qoderSelfModel() {
  const v = process.env.QODER_SEAT_MODEL || '';
  return v ? v + '-from-selfdeclared' : '';
}

/**
 * 署名票（qoder 代写 / manual1…）的先验标签：**唯一实现**。
 * 要求两件事同时成立：① 人给出答者是谁；② 人交出他所回答的那份 payload 的 sha，
 * 且与现算的一致。②钉住"回答的问题没被软化过"。缺任一条 → 仍算一票，但不配一个先验。
 */
export function seatAttestToken(be, payloadSha) {
  const env = process.env;
  let mdl = '';
  let sha = '';
  if (be === 'qoder') {
    mdl = env.QODER_SEAT_MODEL || '';
    sha = env.QODER_ATTEST_SHA || '';
  } else if (/^manual[0-9]+$/.test(be)) {
    const up = be.toUpperCase();
    mdl = env[up + '_MODEL'] || '';
    sha = env[up + '_SHA'] || '';
  } else {
    return '';
  }
  if (mdl && sha && payloadSha && sha === payloadSha) return mdl + '-manual-attested';
  return 'unknown-check-config';
}

// 说明：本文件曾经还有一份 `reviewModels()`（无参数、按环境变量读三家），与
// registry.mjs 的 `reviewModels(cfg)`（按座位表读）重名。唯一实现是 registry 那一份
// （bin/dispatch.mjs 只 import 它），这里这份无人引用，已删除 —— 留两份就是留一条漂移路径。
