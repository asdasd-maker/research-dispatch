// 设置页与 /swarm 科研拓扑静态预览生成器（v2.3.0）：把真实组件树序列化成静态 HTML，复用同一份 CSS 渲染。
//
//   node plugin/research-dispatch/test/preview.mjs   → plugin/research-dispatch/test/preview.html
//
// DOM 来自 lib/client.js 的真实渲染输出，样式取自 __test.CSS()，避免手写预览与真实界面漂移。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hookState = [];
let hookCursor = 0;
let pendingEffects = [];
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.length ? children : (props || {}).children } };
  },
  useState(init) {
    const i = hookCursor++;
    if (!(i in hookState)) hookState[i] = typeof init === 'function' ? init() : init;
    return [hookState[i], (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v; }];
  },
  useEffect(fn) { pendingEffects.push(fn); },
  useSyncExternalStore(_s, get) { return get(); },
};
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => (ms >= 3000 ? 0 : realSetTimeout(fn, ms));
globalThis.clearTimeout = () => {};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

let reg = null;
globalThis.window = { __ModuleLoader__: { load: (r) => { reg = r; } } };
await import(new URL('../lib/client.js', import.meta.url).href);
const mod = reg.factory((id) => (id === 'react' ? fakeReact : (() => { throw new Error('不许 require ' + id); })()));

