// DSH 插件外壳：把"座位表"暴露成一个可读写的设置命名空间，并在装配时校验它。
//
// 这一层**不做分派**：分派逻辑在 lib/run.mjs，入口是 bin/dispatch.mjs。插件外壳的职责只有两件：
//   ① 让配置可被发现、可被编辑（settings 面板 / settings.yaml 都能写），
//   ② 装配时就把座位表读一遍 —— 配置坏了要在这里喊出来，而不是等第一轮评审开跑才炸。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

// schemastery 必须真的解析到，设置面板才会按 Config 自动渲染表单。
// 但它是 profile 侧的依赖：插件被 link: 进 profile 后，Node 是按**真实路径**
// (E:\项目\plugin\research-dispatch) 往上找 node_modules 的，那里没有它。
// 硬 import 会在挂载时抛 ERR_MODULE_NOT_FOUND —— 一个插件顺手把 host 拖崩是最坏的结果。
// 所以：先按标准解析；失败就沿已知的 profile 目录找；都找不到就用最小垫片，
// 此时插件照常装配（apply 能用、CLI 不受影响），只是设置页那张卡片不会出现。
function schemaShim() {
  const field = () => {
    const self = {
      description: () => self, default: () => self, extra: () => self,
      required: () => self, hidden: () => self, note: () => self,
      pattern: () => self,
    };
    return self;
  };
  const object = (shape) => {
    const schema = (value) => ({ ...(value || {}) });
    schema.dict = shape;
    schema.description = () => schema;
    schema.extra = () => schema;
    schema.default = () => schema;
    return schema;
  };
  return { object, string: field, number: field, boolean: field, union: field, const: field };
}

async function loadSchema() {
  try {
    return (await import('@deepseek-ai/schemastery')).default;
  } catch { /* 继续找 */ }
  const home = process.env.HOME || os.homedir();
  const cands = [
    path.join(home, '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
    path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs'),
  ];
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return (await import(pathToFileURL(c).href)).default;
    } catch { /* 继续找 */ }
  }
  return schemaShim();
}

const z = await loadSchema();
import { loadConfig, seatIdentity } from './registry.mjs';
import { resolveModel, expandHome, dshLiveModel, homeDir } from './models.mjs';
import { registerFlowTools } from './flow-tools.mjs';

export const name = 'research-dispatch';
// 设置命名空间属于 settings seam：声明依赖让 entry 等 settings 就绪后再 activate。
export const inject = []; // 2026-10-25：原为 ['settings']——两个依赖树里都没有任何包 provide 'settings' 服务，
// entry 因此永远 pending（宿主日志：waiting for service: settingsScope），research_dispatch 工具从不注册。
// 插件正文不消费 settings（configEditor 是设置页 UI 侧按命名空间找 entry，与本插件宿主侧无关），
// 故移除等待：代价只是设置页不再渲染本插件的可编辑卡片，与源码里 schemaShim 的降级注释口径一致。

const here = path.dirname(fileURLToPath(import.meta.url));
// bin → 插件包 → plugin/ → 仓库根：仓库根是插件包的上两级再上一级。
export const PACKAGE_ROOT = path.resolve(here, '..');
// 仓库根解析：npm 安装时包位于 <project>/node_modules/research-dispatch，
// "上两级"指到 node_modules 之外的项目目录——不再是本包 monorepo 的 plugin/../.. 布局。
// 因此候选按「显式配置 > monorepo 布局（当 seats.json 真的在那）> 当前工作目录」依次判定。
export function resolveDefaultRepoRoot() {
  // 顺序：当前工作目录优先。真实使用者是在自己的项目根跑 CLI/npx，
  // 所以 <cwd>/dispatch/seats.json 必须赢过包位置推出的目录；monorepo 布局只作开发期兜底
  // （旧版顺序相反，包被放在任何带 dispatch/seats.json 的兄弟目录下都会被误认成仓库根）。
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'dispatch', 'seats.json'))) return cwd;
  const monorepo = path.resolve(PACKAGE_ROOT, '..', '..');
  if (fs.existsSync(path.join(monorepo, 'dispatch', 'seats.json'))) return monorepo;
  return cwd;
}
export const DEFAULT_REPO_ROOT = resolveDefaultRepoRoot();

