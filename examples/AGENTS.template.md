# 科研工作流主控规范（AGENTS.md）

本文件面向主控会话（通用于 Antigravity、Claude Code、Codex、Cursor、DSH 等任意 AI 编程宿主）。用户说「开始科研」「继续科研」或点名执行科研链路时，主会话充当流程调度向导：所有耗时的文献检索、想法发散、多票评审、探针实验全部通过子任务或 `npx research-dispatch` 外派执行，主会话只向人类呈交落盘结构化证据并等待人类拍板。

---

## 一、四条不可违反的硬约束

1. **Worker 仓外临时目录推式隔离（物理防上下文污染）**
   - 外部发散与评审 Worker 的上下文完全由派工器显式拼装的 Prompt 决定（**推式输入，而非拉式探索**）。
   - `research-dispatch` 执行外部 CLI 子进程时，默认将工作目录 `cwd` 置于操作系统临时目录（`os.tmpdir()` 下的独立空沙箱，位于本项目 `.git` 树之外），物理隔绝子进程向上遍历读取项目根 `AGENTS.md`、`CLAUDE.md`、`dead-ends.md` 或其它候选工单。因此根目录可安全保留本文件作为主控记忆。
   - 严禁让评审 Worker 自行读取任务板或横向比较多个候选：每张评审票只能看到共享 `Baseline` 段与当前唯一 `Idea`。

2. **人类唯一裁决权（禁止模型互相收敛代替拍板）**
   - 多 Agent / 多模型的发散、评审票、查重报告与统计探针都只是**判断素材**，不是决策。
   - 严禁让多个模型互相辩论到“达成一致”后自动推进正式训练。最终裁决必须由**人类**明确拍板，并逐单写入 `ideas/<topic>/verdict-<id>.md`（或顶层 `ideas/verdict-<id>.md`）的 `决定: go | revise | kill` 栏。

3. **落盘结构化证据优先于自然语言汇报**
   - 口头总结一律不作数；只认磁盘上的结构化字段、校验回执与哈希指纹：
     - 文献池：`papers/cards/*.md` 经 `check-paper` 校验后由 `pool` 拼出 `_pool.md`；
     - 发散与拆单：`diverge` 写入 `<!-- meta role=diverger ... isha=<12> bsha=<12> -->`，`briefs` 重算对账并校验 `预测` / `主读数` / `判据` 数值门槛与跨条零引用；
     - 多票评审：每票经 `checkCardFile` 校验五维正向打分（满分 25）与尾部散文上限（`≤30` 字），汇总写入 `<id>.manifest`，并由 `summary` 按票型与五维均分自动降序生成跨工单对比总表 `_summary.md`；
     - 探针读数：双臂实验经 `pilot-stats` 计算同单元配对标准误、`2σ MDE` 与合规子集同题对照。

4. **研究契约冻结（防事后合理化与改指标迎合结果）**
   - 正式训练开跑前必须填写 `contract/<exp_id>.md`（含阈值数值化的 Hypothesis、四项实现锚点、成功信号 `S1..Sn`、**独立于成功反面**的失败信号 `F1..Fn`、非空消融预期表），并执行 `npx research-dispatch check-contract contract/<exp_id>.md --record` 将 `sha12` 指纹记入 5 列 `contract/CHANGELOG.md` 后单独提交 Git。
   - 实验启动后严禁修改已冻结契约的 `success signal` 去配合实验结果。确需迭代假设时，必须新建 `contract/<exp_id>.v2.md` 并在 `CHANGELOG.md` 追加版本演进记录（闸门会自动核查 `.v2 -> .v1` 完整前序冻结链）。

---

## 二、七步标准科研闭环（S0 → S6）

