# 横向扫描：验证定位假设 H1–H5

> 目的：只回答 [positioning.md](../positioning.md) 里的 H1–H5 是否成立，不深挖实现。
> 日期：2026-10-22
> 证据等级：**R** = 官方 README / 文档 · **P** = 论文摘要 · **3** = 第三方文章。全部来自网页抓取的摘要，没有读过源码或论文全文。

## 1. 对照表

| 对象 | 记什么 | 写入方式 | 成本 | 冷启动 | 影响可见 | 用户修正 | 证据 |
|---|---|---|---|---|---|---|---|
| **CC auto memory** | user / feedback / project / reference 四类 | 主模型在会话中自己决定写什么 | 无额外调用；MEMORY.md 前 200 行或 25KB 进每个会话 | 无 | 界面显示 "Saved/Recalled N memories" | md 文件，可以用 `/memory` 打开编辑 | R |
| **trace-memory** | 事实、知识、原文三层；global / project / session 三个作用域；没有单独的用户画像 | 后台 Noter 提取、Dreamer 整理，agent 也能手动写 | 有完整的预算体系；状态栏显示当天花费；自称"真实模型下的质量和成本未验证" | 只能补处理安装后的待办原文，不导入历史 | `/trace` 能看上下文组成；没有逐轮的注入清单 | 只能归档，不能硬删除；没有人工直接编辑 | R |
| **claude-mem** | 工具调用观察和会话摘要；没有用户画像 | 6 个 hook 自动采集，后台 worker 压缩 | 只有检索成本（每条 50–100 token），没有写入成本数字；托管服务 30 天试用后付费 | 未描述 | 观察有 ID；没有逐轮注入清单 | 有网页查看器；编辑、删除未描述 | R |
| **claude-supermemory** | 按仓库存项目记忆，另有跨项目的 profile facts | 会话结束时由托管服务提取 | 需要 API key，未给价格 | 无，从安装后开始 | **有 recall strip：可以逐条看本轮返回的记忆，回答里来自记忆的内容用 ◪ 标出** | 文档里没有查看、编辑、删除的方法 | R |
| **Claude-User-Memory-Plugin** | 只记用户本人，分个人和工作两个空间 | 模型自己决定；会话结束时批量提交，需要用户确认 | 未提 | 无 | 无，检索结果被"静默整合" | 通过 MCP 工具列出、修改、删除 | R |
| **Hermes Agent** | MEMORY.md（2,200 字符）+ USER.md（1,375 字符） | agent 自己写；每轮结束后有后台复盘 | 每个提示固定约 1,300 token；**官方承认后台复盘"在繁忙时会烧掉相当比例的 token"**，建议换便宜模型（便宜 3–5 倍） | 无 | 只能看到写入，看不到使用 | 纯文本可直接改；`/journey` 时间线；写入可以先审批 | R |
| **Pi observational memory**（elpapi42） | 观察 → 反思 → 修剪 | 达到 token 阈值后触发后台 worker（10k 触发观察，20k 触发反思） | 默认用会话模型；没有成本分析 | 无 | `/om:view` 查看记忆状态 | 不能编辑，只能自动修剪 | R |
| **Magic Context** | 项目记忆分 5 类；dreamer 归纳出的用户画像；压缩后的会话历史 | 后台 historian 压缩时顺带提取；dreamer 在空闲时整理 | **核心设计原则是"后台工作永不破坏 prompt cache"**；historian 可以用便宜或本地模型；没有具体数字 | **明确不回填**安装前的会话 | 侧栏和桌面端显示按来源划分的上下文；**明确不追踪模型实际用了哪条** | 桌面端可以搜索、编辑 | R |
| **Mastra OM**（Pi OM 的源头） | 带日期的观察日志 | 30k 未观察 token 触发 Observer，40k 触发 Reflector | 观察只追加，所以缓存只在反思时失效；自称 LongMemEval 94.87%，没有独立复现 | — | — | — | R / 3 |

**还没扫的：** remem、layered-memory（都是小项目，优先级低）。

### 1.1 通用记忆层（2026-10-22 补充）