// 字段说明同步写在 README.md 的「配置」一节 —— 两处不一致时以 README 为准并改代码。
// .extra("volatile", true)：字段可热改，改完不需要重挂载插件。这也是设置面板能把它渲染成
// 可编辑卡片的三个必要条件之一（另两个：entry id 与命名空间同名、本文件导出 Config）。
// 执行者目录：宿主侧探测"这台机器上装了哪些执行者、各自当前模型是什么"，
// 编码成不含引号与括号的扁平串塞进 Config default —— 浏览器半读不到文件系统，只能靠这个。
// 格式：codex:gpt-6.1-sol|gpt-6.1-mini;claude:opus;dsh:jiyuan/glm-5.3;kimi:sensenova/kimi-k3;subagent:
// dsh 座的可用模型：从 profile 的设置文档里读 llm provider 声明的模型 id。
// 为什么不用 models.mjs 的 dshLiveModel：那只给"当前生效的一个"，面板要的是"可选的一批"。
function dshModelList() {
  try {
    const home = homeDir();
    const p = String(process.env.DSH_DISPATCH_SETTINGS || "").trim()
      || home + "/.dsh/profiles/" + (process.env.DSH_PROFILE || "desktop") + "/cordis.patch.yml";
    const text = fs.readFileSync(p, "utf8");
    // 只认 providers 下 models 里那些更深的 "- id:"（10 空格以上），
    // 浅层的是 profile entry（web / 插件 id），不是模型名。
    const ids = [...text.matchAll(/^(\s{10,})-\s+id:\s*([A-Za-z0-9._/-]+)\s*(?:#.*)?$/gm)].map((m) => m[2]);
    return [...new Set(ids)].slice(0, 20);
  } catch {
    return [];
  }
}

// DSH 会话默认模型：写在 profile 的 cordis.patch.yml 的 agent-default-model 条目里，
// 不是 ~/.dsh/settings.yaml（这台机器上那个文件根本不存在 —— 这就是 dsh/subagent 一直空着的直接原因）。
function profileAgentModel() {
  try {
    const home = homeDir();
    const p = String(process.env.DSH_DISPATCH_SETTINGS || "").trim()
      || home + "/.dsh/profiles/" + (process.env.DSH_PROFILE || "desktop") + "/cordis.patch.yml";
    const text = fs.readFileSync(p, "utf8");
    const lines = text.split(/\r?\n/);
    // 允许行尾注释：profile 里是 `- id: agent-default-model # magpie`，
    // 旧正则要求"行尾即结束"，于是 profileAgentModel() 恒返回空，面板里 dsh 当前模型排不到最前。
    const at = lines.findIndex((l) => /^-\s+id:\s*agent-default-model\s*(?:#.*)?$/.test(l));
    if (at < 0) return "";
    let provider = "", model = "";
    for (let i = at + 1; i < Math.min(at + 8, lines.length); i++) {
      if (/^-\s/.test(lines[i])) break;
      const m = lines[i].match(/^\s{4}model:\s*(\S+)/); if (m) model = m[1];
      const pr = lines[i].match(/^\s{4}provider:\s*(\S+)/); if (pr) provider = pr[1];
    }
    return model || "";
  } catch {
    return "";
  }
}

// 从本机 DSH 的真实存储里收集"可用模型" —— 不预设供应商、不预设 profile 名。
//   根目录：$DSH_HOME 或 ~/.dsh
//   模型清单：<root>/storages 下**所有** .json（不限于 *-models.json），
//             任何数组里形如 "provider/model" 的 id 都收（catalogModels / models / 自定义键都行）
//   当前生效模型：任意 profile 的 cordis.patch.yml 里 agent-default-model 的 model
// 这样换一台机器、换一个订阅、加一个官方 provider，都不需要改代码。
function dshRoot() {
  return String(process.env.DSH_HOME || "").trim() || (homeDir() + "/.dsh");
}

function collectModelIds(node, out, depth, provPrefix) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === "object") {
        const id = item.id || item.model || item.modelId || item.route;
        if (typeof id === "string") {
          if (id.includes("/")) out.push(id);
          else if (provPrefix) out.push(provPrefix + "/" + id);   // catalog 里是裸名，补上供应商前缀
        }
      }
      collectModelIds(item, out, depth + 1, provPrefix);
    }
    return;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node)) collectModelIds(v, out, depth + 1, provPrefix);
  }
}

