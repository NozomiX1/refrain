# D 段实验：切片注入、接管压缩、fork worker、插件主动压缩

> 目的：验证几份 ADR 依赖的 CC 能力。ADR-0015 依赖切片注入，ADR-0009 依赖接管压缩，B4 依赖 fork worker，D4 依赖插件主动发起压缩。
> 日期：2026-10-23
> 环境：CC 2.1.308。测试项目和测试 mod 都放在 scratchpad。用 `claude -p --plugin-dir <mod> --model haiku` 起独立的无头会话，和本项目、我的其他项目都不搭边。
> 判断方法：以 transcript 文件为准，模型的回答只作为辅助。

## D-a：8 个 SessionStart hook 切片注入（ADR-0015）

**做法：** 注册 8 个 SessionStart command hook，每个输出约 9450 字符，带 `[[SLICE i START]]` 和 `[[SLICE i END]]` 标记。

**结果：**
- **8 片全部完整注入，没有被截断。** 合起来是一条约 7.6 万字符的 `hook_additional_context`；模型也列出了全部 16 个标记。
- **顺序没有保证。** transcript 和模型看到的顺序都是 4、1、2、0、6、7、5、3，也就是 hook 完成的先后。这些 hook 是并行运行的。
- 压缩后（`source=compact`）和恢复会话后（`source=resume`），8 个 hook 都会再触发一次，重新注入。

**对设计的影响：** 每一片都必须能单独读懂。要按条目或分组切，每片开头写明自己属于哪一组，不能从一条记忆的中间切开。

## D-a2：改用函数接口模块注入（2026-10-24）

**动机：** D-a 的乱序很难受。原因是 command hook 并行执行，按完成先后拼接，CC 没有让它们按顺序执行的选项。函数接口的类型文件里有 `classic.SessionStart` 事件，插件可以接管 SessionStart 的结果，其中的 `additionalContext` 是一个数组（每个 hook 一项）。

**做法：** 写一个 mod，在 `classic.SessionStart` 里 `await next(e)` 之后，往 `additionalContext` 追加内容；用 `claude -p --plugin-dir` 启动（CC 2.1.309）。测了两组：
1. 8 片，0–6 号各约 9480 字符，7 号约 15030 字符；
2. 只有 1 片，约 10 万字符。

**结果：**
- **顺序固定：** transcript 和模型看到的都是 0 到 7，和数组顺序一致。
- **没有 1 万字符的上限：** 15030 字符和 10 万字符的单项都完整注入，首尾标记都在，没有截断，也没有"已存成文件"的提示。transcript 里是一条 `hook_additional_context`，`content` 数组的长度和返回的完全一致。

**对设计的影响：** 简报整份作为一项返回，不再切片，也不需要 command hook。这个行为是从类型文件和实测得出的，文档里没有写明，要放进 H12 的 CC 升级自检。

测试用的 mod 和它生成的 transcript 都已删除。

**后续：** 我问"这是官方承认的做法吗"。查文档的结果：mod 和 `classic.*` 事件都有官方文档，但 hooks 文档说的 1 万字符上限是针对 hook 的 additionalContext 的，mod 返回的内容算不算没写。也就是说，"不受上限"是文档没写的行为，没找到别人这样用。于是改测 D-a3。

## D-a3：`prompt.context` 自定义块（2026-10-24）

**依据：** 类型文件写明，`prompt.context` 每个对话触发一次，算的是第一条用户消息带的上下文块（CLAUDE.md、邮箱、日期都在这里）；插件可以加自己命名的块；"对话里还没有这个块时（第一次请求、压缩之后）才发一份，只要它还在，之后的回答不会增加、修改或撤回它"；压缩和 `/clear` 之后会重新读取。CC 内置的 agents-md mod 用的就是这个事件（它改的是 `instructionFiles`）。

**做法：** mod 在 `prompt.context` 里追加一个 `memoryTest` 块，约 10 万字符，带首尾标记，每次触发都记日志；同时接管 `session.compact`，返回 `[[OUR HANDOFF]] 暗号 PELICAN-9`。用无头模式依次测：新会话 → `--resume` 恢复 → `--resume` 执行 `/compact` → `--resume` 提问。

**结果：**
- **新会话：** 10 万字符完整，首尾标记都在。位置在第一条用户消息里，单独一个 `<system-reminder>`，标题 `# memoryTest`，引擎在末尾加了一句"This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request."
- **恢复会话：** hook 又触发了一次（日志多一行），但上下文里**仍然只有 1 份**，没有重复。
- **压缩（我们接管）：** `session.compact` 收到 `trigger=manual`；之后 hook 再次触发，块**重新带上 1 份，位置在交接之前**；原来的对话看不到了，暗号能读到。
- 引擎自己的块：`claudeMd`（这个测试目录里为空）、`userEmail`、`currentDate`。

**对设计的影响：**
- 注入改用 `prompt.context`，冻结快照由引擎保证；
- 压缩后简报自动重新生成，而且是最新的，所以交接里不再放知识和项目现状；
- 不再需要 SessionStart；
- `/clear` 在无头模式下测不了，留到实现阶段验证；
- 这些行为写在类型文件里，但官方网页文档只有一行概括，要放进 H12 的升级自检。

测试用的 mod 和它生成的 transcript 都已删除。

**漏洞（2026-10-25 发现）：** 这次每次注入的块内容都一样，所以"压缩后重新带上 1 份"只能说明块还在，说明不了块是新的。trace-memory 的探测（他们的票 168）每次换内容，结果测出自动压缩之后还是旧块。于是补测 D-a4。

## D-a4：压缩后的简报块是不是新的（2026-10-25）

