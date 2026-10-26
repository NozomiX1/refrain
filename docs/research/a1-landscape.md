# A1 调研：其他项目怎么给记忆分类

> 目的：回答 A1"记忆分几类"。不只看 trace-memory（见 [a1-trace-memory.md](a1-trace-memory.md)），也看其他项目怎么分、为什么这样分。
> 日期：2026-10-22
> 证据等级：**S** = 源码、提示词、发布说明（2026-10 浅克隆）· **R** = 官方文档。
> 用来对照的分法：用户提出的"**发生了什么**（作用于当前会话/项目，压缩需要）vs **先验知识**（作用于会话/项目/跨项目，这才是记忆）"。

## 1. 对照表

| 项目 | 发生了什么 | 先验知识 | 关于用户 | 程序性（怎么做） | 证据 |
|---|---|---|---|---|---|
| **trace-memory** | Raw + Fact（话题切片）。属于会话；压缩时放进去；跨会话只能检索 | Knowledge：5 个用途标签 × 作用域（session / project / global）× 稳定性（open / 已确立） | 没有单独一类，就是 global 的 constraint | 没有单独一类 | S |
| **Magic Context** | compartment（一段工作的叙述，4 档详略，按重要性随时间衰减）+ events（少量"锚点时刻"：外部系统的坑、路线修正） | 项目记忆，5 类：PROJECT_RULES / ARCHITECTURE / CONSTRAINTS（仅外部系统的限制）/ CONFIG_VALUES / NAMING；另有 primer（项目里反复出现的问题） | **单独的流水线**：historian 记"用户观察"，同一条出现 ≥3 次才升级进跨项目的 `<user-profile>` | 没有 | S |
| **Hermes** | `session_search`：任务进度、做完的工作、临时待办 **都不进记忆** | MEMORY.md：环境、约定、工具的坑、教训（每个会话都注入，2,200 字符） | USER.md：用户是谁、偏好、风格（1,375 字符） | **skill**：做某类任务时学到的流程、坑，**以及用户对这类工作的偏好**，只在相关时加载 | S |
| **Letta Code** | recall memory：全部消息历史，不可修改，叫作"经验" | core memory：编进 system prompt 的块，外加按目录组织的 deferred memory | `human` 块 | skill | S |
| **Pi OM** | observation：带时间和重要度的事件 | reflection：从观察中提炼的持久结论，不分类。**只在当前分支内有效，不跨会话** | 不单列 | 不单列 | S |
| **claude-mem** | observation：按工作类型分（bugfix / feature / refactor / change / discovery / decision）+ 会话摘要 | **没有这一层**，经历本身就是记忆 | 没有 | 没有 | S |
| **mem0 v3** | 和右边混在一起：只追加，每条都带日期，事件也照样存 | 同左，一个扁平的池子，不分类 | 另有一段叙述式的用户摘要 | 没有 | S |
| **LangMem** | 情景记忆：成功的交互，用作 few-shot 示例 | 语义记忆：集合（多条，检索）或画像（单个文档，覆盖更新） | 用画像表示 | 程序性记忆：改写 prompt | R |
| **Graphiti** | episode：原始数据，所有来源都追溯到这里 | 实体和关系，带有效期，过时就标记失效 | 不单列 | 没有 | R |
| **CC auto memory** | 没有这一层，历史只在 transcript 里 | user / feedback / project / reference 四类；project 里包括进行中的工作 | `user` | `feedback` | R |

## 2. 发现

### 2.1 "发生了什么 vs 先验知识"基本是共识

六家明确分了这两层：trace-memory、Magic Context、Letta Code、Pi OM、Graphiti、Hermes。Magic Context 的提示词说得最直白：

> 世界知识（"事情是怎样的"）放进 facts；经历（"发生了什么"）放进 compartment 和 events。遇到一条信号就问："它描述的是项目**是**什么样，还是**发生**了什么？"

Letta Code 的提示词说："更新要能推广到各种情况，而不只是记录个别事件；目标是让将来的自己**做得更好**，而不是**记得更多**。"

例外：
- claude-mem 只有"发生了什么"。
- mem0 v3 把两者摊平成一个池子。它是按问答基准优化的，目标是"答得出"，不是"做得对"。
- CC auto memory 只有先验知识，经历只留在 transcript 里。

**一个细节：** 在 Magic Context、Letta、Hermes、trace-memory 里，"发生了什么"都不只是给压缩用。它会长期保存，跨会话可以检索，但不注入。Magic Context 还会把少数经历提炼成"锚点事件"，单独存放。

