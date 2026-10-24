# Current verification

本轮基于 ddd00d2 裁剪 consumer。DW历史联调不作为当前验收。

- 删除前characterization为96/96，exit0。首次未清理child环境导致fixture未初始化，日志保留，不作通过证据。
- 新退休测试先red，exit1。最终retirement-confirmed为6/6，exit0。覆盖普通workflow不登记、公开机械进展、混合旧DW/subagent canonical冷恢复、DW-only waiting原deadline暂停、claimed不重放。冷worker删除pool snapshot，直接parseGoalFile逐值比较scope、receipt、used、wait/dispatch及原预算。
- targeted-final为105/105，exit0。包含subagent/BG/generic、部分完成、10分钟一次受限query、11分钟原deadline、冷恢复、owner、goal切换、空origin、失败create与既有scheduler用例。
- check-final类型检查exit0。
- unit-isolated和selfcheck-isolated各1127/1127，exit0。manifest为82 unit、1 integration、5 E2E入口。首轮unit/selfcheck有3项blocked用例受用户全局Oracle配置影响，清理child环境仍失败；仅以PI_GOAL_GLOBAL_SETTINGS_FILE指向本轮不存在文件隔离后通过，未编辑全局设置。
- rpc真实pi使用-ne与本worktree扩展，scratch项目执行goal-direct、goal-pause、goal-status health，3条命令及2个磁盘快照，exit0。不含模型调用，不证明真实subagent/BG producer端到端。

主审另外独立复跑check与selfcheck，真实exit均为0，1127/1127、零skip。

真实Pi1.4.0 TUI只加载候选goal与已安装pi-subagents。FAST与SLOW分别以async启动；处理FAST后写fast.txt与independent.txt，再次等待SLOW。164个canonical采样中57个、覆盖56.39秒满足FAST已消费而SLOW未消费，SLOW原deadline/checkAt/remainingChecks逐值不变，used固定2。最后两份报告均hostReported=true、三个文件字面内容正确，普通update_goal paused成功，canonical最终paused。未加载dynamic workflows，不依赖completion audit。

可复跑命令、完整输出和真实exit在 /tmp/pgx828-trim/*.command、*.log、*.exit。run.sh为统一运行器。RPC脚本与证据也在该目录。完整all的两个已知网络E2E基线失败本轮未重跑、未修复。

旧DW-only等待恢复后不补发checkpoint，保留原deadline。若用户发送新的真实工作消息，后续普通机械继续行为不在退休逻辑中另加限制。旧DW身份不能替保留任务提供poll grant，scheduler原有producer、taskId、receiptId匹配不变。

## 独立 review P1 后补验证

本段只补本次修复证据，不替换上方主审真实 subagent sibling 验证。

- 原 independent-unspent.mjs 复现真实 exit1，sent=1、used=1、targets=[]，日志 `/tmp/pgx828-trim/p1-repro-red.log`。
- 新增两项 canonical 真 child 未花检查回归先红，8项中6 pass/2 fail，exit1，`p1-red.log`。修后 retirement 8/8 随 targeted 通过。DW-only 在 +600000ms 无 checkpoint、used 不变，原 deadline 暂停。mixed-unspent 在旧 due 不发，在 sibling 原 due +620000ms 只发其自身 target，原 deadline 暂停。
- 五入口 targeted 107/107，exit0，`p1-target.log`。入口为 goal-background-retirement、goal-issue-828-regressions、goal-issue-828-correlation、goal-background-task-pause、goal-scheduler。
- `npm run check` exit0，`p1-check.log`。`npm run test:unit` 1129/1129、零skip，exit0，`p1-unit.log`。仅隔离继承 child/runner 环境和全局 settings 路径，未改用户全局配置。
- `/tmp` independent-parser、independent-collision 复跑 exit0，日志 `p1-independent-parser.log`、`p1-independent-collision.log`。旧 DW 同ID同receipt 不授 subagent，正控仍允许。
- 原未花冷探针副本仅将 canonical parse 的预期 quota 从1改为退休后0，并断言 nextCheckAt 为空，随后相同 runtime +600000ms 验证 sent=0、used=0，exit0，`p1-p1-unspent-fixed-expectation.log`。
- `git diff --check`、`git diff --cached --quiet` exit0。未提交、未推送、未开PR、未改安装。本次未重跑真实模型 TUI、selfcheck 或 all/network E2E。

最后退休P1修复后，主审重新执行check与selfcheck，真实exit均0，1129/1129、零skip。最终targeted为107/107。