这一类不接 CC，所以只看它们的思路和取舍，不看接入方式。

| 对象 | 核心设计 | 和我们的差异点有关的部分 | 证据 |
|---|---|---|---|
| **mem0** | LLM 从对话中提取事实。2025 年的论文版本会和已有记忆对账，决定 ADD / UPDATE / DELETE / NOOP | 论文在 LOCOMO 上报告：相比全量上下文，token 节省 90% 以上，p95 延迟降低 91%。**现行文档里，平台版和开源版都写着 "ADD-only; memories accumulate"**，看起来已经放弃了对账，改为只追加，原因未查明。文档里没有逐条来源或历史版本；有 `expiration_date` 用来隐藏过期记忆 | P / R |
| **Letta**（MemGPT） | core memory 块常驻 system prompt，agent 用工具自己改写；所有状态都存数据库，被挤出上下文的内容也能取回 | 它的 sleep-time compute 论文：空闲时预先思考，测试时的计算量减少约 5 倍，多个查询分摊后单次成本降低 2.5 倍；**效果取决于查询的可预测性**。编程场景（同一个项目里反复工作）的可预测性应该较高，但这一点要验证 | R / P |
| **Zep / Graphiti** | 时序知识图谱，**双时间轴**记录事实的生命周期；事实过时时**标记边失效，而不是删除**；数据以 episode 为单位写入，并保留来源 | 和过期记忆、溯源直接相关。检索结合向量、BM25 和图遍历，不用 LLM 重排。论文报告：DMR 94.8%（MemGPT 93.4%），LongMemEval 最多提升 18.5%，延迟降低 90% | R / P |
| **LangMem** | 语义记忆分**集合**（很多条，检索）和**画像**（单个文档，覆盖更新）；还有情景记忆（成功案例）和程序性记忆（用反馈优化 prompt） | 把"在对话中写"和"后台写"的权衡讲得很清楚：前者即时，但增加延迟和主 agent 的负担；后者延迟生效，但召回更高。检索排序用到"强度"，即**记忆被使用的频率和时近性**，说明它在内部追踪使用情况，但没有展示给用户 | R |

**对四个差异点的影响：**
1. **忠实且被遵从的用户模型**：没有一家保证遵从。LangMem 的程序性记忆只是改写 prompt，是"软"的，不是强制执行。**成立。**
2. **使用归因**：LangMem 在内部用使用频率排序，但不告诉用户这一次用了哪条。**成立。**
3. **可量化的低成本**：通用层其实会报成本，比如 mem0、Zep 在基准上和全量上下文比 token 和延迟。所以 H1′ 要收窄为：**在 CC 的真实使用中，没人报告记忆开销比。**
4. **冷启动**：Graphiti 支持批量导入历史 episode，所以"能导入历史"在通用层不算新鲜。但没人针对 CC 的 transcript 去做。**在 CC 场景下成立。**

**顺带的发现：**
- **mem0 从"对账"改成"只追加"，是一个值得深挖的"别人如何抉择"案例。** 它直接关系到我们的冲突处理和更新策略，到问题清单阶段再查原因。
- LangMem 的分类可以和愿景里的三类记忆对上：画像 ≈ 我是什么样的人，情景 ≈ 我们一起做过什么，程序性 ≈ 我们形成的做事习惯。

## 2. 假设的判定

### H1：现有的 CC 记忆方案，额外消耗都很高 → **部分成立，需要改写**
- 成本是公认的问题：Hermes 官方承认，Magic Context 和 Mastra 把缓存稳定当作首要的设计原则。
- 降成本的手段已经有共识：便宜或本地的 worker 模型、按 token 阈值触发、只追加以保持缓存、冻结快照。
- **但没有一家公开"记忆系统消耗 ÷ 主会话消耗"这样的数字**，trace-memory 自己也说成本未验证。
- 改写为 H1′：**现有方案都没有量化记忆开销。** 差异点从"便宜"变成"可量化地便宜"。