| 阶段 | 目标与动作 | 确定性闸门 / 落盘产物 |
|---|---|---|
| **S0 文献进料与窄选精读** | 1) 按 `roles/scout.md` 检索相关论文（**能拿 arXiv LaTeX 源码或 HTML/Markdown 就不走 PDF**，仅在无源码/HTML 时回退 PDF），每篇写一张 `papers/cards/<slug>.md`（先读摘要与导论判相关性，如实标注 `venue` 与 `code_url`）；<br>2) 跑 `pool` 过滤坏卡拼出 `_pool.md`；<br>3) 从池中**窄选 Top 3–5 篇最接近工作精读方法章节与实验主表**，列出公开指标、开源可跑性与估算卡时供人类选定对照尺子。 | `npx research-dispatch check-paper`<br>`npx research-dispatch pool`<br>→ `papers/cards/_pool.md` |
| **S1 复现验收与签基线锚点** | 基于 `baselines/TEMPLATE.REPRO.md` 与 `TEMPLATE.BRIEF_BLOCK.md` 建立 `baselines/<name>/`；训练期间用 `repro-watch` 巡检数据 `sha256` 与日志心跳；复现完成后由**人类核对落盘指标并在 `REPRO.md §4` 签下 `SIGNOFF: PASS`**。 | `npx research-dispatch repro-watch`<br>`baselines/<name>/REPRO.md`<br>`baselines/<name>/BRIEF_BLOCK.md` |
| **S2 候选发散（支持负知识与纯空白双模式）** | 运行 `diverge`（默认产出 **10** 条）拼装 `roles/diverger.md` + `_pool.md` + `BRIEF_BLOCK.md`；默认自动挂载 `≤60` 行 `ideas/<topic>/dead-ends.md` 避开已证伪死胡同，也可传 **`--no-dead-ends`** 切换为完全不含历史讨论与被否点子的纯空白发散模式。 | `npx research-dispatch diverge`<br>→ `ideas/<topic>/raw-<ts>.md` |
| **S3 按课题拆单与自包含把关** | 运行 `briefs` 将候选拆分为单方案隔离工单 `ideas/<topic>/briefs/idea_XX.md`：核对 `isha`/`bsha` 出处指纹，硬性校验 `预测`、`主读数`（`acc` 型需 `≥ 2σ`）与 `判据`，并拦截任何跨条引用 `idea_XX` 的串写工单。 | `npx research-dispatch briefs`<br>→ `ideas/<topic>/briefs/idea_XX.md` |
| **S4 自由多 Agent 评审与自动 Ranking 总表** | 用 `agents` 探测本机可用 CLI/API 与模型，用 `lineup` 配置任意评审票组合（支持异构多 Agent 或同 Agent 多模型如 `codex:m1,codex:m2`）；先 `plan` 免费预演确认后再逐单 `run` 出票，跑完用 `summary` 计算五维总均分（`/25`）并默认按票型与均分**自动降序 Ranking** 生成 `_summary.md`（支持 `--sort rank|id`）。 | `npx research-dispatch plan`<br>`npx research-dispatch run`<br>`npx research-dispatch summary`<br>→ `ideas/<topic>/_summary.md` |
| **S4.5 前置查重 + ≤2h Pilot 探针** | 对票面占优的入围候选（正式投入长训前）：<br>1) 按 `roles/novelty.md` 做定向查重写 `papers/novelty/<id>.md` 并过 `check-novelty`；<br>2) 设计 **≤2 小时零训练或微训练诊断探针**验证核心机制前提，双臂输出用 `pilot-stats` 检验同单元配对 `Δ` 是否越过 `2σ MDE`，若含格式合规过滤则强制传入 `--compliant-field` 检查同题配对子集以排除难易选择性偏差。 | `npx research-dispatch check-novelty`<br>`npx research-dispatch pilot-stats`<br>→ `papers/novelty/<id>.md` |
| **S5 人工裁决与负知识沉淀** | 人类审阅 `_summary.md`、查重报告与 Pilot 统计后，在 `ideas/<topic>/verdict-<id>.md` 填写 `决定: go | revise | kill`。`revise` 并回修订后加 `--force` 重拆单（旧件自动归档 `.superseded/`）；`kill` 或探针证伪的机制提炼一行记入 `ideas/<topic>/dead-ends.md`。 | `npx research-dispatch status`<br>→ `ideas/<topic>/verdict-<id>.md`<br>→ `ideas/<topic>/dead-ends.md` |
| **S6 契约冻结与正式实验** | 复制 `contract/TEMPLATE.md` 为 `contract/<exp_id>.md` 填妥全部数值信号与非空消融预期，运行 `check-contract --record` 将指纹写入 `contract/CHANGELOG.md` 并提交 Git，随后按契约启动正式实验。 | `npx research-dispatch check-contract <file> --record`<br>→ `contract/CHANGELOG.md` |

