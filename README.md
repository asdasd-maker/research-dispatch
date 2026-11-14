# research-dispatch

**Universal Pure-Node AI Research Workflow Engine (`v2.0.0`)**
*Literature Pool (LaTeX/Markdown-First) → Baseline Repro Gate → Dead-End-Aware or Blank-Slate Divergence → Out-of-Repo Multi-Agent Blind Review & Ranked 5D Summary → Front-Loaded Novelty & Paired `2σ` Pilot Stats → Human Verdict → Frozen Experiment Contract.*

普适纯 Node 科研流程引擎：把「文献成池（优先抓取 arXiv LaTeX/Markdown 免 PDF 乱序）→ 基线复现签字 → 候选发散（默认 10 条，支持挂载死胡同记忆或 `--no-dead-ends` 纯空白模式）→ 仓外物理隔离的多 Agent 盲审与五维 `/25` 自动 Ranking 总表 → 前置查重与 ≤2h Pilot 配对统计探针 → 人类裁决 → 实验与消融契约哈希冻结」做成一套**零外部脚本依赖、跨五大 AI 编程宿主开箱即用**的确定性流水线。

> **English Overview**: `research-dispatch` v2.0.0 is a host-agnostic, zero-Bash/zero-Python Node.js (`>=20`) research workflow engine. Run `npx research-dispatch init` inside any repository to scaffold `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`), `skills/research-flow/SKILL.md`, and `dispatch/seats.json`—ready immediately for **Antigravity**, **Claude Code**, **Codex CLI**, **Cursor / Cline / Windsurf**, and **DeepSeek Harness (DSH)**. External CLI workers execute inside ephemeral `os.tmpdir()` sandboxes outside your `.git` tree so root `AGENTS.md` / `CLAUDE.md` never leak into blind-review or divergence prompts, while giving you full freedom to mix any agents and models (including same-agent multi-vote and shared-model comparisons).

---

## 核心特性（v2.0.0）

- **仓外临时目录物理盲审隔离（`os.tmpdir()`）**：外部 Worker 子进程（`codex` / `claude` / `dsh` / `gemini` / `kimi`）默认在系统临时目录（项目 `.git` 树之外）启动，向上遍历父目录永远读不到项目根 `AGENTS.md` 或 `CLAUDE.md`，彻底根治主控说明污染盲审上下文的顽疾。
- **全自由多 Agent 与模型编排**：
  - **发散与评审全执行器打通**：`diverge` 与 `run` 共用同一套纯 Node 执行底座，任意 `codex`、`claude`、`dsh`、`gemini`、`kimi`、OpenAI 兼容 `api` 或离线代递 `delivery` 均可自由担任发散或评审。
  - **同 Agent 多票 & 跨 Agent 同模型不毁票**：原生支持同一轮排多张同工具不同模型的票（如 `codex:gpt-5,codex:o3` 自动落盘为 `idea_01.codex1.md` 与 `idea_01.codex2.md`）；默认 `policy.require_unique_models: false` 允许不同工具使用同一底层模型做交叉检验，`.manifest` 如实记录 `shared_models`，绝不强行作废真卡（需要严格异构先验门禁时可一键开启 `require_unique_models: true`）。
- **全链路纯 Node 确定性闸门（零 Python / 零 Bash 强依赖）**：内置文献卡片校验与拼池（`check-paper` / `pool`，`roles/scout.md` 强制优先抓取 arXiv LaTeX/HTML/Markdown 源码以规避双栏 PDF 乱序）、基线复现心跳看门狗（`repro-watch`）、双模式候选发散（`diverge` 默认产出 `10` 条，常规挂载 `<=60` 行 `dead-ends.md` 避坑，或传 `--no-dead-ends` 开启零历史干扰的纯空白发散）、强制单单自包含的按课题拆单（`briefs`）、五维正向计分（`1–5` 分/维、满分 `/25`）自动降序 Ranking 横向总表（`summary --sort rank|id`）、前置查重校验（`check-novelty`）、配对 Bootstrap 与合规子集 `2σ MDE` 统计检验（`pilot-stats`），以及跨平台 CRLF 归一化的实验契约冻结链（`check-contract --record`）。
- **`dispatch/seats.json` 单一真源 + DSH 作用域收敛**：在终端或任意外部 IDE 中运行时，严格以项目内 `dispatch/seats.json` 为唯一配置来源，绝不被本机 `~/.dsh` 配置暗中篡改；DSH 设置面板覆盖仅在 DSH 宿主内部生效（`useDshPatch: true`）。

---

## 安装

