# e2：SessionStart 的 additionalContext 能不能代替 prompt.context

起因（s1 第三次演练）：`prompt.context` 的块不只给主会话，每个子 agent 也会收到（CC 自己用它放 CLAUDE.md，所以子 agent 注册时才有 `omitClaudeMd`）。书记员因此收到了一份给主模型看的简报，Explore 这类子 agent 也收到了记忆，违反 ADR-0019。`SessionStart` 是官方 hooks 文档里"在会话开头加背景"的钩子，只属于主会话（子 agent 有自己的 `SubagentStart`）。D-a2 当时没选它，是因为官方文档写着钩子注入的内容上限 1 万字符，mod 是否例外没写。

探测 mod 在 `mod/`：`classic.SessionStart` 每次触发都追加三段，分别正好 1 万、3 万、10 万字符，每段带 BEGIN、MID、END 标记和版本号；`turn.step` 在每次请求发出之前，用 `$.session.messages({ as: "api" })` 读出**实际要发给模型的消息**，检查每段三个标记是否都在、长度是否一字不差。主会话和子 agent 都检查。原始日志和 transcript 在 `raw/`，只在本机。

## 结果（2026-10-26，CC 2.1.310，Haiku）

| 情况 | SessionStart | 实际请求里 |
|---|---|---|
| 启动 | `source=startup` | 三段都在，10000 / 30000 / 100000 字符，一字不差 |
| Explore 子 agent | 不触发（触发的是 `SubagentStart`） | 一段都没有 |
| 插件自己起的后台 agent（和书记员同样的起法） | 不触发（`SubagentStart`） | 一段都没有 |
| 手动 `/compact`，我们接管 | `source=compact` | 新的一份完整；旧的不在；和交接在同一条消息里，排在交接前面 |
| `/clear` | `source=clear` | 新的一份完整 |
| `--resume` | `source=resume`，还带 `prompt_cache_likely_expired`、`context_tokens`、`seconds_since_last_response` | 旧的一份还在对话里，又追加了一份：**恢复时要跳过，否则重复** |
| 自动压缩，发生在一轮开头 | `source=compact` | 只有新的一份，和手动压缩一样 |
| 自动压缩，发生在一轮中间 | `source=compact` | **新旧两份都在**：旧的被原样放回到交接旁边，新的加在对话后面 |

**结论：**
1. **能代替。** 只给主会话，子 agent 一律收不到；启动、`/clear`、压缩后都会重新给；10 万字符的单段完整到达模型，没有 1 万字符的截断（这仍是文档没写的行为，放进 CC 自检，每次升级测一次）。
2. **恢复会话时要自己跳过。** `prompt.context` 恢复时由引擎保证不重发，换成 SessionStart 要看 `source`。
3. **自动压缩照旧拦下。** 一轮中间的自动压缩会把旧内容放回去，和 `prompt.context` 的老问题同一类；不同的是新内容也到了。以后想重新打开自动压缩，要先能区分"一轮开头"和"一轮中间"。
4. 附带：恢复会话时的 `prompt_cache_likely_expired` 和 `context_tokens`，正好是 design.md 4.5 留的 D4 问题（会话关掉后再恢复、缓存已过期时，能否在第一次请求之前换成交接）要用的。

花费：主会话 Haiku 约 8 轮，按 API 价折算约 $0.12（每次请求带着约 14 万字符的测试内容，测自动压缩那段写入缓存 43 万 token，占了大头）。