---

## 三、命令速查（纯 Node 跨平台，零 Python/Bash 依赖）

```bash
# 1. 初始化目录骨架与角色/契约模板（已有文件默认跳过，不覆盖）
npx research-dispatch init [--topic <slug>] [--force]

# 2. 探测本机已安装的五大 CLI（codex / claude / dsh / agy / kimi）与模型，自由编排四阶段阵容
npx research-dispatch agents [--refresh] [--json]
npx research-dispatch lineup --scout agy --diverge agy --review codex:gpt-5,claude:claude-sonnet-4 --novelty claude
npx research-dispatch lineup --reset

# 3. 文献卡校验与文献池装配
npx research-dispatch check-paper papers/cards/<slug>.md
npx research-dispatch pool [--cards papers/cards] [--out papers/cards/_pool.md] [--dry]

# 4. 生成候选池（默认 10 条；加 --no-dead-ends 切换纯空白零负向锚定模式）& 按课题拆分为独立工单
npx research-dispatch diverge "<研究方向>" [10] --topic <slug> [--baseline baselines/<name>] [--no-dead-ends] [--agent <seat[:model]>] [--dry]
npx research-dispatch briefs ideas/<slug>/raw-<ts>.md --topic <slug> [--baseline baselines/<name>] [--force] [--allow-reanchor]

# 5. 免费预演、正式多票评审、五维均分自动降序总表与待裁决盘面扫描
npx research-dispatch plan ideas/<slug>/briefs/idea_01.md
npx research-dispatch run ideas/<slug>/briefs/idea_01.md
npx research-dispatch summary [--topic <slug>] [--sort rank|id]
npx research-dispatch status [--topic <slug>]

# 6. 前置查重校验、Pilot 配对统计（含合规子集防偏差）与基线复现活性巡检
npx research-dispatch check-novelty papers/novelty/idea_01.md
npx research-dispatch pilot-stats runs/armA.jsonl runs/armB.jsonl [--compliant-field compliant] [--json]
npx research-dispatch repro-watch baselines/<name> [--log baselines/<name>/repro.log]

# 7. 研究契约结构把关与冻结指纹对账
npx research-dispatch check-contract contract/exp01.md --record
npx research-dispatch check-contract contract/exp01.md
```

---

## 四、标准目录布局

```text
AGENTS.md                  跨宿主主控规范（CLAUDE.md 通过 @AGENTS.md 引用本文件）
dispatch/seats.json        Agent 座位定义、发散/评审阵容（lineup）与策略（policy）唯一真源
roles/                     四类标准角色提示词（scout / diverger / reviewer / novelty）
papers/cards/              单篇文献 YAML 卡与装配产物 _pool.md（坏卡自动移入 rejected/）
papers/novelty/            入围候选的定向查重报告 <idea_id>.md
baselines/                 各基线目录 REPRO.md（人类签 SIGNOFF: PASS）+ BRIEF_BLOCK.md
ideas/<topic>/             按课题隔离：dead-ends.md、raw-*.md、briefs/、cards/、_summary.md、verdict-*.md
contract/                  冻结的研究契约 <exp_id>.md 与 5 列指纹账本 CHANGELOG.md
runs/                      探针与正式实验运行产物（metrics / 双臂配对 JSONL）
```