function dshCatalogModels() {
  const out = [];
  const dir = dshRoot() + "/storages";
  // 同一个供应商会拆成多个文件（xxx-models / xxx-catalog / xxx-prod-catalog）。
  // 开关只写在其中一个里，所以先按前缀汇总"这个供应商有没有被关掉"。
  const offPrefix = new Set();
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8"));
        if (!j) continue;
        const prefix = (f.match(/^[a-z0-9]+(?:-[a-z0-9]+)*?(?=-(?:models|catalog|prod-catalog|intl-catalog|[a-z]*-catalog)\.json$)/i) || [f.replace(/\.json$/, "")])[0];
        // 只信模型清单类文件里的开关：usage/checkin/pool 这些文件的 enabled 语义不同，
        // 拿它们判断会把"其实开着"的供应商误关掉（实测 WorkBuddy 就是这样被误伤）。
        if (!/(models|catalog)/i.test(f)) continue;
        if (j.enabled === false || j.disabled === true) offPrefix.add(prefix);
      } catch { /* 单文件坏掉不影响 */ }
    }
  } catch { /* 没有目录 */ }
  try {
    for (const f of fs.readdirSync(dir)) {
      // 只读"像模型清单"的文件：文件名带 models 或 catalog。仍然与供应商无关，
      // 换机器只要 provider 按这个惯例落盘就自动收进来；其余 json（会话缓存、偏好）跳过。
      if (!f.endsWith(".json") || !/(models|catalog)/i.test(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8"));
        if (!j) continue;
        if (j.enabled === false || j.disabled === true) continue;
        const prefix = (f.match(/^[a-z0-9]+(?:-[a-z0-9]+)*?(?=-(?:models|catalog|prod-catalog|intl-catalog|[a-z]*-catalog)\.json$)/i) || [f.replace(/\.json$/, "")])[0];
        if (offPrefix.has(prefix)) continue;   // 该供应商在订阅服务页被关掉 → 它的 catalog 也跳过
        const before = out.length;
        // 供应商前缀：由文件名推断（cline-pass-models → cline-pass；workbuddy-intl-catalog → workbuddy）。
        // 只用于**没有** provider 前缀的 catalog 条目；带前缀的原样保留。
        const stem = f.replace(/\.json$/, "")
          .replace(/-(models|prod-catalog|intl-catalog|cn-catalog|global-catalog|[a-z]*-catalog)$/, "")
          .replace(/-(intl|prod|cn|global)$/, "");
        collectModelIds(j, out, 0, stem);
        // enabledModelIds 非空 = 该供应商只启用其中几个（订阅服务页显示"4/24 可用"），
        // hiddenModels = 明确隐藏的。两条都得照做，否则下拉里会出现用户看不到的模型。
        const picked = out.slice(before);
        if (Array.isArray(j.enabledModelIds) && j.enabledModelIds.length > 0) {
          const allow = new Set(j.enabledModelIds.map(String));
          for (let i = out.length - 1; i >= before; i--) if (!allow.has(out[i])) out.splice(i, 1);
        }
        if (Array.isArray(j.hiddenModels) && j.hiddenModels.length > 0) {
          const deny = new Set(j.hiddenModels.map(String));
          for (let i = out.length - 1; i >= before; i--) if (deny.has(out[i])) out.splice(i, 1);
        }
      } catch { /* 单个文件坏掉不影响其它 */ }
    }
  } catch { /* 没有 storages 目录 */ }
  return [...new Set(out)];
}

function executorCatalog() {
  const out = [];
  const push = (id, models) => out.push(id + ":" + models.filter(Boolean).join("|"));
  try {
    const codex = resolveModel(process.env.CODEX_MODEL || "", expandHome(process.env.CODEX_CFG || "~/.codex/config.toml"), '^model = "[^"]*"', 2);
    push("codex", [codex.replace(/-from-config$|-explicit$/, "")]);
  } catch { push("codex", []); }
  try {
    const claude = resolveModel(process.env.CLAUDE_MODEL || "", expandHome(process.env.CLAUDE_CFG || "~/.claude/settings.json"), '"(ANTHROPIC_MODEL|model)": *"[^"]*"', 4);
    push("claude", [claude.replace(/-from-config$|-explicit$/, "")]);
  } catch { push("claude", []); }
  const agentModel = profileAgentModel();
  // dsh / subagent 都走 DSH 的模型路由：清单 = storages 里的全部可用模型（当前生效的排最前）
  const all = dshCatalogModels().filter((x) => x !== agentModel);
  const dshList = agentModel ? [agentModel, ...all] : all;
  try { push("dsh", dshList.length ? dshList : [dshLiveModel()]); } catch { push("dsh", dshList); }
  push("kimi", [String(process.env.KIMI_MODEL || "").trim() || "sensenova/kimi-k3"]);
  // subagent 不是一个 CLI：它用的就是 DSH 会话模型（agent-default-model），所以清单同源。
  push("subagent", dshList);
  return out.join(";");
}

