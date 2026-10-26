# A6 调研：和 CC 自带 auto memory 的关系

> 目的：回答 A6，是共存、关掉它，还是取代它。
> 日期：2026-10-22
> 证据等级：**R** = 官方文档（code.claude.com/docs/en/memory，2026-10-22 抓取）· **S** = 源码。

## 1. auto memory 现在的行为（R）

| 项目 | 内容 |
|---|---|
| 写什么 | 四类：`user`、`feedback`（纠正和你确认过的做法）、`project`（进行中的工作、截止日期、代码里看不出来的决定）、`reference`。不写能从代码推出来的东西，也不写 CLAUDE.md 里已有的 |
| 谁写 | 主模型在会话中自己决定。你说"记住……"，它会写进 auto memory |
| 存在哪 | `~/.claude/projects/<project>/memory/`，按 git 仓库划分，worktree 之间共享，只在本机。可以用 `autoMemoryDirectory` 换位置 |
| 怎么加载 | 每个会话开始时，加载 `MEMORY.md` 的前 200 行或前 25KB，以先到者为准；topic 文件按需读取。**子 agent 不加载**（fork 除外） |
| 元数据 | 写入时自动记录 `modified` 时间戳。没有来源 |
| 怎么关 | `/memory` 里的开关（写入 `autoMemoryEnabled`）；项目设置里 `"autoMemoryEnabled": false` 只关这个项目；环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| 保留 | `cleanupPeriodDays` 只清理 transcript，**不清理记忆文件** |
| 界面 | 显示 "Saved N memories" / "Recalled N memories"；可以用 `/memory` 浏览和编辑 |
| 定位 | 官方文档："Claude 把它们当作上下文，不是强制配置。要无论 Claude 怎么决定都阻止某个动作，用 PreToolUse hook" |

## 2. 别的插件怎么处理（S）

| 项目 | 做法 |
|---|---|
| **claude-mem** | **来回改过。** 安装器代码注释主张关掉："auto memory 是用户控制之外的影子状态，和 claude-mem 争抢上下文 token"。但交互式安装的默认选项是"保留（推荐）"，只有用户明确想让 claude-mem 替代时才关；项目里还有一条记录写着"auto memory 默认值翻转"。另外做了两件事：<br>① **导入**：`memory ingest` 把 auto memory 的 topic 文件直接导成观察记录，不调模型（"已经是提炼过的东西，再跑一遍生成是有损的，花钱买负价值"）；<br>② **桥接**：模型读原生记忆目录时，用 PreToolUse hook 补充自己检索到的内容 |
| **Magic Context** | 在 OMP 上安装时，**直接关掉** OMP 自带的自动记忆："第二个记忆注入器会让召回和保留重复"；已有数据不删 |
| **trace-memory** | 只在自己的后台 worker 里关掉，主会话不管，等于默认共存 |

## 3. 对照我们已经定下的规则

| 我们的规则 | auto memory 能不能满足 |
|---|---|
| ADR-0004：每条都链接到我本人的证据，标明原话还是推断 | 不能：没有来源，是主模型自己写的 |
| ADR-0002/0006：作用域 session / project / global | 部分：只按仓库划分，没有跨项目，也没有 session |
| ADR-0006：写入时裁决冲突、归档不删除 | 不能：直接改写或删除文件，靠 git 之外没有历史 |
| 差异点 2：使用归因 | 不能：只知道"Recalled N"，不知道用了哪条 |
| 差异点 3：成本 | 写记忆发生在主会话里，花的是主会话的 token |

共存的风险是：**两个系统各写各的，说法可能互相矛盾。** STALE 发现，新旧两种说法都摆在模型面前时，它照样会选错（"能看到不等于有权威"）。

## 4. 补充（2026-10-23）：CC 的 auto-dream

CC 设置 schema 里有 `autoDreamEnabled`，说明是"后台记忆整理（auto-dream）"。官方文档目前没有它的说明，下面全部来自社区分析和 GitHub issue，**未经官方确认**：
- 会定期启动一个子 agent，整理 auto memory 文件，分四个阶段：了解现状、收集材料、合并整理、删减并重建索引。保持 MEMORY.md 在 200 行以内。
- 受服务端灰度开关控制。开关没打开时，这个设置会被静默忽略（[issue #86209](https://github.com/anthropics/claude-code/issues/86209)）。
- 触发条件，社区说法不一：一说距上次整理至少 24 小时、且至少有 3 个 transcript 变过；一说按时间间隔或会话数触发。
- 已知 bug：整理中途被强制中断，会留下一个锁文件，之后整理功能就再也不会运行，而且没有任何报错（[issue #50694](https://github.com/anthropics/claude-code/issues/50694)）。
- 有用户提出"只读不写"的需求，并指出这个设置没有文档（[issue #76186](https://github.com/anthropics/claude-code/issues/76186)）。

**对我们的影响：** 官方 auto memory 的"整理"可能已经在灰度上线，H4 里"没有整理"这一条正在过时。但它仍然只按仓库划分，没有跨项目，没有来源，也没有使用归因。ADR-0001 的推翻条件是"补上了跨项目、整理**和**来源"，三者缺二，所以没有触发。ADR-0007 的对照组（只开 auto memory）要记下当时 auto-dream 是否开启。