### H2：现有方案没有认真建模用户本人 → **推翻**
- 几乎每家都有用户画像：CC auto memory 的 `user` 和 `feedback` 两类、Hermes 的 USER.md、Magic Context 的 `<user-profile>`、supermemory 的 profile facts，还有专门记用户的插件。
- 但研究表明，问题出在**画像的质量**上：
  - **画像会编造**：Personalization Mirage 论文称，LLM 生成的用户画像平均 41.6% 的内容超出证据（数字来自第三方摘要），而且模型的自我检查和真实情况负相关。P/3
    - **更正（2026-10-22，读了全文）：** 41.6% 是"超出证据"（编造 31.1% + 刻板印象 10.5%），发生在生成时；"自我检查负相关"只是探索性结果，置信区间包含 0。见 [a3-evidence.md](a3-evidence.md)。
  - **记得不等于照做**：TRACE 论文显示，用 Mem0 时 57.5% 适用的偏好仍然被违反。P
- 改写为 H2′：**现有方案不保证用户模型忠实（不编造）和被遵从（真的照做）。**

### H3：现有方案装上后从零开始，不利用已有 transcript → **成立**
- Magic Context 明确不回填；supermemory 从安装后开始；trace-memory 只补处理安装后的待办；claude-mem 没有提到。
- 注意：CC 会按 `cleanupPeriodDays` 删除旧 transcript（官方文档确认有这个设置，默认值还没核实），所以能回填多少，取决于用户保留了多少数据。

### H4：CC auto memory 有具体的不足 → **成立**（依据官方文档）
- 只按仓库隔离，没有自动的跨项目记忆。跨项目只能靠手写的 `~/.claude/rules/` 或用户级 CLAUDE.md。
- 写入完全依赖主模型在会话中"想起来"，没有后台提取。主模型忘了写，信息就丢了。
- 没有整理：快到 200 行或 25KB 时，只会提醒模型去精简。
- 只有 `modified` 时间戳，没有来源。
- 和压缩没有打通，也不会加载到子 Agent 里。
- "Recalled N memories" 只告诉你读了几条，不告诉你用了哪条。

### H5：现有方案都不告诉用户这一次用了哪些记忆 → **部分成立，需要改写**
- "注入了哪些"已经有人做了：supermemory 的 recall strip 加上回答里的 ◪ 标记最接近；CC 显示 Recalled N；Magic Context 显示按来源划分的上下文。
- "**实际用了哪条**"没人做。Magic Context 明确不做，研究里也被列为开放问题（2606.04990）。
- 改写为 H5′：**没人做记忆的使用归因。** 这也是最难的部分，可行性要靠实验验证。

## 3. 定位之外，对设计有用的发现

这些发现不影响 H1–H5 的判定，但将来写问题清单和 ADR 时要用到。

1. **"压缩时不调模型、只渲染"已经是 Pi 生态的共识。** Pi OM、Magic Context、trace-memory 都这么做，源头是 Mastra OM。这在我们这里只是基本要求，不是差异点。R
2. **缓存稳定是降成本的核心。** Hermes 的冻结快照（会话中写入的记忆下个会话才生效）、Magic Context 的"不破坏缓存"、Mastra 的只追加，都在为缓存服务。R
3. **Hermes 的两条实战教训。** R
   - 超出容量时报错，而不是静默丢弃。
   - 删掉了 `replace` 操作，因为模型把它当成查找替换来用，会抹掉同一条目里的其他事实。
