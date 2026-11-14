// 设置页静态预览生成器（v2.0.0）：把真实组件树序列化成静态 HTML，复用同一份 CSS 渲染。
//
//   node test/preview.mjs   → test/preview.html
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

// 展示 v2.0.0 全自由编排：同工具多票（codex:gpt-5 + codex:o3）+ 含 gemini 候选 + 非 kimi 发散联动。
const VALUE = {
  repoRoot: '/workspace/project',
  seatsFile: 'dispatch/seats.json',
  otherStages: '',
  stageOpinions: '',
  reviewVotes: 'codex:gpt-5,codex:o3,claude:claude-sonnet-4-5,gemini:gemini-2.5-pro',
  executorCatalog: 'codex:gpt-5|o3;claude:claude-sonnet-4-5|claude-opus-4-1;dsh:jiyuan/glm-5.3;gemini:gemini-2.5-pro|gemini-2.5-flash;api:deepseek-chat;kimi:sensenova/kimi-k3',
  divergeCommand: 'claude',
  divergeModel: 'claude-sonnet-4-5',
};
const SCHEMA = {
  uid: 76,
  refs: {
    3: { type: 'string', meta: { description: '工作流项目根目录（含 dispatch/ 与 ideas/）', default: '/workspace/project' } },
    7: { type: 'string', meta: { description: '座位表相对路径；默认 dispatch/seats.json', default: 'dispatch/seats.json' } },
    15: { type: 'string', meta: { description: '历史兼容字段', default: '' } },
    19: { type: 'string', meta: { description: '历史兼容字段', default: '' } },
    23: { type: 'string', meta: { description: '评审票（可自由增删，支持同工具多票）', default: '' } },
    27: { type: 'string', meta: { description: '只读：本机探测到的执行者与模型目录', default: '' } },
    31: { type: 'string', meta: { description: '发散环节执行者', default: '' } },
    35: { type: 'string', meta: { description: '发散环节模型名', default: '' } },
    76: {
      type: 'object',
      meta: { default: {} },
      dict: {
        repoRoot: 3,
        seatsFile: 7,
        otherStages: 15,
        stageOpinions: 19,
        reviewVotes: 23,
        executorCatalog: 27,
        divergeCommand: 31,
        divergeModel: 35,
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
  if (typeof n.type === 'function') return resolve(n.type(n.props));
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function attr(k, v, tag) {
  if (v === undefined || v === null || v === false || k === 'children') return '';
  if (tag === 'select' && k === 'value') return '';
  if (k === 'className') return ' class="' + esc(v) + '"';
  if (k === 'disabled') return v ? ' disabled' : '';
  if (['value', 'placeholder', 'type', 'title', 'role', 'aria-hidden', 'aria-selected', 'aria-haspopup', 'aria-expanded'].includes(k)) {
    return ' ' + k + '="' + esc(v) + '"';
  }
  return '';
}
function ser(n) {
  if (n === null || n === undefined || n === false || n === true) return '';
  if (typeof n === 'string' || typeof n === 'number') return esc(n);
  if (Array.isArray(n)) return n.map(ser).join('');
  if (!n || typeof n !== 'object') return '';
  if (typeof n.type === 'function') return ser(n.type(n.props));
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

const demoGroups = mod.__test.groupedModels('dsh', [{ exec: 'dsh', models: [] }]);
function demoPicker(q) {
  const st = { menu: { key: 'demo', hi: 2, q }, setMenu() {} };
  return mod.__test.ModelPicker(Object.assign(
    { value: 'qoder/auto', groups: demoGroups, disabled: false, placeholder: '默认' },
    mod.__test.menuProps(st, 'demo', demoGroups, 'qoder/auto', () => {}),
  ));
}
const demoHtml = ser(demoPicker(''));
const demoHtmlFiltered = ser(demoPicker('qwen'));

const LIGHT = [
  '--dsw-alias-bg-base:#fcfcfb;--dsw-alias-bg-layer-1:#fcfcfb;--dsw-alias-bg-layer-2:#f2f0e9;--dsw-alias-bg-layer-3:#f9f9f6',
  '--dsw-alias-border-l1:#e8e6dc;--dsw-alias-border-l2:#e0ded4;--dsw-alias-border-l3:#d0cdc1',
  '--dsw-alias-label-primary:#141413;--dsw-alias-label-secondary:#6b6a63;--dsw-alias-label-tertiary:#8f8d84',
  '--dsw-alias-brand-primary:#d97757;--dsw-alias-button-primary-fill:#d97757;--dsw-alias-button-primary-hover:#c6613f;--dsw-alias-button-primary-text:#faf9f5',
  '--dsw-alias-state-danger-fg:#c0503f;--dsw-alias-state-success-fg:#4f8f5f',
  '--dsw-font-family:ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif',
].join(';');
const DARK = [
  '--dsw-alias-bg-base:#141413;--dsw-alias-bg-layer-1:#1c1b1a;--dsw-alias-bg-layer-2:#242320;--dsw-alias-bg-layer-3:#2e2c29',
  '--dsw-alias-border-l1:rgba(255,255,255,.09);--dsw-alias-border-l2:rgba(255,255,255,.14);--dsw-alias-border-l3:rgba(255,255,255,.30)',
  '--dsw-alias-label-primary:#faf9f5;--dsw-alias-label-secondary:#b9b6ac;--dsw-alias-label-tertiary:#8c8a80',
  '--dsw-alias-brand-primary:#d97757;--dsw-alias-button-primary-fill:#d97757;--dsw-alias-button-primary-hover:#e08a6d;--dsw-alias-button-primary-text:#141413',
  '--dsw-alias-state-danger-fg:#e0776a;--dsw-alias-state-success-fg:#79c08c',
  '--dsw-font-family:ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif',
].join(';');

const css = mod.__test.CSS();
const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
  + '<title>科研派工 · 设置卡片预览</title><style>'
  + '*{box-sizing:border-box}body{margin:0;padding:32px;background:#f3f1ea;font-family:ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif}'
  + '.wrap{display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:1720px;margin:0 auto}'
  + '.pane{border-radius:12px;padding:26px 28px 30px;min-height:560px;box-shadow:0 1px 2px rgba(0,0,0,.06)}'
  + '.pane.light{background:var(--dsw-alias-bg-base);' + LIGHT + '}'
  + '.pane.dark{background:var(--dsw-alias-bg-base);' + DARK + '}'
  + '.cap{font:500 11px/1.4 inherit;letter-spacing:.08em;text-transform:uppercase;color:#8f8d84;margin:0 0 18px}'
  + css
  + '</style></head><body><div class="wrap">'
  + '<div class="pane light"><p class="cap">Claude light</p>' + bodyHtml + '</div>'
  + '<div class="pane dark"><p class="cap">Claude dark</p>' + bodyHtml + '</div>'
  + '</div><div class="wrap" style="margin-top:24px">'
  + '<div class="pane light" style="grid-column:1 / span 2"><p class="cap">状态：连不上设置服务（控件禁用 + 恢复路径）</p>' + bodyHtmlNoGw + '</div>'
  + '</div>'
  + '<div class="wrap" style="margin-top:24px">'
  + '<div class="pane light"><p class="cap">模型弹层 · 打开态（light）</p>'
  + '<div style="position:relative;width:300px;height:400px">' + demoHtml + '</div>'
  + '<p class="cap" style="margin-top:24px">同一弹层 · 输入 qwen 后</p>'
  + '<div style="position:relative;width:300px;height:260px">' + demoHtmlFiltered + '</div></div>'
  + '<div class="pane dark"><p class="cap">模型弹层 · 打开态（dark）</p>'
  + '<div style="position:relative;width:300px;height:400px">' + demoHtml + '</div>'
  + '<p class="cap" style="margin-top:24px">同一弹层 · 输入 qwen 后</p>'
  + '<div style="position:relative;width:300px;height:260px">' + demoHtmlFiltered + '</div></div>'
  + '</div></body></html>\n';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'preview.html');
fs.writeFileSync(out, html, 'utf8');
console.log('wrote ' + out + ' (' + html.length + ' bytes)');
const cls = [...new Set((html.match(/class="(rdp[^"]*)"/g) || []).map((s) => s.slice(7, -1)))].sort();
console.log('用到 ' + cls.length + ' 个 rdp-* 类：' + cls.join(' '));
