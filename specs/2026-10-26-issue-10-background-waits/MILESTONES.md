# Implementation log

RED 先行：tests/goal-pstack-agent-wait.test.ts（commit 7cf0fb4）复现通知漏消费与固定窗口暂停。

实现（本 commit）：registry 增加 pstack-agent 通知适配器、pstack-agents 记录读取/结算、send_message 再登记、stop_agent 结果适配器、deadlineAt 显式期限；删除 allocateWaits/consumeDueChecks 与 taskCheck admission。scheduler 任务等待改为事件驱动（pstack 记录重读 1ms 起步指数退避至 60s，仅 structured:agent outstanding 时安排；有 deadlineAt 时由 deadline 界定睡眠），settled/schedule/begin 前先扫记录，wait 随存活任务投影刷新；resume 返回真实状态。normalize 迁移旧 wait 预算与 taskCheck（丢弃而非拒绝），task wait deadline 由 projection 重导。goal-recovery 增加 tasks 子命令：latest-record 验证、header id 匹配、symlink/畸形文件跳过、跨文件时间戳排序与歧义拒绝、确认后锁内重验、精确 tuple 结算、pre-write 备份、仅对实际应用的事件记账。ledger 新增 background_task_recovered。

review 修正：撤销通用 input.timeoutMs 推断（pstack schema 无该字段）；deadlineAt 仅接受已验证整数 epoch ms；blocksTaskPoll 保持失败即阻塞（不因 storage failure 放行）；恢复命令匹配 receiptId+sessionId 并在确认竞态下整体不动；session map 在 send_message 后清除旧终态，避免旧记录结算新 run。

旧策略测试更新（行为覆盖保留、断言更新到新语义）：+10m/+11m 系列改为无界事件驱动断言；660000ms 暂停测试移除（政策废除，显式期限覆盖移至 deadlineAt 测试）；冷恢复/退休夹具断言新 wait 形状与 dropped 预算；unspent/spent 旧预算统一按丢弃迁移验证。

验证：npm test 1151/1148/3（3 项为 baseline 既有 blocked-goal 失败，见 /tmp/pgx-issue10-handoff/full-suite-final.log）；tsc 0 错误；lint 仅剩 baseline 既有 1 项（verify-pi-goal-x/rpc-drive.mjs unused os）。真实 runtime completed/failed 已由 parent 验证 hostReported=true；native stopped 待 parent 复跑（stop_agent 适配器新增后）。

final review 修正（Claude 独立 review）：恢复原 RED 意图的真实回归，用持久化的 nico `deadlineAt` 到期后 `/goal-resume`，resume 在锁内写入前检查 projection deadline，已过期则不写入、不派发、不报成功，提示含 deadline 时间。`/goal-recovery tasks` 确认文案改为 lifecycle 不变（active 同/异 owner 测试覆盖）；撤回 receiptId 已验证的说法（verifyRecoverableTasks 从 task 复制 receiptId，可信来源只有 agentId+header+latest 终态）；锁内重验以确认时的完整 tuple 为上界，确认期间 receipt/scope 变化或新增任务均不结算。移除用户命令描述与注释中的 issue 10 历史标注。
