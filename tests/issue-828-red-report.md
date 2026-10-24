# #828 失败回归结果

本次只增加测试与证据。没有修改生产源码、producer、安装、票据、主副本，没有提交或暂存。

## 执行结果

最终回归为 34 项，16 通过，18 失败，真实 exit 1。所有最终失败都是正确行为断言观察到产品缺陷。没有 delegated guard、缺包、运行器错误或 TypeError 造成的最终假红。

命令在 /Users/admin/project/pi-goal-x-828-fix 执行。

```sh
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH node --import ./scripts/test-adapter-hooks.mjs --experimental-strip-types --test --test-reporter=tap tests/goal-issue-828-regressions.test.ts
```

exit 1。完整 TAP 在 tests/issue-828-red-output.log。

```sh
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH node --import ./scripts/test-adapter-hooks.mjs --experimental-strip-types --test tests/goal-subagents-receipt.test.ts tests/goal-background-task-pause.test.ts
```

exit 0。既有相邻回归 24/24 通过，日志为 tests/issue-828-baseline-output.log。

```sh
npm run check
node scripts/run-unit-tests.mjs --write-manifest
git -C /Users/admin/project/pi-goal-x-828-fix diff --check
```

以上 exit 均为 0。typecheck 日志为 tests/issue-828-typecheck.log。manifest 只新增本次测试入口。

## 失败映射

数字对应最终 TAP 编号。

- 审查 1。4、5、7 失败。lifecycle→host 不消费完成任务；host→lifecycle 在 sibling 存在时仍不能关联。6 的单 workflow host-first 路径通过。host details 只有 opaque deliveryId，没有虚构 runId 或解析正文。
- 审查 2。8、9 失败。create_goal 与 goal-focus 都将旧任务投影进新聚焦 goal。10、11 的明确暂停、清除及旧报告控制通过。
- 审查 3。12、13、22 失败。用户接管跨过 11m、存在独立读取进展、部分完成并继续处理时，仍 active 而非 paused。32 在无接管时精确 660000ms 暂停通过。34 验证部分完成后再等仍保留原 deadline 与耗尽额度，通过。
- 审查 4。14 失败。首次等待前收到重复 completed lifecycle 后 phase 为 idle，没有带期限的 host delivery guard。
- 审查 5。15、16、17、18、33 失败。普通 user 消费 generic；workflow 终态污染同 ID subagent；外国 session lifecycle 污染本任务；generic failed 被记为 completed。33 独立验证 session，避免被 producer 断言提前遮蔽。
- 审查 6。19 失败。带真实 resumedFrom 的同 ID workflow 恢复后不再等待。20 验证任意新 receipt 不构成 resume，通过。23 至 26 的早到、重复 subagent 启动及 completed/failed/paused/stopped 通知与 sibling 通过。
- 审查 7。21 失败。精确 600000ms 发出唯一 check，但进入公开 tool_call 后首次合法 status 查询仍 block。修复后此测试还要求同回合第二次 poll 被拒绝、660000ms 暂停。
- 审查 8。27、30 失败。真正子进程 canonical parse 与删除 snapshot 后的 scan 都得到 interrupted，而非 waiting。28、29 的 snapshot 与新进程 extension 同 session 恢复通过，后者按原时钟暂停且不重新获得 check。31 跨 session 冷恢复保留原 owner，不派 checkpoint，通过。

## 测试组织

- tests/goal-issue-828-regressions.test.ts 是 runner 入口。
- tests/fixtures/issue-828-cases.mjs 是 34 项场景，按已有 worker 模块约定承载动态 host API fixture。
- tests/fixtures/issue-828-extension.mjs 仅通过注册事件、注册工具与命令驱动。get_goal.details.goal 为主观察对象。未访问 _goalCore 或 scheduler 私有成员。
- tests/fixtures/issue-828-cold.mjs 为真正子进程 worker。canonical 直接解析目标文件，不把 snapshot 结果当作 canonical 证据。scan-restore 删除的是测试临时目录的 snapshot，不动用户数据。
- tests/.test-manifest.json 注册入口。
- tests/issue-828-red-plan.md 记录 playbook、原则、数据形状和契约来源。

## 调试中排除的假红

最初 fixture 只发 agent_settled，缺少 agent_end 的成功回合标记，等待没有建立。已改为公开 turn_start、turn_end、agent_end、agent_settled 顺序，重新执行所有场景。最初停止控制发生在已结束的同回合，触发正确的 post-stop gate；已改为新 user 回合。最初 cold scan 错用 goalStoragePath，已改成 goalStorageRoot。最初跨 session 断言强制 interrupted，超出既有契约；已改为原 owner 保留及不派 checkpoint。以上都不列为产品失败。

首次 TS 场景导入动态 .mjs fixture 导致类型检查失败。场景迁入 .mjs worker，TS 入口只导入 worker，最终 tsc exit 0。动态 fixture 本身不受 tsc 完整检查，这是测试实现限制，不把 tsc 通过称为所有 worker 已静态验证。

## 缺口与建议

没有执行真实 Pi RPC/模型/producer 冒烟，没有跑完整 suite 或 TLC。本次未改生产源码，不声称证明修复或全局兼容。generic producer 只复用既有结构化 task 契约，不声称已安装或真实 E2E。

部分场景在首个正确行为断言失败后停止，后面的 deadline、sibling 或 quota 断言需修复后再次执行。canonical scan 当前在解析恢复前即失败，因此扫描后的 extension restore 还未到达。新 session 的显式 /goal-resume 后续流程、完整 stop/cancel/steer 控制矩阵和所有 producer 跨 session 通知尚未穷举。

workflow host-first+sibling 在只有 deliveryId 时不能立即可靠归属。测试只在后续带 runId 的 lifecycle 到达后要求归属正确；两个 workflow 同时终态且 deliveryId 均不可关联时，需主设计说明保守策略，不得编造字段。

建议主会话先保留这些 red，按任务归属、host 关联、持久预算修复共享根因，然后重跑同命令。真实冒烟应处理首个结果后继续独立工作并再次等待 sibling，不能立即完成 goal 掩盖残余等待。

## 自审

Test Behavior, Not Implementation 决定了公开入口和字面正确行为断言。Model the Domain 决定 producer 回执、lifecycle、host 分离。Type System Discipline 决定只使用一手实际字段。Prove It Works 决定记录真实 exit，并以 canonical 与 snapshot 子进程作区分。不派新 agent，no-comments 的 fan-out 步骤按用户限制跳过；新增测试代码没有解释性注释或 suppression。
