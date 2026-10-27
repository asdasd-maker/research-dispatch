# research-dispatch

**Multi-model review dispatch for [DeepSeek Harness](https://github.com/deepseek-ai).**
Seats decide *who* reviews, votes decide *how many* seats run, and every round lands on disk as
review cards you can diff, sign and archive.

一个把"多模型评审"做成可复现命令行的插件：座位表决定谁评，票决定跑几座，每轮结果落盘成卡片。

- ✅ 不写死模型：执行者（codex / claude / qoder / dsh / 任意 API）与模型都来自配置或单次参数
- ✅ 票源可证：自报身份永远不会被当成先验（`selfdeclared` 永不进 priors）
- ✅ 纯本地：零网络服务、零数据库；配置就是一份 JSON，产物就是文件
- ✅ 可测试：`npm test` 跑 123 条断言，不联网、不碰工作树

---

## 快速开始

```bash
npm i -D research-dispatch        # 或 git clone 后 npm link

# 1) 在工作区造一份座位表
mkdir -p dispatch ideas/briefs ideas/cards workers
cp node_modules/research-dispatch/examples/seats.example.json dispatch/seats.json
# 按需改 dispatch/seats.json：command / argv / identity 就是你本机 CLI 的真实调用方式

# 2) 看看生效的座位
npx research-dispatch seats

# 3) 只打印这一轮会跑什么（不动盘）
DRY=1 npx research-dispatch run ideas/briefs/idea_01.md

# 4) 真跑
npx research-dispatch run ideas/briefs/idea_01.md
```

产物：`ideas/cards/<工单id>.<座位名>.md`（一张卡一座），外加该轮 manifest。

## 三个概念

| 概念 | 是什么 | 落在哪 |
| --- | --- | --- |
| **座位 seat** | 一个"执行者 + 模型"的组合，以及怎么调它（argv、payload 位置、输出方式、身份回读方式） | `dispatch/seats.json` 的 `seats[]` |
| **票 vote** | 这一轮要跑哪些座。`reviewVotes: "codex:gpt-5,claude:opus-4,dsh:magpie/deepseek-v3"`，**排几票就跑几座** | DSH 设置面板，或环境变量 `BACKENDS` |
| **卡片 card** | 一轮里某座对某张工单的评审结果，带 meta 行（座位、模型、票源） | `ideas/cards/*.md` |

## 命令行

```bash
research-dispatch run  <brief.md>   # 跑一轮分派
research-dispatch plan <brief.md>   # 只打印计划（JSON），不动盘
research-dispatch seats             # 打印生效的座位表
research-dispatch review-models     # 打印各座身份（三行以内）
```

## 配置参考

### 座位表 `dispatch/seats.json`

```jsonc
{
  "version": 1,
  "paths": {
    "briefs_dir": "ideas/briefs",     // 工单目录
    "cards_dir": "ideas/cards",       // 卡片落盘目录
    "workers_dir": "workers",         // 外部 CLI 的 cwd（沙箱）
    "role_file": "roles/reviewer.md"  // payload 里的角色段
  },
  "default_backends": ["codex", "claude"],   // 没给票时跑这几座
  "seats": [
    {
      "id": "codex",                 // 座位名 = 卡片后缀 = 票里的取值
      "kind": "cli",                 // cli | api | delivery
      "enabled": true,
      "command": "codex",
      "argv": ["exec", "--sandbox", "read-only", "-C", "{workers_dir}",
               "{optional_args}", "-o", "{tmp}", "-"],
      "payload_position": "stdin",   // stdin | argv
      "output": "file",              // file（读 {tmp}）| stdout
      "optional_args": [             // 该环境变量非空时才追加；{env} 展开成它的值
        { "env": "CODEX_MODEL", "argv": ["-m", "{env}"] }
      ],
      "identity": {
        "kind": "config",            // 身份怎么回读，决定这张票算不算可证先验
        "explicit_env": "CODEX_MODEL",
        "file_env": "CODEX_CFG",
        "default_file": "~/.codex/config.toml",
        "pattern": "^model = \"[^\"]*\"",
        "cut_field": 2
      }
    }
  ]
}
```

`argv` 占位符：`{workers_dir}`（沙箱 cwd）、`{tmp}`（本次输出文件）、`{payload}`（整段 prompt 作为参数）、`{patch}`、`{optional_args}`。

### `identity.kind`：票源可信度

| kind | 怎么读 | 进先验？ |
| --- | --- | --- |
| `config` | 按 `pattern`/`cut_field` 从配置文件回读 | ✅ |
| `settings` | 读 DSH 的 `agent-default-model` | ✅ |
| `selfdeclared` | 只信自报名（`<SEAT>_MODEL`） | ❌ 永不 |
| `manual` | 自报名 + 必须绑 payload sha | 绑定成功才进 |
| `api` | 环境变量里的模型名 | ✅ |

`selfdeclared` 进先验等于"我说我是 X 就白换一票"，所以它永远只做展示。

### 环境变量（单次调用）

| 变量 | 作用 |
| --- | --- |
| `BACKENDS="codex dsh qoder"` | 本轮只跑这几座（覆盖票） |
| `<SEAT>_MODEL` | 该座显式模型（走 `-explicit`，不再读配置文件） |
| `<SEAT>_EFFORT` | 推理档（如 claude 的 `--effort`） |
| `<SEAT>_BODY` / `<SEAT>_SHA` | `delivery` 类座位的待投递正文 / 绑定的 payload sha |
| `DRY=1` | 只回显命令，不动盘 |
| `SHOW_PAYLOAD_TO=<file>` | 只交出 payload 字节就退出 |
| `DSH_DISPATCH_ROOT` | 仓库根（默认：monorepo 布局命中则用它，否则当前工作目录） |
| `DSH_DISPATCH_CONFIG` | 整份座位表覆盖路径 |
| `DSH_DISPATCH_BASH` | 指定 bash 可执行文件（默认自动探测 Git Bash / PATH） |
| `API_*` | `api` 座的端点、密钥变量名、模型、票数、温度 |

## 在 DeepSeek Harness 里当插件用

```bash
# 方式 A：本地 link 安装（开发用）
dsh plugin --profile desktop add "link:/abs/path/to/research-dispatch"

# 方式 B：从 npm 安装后加进 profile（把包名换成你的安装来源）
npm i -D research-dispatch
# 再把它加进 profile 的 dsh.profile.bundles（只装依赖不进 bundles，patch 不生效）
```

装完**要重启该 profile 的应用**。`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，
装配时插入 entry `research-dispatch`，并注册：

| 能力 | 说明 |
| --- | --- |
| 设置卡片 | `lib/client.js` 手写 browser bundle，注册到 `settings.section` 槽；改动即时生效 |
| 工具 `research_dispatch` | `classify` / `status` / `preview` / `state_get` / `state_set`——科研流程向导的执行通道 |
| 技能 `research-flow` | 说「开始科研 / 继续科研」时按向导一步步走 |

### 配置优先级

```
环境变量（CODEX_MODEL / CLAUDE_MODEL / BACKENDS）
  > DSH 设置文档里 id: research-dispatch 的 config（面板保存的值）
  > dispatch/seats.json 的 model_override / default_backends
```

Config 字段：`repoRoot`、`seatsFile`、`reviewVotes`、`stageOpinions`、`executorCatalog`、
`divergeCommand`、`divergeModel`、`otherStages`。**座位不是字段**——逐座的模型/执行者只写在座位表里。

## 目录

```
bin/dispatch.mjs      CLI 入口
lib/index.js          DSH 插件外壳（Config + apply + research_dispatch 注册）
lib/flow-tools.mjs    向导工具：classify / status / preview / state
lib/run.mjs           一轮分派：拼 payload → 逐座执行 → 落卡
lib/registry.mjs      座位表加载与身份解析
lib/models.mjs        模型身份归一、同族比对
lib/settings-file.mjs 读 DSH 设置文档（扁平 YAML 标量）
lib/client.js         设置卡片（浏览器 bundle）
skills/research-flow  向导技能
test/*.selftest.mjs   123 条断言（零联网、零模型）
```

## 测试

```bash
npm test
# flow-tools 14 条 + client 109 条，全部本地断言
```

## 已知限制

- **Windows 需要 Git Bash**（`bash.exe`）。会自动探测标准安装位与 `PATH`，也可用 `DSH_DISPATCH_BASH` 指定；显式排除 `system32\bash.exe`（WSL 转发器）。
- 座位表里的 `anchor_checker` / `card_validator` 等**由使用者自己提供**：本包只按路径调用，不附带你的私有脚本。
- 外部执行者（codex / claude / qoder / kimi）需自行安装并按各自方式登录；本包不代管凭据。
- `research_dispatch` 工具的注册依赖当前 dsh-tools 的 `output.render` 契约；本版本（1.0.3）已对齐，旧版宿主请忽略此条。
- 设置卡片是手写浏览器 bundle，DSH 大版本升级后槽名可能变化，届时需要同步。

## 隐私

仓库与 npm 包**只包含插件本身**：无密钥、无本机路径、无个人配置、无测试夹具里的私有数据。
座位表（含你的模型选择与 CLI 调用方式）属于你的工作区，不进本包。

## License

MIT
