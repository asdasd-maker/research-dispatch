# 任务规格：文献检索与近邻初筛（scout）

> 本文件供主会话调度文献检索子任务（Subagent）或检索助手时使用，通用于任意宿主环境。
> 请优先调用宿主已挂载的学术检索与网页搜索工具（例如学术检索 MCP、arXiv / Semantic Scholar / OpenAlex / Crossref / DBLP 检索接口或内置 WebSearch）。
> **严禁在缺少检索工具或未查到结果时凭模型记忆编造文献卡** —— 一张虚构文献卡会污染后续整轮发散与基线选择。

## 你的任务

围绕目标研究问题，分两层完成进料：

1. **广度建卡（落盘 `papers/cards/<slug>.md`）**：检索真正相关的论文，每篇独立写一张结构化 YAML 卡；只负责客观抽取，不做主观吹捧或评审。
2. **窄选 Top 5 近邻提示（供主会话精读定锚）**：完成建卡后，向主会话指明与本问题最直接竞争或最适合作为实验基线的 **Top 3–5 篇核心近邻**（优先有开源代码与清晰评测基准的工作），供主会话进一步精读其方法细节与实验主表（提取具体指标数值、数据集切分与训练卡时预算）。

## 行为约束

- **格式获取优先级（能拿 LaTeX / Markdown 就不走 PDF）**：检索与阅读论文正文（尤其是精读方法公式与实验表）时，**优先获取 arXiv TeX/LaTeX 源码包**（如 `e-print` 源码）或 **HTML / Markdown 版本**（如 arXiv HTML、`ar5iv`、官方代码仓库中的 Markdown 文档），避免直接解析双栏 PDF 导致的跨栏语序错乱、公式上下标丢失与上下文膨胀；**仅当目标论文既无 LaTeX 源码也无 HTML/Markdown 时，才回退读取 PDF**。
- **广度建卡阶段控制阅读粒度**：初筛阶段聚焦标题、摘要（Abstract）与导论（Introduction），快速核定痛点与相关性，避免把几十篇全文细节塞满上下文；实验主表精读仅针对窄选出的 Top 3–5 篇近邻展开。
- **每张卡必答两项硬事实**（供后续选基线与查重使用）：
  1. `venue`：发表会议/期刊名或 `arXiv`。不确定时写 `other`，**严禁臆造会议名**。
  2. `code_url`：官方或可靠开源仓库链接；确实没有开源代码时必须显式写 `none`（**漏填与显式写 `none` 在校验器中严格区分**）。
- **禁止编造论文、作者、年份或代码链接**：检索不到就少出卡，绝不凑数。
- 一篇论文对应一个文件 `papers/cards/<slug>.md`，`<slug>` 使用小写英文、数字与连字符（如 `resnet-2016`），且必须与卡内 `paper_id` 完全一致。

## 每张卡的严格格式（`papers/cards/<slug>.md`）

可选首行写一条 HTML 元数据注释，随后**只输出以下 YAML 代码块**，禁止在代码块前后附加超过 30 字的总结散文：

```yaml
paper_id: <与文件名一致的 slug>
title: "<论文完整英文或原文标题>"
venue: CVPR | ICCV | ECCV | NeurIPS | ICML | ICLR | ACL | EMNLP | NAACL | KDD | AAAI | IJCAI | JMLR | TMLR | TPAMI | arXiv | other
code_url: <真实仓库 URL 或 none>
abstract_zh: "<不超过 3 句的中文核心摘要>"
intro_key: "<该工作针对的具体痛点与核心切入机制，1-2 句>"
relevance: "<与当前研究问题的直接关联或边界差异，1 句>"
```

写完卡片后运行 `npx research-dispatch pool` 即可自动完成逐卡结构校验（`check-paper`）并拼装 `papers/cards/_pool.md`。
