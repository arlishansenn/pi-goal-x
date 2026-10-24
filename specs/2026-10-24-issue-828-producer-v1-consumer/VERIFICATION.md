# #828 候选验证与限制

## 基线与候选

Consumer 基线为 `93aaf7a`，先行失败回归为 `ac27d6c`。Producer 候选为个人 fork 的 `5a9913b34ac9cd67e3531091ed01202a26fb309d`，先行失败回归为 `81cfa64`。所有真实运行显式加载候选 checkout，没有切换运行安装、合并 PR 或关闭验收票。

## 可复跑验证

在 consumer 仓库运行以下命令。测试进程使用不存在的独立设置路径，避免用户 Oracle 模型配置影响已有测试；这不修改全局配置。

```sh
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_DEPTH \
  PI_GOAL_GLOBAL_SETTINGS_FILE=/tmp/pi-goal-x-test-settings-absent.json \
  npm run test:selfcheck
npm run check
```

主审最终复跑 check 与 selfcheck，真实 exit 均为 0，selfcheck 为 1157 passed、0 failed、0 skipped。定向公开事件、canonical 冷恢复与关联回归共 104 项通过。新增审查回归先观察到 3/3 失败，再转绿；没有跳过或删除正确行为断言。

Producer 六个受影响测试文件为 430/430。独立 reviewer 重跑同一组，并在隔离副本检查 required-save 失败、public lifecycle 重入 resume、disk-only adopt 和 queue drain，没有确认新增 blocker。

## 真实 sibling 联调

Pi 1.4.0 TUI 显式加载两个候选，以真实 `/goal-direct` 创建目标并启动 FAST、SLOW 两个后台 workflow。主审从 canonical goal 文件每秒采样，同时读取实际产出文件。

- FAST 报告消费后写入 `fast.txt=FAST_DONE` 和 `independent.txt=CONTINUED_AFTER_FAST`。
- 随后共 76 个采样、覆盖 75.48 秒满足 phase=waiting，SLOW 尚未报告、`slow.txt` 尚不存在。
- 这段等待期间 SLOW 的原 deadline、checkAt、remainingChecks 逐值不变，scheduler.used 固定为 2。
- SLOW 原生报告到达后写入 `slow.txt=SLOW_DONE`，两任务均 hostReported=true，executionEpoch=1。三个文件字面内容均核实。

判定为部分结果处理、继续独立工作、重新等待 sibling、预算保持和两份报告消费通过。300 秒采样窗口结束时 completion audit 尚在最终决定，goal 仍 active/idle；本次不宣称最终审计完成。真实旧代报告延迟与 resume 的全部排列未逐一制造，该项由 producer 和 consumer 的 fixture、持久队列与冷进程测试验证。

## 全量门禁未通过项

Consumer `test:all` 本次主审运行 1203/1205 通过，两项网络 E2E 失败，未 skip。相同原测试在 untouched `93aaf7a` 同环境重现，不能归因于本轮新增修复。

第一层原因为测试进程的 global-settings override 遮蔽了 fixture 自动 focus 设置。仅在临时诊断副本将设置放到 project 层后，基线与候选均产生通知，但都因 Pi 1.4.0 custom `before_agent_start` 使用 message 而非 prompt，退避计数回到 1，仍未通过升级退避断言。该既有兼容问题未混入 #828 PR；不能据 unit 全绿宣称全量门禁通过。

Producer 完整 suite 为 1755/1757，两项 UI theme parser 失败已在 untouched `3a52f19` 复现。check、build、docs、context、guidance、release verify 通过；UI 修复未混入契约 PR。

## 验收边界

旧版 workflow 只有 opaque deliveryId 时不猜归属，保留原期限的有界等待。完整自动关联需要配套 producer v1。BG/subagent 没有 execution epoch 时不承诺任意重放安全。

外部原地改 canonical 而不更新 snapshot 的恢复仍可能因旧 revision 拒写，本轮不新增专用读取旁路。写入失败且 canonical interruption 无法持久化时，故障锁存只保证当前进程拒绝自主调度，不承诺断电 fsync 或跨冷进程保存未提交事实。

既有 TLC 模型通过不代表覆盖新增 v1、provenance、delivery 墓碑与 admission 的完整组合。未新增该组合的形式化模型。

原始运行日志包含本机路径、会话和模型内容，保留在本机临时证据目录，不直接提交公共仓库。公开 PR 使用本说明、可运行测试及脱敏事件结构作为证据。
