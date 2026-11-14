# Shared Baseline Block (`BRIEF_BLOCK.md`)

> 将本模板复制为 `baselines/<baseline_name>/BRIEF_BLOCK.md`，填入已通过 `REPRO.md`（`SIGNOFF: PASS`）验收的真实复现数字。
>
> **格式硬约束**：
> 1. 文件有效内容须 **不少于 200 UTF-8 字节**（防止空壳基线蒙混过关）；
> 2. 必须包含具体复现数值、评测集规模与配对噪声底（`2σ`），让盲审员无需猜数即可核算效应量是否跨过噪声线；
> 3. **严禁**在本文件内使用 `### Idea` 三级标题（`npx research-dispatch briefs` 会将本文件内容嵌入工单 `### Baseline` 节，`### Idea` 保留给候选方案正文）。

- **基线模型与代码锚点**：`<model_name>`（本地代码路径：`<path/to/code>`，权重/配置：`<checkpoint_or_config>`）
- **评测基准与样本规模**：`<dataset_name>`（`<split>`，共 `<N>` 题 × 每题 `<K>` 次采样 = `<N*K>` 条样本）
- **实测复现主指标**：`<primary_metric> = <XX.XX>%`（原论文报告 `<YY.YY>%`，复现偏差 `<±Z.ZZ>pp`，已签字验收）
- **辅助成本 / 行为读数**：`<avg_tokens / latency / compliance_rate = ...>`
- **配对统计噪声底（`2σ MDE`）**：同题配对标准误约 `<SE>pp`，最小可检出效应 **`2σ = <MDE>pp`**（低于 `2σ` 的单次波动视为统计噪声，可通过 `npx research-dispatch pilot-stats` 复核）
- **公平对比硬约束**：所有候选改进必须固定相同的评测评测脚本、解码温度、最大生成长度与总采样预算，严禁通过暗增推理计算量或事后按格式合规子集筛选（survivorship bias）虚报增益。
