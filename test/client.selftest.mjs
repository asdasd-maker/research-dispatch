// 设置页与宿主层离线自检（v2.3.0）：无浏览器、无真 React、无网络。
//   node plugin/research-dispatch/test/client.selftest.mjs
//
// 覆盖契约：
//   · schema 用真实形状 —— schemastery 的 toJSON() 是 { uid, refs }，覆盖全部 15 个字段；
//   · 五大分区按科研闭环顺序排布：工作流项目 → 文献调研 → 想法发散 → 多票评审 → 前置查重；
//   · 五合一真实 CLI 列表（codex / claude / dsh / agy / kimi，移除 api 与幻影 subagent，兼容旧 gemini/api 配置切走）；
//   · ModelPicker 彻底根治空模型死锁：常驻顶部搜索/自定义输入框、首项常驻恢复默认、0 模型可手输自定义回车选用；
//   · 宿主 apply() + loader/volatile-update 自动写穿同步 lineup 至 dispatch/seats.json，且绝不触碰手写 model_override。
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 清理可能干扰路径解析的环境变量，并锁定离线无联网单测模式
delete process.env.DSH_DISPATCH_ROOT;
delete process.env.DSH_DISPATCH_CONFIG;
delete process.env.DSH_DISPATCH_SETTINGS;
process.env.AGY_SKIP_LIVE_MODELS = '1';

// ── 极简 React：useState 有真状态，useEffect 手动 flush，3 秒超时短路 ────
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
ok(viaGet && viaGet.ns === 'research-dispatch', 'ctx.get("remote") 兜底路径可读到描述');

{
  const api = { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'research-dispatch', value: { a: 1 } }] } }) };
  const viaSub = await mod.__test.readDescriptor({ get: (n) => (n === 'remote.settings' ? api : undefined) });
  ok(viaSub && viaSub.ns === 'research-dispatch', 'ctx.get("remote.settings") 子服务路径可用（首选）');
}
{
  const pkgJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const deps = (pkgJson.dsh && pkgJson.dsh.client && pkgJson.dsh.client.inject) || [];
  ok(deps.includes('@deepseek-ai/dsh-client-ui-settings')
    && deps.includes('@deepseek-ai/dsh-client-connection')
    && deps.includes('@deepseek-ai/dsh-api-remotes'),
    'v2.2.1：包级 dsh.client.inject 同时声明 settings / connection / api-remotes 客户端依赖');
  ok(pkgJson.dsh.client.platform === 'web', '包级平台声明为 web');
}

// ── 回归：cordis 对未声明服务的读取抛异常时不打断注册 ───────────────────
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
  ok(!threw, 'ctx.remote 抛异常时 apply 不往外抛');
  ok(!!reg2 && reg2.slot === 'settings.section', 'ctx.remote 抛异常也不影响设置页注册');
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

{
  const api = { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'research-dispatch', value: { a: 2 } }] } }) };
  const direct = await mod.__test.readDescriptor({ remote: { settings: api }, get: () => undefined });
  ok(direct && direct.ns === 'research-dispatch', '已声明时 ctx.remote.settings 直接可用');
}

// ── 模型清单与五合一执行者座位（移除 api，换入 agy 与 kimi）──────────────
{
  const cat = mod.__test.catalogOf({ executorCatalog: 'codex:gpt-5|o3;claude:claude-sonnet-4-5;dsh:;agy:gemini-4-carbon-high;kimi:kimi-k2-thinking' });
  ok(cat.length === 5 && cat[0].exec === 'codex' && cat[3].exec === 'agy' && cat[4].exec === 'kimi',
    'catalogOf 解析五类 CLI 探测串（含 agy）');

  const stMap = mod.__test.statusOf({ executorStatus: 'codex:1;claude:1;dsh:1;agy:0;kimi:1' });
  ok(stMap.codex === true && stMap.agy === false && stMap.kimi === true,
    'statusOf 解析 executorStatus 安装标记（1→true, 0→false）');

  mod.__test.resetModelDirs();
  const snap = { providers: [{ id: 'codex', models: [{ id: 'gpt-5' }, { id: 'gpt-9-runtime' }] }, { id: 'kimi', models: [{ id: 'kimi-latest' }] }] };
  const dirs = mod.__test.readModelDirectories({ get: (n) => (n === 'modelDirectories' ? { getSnapshot: () => snap } : undefined) });
  ok(dirs.codex && dirs.codex.includes('gpt-9-runtime'), 'readModelDirectories 读出运行时模型');
  const merged = mod.__test.mergeCatalog(cat, dirs);
  const codexRow = merged.find((c) => c.exec === 'codex');
  const kimiRow = merged.find((c) => c.exec === 'kimi');
  ok(codexRow.models.filter((m) => m === 'gpt-5').length === 1, '合并时同名去重');
  ok(codexRow.models.includes('gpt-9-runtime') && kimiRow.models.includes('kimi-latest'), '运行时模型并进对应执行者行');

  mod.__test.resetModelDirs();
  const none = mod.__test.readModelDirectories({ get: () => { throw new Error('no such service'); } });
  ok(JSON.stringify(none) === '{}', 'modelDirectories 抛错时返回空表');
  ok(!!(globalThis.window.__researchDispatch || {}).modelDirsError, '异常记入诊断');
  mod.__test.resetModelDirs();
}

// ── dsh 目录覆盖 & STAGE_SEATS 五合一无 api / subagent ────────────────
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
  ok(ids.length === 5, 'groups 平铺成 5 个 provider/model id');
  ok(ids.includes('qoder/auto') && ids.includes('magpie/auto/deepseek-v4.1-flash')
    && ids.includes('magpie-anthropic/zcode/GLM-5.3-Flash') && ids.includes('cline-pass/qwen3.8-max'),
    '四组供应商都在（含多层斜杠路由模型）');

  const staticValue = { executorCatalog: 'codex:gpt-5;claude:opus;dsh:cline-pass/old-a;subagent:cline-pass/old-a;api:deepseek-chat;kimi:kimi-k2' };
  const noCtx = { get: () => undefined };

  const fallback = mod.__test.panelCatalog(staticValue, noCtx).find((c) => c.exec === 'dsh');
  ok(fallback && fallback.models.includes('cline-pass/old-a'), '拿不到宿主目录时退回静态探测');

  mod.__test.setLiveGroups(groups);
  const patched = mod.__test.panelCatalog(staticValue, noCtx);
  const dsh = patched.find((c) => c.exec === 'dsh');
  const sub = patched.find((c) => c.exec === 'subagent');
  const apiEntry = patched.find((c) => c.exec === 'api');
  const expectedSeats = ['codex', 'claude', 'dsh', 'agy', 'kimi'];
  ok(dsh && dsh.models.length === 5 && !dsh.models.includes('cline-pass/old-a'),
    'dsh 行以宿主目录为准');
  ok(!sub && !apiEntry
    && JSON.stringify(mod.__test.STAGE_SEATS) === JSON.stringify(expectedSeats)
    && JSON.stringify(mod.__test.REVIEW_SEATS) === JSON.stringify(expectedSeats)
    && JSON.stringify(mod.__test.DIVERGE_SEATS) === JSON.stringify(expectedSeats),
    '五合一清晰 Agent 列表：STAGE_SEATS / REVIEW_SEATS / DIVERGE_SEATS 均为 [codex,claude,dsh,agy,kimi]，剔除 api 与 subagent');
  ok(patched.find((c) => c.exec === 'codex').models.includes('gpt-5')
    && patched.find((c) => c.exec === 'kimi').models.includes('kimi-k2'),
    'codex / kimi 外部 CLI 座位不受 dsh 覆盖影响');

  mod.__test.resetLiveCatalog();
  ok(mod.__test.panelCatalog(staticValue, noCtx).find((c) => c.exec === 'dsh').models.includes('cline-pass/old-a'),
    '复位后回到静态探测');
}

// ── ModelPicker（v2.1.0）：常驻输入框 + 常驻恢复默认项 + 0 模型手输自定义不死锁 ──
{
  mod.__test.resetModelDirs();
  mod.__test.resetLiveCatalog();
  const groups = [
    { id: 'cline-pass', name: 'Cline Pass', models: [{ id: 'qwen3.8-max', name: 'Qwen 3.8 Max' }] },
    { id: 'qoder', name: 'Qoder (订阅)', models: [{ id: 'auto', name: 'Auto' }, { id: 'deepseek-v4-pro', name: 'deepseek V4-Pro' }] },
  ];
  const cat = [{ exec: 'dsh', models: [] }, { exec: 'codex', models: ['gpt-5'] }];
  const flat = mod.__test.groupedModels('dsh', cat);
  ok(flat.length === 1 && flat[0].label === '' && flat[0].items.length === 0,
    '没拿到宿主目录时 dsh 预设组为空');

  mod.__test.setLiveGroups(groups);
  const grouped = mod.__test.groupedModels('dsh', cat);
  ok(grouped.length === 2 && grouped[0].label === 'Cline Pass' && grouped[1].label === 'Qoder (订阅)',
    '按供应商分组展示');

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

  const picked = [];
  const st = { menu: { key: null, hi: 0, q: '' }, setMenu(v) { st.menu = v; } };
  const pick = (state, value, grp = grouped) => mod.__test.ModelPicker(Object.assign(
    { value, groups: grp, disabled: false, placeholder: '默认' },
    mod.__test.menuProps(state, 'k1', grp, value, (v) => picked.push(v)),
  ));

  // 关闭态
  const closedTree = pick(st, 'qoder/auto');
  ok(closedTree.type === 'div' && closedTree.props.className === 'rdp-pick', '外层 .rdp-pick 锚点');
  const btn = kids(closedTree)[0];
  ok(btn.type === 'button' && /rdp-pick-btn/.test(btn.props.className), '关闭态是按钮');
  ok(txt(btn).includes('Auto') && !txt(btn).includes('qoder/auto'), '按钮显示模型友好名 Auto');
  ok(byClass(closedTree, /rdp-menu-search/).length === 0, '关闭态不渲染弹层与输入框');

  // 打开态（仅 3 个预设模型 ≤4）：依然常驻渲染顶部搜索兼自定义输入框 + 首项常驻「默认（使用该工具自身默认模型）」！
  st.menu = { key: 'k1', hi: 2, q: '' };
  const openTree = pick(st, 'qoder/auto');
  const searchInSmall = byClass(openTree, /rdp-menu-search/);
  ok(searchInSmall.length === 1 && String(searchInSmall[0].props.placeholder || '').includes('输入新模型名回车'),
    '候选数 ≤4（3 个）时打开弹层也始终渲染顶部搜索/自定义输入框');
  ok(capsOf(openTree).join('|') === 'Cline Pass|Qoder (订阅)', '供应商分组胶囊标题正常渲染');
  const openRows = rowsOf(openTree);
  ok(openRows.length === 4 && txt(openRows[0]).includes('默认模型'),
    '未输入过滤词时首项常驻「默认模型」（1 默认 + 3 预设 = 4 行）');
  const selRow = openRows.find((x) => x.props['aria-selected'] === 'true');
  ok(!!selRow && txt(byClass(selRow, /rdp-menu-name/)[0]) === 'Auto' && byClass(selRow, /rdp-menu-tick/).length === 1, '当前选中模型行带矢量勾选标记');

  // 点击首项常驻默认行 → 一键切回 ""（恢复该工具自身默认模型）
  openRows[0].props.onClick();
  ok(picked[0] === '' && st.menu.key === null, '点击首项常驻默认行可随时从具体模型一键恢复默认（""）');

  // 键盘导航：关闭态按 ArrowDown 打开并移至当前值（index 2: qoder/auto）下一项（index 3: qoder/deepseek-v4-pro）
  st.menu = { key: null, hi: 0, q: '' };
  kids(closedTree)[0].props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  ok(st.menu.key === 'k1' && st.menu.hi === 3, '关闭态按 ↓ 打开并把高亮移到当前值下一行（index 3）');
  const open2 = pick(st, 'qoder/auto');
  kids(open2)[0].props.onKeyDown({ key: 'Enter', preventDefault() {} });
  ok(picked[1] === 'qoder/deepseek-v4-pro' && st.menu.key === null, 'Enter 选中高亮行并收起');

  // ── 0 模型空目录场景：彻底根治「没有匹配的模型」死锁 ──────────────────
  const emptyGroups = [{ label: '', items: [] }];
  const pickedCustom = [];
  const stZero = { menu: { key: 'zero', hi: 0, q: '' }, setMenu(v) { stZero.menu = v; } };
  const renderZero = (val = '') => mod.__test.ModelPicker(Object.assign(
    { value: val, groups: emptyGroups, disabled: false, placeholder: '默认' },
    mod.__test.menuProps(stZero, 'zero', emptyGroups, val, (v) => pickedCustom.push(v)),
  ));

  const zeroOpen = renderZero('');
  const zeroInput = byClass(zeroOpen, /rdp-menu-search/)[0];
  ok(!!zeroInput, '0 个已探测模型时打开弹层也始终渲染顶部输入框（绝不锁死）');
  ok(rowsOf(zeroOpen).length === 1 && txt(rowsOf(zeroOpen)[0]).includes('默认模型'),
    '0 个已探测模型时仍提供常驻默认项');

  // 用户在 0 模型弹层输入自定义模型名并按回车
  zeroInput.props.onChange({ target: { value: '  claude-opus-4-1-custom  ' } });
  const zeroTyped = renderZero('');
  const zeroRowsAfter = rowsOf(zeroTyped);
  ok(zeroRowsAfter.length === 1 && txt(zeroRowsAfter[0]).includes('使用自定义模型：claude-opus-4-1-custom'),
    '输入任意非空新模型名时出现「使用自定义模型：<q.trim()>」选项');
  byClass(zeroTyped, /rdp-menu-search/)[0].props.onKeyDown({ key: 'Enter', preventDefault() {} });
  ok(pickedCustom[0] === 'claude-opus-4-1-custom' && stZero.menu.key === null,
    '0 模型下直接输入自定义模型名按 Enter 即刻写入并收起弹层');

  // 当输入与现有候选 value 完全重名时，不重复生成「使用自定义模型」行
  const stExact = { menu: { key: 'k1', hi: 0, q: 'qoder/auto' }, setMenu(v) { stExact.menu = v; } };
  const exactTree = mod.__test.ModelPicker(Object.assign(
    { value: '', groups: grouped, disabled: false, placeholder: '默认' },
    mod.__test.menuProps(stExact, 'k1', grouped, '', () => {}),
  ));
  ok(!rowsOf(exactTree).some((r) => txt(r).includes('使用自定义模型：')),
    '输入与现有候选 value 完全重名时不重复追加自定义行');

  // 不在目录里的已存自定义值在关闭态按钮上原样显示
  const goneTree = pick({ menu: { key: null, hi: 0, q: '' }, setMenu() {} }, 'my-saved-custom-model');
  ok(txt(kids(goneTree)[0]).includes('my-saved-custom-model'), '已保存的自定义模型在关闭态照原样显示');

  mod.__test.resetLiveCatalog();
}