```bash
# 方式 A：在科研项目内作为开发依赖安装（推荐）
npm i -D git+https://github.com/asdasd-maker/research-dispatch.git

# 方式 B：从 GitHub Release 离线归档安装
npm i -D ./research-dispatch-2.0.0.tgz

# 方式 C：克隆仓库后全局 link（多课题共用）
git clone https://github.com/asdasd-maker/research-dispatch.git
cd research-dispatch && npm link
```

---

## 五大宿主一键接入指南（`npx research-dispatch init`）

进入任意空目录或现有科研代码仓，一行命令完成全套工作流骨架初始化（已有同名文件默认保留不覆盖，传 `--force` 强制更新模板）：

```bash
npx research-dispatch init --topic my-topic
```

`init` 会自动生成跨宿主统一入口与标准模板：
- `AGENTS.md`：主控会话完整科研规程、七步确定性命令速查与四条硬约束；
- `CLAUDE.md`：单行 `@AGENTS.md` 引用桥接（让 Claude Code 与其它遵循 `AGENTS.md` 的宿主零分叉共享同一份规范）；
- `skills/research-flow/SKILL.md`：交互式向导技能（「开始科研 / 继续科研」）；
- `dispatch/seats.json`：单一真源座位与阵容配置；
- `roles/{scout,diverger,reviewer,novelty}.md`：四个阶段的独立角色提示词；
- `baselines/TEMPLATE.{REPRO,BRIEF_BLOCK}.md`、`contract/{TEMPLATE,CHANGELOG}.md`、`ideas/my-topic/dead-ends.md`。

| 宿主环境 | 接入方式与体验 |
| --- | --- |
| **Antigravity（反重力）** | 打开项目即自动识别根 `AGENTS.md` 与 `skills/research-flow/SKILL.md`。直接对 Agent 说「开始科研」或按步骤调用 `npx research-dispatch <子命令>`。 |
| **Claude Code** | 启动自动加载根 `CLAUDE.md`（`@AGENTS.md`）与 `skills/`；当流水线后台调用 `claude -p` 跑发散或盲审时，子进程运行在 `os.tmpdir()` 仓外空目录，不会递归读取项目根 `CLAUDE.md`。 |
| **Codex CLI** | 自动读取根 `AGENTS.md` 担任主控编排；后台盲审调用的 `codex exec -C <tmpdir>` 物理脱离 `.git` 树，保证每张工单零先验泄露。 |
| **Cursor / Cline / Windsurf** | 主会话遵循根 `AGENTS.md` 规程，通过内置终端执行 `npx research-dispatch` 全套纯 Node 闸门（Windows PowerShell / macOS / Linux 原生直跑）。 |
| **DeepSeek Harness (DSH)** | 执行 `dsh plugin --profile desktop add "link:/abs/path/to/research-dispatch"` 并重启桌面端，额外获得左栏「科研派工」图形设置面板（`评审` + `发散`）与内置 `research_dispatch` 向导工具。 |

---

## 自由多 Agent 与模型编排（`agents` & `lineup`）

### 1. 自动扫描本机可用 Agent 与模型

```bash
npx research-dispatch agents
# 或输出机器可读 JSON：
npx research-dispatch agents --json
```

自动探测本机 `PATH` 中的 `codex`、`claude`、`dsh`、`gemini`、`kimi` 安装状态、本地配置文件（`~/.codex/config.toml` 含 `[profiles.*]`、`~/.claude/settings.json`、`~/.dsh/storages/*.json`、`~/.gemini/settings.json`）及常见 OpenAI 兼容 API 环境变量。

### 2. 一行命令自由编排发散与评审阵容

```bash
# 同 Agent 多票（gpt-5 与 o3 同场盲审）+ 跨 Agent 组合 + 指定 claude 跑发散：
npx research-dispatch lineup \
  --review codex:gpt-5,codex:o3,claude:claude-sonnet-4-5,gemini:gemini-2.5-pro \
  --diverge claude:claude-sonnet-4-5

# 查看当前生效阵容：
npx research-dispatch lineup

# 清空自定义 lineup，恢复 default_backends 默认阵容：
npx research-dispatch lineup --reset
```

上述命令原子更新项目内 `dispatch/seats.json` 的 `lineup` 字段：

```json
{
  "version": 2,
  "policy": {
    "require_unique_models": false
  },
  "lineup": {
    "diverge": { "seat": "claude", "model": "claude-sonnet-4-5" },
    "review": [
      { "seat": "codex", "model": "gpt-5" },
      { "seat": "codex", "model": "o3" },
      { "seat": "claude", "model": "claude-sonnet-4-5" },
      { "seat": "gemini", "model": "gemini-2.5-pro" }
    ]
  }
}
```

