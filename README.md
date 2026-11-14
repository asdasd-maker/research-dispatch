# research-dispatch

**Universal Pure-Node AI Research Workflow Engine (`v2.1.0`)**
*Literature Scout (LaTeX/Markdown-First) → Baseline Repro Gate → Dual-Mode Divergence → Out-of-Repo Multi-Agent Blind Review & Ranked 5D Summary → Pre-Contract Novelty & Paired `2σ` Pilot Stats → Human Verdict → Frozen Experiment Contract.*

普适纯 Node 科研流程引擎：把「文献调研成池（优先抓取 arXiv LaTeX/Markdown 免 PDF 乱序）→ 基线复现签字 → 双模式候选发散（默认 10 条，支持挂载死胡同记忆或纯空白零锚定模式）→ 仓外物理隔离的多 Agent 盲审与五维 `/25` 自动 Ranking 总表 → 单工单隔离前置查重与 ≤2h Pilot 配对统计探针 → 人类唯一裁决 → 实验与消融契约哈希冻结」做成一套**零外部脚本依赖、跨主流 AI 编程宿主开箱即用**的确定性流水线。

> **English Overview**: `research-dispatch` v2.1.0 is a host-agnostic, zero-Bash / zero-Python Node.js (`>=20`) research workflow engine. Run `npx research-dispatch init` inside any repository to scaffold `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`), `skills/research-flow/SKILL.md`, and `dispatch/seats.json`—ready immediately for **Antigravity**, **Claude Code**, **Codex CLI**, **Cursor / Cline / Windsurf**, **Kimi Code**, **Gemini CLI**, and **DeepSeek Harness (DSH)**. External CLI workers across all 4 AI stages (`scout`, `diverge`, `review`, `novelty`) execute inside ephemeral `os.tmpdir()` sandboxes outside your `.git` tree so root `AGENTS.md` / `CLAUDE.md` and sibling briefs never leak into worker prompts.

---

## 核心特性（v2.1.0）

- **四大 AI 阶段全流程独立编排（`scout` / `diverge` / `review` / `novelty`）**：
  - **S0 文献调研（`scout`）**：自动读取 `roles/scout.md`、注入已有文献去重清单、要求优先提取 arXiv LaTeX/HTML/Markdown 源码信息，自动切分多卡、逐张执行 `check-paper`（坏卡隔离至 `rejected/`），支持 `--pool` 一键刷新 `papers/cards/_pool.md`。
  - **S2 想法发散（`diverge`）**：支持在 `dispatch/seats.json` 或设置面板持久化默认单轮条数（`count`，默认 `10`）与死胡同过滤开关（`use_dead_ends: true|false`），既可常规挂载 `<=60` 行 `dead-ends.md` 防重复踩坑，也可切换 `--no-dead-ends` 纯空白零历史锚定模式。
  - **S4 多票隔离盲审（`review`）**：支持同一 CLI 排多票对比不同模型（如 `codex:gpt-5,codex:o3` → `codex1.md` + `codex2.md`）与跨工具自由组合；默认 `require_unique_models: false` 在 `.manifest` 如实记录 `shared_models` 留痕而不强行毁票；`summary` 按五维正向总均分（`/25`）自动降序 Ranking。
  - **S4.5 前置查重（`novelty`）**：按工单路径或工单 ID 单单推式隔离派工外部查新（仅可见 `roles/novelty.md` + 当前唯一 `brief` + `_pool.md`，零同批工单串味），落盘 `papers/novelty/<id>.md` 并自动运行 `check-novelty` 校验闸门。
- **五大 CLI 执行者 + 零子进程深度模型自动发现**：
  - 原生支持 **`codex`（Codex CLI）**、**`claude`（Claude Code）**、**`dsh`（DeepSeek Harness）**、**`gemini`（Gemini CLI）**、**`kimi`（Kimi Code，`--output-format text`）** 五大真实 CLI 工具（底层仍兼容编程式 `api` / `delivery` 座位）。
  - 毫秒级本地静态扫描（零子进程开销、零密钥值读取）：自动聚合 `~/.codex/{config.toml,models_cache.json,cc-switch-model-catalog.json}`、`~/.claude/settings.json`（含 `ANTHROPIC_*MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL` / `availableModels`）、`~/.dsh/{settings.yaml,storages/*catalog*.json}` 与 `cordis.patch.yml` 模型 ID、`~/.gemini/settings.json` 与已安装 `@google/gemini-cli` 包内模型常量、`~/.kimi/config.toml`（顶层与 `[models.*]` 节）。
