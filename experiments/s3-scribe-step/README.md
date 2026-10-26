# s3：书记员在真实 CC 里怎么结束

E7 之后的小演练（2026-10-26，CC 2.1.310）。要确认三件事：书记员的推理强度真的是 low；提交成功后 mod 代答下一步，能省掉一次请求；整理正常收尾。

做法：`work/proj/` 里一个三个文件的小仓库，用 `tools/cc-start.sh` 开交互式 CC（Haiku），加载 refrain，触发量调到 800 字，聊了 7 轮，书记员跑了 5 次。原始 transcript 在本机 `~/.claude/projects/`，不入库。

## 结果

- **推理强度 low 生效。** 每次整理思考 100–900 token（s1 时继承 xhigh，是 8k–16k）。
- **代答省不下请求。** 2.1.310 要求子 agent 调用 `SubagentHandback` 交回报告才算结束。mod 在提交后代答一个空回答，CC 就插入一条 "[handback-send-enforce] Your report has not been delivered" 再请求一次；改成代答一个 `SubagentHandback` 调用，CC 不执行，照样补那一句。两种都和不代答一样多一次请求，所以撤掉了。
- **发现收尾从没执行过。** 书记员是在主会话的 `turn.complete` hook 里用 `$.agent.spawn` 起的，从 hook 里起的子 agent 的事件会跳过那个 hook，所以书记员自己的 `turn.complete` 也到不了这个 hook：`finish` 一次都没调用，用量没记下（状态栏一直 ≈$0.00），没提交就结束的运行要等 20 分钟超时才算失败。拆成单独的 hook 以后（同一事件的第二个 hook 必须带匹配条件，用了列出全部结束原因的条件），第 5 次整理记下了用量。s1、s2 时就是这样，当时没发现。
- **书记员的输入里多了别人加的东西**：CC 自带的一段 system-reminder（含用户邮箱，约 900 字）、MCP 服务的说明（Claude Docs）、交回报告的提示，以及用户装的 ponytail 插件在 `SubagentStart` 里加的说明。E7 的 `claude -p` 重放没有这些，所以真实使用时每次整理的输入比实验多一些。我定的：这些量不大，也不影响书记员，保留，不在 `SubagentStart` 里替书记员去掉。

花费：主会话 Haiku 7 轮、书记员 5 次，5 小时额度从 50% 到 56%（主会话是 xhigh，占了大半）。