- **同 Agent 多票防覆盖**：当同一轮评审中某座位出现 `>=2` 次时，引擎自动编号为 `codex1`、`codex2`…，独立注入各自模型参数，分别落盘为 `idea_01.codex1.md`、`idea_01.codex2.md`，绝不串改或互相覆盖。
- **可选异构先验强门禁**：默认 `"require_unique_models": false`（自由组合模型，若多票共享底层模型则在 `.manifest` 中标注 `shared_models: <uniq>/<proven> unique` 供人参考，正常返回 `rc=0`）；若课题需要严格强制「每张票必须来自可证的不同模型先验」，只需在 `dispatch/seats.json` 中设 `"policy": { "require_unique_models": true }`（或单次传 `REQUIRE_UNIQUE_MODELS=1`），即可开启预检同模型拦截（`rc=2`）与实跑塌缩作废隔离（`rc=3`）。
- **配置优先级**：
  `单次 CLI 参数 / 环境变量（BACKENDS / --agent）` > `（仅 DSH 宿主内）DSH 设置面板覆盖` > `dispatch/seats.json 的 lineup` > `dispatch/seats.json 的 default_backends`。

---

## 全链路七步纯 Node 科研流水线速查

```text
S0 文献成池：优先取 arXiv LaTeX / HTML / Markdown，无源码才回退 PDF (check-paper / pool)
 ↓
S1 基线复现与锚点签字 (repro-watch / SIGNOFF: PASS)
 ↓
S2 双模式候选发散：默认 10 条，挂载 dead-ends.md 避坑或 --no-dead-ends 纯空白模式 (diverge)
 ↓
S3 按课题拆出自包含盲审工单 (briefs → ideas/<topic>/briefs/)
 ↓
S4 自由多 Agent 隔离评审 + 五维正向(/25)自动降序 Ranking 总表 (plan → run → summary & status)
 ↓
S4.5 前置新颖度查重 + ≤2h Pilot 配对 2σ 统计探针 (check-novelty + pilot-stats)
 ↓
S5 人类唯一裁决 (ideas/<topic>/verdict-<id>.md)
 ↓
S6 实验与消融契约哈希冻结 (check-contract --record)
```

### 常用命令全表