### 2.2 先验知识的细分，有三种思路

| 思路 | 谁在用 | 优点 | 代价 |
|---|---|---|---|
| **按用途或内容分类** | trace-memory（5 类）、Magic Context（5 类）、CC（4 类） | 好展示、好筛选、好按类整理 | 边界模糊；两家都删减过类别 |
| **按对象分：关于用户 vs 关于世界** | Magic Context、Hermes、Letta、supermemory | 用户画像可以跨项目、单独审查、单独设门槛 | 偏好往往依附于具体任务（Hermes 因此把任务相关的偏好放进 skill） |
| **按加载时机分：常驻 / 按需 / 检索** | Hermes（memory / skill / session_search）、Letta（core / deferred / skill）、LangMem | 直接对应成本和缓存；常驻部分可以保持很小 | 写入时要判断"什么时候用得上" |

trace-memory 另外用了两个轴：**作用域**和**稳定性**。这两个轴可以和上面任何一种思路组合。

### 2.3 有两家都删减过类别
- trace-memory：knowledge 从 7 类减到 5 类，类别改成纯标签；fact 的 6 个类别全部取消。
- Magic Context：项目记忆从 9 类减到 5 类，原来的 `USER_DIRECTIVES` 和 `USER_PREFERENCES` 被移出，改走单独的用户画像流程。发布说明里没写原因。

两家都保留了类别，但不再让类别承担太多职责。Magic Context 仍然按类别做整理（每次整理一类，不允许跨类合并）、按类别共享（工作区默认只共享 CONSTRAINTS）。

### 2.4 程序性知识，有两家单独存放
Hermes 和 Letta 都把"做某类事的流程"放进 skill，只在相关时加载，常驻记忆因此保持很小。Hermes 甚至把"用户对这类工作的偏好和纠正"也放进 skill。CC 本身就支持 skill，所以"记忆系统写 skill"在 CC 里是一条现成的路。这和 C1"什么时候注入"直接相关。

### 2.5 和后面问题有关的分歧（先记下，到对应问题再讨论）

**A3：重复出现意味着什么？三家立场各不相同**

| 项目 | 立场 |
|---|---|
| Magic Context | 用户观察出现 ≥3 次，才升级进画像 |
| Letta Code | "只根据一个模式或一条明确指令更新，不根据单个含糊的事件" |
| trace-memory | "重复出现只提示复查，不扩大适用范围，也不会把 agent 的要求变成用户的裁决" |

**A3 / 差异点 1：要不要在记忆里写来源？**

| 项目 | 做法 |
|---|---|
| trace-memory | 每条知识都引用 fact，fact 引用到具体的原始消息 |
| Letta Code | 明确要求常驻记忆**不写来源**（不写名字、日期、引语、事件经过）："消息历史里已经有事件，提交信息记录了改动原因"。理由是写成原则才能推广，事件细节会被模型过度模仿 |
| Magic Context | event 带 evidence 字段；记忆不带来源，但会映射到相关代码文件，用来核验 |

**A7：接续工作状态放在哪？**

| 项目 | 放在哪 |
|---|---|
| trace-memory | knowledge 里的 open，会注入下一个会话 |
| CC auto memory | project 类 |
| claude-mem | 会话摘要，下次开会话时注入 |
| Hermes | 明确**不进记忆**，用 session_search 去查 |
| Letta Code | 明确不写"当前状态、最近的活动" |

### 2.6 顺带：mem0 为什么改成只追加（B5）
mem0 v3（2026-04）的迁移文档："旧算法用两次 LLM 调用，一次提取候选事实，一次对照已有记忆决定 ADD / UPDATE / DELETE。新算法合并成一次调用，只做添加，**让模型把能力花在理解输入上，而不是和已有状态做 diff**。"新算法里，冲突交给检索阶段处理：每条记忆都带日期，检索时按时间选出对应的那一条；相关记忆之间用 `linked_memory_ids` 连起来。官方报告的效果是 LoCoMo 从 71.4 升到 91.6，LongMemEval 从 67.8 升到 93.4，提取延迟大约减半。这些是官方数字，没有独立复现。

## 3. 没看的
- 论文里的分类体系，比如 CoALA 的工作记忆、情景、语义、程序性四分，以及 Agent Memory Survey 2602.06052。
- Magic Context 为什么从 9 类减到 5 类：发布说明里没写，浅克隆也看不到完整的提交历史。
- claude-supermemory 的画像结构：README 里只提到 profile facts，最多 5 条。