**做法：** 在 tmux 里开一个交互式 CC 2.1.309（固定用这个版本的二进制，模型是 Haiku），由 Claude 用 `send-keys` 打字、用 `capture-pane` 读屏。实验 mod 做了三件事：
- `prompt.context` 每触发一次，块的内容就换一次（`BLOCK-VERSION: v1`、`v2`……）；
- 接管 `session.compact`，返回一条 `[[HANDOFF from trigger=…]]`；
- 主会话每次请求之前，在 `turn.step` 里用 `$.session.messages({ as: "api" })` 读出这次实际要发的消息，记录里面有哪几个版本。

这样判断"模型看到的是哪一版"靠的是日志，不靠模型自己说；模型的回答只拿来对照。自动压缩是这样触发的：设 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=6`（阈值约 60k），再让模型读几个 100KB 的文件，把上下文撑过阈值。

**结果：**

| 触发方式 | `prompt.context` 有没有重新触发 | 下一次请求里的块 |
|---|---|---|
| 手动 `/compact`（`manual`） | 有 | **新的**（v1 → v2） |
| 插件发起，在 `turn.complete` 里调用 `$.session.compact()`（`plugin`） | 有 | **新的**（v2 → v3） |
| 自动压缩，发生在一轮中间（`auto`） | **没有** | **旧的 v1**，和交接一起放在第一条消息里。同一轮里连续两次自动压缩，都是 v1 |
| 自动压缩时在 hook 里调用 `$.ui.invalidate("prompt.context")` | 下一轮才触发，算出了 v2 | **还是 v1**。块已经在对话里了，新算出来的不会发出去 |
| 自动压缩之后，再做一次插件发起的压缩 | 有 | **新的**（v3） |

- 整个过程**没有出现 `precompute`**，所以旧块不是预先压缩造成的。
- 和 trace-memory 的结论一致：手动压缩换新；自动压缩保留旧块；中途 invalidate 无效。

**没测的：** 一轮开头发生的自动压缩（这次的自动压缩都发生在一轮中间）；CC 原生的自动压缩（trace-memory 测过，也是旧块）。

**旁证：** CC 的 issue [#92949](https://github.com/anthropics/claude-code/issues/92949)（open，标签 bug / has repro）报告的是同一个机制：CLAUDE.md、MEMORY.md 在自动压缩后被放回的是旧副本。评论里有人统计过，手动压缩 14 次全部是新的，自动压缩 11 次里有 10 次是旧的。有一点不同：CLAUDE.md 到下一条用户消息时会补发新版本，而我们的自定义块到下一轮也不会补发。

**对设计的影响：** 只支持手动压缩和插件发起的压缩。在启用插件的项目里，用 `DISABLE_AUTO_COMPACT=1` 关掉 CC 的自动压缩（design.md 4.4）。会话现状继续放在简报块里，不用改。

测试用的 tmux 会话和它的 transcript 都已删除。mod 和驱动脚本（`run.sh`、`say.sh`）留在本会话的 scratchpad 里。

## D-b：接管压缩（ADR-0009）

**做法：** mod 的 `session.compact` hook 不调用 `next`，直接返回自己拼好的一条消息 `[[OUR COMPACTION BLOCK]] … PELICAN-7`。然后在会话里执行 `/compact`。

**结果：**
- hook 收到了 `trigger: manual` 和 8 条原消息。
- transcript 里 `compact_boundary` 记录的是 **`durationMs: 5`**，token 数从 190393 降到 19677，**全程不调模型**。
- 压缩后再问模型：它能逐字引用我们拼好的那段内容，知道暗号；原来那条用户消息已经看不到了。
- 压缩完成后，SessionStart（`compact`）照常触发。按 ADR-0015，接管成功时 hook 要判断来源是 `compact`，然后不输出任何内容，避免重复注入。

## D-c：fork worker（B4）

**做法：** 在 `turn.complete` 里调用 `$.agent.spawn({ subagentType: 'fork', prompt })`，让 fork 把父会话里的暗号写进一个文件。

**结果：**
- 派生成功，`agentId` 已经返回；fork 写出了 `PELICAN-7`。说明它能看到父会话的完整上下文。
- **几乎全部走缓存：** fork 每次请求的缓存读取约 19 万 token，新写入缓存约 1400 token。回看整段上下文按缓存价计费。
- 模型和主会话一样，这里都是 Haiku。fork 不能换模型，否则缓存就用不上了。

## D4：插件主动发起压缩

**结果：**
- 无头模式下不可用，报错："not available in a headless (-p / SDK) session yet"。
- 交互模式下，从 `command.run` 里调用也不行，报错："called from a command.run hook, it would compact under the turn this hook is holding; call it from a later event (turn.complete)"。
- **交互模式下，从 `turn.complete` 里调用可以。** 由我手动测试：结果是 `ok: true`；压缩走了我们接管压缩的 hook，`trigger: plugin`；`compact_boundary` 里 `durationMs: 8`，token 从 124052 降到 19677；屏幕上显示的就是我们拼装的那段内容。

**对 D4 的意义：** 插件可以在一轮结束后自己发起压缩，而且压缩时走我们的拼装逻辑，所以"缓存过期后自动压缩"在技术上做得到。还缺一块：怎么判断缓存已经过期。另外，这个能力只能在交互会话里用。

## 顺带踩到的坑

- `--allowedTools` 这个参数可以接收多个值，会把它后面的提示也当成工具名吃掉。提示要放在它前面，或者写成 `--allowedTools=Write`。
- 用 `-p --resume` 时，插件注册的斜杠命令没法当作提示来用，所以改成在一轮结束时检查标记文件来触发。
