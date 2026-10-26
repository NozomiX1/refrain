# 0019. 子 agent：第一版不注入、不单独提取、不带 worker；只有主会话的一轮结束才触发 worker

- 状态：采纳（2026-10-23）
- 日期：2026-10-23
- 相关：[ADR-0009](0009-writer.md)（worker 按量触发）· [ADR-0014](0014-user-authorship.md)（子 agent 的提示词不算我的原话）· [ADR-0015](0015-context-assembly.md)（推迟了子 agent 的注入）· [ADR-0018](0018-storage-and-privacy.md)（单写者）· [research/d-experiments.md](../research/d-experiments.md)（D-c：fork 能看到父会话的上下文）

## 背景

写完 F 段后，我想到子 agent 的问题：它需要记忆吗？如果子 agent 也有 worker，就会碰到"加锁"的问题。

拆开以后其实是三个问题：要不要给子 agent 注入记忆，worker 要不要处理子 agent 的 transcript，子 agent 会不会自己触发 worker。

## 决定

**1. 第一版不给子 agent 注入记忆。**
- fork 会继承主会话的整个上下文，注入过的记忆自然也在里面。D-c 实验验证过这一点。
- 普通子 agent（Explore、通用型等）从空白开始，需要的背景由主模型写进任务说明里。CC 的 auto memory 和 trace-memory 也都不给这类子 agent 加载记忆。

**2. worker 只处理主会话的 transcript。**
- 子 agent 的 transcript 里，"用户"的话其实是主模型写的任务说明，不算我的原话（ADR-0014）。
- 子 agent 做了什么，会作为工具结果回到主会话，主会话里已经有一份主模型的消化结果。
- 真需要细节时，再按地址回读子 agent 的 transcript。

**3. 只有主会话的一轮结束才触发 worker。** 子 agent、fork 的一轮结束一律忽略，用 `agentId` 区分。否则用 fork 当 worker 时，fork 自己的一轮结束又会触发 worker，形成无限递归。trace-memory 的代码里也有同样的判断。

## 理由

- **没有真实案例。** 标注实验里，没有出现子 agent 因为缺记忆而出错的情况。
- **硬约束会自然覆盖到子 agent。** 子 agent 的风险主要在硬约束上，比如"不能碰代理"。将来做 C3（用 hook 强制执行）时，PreToolUse hook 对子 agent 的工具调用同样会触发，约束会自动生效，不需要给子 agent 注入记忆。
- **子 agent 不增加写入方。** 需要加锁，只是因为我会同时开着多个主会话（ADR-0018）。

## 后果

- 普通子 agent 不知道项目里的硬约束。在 C3 做好之前，这是一个已知的缺口。
- 防递归的判断是必须实现的，漏了就会出事。

## 什么情况下推翻

- 出现子 agent 因为缺少记忆而违反约束、或者做错事的真实案例 → 用 SubagentStart hook 给它注入硬约束，或者提前做 C3。
