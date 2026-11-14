// 设置页与宿主层离线自检（v2.1.2）：无浏览器、无真 React、无网络。
//   node plugin/research-dispatch/test/client.selftest.mjs
//
// 覆盖契约：
//   · schema 用真实形状 —— schemastery 的 toJSON() 是 { uid, refs }，覆盖全部 15 个字段；
//   · 五大分区按科研闭环顺序排布：工作流项目 → 文献调研 → 想法发散 → 多票评审 → 前置查重；
//   · 五合一真实 CLI 列表（codex / claude / dsh / agy / kimi，移除 api 与幻影 subagent，兼容旧 gemini/api 配置切走）；
//   · ModelPicker 彻底根治空模型死锁：常驻顶部搜索/自定义输入框、首项常驻恢复默认、0 模型可手输自定义回车选用；
//   · 宿主 apply() + loader/volatile-update 自动写穿同步 lineup 至 dispatch/seats.json，且绝不触碰手写 model_override。
import { pathToFileURL } from 'node:url';
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
  ok(deps.includes('@deepseek-ai/dsh-client-ui-settings'), '包级 dsh.client.inject 声明了设置域客户端');
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
  ok(openRows.length === 4 && txt(openRows[0]).includes('默认（使用该工具自身默认模型）'),
    '未输入过滤词时首项常驻「默认（使用该工具自身默认模型）」（1 默认 + 3 预设 = 4 行）');
  const selRow = openRows.find((x) => x.props['aria-selected'] === 'true');
  ok(!!selRow && txt(selRow) === 'Auto✓', '当前选中模型行带勾选标记');

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
  ok(rowsOf(zeroOpen).length === 1 && txt(rowsOf(zeroOpen)[0]).includes('默认（使用该工具自身默认模型）'),
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

// ── schema 的真实形状（15 字段完整覆盖）────────────────────────────────
const REAL_SCHEMA = {
  uid: 90,
  refs: {
    '3': { type: 'string', meta: { description: '科研项目文件夹路径', default: '/repo', volatile: true } },
    '7': { type: 'string', meta: { description: '座位表相对路径', default: 'dispatch/seats.json', volatile: true } },
    '11': { type: 'string', meta: { description: '文献调研环节执行工具', default: '', volatile: true } },
    '13': { type: 'string', meta: { description: '文献调研环节模型名', default: '', volatile: true } },
    '17': { type: 'string', meta: { description: '想法发散环节执行工具', default: '', volatile: true } },
    '21': { type: 'string', meta: { description: '想法发散环节模型名', default: '', volatile: true } },
    '25': { type: 'string', meta: { description: '想法发散单轮默认产出条数', default: '', volatile: true } },
    '29': { type: 'string', meta: { description: '想法发散历史死胡同过滤', default: '', volatile: true } },
    '33': { type: 'string', meta: { description: '评审票（可自由增删）', default: '', volatile: true } },
    '37': { type: 'string', meta: { description: '前置查重环节执行工具', default: '', volatile: true } },
    '41': { type: 'string', meta: { description: '前置查重环节模型名', default: '', volatile: true } },
    '45': { type: 'string', meta: { description: '只读：工具与候选模型目录', default: '', volatile: true } },
    '49': { type: 'string', meta: { description: '只读：工具安装状态', default: '', volatile: true } },
    '53': { type: 'string', meta: { description: '历史兼容字段', default: '', volatile: true } },
    '57': { type: 'string', meta: { description: '历史兼容字段', default: '', volatile: true } },
    '90': {
      type: 'object', meta: { default: {} },
      dict: {
        repoRoot: 3, seatsFile: 7,
        scoutCommand: 11, scoutModel: 13,
        divergeCommand: 17, divergeModel: 21, divergeCount: 25, divergeUseDeadEnds: 29,
        reviewVotes: 33,
        noveltyCommand: 37, noveltyModel: 41,
        executorCatalog: 45, executorStatus: 49,
        otherStages: 53, stageOpinions: 57,
      },
    },
  },
};
const ALL_KEYS = [
  'repoRoot', 'seatsFile',
  'scoutCommand', 'scoutModel',
  'divergeCommand', 'divergeModel', 'divergeCount', 'divergeUseDeadEnds',
  'reviewVotes',
  'noveltyCommand', 'noveltyModel',
  'executorCatalog', 'executorStatus',
  'otherStages', 'stageOpinions',
];

{
  const props = mod.__test.propsFromSchema(REAL_SCHEMA);
  ok(!!props && !('properties' in REAL_SCHEMA), 'fixture 为真实 { uid, refs } 形状');
  const desc = { ns: 'research-dispatch', revision: 7, user: {}, value: {}, schema: REAL_SCHEMA };
  const fields = mod.__test.fieldsOf(desc);
  ok(fields.length === 15 && fields.map((f) => f.key).join(',') === ALL_KEYS.join(','),
    '真实形状下 15 个字段完整列出且顺序一致（实际 ' + fields.length + ' 个）');
  ok(/schema\.refs/.test(globalThis.window.__researchDispatch.fieldSource || ''), '字段来自 schema.refs');
}

{
  const noSchema = { ns: 'research-dispatch', value: { reviewVotes: 'codex:gpt-5' } };
  const f2 = mod.__test.fieldsOf(noSchema);
  ok(f2.length === 15, 'schema 缺失时合并完整 15 个已知字段（实际 ' + f2.length + ' 个）');
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
  divergeCommand: '',
  divergeModel: '',
  divergeCount: '',
  divergeUseDeadEnds: '',
  reviewVotes: '',
  noveltyCommand: '',
  noveltyModel: '',
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
  ok(!page.texts.some((t) => ['repoRoot', 'seatsFile', 'scoutCommand', 'divergeCommand', 'divergeCount', 'divergeUseDeadEnds', 'noveltyCommand', 'executorCatalog', 'executorStatus', 'otherStages', 'stageOpinions'].includes(t)),
    '所有配置内部键名均由专用白话控件接管，不裸露在页面上');
  ok(page.texts.filter((t) => t === '高级项').length === 0, '无未知字段时不渲染「高级项」');
  ok(!/undefined/.test(page.texts.join(' ')), '无 undefined 泄漏');

  // 所有下拉框均不含 subagent、api 或旧版 gemini（默认无旧残留时），且带友好工具标签与未安装提示
  const anySubagent = page.selects.some((p) => optsOf(p).some((o) => o.value === 'subagent'));
  const anyApi = page.selects.some((p) => optsOf(p).some((o) => o.value === 'api'));
  const anyLegacyGemini = page.selects.some((p) => optsOf(p).some((o) => o.value === 'gemini'));
  ok(!anySubagent && !anyApi && !anyLegacyGemini, '所有下拉框默认均不含 api、subagent 与旧版 gemini');
  const scoutSelect = page.selects[0];
  const scoutLabels = optsOf(scoutSelect).map((o) => String([].concat(o.children || []).join('')));
  ok(scoutLabels.some((l) => l.includes('codex · Codex CLI'))
    && scoutLabels.some((l) => l.includes('kimi · Kimi Code'))
    && scoutLabels.some((l) => l.includes('agy · Antigravity（未检测到命令）')),
    '下拉框展示 agy · Antigravity 等友好名称，并对 executorStatus=0 的工具柔和标注「（未检测到命令）」');

  // 工作流项目输入框 + 发散单轮默认条数 + 死胡同过滤开关交互并保存
  const pathInput = page.inputs.find((p) => String(p.className || '').includes('rdp-in-path'));
  const numInput = page.inputs.find((p) => String(p.className || '').includes('rdp-in-num'));
  const deadEndsSelect = page.selects.find((p) => String(p.className || '').includes('rdp-in-mode'));
  ok(!!pathInput && pathInput.value === '/workspace/demo-project', '工作流项目展示 repoRoot 输入框');
  ok(!!numInput && numInput.value === '10' && numInput.max === 50,
    '想法发散内联展示单轮默认条数（空串回退展示 10，上限 max=50）');
  ok(!!deadEndsSelect && deadEndsSelect.value === 'true', '想法发散内联展示历史死胡同过滤选择（空串回退展示 true）');

  pathInput.onChange({ target: { value: '/workspace/new-topic' } });
  scoutSelect.onChange({ target: { value: 'kimi' } });
  numInput.onChange({ target: { value: '45' } });
  deadEndsSelect.onChange({ target: { value: 'false' } });
  let editedPage = render();
  // 同时设置前置查重为 agy
  const noveltySelect = editedPage.selects[editedPage.selects.length - 1];
  noveltySelect.onChange({ target: { value: 'agy' } });
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

  // 超上限 >50 自动钳制到 50，且在默认空串下显式保存 10/true 仍可写穿提交
  const pClamp = render();
  const numClamp = pClamp.inputs.find((p) => String(p.className || '').includes('rdp-in-num'));
  const deadClamp = pClamp.selects.find((p) => String(p.className || '').includes('rdp-in-mode'));
  numClamp.onChange({ target: { value: '99' } });
  deadClamp.onChange({ target: { value: 'true' } });
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
  const pApi = await settle(render());
  const scoutOpts = optsOf(pApi.selects[0]).map((o) => ({ value: o.value, label: String([].concat(o.children || []).join('')) }));
  const divergeOpts = optsOf(pApi.selects[1]).map((o) => o.value);
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
    ok(!!liveSnap && liveSnap.version === '2.1.2' && liveSnap.catalog.includes('agy:'),
      'v2.1.2：fetchBridgeSnapshot 走实时桥拉回最新本机五类 CLI（含 agy）模型目录');

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

  if (prevDiag === undefined) delete process.env.RESEARCH_DISPATCH_DIAG; else process.env.RESEARCH_DISPATCH_DIAG = prevDiag;
  if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + (fail.length ? '失守 ' + fail.length + ' 条' : '全部 ' + ops + ' 条断言通过'));
process.exitCode = fail.length === 0 ? 0 : 1;
