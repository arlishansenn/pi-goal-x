# Issue 10: background task waits

## Problem

pstack 后台子任务已经结束并发出 `pstack-agent` 终态通知，但 goal registry 不消费该通知；等待期限到达后目标被暂停，`/goal-resume` 再次暂停并可能显示与实际状态不一致的成功提示（issue #10）。

## Behavior contract

- pstack `agent` 工具的后台启动按结构化 receipt（`details { agentId, status: "running" }`）登记为 `structured:agent` 任务。
- 终态证据的来源与归属，任一都会结算任务，全部要求同 session 归属、精确 id：
  - `customType: "pstack-agent"` 通知，状态仅限 completed/failed/stopped（不解析文本，不匹配别名或跨 producer id）；
  - session 内 `pstack-agents` 记录（native stop triggerTurn=false、reload 孤儿 stop、以及启动 receipt 之前就存在的终态记录）；记录内按最后一条为准，`agent.sessionId` 是子会话 id，不用于归属；
  - `stop_agent` 结果 receipt（`details { agentId, status }`），仅结算同名 `structured:agent` 任务，覆盖同回合内立刻 pause 的真实序列；
  - `send_message` receipt（`details { agentId, running }`）将同 id agent 重新登记为运行中的新 run，旧终态记录不得结算新 run。
- 重复通知幂等且不改写首次 outcome；错误 id、foreign session、错误 producer、非终态状态不结算任何任务。
- 系统不再制造任务等待期限或检查配额：`+10min 检查 / +11min deadline` 政策废除。未声明期限的任务等待是事件驱动的、无界的；等待期间的记录重读有退避，且只为 pstack 任务安排。
- 期限只有两种来源：调用方 `update_goal` 声明的 wait（含 polling，语义不变、不可续期）；以及已验证 producer 契约声明的绝对期限（nicobailon `details.deadlineAt`，整数 epoch ms）。工具 input 的 timeout 不被读取。
- 迁移：旧持久化数据中的系统 wait 预算与 taskCheck 授权在加载时丢弃，任务身份、spent allowance、outcome 证据保留；系统制造的 deadline 不再授权暂停。
- `/goal-resume` 只在目标实际继续时报告成功；未结算任务的显式 producer deadline（`deadlineAt`）已过时，resume 不写入、不派发，报告该 deadline，目标保持暂停直到任务回报结果。
- `/goal-recovery tasks` 对旧目标提供经确认、先备份、逐条 ledger 审计的结算（latest 记录、跨文件时间戳排序、歧义拒绝）。可信绑定只有 agentId、session 文件 header id 与 latest 终态记录；`receiptId` 仅用于审计与 incarnation 匹配，不声称经过验证。锁内重验只结算确认时展示过的完整 tuple（producer、taskId、receiptId、session、outcome、evidence entry），确认期间变化或新增的任务不结算。不改变目标 lifecycle（status、owner、scheduling），active 目标同样适用。
