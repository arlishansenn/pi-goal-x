# #828 失败回归执行记录

## Bug fix playbook

1. Reproduce it yourself on the matching surface via the control skill (Non-negotiables). Don't hand the repro to the user. A debug or instrumentation protocol that says to ask the user does not override this. You drive the instrumented runtime. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. Won't reproduce directly, force it: synthesize the trigger, tighten conditions, or instrument until it fires.
2. Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with `how` over the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. Drive a long or stubborn hunt with a recurring wake. Confirm the surviving *mechanism* with runtime evidence before the step-3 architect/interrogate fan-out.
3. Plan the fix. If it crosses a function boundary, `architect` first. Delegate implementation to a subagent using your configured bug-fix model (default inherit-parent) with a specific scope. Review the diff.
4. Verify on the same surface. The original repro now passes. "Inconclusive" or wrong-surface is not a pass. Flag it. Unit tests show branch behavior, not bug absence.
5. Stage the commits so the failing repro lands before the fix in git history. See the **tdd** skill for the failing-test-first cadence when the bug has a cheap local test path. Skip it when the test would be expensive, integration-heavy, or unclear.
6. Run **Opening a PR**.

本任务只负责失败回归。步骤 1、2 限于确认已审查缺陷并排除 fixture 假红。步骤 3、4 的生产修复与转绿由主会话负责。步骤 5 不暂存或提交，按用户要求留给主审查。步骤 6 skip: 用户禁止本 agent 开 PR。所有 fan-out skip: 用户禁止再派 agent。

## Throughput checkpoint

唯一写入范围为当前 worktree 的 tests/。先建立一套公开入口 fixture，再按生命周期、归属、时限、冷恢复四组执行。每个测试独立目录、清理 timer、显式隔离全局 settings。执行前移除 PI_SUBAGENT_CHILD 与 PI_SUBAGENT_DEPTH，子进程继承清理后的环境。只读源码和已安装 producer，不安装或改源码。

## 原则改变的决定

- Test Behavior, Not Implementation。不调用私有 scheduler，注册事件触发行为，get_goal.details.goal 观察持久状态，tool_call 观察拦截。
- Model the Domain。producer fixture 按 launch、lifecycle、host 分开，workflow 不把 lifecycle 等同于 host delivery。
- Type System Discipline。回执使用已安装 producer 实际字段，host deliveryId 保持 opaque，解析子进程输出只作测试边界数据。

## 一手契约

- 已安装 @quintinshaw/pi-dynamic-workflows/src/workflow-tool.ts，启动 details 为 runId/background；恢复另有 resumedFrom，structured content 为 runId/status。
- 已安装同包 src/task-panel.ts 的 WorkflowLifecycleEvent 包含 status/runId/name/sessionId；tryDeliverEndpoint 只传 details.deliveryId。
- 已安装 pi-subagents 的 bundle/chunk-26C3WLYQ.js 使用 subagent-notify 与 details.runs。现有 tests/goal-subagents-receipt.test.ts 提供脱敏真实异步回执。
- generic bg_run/bg_status 复用现有结构化嵌套 task 契约，仅契约级证据，不声称安装或真实运行第三类 producer。