- **仓外临时目录物理隔离（`os.tmpdir()`）**：全部外部 CLI 子进程默认在系统临时目录（项目 `.git` 树之外）启动，向上遍历父目录永远读不到项目根 `AGENTS.md` 或 `CLAUDE.md`。
- **DSH 全流程五分区面板 + 保存即写穿同步（Write-Through）**：
  - DSH 桌面端设置页按科研闭环排布「`工作流项目` → `文献调研` → `想法发散` → `多票评审` → `前置查重`」五大分区，剔除令人困惑的 `api` 界面项并换入 `kimi · Kimi Code`。
  - **`ModelPicker` 零死锁交互**：弹层常驻顶部搜索兼自定义模型输入框（即使探测模型数为 `0` 也常驻），支持一键切回 `默认（使用该工具自身默认模型）`，输入任意新模型名回车即可直接选用 `使用自定义模型：<名称>`。
  - **面板保存自动写穿 `dispatch/seats.json`**：点击底部「保存」时，宿主通过 `syncPanelLineupToSeats`（监听 `loader/volatile-update`）自动将四阶段阵容同步写回所选项目的 `dispatch/seats.json` `lineup`（绝不触碰手写 `seats[i].model_override`），桌面端与外部终端实时共享生效。

---

## 安装

```bash
# 方式 A：在科研项目内作为开发依赖安装（推荐）
npm i -D git+https://github.com/asdasd-maker/research-dispatch.git

# 方式 B：从 GitHub Release 离线归档安装
npm i -D ./research-dispatch-2.1.0.tgz

# 方式 C：克隆仓库后全局 link（多课题共用）
git clone https://github.com/asdasd-maker/research-dispatch.git
cd research-dispatch && npm link
```

---

## 主流宿主一键接入指南（`npx research-dispatch init`）

进入任意空目录或现有科研代码仓，一行命令完成全套工作流骨架初始化（已有同名文件默认保留不覆盖，传 `--force` 强制更新模板）：

```bash
npx research-dispatch init --topic my-topic
```

`init` 会自动生成跨宿主统一入口与标准模板：
- `AGENTS.md`：主控会话完整科研规程、七步确定性命令速查与四条硬约束；
- `CLAUDE.md`：单行 `@AGENTS.md` 引用桥接（让 Claude Code 与其它遵循 `AGENTS.md` 的宿主零分叉共享同一份规范）；
- `skills/research-flow/SKILL.md`：交互式向导技能（「开始科研 / 继续科研」）；
- `dispatch/seats.json`：单一真源座位与四阶段阵容配置（`scout` / `diverge` / `review` / `novelty`）；
- `roles/{scout,diverger,reviewer,novelty}.md`：四个阶段的独立角色提示词；
- `papers/novelty/`、`baselines/TEMPLATE.{REPRO,BRIEF_BLOCK}.md`、`contract/{TEMPLATE,CHANGELOG}.md`、`ideas/my-topic/dead-ends.md`。

| 宿主环境 | 接入方式与体验 |
| --- | --- |
| **Antigravity（反重力）** | 打开项目即自动识别根 `AGENTS.md` 与 `skills/research-flow/SKILL.md`。直接对 Agent 说「开始科研」或按步骤调用 `npx research-dispatch <子命令>`。 |
| **Claude Code** | 启动自动加载根 `CLAUDE.md`（`@AGENTS.md`）与 `skills/`；当流水线后台调用 `claude -p` 跑调研/发散/盲审/查重时，子进程运行在 `os.tmpdir()` 仓外空目录，不会递归读取项目根 `CLAUDE.md`。 |
| **Codex CLI / Kimi Code / Gemini CLI** | 自动读取根 `AGENTS.md` 担任主控编排；后台派工调用物理脱离 `.git` 树，保证每张工单零先验泄露。 |
| **Cursor / Cline / Windsurf** | 主会话遵循根 `AGENTS.md` 规程，通过内置终端执行 `npx research-dispatch` 全套纯 Node 闸门（Windows PowerShell / macOS / Linux 原生直跑）。 |
| **DeepSeek Harness (DSH)** | 执行 `dsh plugin --profile desktop add "link:/abs/path/to/research-dispatch"` 并重启桌面端，额外获得左栏「科研派工 · 全流程阵容」五分区设置面板（保存自动写穿 `dispatch/seats.json`）与内置 `research_dispatch` 向导工具。 |