// ── 可选光纤：拿宿主目录走 ctx.inject，不进静态 inject ─────────────────
{
  mod.__test.resetModelDirs();
  mod.__test.resetLiveCatalog();
  const deps = [];
  const api = { modelCatalog: async () => ({ ok: true, value: { groups: [{ id: 'magpie', name: 'Magpie', models: [{ id: 'auto/x', name: 'X' }] }] } }) };
  const ctx2 = {
    slots: { inject: (n, fn) => fn(), register: (d, c) => ({ def: d, comp: c }) },
    get: () => undefined,
    inject: (list, fn) => { deps.push(list.join(',')); fn({ 'remote.session': api, get: () => undefined }); },
    effect: () => {},
  };
  let threw = false;
  try { mod.apply(ctx2); } catch { threw = true; }
  ok(!threw, 'ctx.inject 存在时 apply 不抛');
  ok(deps.includes('remote.session'), '用可选光纤取 remote.session');
  await tick();
  const dsh = mod.__test.panelCatalog({ executorCatalog: 'dsh:' }, { get: () => undefined }).find((c) => c.exec === 'dsh');
  ok(!!dsh && dsh.models.includes('magpie/auto/x'), '光纤里拿到的目录进了面板清单');
  mod.__test.resetLiveCatalog();
  mod.__test.resetModelDirs();
}

// ── 两种"拿不到"必须可区分 ──────────────────────────────────────────
{
  const noGw = await mod.__test.readDescriptor({}).catch(() => 'THREW');
  ok(noGw === null, '没有设置服务时 readDescriptor 返回 null');
  const apiNoNs = { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'other', value: {} }] } }) };
  let err = null;
  try { await mod.__test.readDescriptor({ remote: { settings: apiNoNs }, get: () => undefined }); } catch (e) { err = e; }
  ok(!!err && err.code === 'NS_MISSING', 'describe 通了但无本命名空间 → 抛 NS_MISSING');
  let threw = false;
  try { await mod.__test.writePatch({}, {}); } catch (e) { threw = /设置服务/.test(String(e.message)); }
  ok(threw, '连不上设置服务时 writePatch 显式报错');
}

// ── schema 的真实形状（18 字段完整覆盖）────────────────────────────────
const REAL_SCHEMA = {
  uid: 90,
  refs: {
    '3': { type: 'string', meta: { description: '科研项目文件夹路径', default: '/repo', volatile: true } },
    '7': { type: 'string', meta: { description: '座位表相对路径', default: 'dispatch/seats.json', volatile: true } },
    '11': { type: 'string', meta: { description: '文献调研环节执行工具', default: '', volatile: true } },
    '13': { type: 'string', meta: { description: '文献调研环节模型名', default: '', volatile: true } },
    '14': { type: 'string', meta: { description: '文献调研思考强度', default: '', volatile: true } },
    '17': { type: 'string', meta: { description: '想法发散环节执行工具', default: '', volatile: true } },
    '21': { type: 'string', meta: { description: '想法发散环节模型名', default: '', volatile: true } },
    '22': { type: 'string', meta: { description: '想法发散思考强度', default: '', volatile: true } },
    '25': { type: 'string', meta: { description: '想法发散单轮默认产出条数', default: '', volatile: true } },
    '29': { type: 'string', meta: { description: '想法发散历史死胡同过滤', default: '', volatile: true } },
    '33': { type: 'string', meta: { description: '评审票（可自由增删）', default: '', volatile: true } },
    '37': { type: 'string', meta: { description: '前置查重环节执行工具', default: '', volatile: true } },
    '41': { type: 'string', meta: { description: '前置查重环节模型名', default: '', volatile: true } },
    '42': { type: 'string', meta: { description: '前置查重思考强度', default: '', volatile: true } },
    '45': { type: 'string', meta: { description: '只读：工具与候选模型目录', default: '', volatile: true } },
    '49': { type: 'string', meta: { description: '只读：工具安装状态', default: '', volatile: true } },
    '53': { type: 'string', meta: { description: '历史兼容字段', default: '', volatile: true } },
    '57': { type: 'string', meta: { description: '历史兼容字段', default: '', volatile: true } },
    '90': {
      type: 'object', meta: { default: {} },
      dict: {
        repoRoot: 3, seatsFile: 7,
        scoutCommand: 11, scoutModel: 13, scoutEffort: 14,
        divergeCommand: 17, divergeModel: 21, divergeEffort: 22, divergeCount: 25, divergeUseDeadEnds: 29,
        reviewVotes: 33,
        noveltyCommand: 37, noveltyModel: 41, noveltyEffort: 42,
        executorCatalog: 45, executorStatus: 49,
        otherStages: 53, stageOpinions: 57,
      },
    },
  },
};
const ALL_KEYS = [
  'repoRoot', 'seatsFile',
  'scoutCommand', 'scoutModel', 'scoutEffort',
  'divergeCommand', 'divergeModel', 'divergeEffort', 'divergeCount', 'divergeUseDeadEnds',
  'reviewVotes',
  'noveltyCommand', 'noveltyModel', 'noveltyEffort',
  'executorCatalog', 'executorStatus',
  'otherStages', 'stageOpinions',
];

{
  const props = mod.__test.propsFromSchema(REAL_SCHEMA);
  ok(!!props && !('properties' in REAL_SCHEMA), 'fixture 为真实 { uid, refs } 形状');
  const desc = { ns: 'research-dispatch', revision: 7, user: {}, value: {}, schema: REAL_SCHEMA };
  const fields = mod.__test.fieldsOf(desc);
  ok(fields.length === 18 && fields.map((f) => f.key).join(',') === ALL_KEYS.join(','),
    '真实形状下 18 个字段完整列出且顺序一致（实际 ' + fields.length + ' 个）');
  ok(/schema\.refs/.test(globalThis.window.__researchDispatch.fieldSource || ''), '字段来自 schema.refs');
}

{
  const noSchema = { ns: 'research-dispatch', value: { reviewVotes: 'codex:gpt-5' } };
  const f2 = mod.__test.fieldsOf(noSchema);
  ok(f2.length === 18, 'schema 缺失时合并完整 18 个已知字段（实际 ' + f2.length + ' 个）');
  ok(f2.some((f) => f.key === 'scoutCommand' && f.title === '文献调研工具')
    && f2.some((f) => f.key === 'noveltyCommand' && f.title === '前置查重工具'),
    '兜底字段保留四阶段可读标题');
}

// ── 页面级完整交互渲染：五大分区顺序、无 api、发散条数/死胡同开关、兼容旧 api ──
function mount(view) {
  hookState.length = 0;
  registered = null;
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
  for (const fn of page.effects) { try { fn(); } catch { /* 忽略 */ } }
  await tick(); await tick();
  return render();
}
const optsOf = (p) => {
  const out = [];
  (function flat(n) { (Array.isArray(n) ? n : [n]).forEach((x) => { if (Array.isArray(x)) flat(x); else if (x && x.props) out.push(x.props); }); })(p.children || []);
  return out;
};

const FULL_VALUE = {
  repoRoot: '/workspace/demo-project',
  seatsFile: 'dispatch/seats.json',
  scoutCommand: '',
  scoutModel: '',
  scoutEffort: '',
  divergeCommand: '',
  divergeModel: '',
  divergeEffort: '',
  divergeCount: '',
  divergeUseDeadEnds: '',
  reviewVotes: '',
  noveltyCommand: '',
  noveltyModel: '',
  noveltyEffort: '',
  executorCatalog: 'codex:gpt-5|o3;claude:claude-sonnet-4-5;dsh:qoder/deepseek-v4-pro;agy:gemini-4-carbon-medium|gemini-4-carbon-high;kimi:kimi-k2-thinking',
  executorStatus: 'codex:1;claude:1;dsh:1;agy:0;kimi:1',
  otherStages: '',
  stageOpinions: '',
};

let savedPatches = [];
const readyApi = {
  describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'research-dispatch', revision: 7, user: {}, value: FULL_VALUE, schema: REAL_SCHEMA }] } }),
  update: async (_ns, patch) => { savedPatches.push(patch); return { ok: true, value: {} }; },
};

{
  mount({ remote: { settings: readyApi } });
  let page = render();
  ok(page.texts.some((t) => t.includes('正在连接设置服务')), '首帧为连接提示（非空白）');
  page = await settle(page);

  // 五大分区按科研闭环清晰排列
  const SECTIONS = ['工作流项目', '文献调研', '想法发散', '多票评审', '前置查重'];
  const pos = SECTIONS.map((n) => page.texts.findIndex((t) => t === n));
  ok(pos.every((i) => i >= 0), '五大分区标题齐全（' + SECTIONS.join(' → ') + '）');
  ok(pos[0] < pos[1] && pos[1] < pos[2] && pos[2] < pos[3] && pos[3] < pos[4],
    '五大分区严格按科研闭环排序（索引 ' + pos.join(' < ') + '）');

  // JARGON 与内部键名零泄露
  const JARGON = /dispatch\/|\.sh\b|\.json|default_backends|seats\[|model_override|executor_override|subagent|tmux|kimi-k3|命名空间|网关/;
  ok(!page.texts.some((t) => JARGON.test(t)), '面板白话文案零内部文件名 / 字段名 / JARGON 泄露');
  ok(!page.texts.some((t) => ['repoRoot', 'seatsFile', 'scoutCommand', 'scoutEffort', 'divergeCommand', 'divergeEffort', 'divergeCount', 'divergeUseDeadEnds', 'noveltyCommand', 'noveltyEffort', 'executorCatalog', 'executorStatus', 'otherStages', 'stageOpinions'].includes(t)),
    '所有配置内部键名均由专用白话控件接管，不裸露在页面上');
  ok(page.texts.filter((t) => t === '高级项').length === 0, '无未知字段时不渲染「高级项」');
  ok(!/undefined/.test(page.texts.join(' ')), '无 undefined 泄漏');

  // v2.3.0：零原生 <select>，四阶段工具选择全部走定制 ExecPicker（不含 subagent、api 或旧版 gemini）
  ok(page.selects.length === 0, 'v2.3.0：页面彻底零原生 <select> 元素');
  const execBtnsOf = (pg) => pg.buttons.filter((b) => String(b.className || '').includes('rdp-exec-btn'));
  const scoutExecBtn = execBtnsOf(page)[0];
  ok(!!scoutExecBtn, '文献调研渲染定制 ExecPicker 触发按钮');
  scoutExecBtn.onClick();
  page = render();
  const openMenuOpts = page.buttons.filter((b) => b.role === 'option');
  const openValues = openMenuOpts.map((o) => o['data-exec-val']);
  const scoutLabels = openMenuOpts.map((o) => {
    const chunks = [];
    (function walkTxt(x) {
      if (typeof x === 'string' || typeof x === 'number') chunks.push(String(x));
      else if (Array.isArray(x)) x.forEach(walkTxt);
      else if (x && x.props) walkTxt(x.props.children);
    })(o.children);
    return chunks.join('');
  });
  ok(!openValues.includes('subagent') && !openValues.includes('api') && !openValues.includes('gemini'),
    '所有定制下拉框默认均不含 api、subagent 与旧版 gemini');
  ok(scoutLabels.some((l) => l.includes('codex · Codex CLI'))
    && scoutLabels.some((l) => l.includes('kimi · Kimi Code'))
    && scoutLabels.some((l) => l.includes('agy · Antigravity（未检测到命令）')),
    '定制下拉框展示 agy · Antigravity 等友好名称，并对 executorStatus=0 的工具柔和标注「（未检测到命令）」');

  // Escape 关闭定制工具下拉菜单，重新打开并选中 kimi
  execBtnsOf(page)[0].onKeyDown({ key: 'Escape', preventDefault() {} });
  page = render();
  ok(page.buttons.filter((b) => b.role === 'option').length === 0, '按 Escape 收起定制工具下拉菜单');

  // 工作流项目输入框 + 发散单轮默认条数 + 死胡同过滤 Switch 拨杆交互并保存
  const pathInput = page.inputs.find((p) => String(p.className || '').includes('rdp-in-path'));
  const numInput = page.inputs.find((p) => String(p.className || '').includes('rdp-in-num'));
  const deadEndsSwitch = page.buttons.find((b) => b.role === 'switch');
  ok(!!pathInput && pathInput.value === '/workspace/demo-project', '工作流项目展示 repoRoot 输入框');
  ok(!!numInput && numInput.value === '10' && numInput.max === 50,
    '想法发散内联展示单轮默认条数（空串回退展示 10，上限 max=50）');
  ok(!!deadEndsSwitch && deadEndsSwitch['aria-checked'] === 'true',
    '想法发散内联展示历史死胡同过滤无障碍 Switch（空串回退展示开启态 true）');

  pathInput.onChange({ target: { value: '/workspace/new-topic' } });
  numInput.onChange({ target: { value: '45' } });
  deadEndsSwitch.onClick(); // true -> false
  let editedPage = render();

  // 设置文献调研为 kimi
  execBtnsOf(editedPage)[0].onClick();
  editedPage = render();
  editedPage.buttons.find((b) => b.role === 'option' && b['data-exec-val'] === 'kimi').onClick();
  editedPage = render();

  // 同时设置前置查重为 agy
  const noveltyExecBtns = execBtnsOf(editedPage);
  noveltyExecBtns[noveltyExecBtns.length - 1].onClick();
  editedPage = render();
  editedPage.buttons.find((b) => b.role === 'option' && b['data-exec-val'] === 'agy').onClick();
  editedPage = render();

  // 加一票 codex
  const addBtn = editedPage.buttons.find((b) => String([].concat(b.children || []).join('')).includes('加一票'));
  addBtn.onClick();
  editedPage = render();
  const saveBtn = editedPage.buttons.find((b) => String([].concat(b.children || []).join('')) === '保存');
  ok(!!saveBtn && !saveBtn.disabled, '修改任意阶段配置后保存按钮激活');
  savedPatches = [];
  saveBtn.onClick();
  await tick(); await tick();
  ok(savedPatches.length === 1
    && savedPatches[0].repoRoot === '/workspace/new-topic'
    && savedPatches[0].scoutCommand === 'kimi'
    && savedPatches[0].divergeCount === '45'
    && savedPatches[0].divergeUseDeadEnds === 'false'
    && savedPatches[0].noveltyCommand === 'agy'
    && savedPatches[0].reviewVotes === 'codex:',
    '点击保存完整提交五分区改动（支持 agy 座位与 31–50 范围内条数如 45）');

  // 超上限 >50 自动钳制到 50，且在默认空串下显式切换 Switch 回 true 仍可写穿提交
  let pClamp = render();
  const numClamp = pClamp.inputs.find((p) => String(p.className || '').includes('rdp-in-num'));
  let deadSwitchClamp = pClamp.buttons.find((b) => b.role === 'switch');
  // 当前 FULL_VALUE.divergeUseDeadEnds 仍为空串（展示 true），连按两次 true->false->true 使 draft 显式置为 'true'
  deadSwitchClamp.onClick();
  pClamp = render();
  pClamp.buttons.find((b) => b.role === 'switch').onClick();
  numClamp.onChange({ target: { value: '99' } });
  const pClamp2 = render();
  const saveClamp = pClamp2.buttons.find((b) => String([].concat(b.children || []).join('')) === '保存');
  savedPatches = [];
  saveClamp.onClick();
  await tick(); await tick();
  ok(savedPatches.length === 1
    && savedPatches[0].divergeCount === '50'
    && savedPatches[0].divergeUseDeadEnds === 'true',
    '单轮条数超上限 99 钳制为 50，且在 value 为空串时显式选 true 仍可正常提交保存');
}

// ── 历史残留 api / gemini 兼容：仅在当前值为旧项时显示兼容项以便用户切走 ──
{
  const legacyApiVal = Object.assign({}, FULL_VALUE, {
    scoutCommand: 'gemini',
    divergeCommand: 'api',
    reviewVotes: 'api:deepseek-chat,kimi:kimi-k2',
  });
  mount({ remote: { settings: { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'research-dispatch', revision: 8, user: {}, value: legacyApiVal, schema: REAL_SCHEMA }] } }), update: async () => ({ ok: true, value: {} }) } } });
  let pApi = await settle(render());
  const readOpenOpts = () => pApi.buttons.filter((b) => b.role === 'option').map((o) => {
    const chunks = [];
    (function walkTxt(x) {
      if (typeof x === 'string' || typeof x === 'number') chunks.push(String(x));
      else if (Array.isArray(x)) x.forEach(walkTxt);
      else if (x && x.props) walkTxt(x.props.children);
    })(o.children);
    return { value: o['data-exec-val'], label: chunks.join('') };
  });
  pApi.buttons.filter((b) => String(b.className || '').includes('rdp-exec-btn'))[0].onClick();
  pApi = render();
  const scoutOpts = readOpenOpts();
  pApi.buttons.filter((b) => String(b.className || '').includes('rdp-exec-btn'))[1].onClick();
  pApi = render();
  const divergeOpts = readOpenOpts().map((o) => o.value);
  ok(!scoutOpts.some((o) => o.value === 'api') && divergeOpts.includes('api'),
    '历史配置残留 api 时，仅在当前值为 api 的下拉框显示兼容项供切走，其余下拉框绝不出现 api');
  ok(scoutOpts.some((o) => o.value === 'gemini' && o.label.includes('建议切换至 agy'))
    && !divergeOpts.includes('gemini'),
    '历史配置残留 gemini 时，仅在当前值为 gemini 的下拉框提示「建议切换至 agy」，其余下拉框只展示 agy');
}

