# Baseline Reproduction Record (`REPRO.md`)

> 复制本模板至 `baselines/<baseline_name>/REPRO.md`。完成复现核对并由人类研究者亲手将 `§4` 改为 `SIGNOFF: PASS` 后，`npx research-dispatch diverge` 与 `npx research-dispatch run` 方可放行挂载该基线的正式工单（详见根目录 `AGENTS.md` `S1`）。

## 0. 元信息

- **基线名称**：`<baseline_name>`
- **原论文标题与出处**：`<Title> (<Venue Year>)`
- **上游代码仓与 Commit**：`<URL @ commit_sha>`
- **本地代码路径**：`<repo_or_subdir_path>`
- **复现执行日期**：`YYYY-MM-DD`

## 1. 软硬件环境指纹

- **硬件与驱动**：`<GPU 型号 × 数量 / 显存 / Driver / CUDA>`
- **运行环境**：`<OS / Python 版本 / PyTorch / 核心推理或训练框架版本>`
- **关键解码或训练超参**：`<temperature / top_p / max_tokens / batch_size / lr / seed>`
- **复现启动命令**：
  ```bash
  # 记录可一键重跑的完整命令与日志输出路径
  ```

## 2. 数据集与权重指纹（供 `repro-watch` 持续校验）

> 生成方式示例：`sha256sum <dataset_or_split_file>`（保留 `<64位hex>  <相对根目录的文件路径>` 格式，以便 `npx research-dispatch repro-watch baselines/<baseline_name>` 自动核验文件完整性；以 `>` 开头的说明行会被自动忽略）。

```text
# 在下方粘贴真实数据文件或切分清单的 sha256 行（替换此注释）：
# 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  data/eval_split.jsonl
```

## 3. 核心指标复现对账与配对噪声底（`2σ`）

| metric | 论文报告 | 我复现 | 容差 | 判定 |
|---|---:|---:|---:|---|
| `<primary_metric>` | `<paper_val>` | `<repro_val>` | `±<tol>` | `PENDING` |
| `<secondary_metric>` | `<paper_val>` | `<repro_val>` | `±<tol>` | `PENDING` |

- **样本级噪声底（Paired `2σ` / MDE）**：`<记录在该评测集上的单题配对标准误与 2σ 最小可检出效应，供后续工单量化判据对齐>`
- **差异说明（如有）**：`<解释任何环境、量化精度或评测脚本细节导致的固定偏差>`

## 4. 人类签字验收（Human Sign-off）

> 核对 `§1–§3` 全部属实且指标落入容差范围后，由人类研究者将下方下划线替换为 `PASS`（Agent 严禁代签）：

SIGNOFF: ________

## 5. 下一步：提炼共享基线块

签字通过后，请基于本表实测数字同目录编写 `baselines/<baseline_name>/BRIEF_BLOCK.md`（参考 `baselines/TEMPLATE.BRIEF_BLOCK.md`，不少于 200 字节），供发散与拆单自动嵌入。
