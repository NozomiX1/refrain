# C7 实验：查看记忆能不能不经过模型

> 目的：C7 要决定怎么查看记忆。两个候选：一是把文件放在固定位置，二是用命令在终端里显示。要弄清楚的是，命令显示的内容会不会经过模型。
> 日期：2026-10-23
> 环境：CC 2.1.308，用的是插件函数接口（mod，实验性）。mod 放在 `~/.claude/dev-mods/<session>/memview/`，显示的是 scratchpad 里一份示例快照，不是真实数据。

## 做了什么

写了一个 mod，叫 `memview`，注册了一个斜杠命令，有三种用法：

| 用法 | 实现方式 |
|---|---|
| `/memview` | `command.run` 的 hook 返回 `{ text: 文件内容 }` |
| `/memview pane` | `$.ui.open({ id, rows: 30, focus: true, closeOnEscape: true })` 打开面板，`ui.render` 负责画出整份文件 |
| `/memview close` | `$.ui.close({ id })` 关闭面板 |

## 结果

| 方式 | 显示 | 进不进模型的上下文 |
|---|---|---|
| `/memview`（命令直接输出） | 正常，中文、分组和 ID 都没问题 | **会进。** 整份输出以 `<local-command-stdout>` 的形式出现在模型的上下文里。参考文档也写着：命令的 `text` 是"模型也会读到的那一行" |
| `/memview pane`（面板） | 正常。第一版只显示了约 10 行，因为我按视口行数截断了；改成画整份文件之后可以全部显示。焦点在面板上时，方向键可以滚动（用 81 行的示例验证过） | **不进。** 模型只收到 "Memory pane opened." 这一行 |

## 遇到的问题

- **面板右上角的 × 点了没反应。** 原因未查明，可能是终端没有把鼠标点击传给 CC。改成打开面板时让它获得焦点、按 Esc 关闭，另外加了 `/memview close` 作为兜底。

## 和 trace-memory 的对比

trace-memory 的 `/trace` 用的是同一套机制：`focus: true, closeOnEscape: true, rows: 45`。不过它的面板是**状态和设置菜单**，不显示记忆内容。要看知识，得让模型去读虚拟路径。另外，它打开面板时还会把菜单的文字版作为 `{ text }` 返回，这部分会进入模型的上下文。

## 对 D1 的意义

这次顺带验证了：在 2.1.308 上，插件函数接口的命令注册、面板、`$.fs.read` 都能用，而且改动后会自动重新加载。D1 里还没验证的是：`session.compact`（接管压缩）、`$.agent.spawn`（fork worker）、多个 SessionStart hook 的拼接。