export const Config = z.object({
  repoRoot: z.string()
    .description("工作流仓库根（含 dispatch/ 与 ideas/）。默认由插件包位置推出")
    .default(DEFAULT_REPO_ROOT)
    .extra("volatile", true),
  // ④ 这不是自由字符串：它会被 path.resolve 后当"写回目标"用，所以必须钉死在仓库内。
  // 相对路径、不带 ..、必须是 .json —— 三条缺一条就可能把 JSON 写到仓库外任意文件上。
  seatsFile: z.string()
    .description("座位表路径，相对仓库根；默认 dispatch/seats.json（派工脚本读的是同一份文件）")
    .default("dispatch/seats.json")
    .pattern(/^(?!.*(?:^|[\\/])\.\.(?:$|[\\/]))(?![/\\]|[A-Za-z]:)(?!.*[\\/]$).+\.json$/,
      "必须是仓库内的相对路径、不含 ..、以 .json 结尾")
    .extra("volatile", true),
  otherStages: z.string()
    .description("只读：调研 / novelty / 实现三个环节的执行者与模型写在哪里（本面板改不了）")
    .default("调研 scout → roles/scout.md（主会话调 subagent）；novelty 复查 → roles/novelty.md；实现与实验 → contract/expNN.md 的实现锚点 + workers")
    .extra("volatile", true),
  stageOpinions: z.string()
    .description("其余环节的选择（主会话据此调度）：scout|novelty|implement 三环，格式 环节:执行者:模型;环节:执行者:模型")
    .default("")
    .extra("volatile", true),
  reviewVotes: z.string()
    .description("评审票（可增删，逗号分隔）：执行者:模型。例 codex:gpt-6.1-sol,claude:opus,dsh:。留空=按座位表的三票")
    .default("")
    .extra("volatile", true),
  executorCatalog: z.string()
    .description("只读：本机可用的执行者及其当前模型（宿主探测，格式 exec:model1|model2;…）")
    .default(executorCatalog())
    .extra("volatile", true),
  divergeCommand: z.string()
    .description("发散环节的执行者命令名（dispatch/diverge.sh 里调用的那个 CLI）。留空=kimi。参数形态仍是 kimi 兼容的 -p")
    .default("")
    .extra("volatile", true),
  divergeModel: z.string()
    .description("发散环节用的模型（dispatch/diverge.sh 的 KIMI_MODEL）。留空=用 divege 默认 sensenova/kimi-k3")
    .default("")
    .extra("volatile", true),
  // 座位**不是**设置字段。逐座的模型与执行方式一律改 dispatch/seats.json 的
  // seats[<id>].model_override / executor_override —— 座位是数据，面板不再持有第二份。
  // （按设计）
});

function diag(msg) {
  const target = process.env.RESEARCH_DISPATCH_DIAG || path.join(os.homedir(), '.dsh', 'research-dispatch-diag.log'); // 2026-10-25：默认也落盘——ctx.logger 的喊话在桌面宿主里无人可见，注册失败曾因此长期不可观测
  if (!target) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, "[" + new Date().toISOString() + "] " + msg + "\n");
  } catch { /* 诊断写不进不影响主流程 */ }
}

// __file 是运行时字段，不许写回磁盘（写进去就成了一个没人认识的键）。
function replacer(key, value) {
  if (key === "__file") return undefined;
  return value;
}

/**
 * 把面板上的值（模型覆盖 + 默认座位）写进座位表 —— 写穿，不是另存一份。
 *
 * 为什么必须写穿：CLI 是 bash 起的独立进程，它读的是 dispatch/seats.json。如果面板的值只
 * 存在 DSH 自己的设置里，就会出现"界面上写着 glm-5.3、实跑还是 gpt-6.1-sol"这种两套事实。
 * 只在值真的变了时写，避免每次挂载都碰用户的文件。
 */
