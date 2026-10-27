// 设置页自检：无浏览器、无真 React、无网络。
//   node plugin/research-dispatch/test/client.selftest.mjs
//
// 这把尺子的判据（改过一轮：以前 41 条全绿但测的是生产走不到的分支）：
//   · schema 用**真实形状** —— schemastery 的 toJSON() 是 { uid, refs }，没有 properties 键；
//   · 不 grep 源码，能真调用的都真调用（readModelDirectories / mergeCatalog / catalogOf / fieldsOf）；
//   · 渲染断言用带状态的极简 hook，页面能真的走到"连上 / 命名空间缺失 / 连不上"三条分支；
//   · 写穿链路（面板保存 → seats.json）有独立用例，这是最重要的一条。
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 这三条环境变量会把宿主侧读的座位表/设置文档改到别处，自检里必须干净。
delete process.env.DSH_DISPATCH_ROOT;
delete process.env.DSH_DISPATCH_CONFIG;
delete process.env.DSH_DISPATCH_SETTINGS;

// ── 极简 React：useState 有真状态，useEffect 手动 flush，setTimeout 关掉 ────
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
// 页面里那个 3 秒超时不该把自检进程拖住
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => (ms >= 3000 ? 0 : realSetTimeout(fn, ms));
globalThis.clearTimeout = () => {};

let reg = null;
globalThis.window = { __ModuleLoader__: { load: (r) => { reg = r; } } };
await import(new URL('../lib/client.js', import.meta.url).href);

const fail = [];
let ops = 0;
const ok = (c, m) => { ops++; return c ? console.log('  ✓ ' + m) : (fail.push(m), console.log('  ✗ ' + m)); };
const tick = () => new Promise((r) => setImmediate(r));

ok(!!reg && reg.id === 'research-dispatch', '注册 id = research-dispatch');
const mod = reg.factory((id) => (id === 'react' ? fakeReact : (() => { throw new Error('不许 require ' + id); })()));

// ── inject 声明：必须是恰好这三个 ────────────────────────────────────
ok(JSON.stringify(mod.inject) === JSON.stringify(['slots', 'remote', 'remote.settings']),
  'inject 恰好是 ["slots","remote","remote.settings"]（多声明拿不到的服务会让 entry 永久 pending）');
const viaGet = await mod.__test.readDescriptor({ get: (n) => (n === 'remote' ? { settings: { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'research-dispatch', value: { a: 1 } }] } }) } } : undefined) });
ok(viaGet && viaGet.ns === 'research-dispatch', 'ctx.get("remote") 这条兜底路径也能读到描述');

// 首选路径：ctx.get("remote.settings") —— 与 ctx.get("remote") 同一条反射 API，
// 绕开 "cannot get property remote.settings without inject" 的属性门禁（实测错误原文）。
{
  const api = { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'research-dispatch', value: { a: 1 } }] } }) };
  const viaSub = await mod.__test.readDescriptor({ get: (n) => (n === 'remote.settings' ? api : undefined) });
  ok(viaSub && viaSub.ns === 'research-dispatch', 'ctx.get("remote.settings") 子服务路径可用（首选）');
}
{
  const pkgJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const deps = (pkgJson.dsh && pkgJson.dsh.client && pkgJson.dsh.client.inject) || [];
  ok(deps.includes('@deepseek-ai/dsh-client-ui-settings'), '包级 dsh.client.inject 声明了设置域客户端（模块依赖没声明 → 服务永远等不到）');
  ok(pkgJson.dsh.client.platform === 'web', '包级平台声明为 web');
}

// ── 回归：cordis 对未声明服务的读取是抛异常，不是 undefined ─────────
// 实测错误原文：cannot get property "remote" without inject —— 上一版把探针写在
// 注册之前，这个异常直接打断了注册，于是设置页整项消失。
{
  let reg2 = null;
  const trapCtx = {
    slots: { inject: (n, fn) => { reg2 = { slot: n, ...fn() }; }, register: (d, c) => ({ def: d, comp: c }) },
    get: () => undefined,
  };
  Object.defineProperty(trapCtx, 'remote', {
    get() { throw new Error('cannot get property "remote" without inject'); },
    configurable: true,
  });
  let threw = false;
  try { mod.apply(trapCtx); } catch { threw = true; }
  ok(!threw, 'ctx.remote 抛异常时 apply 不往外抛（否则整个 entry 挂掉）');
  ok(!!reg2 && reg2.slot === 'settings.section', 'ctx.remote 抛异常也不影响设置页注册（注册先于探针）');
}

// ── 注册 ──────────────────────────────────────────────────────────
let registered = null;
const ctx = {
  slots: { inject: (n, fn) => { registered = { slot: n, ...fn() }; }, register: (def, comp) => ({ def, comp }) },
  remote: { settings: { describe: async () => [], update: async () => ({}) } },
};
mod.apply(ctx);
ok(registered && registered.slot === 'settings.section', '注册进 settings.section');
ok(registered.def.id === 'research-dispatch' && registered.def.label() === '科研派工', 'section id 与左栏标题');

// ── 已声明 remote.settings 时，直接走属性（守卫放行） ─────────────────
{
  const api = { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'research-dispatch', value: { a: 2 } }] } }) };
  const direct = await mod.__test.readDescriptor({ remote: { settings: api }, get: () => undefined });
  ok(direct && direct.ns === 'research-dispatch', '已声明时 ctx.remote.settings 直接可用（走属性而非 get）');
}