// ── NS_MISSING 与断连态：断连时五分区骨架保留且控件全部禁用 ─────────────
{
  mount({ remote: { settings: { describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'other', value: {} }] } }) } } });
  const page = await settle(render());
  ok(page.texts.some((t) => t.includes('本页暂时没有可编辑项')) && !page.texts.some((t) => t.includes('连不上设置服务')),
    'NS_MISSING 与连接故障严格区分');
}
{
  mount({ remote: { settings: { describe: async () => { throw new Error('RPC 断开'); } } } });
  const page = await settle(render());
  ok(page.texts.some((t) => t.includes('连不上设置服务') && t.includes('RPC 断开')), 'describe 抛错报连不上设置服务');
  ok(['工作流项目', '文献调研', '想法发散', '多票评审', '前置查重'].every((s) => page.texts.includes(s)),
    '断连态下五大分区骨架完整保留（不整页空白）');
  const addBtn = page.buttons.find((b) => String([].concat(b.children || []).join('')).includes('加一票'));
  const pathIn = page.inputs.find((p) => String(p.className || '').includes('rdp-in-path'));
  ok(!!addBtn && addBtn.disabled === true && !!pathIn && pathIn.disabled === true, '断连态下交互控件全部禁用');
}

// ── 写回：update(ns, patch, revision) ────────────────────────────────
{
  const DESCRIPTOR = { ns: 'research-dispatch', revision: 7, user: {}, value: {}, schema: REAL_SCHEMA };
  const settingsApi = {
    describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'other', value: {} }, DESCRIPTOR] } }),
    update: async (...args) => { ctxW.__calls.push(args); return { ok: true, value: {} }; },
  };
  const ctxW = { get: (n) => (n === 'remote' ? { settingsController: settingsApi } : undefined), __calls: [] };
  const d = await mod.__test.readDescriptor(ctxW);
  ok(d && d.ns === 'research-dispatch', 'readDescriptor 兼容 settingsController');
  await mod.__test.writePatch(ctxW, { reviewVotes: 'codex:gpt-5,kimi:kimi-k2' }, 7);
  const call = ctxW.__calls[0];
  ok(call && call[0] === 'research-dispatch' && call[1].reviewVotes === 'codex:gpt-5,kimi:kimi-k2' && call[2] === 7,
    'writePatch 调 update(ns, patch, revision)');
}