---

## 四阶段多 Agent 与模型编排（`agents` & `lineup`）

### 1. 深度扫描本机可用 Agent 与模型目录

```bash
npx research-dispatch agents
# 或输出机器可读 JSON（含四阶段生效阵容与候选模型列表）：
npx research-dispatch agents --json
```

### 2. 一行命令编排四阶段阵容与发散策略

```bash
# 独立指定文献调研(scout)、想法发散(diverge + 默认条数与死胡同开关)、多票盲审(review)与前置查重(novelty)：
npx research-dispatch lineup \
  --scout gemini:gemini-2.5-pro \
  --diverge gemini:gemini-2.5-pro \
  --diverge-count 10 \
  --use-dead-ends \
  --review codex:gpt-5,claude:claude-sonnet-4-5,kimi:kimi-k2.5 \
  --novelty claude:claude-sonnet-4-5

# 切换默认发散策略为纯空白零历史锚定模式（默认不挂载 dead-ends.md）：
npx research-dispatch lineup --diverge-count 8 --no-dead-ends

# 查看当前四阶段生效阵容：
npx research-dispatch lineup

# 清空自定义 lineup，恢复 default_backends 默认阵容：
npx research-dispatch lineup --reset
```

上述命令原子更新项目内 `dispatch/seats.json` 的四阶段 `lineup` 结构（若引用了 `gemini` 或 `kimi` 且座位表尚未声明，会自动补入内置 CLI 座位定义）：

```json
{
  "version": 2,
  "policy": {
    "require_unique_models": false
  },
  "lineup": {
    "scout": { "seat": "gemini", "model": "gemini-2.5-pro" },
    "diverge": {
      "seat": "gemini",
      "model": "gemini-2.5-pro",
      "count": 10,
      "use_dead_ends": true
    },
    "review": [
      { "seat": "codex", "model": "gpt-5" },
      { "seat": "claude", "model": "claude-sonnet-4-5" },
      { "seat": "kimi", "model": "kimi-k2.5" }
    ],
    "novelty": { "seat": "claude", "model": "claude-sonnet-4-5" }
  }
}
```

- **配置优先级**：
  `单次 CLI 参数 / 环境变量（BACKENDS / --agent / SCOUT_AGENT / DIVERGE_AGENT / NOVELTY_AGENT）` > `（DSH 宿主内）设置面板实时值（保存时同步写穿 seats.json）` > `dispatch/seats.json 的 lineup` > `dispatch/seats.json 的 default_backends`。

---

## 全链路七步纯 Node 科研流水线速查

```text
S0 文献调研成池：优先取 arXiv LaTeX / HTML / Markdown，自动去重切卡入池 (scout / check-paper / pool)
 ↓
S1 基线复现与锚点签字 (repro-watch / SIGNOFF: PASS)
 ↓
S2 双模式候选发散：继承 lineup 默认条数(10)与死胡同策略，或传 --no-dead-ends 纯空白发散 (diverge)
 ↓
S3 按课题拆出自包含盲审工单 (briefs → ideas/<topic>/briefs/)
 ↓
S4 自由多 Agent 隔离评审 + 五维正向(/25)自动降序 Ranking 总表 (plan → run → summary & status)
 ↓
S4.5 单单隔离前置查重 + ≤2h Pilot 配对 2σ 统计探针 (novelty / check-novelty + pilot-stats)
 ↓
S5 人类唯一裁决 (ideas/<topic>/verdict-<id>.md)
 ↓
S6 实验与消融契约哈希冻结 (check-contract --record)
```

### 常用命令全表