mod.__test.setLiveGroups([
  { id: 'cline-pass', name: 'Cline Pass', models: [{ id: 'qwen3.8-max', name: 'Qwen 3.8 Max' }, { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus' }] },
  { id: 'qoder', name: 'Qoder (订阅)', models: [{ id: 'auto', name: 'Auto' }, { id: 'deepseek-v4-pro', name: 'deepseek V4-Pro' }] },
  { id: 'magpie', name: 'Magpie', models: [{ id: 'auto/deepseek-v4.1-flash', name: 'deepseek V4.1-Flash · routing group' }] },
  { id: 'magpie-anthropic', name: 'Magpie · Anthropic', models: [{ id: 'zcode/GLM-5.3-Flash', name: 'GLM 5.3-Flash · ZCode' }] },
]);

mod.__test.setBridgeSnapshot({
  version: '2.3.0',
  catalog: 'codex:gpt-5|o3;claude:claude-sonnet-4-5|claude-opus-4-1;dsh:qoder/deepseek-v4-pro;agy:gemini-4-carbon-medium|gemini-4-carbon-high|claude-opus-5-5-high;kimi:kimi-k2-thinking',
  status: 'codex:1;claude:1;dsh:1;agy:1;kimi:1',
  defaultRepoRoot: '/workspace/my-research',
  repoRoot: '/workspace/my-research',
  workspaces: [
    { dir: '/workspace/my-research', path: '/workspace/my-research', name: 'my-research', isResearch: true, hasSeats: true, paperCount: 8 },
    { dir: '/workspace/vlm-rl-exp', path: '/workspace/vlm-rl-exp', name: 'vlm-rl-exp', isResearch: true, hasSeats: true, paperCount: 5 },
  ],
  projectLineup: {
    configured: true,
    scout: { seat: 'agy', model: 'gemini-4-carbon-high', resolvedModel: 'gemini-4-carbon-high' },
    diverge: { seat: 'kimi', model: 'kimi-k2-thinking', resolvedModel: 'kimi-k2-thinking', count: 10, useDeadEnds: true },
    review: [
      { tag: 'codex1', seat: 'codex', model: 'gpt-5', resolvedModel: 'gpt-5' },
      { tag: 'claude', seat: 'claude', model: 'claude-sonnet-4-5', resolvedModel: 'claude-sonnet-4-5' },
      { tag: 'dsh', seat: 'dsh', model: 'qoder/deepseek-v4-pro', resolvedModel: 'qoder/deepseek-v4-pro' },
    ],
    novelty: { seat: 'claude', model: 'claude-sonnet-4-5', resolvedModel: 'claude-sonnet-4-5' },
  },
});

const VALUE = {
  repoRoot: '/workspace/my-research',
  seatsFile: 'dispatch/seats.json',
  scoutCommand: 'agy',
  scoutModel: 'gemini-4-carbon-high',
  divergeCommand: 'kimi',
  divergeModel: 'kimi-k2-thinking',
  divergeCount: '10',
  divergeUseDeadEnds: 'true',
  reviewVotes: 'codex:gpt-5,codex:o3,claude:claude-sonnet-4-5,dsh:qoder/deepseek-v4-pro',
  noveltyCommand: 'claude',
  noveltyModel: 'claude-sonnet-4-5',
  executorCatalog: 'codex:gpt-5|o3;claude:claude-sonnet-4-5|claude-opus-4-1;dsh:qoder/deepseek-v4-pro;agy:gemini-4-carbon-medium|gemini-4-carbon-high|claude-opus-5-5-high;kimi:kimi-k2-thinking',
  executorStatus: 'codex:1;claude:1;dsh:1;agy:1;kimi:1',
  otherStages: '',
  stageOpinions: '',
};
const SCHEMA = {
  uid: 90,
  refs: {
    3: { type: 'string', meta: { description: '科研项目文件夹路径', default: '/workspace/my-research' } },
    7: { type: 'string', meta: { description: '座位表相对路径；默认 dispatch/seats.json', default: 'dispatch/seats.json' } },
    11: { type: 'string', meta: { description: '文献调研环节执行工具', default: '' } },
    13: { type: 'string', meta: { description: '文献调研环节模型名', default: '' } },
    17: { type: 'string', meta: { description: '想法发散环节执行工具', default: '' } },
    21: { type: 'string', meta: { description: '想法发散环节模型名', default: '' } },
    25: { type: 'string', meta: { description: '想法发散单轮默认产出条数', default: '10' } },
    29: { type: 'string', meta: { description: '想法发散历史死胡同过滤', default: 'true' } },
    33: { type: 'string', meta: { description: '评审票（可自由增删，支持同工具多票）', default: '' } },
    37: { type: 'string', meta: { description: '前置查重环节执行工具', default: '' } },
    41: { type: 'string', meta: { description: '前置查重环节模型名', default: '' } },
    45: { type: 'string', meta: { description: '只读：本机探测到的工具与模型目录', default: '' } },
    49: { type: 'string', meta: { description: '只读：本机探测到的工具安装状态', default: '' } },
    53: { type: 'string', meta: { description: '历史兼容字段', default: '' } },
    57: { type: 'string', meta: { description: '历史兼容字段', default: '' } },
    90: {
      type: 'object',
      meta: { default: {} },
      dict: {
        repoRoot: 3,
        seatsFile: 7,
        scoutCommand: 11,
        scoutModel: 13,
        divergeCommand: 17,
        divergeModel: 21,
        divergeCount: 25,
        divergeUseDeadEnds: 29,
        reviewVotes: 33,
        noveltyCommand: 37,
        noveltyModel: 41,
        executorCatalog: 45,
        executorStatus: 49,
        otherStages: 53,
        stageOpinions: 57,
      },
    },
  },
};

let registered = null;
function mount(mode) {
  hookState.length = 0;
  hookCursor = 0;
  pendingEffects = [];
  mod.apply({
    slots: { inject: (n, fn) => { registered = { slot: n, ...fn() }; }, register: (def, comp) => ({ def, comp }) },
    get: () => undefined,
    uiWorkspace: { pickDirectory: async () => null },
    remote: {
      settings: {
        describe: mode === 'nogw'
          ? async () => { throw new Error('RPC 断开'); }
          : async () => ({ ok: true, value: { namespaces: [{ ns: 'research-dispatch', revision: 7, user: {}, value: VALUE, schema: SCHEMA }] } }),
        update: async () => ({ ok: true }),
      },
    },
  });
  return registered.comp({});
}
const tick = () => new Promise((r) => setImmediate(r));

function resolve(n) {
  if (n === null || n === undefined || n === false || n === true) return n;
  if (Array.isArray(n)) return n.map(resolve);
  if (typeof n === 'string' || typeof n === 'number') return n;
  if (!n || typeof n !== 'object') return n;
  if (typeof n.type === 'function') return resolve(n.type(n.props || {}));
  if (!n.props) return n;
  return { ...n, props: { ...n.props, children: resolve(n.props.children) } };
}
function render() {
  hookCursor = 0;
  pendingEffects = [];
  const tree = resolve(registered.comp({}));
  return { tree, effects: pendingEffects.slice() };
}

async function settled(mode) {
  mount(mode);
  let page = render();
  for (const fn of page.effects) { try { fn(); } catch { /* 忽略预览副作用异常 */ } }
  await tick();
  await tick();
  page = render();
  return page.tree;
}
const tree = await settled('ready');
const treeNoGw = await settled('nogw');

// 构造旗舰 /swarm 科研拓扑星图预览快照（含运行中沙箱脉冲、五维拆解条与人类唯一裁决台）
mod.__test.setSwarmSnapshot({
  ok: true,
  repoRoot: '/workspace/my-research',
  repoName: 'my-research',
  initialized: true,
  hasSeats: true,
  activeTopic: 'sparse-routing',
  activeWorkerCount: 1,
  pendingVerdictCount: 2,
  topics: [
    { id: 'sparse-routing', label: 'sparse-routing', archived: false, briefCount: 10, rawCount: 1 },
    { id: 'archive/papo-3b', label: 'archive/papo-3b', archived: true, briefCount: 20, rawCount: 2 },
  ],
  stages: [
    { id: 'S0', code: 'S0', title: '文献调研', badge: '8 篇卡', status: 'done' },
    { id: 'S1', code: 'S1', title: '基线复现', badge: '1 已签字', status: 'done' },
    { id: 'S2', code: 'S2', title: '候选发散', badge: '1 份池', status: 'done' },
    { id: 'S3', code: 'S3', title: '隔离拆单', badge: '10 张工单', status: 'done' },
    { id: 'S4', code: 'S4', title: '多票盲审', badge: '#1 21.3/25', status: 'working' },
    { id: 'S4.5', code: 'S4.5', title: '查重与探针', badge: '1 份查重', status: 'done' },
    { id: 'S5', code: 'S5', title: '人类拍板', badge: '2 待拍板', status: 'pending' },
    { id: 'S6', code: 'S6', title: '契约冻结', badge: '待立项', status: 'ready' },
  ],
  ideas: [
    { ideaId: 'idea_04', rank: 1, title: 'Paired Entropy-Gated Rollout Pruning', meanScore25: 21.3, voteCount: 3, verdict: 'pending' },
    { ideaId: 'idea_07', rank: 2, title: 'Layerwise Token-Budget Calibration', meanScore25: 19.5, voteCount: 3, verdict: 'go' },
    { ideaId: 'idea_02', rank: 3, title: 'Dual-Anchor KL Warmup', meanScore25: 15.0, voteCount: 3, verdict: 'kill' },
  ],
  graph: {
    focusStage: 'S4',
    focusIdeaId: 'idea_04',
    nodes: [
      { id: 'in-brief', col: 0, x: 118, y: 165, kind: 'input', title: '隔离工单 idea_04.md', subtitle: 'Paired Entropy-Gated Pruning', badge: 'sha:9f81c2', status: 'done' },
      { id: 'in-base', col: 0, x: 118, y: 345, kind: 'input', title: '基线尺子 BRIEF_BLOCK', subtitle: 'acc=78.4% (±0.3%, SIGNOFF)', badge: 'sha:4a10e8', status: 'done' },
      { id: 'hub-s4', col: 1, x: 342, y: 255, kind: 'hub', title: 'S4 盲审扇出派工器', subtitle: '单单推式隔离 · 零横向串写', badge: '3 票扇出', status: 'working' },
      { id: 'w-codex', col: 2, x: 590, y: 120, kind: 'worker', seat: 'codex', title: 'codex · 盲审票 1', subtitle: 'gpt-5 · os.tmpdir() 沙箱', badge: '22/25 · GO', durationMs: 19000, status: 'done' },
      { id: 'w-claude', col: 2, x: 590, y: 255, kind: 'worker', seat: 'claude', title: 'claude · 盲审票 2', subtitle: 'claude-sonnet-4-5 · os.tmpdir()', badge: '21/25 · GO', durationMs: 24000, status: 'done' },
      { id: 'w-agy', col: 2, x: 590, y: 390, kind: 'worker', seat: 'agy', title: 'agy · 盲审票 3', subtitle: 'gemini-4-carbon-high · 评审中', badge: '运行中', startedAt: Date.now() - 12000, status: 'working' },
      {
        id: 'gate-s5',
        col: 3,
        x: 848,
        y: 255,
        kind: 'gate',
        title: 'Ranking #1 · 人类拍板',
        subtitle: '总均分 21.3/25 · 2G/0R/0K',
        badge: '待人类裁决',
        status: 'pending',
        inspect: {
          title: 'idea_04：Paired Entropy-Gated Rollout Pruning',
          kindLabel: 'S4/S5 盲审汇总与人类裁决闸门',
          fileRel: 'ideas/sparse-routing/verdict-idea_04.md',
          sha: '9f81c204ab11',
          canVerdict: true,
          ideaId: 'idea_04',
          topic: 'sparse-routing',
          metaRows: [
            ['当前 Ranking', '#1 / 10（总均分 21.3 / 25）'],
            ['票型分布', '2 GO · 0 REVISE · 0 KILL（第 3 票运行中）'],
            ['物理沙箱校验', '全部 Worker 运行于 os.tmpdir() 独立目录'],
          ],
          pushedInputs: [
            { label: '唯一目标工单', rel: 'ideas/sparse-routing/briefs/idea_04.md', sha: '9f81c204ab11' },
            { label: '已签字基线锚点', rel: 'baselines/qwen-math/BRIEF_BLOCK.md', sha: '4a10e88cc302' },
            { label: '五维盲审角色规约', rel: 'roles/reviewer.md', sha: '71bc09ef3321' },
          ],
          dims: { novelty: 4.5, feasibility: 4.0, baseline_fit: 4.5, impl_cost: 4.0, expected_gain: 4.3 },
          dimReasons: {
            novelty: '将熵门控绑定在同题 rollout 配对裁剪上，避开了全局固定阈值退化',
            expected_gain: '主读数预期提升 +1.4pp，显著越过 2σ = 0.60pp 门槛',
          },
          actions: ['summary', 'run-novelty'],
          preview: '# 评审汇总摘录（idea_04）\n- codex (gpt-5): 22/25 [GO] 门控开销极低，两小时探针可直接证伪。\n- claude (claude-sonnet-4-5): 21/25 [GO] 与基线损失解耦干净，建议补查 2026 同类熵裁剪文献。',
        },
      },
    ],
    edges: [
      { id: 'e1', from: 'in-brief', to: 'hub-s4', status: 'done' },
      { id: 'e2', from: 'in-base', to: 'hub-s4', status: 'done' },
      { id: 'e3', from: 'hub-s4', to: 'w-codex', status: 'done' },
      { id: 'e4', from: 'hub-s4', to: 'w-claude', status: 'done' },
      { id: 'e5', from: 'hub-s4', to: 'w-agy', status: 'working' },
      { id: 'e6', from: 'w-codex', to: 'gate-s5', status: 'done' },
      { id: 'e7', from: 'w-claude', to: 'gate-s5', status: 'done' },
      { id: 'e8', from: 'w-agy', to: 'gate-s5', status: 'working' },
    ],
  },
});

hookState.length = 0;
hookCursor = 0;
const swarmTree = resolve(mod.__test.SwarmStudio({ repoRoot: '/workspace/my-research', embedded: false }));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SVG_ATTR_MAP = {
  viewBox: 'viewBox',
  fill: 'fill',
  stroke: 'stroke',
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  d: 'd',
  cx: 'cx',
  cy: 'cy',
  r: 'r',
  x: 'x',
  y: 'y',
  width: 'width',
  height: 'height',
  rx: 'rx',
  ry: 'ry',
  transform: 'transform',
  textAnchor: 'text-anchor',
  fontSize: 'font-size',
  fontWeight: 'font-weight',
  filter: 'filter',
  id: 'id',
  dx: 'dx',
  dy: 'dy',
  stdDeviation: 'stdDeviation',
  floodColor: 'flood-color',
  floodOpacity: 'flood-opacity',
  dur: 'dur',
  repeatCount: 'repeatCount',
  path: 'path',
};
function serStyle(st) {
  if (!st || typeof st !== 'object') return '';
  return Object.entries(st)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const cssKey = k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
      const cssVal = typeof v === 'number' && !/^(?:opacity|zIndex|fontWeight|lineHeight|flex)/.test(k) ? (v + 'px') : String(v);
      return cssKey + ':' + cssVal;
    })
    .join(';');
}
function attr(k, v, tag) {
  if (v === undefined || v === null || v === false || k === 'children') return '';
  if (tag === 'select' && k === 'value') return '';
  if (k === 'className') return ' class="' + esc(v) + '"';
  if (k === 'disabled') return v ? ' disabled' : '';
  if (k === 'checked') return v ? ' checked' : '';
  if (k === 'style') {
    const s = serStyle(v);
    return s ? ' style="' + esc(s) + '"' : '';
  }
  if (SVG_ATTR_MAP[k]) return ' ' + SVG_ATTR_MAP[k] + '="' + esc(v) + '"';
  if (k.startsWith('data-') || ['value', 'placeholder', 'type', 'min', 'max', 'title', 'role', 'aria-label', 'aria-hidden', 'aria-selected', 'aria-checked', 'aria-haspopup', 'aria-expanded'].includes(k)) {
    return ' ' + k + '="' + esc(v) + '"';
  }
  return '';
}
function ser(n) {
  if (n === null || n === undefined || n === false || n === true) return '';
  if (typeof n === 'string' || typeof n === 'number') return esc(n);
  if (Array.isArray(n)) return n.map(ser).join('');
  if (!n || typeof n !== 'object') return '';
  if (typeof n.type === 'function') return ser(n.type(n.props || {}));
  const tag = n.type;
  const p = n.props || {};
  if (tag === 'input') {
    const inputProps = { ...p, value: p.value === undefined ? '' : p.value };
    const inputAttrs = Object.keys(inputProps).map((k) => attr(k, inputProps[k], 'input')).join('');
    return '<input' + inputAttrs + '>';
  }
  const attrs = Object.keys(p).map((k) => attr(k, p[k], tag)).join('');
  let inner = ser(p.children);
  if (tag === 'select' && Array.isArray(p.children)) {
    const optOf = (o) => {
      const op = (o && o.props) || {};
      const valStr = String(op.value === undefined ? '' : op.value);
      const selected = valStr === String(p.value === undefined ? '' : p.value);
      const text = [].concat(op.children === undefined ? '' : op.children).flat(Infinity).join('');
      return '<option value="' + esc(valStr) + '"' + (selected ? ' selected' : '') + '>' + esc(text) + '</option>';
    };
    inner = p.children.flat(Infinity).filter((o) => o && typeof o === 'object').map((o) => {
      if (o.type === 'optgroup') {
        const gp = o.props || {};
        const opts = [].concat(gp.children || []).flat(Infinity)
          .filter((x) => x && typeof x === 'object').map(optOf).join('');
        return '<optgroup label="' + esc(gp.label === undefined ? '' : gp.label) + '">' + opts + '</optgroup>';
      }
      return optOf(o);
    }).join('');
  }
  return '<' + tag + attrs + '>' + inner + '</' + tag + '>';
}
const bodyHtml = ser(tree);
const bodyHtmlNoGw = ser(treeNoGw);
const swarmHtml = ser(swarmTree);

const demoGroups = mod.__test.groupedModels('dsh', [{ exec: 'dsh', models: [] }]);
function demoPicker(q, groups = demoGroups) {
  const st = { menu: { key: 'demo', hi: q ? 0 : 3, q }, setMenu() {} };
  return mod.__test.ModelPicker(Object.assign(
    { value: 'qoder/auto', groups, disabled: false, placeholder: '默认' },
    mod.__test.menuProps(st, 'demo', groups, 'qoder/auto', () => {}),
  ));
}
const demoHtml = ser(demoPicker(''));
const demoHtmlFiltered = ser(demoPicker('qwen-custom-preview'));

const LIGHT = [
  '--dsw-alias-bg-base:#faf9f5;--dsw-alias-bg-layer-1:#f5f4ed;--dsw-alias-bg-layer-2:#ecebe3;--dsw-alias-bg-layer-3:#e3e1d6',
  '--dsw-alias-border-l1:#e5e3d8;--dsw-alias-border-l2:#dad8cc;--dsw-alias-border-l3:#c7c4b6',
  '--dsw-alias-label-primary:#141413;--dsw-alias-label-secondary:#5e5d59;--dsw-alias-label-tertiary:#87867f',
  '--dsw-alias-brand-primary:#c96442;--dsw-alias-button-primary-fill:#c96442;--dsw-alias-button-primary-hover:#b55737;--dsw-alias-label-primary-foreground:#ffffff',
  '--dsw-alias-state-error-primary:#dc2626;--dsw-alias-state-success-primary:#059669;--dsw-alias-state-warn-primary:#d97706;--dsw-alias-state-warn-label:#b45309',
  '--dsw-font-family:ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif',
].join(';');
const DARK = [
  '--dsw-alias-bg-base:#1f1e1b;--dsw-alias-bg-layer-1:#262624;--dsw-alias-bg-layer-2:#30302e;--dsw-alias-bg-layer-3:#3a3936',
  '--dsw-alias-border-l1:rgba(255,255,255,.08);--dsw-alias-border-l2:rgba(255,255,255,.13);--dsw-alias-border-l3:rgba(255,255,255,.24)',
  '--dsw-alias-label-primary:#faf9f5;--dsw-alias-label-secondary:#c2c0b6;--dsw-alias-label-tertiary:#8e8d85',
  '--dsw-alias-brand-primary:#d97757;--dsw-alias-button-primary-fill:#d97757;--dsw-alias-button-primary-hover:#e2886b;--dsw-alias-label-primary-foreground:#ffffff',
  '--dsw-alias-state-error-primary:#f87171;--dsw-alias-state-success-primary:#34d399;--dsw-alias-state-warn-primary:#fbbf24;--dsw-alias-state-warn-label:#fbbf24',
  '--dsw-font-family:ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif',
].join(';');

const css = mod.__test.CSS();
const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
  + '<title>科研派工 v2.3.0 · dsh-claude-style 极简编排工作台 &amp; 可平移缩放 /swarm 拓扑星图预览</title><style>'
  + '*{box-sizing:border-box}body{margin:0;padding:28px;background:#e9e7df;font-family:ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif}'
  + '.wrap{display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:1820px;margin:0 auto}'
  + '.wrap-single{max-width:1820px;margin:0 auto 24px}'
  + '.pane{border-radius:16px;padding:24px 26px 28px;min-height:520px;box-shadow:0 8px 28px rgba(15,23,42,.08)}'
  + '.pane.light{background:var(--dsw-alias-bg-base);' + LIGHT + '}'
  + '.pane.dark{background:var(--dsw-alias-bg-base);' + DARK + '}'
  + '.cap{font:600 11px/1.4 inherit;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin:0 0 16px}'
  + css
  + '</style></head><body>'
  + '<div class="wrap-single"><div class="pane dark"><p class="cap">科研拓扑 /swarm 实时星图 · Dark Mode（S0→S6 全链路轨 + 三次贝塞尔扇出 + 人类唯一裁决台）</p>' + swarmHtml + '</div></div>'
  + '<div class="wrap-single"><div class="pane light"><p class="cap">科研拓扑 /swarm 实时星图 · Light Mode</p>' + swarmHtml + '</div></div>'
  + '<div class="wrap">'
  + '<div class="pane light"><p class="cap">阵容编排 Bento Studio · Light</p>' + bodyHtml + '</div>'
  + '<div class="pane dark"><p class="cap">阵容编排 Bento Studio · Dark</p>' + bodyHtml + '</div>'
  + '</div><div class="wrap" style="margin-top:24px">'
  + '<div class="pane light" style="grid-column:1 / span 2"><p class="cap">状态：连不上设置服务（五分区 Bento 骨架保留 + 控件禁用）</p>' + bodyHtmlNoGw + '</div>'
  + '</div>'
  + '<div class="wrap" style="margin-top:24px">'
  + '<div class="pane light"><p class="cap">模型弹层 · 打开态（含常驻默认项 + 搜索框）</p>'
  + '<div style="position:relative;width:300px;height:420px">' + demoHtml + '</div>'
  + '<p class="cap" style="margin-top:24px">同一弹层 · 输入自定义模型名后</p>'
  + '<div style="position:relative;width:300px;height:260px">' + demoHtmlFiltered + '</div></div>'
  + '<div class="pane dark"><p class="cap">模型弹层 · 打开态（Dark）</p>'
  + '<div style="position:relative;width:300px;height:420px">' + demoHtml + '</div>'
  + '<p class="cap" style="margin-top:24px">同一弹层 · 输入自定义模型名后</p>'
  + '<div style="position:relative;width:300px;height:260px">' + demoHtmlFiltered + '</div></div>'
  + '</div></body></html>\n';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'preview.html');
fs.writeFileSync(out, html.replace(/\r\n/g, '\n'), 'utf8');
console.log('wrote ' + out + ' (' + html.length + ' bytes)');
const cls = [...new Set((html.match(/class="(rdp[^"]*)"/g) || []).map((s) => s.slice(7, -1)))].sort();
console.log('用到 ' + cls.length + ' 个 rdp-* 类：' + cls.join(' '));