// ── 宿主层 lib/index.js：统一五座探测 + Config 15 字段 + 写穿同步 seats.json ──
{
  const host = await import(new URL('../lib/index.js', import.meta.url).href);
  const registryMod = await import(new URL('../lib/registry.mjs', import.meta.url).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-wt-v21-'));
  const fakeHome = path.join(tmp, 'clean-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const prevDiag = process.env.RESEARCH_DISPATCH_DIAG;
  const prevDshHome = process.env.DSH_HOME;
  delete process.env.RESEARCH_DISPATCH_DIAG;
  process.env.DSH_HOME = path.join(fakeHome, '.dsh');

  const catKeys = host.executorCatalog().split(';').map((s) => s.split(':')[0]);
  const statPairs = host.executorStatus().split(';');
  ok(JSON.stringify(catKeys) === JSON.stringify(['codex', 'claude', 'dsh', 'agy', 'kimi']),
    'host.executorCatalog() 精确覆盖 [codex,claude,dsh,agy,kimi] 五座，不含 api / subagent / 旧 gemini');
  ok(statPairs.length === 5 && statPairs.every((p) => /^(codex|claude|dsh|agy|kimi):(0|1)$/.test(p)),
    'host.executorStatus() 输出五座 0/1 安装标记');

  const repo = path.join(tmp, 'repo');
  const seatsFile = path.join(repo, 'dispatch', 'seats.json');
  fs.mkdirSync(path.dirname(seatsFile), { recursive: true });
  fs.writeFileSync(seatsFile, JSON.stringify({
    version: 2,
    default_backends: ['codex', 'claude', 'dsh'],
    seats: [
      { id: 'codex', kind: 'cli', command: 'codex', argv: ['exec', '{payload}'], enabled: true, model_override: 'hand-written' },
      { id: 'claude', kind: 'cli', command: 'claude', argv: ['-p', '{payload}'], enabled: true },
      { id: 'dsh', kind: 'cli', command: 'dsh', argv: ['run', '{payload}'], enabled: true },
    ],
  }, null, 2) + '\n');

  // 构造 volatile 响应式包装配置，验证挂载即同步 + loader/volatile-update 保存即写穿 lineup
  const liveState = {
    repoRoot: repo,
    seatsFile: 'dispatch/seats.json',
    scoutCommand: 'agy',
    scoutModel: 'gemini-4-carbon-high',
    divergeCommand: 'kimi',
    divergeModel: 'kimi-k2-thinking',
    divergeCount: '12',
    divergeUseDeadEnds: 'false',
    reviewVotes: 'codex:gpt-5,claude:claude-sonnet-4-5',
    noveltyCommand: 'claude',
    noveltyModel: 'claude-sonnet-4-5',
  };
  const volatileCfg = {};
  for (const k of Object.keys(liveState)) {
    volatileCfg[k] = { get: () => liveState[k] };
  }

  const listeners = {};
  let unsubVolatileCalled = false;
  host.apply({
    logger: () => ({ info() {}, error() {} }),
    on: (evt, fn) => {
      listeners[evt] = fn;
      if (evt === 'loader/volatile-update') return () => { unsubVolatileCalled = true; };
      return () => {};
    },
  }, volatileCfg);

  ok(typeof listeners['loader/volatile-update'] === 'function',
    'host.apply() 注册 loader/volatile-update 监听以响应面板保存');
  ok(!fs.existsSync(path.join(fakeHome, '.dsh', 'research-dispatch-diag.log')),
    '默认未设 RESEARCH_DISPATCH_DIAG 时绝不往 ~/.dsh 写诊断日志');

  ok(typeof registryMod.syncPanelLineupToSeats === 'function',
    'registry.mjs 导出 syncPanelLineupToSeats 供宿主写穿调用');
  if (typeof registryMod.syncPanelLineupToSeats === 'function') {
    const afterMount = JSON.parse(fs.readFileSync(seatsFile, 'utf8'));
    ok(afterMount.seats[0].model_override === 'hand-written',
      '写穿同步严守边界：绝不改动 seats[0].model_override 等手写座位属性');
    ok(afterMount.lineup
      && afterMount.lineup.scout && afterMount.lineup.scout.seat === 'agy' && afterMount.lineup.scout.model === 'gemini-4-carbon-high'
      && afterMount.lineup.diverge && afterMount.lineup.diverge.seat === 'kimi'
      && afterMount.lineup.diverge.count === 12 && afterMount.lineup.diverge.use_dead_ends === false
      && Array.isArray(afterMount.lineup.review) && afterMount.lineup.review.length === 2
      && afterMount.lineup.novelty && afterMount.lineup.novelty.seat === 'claude',
      'apply() 初次挂载将四阶段阵容（含 scout=agy, diverge.count=12, use_dead_ends=false）写穿至 seats.json lineup');

    // 模拟用户在 DSH 面板修改配置并点击「保存」触发 loader/volatile-update
    liveState.reviewVotes = 'codex:gpt-5,codex:o3,kimi:kimi-k2-thinking';
    liveState.divergeCount = '8';
    liveState.divergeUseDeadEnds = 'true';
    listeners['loader/volatile-update']();

    const afterSave = JSON.parse(fs.readFileSync(seatsFile, 'utf8'));
    ok(Array.isArray(afterSave.lineup.review) && afterSave.lineup.review.length === 3
      && afterSave.lineup.review[1].seat === 'codex' && afterSave.lineup.review[1].model === 'o3'
      && afterSave.lineup.review[2].seat === 'kimi'
      && afterSave.lineup.diverge.count === 8 && afterSave.lineup.diverge.use_dead_ends === true
      && afterSave.seats[0].model_override === 'hand-written',
      '触发 loader/volatile-update 后即时写穿最新 lineup 至 seats.json 且保留手写 model_override');
  }

  if (typeof listeners.dispose === 'function') listeners.dispose();
  ok(unsubVolatileCalled === true, '插件 dispose 时正确释放 loader/volatile-update 订阅');

  // ── 回归测试（V21-BUG-1）：Config 默认空串不冲毁 CLI 预置 lineup.diverge.{count,use_dead_ends} ──
  {
    const repoBug1 = path.join(tmp, 'repo-bug1');
    const seatsBug1 = path.join(repoBug1, 'dispatch', 'seats.json');
    fs.mkdirSync(path.dirname(seatsBug1), { recursive: true });
    fs.writeFileSync(seatsBug1, JSON.stringify({
      version: 2,
      default_backends: ['codex', 'claude', 'dsh'],
      lineup: {
        diverge: { seat: 'gemini', model: '', count: 8, use_dead_ends: false },
      },
      seats: [
        { id: 'codex', kind: 'cli', command: 'codex', argv: ['exec', '{payload}'], enabled: true },
        { id: 'claude', kind: 'cli', command: 'claude', argv: ['-p', '{payload}'], enabled: true },
        { id: 'gemini', kind: 'cli', command: 'gemini', argv: ['-p', '{payload}'], enabled: true },
      ],
    }, null, 2) + '\n');

    // 1) 直接以 host.Config({ repoRoot }) 默认值挂载 apply()
    const evalCfg = host.Config({ repoRoot: repoBug1 });
    const bug1State = {};
    const bug1Volatile = {};
    for (const k of Object.keys(evalCfg)) {
      bug1State[k] = host.plainValue(evalCfg[k]);
      bug1Volatile[k] = { get: () => bug1State[k] };
    }
    const bug1Listeners = {};
    host.apply({
      logger: () => ({ info() {}, error() {} }),
      on: (evt, fn) => { bug1Listeners[evt] = fn; return () => {}; },
    }, bug1Volatile);

    const afterApplyDefault = JSON.parse(fs.readFileSync(seatsBug1, 'utf8'));
    ok(afterApplyDefault.lineup
      && afterApplyDefault.lineup.diverge
      && afterApplyDefault.lineup.diverge.seat === 'gemini'
      && afterApplyDefault.lineup.diverge.count === 8
      && afterApplyDefault.lineup.diverge.use_dead_ends === false,
      'V21-BUG-1：apply(ctx, Config({ repoRoot })) 绝不冲毁 CLI 预置的 count=8 与 use_dead_ends=false');

    // 2) 仅修改无关项 scoutCommand='claude' 保存时，发散 count=8 / use_dead_ends=false 仍原封不动
    bug1State.scoutCommand = 'claude';
    bug1Listeners['loader/volatile-update']();
    const afterUnrelatedSave = JSON.parse(fs.readFileSync(seatsBug1, 'utf8'));
    ok(afterUnrelatedSave.lineup.scout && afterUnrelatedSave.lineup.scout.seat === 'claude'
      && afterUnrelatedSave.lineup.diverge.count === 8
      && afterUnrelatedSave.lineup.diverge.use_dead_ends === false,
      'V21-BUG-1：面板仅保存无关项 scoutCommand=claude 时，seats.json 的 count=8 与 use_dead_ends=false 保持不变');

    // 3) 面板显式设置 divergeCount='10' 与 divergeUseDeadEnds='true' 时正常写穿覆盖
    bug1State.divergeCount = '10';
    bug1State.divergeUseDeadEnds = 'true';
    bug1Listeners['loader/volatile-update']();
    const afterExplicitSave = JSON.parse(fs.readFileSync(seatsBug1, 'utf8'));
    ok(afterExplicitSave.lineup.diverge.count === 10
      && afterExplicitSave.lineup.diverge.use_dead_ends === true,
      'V21-BUG-1：面板显式设置 divergeCount=10 / divergeUseDeadEnds=true 后正常写穿更新 seats.json');
    if (typeof bug1Listeners.dispose === 'function') bug1Listeners.dispose();
  }

  // Config 路径穿越防护与默认值核验
  const bad = ['C:/tmp/x.json', '/etc/x.json', '../outside.json', 'a/../../b.json', 'dispatch/notes.md'];
  ok(bad.every((v) => { try { host.Config({ seatsFile: v, repoRoot: repo }); return false; } catch { return true; } }),
    'Config 的 seatsFile 约束拒掉绝对路径 / .. / 非 .json');
  const defCfg = host.Config({ repoRoot: repo });
  ok(host.plainValue(defCfg.seatsFile) === 'dispatch/seats.json'
    && host.plainValue(defCfg.divergeCount) === ''
    && host.plainValue(defCfg.divergeUseDeadEnds) === '',
    'Config 默认值（seatsFile=dispatch/seats.json，divergeCount/divergeUseDeadEnds 均为空串跟随 seats.json）齐全');
  ok(host.plainValue({ get: () => 'dispatch/seats.json' }) === 'dispatch/seats.json'
    && host.plainValue('dispatch/seats.json') === 'dispatch/seats.json'
    && host.plainValue(undefined) === undefined,
    'plainValue 兼容 volatile 包装与裸值');

  // ── v2.1.1 回归：schema 默认目录兜底 + 托盘驻留旧后台检测提示 + 实时 /api/research-dispatch/executors 桥 ──
  {
    mod.__test.resetBridgeSnapshot();
    mod.__test.resetLiveCatalog();
    mod.__test.resetModelDirs();

    // 1) 当 desc.value.executorCatalog 为空或残留旧串时，自动合并 desc.schema 的 meta.default 模型目录
    const schemaWithDefaults = JSON.parse(JSON.stringify(REAL_SCHEMA));
    schemaWithDefaults.refs['45'].meta.default = 'codex:gpt-5.4;claude:claude-sonnet-4-5;dsh:;agy:gemini-4-carbon-medium|gemini-4-carbon-high;kimi:kimi-k2-thinking';
    schemaWithDefaults.refs['49'].meta.default = 'codex:1;claude:1;dsh:1;agy:1;kimi:0';
    const schemaProps = mod.__test.propsFromSchema(schemaWithDefaults);
    const catRecovered = mod.__test.panelCatalog({ executorCatalog: 'codex:;claude:;dsh:;gemini:;api:' }, { get: () => undefined }, schemaProps);
    const agyRow = catRecovered.find((c) => c.exec === 'agy');
    const stRecovered = mod.__test.effectiveStatusOf({ executorStatus: '' }, schemaProps);
    ok(!!agyRow && agyRow.models.includes('gemini-4-carbon-medium') && agyRow.models.includes('gemini-4-carbon-high'),
      'v2.1.2：desc.value.executorCatalog 为旧版空值时，自动从 desc.schema.default 恢复 agy 等完整探测模型列表');
    ok(stRecovered.agy === true && stRecovered.kimi === false,
      'v2.1.2：desc.value.executorStatus 为空时，自动从 desc.schema.default 恢复 CLI 安装标记');

    // 2) Windows 托盘驻留分脑（后台仍为 v2.0.0 或 v2.1.1 无 agy schema）时渲染明确托盘退出提示横幅
    const v20Schema = {
      uid: 30,
      refs: {
        '1': { type: 'string', meta: { default: '/repo', volatile: true } },
        '2': { type: 'string', meta: { default: '', volatile: true } },
        '3': { type: 'string', meta: { default: 'codex:;claude:;dsh:;gemini:;api:', volatile: true } },
        '30': {
          type: 'object',
          meta: { default: {} },
          dict: { repoRoot: 1, divergeCommand: 2, reviewVotes: 2, executorCatalog: 3 },
        },
      },
    };
    const v211Schema = JSON.parse(JSON.stringify(REAL_SCHEMA));
    v211Schema.refs['45'].meta.default = 'codex:gpt-5.4;claude:claude-sonnet-4-5;dsh:;gemini:gemini-2.5-pro;kimi:kimi-k2-thinking';
    ok(mod.__test.isBackendOutdated({ ns: 'research-dispatch', schema: v20Schema, value: {} }) === true
      && mod.__test.isBackendOutdated({ ns: 'research-dispatch', schema: v211Schema, value: {} }) === true
      && mod.__test.isBackendOutdated({ ns: 'research-dispatch', schema: schemaWithDefaults, value: {} }) === false
      && mod.__test.isBackendOutdated({ ns: 'research-dispatch', schema: REAL_SCHEMA, value: {} }) === false,
      'v2.1.2：isBackendOutdated 精准识别 v2.0.0 / v2.1.1 驻留旧后台 schema 与 v2.1.2 含 agy 正常后台');

    mount({
      remote: {
        settings: {
          describe: async () => ({
            ok: true,
            value: { namespaces: [{ ns: 'research-dispatch', revision: 1, user: {}, value: { executorCatalog: 'gemini:' }, schema: v20Schema }] },
          }),
        },
      },
    });
    const stalePage = await settle(render());
    ok(stalePage.texts.some((t) => t.includes('系统托盘') && t.includes('退出')),
      'v2.1.1：后台仍驻留旧版时顶部显式提示从右下角系统托盘退出重开');

    // 3) 宿主 /api/research-dispatch/executors 实时桥路由（安全守卫 + POST 探测回传 + 前端合并刷新）
    let registeredRoute = null;
    let routeDisposed = false;
    host.apply({
      logger: () => ({ info() {}, error() {} }),
      inject: (deps, fn) => {
        if (Array.isArray(deps) && deps.includes('webServer')) {
          fn({
            webServer: {
              register: (r) => {
                registeredRoute = r;
                return () => { routeDisposed = true; };
              },
            },
            effect: (eff) => {
              const clean = eff();
              registeredRoute.__dispose = clean;
            },
          });
        }
      },
      on: () => () => {},
    }, { repoRoot: repo });

    ok(!!registeredRoute && registeredRoute.kind === 'exact' && registeredRoute.path === '/api/research-dispatch/executors',
      'v2.1.1：host.apply() 通过 webServer 可选光纤注册 /api/research-dispatch/executors 实时探测桥');

    const callBridge = async (reqInit) => {
      let statusCode = 0;
      let rawBody = '';
      const mockRes = {
        writeHead(code) { statusCode = code; },
        end(payload) { rawBody = String(payload || ''); },
      };
      await registeredRoute.handler(reqInit, mockRes);
      return {
        status: statusCode,
        ok: statusCode >= 200 && statusCode < 300,
        json: async () => JSON.parse(rawBody || '{}'),
      };
    };

    const crossSiteResp = await callBridge({
      method: 'POST',
      headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    ok(crossSiteResp.status === 403, 'v2.1.1：跨站请求被实时桥 403 拦截');

    const getResp = await callBridge({
      method: 'GET',
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    ok(getResp.status === 405, 'v2.1.1：非 POST 请求返回 405');

    const liveSnap = await mod.__test.fetchBridgeSnapshot((url, opts) => callBridge({
      method: opts.method,
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
    }));
    ok(!!liveSnap && liveSnap.version === '2.3.1' && liveSnap.catalog.includes('agy:'),
      'v2.3.1：fetchBridgeSnapshot 走实时桥拉回最新本机五类 CLI（含 agy）模型目录');

    const catFromBridge = mod.__test.panelCatalog({ executorCatalog: '' }, { get: () => undefined }, null);
    ok(catFromBridge.some((c) => c.exec === 'agy' && c.models.length >= 6),
      'v2.1.2：即使 value 与 schema 均为空，实时桥快照仍可为面板注入完整探测模型（如 agy ≥6 个模型）');

    if (registeredRoute && typeof registeredRoute.__dispose === 'function') registeredRoute.__dispose();
    ok(routeDisposed === true, 'v2.1.2：webServer 路由卸载时干净释放');

    // 4) 离线 schemaShim().object(...).toJSON() 与 propsFromSchema 100% 兼容
    const shimZ = host.__schemaShimForTest();
    const shimSchema = shimZ.object({
      executorCatalog: shimZ.string().default('agy:gemini-4-carbon-high').extra('volatile', true),
    });
    const shimProps = mod.__test.propsFromSchema(shimSchema.toJSON());
    ok(!!shimProps && shimProps.executorCatalog && shimProps.executorCatalog.default === 'agy:gemini-4-carbon-high',
      'v2.1.2：离线 schemaShim.toJSON() 产出标准 { uid, refs } 并被 propsFromSchema 正常读取');

    mod.__test.resetBridgeSnapshot();
  }

  // ── v2.2.0 新增契约：四槽位注册 + .dsh/profiles 黑名单净化 + seats.json 双向回显 + /swarm 拓扑与人类裁决台 ──
  {
    const expandTree = (n) => {
      if (n === null || n === undefined || typeof n !== 'object') return n;
      if (Array.isArray(n)) return n.map(expandTree);
      if (typeof n.type === 'function') return expandTree(n.type(n.props || {}));
      return { ...n, props: { ...(n.props || {}), children: expandTree((n.props || {}).children) } };
    };
    const findAll = (rootNode, pred) => {
      const acc = [];
      (function scan(x) {
        if (x === null || x === undefined || typeof x !== 'object') return;
        if (Array.isArray(x)) { x.forEach(scan); return; }
        if (typeof x.type === 'function') { scan(x.type(x.props || {})); return; }
        if (pred(x)) acc.push(x);
        if (x.props) scan(x.props.children);
      })(rootNode);
      return acc;
    };
    const textOf = (rootNode) => {
      const chunks = [];
      (function scan(x) {
        if (x === null || x === undefined || x === false || x === true) return;
        if (typeof x === 'string' || typeof x === 'number') { chunks.push(String(x)); return; }
        if (Array.isArray(x)) { x.forEach(scan); return; }
        if (typeof x.type === 'function') { scan(x.type(x.props || {})); return; }
        if (x && x.props) scan(x.props.children);
      })(rootNode);
      return chunks.join('');
    };
    const JARGON_RE = /dispatch\/|\.sh\b|\.json|default_backends|seats\[|model_override|executor_override|subagent|tmux|kimi-k3|命名空间|网关/;

    // 1) 四槽位注册验证（settings.section.icon / conversation.view / conversation.session.header.utilities / settings.section）
    const slotBag = [];
    let openedView = null;
    mod.apply({
      slots: {
        inject: (slotName, fn) => { slotBag.push({ slot: slotName, ...fn() }); },
        register: (def, comp) => ({ def, comp }),
      },
      get: (n) => (n === 'conversationView' ? { openView: (id, sub) => { openedView = { id, sub }; } } : undefined),
      remote: { settings: { describe: async () => ({ ok: true, value: { namespaces: [] } }) } },
    });
    const slotNames = slotBag.map((s) => s.slot);
    ok(slotNames.includes('settings.section.icon')
      && slotNames.includes('conversation.view')
      && slotNames.includes('conversation.session.header.utilities')
      && slotNames[slotNames.length - 1] === 'settings.section',
      'v2.2.0：客户端同时注册设置图标、会话顶栏科研拓扑视图、会话顶栏快捷胶囊与设置页主面板');

    const convViewSlot = slotBag.find((s) => s.slot === 'conversation.view');
    const pillSlot = slotBag.find((s) => s.slot === 'conversation.session.header.utilities');
    ok(convViewSlot && convViewSlot.def.id === 'research-swarm' && convViewSlot.def.label() === '科研拓扑',
      'v2.2.0：conversation.view 注册 id=research-swarm（标题“科研拓扑”）');
    hookCursor = 0;
    const pillTree = expandTree(pillSlot.comp({ session: { id: 's1', cwd: repo } }));
    pillTree.props.onClick();
    ok(!!openedView && openedView.id === 'research-swarm',
      'v2.2.0：点击会话顶栏“科研拓扑”胶囊直接唤醒 conversationView.openView("research-swarm")');

    // 2) .dsh/profiles/desktop 黑名单净化与 DSH workspace.json 自动识别
    const fakeDshRoot = process.env.DSH_HOME;
    const fakeProfileDir = path.join(fakeDshRoot, 'profiles', 'desktop');
    fs.mkdirSync(path.join(fakeDshRoot, 'storages'), { recursive: true });
    fs.mkdirSync(fakeProfileDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDshRoot, 'storages', 'workspace.json'), JSON.stringify({
      tables: {
        workspaces: {
          ws_bad: { id: 'ws_bad', path: fakeProfileDir, name: 'desktop', updatedAt: '2026-11-15T01:00:00Z' },
          ws_good: { id: 'ws_good', path: repo, name: '科研工作流', updatedAt: '2026-11-15T00:00:00Z' },
        },
      },
    }), 'utf8');
    ok(host.resolveDefaultRepoRoot(fakeProfileDir) === repo
      && host.repoRootOf({ repoRoot: fakeProfileDir }) === repo,
      'v2.2.0：宿主层遇到 .dsh/profiles/desktop 自动拉黑并切换到含 dispatch/seats.json 的真实科研工作区');

    // 3) 多路由 webServer 桥（/executors + /swarm-state + /action）+ 前端项目继承回显 + 科研拓扑 SVG 渲染 + 人工拍板写盘
    fs.mkdirSync(path.join(repo, 'ideas', 'demo-topic', 'briefs'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'ideas', 'demo-topic', 'cards'), { recursive: true });
    const demoBriefText = '# idea_01: Dual-Stage Sparse Gating\n\n<!-- meta isha=111122223333 bsha=444455556666 -->\n- 预测: +2.0\n- 主读数: acc\n- 判据: >= 2sigma\n';
    const demoBriefSha = crypto.createHash('sha256').update(demoBriefText.replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(repo, 'ideas', 'demo-topic', 'briefs', 'idea_01.md'), demoBriefText, 'utf8');
    fs.writeFileSync(path.join(repo, 'ideas', 'demo-topic', 'cards', 'idea_01.codex.md'), [
      '<!-- meta role=reviewer idea=idea_01 seat=codex model=gpt-5 sha=' + demoBriefSha + ' -->',
      '```yaml',
      'idea_id: idea_01',
      'reviewer: codex',
      'model: gpt-5',
      'novelty: { score: 4, reason: "门控分解清晰" }',
      'feasibility: { score: 4, reason: "单卡两小时可验" }',
      'baseline_fit: { score: 5, reason: "零侵入挂载基线" }',
      'impl_cost: { score: 4, reason: "仅改 40 行" }',
      'expected_gain: { score: 4, reason: "越过 2sigma" }',
      'verdict: go',
      'kill_reason: null',
      'confidence: 0.85',
      'missing_info: []',
      '```',
      '建议推进短探针核验。',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(repo, 'ideas', 'demo-topic', 'cards', 'idea_01.manifest'), [
      '<!-- manifest schema=2 idea=idea_01 sha=' + demoBriefSha + ' status=OK -->',
      'votes: codex',
      'codex → verdict: go',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(repo, 'ideas', 'demo-topic', '_summary.md'), [
      '# 评审汇总（demo-topic）',
      '',
      '| Rank | Idea | N | F | C | Cost | G | 总均分(/25) | 票型 | 裁决 |',
      '|---|---|---|---|---|---|---|---|---|---|',
      '| #1 | idea_01 | 4.0 | 4.0 | 5.0 | 4.0 | 4.0 | 21.0 | 1G/0R/0K | *(待填)* |',
      '',
    ].join('\n'), 'utf8');

    const routeMap = {};
    host.apply({
      logger: () => ({ info() {}, error() {} }),
      inject: (deps, fn) => {
        if (Array.isArray(deps) && deps.includes('webServer')) {
          fn({
            webServer: { register: (r) => { routeMap[r.path] = r; return () => {}; } },
            effect: (eff) => { eff(); },
          });
        }
      },
      on: () => () => {},
    }, { repoRoot: repo });

    ok(!!routeMap['/api/research-dispatch/executors']
      && !!routeMap['/api/research-dispatch/swarm-state']
      && !!routeMap['/api/research-dispatch/action'],
      'v2.2.0：webServer 注册齐备 /executors、/swarm-state、/action 三条本地回环桥路由');

    const mockFetch = async (url, opts = {}) => {
      const u = new URL(url, 'http://127.0.0.1:3080');
      const r = routeMap[u.pathname];
      if (!r) return { status: 404, ok: false, json: async () => ({ ok: false }) };
      let code = 0;
      let raw = '';
      const bodyBuf = opts.body ? Buffer.from(String(opts.body), 'utf8') : Buffer.alloc(0);
      const reqObj = {
        method: opts.method || 'POST',
        url: u.pathname + u.search,
        headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
        socket: { remoteAddress: '127.0.0.1' },
        [Symbol.asyncIterator]: async function* () { if (bodyBuf.length) yield bodyBuf; },
      };
      await r.handler(reqObj, {
        writeHead(c) { code = c; },
        end(p) { raw = String(p || ''); },
      });
      return { status: code, ok: code >= 200 && code < 300, json: async () => JSON.parse(raw || '{}') };
    };
    const prevFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      await mod.__test.fetchBridgeSnapshot(mockFetch, fakeProfileDir);
      let savedPatch = null;
      mount({
        remote: {
          settings: {
            describe: async () => ({
              ok: true,
              value: {
                namespaces: [{
                  ns: 'research-dispatch',
                  revision: 9,
                  user: {},
                  value: {
                    ...FULL_VALUE,
                    repoRoot: fakeProfileDir,
                    scoutCommand: '',
                    divergeCommand: '',
                    reviewVotes: '',
                    noveltyCommand: '',
                  },
                  schema: REAL_SCHEMA,
                }],
              },
            }),
            update: async (arg) => { savedPatch = arg; return { ok: true }; },
          },
        },
      });

      let p22 = await settle(render());
      const pathInput = p22.inputs.find((p) => String(p.className || '').includes('rdp-in-path'));
      ok(pathInput && pathInput.value === repo,
        'v2.2.0：前端面板发现旧配置误存 .dsh/profiles/desktop 时自动净化为真实科研项目根目录');
      ok(p22.texts.some((t) => t.includes('项目默认：')) && p22.texts.some((t) => t.includes('载入默认')),
        'v2.2.0：面板留空时自动回显项目 seats.json 真实默认阵容与一键载入微调按钮');
      ok(p22.buttons.filter((b) => String(b.className || '').includes('rdp-help-btn')).length >= 6,
        'v2.3.2：冗余大段文字已收纳至问号悬停提示（rdp-help-btn）');
      const jargonHit = p22.texts.find((t) => JARGON_RE.test(t));
      ok(!jargonHit, 'v2.2.0：Bento 升级后的「阵容编排」页依然保持零底层术语泄漏' + (jargonHit ? '（命中：' + jargonHit + '）' : ''));

      // 切换到「科研拓扑」Tab，验证 S0→S6 流水线导轨 + SVG 贝塞尔 /swarm 关系图 + 五维拆解条 + 人工拍板写盘
      const swarmTabBtn = p22.buttons.find((b) => textOf(b.children).includes('科研拓扑'));
      ok(!!swarmTabBtn, 'v2.2.0：设置页顶栏提供「科研拓扑」分段切换器');
      swarmTabBtn.onClick();
      p22 = await settle(render());
      p22 = await settle(render());

      hookCursor = 0;
      const expandedSwarm = expandTree(p22.tree);
      const svgPaths = findAll(expandedSwarm, (n) => n.type === 'path' && String(n.props.className || '').includes('rdp-edge'));
      const svgNodes = findAll(expandedSwarm, (n) => n.type === 'g' && String(n.props.className || '').includes('rdp-gnode'));
      const ideaChips = findAll(expandedSwarm, (n) => n.type === 'button' && String(n.props.className || '').includes('rdp-idea-chip'));
      ok(ideaChips.length >= 1 && !textOf(ideaChips[0].props.children).includes('idea_01'),
        'v2.3.3：候选方案胶囊不再暴露 idea_01 下划线内部代码名，改为自然标题/方案编号');
      ok(svgPaths.length >= 4 && svgNodes.length >= 5 && p22.texts.some((t) => t.includes('idea_01')) && p22.texts.some((t) => t.includes('21.0/25')),
        'v2.2.0：「科研拓扑」渲染 S0→S6 全链路、三次贝塞尔 /swarm 拓扑边与节点、以及 #1 idea_01 (21.0/25) 读数');

      // [P1 #3] 缺省 expectedBriefSha 必须被宿主桥 400 拦截，不允许绕过版本指纹锁
      let missingShaErr = '';
      try {
        await mod.__test.postDispatchAction({
          kind: 'verdict',
          repoRoot: repo,
          topic: 'demo-topic',
          ideaId: 'idea_01',
          decision: 'kill',
        }, mockFetch);
      } catch (e) {
        missingShaErr = String((e && e.message) || e);
      }
      ok(missingShaErr.includes('expectedBriefSha'),
        'P1 #3：HTTP /action 缺省 expectedBriefSha 时显式拒绝写盘');

      // [P1 #5] HTTP 回环桥拒绝操作未授权的外部 repoRoot（403）
      const unauthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-unauth-ws-'));
      let unauthErr = '';
      try {
        await mod.__test.postDispatchAction({
          kind: 'init',
          repoRoot: unauthDir,
        }, mockFetch);
      } catch (e) {
        unauthErr = String((e && e.message) || e);
      } finally {
        try { fs.rmSync(unauthDir, { recursive: true, force: true }); } catch {}
      }
      ok(unauthErr.includes('未授权'),
        'P1 #5：HTTP 回环桥 /action 拒绝对未授权外部 repoRoot 执行写入或初始化');

      // [P2 #17] 业务 404（BRIEF_NOT_FOUND）必须透出业务错误且不得误判为旧后台 SWARM_ROUTE_MISSING
      let missingBriefErr = '';
      try {
        await mod.__test.postDispatchAction({
          kind: 'verdict',
          repoRoot: repo,
          topic: 'demo-topic',
          ideaId: 'idea_99',
          expectedBriefSha: demoBriefSha,
          decision: 'go',
        }, mockFetch);
      } catch (e) {
        missingBriefErr = String((e && e.message) || e);
      }
      ok(missingBriefErr.includes('不存在') && mod.__test.isBackendOutdated({ ns: 'research-dispatch', schema: REAL_SCHEMA, value: {} }) === false,
        'P2 #17：HTTP 404 业务错误（BRIEF_NOT_FOUND）透出可读业务提示且绝不误触发旧后台警告');

      // [P2 #6] 通用路由器的普通 JSON 404（无桥接标识与业务 code）仍须准确判定为旧后台路由未挂载
      const generic404Fetch = async () => ({
        status: 404,
        ok: false,
        headers: { get: () => '' },
        json: async () => ({ error: 'Not Found' }),
      });
      let generic404Err = '';
      try {
        await mod.__test.postDispatchAction({ kind: 'pool', repoRoot: repo }, generic404Fetch);
      } catch (e) {
        generic404Err = String((e && e.message) || e);
      }
      ok(generic404Err.includes('旧版进程') && mod.__test.isBackendOutdated({ ns: 'research-dispatch', schema: REAL_SCHEMA, value: {} }) === true,
        'P2 #6：通用路由器 JSON 404（不含桥接响应头或业务 code）准确触发旧后台提示');
      mod.__test.resetSwarmSnapshot();

      // [新 P2-A] /executors 同样拦截未授权外部 repoRoot（403）
      const unauthExecDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-unauth-exec-'));
      let unauthExecStatus = 0;
      try {
        const respExec = await mockFetch('/api/research-dispatch/executors', {
          method: 'POST',
          body: JSON.stringify({ repoRoot: unauthExecDir, refresh: false }),
        });
        unauthExecStatus = respExec.status;
      } finally {
        try { fs.rmSync(unauthExecDir, { recursive: true, force: true }); } catch {}
      }
      ok(unauthExecStatus === 403,
        '新 P2-A：/executors 接口同样拒绝读取未授权外部工作区配置（403）');

      // [P1 #7] 动作发出 → 新轮询发出 → 动作先返回 v2 → 旧轮询晚返回 v1：共享快照必须保持 v2 不被回退
      let releaseAction = null;
      let releaseSlowPoll = null;
      const actionPromise = mod.__test.postDispatchAction({ kind: 'pool', repoRoot: repo }, async () => new Promise((resolve) => {
        releaseAction = () => resolve({
          status: 200,
          ok: true,
          headers: { get: () => '1' },
          json: async () => ({ ok: true, value: { ok: true }, snapshot: { repoRoot: repo, revTag: 'fresh-v2' } }),
        });
      }));
      const slowPollPromise = mod.__test.fetchSwarmSnapshot({ repoRoot: repo }, async () => new Promise((resolve) => {
        releaseSlowPoll = () => resolve({
          status: 200,
          ok: true,
          headers: { get: () => '1' },
          json: async () => ({ ok: true, value: { repoRoot: repo, revTag: 'stale-v1' } }),
        });
      }));
      releaseAction();
      await actionPromise;
      releaseSlowPoll();
      await slowPollPromise;
      ok(mod.__test.swarmSnapshot() && mod.__test.swarmSnapshot().revTag === 'fresh-v2',
        'P1 #7：动作发出→新轮询发出→动作先返回 v2→旧轮询晚返回 v1，共享快照保持 fresh-v2 不回退');
      mod.__test.resetSwarmSnapshot();

      // 验证人类唯一裁决权：点击 KILL 裁决动作通过 /action 路由原子写入 verdict-idea_01.md 与 dead-ends.md
      const verdictResp = await mod.__test.postDispatchAction({
        kind: 'verdict',
        repoRoot: repo,
        topic: 'demo-topic',
        ideaId: 'idea_01',
        expectedBriefSha: demoBriefSha,
        decision: 'kill',
        reason: '机制与现有门控等价',
        deadEndLine: '禁止简单双阶段稀疏门控重命名',
      }, mockFetch);
      const verdictDisk = fs.readFileSync(path.join(repo, 'ideas', 'demo-topic', 'verdict-idea_01.md'), 'utf8');
      const deadEndsDisk = fs.readFileSync(path.join(repo, 'ideas', 'demo-topic', 'dead-ends.md'), 'utf8');
      ok(verdictResp && verdictResp.ok === true
        && verdictDisk.includes('决定: kill')
        && deadEndsDisk.includes('禁止简单双阶段稀疏门控重命名'),
        'v2.2.0：人类裁决台落盘写入 verdict-idea_01.md（决定: kill）并同步沉淀课题 dead-ends.md');

      let badActionErr = '';
      try {
        await mod.__test.postDispatchAction({
          kind: 'verdict',
          repoRoot: repo,
          topic: 'demo-topic',
          ideaId: 'idea_01',
          decision: 'auto_approve',
        }, mockFetch);
      } catch (e) {
        badActionErr = String((e && e.message) || e);
      }
      ok(badActionErr.includes('go、revise 或 kill'),
        'v2.2.0：非法裁决枚举（非 go/revise/kill）被宿主闸门严格拦截');
      void savedPatch;
    } finally {
      globalThis.fetch = prevFetch;
      mod.__test.resetBridgeSnapshot();
      mod.__test.resetSwarmSnapshot();
    }

    // 4) v2.2.1 Electron 桌面端（file:// 协议 + 无 webServer + connection.fetch.register / connection.rpc）端到端回归
    const connRoutes = {};
    let webFallbackDisposed = false;
    let disposeConnScope = null;
    let deferredConnInject = null;
    host.apply({
      logger: () => ({ info() {}, error() {} }),
      inject: (deps, fn) => {
        // 模拟 webServer 先就绪、connection 后异步就绪，验证 connection 挂载后自动卸载备用 webServer 防 /api 冲突
        if (Array.isArray(deps) && deps.includes('webServer')) {
          fn({
            webServer: { register: () => () => { webFallbackDisposed = true; } },
            effect: (eff) => { eff(); },
          });
        }
        if (Array.isArray(deps) && deps.includes('connection')) {
          deferredConnInject = fn;
        }
      },
      on: () => () => {},
    }, { repoRoot: repo });
    if (deferredConnInject) {
      deferredConnInject({
        connection: {
          fetch: {
            register: (route) => {
              connRoutes[route.path] = route;
              return () => { delete connRoutes[route.path]; };
            },
          },
        },
        on: (ev, cb) => { if (ev === 'dispose') disposeConnScope = cb; },
      });
    }

    ok(!!connRoutes['/api/research-dispatch/swarm-state']
      && !!connRoutes['/api/research-dispatch/action']
      && !!connRoutes['/api/research-dispatch/executors']
      && webFallbackDisposed === true,
      'v2.2.1：宿主 connection.fetch.register 注册齐三条跨端 RPC 路由，并自动释放先挂载的备用 webServer 路由');

    // 严格复刻 @deepseek-ai/dsh-client-connection 的 parseConnectionResponse 协议校验
    let rpcSeq = 0;
    const strictElectronRpc = {
      async call(channel, endpoint, payload) {
        const fullPath = channel + '/' + endpoint;
        const route = connRoutes[fullPath];
        if (!route) throw new Error('transport failure for ' + fullPath + ': HTTP 404');
        const rpcId = 'rpc-' + (++rpcSeq);
        const req = new Request('http://dsh.internal' + fullPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
        });
        const resp = await route.fetch(req);
        if (!resp.ok) throw new Error('transport failure for ' + fullPath + ': HTTP ' + resp.status);
        const env = await resp.json();
        if (!env || env.type !== 'server-response' || env.rpcId !== rpcId || !env.result || typeof env.result !== 'object') {
          throw new TypeError('invalid server-response envelope');
        }
        if (env.result.ok === true) {
          return { ok: true, value: env.result.value };
        }
        const er = env.result.error;
        if (!er || typeof er.code !== 'string' || typeof er.message !== 'string'
          || !er.details || typeof er.details !== 'object' || Array.isArray(er.details)) {
          throw new TypeError('invalid error envelope details');
        }
        return { ok: false, error: er };
      },
    };

    const prevFetchDesktop = globalThis.fetch;
    const prevLoc = globalThis.window.location;
    globalThis.fetch = undefined;
    globalThis.window.location = { protocol: 'file:', origin: 'null' };
    mod.__test.resetBridgeSnapshot();
    mod.__test.resetSwarmSnapshot();

    try {
      mount({
        get: (n) => (n === 'connection' ? { rpc: strictElectronRpc } : undefined),
        remote: {
          settings: {
            describe: async () => ({
              ok: true,
              value: {
                namespaces: [{
                  ns: 'research-dispatch',
                  revision: 10,
                  user: {},
                  value: { ...FULL_VALUE, repoRoot: repo },
                  schema: REAL_SCHEMA,
                }],
              },
            }),
            update: async () => ({ ok: true }),
          },
        },
      });

      let pDesktop = await settle(render());
      ok(!!mod.__test.bridgeSnapshot() && mod.__test.bridgeSnapshot().version === '2.3.1',
        'v2.3.1：Electron file:// 环境下无 HTTP fetch 时，自动走 connection.rpc 拉通执行者模型目录');

      const toSwarmBtn = pDesktop.buttons.find((b) => textOf(b.children).includes('科研拓扑'));
      toSwarmBtn.onClick();
      pDesktop = await settle(render());
      pDesktop = await settle(render());

      hookCursor = 0;
      const expandedDesktopSwarm = expandTree(pDesktop.tree);
      const desktopNodes = findAll(expandedDesktopSwarm, (n) => n.type === 'g' && String(n.props.className || '').includes('rdp-gnode'));
      const stuckLoading = pDesktop.texts.some((t) => t.includes('正在同步实时科研拓扑盘面'));
      ok(!stuckLoading && desktopNodes.length >= 5 && pDesktop.texts.some((t) => t.includes('idea_01')),
        'v2.2.1：Electron 桌面端（file:// + connection.rpc）秒级渲染 /swarm 拓扑星图，不再卡死于“正在同步实时科研拓扑盘面…”');

      // 验证 connection.rpc 下的拍板动作：parseConnectionResponse 剥离顶层字段后仍从 value.snapshot 更新拓扑快照
      const goViaRpc = await mod.__test.postDispatchAction({
        kind: 'verdict',
        repoRoot: repo,
        topic: 'demo-topic',
        ideaId: 'idea_01',
        expectedBriefSha: demoBriefSha,
        decision: 'go',
        note: 'Electron RPC 拍板验收通过',
      });
      const goDisk = fs.readFileSync(path.join(repo, 'ideas', 'demo-topic', 'verdict-idea_01.md'), 'utf8');
      const snapIdeas = (mod.__test.swarmSnapshot() && mod.__test.swarmSnapshot().ideas) || [];
      ok(goViaRpc.ok === true
        && goDisk.includes('决定: go')
        && snapIdeas.some((it) => it.ideaId === 'idea_01' && it.verdict === 'go'),
        'v2.2.1：Electron connection.rpc 拍板动作回传符合严格协议校验并实时刷新前端拓扑状态');

      // 验证 connection.rpc 错误包格式（details 必为纯对象）与非 404 异常显式提示（绝不静默卡死）
      let badRpcErr = '';
      try {
        await mod.__test.postDispatchAction({
          kind: 'verdict',
          repoRoot: repo,
          topic: 'demo-topic',
          ideaId: 'idea_01',
          decision: 'invalid_choice',
        });
      } catch (e) {
        badRpcErr = String((e && e.message) || e);
      }
      ok(badRpcErr.includes('go、revise 或 kill'),
        'v2.2.1：connection.rpc 失败回包满足 error.details 纯对象校验且透出可读中文错误');

      // 验证旧版托盘驻留进程（HTTP 404）与通道故障时，画布显式告警而不无限转圈
      mod.__test.resetSwarmSnapshot();
      mod.__test.setConnection({
        rpc: {
          call: async () => { throw new Error('transport failure for /api/research-dispatch/swarm-state: HTTP 404'); },
        },
      });
      await mod.__test.fetchSwarmSnapshot({ repoRoot: repo });
      pDesktop = await settle(render());
      ok(mod.__test.swarmRouteMissing() === true
        && pDesktop.texts.some((t) => t.includes('系统托盘'))
        && !pDesktop.texts.some((t) => t.includes('正在同步实时科研拓扑盘面')),
        'v2.2.1：旧后台未挂载路由返回 HTTP 404 时，立即提示从系统托盘退出重开而非永久卡加载');

      mod.__test.resetSwarmSnapshot();
      mod.__test.setConnection({
        rpc: {
          call: async () => { throw new Error('IPC channel disconnected'); },
        },
      });
      await mod.__test.fetchSwarmSnapshot({ repoRoot: repo });
      pDesktop = await settle(render());
      ok(mod.__test.swarmLastError().includes('IPC channel disconnected')
        && pDesktop.texts.some((t) => t.includes('实时拓扑同步未成功'))
        && !pDesktop.texts.some((t) => t.includes('正在同步实时科研拓扑盘面')),
        'v2.2.1：IPC 异常时显式展示错误原因与重试引导，绝不静默卡死');

      // 验证 Electron Origin: null / file:// 回环放行与跨站阻断
      ok(host.isLocalBridgeRequestAllowed({
        headers: { host: '127.0.0.1:3080', origin: 'null' },
        socket: { remoteAddress: '127.0.0.1' },
      }) === true
        && host.isLocalBridgeRequestAllowed({
          headers: { host: 'localhost:3080', origin: 'file://' },
          socket: { remoteAddress: '::1' },
        }) === true
        && host.isLocalBridgeRequestAllowed({
          headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' },
          socket: { remoteAddress: '127.0.0.1' },
        }) === false
        && host.isLocalBridgeRequestAllowed({
          headers: { host: '127.0.0.1:3080', origin: 'file://' },
          socket: { remoteAddress: '192.168.1.99' },
        }) === false,
      'v2.2.1：回环鉴权放行本机 Electron Origin:null/file://，严格拦截外部站点与非本机来源');

      if (typeof disposeConnScope === 'function') disposeConnScope();
      ok(Object.keys(connRoutes).length === 0, 'v2.2.1：connection 作用域卸载时干净注销全部 RPC 路由');
    } finally {
      globalThis.fetch = prevFetchDesktop;
      globalThis.window.location = prevLoc;
      mod.__test.setConnection(null);
      mod.__test.resetBridgeSnapshot();
      mod.__test.resetSwarmSnapshot();
    }

    // 5) v2.3.0 精修契约：① 视觉反廉价静态审计 ② 无 Prim 离线 SVG 兜底 + 原生目录选择 ③ 注入模拟 Prim 原语契约 ④ /swarm 画布缩放平移
    {
      const expand23 = (n) => {
        if (n === null || n === undefined || typeof n !== 'object') return n;
        if (Array.isArray(n)) return n.map(expand23);
        if (typeof n.type === 'function') return expand23(n.type(n.props || {}));
        return { ...n, props: { ...(n.props || {}), children: expand23((n.props || {}).children) } };
      };
      const find23 = (rootNode, pred) => {
        const acc = [];
        (function scan(x) {
          if (x === null || x === undefined || typeof x !== 'object') return;
          if (Array.isArray(x)) { x.forEach(scan); return; }
          if (typeof x.type === 'function') { scan(x.type(x.props || {})); return; }
          if (pred(x)) acc.push(x);
          if (x.props) scan(x.props.children);
        })(rootNode);
        return acc;
      };
      const txt23 = (rootNode) => {
        const chunks = [];
        (function scan(x) {
          if (x === null || x === undefined || x === false || x === true) return;
          if (typeof x === 'string' || typeof x === 'number') { chunks.push(String(x)); return; }
          if (Array.isArray(x)) { x.forEach(scan); return; }
          if (typeof x.type === 'function') { scan(x.type(x.props || {})); return; }
          if (x && x.props) scan(x.props.children);
        })(rootNode);
        return chunks.join('');
      };

      // ① 静态反廉价与版本兼容审计
      const cssStr = mod.__test.CSS();
      const rawClientCode = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
      const codeNoComments = rawClientCode.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      ok(!/linear-gradient/i.test(cssStr) && /tabular-nums/.test(cssStr),
        'v2.3.0：CSS 零 linear-gradient 刺眼渐变，全量数值启用 tabular-nums 等宽排版');
      ok(!/--dsw-alias-(?:state-warning-|button-primary-text)/.test(rawClientCode)
        && /--dsw-alias-state-warn-primary/.test(cssStr)
        && /--dsw-alias-label-primary-foreground/.test(cssStr),
        'v2.3.0：CSS 全量对齐 DSH 官方真实令牌（--dsw-alias-state-warn-primary / --dsw-alias-label-primary-foreground），零幻觉变量名');
      ok(!/[▾▸✓✕✦●↻👤①②③④]/.test(codeNoComments),
        'v2.3.0：client.js 运行代码彻底清零 Unicode 伪图标字符（全部升级为矢量 SVG / 官方 Icon*）');
      mod.__test.setBridgeSnapshot({ version: '2.2.0', catalog: 'agy:m1' });
      const v220Outdated = mod.__test.isBackendOutdated({ schema: REAL_SCHEMA, value: {} });
      mod.__test.setBridgeSnapshot({ version: '2.2.1', catalog: 'agy:m1' });
      const v221Outdated = mod.__test.isBackendOutdated({ schema: REAL_SCHEMA, value: {} });
      mod.__test.setBridgeSnapshot({ version: '2.3.0', catalog: 'agy:m1' });
      const v230Outdated = mod.__test.isBackendOutdated({ schema: REAL_SCHEMA, value: {} });
      mod.__test.resetBridgeSnapshot();
      ok(v220Outdated === true && v221Outdated === false && v230Outdated === false,
        'v2.3.0：isBackendOutdated 拦截无 RPC 桥的 ≤2.2.0 旧后台，放行 2.2.1 与 2.3.0');

      // ② 无 Prim 离线沙箱降级渲染 + 原生目录选择（null 取消静默无错 + 选中路径回填）+ 页脚安静/高亮切换
      ok(mod.__test.getPrimitives() === null, 'v2.3.0：离线沙箱默认安全降级 Prim === null 不抛异常');
      let dirPickCalls = 0;
      let nextPickedDir = null;
      hookState.length = 0;
      let regDir = null;
      mod.apply({
        slots: { inject: (n, fn) => { regDir = { slot: n, ...fn() }; }, register: (def, comp) => ({ def, comp }) },
        get: () => undefined,
        uiWorkspace: {
          pickDirectory: async () => { dirPickCalls += 1; return nextPickedDir; },
        },
        remote: { settings: readyApi },
      });
      const renderExpanded23 = () => {
        hookCursor = 0;
        pendingEffects = [];
        return expand23(registered.comp({}));
      };
      registered = regDir;
      let pDir = await settle(render());
      const expClean = renderExpanded23();
      const footClean = find23(expClean, (n) => n.type === 'div' && String(n.props.className || '').includes('rdp-foot'))[0];
      const svgFallbackIcons = find23(expClean, (n) => n.type === 'svg' && String(n.props.className || '').includes('rdp-svg-ico'));
      ok(!!footClean && String(footClean.props.className).includes('is-quiet') && svgFallbackIcons.length >= 6,
        'v2.3.0：无改动时底部操作栏保持 is-quiet 安静态，且离线沙箱正常渲染 1.5px 描边矢量 SVG 图标');

      const browseBtn = pDir.buttons.find((b) => String(b.className || '').includes('rdp-browse-btn'));
      ok(!!browseBtn && txt23(browseBtn.children).includes('浏览'),
        'v2.3.0：检测到 uiWorkspace.pickDirectory 服务时在项目路径旁展示原生「浏览…」按钮');

      // 用户取消选择（返回 null）→ 静默保持原路径且不置 dirty
      nextPickedDir = null;
      browseBtn.onClick();
      await tick(); await tick();
      pDir = render();
      ok(dirPickCalls === 1
        && pDir.inputs.find((p) => String(p.className || '').includes('rdp-in-path')).value === '/workspace/demo-project'
        && pDir.buttons.find((b) => txt23(b.children) === '保存').disabled === true,
        'v2.3.0：原生文件夹选择框用户取消（返回 null）时静默不报错、不污染草稿');

      // 用户选中新目录 → 自动更新路径草稿并抬升底部保存栏为 is-elevated
      nextPickedDir = '/workspace/picked-via-native-dialog';
      pDir.buttons.find((b) => String(b.className || '').includes('rdp-browse-btn')).onClick();
      await tick(); await tick();
      pDir = render();
      const footDirty = find23(renderExpanded23(), (n) => n.type === 'div' && String(n.props.className || '').includes('rdp-foot'))[0];
      ok(dirPickCalls === 2
        && pDir.inputs.find((p) => String(p.className || '').includes('rdp-in-path')).value === '/workspace/picked-via-native-dialog'
        && !!footDirty && String(footDirty.props.className).includes('is-elevated'),
        'v2.3.0：原生文件夹选择返回路径后即时写入输入框，并将底部保存栏切换至 is-elevated 高亮态');

      // ③ 注入模拟 @deepseek-ai/dsh-client-ui-primitives 核验原生组件调用与精确 Props 契约
      const primCalls = { Button: 0, Switch: [], Tag: 0, StateDot: 0, Menu: [], Icons: [] };
      const makeIconMock = (iconName) => (p) => {
        const definedKeys = Object.keys(p || {}).filter((k) => p[k] !== undefined);
        primCalls.Icons.push({ name: iconName, keys: definedKeys });
        return fakeReact.createElement('svg', { 'data-prim-icon': iconName, width: p && p.size });
      };
      const mockPrim = {
        Button: (p) => {
          primCalls.Button += 1;
          return fakeReact.createElement('button', {
            type: 'button',
            'data-prim-btn': p.variant,
            disabled: p.disabled,
            className: p.className,
            onClick: p.onClick,
          }, p.icon, p.children);
        },
        Switch: (p) => {
          primCalls.Switch.push(p);
          return fakeReact.createElement('button', {
            type: 'button',
            role: 'switch',
            'data-prim-switch': '1',
            'aria-checked': String(Boolean(p.checked)),
            'aria-label': p.label,
            disabled: p.disabled,
            onClick: () => p.onChange(!p.checked),
          });
        },
        Tag: (p) => {
          primCalls.Tag += 1;
          return fakeReact.createElement('span', { 'data-prim-tag': p.tone }, p.children);
        },
        StateDot: (p) => {
          primCalls.StateDot += 1;
          return fakeReact.createElement('span', { 'data-prim-dot': p.state });
        },
        Menu: (p) => {
          primCalls.Menu.push(p);
          return fakeReact.createElement('span', { 'data-prim-menu': p.open ? 'open' : 'closed' },
            p.anchor,
            p.open ? p.items.map((it) => fakeReact.createElement('button', {
              type: 'button',
              key: it.id,
              'data-prim-item': it.id,
              onClick: () => p.onSelect(it.id),
            }, it.label)) : null);
        },
        IconFolderOpenOutline16: makeIconMock('IconFolderOpenOutline16'),
        IconRefreshOutline14: makeIconMock('IconRefreshOutline14'),
        IconChevronDownOutline14: makeIconMock('IconChevronDownOutline14'),
        IconCheckOutline14: makeIconMock('IconCheckOutline14'),
        IconPlusOutline16: makeIconMock('IconPlusOutline16'),
        IconBranchOutline16: makeIconMock('IconBranchOutline16'),
      };

      const modWithPrim = reg.factory((id) => {
        if (id === 'react') return fakeReact;
        if (id === '@deepseek-ai/dsh-client-ui-primitives') return mockPrim;
        throw new Error('unexpected require: ' + id);
      });
      ok(modWithPrim.__test.getPrimitives() === mockPrim,
        'v2.3.0：宿主持有 @deepseek-ai/dsh-client-ui-primitives 时自动启用官方原语模块');

      hookState.length = 0;
      let regPrimSlot = null;
      modWithPrim.apply({
        slots: { inject: (n, fn) => { regPrimSlot = { slot: n, ...fn() }; }, register: (def, comp) => ({ def, comp }) },
        get: () => undefined,
        remote: { settings: readyApi },
      });
      registered = regPrimSlot;
      let pPrim = await settle(render());
      ok(primCalls.Button > 0
        && primCalls.StateDot > 0
        && primCalls.Switch.length >= 1
        && primCalls.Menu.length >= 3
        && primCalls.Menu.every((m) => m.portal === true && m.selectedId === '__default__')
        && primCalls.Icons.length > 0
        && primCalls.Icons.every((ic) => ic.keys.every((k) => k === 'size' || k === 'className')),
        'v2.3.0：Prim 原语模式下正确调用 Button / Switch / StateDot / Menu(portal:true) / Icon*(仅传 size/className)');

      // 验证 Prim.Switch 布尔值回调与 Prim.Menu(portal:true) 在 document mousedown 先于 click 冒泡时不提前卸载
      const prevDoc23 = globalThis.document;
      const docListeners23 = new Map();
      globalThis.document = {
        addEventListener: (ev, fn) => {
          if (!docListeners23.has(ev)) docListeners23.set(ev, new Set());
          docListeners23.get(ev).add(fn);
        },
        removeEventListener: (ev, fn) => {
          if (docListeners23.has(ev)) docListeners23.get(ev).delete(fn);
        },
      };
      const fireDocMouseDown23 = (target) => {
        const set = docListeners23.get('mousedown');
        if (set) for (const fn of [...set]) fn({ target });
      };
      try {
        const primSw = pPrim.buttons.find((b) => b['data-prim-switch'] === '1');
        primSw.onClick();
        pPrim = render();
        const primExecTrigger = pPrim.buttons.find((b) => String(b.className || '').includes('rdp-exec-btn'));
        primExecTrigger.onClick();
        pPrim = render();
        const cleanups23 = [];
        for (const eff of pPrim.effects) {
          const cl = eff();
          if (typeof cl === 'function') cleanups23.push(cl);
        }
        const agyMenuItemBeforeDown = pPrim.buttons.find((b) => b['data-prim-item'] === 'agy');
        ok(!!agyMenuItemBeforeDown, 'v2.3.0：Prim.Menu 展开渲染全部 CLI 选项');

        // 模拟 createPortal(menu, document.body) 下的真实点击顺序：先冒泡 document mousedown（不在 .rdp-pick 内，在 [role="menu"] 内），再触发 onClick
        fireDocMouseDown23({
          closest: (sel) => (sel === '[role="menu"]' ? { role: 'menu' } : null),
        });
        pPrim = render();
        const agyMenuItemAfterDown = pPrim.buttons.find((b) => b['data-prim-item'] === 'agy');
        ok(!!agyMenuItemAfterDown,
          'v2.3.0：portaled Prim.Menu 菜单项触发 document mousedown 时不被 Page 提前卸载');

        agyMenuItemAfterDown.onClick();
        for (const cl of cleanups23) cl();
        pPrim = render();
        savedPatches = [];
        pPrim.buttons.find((b) => txt23(b.children) === '保存').onClick();
        await tick(); await tick();
        ok(savedPatches.length === 1
          && savedPatches[0].divergeUseDeadEnds === 'false'
          && savedPatches[0].scoutCommand === 'agy',
          'v2.3.0：Prim.Switch 布尔回调与 portaled Prim.Menu 点击选择完整驱动设置保存');
      } finally {
        if (prevDoc23 === undefined) delete globalThis.document;
        else globalThis.document = prevDoc23;
      }

      // ④ /swarm 拓扑画布缩放、滚轮钳制、拖拽平移、重置视图与 working 连线脉冲断言
      mod.__test.setSwarmSnapshot({
        ok: true,
        repoRoot: repo,
        repoName: '科研工作流',
        initialized: true,
        activeTopic: 'demo-topic',
        activeWorkerCount: 1,
        stages: [{ id: 'S4', code: 'S4', title: '多票盲审', badge: '1 运行中', status: 'working' }],
        ideas: [{ ideaId: 'idea_01', rank: 1, meanScore25: 21.0, voteCount: 2, verdict: 'pending' }],
        graph: {
          focusStage: 'S4',
          focusIdeaId: 'idea_01',
          nodes: [
            { id: 'n-in', x: 118, y: 255, kind: 'input', title: '工单 idea_01', subtitle: 'brief', badge: 'sha:111', status: 'done' },
            { id: 'n-hub', x: 342, y: 255, kind: 'hub', title: '盲审调度', subtitle: 'fanout', badge: '2 票', status: 'working' },
            { id: 'n-w1', x: 590, y: 180, kind: 'worker', seat: 'codex', title: 'codex 票', subtitle: 'gpt-5', badge: 'GO', status: 'done' },
            { id: 'n-w2', x: 590, y: 330, kind: 'worker', seat: 'agy', title: 'agy 票', subtitle: 'gemini-4', badge: '运行中', status: 'working' },
            { id: 'n-gate', x: 848, y: 255, kind: 'gate', title: '人类拍板', subtitle: '21.0/25', badge: '待裁决', status: 'pending' },
          ],
          edges: [
            { id: 'ed-done', from: 'n-in', to: 'n-hub', status: 'done' },
            { id: 'ed-w1', from: 'n-hub', to: 'n-w1', status: 'done' },
            { id: 'ed-working', from: 'n-hub', to: 'n-w2', status: 'working' },
            { id: 'ed-gate', from: 'n-w1', to: 'n-gate', status: 'pending' },
          ],
        },
      });
      hookState.length = 0;
      const renderSwarm23 = () => {
        hookCursor = 0;
        pendingEffects = [];
        return expand23(mod.__test.SwarmStudio({ repoRoot: repo, embedded: true }));
      };

      let swTree = renderSwarm23();
      const pulses = find23(swTree, (n) => n.type === 'circle' && String(n.props.className || '').includes('rdp-edge-pulse'));
      const pctOf = (tr) => txt23(find23(tr, (n) => String((n.props || {}).className || '').includes('rdp-zoom-pct'))[0]);
      const stageTrOf = (tr) => find23(tr, (n) => n.type === 'g' && String((n.props || {}).className || '').includes('rdp-svg-stage'))[0].props.transform;
      const zoomBtnOf = (tr, act) => find23(tr, (n) => n.type === 'button' && (n.props || {})['data-zoom-act'] === act)[0];
      const viewportOf = (tr) => find23(tr, (n) => n.type === 'div' && String((n.props || {}).className || '').includes('rdp-canvas-viewport'))[0];

      ok(pulses.length === 1 && pctOf(swTree) === '100%',
        'v2.3.0：/swarm 画布默认 100% 视图，且仅在 working 连线上渲染微光流动脉冲点（共 1 条）');

      // 点击 + 放大至 115%
      zoomBtnOf(swTree, 'in').props.onClick();
      swTree = renderSwarm23();
      ok(pctOf(swTree) === '115%' && stageTrOf(swTree).includes('scale(1.15)'),
        'v2.3.0：点击悬浮控制条 + 按钮放大拓扑画布至 115%');

      // 连续滚轮放大验证上限钳制 165%（1.65x）
      for (let i = 0; i < 10; i++) viewportOf(swTree).props.onWheel({ deltaY: -100, preventDefault() {} });
      swTree = renderSwarm23();
      ok(pctOf(swTree) === '165%' && zoomBtnOf(swTree, 'in').props.disabled === true,
        'v2.3.0：滚轮放大严格钳制在上限 165%（1.65x）并禁用 + 按钮');

      // 连续滚轮缩小验证下限钳制 65%（0.65x）
      for (let i = 0; i < 15; i++) viewportOf(swTree).props.onWheel({ deltaY: 100, preventDefault() {} });
      swTree = renderSwarm23();
      ok(pctOf(swTree) === '65%' && zoomBtnOf(swTree, 'out').props.disabled === true,
        'v2.3.0：滚轮缩小严格钳制在下限 65%（0.65x）并禁用 - 按钮');

      // 背景指针拖拽平移画布
      viewportOf(swTree).props.onPointerDown({ button: 0, pointerId: 1, clientX: 100, clientY: 120, target: { closest: () => null } });
      swTree = renderSwarm23();
      viewportOf(swTree).props.onPointerMove({ clientX: 165, clientY: 95 });
      viewportOf(swTree).props.onPointerUp({});
      swTree = renderSwarm23();
      ok(stageTrOf(swTree).includes('translate(555,235)'),
        'v2.3.0：背景拖拽顺滑更新拓扑视口平移偏移（+65, -25）');

      // 点击「重置视图」一键归零至 100% 与原位 (490,260)
      zoomBtnOf(swTree, 'reset').props.onClick();
      swTree = renderSwarm23();
      ok(pctOf(swTree) === '100%' && stageTrOf(swTree).includes('translate(490,260) scale(1)'),
        'v2.3.0：点击「重置视图」按钮一键将缩放与平移复位至 100% 初始坐标');

      // ⑤ 模型思考强度（EffortPicker）与 /swarm Docked Tab / Verdict 台断言
      ok(mod.__test.embeddedModelEffort('gemini-4-carbon-high') === 'high'
        && mod.__test.embeddedModelEffort('kimi-k2-thinking') === 'thinking'
        && mod.__test.embeddedModelEffort('gpt-5') === '',
        'v2.3.1：embeddedModelEffort 准确识别 *-high / *-thinking 内置模型，不误判普通模型');

      const parsedVotesEff = mod.__test.parseVoteRows('codex:gpt-5@high,agy:gemini-4-carbon-high@low,claude@xhigh');
      ok(parsedVotesEff.length === 3
        && parsedVotesEff[0].effort === 'high'
        && parsedVotesEff[1].effort === ''
        && parsedVotesEff[2].effort === 'xhigh'
        && mod.__test.voteString(parsedVotesEff) === 'codex:gpt-5@high,agy:gemini-4-carbon-high,claude:@xhigh',
        'v2.3.1：parseVoteRows / voteString 往返编码 @effort，并自动剥离内置强度模型上的多余覆盖');

      // 验证 Prim.Menu 版 EffortPicker：selectable 调起 Prim.Menu(portal:true)、内置模型显示只读随模型、kimi 非 thinking 显示不支持
      primCalls.Menu.length = 0;
      hookState.length = 0;
      const effApiValue = {
        ...FULL_VALUE,
        scoutCommand: 'codex',
        scoutModel: 'gpt-5',
        scoutEffort: '',
        divergeCommand: 'kimi',
        divergeModel: 'kimi-k2-thinking',
        noveltyCommand: 'agy',
        noveltyModel: 'gemini-4-carbon-high',
        reviewVotes: 'codex:gpt-5@high,kimi:kimi-k2.5',
      };
      const effReadyApi = {
        describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'research-dispatch', revision: 9, user: {}, value: effApiValue, schema: REAL_SCHEMA }] } }),
        update: async (_ns, patch) => { savedPatches.push(patch); return { ok: true, value: {} }; },
      };
      modWithPrim.apply({
        slots: { inject: (n, fn) => { regPrimSlot = { slot: n, ...fn() }; }, register: (def, comp) => ({ def, comp }) },
        get: () => undefined,
        remote: { settings: effReadyApi },
      });
      registered = regPrimSlot;
      let pEff = await settle(render());
      const coupledBtns = pEff.buttons.filter((b) => b['data-effort-mode'] === 'coupled');
      const unsupBtns = pEff.buttons.filter((b) => b['data-effort-mode'] === 'unsupported');
      const selEffortBtns = pEff.buttons.filter((b) => b['data-effort-mode'] === 'selectable');
      ok(coupledBtns.length === 2
        && coupledBtns.every((b) => b.disabled === true && b['aria-disabled'] === 'true')
        && coupledBtns.some((b) => txt23(b.children).includes('随模型 · thinking'))
        && coupledBtns.some((b) => txt23(b.children).includes('随模型 · high')),
        'v2.3.1：*-thinking 与 *-high 模型在界面呈现不可覆盖的只读「随模型」思考强度态');
      ok(unsupBtns.length === 1 && unsupBtns[0].disabled === true && txt23(unsupBtns[0].children).includes('不透传'),
        'v2.3.1：非内置 thinking 的不支持席位（如 kimi:kimi-k2.5）诚实标注默认不透传');
      ok(selEffortBtns.length >= 2 && primCalls.Menu.some((m) => m.selectedId === 'high' && m.portal === true),
        'v2.3.1：支持席位（codex:gpt-5）使用 Prim.Menu(portal:true) 展示可选思考强度');
      // 点击文献调研 EffortPicker 触发打开菜单并选中 medium → 保存 scoutEffort
      const scoutEffBtn = selEffortBtns.find((b) => String(b['aria-label'] || '').includes('由谁调研'));
      scoutEffBtn.onClick();
      pEff = render();
      const medItem = pEff.buttons.find((b) => b['data-prim-item'] === 'medium');
      ok(!!medItem, 'v2.3.1：点击思考强度选择器展开 Prim.Menu 含 默认 / low / medium / high / xhigh');
      medItem.onClick();
      pEff = render();
      savedPatches = [];
      pEff.buttons.find((b) => txt23(b.children) === '保存').onClick();
      await tick(); await tick();
      ok(savedPatches.length === 1 && savedPatches[0].scoutEffort === 'medium',
        'v2.3.1：选择思考强度 medium 并保存后完整提交 scoutEffort: "medium"');

      // 验证 /swarm 右侧 Dock 选项卡切换与常驻人类唯一裁决台（即使切换检视 Worker 节点也不消失）
      mod.__test.setSwarmSnapshot({
        ok: true,
        repoRoot: repo,
        repoName: '科研工作流',
        initialized: true,
        activeTopic: 'demo-topic',
        stages: [{ id: 'S4', code: 'S4', title: '多票盲审', badge: '2 票', status: 'done' }],
        ideas: [{ ideaId: 'idea_01', rank: 1, meanScore25: 21.0, voteCount: 2, verdict: 'pending' }],
        graph: {
          focusStage: 'S4',
          focusIdeaId: 'idea_01',
          nodes: [
            {
              id: 'w-codex',
              x: 590,
              y: 180,
              kind: 'worker',
              seat: 'codex',
              title: 'codex 票',
              subtitle: 'gpt-5 · high',
              badge: '21/25 · GO',
              status: 'done',
              inspect: {
                title: '盲审 Worker：codex',
                dims: { novelty: 4, feasibility: 4, baseline_fit: 4, impl_cost: 5, expected_gain: 4 },
                pushedInputs: [{ label: '唯一工单', rel: 'ideas/demo-topic/briefs/idea_01.md', sha: '112233445566' }],
                preview: 'WORKER_RAW_PREVIEW_TOKEN',
              },
            },
            {
              id: 'gate-s5',
              x: 848,
              y: 255,
              kind: 'gate',
              title: '人类拍板',
              subtitle: '21.0/25',
              badge: '待裁决',
              status: 'pending',
              inspect: {
                title: '人类裁决单',
                canVerdict: true,
                ideaId: 'idea_01',
                metaRows: [['总均分', '21.0 / 25']],
              },
            },
          ],
          edges: [{ id: 'e-wg', from: 'w-codex', to: 'gate-s5', status: 'done' }],
        },
      });
      hookState.length = 0;
      swTree = renderSwarm23();
      const workerG = find23(swTree, (n) => n.type === 'g' && String((n.props || {}).className || '').includes('rdp-gnode'))[0];
      workerG.props.onClick();
      swTree = renderSwarm23();
      const verdictDockVisible = find23(swTree, (n) => String((n.props || {}).className || '').includes('rdp-verdict-dock')).length === 1;
      const auditTabBtn = find23(swTree, (n) => n.type === 'button' && txt23((n.props || {}).children) === '隔离审计')[0];
      ok(verdictDockVisible && !!auditTabBtn,
        'v2.3.1：点击沙箱 Worker 后依然首屏固定展示人类裁决台，且右栏提供「隔离审计」选项卡');
      auditTabBtn.props.onClick();
      swTree = renderSwarm23();
      const hasPreviewInAudit = find23(swTree, (n) => n.type === 'pre' && txt23((n.props || {}).children).includes('WORKER_RAW_PREVIEW_TOKEN')).length === 1;
      ok(hasPreviewInAudit, 'v2.3.1：切换到「推式隔离审计」选项卡即刻展示推式隔离证明与原始证据预览');

      // ⑥ Codex 复审回归（P0-02 缺 socket.remoteAddress 拒绝 / N20 乱序快照不覆盖 / P2-21 部分注册回滚与断链恢复）
      ok(host.isLocalBridgeRequestAllowed({
        headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
        socket: {},
      }) === false, 'P0-02：缺失 socket.remoteAddress 的 HTTP 请求必须默认 fail-closed 拒绝');

      // N20：乱序响应——先发慢请求、后发快请求，慢请求晚到绝不覆盖新快照
      mod.__test.resetSwarmSnapshot();
      mod.__test.setConnection(null);
      let resolveSlow = null;
      const slowPromise = new Promise((r) => { resolveSlow = r; });
      const seqFetch = async (_u, init) => {
        const body = JSON.parse(String((init && init.body) || '{}'));
        if (body.topic === 'slow-old') {
          await slowPromise;
          return { status: 200, ok: true, json: async () => ({ ok: true, value: { repoRoot: repo, activeTopic: 'slow-old', ideas: [] } }) };
        }
        return { status: 200, ok: true, json: async () => ({ ok: true, value: { repoRoot: repo, activeTopic: 'fast-new', ideas: [] } }) };
      };
      const pSlow = mod.__test.fetchSwarmSnapshot({ repoRoot: repo, topic: 'slow-old' }, seqFetch);
      const pFast = mod.__test.fetchSwarmSnapshot({ repoRoot: repo, topic: 'fast-new' }, seqFetch);
      await pFast;
      resolveSlow();
      await pSlow;
      ok(mod.__test.swarmSnapshot() && mod.__test.swarmSnapshot().activeTopic === 'fast-new',
        'N20：迟到的旧拓扑快照响应被单调请求序号丢弃，不覆盖最新课题状态');

      // P2-4：跨课题切换竞态——课题 A 的动作发起后切换到课题 B 并加载成功，随后 A 的动作迟到返回不得把共享快照回滚为 A
      mod.__test.resetSwarmSnapshot();
      let resolveActA = null;
      const actAPromise = new Promise((r) => { resolveActA = r; });
      const crossTopicFetch = async (url, init) => {
        const body = JSON.parse(String((init && init.body) || '{}'));
        if (String(url).includes('/action')) {
          await actAPromise;
          return {
            status: 200,
            ok: true,
            json: async () => ({
              ok: true,
              snapshot: { repoRoot: repo, activeTopic: 'topic-a', ideas: [] },
            }),
          };
        }
        return {
          status: 200,
          ok: true,
          json: async () => ({
            ok: true,
            value: { repoRoot: repo, activeTopic: body.topic || 'topic-b', ideas: [] },
          }),
        };
      };
      const pActA = mod.__test.postDispatchAction({ repoRoot: repo, topic: 'topic-a', action: 'run-brief', ideaId: 'idea_01' }, crossTopicFetch);
      await mod.__test.fetchSwarmSnapshot({ repoRoot: repo, topic: 'topic-b' }, crossTopicFetch);
      ok(mod.__test.swarmSnapshot() && mod.__test.swarmSnapshot().activeTopic === 'topic-b',
        'P2-4 前置：切换到 topic-b 后快照应为 topic-b');
      // 模拟 topic-b 加载后触发一次不带 topic 的自动轮询，其间 topic-a 动作迟到返回绝不得覆盖 topic-b
      let resolveAutoPoll = null;
      const autoPollGate = new Promise((r) => { resolveAutoPoll = r; });
      const pAutoPoll = mod.__test.fetchSwarmSnapshot({ repoRoot: repo }, async () => {
        await autoPollGate;
        return {
          status: 200,
          ok: true,
          json: async () => ({ ok: true, value: { repoRoot: repo, activeTopic: 'topic-b', ideas: [] } }),
        };
      });
      resolveActA();
      await pActA;
      ok(mod.__test.swarmSnapshot() && mod.__test.swarmSnapshot().activeTopic === 'topic-b',
        'P2-4：即便期间发起了不带 topic 的自动轮询，topic-a 的迟到动作快照也绝不得覆盖 topic-b');
      resolveAutoPoll();
      const autoPollVal = await pAutoPoll;
      ok(autoPollVal && autoPollVal.activeTopic === 'topic-b' && mod.__test.swarmSnapshot().activeTopic === 'topic-b',
        'P2-4：被拒的迟到动作不递增序号，后续 topic-b 自动轮询正常落地');

      // P2-21：webServer 部分注册失败完整回滚，且 connection 注销后自动重挂 HTTP 备用路由
      let regAttempt = 0;
      let rollbackDisposed = 0;
      host.apply({
        logger: () => ({ info() {}, error() {} }),
        inject: (deps, fn) => {
          if (Array.isArray(deps) && deps.includes('webServer')) {
            fn({
              webServer: {
                register: () => {
                  regAttempt += 1;
                  if (regAttempt === 2) throw new Error('second-route-boom');
                  return () => { rollbackDisposed += 1; };
                },
              },
              effect: (eff) => { eff(); },
            });
          }
        },
        on: () => () => {},
      }, { repoRoot: repo });
      ok(rollbackDisposed === 1, 'P2-21：webServer 第 2 条路由注册失败时自动回滚第 1 条已注册路由');

      let connDisposeCb = null;
      let webRegisteredCount = 0;
      let webUnmountedCount = 0;
      host.apply({
        logger: () => ({ info() {}, error() {} }),
        inject: (deps, fn) => {
          if (Array.isArray(deps) && deps.includes('connection')) {
            fn({
              connection: { fetch: { register: () => () => {} } },
              on: (ev, cb) => { if (ev === 'dispose') connDisposeCb = cb; },
            });
          } else if (Array.isArray(deps) && deps.includes('webServer')) {
            fn({
              webServer: {
                register: () => {
                  webRegisteredCount += 1;
                  return () => { webUnmountedCount += 1; };
                },
              },
              effect: (eff) => { eff(); },
            });
          }
        },
        on: () => () => {},
      }, { repoRoot: repo });
      if (typeof connDisposeCb === 'function') connDisposeCb();
      ok(webRegisteredCount === 3 && webUnmountedCount === 0,
        'P2-21：connection 通道卸载后自动重挂 3 条 HTTP 备用路由，恢复通道可用性');

      mod.__test.resetSwarmSnapshot();
    }
  }

  if (prevDiag === undefined) delete process.env.RESEARCH_DISPATCH_DIAG; else process.env.RESEARCH_DISPATCH_DIAG = prevDiag;
  if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + (fail.length ? '失守 ' + fail.length + ' 条' : '全部 ' + ops + ' 条断言通过'));
process.exitCode = fail.length === 0 ? 0 : 1;