```bash
# S0：派工 Agent 检索文献并自动切分校验落卡（加 --pool 顺手拼出 papers/cards/_pool.md；先 --dry 预演）
npx research-dispatch scout "可验证奖励下推理长度自适应惩罚" 5 --pool --dry
npx research-dispatch scout "可验证奖励下推理长度自适应惩罚" 5 --pool
# 手写或外部导入单卡时也可单独校验与拼池：
npx research-dispatch check-paper papers/cards/smith2025.md
npx research-dispatch pool --cards papers/cards --out papers/cards/_pool.md

# S1：监控基线复现实验心跳与数据哈希（配置 baselines/<name>/REPRO.md 并签 SIGNOFF: PASS）
npx research-dispatch repro-watch baselines/qwen-math --log baselines/qwen-math/train.log

# S2（常规模式）：省略条数时自动继承 lineup.diverge.count（默认 10 条），挂载 ≤60 行 dead-ends.md
npx research-dispatch diverge "推理长度自适应惩罚" \
  --topic length-penalty \
  --baseline baselines/qwen-math

# S2（纯空白模式）：传 --no-dead-ends 跳过 dead-ends.md，上下文仅含文献池与基线，零历史讨论/否决锚定
npx research-dispatch diverge "推理长度自适应惩罚" \
  --topic length-penalty \
  --baseline baselines/qwen-math \
  --no-dead-ends

# S3：校验溯源指纹与自包含性（拦截跨条引用其它 idea_XX），拆分为独立盲审工单
npx research-dispatch briefs ideas/length-penalty/raw-20261114-120000.md \
  --topic length-penalty \
  --baseline baselines/qwen-math

# S4：免费预演计划 → 正式多 Agent 盲审落卡（五维 1-5 正向计分）→ 生成五维 /25 均分与自动降序 Ranking 总表 _summary.md
npx research-dispatch plan ideas/length-penalty/briefs/idea_01.md
npx research-dispatch run  ideas/length-penalty/briefs/idea_01.md
npx research-dispatch summary --topic length-penalty                 # 默认 --sort rank（按 go/kill/revise 票型与 /25 均分降序排 #1, #2...）
npx research-dispatch summary --topic length-penalty --sort id       # 按工单编号自然序排列
npx research-dispatch status  --topic length-penalty

# S4.5：对入围候选执行单单推式隔离前置查重（自动落盘 papers/novelty/idea_01.md 并运行 check-novelty）+ Pilot 配对统计
npx research-dispatch novelty idea_01 --topic length-penalty --dry
npx research-dispatch novelty idea_01 --topic length-penalty
npx research-dispatch check-novelty papers/novelty/idea_01.md
npx research-dispatch pilot-stats pilot/base.jsonl pilot/treatment.jsonl --compliant-field format_ok

# S5 & S6：人工写入 ideas/<topic>/verdict-idea_01.md（决定: go）后，校验并哈希冻结正式实验与消融契约
npx research-dispatch check-contract contract/exp01.md --record
npx research-dispatch check-contract contract/exp01.md --re-record --reason "修正验证集采样随机种子说明"
```

### 退出码契约

| 退出码 | 含义 |
| --- | --- |
| `0` | 校验/派工正常通过（`status` 无待办旧账） |
| `1` | 卡片/报告/契约内容不合规，或派工 `PARTIAL` 部分座位降级，或 `status` 存在待人工裁决/未派工工单 |
| `2` | 基础设施或配置/输入文件缺失（一票未出；或显式开启 `require_unique_models: true` 时预检撞同模型） |
| `3` | 显式开启 `require_unique_models: true` 时实跑多票塌缩为同一模型，或外部校验器故障导致整轮 `VOID` |
| `8` | 工单未通过前置基线/锚点闸门（缺少带数值的 `### Baseline` 或基线 `REPRO.md` 未签 `SIGNOFF: PASS`） |

---

## DeepSeek Harness (DSH) 插件能力说明

当通过 `dsh plugin --profile desktop add "link:/abs/path/to/research-dispatch"` 挂载进 DSH 时：
1. **「科研派工 · 全流程阵容」五分区设置面板（`lib/client.js` → `settings.section`）**：
   - 按科研闭环依次提供 **`工作流项目`**（项目路径）、**`文献调研`**（S0）、**`想法发散`**（S2：执行工具、模型、单轮默认条数 `1–50`、历史死胡同过滤开关）、**`多票评审`**（S4：自由增删票与同工具多票）与 **`前置查重`**（S4.5）。
   - 执行工具精选五大真实 CLI（`codex` / `claude` / `dsh` / `gemini` / `kimi`），模型弹层常驻搜索框、支持手输任意自定义模型名回车即选、支持一键恢复工具默认模型。
   - **保存写穿同步**：点击底部「保存」自动通过 `syncPanelLineupToSeats` 将四阶段阵容写回项目 `dispatch/seats.json` `lineup`，桌面端与命令行无缝共享。