```bash
# S0：按 roles/scout.md 检索建卡（优先抓 arXiv LaTeX/TeX 源码或 HTML/Markdown，仅无源码时回退 PDF），校验并汇总 _pool.md
npx research-dispatch check-paper papers/cards/smith2025.md
npx research-dispatch pool --cards papers/cards --out papers/cards/_pool.md

# S1：监控基线复现实验心跳与数据哈希（配置 baselines/<name>/REPRO.md 并签 SIGNOFF: PASS）
npx research-dispatch repro-watch baselines/qwen-math --log baselines/qwen-math/train.log

# S2（常规模式）：默认发散 10 条，自动挂载课题内 ≤60 行 dead-ends.md 负知识库避开已证伪死胡同
npx research-dispatch diverge "推理长度自适应惩罚" 10 \
  --topic length-penalty \
  --baseline baselines/qwen-math \
  --pool papers/cards/_pool.md \
  --agent claude:claude-sonnet-4-5

# S2（纯空白模式）：传 --no-dead-ends 跳过 dead-ends.md，上下文仅含文献池与基线，零历史讨论/否决锚定
npx research-dispatch diverge "推理长度自适应惩罚" \
  --topic length-penalty \
  --baseline baselines/qwen-math \
  --no-dead-ends \
  --agent claude:claude-sonnet-4-5

# S3：校验溯源指纹与自包含性（拦截跨条引用其它 idea_XX），拆分为独立盲审工单
npx research-dispatch briefs ideas/length-penalty/raw-20261113-120000.md \
  --topic length-penalty \
  --baseline baselines/qwen-math

# S4：免费预演计划 → 正式多 Agent 盲审落卡（五维 1-5 正向计分）→ 生成五维 /25 均分与自动降序 Ranking 总表 _summary.md
npx research-dispatch plan ideas/length-penalty/briefs/idea_01.md
npx research-dispatch run  ideas/length-penalty/briefs/idea_01.md
npx research-dispatch summary --topic length-penalty                 # 默认 --sort rank（按 go/kill/revise 票型与 /25 均分降序排 #1, #2...）
npx research-dispatch summary --topic length-penalty --sort id       # 按工单编号自然序排列
npx research-dispatch status  --topic length-penalty

# S4.5：对入围候选做前置查重校验 + 运行 ≤2h 最小证伪 Pilot 后计算配对 2σ MDE 与合规子集偏差
npx research-dispatch check-novelty ideas/length-penalty/novelty-idea_01.md
npx research-dispatch pilot-stats pilot/base.jsonl pilot/treatment.jsonl --compliant-field format_ok

# S5 & S6：人工写入 ideas/<topic>/verdict-idea_01.md（决定: go）后，校验并哈希冻结正式实验与消融契约
npx research-dispatch check-contract contract/exp01.md --record
# 若后续确需修订已冻结契约，必须升版文件（如 exp01.v2.md）或显式附带理由重签进 5 列 CHANGELOG.md：
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
1. **「科研派工」设置面板（`lib/client.js` → `settings.section`）**：
   - **评审**：支持 `codex` / `claude` / `dsh` / `gemini` / `api` 自由增删与同工具多票；模型弹层与宿主 `/model` 目录实时同源（供应商胶囊分组 + 不连续字符搜索）；删空最后一票保存 `""` 即恢复 `dispatch/seats.json` 阵容。
   - **发散**：开放 `默认（按配置）` 与 `codex` / `claude` / `dsh` / `gemini` / `api` / `kimi` 全执行者及联动模型选择。
2. **向导工具 `research_dispatch`（`lib/flow-tools.mjs`）**：暴露 `classify`、`agents`、`status`、`summary`、`preview`、`state_get`、`state_set` 七类零花钱动作（支持 `topic` 子课题参数，动态响应路径热更新）。
3. **交互式技能 `research-flow`（`skills/research-flow/SKILL.md`）**：按确定性问序引导全流程，花钱调模型前必先免费预演并停下等待人工确认。

---

## 编程式导出入口（Subpath Exports）

| 导入路径 | 对应模块 | 核心导出能力 |
| --- | --- | --- |
| `research-dispatch` | `./lib/index.js` | DSH 宿主入口（`Config`、`apply`、`executorCatalog`、`plainValue`） |
| `research-dispatch/run` | `./lib/run.mjs` | `run`（多 Agent 盲审派工）、`runDiverge`（多 Agent 候选发散） |
| `research-dispatch/workflow` | `./lib/workflow.mjs` | `initProject`、`checkPaperCard`、`assemblePaperPool`、`makeBriefs`、`checkNoveltyReport`、`checkContractFile`、`watchRepro` |
| `research-dispatch/pilot-stats` | `./lib/pilot-stats.mjs` | `computePairedStats`、`formatPairedStatsReport`（配对 Bootstrap、`2σ MDE` 与合规子集分析） |
| `research-dispatch/validators` | `./lib/validators.mjs` | `checkAnchor`、`extractCardVerdict`、`checkCardFile`、`scanPendingVerdicts`、`summarizeTopic`、`maskSecrets`、`apiChatCompletion` |
| `research-dispatch/models` | `./lib/models.mjs` | 模型名归一化、家族归属、配置回读与署名票校验 |
| `research-dispatch/bin` | `./bin/dispatch.mjs` | CLI 主入口 |
| `research-dispatch/client` | `./lib/client.js` | DSH Web 设置面板客户端 bundle |

---

## 目录结构与离线自检

```text
bin/dispatch.mjs              全链路 CLI 入口（init / agents / lineup / pool / diverge / briefs / run / summary / pilot-stats / check-contract …）
lib/index.js                  DSH 插件宿主外壳（useDshPatch 作用域收敛 + 动态工具生命周期管理）
lib/client.js                 DSH 设置面板客户端 bundle（全自由多 Agent 评审与发散编排）
lib/workflow.mjs              上下游纯 Node 确定性闸门与跨宿主 initProject 脚手架
lib/pilot-stats.mjs           Pilot 探针配对统计检验与合规子集偏差分析
lib/validators.mjs            锚点校验、YAML 卡片校验、待裁决扫描、横向总表 _summary.md 与内置 API 调用
lib/run.mjs                   仓外 os.tmpdir() 隔离的通用多 Agent 发散与盲审执行引擎
lib/registry.mjs              单一真源座位表加载、本机 Agent 自动探测与 lineup 原子更新
lib/models.mjs                模型身份回读、归一化与签名核验
lib/flow-tools.mjs            research_dispatch 向导工具实现
lib/settings-file.mjs         DSH cordis.patch.yml 作用域受控读取
examples/                     内置 AGENTS.md / CLAUDE.md / seats.example.json / 四大角色与实验契约标准模板
skills/research-flow/         跨宿主通用科研流程向导技能
docs/CARD-STYLE.md            设置卡片视觉与文案规范
cordis.patch.yml              DSH 插件装配声明
test/                         全离线五套自检套件（共 215 条断言）与静态预览生成器（零联网、不依赖真实付费密钥）
```

在源码仓库根目录运行全套离线自检（`flow` 32 + `client` 117 + `run` 32 + `standalone` 16 + `workflow` 18 = **215 条断言**）：

```bash
npm test
node test/preview.mjs   # 重新生成 test/preview.html
```

## License

MIT
