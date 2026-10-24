# Background task scheduling

用户已移除 dynamic-workflows。consumer 不再识别其 launch/control/resume、lifecycle 或 host delivery，也不保留 epoch 和 delivery 墓碑框架。普通 workflow 工具结果按既有 #83 机械规则处理，不读取 DW 专用字段。

保留 nicobailon/pi-subagents async receipt 与原生 subagent-notify，保留既有 generic status/phase 识别，以及已核实的 ismailsaleekh/pi-background-tasks。任务身份仍由 producer、task ID 和发起 goal/session 共同约束。部分完成不能消费 sibling，不能刷新原预算。

每个 outstanding task 首次等待分配一次 600000ms 检查和 660000ms deadline。保留单 GoalService authority、显式 owner resume、空 origin 和 goal 切换保护、失败 create 传播、canonical 冷恢复及故障保护。

旧数据只在 canonical normalize 输入边界退休。精确 DW producer 的任务被过滤，根 deliveries 被丢弃。其他任务逐项正常校验，其 identity、scope、receipt、原预算不变。旧 DW 不被伪造为完成，也不再获授查询。已有 wait/dispatch 的 used、原 deadline 和授权不重置；system-task wait 的检查机会只来自保留任务的原预算，旧 DW-only 未花检查失效，混合场景保留其他任务自己的原始 due。显式声明 wait 语义不变；仅剩 DW 的历史 wait 可沿原 deadline 暂停，需要显式 /goal-resume。claimed dispatch 不重放。此任务不修改用户已有 goal 磁盘。

不新增设置、依赖、兼容框架或全局 producer 开关。历史 DW 联调不作为当前验收。完整 all 已知的两个网络 E2E 基线失败不在此次修复范围。