// 面板**不写盘**。它只改 DSH 设置文档，CLI 直接读同一份（lib/settings-file.mjs）。
// 以前那个 syncToSeatsFile 是为了把面板值镜像进 dispatch/seats.json；现在面板不再持有
// 座位配置（座位与"跑哪几座"都由评审票 + 座位表决定），也就没有第二份要同步。
export function apply(ctx, config) {
  const log = (m) => (ctx.logger ? ctx.logger("info", "[research-dispatch] " + m) : console.log("[research-dispatch] " + m));
  // 装配期就喊：配置坏了不该等到第一轮评审开跑才炸。
  const say = ctx.logger ? (m) => ctx.logger("error", "[research-dispatch] " + m) : (m) => console.error("[research-dispatch] " + m);

  // 这里不往 process.env 写任何东西：host 进程是共用的，一个插件顺手改全局环境会在别处
  // 表现出来；而这个插件真正的运行体是独立进程（bash → node），改 host 的 env 对它无效。
  // 仓库根每次现取：repoRoot 本身也是 volatile 字段，面板一改就不能还认挂载时那个值。
  const repoRootNow = () => process.env.DSH_DISPATCH_ROOT || config.repoRoot || DEFAULT_REPO_ROOT;

  // 装配期就读一遍座位表：配置坏了当场喊，不等第一轮评审开跑。
  let cfg;
  try {
    cfg = loadConfig(repoRootNow(), config.seatsFile);
  } catch (e) {
    say(e.message);
    diag("config-error " + e.message);
    return;
  }
  log("座位表 " + cfg.__file + " 已加载：" + cfg.seats.map((s) => s.id).join(" "));
  diag("loaded " + cfg.__file);

  // 桌面向导（P0）：注册 research_dispatch。**双通道**（历史真机教训：
  // 宿主里 ctx.inject(['tools'], cb) 的回调可能永不执行，而 ctx.get('tools') 直取得到）——
  // ① 先直接取服务注册；② 取不到再等注入（服务可能来晚）。注册后能读回就验证一次。
  // fail-closed + 喊话留 diag（R-6 教训），任何失败都不拖崩宿主。
  let flowOff = null;
  const flowRegister = (tools, via) => {
    try {
      flowOff = registerFlowTools({ tools }, { repoRoot: repoRootNow() });
      let seen = null;
      try {
        if (typeof tools.schemas === 'function') {
          const arr = tools.schemas();
          if (Array.isArray(arr)) seen = arr.some((d) => d && d.name === 'research_dispatch');
        }
      } catch { /* 读回失败不阻断注册，只在确定缺失时喊 */ }
      if (seen === false) {
        say('research_dispatch 注册后未出现在工具表读回里——注册可能未生效，请把此日志报给维护者');
        diag('flow-tool-readback-miss via=' + via);
      }
      log('research_dispatch 向导工具已注册（via ' + via + '；classify / status / preview / state）');
      diag('flow-tool-registered via=' + via);
      return true;
    } catch (e2) {
      say('research_dispatch 工具注册失败：' + ((e2 && e2.message) || e2));
      diag('flow-tool-register-error ' + ((e2 && e2.message) || e2));
      return false;
    }
  };
  let flowDone = false;
  try {
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : null;
    if (tools && typeof tools.register === 'function') flowDone = flowRegister(tools, 'direct');
  } catch (e3) { diag('flow-tool-get-error ' + ((e3 && e3.message) || e3)); }
  if (!flowDone && typeof ctx.inject === 'function') {
    // 只做兜底：直取已成功（或已喊出失败原因）就不重复注册。
    ctx.inject(['tools'], (scope) => { if (!flowDone) flowDone = flowRegister(scope && scope.tools, 'inject'); });
  } else if (!flowDone) {
    say('宿主无 tools 通道：research_dispatch 向导工具不可用（技能会显式提示）');
    diag('flow-tool-no-tools-channel');
  }
  if (flowOff && typeof ctx.on === 'function') {
    ctx.on('dispose', () => { try { flowOff(); } catch { /* 已卸载 */ } });
  }
}

export default { name, inject, Config, apply };