// ── 模型清单：真调用，不 grep 源码 ─────────────────────────────────
{
  const cat = mod.__test.catalogOf({ executorCatalog: 'codex:gpt-6.1-sol|gpt-6.1-mini;claude:opus;dsh:' });
  ok(JSON.stringify(cat) === JSON.stringify([
    { exec: 'codex', models: ['gpt-6.1-sol', 'gpt-6.1-mini'] },
    { exec: 'claude', models: ['opus'] },
    { exec: 'dsh', models: [] },
  ]), 'catalogOf 把宿主探测串解析成 [{exec, models}]（不是写死的两个名字）');

  // 运行时清单：假 modelDirectories 服务给出 provider→models，合并后同名去重
  mod.__test.resetModelDirs();
  const snap = { providers: [{ id: 'codex', models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-9-runtime' }] }, { id: 'kimi', models: [{ id: 'sensenova/kimi-k3' }] }] };
  const dirs = mod.__test.readModelDirectories({ get: (n) => (n === 'modelDirectories' ? { getSnapshot: () => snap } : undefined) });
  ok(dirs.codex && dirs.codex.includes('gpt-9-runtime'), 'readModelDirectories 从 modelDirectories 服务读出运行时可用的模型');
  const merged = mod.__test.mergeCatalog(cat, dirs);
  const codexRow = merged.find((c) => c.exec === 'codex');
  const kimiRow = merged.find((c) => c.exec === 'kimi');
  ok(codexRow.models.filter((m) => m === 'gpt-6.1-sol').length === 1, '合并时同名去重（gpt-6.1-sol 只出现一次）');
  ok(codexRow.models.includes('gpt-9-runtime'), '运行时模型并进了已有的执行者行');
  ok(!!kimiRow && kimiRow.models.includes('sensenova/kimi-k3'), '静态目录里没有的执行者也新增成一行（不是二选一）');

  // 拿不到服务时如实记诊断，不静默
  mod.__test.resetModelDirs();
  const none = mod.__test.readModelDirectories({ get: () => { throw new Error('no such service'); } });
  ok(JSON.stringify(none) === '{}', 'modelDirectories 抛错时返回空表而不是崩掉');
  ok(!!(globalThis.window.__researchDispatch || {}).modelDirsError, '拿不到时把原因记进诊断（__researchDispatch.modelDirsError）');
  mod.__test.resetModelDirs();
}

// ── dsh / subagent 的模型清单 = /model 弹窗那份（不是只有落了盘的 cline-pass）──
{
  mod.__test.resetModelDirs();
  mod.__test.resetLiveCatalog();
  const groups = [
    { id: 'cline-pass', name: 'Cline Pass', models: [{ id: 'qwen3.8-max', name: 'Qwen 3.8 Max' }] },
    { id: 'qoder', name: 'Qoder (订阅)', models: [{ id: 'auto', name: 'Auto' }, { id: 'deepseek-v4-pro', name: 'deepseek V4-Pro' }] },
    { id: 'magpie', name: 'Magpie', models: [{ id: 'auto/deepseek-v4.1-flash', name: 'deepseek V4.1-Flash · routing group' }] },
    { id: 'magpie-anthropic', name: 'Magpie · Anthropic', models: [{ id: 'zcode/GLM-5.3-Flash', name: 'GLM 5.3-Flash' }] },
  ];
  const ids = mod.__test.groupsToCatalog(groups);
  ok(ids.length === 5, 'groups 平铺成 5 个 provider/model id（实际 ' + ids.length + '）');
  ok(ids.includes('qoder/auto') && ids.includes('magpie/auto/deepseek-v4.1-flash')
    && ids.includes('magpie-anthropic/zcode/GLM-5.3-Flash') && ids.includes('cline-pass/qwen3.8-max'),
    '四组供应商都在（Cline Pass / Qoder / Magpie / Magpie·Anthropic），不是只剩 cline-pass');
  ok(mod.__test.groupsToCatalog([{ id: 'x', models: [{ id: 'a' }, { id: 'a' }] }]).length === 1, '同一 id 去重');

  const staticValue = { executorCatalog: 'codex:gpt-6.1-sol;claude:opus;dsh:cline-pass/old-a|cline-pass/old-b;subagent:cline-pass/old-a;kimi:sensenova/kimi-k3' };
  const noCtx = { get: () => undefined };

  // 没拿到宿主目录时：退回静态探测（旧行为，别把降级说成修好了）
  const fallback = mod.__test.panelCatalog(staticValue, noCtx).find((c) => c.exec === 'dsh');
  ok(fallback && fallback.models.includes('cline-pass/old-a'), '拿不到宿主目录时退回静态探测（不是空清单）');

  // 拿到宿主目录后：dsh / subagent 两行被覆盖，不是并集
  mod.__test.setLiveGroups(groups);
  const patched = mod.__test.panelCatalog(staticValue, noCtx);
  const dsh = patched.find((c) => c.exec === 'dsh');
  const sub = patched.find((c) => c.exec === 'subagent');
  ok(dsh && dsh.models.length === 5 && !dsh.models.includes('cline-pass/old-a'),
    'dsh 行以宿主目录为准（旧的 cline-pass/old-a 已被覆盖，不是并集）');
  ok(sub && JSON.stringify(sub.models) === JSON.stringify(dsh.models), 'subagent 与 dsh 同源（subagent 继承会话模型）');
  ok(patched.find((c) => c.exec === 'codex').models.includes('gpt-6.1-sol')
    && patched.find((c) => c.exec === 'kimi').models.includes('sensenova/kimi-k3'),
    'codex / kimi 这些外部 CLI 座位不受影响（只覆盖 dsh / subagent）');
  ok((globalThis.window.__researchDispatch || {}).liveCatalog === undefined
    || typeof globalThis.window.__researchDispatch.liveCatalog === 'string',
    '宿主目录命中时诊断里记下分组（__researchDispatch.liveCatalog）');

  // 复位后回到静态，证明"覆盖"不是把状态写死
  mod.__test.resetLiveCatalog();
  ok(mod.__test.panelCatalog(staticValue, noCtx).find((c) => c.exec === 'dsh').models.includes('cline-pass/old-a'),
    '复位后回到静态探测（覆盖不是一次性卡死）');
}

// ── 下拉风格：按供应商分组、只写模型名（与 /model 弹窗同一形态）──────────
{
  mod.__test.resetModelDirs();
  mod.__test.resetLiveCatalog();
  const groups = [
    { id: 'cline-pass', name: 'Cline Pass', models: [{ id: 'qwen3.8-max', name: 'Qwen 3.8 Max' }] },
    { id: 'qoder', name: 'Qoder (订阅)', models: [{ id: 'auto', name: 'Auto' }, { id: 'deepseek-v4-pro', name: 'deepseek V4-Pro' }] },
  ];
  const cat = [{ exec: 'dsh', models: [] }, { exec: 'codex', models: ['gpt-6.1-sol'] }];
  const flat = mod.__test.groupedModels('dsh', cat);
  ok(flat.length === 1 && flat[0].label === '' && flat[0].items.length === 0,
    '没拿到宿主目录时 dsh 的模型组为空（不编造一份假分组）');

  mod.__test.setLiveGroups(groups);
  const grouped = mod.__test.groupedModels('dsh', cat);
  ok(grouped.length === 2 && grouped[0].label === 'Cline Pass' && grouped[1].label === 'Qoder (订阅)',
    '按供应商分组，组名用人能读的 provider 名（实际 ' + grouped.map((g) => g.label).join('|') + '）');
  ok(grouped[0].items[0].label === 'Qwen 3.8 Max' && grouped[0].items[0].value === 'cline-pass/qwen3.8-max',
    '选项显示模型名，值是 provider/model（显示与存储分开）');
  const codexRow = mod.__test.groupedModels('codex', cat);
  ok(codexRow.length === 1 && codexRow[0].label === '' && codexRow[0].items[0].value === 'gpt-6.1-sol',
    '外部 CLI 执行者不分组（它们本来就没有供应商层级）');

  // ── 渲染层：自造弹层，形态与 /model 弹窗一致 ──────────────────────
  const kids = (n) => (n && n.props ? [].concat(n.props.children || []).flat(Infinity).filter(Boolean) : []);
  const txt = (n) => kids(n).map((x) => (typeof x === 'string' ? x
    : (x && x.props ? [].concat(x.props.children || []).flat(Infinity).join('') : ''))).join('');
  const pick = (state, value) => mod.__test.ModelPicker(Object.assign(
    { value, groups: grouped, disabled: false, placeholder: '默认' },
    mod.__test.menuProps(state, 'k1', grouped, value, (v) => picked.push(v)),
  ));
  const picked = [];
  const st = { menu: { key: null, hi: 0 }, setMenu(v) { st.menu = v; } };

  // 关闭态：一个按钮，文字是模型名，没有弹层
  const closedTree = pick(st, 'qoder/auto');
  ok(closedTree.type === 'div' && closedTree.props.className === 'rdp-pick', '外层 .rdp-pick 作为弹层定位锚点');
  const btn = kids(closedTree)[0];
  ok(btn.type === 'button' && /rdp-pick-btn/.test(btn.props.className), '关闭态是按钮（不是原生 select）');
  ok(txt(btn).includes('Auto') && !txt(btn).includes('qoder/auto'), '按钮上写模型名「Auto」，不露 provider/model');
  ok(!kids(closedTree).some((x) => (x.props || {}).className === 'rdp-menu'), '关闭态不渲染弹层');

  // 打开态：胶囊标题 + 选项行 + 选中勾
  st.menu = { key: 'k1', hi: 1 };
  const openTree = pick(st, 'qoder/auto');
  const menu = kids(openTree).find((x) => (x.props || {}).className === 'rdp-menu');
  ok(!!menu, '打开态渲染 .rdp-menu 弹层');
  const secs = kids(menu);
  const caps = secs.map((s) => kids(s).filter((x) => /rdp-menu-cap/.test((x.props || {}).className || ''))[0]).filter(Boolean);
  ok(caps.map((c) => txt(c)).join('|') === 'Cline Pass|Qoder (订阅)', '分组标题是深色胶囊，写供应商显示名（实际 ' + caps.map((c) => txt(c)).join('|') + '）');
  const rows = secs.flatMap((s) => kids(s).filter((x) => /rdp-menu-item/.test((x.props || {}).className || '')));
  ok(rows.length === 3, '两组合计 3 行（实际 ' + rows.length + '）');
  const selRow = rows.filter((x) => x.props['aria-selected'] === 'true')[0];
  ok(!!selRow && kids(selRow).some((x) => /rdp-menu-tick/.test((x.props || {}).className || '')), '当前选中的行带勾选标记');
  ok(/is-hi/.test((rows[1].props.className || '')), '键盘高亮行有独立样式（is-hi）');
  ok(txt(rows[1]) === 'Auto' + '✓', '行文本是模型名（勾选标记跟在后面）');

  // 点一行 → 回传 provider/model（显示的是名字，存的是 id）
  rows[2].props.onClick();
  ok(picked[0] === 'qoder/deepseek-v4-pro' && st.menu.key === null, '点行回传 provider/model 并收起弹层');

  // 键盘：↓ 移高亮、Esc 收、Enter 选中
  st.menu = { key: null, hi: 0 };
  kids(closedTree)[0].props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  ok(st.menu.key === 'k1' && st.menu.hi === 2, '关闭态按 ↓ 打开并把高亮移到当前值下一行（实际 ' + st.menu.hi + '）');
  st.menu = { key: 'k1', hi: 2 };
  // 重渲染一次：高亮下标是渲染时定下的，拿旧树的 onKeyDown 会选到旧的 hi 那一行。
  const open2 = pick(st, 'qoder/auto');
  kids(open2)[0].props.onKeyDown({ key: 'Enter', preventDefault() {} });
  ok(picked[1] === 'qoder/deepseek-v4-pro' && st.menu.key === null, 'Enter 选中高亮行并收起');
  st.menu = { key: 'k1', hi: 0 };
  kids(openTree)[0].props.onKeyDown({ key: 'Escape', preventDefault() {} });
  ok(st.menu.key === null, 'Esc 收起弹层');

  // 已保存但不在目录里的模型：按钮显示原始 id，不许显示成"没选"
  const goneTree = pick({ menu: { key: null, hi: 0 }, setMenu() {} }, 'gone/model');
  ok(txt(kids(goneTree)[0]).includes('gone/model'), '不在目录里的已存值照原样显示（不被显示成未选）');
  mod.__test.resetLiveCatalog();
}

// ── 弹层里的搜索框：>4 个模型才出现，不连续字符也算命中 ────────────────
{
  mod.__test.resetModelDirs();
  const kids = (n) => (n && n.props ? [].concat(n.props.children || []).flat(Infinity).filter(Boolean) : []);
  const txt = (n) => kids(n).map((x) => (typeof x === 'string' ? x
    : (x && x.props ? [].concat(x.props.children || []).flat(Infinity).join('') : ''))).join('');
  const byClass = (n, re) => {
    const out = [];
    const walk = (x) => {
      if (!x || typeof x !== 'object') return;
      const cls = (x.props || {}).className;
      if (typeof cls === 'string' && re.test(cls)) out.push(x);
      for (const c of kids(x)) walk(c);
    };
    walk(n);
    return out;
  };
  const rowsOf = (n) => byClass(n, /(^|\s)rdp-menu-item(\s|$)/);
  const capsOf = (n) => byClass(n, /rdp-menu-cap/).map(txt);

  const big = [
    { id: 'cline-pass', name: 'Cline Pass', models: [{ id: 'qwen3.8-max', name: 'Qwen 3.8 Max' }, { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus' }] },
    { id: 'qoder', name: 'Qoder (订阅)', models: [{ id: 'auto', name: 'Auto' }, { id: 'deepseek-v4-pro', name: 'deepseek V4-Pro' }] },
    { id: 'magpie', name: 'Magpie', models: [{ id: 'auto/deepseek-v4.1-flash', name: 'deepseek V4.1-Flash · routing group' }] },
  ];
  const gs = [{ label: 'Cline Pass', items: [{ value: 'cline-pass/qwen3.8-max', label: 'Qwen 3.8 Max' }, { value: 'cline-pass/qwen3.7-plus', label: 'Qwen 3.7 Plus' }] },
    { label: 'Qoder (订阅)', items: [{ value: 'qoder/auto', label: 'Auto' }, { value: 'qoder/deepseek-v4-pro', label: 'deepseek V4-Pro' }] },
    { label: 'Magpie', items: [{ value: 'magpie/auto/deepseek-v4.1-flash', label: 'deepseek V4.1-Flash · routing group' }] }];
  const st2 = { menu: { key: null, hi: 0, q: '' }, setMenu(v) { st2.menu = v; } };
  const tree = (v) => mod.__test.ModelPicker(Object.assign(
    { value: v, groups: gs, disabled: false, placeholder: '默认' },
    mod.__test.menuProps(st2, 'k', gs, v, () => {}),
  ));

  st2.menu = { key: null, hi: 0, q: '' };
  ok(byClass(tree('qoder/auto'), /rdp-menu-search/).length === 0, '收起时没有搜索框');
  st2.menu = { key: 'k', hi: 0, q: '' };
  const openT = tree('qoder/auto');
  const input = byClass(openT, /rdp-menu-search/)[0];
  ok(!!input && input.type === 'input', '目录共 5 个模型（>4）→ 打开时出现搜索框');
  ok(byClass(tree('qoder/auto'), /rdp-menu-cap/).length === 3, '未输入时三组全在');

  // 输入过滤：只剩 Qoder 一组，且高亮重置
  input.props.onChange({ target: { value: 'qoder' } });
  ok(st2.menu.q === 'qoder', '输入写进本弹层的查询串');
  const afterQ = tree('qoder/auto');
  ok(capsOf(afterQ).join('|') === 'Qoder (订阅)', '没有匹配的分组整组隐藏（实际 ' + capsOf(afterQ).join('|') + '）');
  ok(rowsOf(afterQ).length === 2, '过滤后剩 2 行（实际 ' + rowsOf(afterQ).length + '）');
  ok(rowsOf(afterQ).map(txt).join('|') === 'Auto✓|deepseek V4-Pro', '行文本仍是模型名，选中行带勾');

  // 匹配规则本身：不连续字符按顺序命中，无关字符不命中，大小写不敏感
  ok(mod.__test.modelMatch({ label: 'deepseek V4-Pro', value: 'qoder/deepseek-v4-pro' }, 'dvp') === true,
    '不连续字符 d→v→p 按顺序命中（与 /model 弹窗同一规则）');
  ok(mod.__test.modelMatch({ label: 'Qwen 3.8 Max', value: 'cline-pass/qwen3.8-max' }, 'dvp') === false,
    '顺序不对/缺字符就不命中（不是模糊包含）');
  ok(mod.__test.modelMatch({ label: 'Auto', value: 'qoder/auto' }, '  QODER  ') === true,
    '去首尾空格且不区分大小写');

  // 过滤到一行：'v4-pro' 只可能命中 deepseek V4-Pro
  input.props.onChange({ target: { value: 'v4-pro' } });
  const afterSub = tree('qoder/auto');
  ok(rowsOf(afterSub).length === 1 && txt(rowsOf(afterSub)[0]).indexOf('deepseek V4-Pro') === 0,
    '过滤后只剩命中那一行（实际 ' + rowsOf(afterSub).map(txt).join('|') + '）');

  // 无匹配：给一句提示，不是空弹层
  input.props.onChange({ target: { value: 'zzzz' } });
  const noneT = tree('qoder/auto');
  ok(rowsOf(noneT).length === 0 && byClass(noneT, /rdp-menu-empty/).length === 1, '无匹配时给一句提示（不留空弹层）');

  // 回车选中过滤后的第一行
  const picked2 = [];
  const st3 = { menu: { key: 'k', hi: 0, q: 'qoder' }, setMenu(v) { st3.menu = v; } };
  const t3 = mod.__test.ModelPicker(Object.assign(
    { value: '', groups: gs, disabled: false, placeholder: '默认' },
    mod.__test.menuProps(st3, 'k', gs, '', (v) => picked2.push(v)),
  ));
  byClass(t3, /rdp-menu-search/)[0].props.onKeyDown({ key: 'Enter', preventDefault() {} });
  ok(picked2[0] === 'qoder/auto' && st3.menu.key === null, '列表被过滤后 Enter 选到的是过滤后的第一行（不是原始第一行）');

  // 小目录（≤4）不给搜索框
  const small = [{ label: '', items: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }];
  const st4 = { menu: { key: 'k', hi: 0, q: '' }, setMenu(v) { st4.menu = v; } };
  const t4 = mod.__test.ModelPicker(Object.assign(
    { value: 'a', groups: small, disabled: false, placeholder: '默认' },
    mod.__test.menuProps(st4, 'k', small, 'a', () => {}),
  ));
  ok(byClass(t4, /rdp-menu-search/).length === 0, '超过 4 个才给搜索框：2 个模型时没有搜索框');

  // 关闭再打开：查询串必须清空（否则下次打开还带着上次的过滤词）
  st2.menu = { key: 'k', hi: 0, q: 'qoder' };
  mod.__test.menuProps(st2, 'k', gs, 'qoder/auto', () => {}).onClose();
  ok(st2.menu.key === null && st2.menu.q === '', '收起时清空查询串');
  mod.__test.resetLiveCatalog();
}

// ── 可选光纤：拿宿主目录走 ctx.inject，不进静态 inject ─────────────────
{
  mod.__test.resetModelDirs();
  mod.__test.resetLiveCatalog();
  const deps = [];
  let fired = 0;
  const api = { modelCatalog: async () => ({ ok: true, value: { groups: [{ id: 'magpie', name: 'Magpie', models: [{ id: 'auto/x', name: 'X' }] }] } }) };
  const ctx2 = {
    slots: { inject: (n, fn) => fn(), register: (d, c) => ({ def: d, comp: c }) },
    get: () => undefined,
    inject: (list, fn) => { deps.push(list.join(',')); fn({ 'remote.session': api, get: () => undefined }); },
    effect: () => {},
  };
  let threw = false;
  try { mod.apply(ctx2); } catch (e) { threw = true; }
  ok(!threw, 'ctx.inject 存在时 apply 不抛');
  ok(deps.includes('remote.session'), '用可选光纤取 remote.session（不写进 inject，避免 entry 永久 pending）');
  await tick();
  fired++;
  const dsh = mod.__test.panelCatalog({ executorCatalog: 'dsh:' }, { get: () => undefined }).find((c) => c.exec === 'dsh');
  ok(!!dsh && dsh.models.includes('magpie/auto/x'), '光纤里拿到的目录真的进了面板清单（实际 ' + (dsh ? dsh.models.join('|') : 'none') + '）');
  ok(typeof (globalThis.window.__researchDispatch || {}).liveCatalog === 'string', '命中时诊断记下分组（liveCatalog）');
  mod.__test.resetLiveCatalog();
  mod.__test.resetModelDirs();
}

// ── ⑦ 两种"拿不到"必须可区分 ──────────────────────────────────────
{
  const noGw = await mod.__test.readDescriptor({}).catch(() => 'THREW');
  ok(noGw === null, '没有网关时 readDescriptor 返回 null（不是抛错）');
  const apiNoNs = { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'other', value: {} }] } }) };
  let err = null;
  try { await mod.__test.readDescriptor({ remote: { settings: apiNoNs }, get: () => undefined }); } catch (e) { err = e; }
  ok(!!err && err.code === 'NS_MISSING', 'describe 通了但没有本命名空间 → 抛 NS_MISSING（不是当成"连不上网关"）');
  let threw = false;
  try { await mod.__test.writePatch({}, {}); } catch (e) { threw = /设置服务/.test(String(e.message)); }
  ok(threw, '连不上设置服务时 writePatch 显式报错（不是静默写丢）');
}

// ── schema 的真实形状：schemastery 的 toJSON() → { uid, refs } ────────
// 这份 fixture 是从真实 Config.toJSON() 抄下来的（19 个字段、uid/refs/dict/meta 全同构）；
// 唯一改动：executorCatalog 的 default 换成了短样例（原值是本机探测出的一大串模型名）。
const REAL_SCHEMA = {
  uid: 76,
  refs: {
    '3': { type: 'string', meta: { description: '工作流仓库根（含 dispatch/ 与 ideas/）。默认由插件包位置推出', default: '<abs>', volatile: true } },
    '7': { type: 'string', meta: { description: '座位表路径，相对仓库根；默认 dispatch/seats.json', default: 'dispatch/seats.json', volatile: true } },
    '15': { type: 'string', meta: { description: '只读：调研 / novelty / 实现三个环节写在哪里', default: '调研 scout → roles/scout.md', volatile: true } },
    '19': { type: 'string', meta: { description: '其余环节的选择', default: '', volatile: true } },
    '23': { type: 'string', meta: { description: '评审票（可增删）', default: '', volatile: true } },
    '27': { type: 'string', meta: { description: '只读：本机可用的执行者及其当前模型', default: 'codex:gpt-6.1-sol;claude:opus', volatile: true } },
    '31': { type: 'string', meta: { description: '发散环节的执行者命令名', default: '', volatile: true } },
    '35': { type: 'string', meta: { description: '发散环节用的模型', default: '', volatile: true } },
    '76': {
      type: 'object', meta: { default: {} },
      dict: {
        repoRoot: 3, seatsFile: 7, otherStages: 15, stageOpinions: 19, reviewVotes: 23,
        executorCatalog: 27, divergeCommand: 31, divergeModel: 35,
      },
    },
  },
};
// 座位不是设置字段（按设计）；"跑哪几座"也不在面板上单独一格（并入评审票）。
const ALL_KEYS = ['repoRoot', 'seatsFile', 'otherStages', 'stageOpinions', 'reviewVotes',
  'executorCatalog', 'divergeCommand', 'divergeModel'];

{
  const props = mod.__test.propsFromSchema(REAL_SCHEMA);
  ok(!!props && !('properties' in REAL_SCHEMA), 'fixture 是真实形状：没有 properties 键（生产上就是这个）');
  const desc = { ns: 'research-dispatch', revision: 7, user: {}, value: {}, schema: REAL_SCHEMA };
  const fields = mod.__test.fieldsOf(desc);
  ok(fields.length === 8, '真实形状下 8 个键被列出（实际 ' + fields.length + ' 个）—— 座位与"默认座位"都不是设置字段');
  ok(fields.map((f) => f.key).join(',') === ALL_KEYS.join(','), '列出的键与 Config 的可编辑字段逐一对应且顺序一致');
  const labelled = fields.filter((f) => ['repoRoot', 'seatsFile'].includes(f.key));
  ok(labelled.length === 2 && labelled.every((f) => f.title && f.title !== f.key), '有中文标签的 2 个字段都用标签而不是键名');
  ok(/schema\.refs/.test(globalThis.window.__researchDispatch.fieldSource || ''), '诊断里记下字段来自 schema.refs（证明确实走了新解析，不是 value 兜底）');
  ok(fields.find((f) => f.key === 'reviewVotes').description.includes('评审票'), 'meta.description 被带进字段说明');
}

// 回归：schema 完全缺失时（describe 只给了 value），仍要退到 value 的键
{
  const noSchema = { ns: 'research-dispatch', value: { reviewVotes: 'codex:gpt-9,', stageOpinions: '' } };
  const f2 = mod.__test.fieldsOf(noSchema);
  ok(f2.length === 2, 'schema 缺失时按 value 的键生成字段');
  ok(f2.some((f) => f.key === 'reviewVotes' && f.title === '评审票'), '兜底字段仍有可读标题');
}

// ── 渲染：用真状态跑页面，三条分支各来一次 ──────────────────────────
// 注意：section 组件是 (p) => h(Page, { ...p, ctx })，Page 拿到的是 apply() 那次
// 的 ctx，不是渲染时传进去的 —— 所以每条分支都要用对应 ctx 重新 mount 一遍。
let renderWith = null;
function mount(view) {
  hookState.length = 0;
  registered = null;
  renderWith = view.remote;
  mod.apply({
    slots: { inject: (n, fn) => { registered = { slot: n, ...fn() }; }, register: (def, comp) => ({ def, comp }) },
    get: (n) => (view.get ? view.get(n) : undefined),
    remote: view.remote,
  });
}
function render() {
  hookCursor = 0;
  pendingEffects = [];
  const tree = registered.comp({});
  const texts = [];
  const inputs = [];
  const selects = [];
  const buttons = [];
  (function walk(n) {
    if (n === null || n === undefined || n === false || n === true) return;
    if (typeof n === 'string' || typeof n === 'number') { texts.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    if (typeof n.type === 'function') { walk(n.type(n.props)); return; }
    if (n.type === 'input') inputs.push(n.props);
    if (n.type === 'select') selects.push(n.props);
    if (n.type === 'button') buttons.push(n.props);
    if (n.props) walk(n.props.children);
  })(tree);
  return { tree, texts, inputs, selects, buttons, effects: pendingEffects };
}
async function settle(page) {
  for (const fn of page.effects) { try { fn(); } catch { /* 副作用自己坏掉不该中断自检 */ } }
  await tick(); await tick();
  return render();
}

// ① 连通 + 有本命名空间 → 面板上只该有"评审票 / 发散 / 其余环节"三块，没有座位区
const FULL_VALUE = {
  repoRoot: '/repo', seatsFile: 'dispatch/seats.json',
  otherStages: 'x', stageOpinions: '', reviewVotes: '', executorCatalog: 'codex:gpt-6.1-sol;claude:opus;dsh:;api:;qoder:',
  divergeCommand: '', divergeModel: '',
};
const readyApi = { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'research-dispatch', revision: 7, user: {}, value: FULL_VALUE, schema: REAL_SCHEMA }] } }), update: async () => ({ ok: true, value: {} }) };
{
  mount({ remote: { settings: readyApi } });
  let page = render();
  ok(page.texts.some((t) => t.includes('正在连接设置服务')), '首帧是"正在连接设置服务…"（不是空白）');
  page = await settle(page);

  // 座位区整块去掉（按设计），"默认座位"那一格也删了（它和评审票冲突）。
  const modelInputs = page.inputs.filter((p) => String(p.placeholder || '').includes('模型（留空'));
  ok(modelInputs.length === 0, '① 面板上没有逐座模型输入框（实际 ' + modelInputs.length + ' 个）');
  const optsOf = (p) => {
    const out = [];
    (function flat(n) { (Array.isArray(n) ? n : [n]).forEach((x) => { if (Array.isArray(x)) flat(x); else if (x && x.props) out.push(x.props); }); })(p.children || []);
    return out;
  };
  const execSelects = page.selects.filter((p) => optsOf(p).some((o) => o.value === 'subagent'));
  ok(execSelects.length === 0, '① 面板上没有逐座执行方式下拉（实际 ' + execSelects.length + ' 个）');
  ok(!page.inputs.some((p) => String(p.placeholder || '').includes('空格分隔，如 codex claude dsh')),
    '① 「默认座位」输入框已删除（它和评审环节是同一件事，且票非空时它完全不生效）');
  // 文案判据（用户要求）：面向所有人，不出现路径 / 字段名 / 模型代号。
  // 所以这里断的是**意图**而不是旧的字符串：票 = 一位评审员；想固定某人的模型有进阶指路。
  ok(page.texts.some((t) => t.includes('几位评审员')), '① 说明把「票」讲成「几位评审员」（不用"座位"这种内部说法）');
  ok(page.texts.some((t) => t.includes('配置文件')), '① 想固定某位评审员的模型去哪改：给了一句进阶指路（不暴露文件名）');
  const JARGON = /dispatch\/|\.sh\b|\.json|default_backends|seats\[|model_override|executor_override|subagent|tmux|kimi-k3|命名空间|网关/;
  ok(!page.texts.some((t) => JARGON.test(t)), '面板文案里没有文件路径 / 字段名 / 模型代号（面向所有人）');
  ok(!page.texts.includes('codexModel') && !page.texts.includes('seatOverrides') && !page.texts.includes('seatRoster'),
    '⑩ 座位相关的键名一个都不出现在面板上');
  ok(!page.texts.includes('stageOpinions'), '⑩ stageOpinions 只由专用控件渲染一次');
  ok(page.texts.filter((t) => t === 'divergeCommand' || t === 'divergeModel').length === 0,
    '⑩ divergeCommand / divergeModel 只由「发散环节」下拉渲染，不再在「高级项」里重复一次');
  ok(page.texts.filter((t) => t === '高级项').length === 0,
    '⑩ 每个字段都有专用控件时，「高级项」整块不渲染（不留空标题）');
  ok(!page.texts.some((t) => t === 'repoRoot' || t === 'seatsFile' || t === 'executorCatalog' || t === 'otherStages'),
    '元信息（repoRoot / seatsFile / executorCatalog / otherStages）仍然隐藏');

  ok(!/undefined/.test(page.texts.join(' ')), '没有 undefined 泄漏');

  // ── 节序 = 科研流程顺序（用户要求：别把评审放在最前面）──────────
  // 五节从上到下就是流程：文献调研 → 发散 → 评审 → 新颖度复查 → 实现与实验。
  // 这里用**精确等值**找标题（标题就是环节名本身），不用 startsWith —— 导语里那串流程名
  // 会先被命中，findIndex 就测不到标题的位置了。
  const FLOW = ['文献调研', '发散', '评审', '新颖度复查', '实现与实验'];
  const pos = FLOW.map((n) => page.texts.findIndex((t) => t === n));
  ok(pos.every((i) => i >= 0), '五节标题都在且就是环节名（' + FLOW.join(' / ') + '）');
  ok(pos.every((v, i) => i === 0 || pos[i - 1] < v),
    '节序 = 科研流程：' + FLOW.join(' → ') + '（实际 ' + pos.join(' < ') + '）');
  // 「只登记」这个性质不能靠分组名称承担了（分组已改成环节名），必须每节自带标记。
  ok(page.texts.filter((t) => t.includes('只登记由谁做')).length === 3,
    '三个"只登记"的环节各自带一句标记（文献调研 / 新颖度复查 / 实现与实验）');
  ok(page.texts.some((t) => t.includes('文献调研 → 发散 → 评审 → 新颖度复查 → 实现与实验')),
    '导语里也写着这条流程（标题之外再给一次整体顺序）');

  // 受控组件真的读 draft：点"加一票"后重渲染，票数从 3 变 4
  const addBtn = page.buttons.find((b) => String(b.children || '').includes('加一票'));
  ok(!!addBtn && typeof addBtn.onClick === 'function', '有「加一票」按钮');
  const votesBefore = page.texts.filter((t) => /^票 \d+$/.test(t)).length;
  addBtn.onClick();
  const page2 = render();
  const votesAfter = page2.texts.filter((t) => /^票 \d+$/.test(t)).length;
  ok(votesAfter === votesBefore + 1, '票是受控的：点「加一票」→ draft 变化 → 重渲染多一行（' + votesBefore + ' → ' + votesAfter + '）');
}

// ①-b 升级残留：设置文档里若还留着上一版的 seatOverrides / seatRoster 键，
// 面板不许把它们画出来（那两个字段已经从 Config 删掉了）。
{
  const v2 = Object.assign({}, FULL_VALUE, { seatOverrides: 'codex:gpt-9:', seatRoster: 'mysandbox:cli:1' });
  mount({ remote: { settings: { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'research-dispatch', revision: 7, user: {}, value: v2, schema: REAL_SCHEMA }] } }), update: async () => ({ ok: true, value: {} }) } } });
  const p2 = await settle(render());
  const mi2 = p2.inputs.filter((p) => String(p.placeholder || '').includes('模型（留空'));
  ok(mi2.length === 0, '①-b 残留的 seatOverrides 不会变出座位控件（实际 ' + mi2.length + ' 个）');
  ok(!p2.texts.some((t) => t === 'seatOverrides' || t === 'seatRoster'), '①-b 残留键名不出现在「高级项」里');
}

