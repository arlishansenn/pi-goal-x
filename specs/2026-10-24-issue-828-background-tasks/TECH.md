# Representation and boundaries

BackgroundTasksState 保留 version=1、scope 和 tasks。TrackedTask 保留 producer、taskId、aliases、label、toolName、receiptId、scope、outcome、hostReported 和 wait。ProducerId 只有 nicobailon/pi-subagents、ismailsaleekh/pi-background-tasks 和 structured 工具命名空间。

normalizeBackgroundTasks 跳过精确旧 DW producer，不再解释 execution、superseded、legacyResumed 或 deliveries。其他任务不因旧 DW 存在而丢失。scheduler 保留原 deadline、used 和 dispatch。normalizeGoalScheduler 仅在 system-task wait 且 canonical tasks 经退休减少时，用 projectWait 从保留任务原预算重投影 remainingChecks/nextCheckAt；无保留检查机会时清 nextCheckAt，沿原 deadline 睡眠，不产生空 targets。显式声明 wait 和没有退休的普通 wait 不变；task-check admission 必须匹配保留下来的实际任务，已退休身份不能提供 grant。

事件路径仍为 tool_call 记录 origin 并检查 poll、tool_result 更新 canonical registry、message_start 消费原生通知。移除 DW lifecycle 订阅和对应入口。GoalService 是唯一状态写入者。

subagent receipt 使用 mode、asyncId、asyncDir 和空 results；终态从 subagent-notify.details.runs 读取。BG bg_run 使用 details.task，bg_status 使用 details.tasks，通知使用 background-task-notification flat snapshot。已核实 BG 旧 structured 命名空间继续在 canonical parser 归一化。generic 继续按现有 status/phase 规则，不猜 DW 字段。

冷进程回归直接读取 canonical goal 文件，排除 snapshot 掩盖。混合旧 DW/subagent 保留 subagent 原预算；旧 DW-only waiting/claimed 不判坏、不重放 dispatch、不重新分配 check。公开 extension fixture 验证 deadline、owner、goal 切换、普通工具进展及 create 失败传播。