4. **记得 ≠ 照做 → 把纠正编译成运行时检查。** TRACE 论文把用户纠正改写成原子规则，再编译成完成任务前必须通过的检查，偏好违反率从 100% 降到 2–60%。CC 官方文档也说过："要无论 Claude 怎么决定都阻止某个动作，用 PreToolUse hook"。所以**会强制执行的记忆**在 CC 里是可以落地的。P/R
5. **把用户模型写成代码。** User as Code 把用户模型写成带类型的代码加规则，聚合类问题的准确率从 6–43% 提高到约 99%。P
6. **隐式冲突是过期记忆最难的一类。** STALE 论文的定义是：新信息让旧记忆失效，但没有直接和它矛盾。最好的模型准确率也只有 55.2%；在写入时就裁决冲突，效果明显更好。P
7. **短期评测会选错赢家。** Ground Truth First 论文发现，3 周时领先的系统，到 9 周时召回率从 96% 掉到 72%；带来源类型的图记忆则升到 90%。3 周时，"全量历史"基线就能打平最好的记忆系统。**评测必须跨多个时间跨度。** P
8. **存原文、让 coding agent 自己检索，是很强的基线。** 在 LongMemEval-V2 上，这种做法得分 72.5%，最好的 RAG 只有 48.5%，代价是延迟高。这会挑战"重度提取"的路线：也许少提取、多存原文，更便宜也更准。P
9. **快写慢整理分开。** Auto-Dreamer 把每个会话的快速写入和跨会话的慢速整理拆开；整理时生成一组替换条目，而不是逐条增删改。P
10. **记忆投毒。** transcript 里有网页和工具输出，如果从这些内容里提取"用户偏好"，就可能被投毒。基于来源的信任比基于内容的判断更难被利用（2606.22030）。由此引出一个可能的设计决定：**用户模型只从用户本人说的话里提取。** P

## 4. 对定位的影响（2026-10-22 已同意下面四个差异点）

原定位"低成本、对齐、冷启动"中：
- 冷启动仍然成立；
- 低成本要改成"可量化地低成本"；
- 对齐不能再笼统地叫"建模用户"，要具体到**忠实和遵从**。

再加上 H5′ 的使用归因，候选的差异点变成：

1. **忠实且被遵从的用户模型**：每条都有用户原话作依据；能强制执行的就用 hook 强制执行。
2. **使用归因**：知道模型这一次用了哪条记忆。
3. **可量化的低成本**：公开记忆开销比。
4. **冷启动**：回填历史。

## 来源

- CC 官方：[memory 文档](https://code.claude.com/docs/en/memory) · [settings reference](https://code.claude.com/docs/en/settings-reference)
- [trace-memory](https://github.com/KawaiiLLM/trace-memory) · [claude-mem](https://github.com/thedotmack/claude-mem) · [claude-supermemory](https://github.com/supermemoryai/claude-supermemory) · [Claude-User-Memory-Plugin](https://github.com/danielrosehill/Claude-User-Memory-Plugin)
- [Hermes memory 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) · [Magic Context](https://github.com/cortexkit/magic-context) · [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) · [Mastra OM research](https://mastra.ai/research/observational-memory)
- 通用层：
  - [mem0 文档](https://docs.mem0.ai/core-concepts/memory-operations/add) · [mem0 论文 2504.19413](https://arxiv.org/abs/2504.19413)
  - [Letta memory](https://docs.letta.com/guides/agents/memory) · [Sleep-time Compute 2504.13171](https://arxiv.org/abs/2504.13171)
  - [Graphiti](https://help.getzep.com/graphiti/getting-started/overview) · [Zep 论文 2501.13956](https://arxiv.org/abs/2501.13956)
  - [LangMem 概念指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- 论文：
  - [TRACE 2606.13174](https://arxiv.org/abs/2606.13174)
  - [LongMemEval-V2 2605.12493](https://arxiv.org/abs/2605.12493)
  - [User as Code 2606.16707](https://arxiv.org/abs/2606.16707)
  - [VARS 2603.20939](https://arxiv.org/abs/2603.20939)
  - [Personalization Mirage 2608.04570](https://arxiv.org/abs/2608.04570)（第三方摘要：[aiweekly](https://aiweekly.co/alerts/miragebench-personalized-llms-fabricate-416-of-user-claims)）
  - [STALE 2605.06527](https://arxiv.org/abs/2605.06527)
  - [Ground Truth First 2607.21962](https://arxiv.org/abs/2607.21962)
  - [Auto-Dreamer 2605.20616](https://arxiv.org/abs/2605.20616)
  - [Rate–Distortion 2607.08032](https://arxiv.org/abs/2607.08032)
  - [Evidence Tracing 2606.04990](https://arxiv.org/html/2606.04990v1)
  - [Belief-Based Memory 2606.22030](https://arxiv.org/abs/2606.22030)
  - [Agent Memory Survey 2602.06052](https://arxiv.org/pdf/2602.06052)
