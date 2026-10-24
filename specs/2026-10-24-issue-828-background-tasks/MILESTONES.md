# Implementation log

此前实现曾支持 dynamic-workflows 的 epoch 与交付墓碑。该方向已被用户撤销，旧实现及联调证据留在 git 历史，不作为当前验收。

本轮先保存96项characterization，再删除DW专用路径、schema、订阅和测试。保留真实subagent、BG和generic入口；generic fixture现在使用pwsh taskId/phase，BG另用真实details.task/details.tasks。迁移预算、producer/session隔离、owner resume、create失败与canonical冷恢复用例。

canonical normalize只过滤精确旧DW producer，不为其伪造完成。其余任务继续校验并逐值保留原scope、receipt和预算。根deliveries退休。历史wait/dispatch不重置，原deadline保护仍在。

新冷测试首次被旧pool snapshot掩盖，已修正为child删除snapshot再restore。另一个测试在恢复后无message_start而主动制造agent turn，走普通implicitReady发checkpoint；已删该虚构turn，改为恢复后直接推进原deadline。没有因此改变production。

逐次运行与真exit位于 /tmp/pgx828-trim。当前结果见VERIFICATION.md。未commit，交主审核验。

独立 review P1 修复。先复跑 /tmp/pgx828-trim/independent-unspent.mjs，真实 exit1，sent=1、used=1、targets=[]。原冷 fixture 先消费 check，未覆盖正常首 check 前退出。新增 DW-only unspent 与 mixed-unspent 真 child canonical 回归，清 snapshot、无虚构 turn，先红 6/8，只有新增两项失败。

根因是 normalizeBackgroundTasks 退休身份后 scheduler.wait 仍留旧检查机会。在 normalizeGoalScheduler 仅对任务数因退休减少的 system-task wait 重投影保留任务的原检查预算。保留 deadline、used、task identity 和 sibling wait，不伪造完成，不改变显式声明 wait。混合回归让 sibling checkAt 比旧 DW 晚 20000ms，验证旧 due 不发送、原 sibling due 单次发送且 targets 只含 sibling。

本次不改 scheduler dispatch/admission，不恢复 DW 支持，不改安装，不派 agent。target 107/107、check、unit 1129/1129 全部 exit0。精确 producer parser、同ID同receipt collision 冷探针复跑 exit0。未提交、未暂存。主审真实 subagent sibling 验证段保留不变。