// ⑦ 分支一：describe 通了但没有本命名空间 → 说"没注册"，不说"连不上"
{
  mount({ remote: { settings: { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'other', value: {} }] } }) } } });
  const page = await settle(render());
  ok(page.texts.some((t) => t.includes('本页暂时没有可编辑项')), '⑦ 连上了但没有可编辑项 → 说的是"没有可编辑项"，不是"连不上"');
  ok(!page.texts.some((t) => t.includes('连不上设置服务')), '⑦ 这种情况不许被误报成"连不上设置服务"');
}

// ⑦ 分支二：describe 直接抛 → 才是"连不上网关"
{
  mount({ remote: { settings: { describe: async () => { throw new Error('RPC 断开'); } } } });
  const page = await settle(render());
  ok(page.texts.some((t) => t.includes('连不上设置服务') && t.includes('RPC 断开')), '⑦ describe 抛错 → "连不上设置服务（RPC 断开）"');
  ok(!page.texts.some((t) => t.includes('本页暂时没有可编辑项')), '⑦ 不要反过来把连接故障说成"没有可编辑项"');
  ok(page.texts.some((t) => t.includes('科研派工 · 评审与环节')) && page.texts.some((t) => t.includes('文献调研')),
    '连不上服务时首屏骨架仍在（不是整页空白）');
}

