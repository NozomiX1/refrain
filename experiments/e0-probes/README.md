# e0：验证设计依赖的 CC 行为

对应 design.md 7.8 和 8.4 第 1 步。每一项都是"不成立就要改设计"的假设。CC 2.1.310，主模型和探测 worker 都用 Haiku。

探测 mod 在 `mod/`；驱动脚本在仓库根目录的 `tools/`（`cc-start.sh` 启动 tmux 里的交互式 CC，`cc-say.sh` 打字并等一轮结束）。外部通过 `work/control.json` 让 mod 在下一轮结束时做某件事，mod 把看到的一切写进 `raw/probe.log`。`raw/` 和 `work/` 不进仓库，留在本机，供以后再分析；结论和汇总写在本文件。

| # | 假设 | 不成立会影响 | 怎么测 |
|---|---|---|---|
| C1 | mod 注册的子 agent 类型（`$.agent.register`）能调用 mod 注册的工具；工具调用里带着它的 `agentId`；`agent.offer` 能对主模型藏起它；它跑完会触发带 `agentId` 的 `turn.complete` | 书记员的运行方式（4.3 第 4 步） | `control.json` 写 `spawn`，worker 调 `ping`，看日志 |
| C2 | 子 agent 的请求用 1 小时缓存，还是 5 分钟缓存 | 书记员输入的排序值不值（4.3 第 3 步） | 看 worker transcript 里的缓存写入类型 |
| C3 | 主会话的 `cost.usd` 是否包含子 agent 的花费 | 状态栏的开销比怎么算（7.11） | spawn 前后对比 `sessionCostUsd` 和 worker 自己的用量 |
| C4 | 在 `session.compact` 的 `e.messages` 里能认出"用户的一轮"，按轮数截出尾巴，带 handle 原样放回能用 | 交接的原文尾巴（4.4） | `keepTurns` + `/compact`，看日志里每条消息的形态，压缩后问模型 |
| C5 | 原样放回的尾巴写进 transcript 时，是沿用原 uuid 还是重新写一遍 | 读取器要不要去重（6.2） | 压缩前后对比 transcript 里那几条的 uuid |
| C6 | 计时器回调里能调用 `$.session.compact()` | 空闲压缩（4.5） | `timerCompact` |
| C7 | 注册工具设 `isDeferred: false` 后主模型直接可见 | 检索工具的说明能否常驻（7.4） | `tool.describe` 日志，问模型 |
| C8 | `DISABLE_AUTO_COMPACT=1` 对子 agent 也生效 | 书记员会不会撑满上下文（7.8） | 调低自动压缩阈值，让 worker 读大文件，看有没有带 `agentId` 的 `session.compact` |

## 结果（2026-10-25，CC 2.1.310）

| # | 结论 | 证据（`raw/probe.log`、`raw/transcripts/`） | 对设计的影响 |
|---|---|---|---|
| C1 | **成立。** 注册的子 agent 能调用 mod 注册的工具，调用里带着它的 `agentId`；`agent.offer` 藏住了它；跑完触发带 `agentId` 的 `turn.complete` | 两次 spawn，`ping` 日志 `worker: true` | 书记员的运行方式可行 |
| C1+ | **意外：** 后台子 agent 跑完，CC 会把"子 agent 的报告"作为一条 task notification 发给主模型，主模型因此多跑一轮。在 `prompt.submit` 里按 `agentId` 认出并 `{ drop }` 能拦住，代价是屏幕上多一行灰字"Prompt dropped by a hook: …"；被拦下的通知也不会出现在压缩时的 `e.messages` 里 | 第一次 spawn 后主模型回了 "A subagent report arrived…"；加 drop 后没有 | mod 必须拦掉书记员的完成通知 |
| C2 | **子 agent 用 5 分钟缓存**（主会话是 1 小时） | worker transcript 的缓存写入全是 `ephemeral_5m`，主会话全是 `ephemeral_1h` | 书记员两次运行隔 5 分钟以上就用不上缓存；5 分钟缓存写入单价 1.25 比 1 小时的 2 便宜，书记员不常跑，影响不大。4.3 第 3 步的排序收益比预想小，但不用改 |
| C3 | **主会话的 `cost.usd` 包含子 agent 的花费** | worker 那一轮的用量按 5 分钟缓存单价反算，正好等于主会话花费的增量 | 状态栏的开销比要先把书记员的花费减掉（7.11） |
| C4 | **成立。** `e.messages` 里一条消息对应一个内容块（thinking、文字、工具调用、工具结果各一条）；按"user、有文字、没有工具结果"认出了全部 5 个轮次的起点；截取最后两轮带 handle 原样放回，压缩后模型答对了暗号、两轮前要它记住的短语、更早一次 Read 的结果 | `handoff` 日志 `userTurnStarts: [0,3,8,11,19]` | 交接的原文尾巴可行。打断、注入的提醒等边角情况到第 1 步用剧本补测 |
| C5 | **原样放回的尾巴会被重写一遍，换成新的 uuid**；时间戳、`origin`、`promptSource` 和原来相同。我们的交接消息没有 `origin` | transcript 里 `compact_boundary` 之后的几条，文字和时间戳与之前的相同，uuid 不同 | 读取器要去重：按时间戳、角色、内容把副本对回原来那条。书签和生效路径也要处理：压缩后原来那几条不在新的父链上（要顺着 `compact_boundary` 的 `logicalParentUuid` 接回去），否则会被误判成回退 |
| C6 | **在计时器回调里调用 `$.session.compact()`，会跳过本插件自己的 `session.compact` hook**，走 CC 原生压缩（调模型，二十多秒）。原因是 mod 的防重入规则：mod 在 hook 之外发起的事件，跳过自己的 hook。在 `prompt.submit` 里调用则被拒绝（"it would compact under the turn this hook is holding"）。**由另一个插件的计时器发起就可以**：refrain 的 hook 正常跑，`trigger: plugin`，0.2 秒 | `timer.compact` 后没有 `session.compact` 日志；`submit.compact.error`；`companion.compact` 前一条是 `trigger: plugin` 的 `session.compact` | 空闲压缩（4.5）要一个很小的配套插件来计时 |
| C7 | **成立。** `isDeferred: false` 的注册工具，主模型直接看到完整参数 | `tool.describe` 日志 `isDeferred: false`；模型回答 | 无 |
| C8 | **成立。** `DISABLE_AUTO_COMPACT=1` 对子 agent 也生效：开着它，worker 的上下文涨到 19.3 万 token 没有压缩；不开（对照），到 9.5 万就触发了带 worker `agentId` 的 `trigger: auto` 压缩（阈值都调在 6%） | 两个 worker transcript；对照组的 `session.compact` 日志 | 书记员每次最多处理多少要设上限（E7），否则可能撑满 |

**补充（2026-10-25，s1 第二次演练）：** C5 漏看了一点：副本的 `parentUuid` 并不都指向前一个副本。工具结果的副本指回压缩前原来那次工具调用（它照抄了 `sourceToolAssistantUUID`）。e0 保留的尾巴里没有工具调用，所以没看到。读取器已按 design.md 6.4 处理。

**附带的小发现：** 两个插件同时读改写同一个日志文件时丢了几行（`$.fs.write` 不是原子的，也没有追加写）。refrain 自己的日志只由核心程序写，不受影响；探测用的日志以 transcript 为准。

花费：三个 tmux 会话，全部 Haiku，主会话加 worker 合计约 $0.05（按 API 价折算）。