2. **向导工具 `research_dispatch`（`lib/flow-tools.mjs`）**：暴露 `classify`、`agents`、`status`、`summary`、`preview`、`state_get`、`state_set` 七类零花钱动作（自动附带四阶段 `lineup` 与 `stages` 快照）。
3. **交互式技能 `research-flow`（`skills/research-flow/SKILL.md`）**：按确定性问序引导全流程，真实调用模型计费前必先 `--dry` / `preview` 免费预演并等待人工确认。

---

## 编程式导出入口（Subpath Exports）

| 导入路径 | 对应模块 | 核心导出能力 |
| --- | --- | --- |
| `research-dispatch` | `./lib/index.js` | DSH 宿主入口（`Config`、`apply`、`executorCatalog`、`executorStatus`、`plainValue`） |
| `research-dispatch/run` | `./lib/run.mjs` | `run`（多票盲审）、`runDiverge`（候选发散）、`runScout`（文献调研）、`runNovelty`（前置查重）、`splitScoutOutputCards` |
| `research-dispatch/workflow` | `./lib/workflow.mjs` | `initProject`、`checkPaperCard`、`assemblePaperPool`、`makeBriefs`、`checkNoveltyReport`、`checkContractFile`、`watchRepro` |
| `research-dispatch/pilot-stats` | `./lib/pilot-stats.mjs` | `computePairedStats`、`formatPairedStatsReport`（配对 Bootstrap、`2σ MDE` 与合规子集分析） |
| `research-dispatch/validators` | `./lib/validators.mjs` | `checkAnchor`、`extractCardVerdict`、`checkCardFile`、`scanPendingVerdicts`、`summarizeTopic`、`maskSecrets`、`apiChatCompletion` |
| `research-dispatch/models` | `./lib/models.mjs` | 零子进程深度模型探测（`probeAgentModelsFromConfigs`、`scanGeminiCliPackageModels`）、模型归一化、家族归属与署名核验 |
| `research-dispatch/bin` | `./bin/dispatch.mjs` | CLI 主入口 |
| `research-dispatch/client` | `./lib/client.js` | DSH Web 五分区全流程设置面板客户端 bundle |

---

## 目录结构与离线自检

```text
bin/dispatch.mjs              全链路 CLI 入口（init / agents / lineup / scout / pool / diverge / briefs / run / summary / novelty / pilot-stats / check-contract …）
lib/index.js                  DSH 插件宿主外壳（统一深度模型目录 + 面板保存写穿 syncPanelLineupToSeats）
lib/client.js                 DSH 五分区全流程设置面板 bundle（五大 CLI 工具 + 常驻搜索与自定义模型输入）
lib/workflow.mjs              上下游纯 Node 确定性闸门与跨宿主 initProject 脚手架
lib/pilot-stats.mjs           Pilot 探针配对统计检验与合规子集偏差分析
lib/validators.mjs            锚点校验、YAML 卡片校验、待裁决扫描、五维 /25 自动 Ranking 总表 _summary.md 与内置 API 调用
lib/run.mjs                   仓外 os.tmpdir() 隔离的四阶段执行引擎（scout / diverge / review / novelty）
lib/registry.mjs              单一真源座位表加载、四阶段阵容解析（resolveStagePlan）、lineup 原子更新与面板写穿同步
lib/models.mjs                五大 CLI 零子进程深度模型探测、模型身份回读与签名核验
lib/flow-tools.mjs            research_dispatch 向导工具实现（含四阶段快照暴露）
lib/settings-file.mjs         DSH cordis.patch.yml 作用域受控读取
examples/                     内置 AGENTS.md / CLAUDE.md / seats.example.json / 四大角色与实验契约标准模板
skills/research-flow/         跨宿主通用科研流程向导技能（v2.1.0）
docs/CARD-STYLE.md            五分区设置卡片视觉与文案规范
cordis.patch.yml              DSH 插件装配声明
test/                         全离线五套自检套件与静态预览生成器（零联网、不依赖真实付费密钥）
```

在源码仓库根目录运行全套离线自检（`flow` / `client` / `run` / `standalone` / `workflow` 五套自检套件）：

```bash
npm test
node test/preview.mjs   # 重新生成 test/preview.html
```

## License

MIT
