# B8 实验：transcript 里哪些话是我本人写的

> 目的：回答 B8。ADR-0004 规定"证据只认我本人"，ADR-0012 规定"注入的内容丢掉"，两条都要先分清楚 role 为 user 的条目里，哪些真的是我写的。
> 日期：2026-10-23
> 做法：统计 CC transcript 里 user 类型条目的字段和标记。脚本只输出计数，不输出原文；遇到 16 条来源不明的短消息，用哈希比对认出它是什么，没有查看原文。
> 范围：只看 CC（第一版只做 CC）。样本：本机 4 个项目，CC 版本 2.1.295–2.1.308。
> 局限：下面用到的字段 CC 官方都没有写进文档，版本一变就可能变。

## 1. role 为 user 的条目，一共有哪些来源

共 4604 条：

| 来源 | 条数 | 怎么认出来 |
|---|---|---|
| 工具结果 | 3732 | 内容里有 `tool_result` 块 |
| **我打的字** | **647** | `origin.kind = "human"`；`promptSource = "typed"`（643 条）或 `"queued"`（2 条，指模型忙的时候我排队输入的） |
| 斜杠命令的回显和输出 | 82 | 以 `<command-…>` 或 `<local-command-…>` 开头 |
| 系统元信息 | 78 | `isMeta = true` |
| 后台任务的通知 | 19 | `origin.kind = "task-notification"` |
| 直接输入的 `/compact`（旧格式） | 16 | 没有 origin 字段，内容就是 `/compact` |
| 压缩摘要 | 16 | `isCompactSummary = true` |
| 子 agent 的提示词 | 16 | `isSidechain = true`。另外还有单独的子 agent 文件 |
| 打断 | 9 | `[Request interrupted by user]`，以及 `interruptedMessageId` 字段 |
| `!` 模式下我输入的命令 | 4 | `<bash-input>` |
| 子 agent 之间的消息、协调者的消息 | 3 | `origin.kind = "peer"` 或 `"coordinator"` |

## 2. "我打的字"里面，也夹着别人的东西

- **粘贴的内容有标签包着：** `<pasted_content>`。一共 5 条，分布在三个项目里（3 条、1 条、1 条）。标注实验里提到的"U390，我贴了别的 AI 写的方案"，就属于这一类。超过 3000 字符、却没有粘贴标签的长消息：0 条。
- **夹带的 system-reminder：** 在 human 条目里一条都没有。CC 现在把 hook 注入的内容存成单独的 `attachment` 记录。
- **斜杠命令的参数：** 2 条。命令后面跟的参数是我自己写的。

## 3. 我的操作：哪些是我做的，哪些是系统自动做的

| 字段 | 取值 | 是谁做的 |
|---|---|---|
| `toolDenialKind` | `user-rejected`：2 条 | **我**拒绝了工具调用 |
| | `automode-blocked`：4 条 | **auto mode 分类器**拦下的，**不是我** |
| `permissionDecision.source` | `user_temporary` 且为接受：5 条 | **我**在弹窗里点了允许 |
| | `config`（分类器、模式、规则）：约 3700 条 | 系统按配置自动放行，或自动拒绝（拒绝 4 条） |

这一点要特别小心：**同样是"拒绝"，有的是我拒绝的，有的是分类器拒绝的。** 只看结果分不出来，必须看字段。