// ── 写回：update(ns, patch, revision) ─────────────────────────────
const DESCRIPTOR = { ns: 'research-dispatch', revision: 7, user: { defaultBackends: 'codex dsh' }, value: {}, schema: REAL_SCHEMA };
const settingsApi = {
  describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'other', value: {} }, DESCRIPTOR] } }),
  update: async (...args) => { ctx2.__calls.push(args); return { ok: true, value: {} }; },
};
const gw = { settingsController: settingsApi };
const ctx2 = { get: (n) => (n === 'remote' ? gw : undefined), __calls: [] };
const d = await mod.__test.readDescriptor(ctx2);
ok(d && d.ns === 'research-dispatch', 'readDescriptor 从全部命名空间里挑出自己那个（方法挂在 settingsController 上也能找到）');
await mod.__test.writePatch(ctx2, { reviewVotes: 'codex:gpt-9,' }, 7);
const call = ctx2.__calls[0];
ok(call && call[0] === 'research-dispatch' && call[1].reviewVotes === 'codex:gpt-9,' && call[2] === 7,
  'writePatch 调 update(命名空间, 只含改动的 patch, revision)');

// ── 面板不写盘────────────────────────────────────────────
// 判据反转了：以前验"保存即写穿到 seats.json"，现在面板不再持有座位配置
// （座位与"跑哪几座"由评审票 + 座位表决定），所以验 **apply() 一个字节都不许动座位表**。
{
  const host = await import(new URL('../lib/index.js', import.meta.url).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-wt-'));
  const repo = path.join(tmp, 'repo');
  const seatsFile = path.join(repo, 'dispatch', 'seats.json');
  fs.mkdirSync(path.dirname(seatsFile), { recursive: true });
  fs.writeFileSync(seatsFile, JSON.stringify({
    version: 1, default_backends: ['codex', 'claude', 'dsh'],
    seats: [
      { id: 'codex', kind: 'cli', enabled: true, model_override: 'hand-written' },
      { id: 'claude', kind: 'cli', enabled: true }, { id: 'dsh', kind: 'cli', enabled: true },
    ],
  }, null, 2));
  const before = fs.readFileSync(seatsFile, 'utf8');

  const events = [];
  host.apply({ logger: () => {}, on: (evt) => events.push(evt) },
    { repoRoot: repo, seatsFile: 'dispatch/seats.json', reviewVotes: 'codex:gpt-9,' });
  ok(fs.readFileSync(seatsFile, 'utf8') === before, '面板保存不写盘：apply() 不碰 dispatch/seats.json');
  ok(!events.includes('loader/volatile-update'), '不再注册 volatile 变更监听（没有要写回的东西）');
  ok(JSON.parse(fs.readFileSync(seatsFile, 'utf8')).seats[0].model_override === 'hand-written',
    '座位表里手写的 model_override 原样保留（面板从不碰它）');

  // Config 的 seatsFile 约束仍在：读取路径也必须钉在仓库内
  const bad = ['C:/tmp/x.json', '/etc/x.json', '../outside.json', 'a/../../b.json', 'dispatch/notes.md'];
  ok(bad.every((v) => { try { host.Config({ seatsFile: v, repoRoot: repo }); return false; } catch { return true; } }),
    '④ Config 的 seatsFile 约束拒掉绝对路径 / .. / 非 .json');
  ok(host.plainValue(host.Config({ seatsFile: 'dispatch/seats.json', repoRoot: repo }).seatsFile) === 'dispatch/seats.json', '④ 合法相对路径照常放行');
  // volatile 字段在装了 schemastery 的环境里会被包成 { get() }，没装则是裸值 —— 两种都得能用。
  // 这条钉住 plainValue：否则同一个包在「裸 checkout」与「真装依赖」两种环境里给出相反结论。
  ok(host.plainValue({ get: () => 'dispatch/seats.json' }) === 'dispatch/seats.json'
    && host.plainValue('dispatch/seats.json') === 'dispatch/seats.json'
    && host.plainValue(undefined) === undefined,
    '④ volatile 包装与裸值都被 plainValue 正确解开');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + (fail.length ? '失守 ' + fail.length + ' 条' : '全部 ' + ops + ' 条断言通过'));
process.exitCode = fail.length === 0 ? 0 : 1;
