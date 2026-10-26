# pi-goal-x feature map

Read ../SKILL.md before driving. Every scenario runs in scratch state with a doctor, transcript, snapshots and owned-process cleanup.

## Goal commands

- [Direct creation and restart](goal-direct-creation.md).
- [List, focus and unfocus](goal-list-and-focus.md).
- [Cancelled clear](goal-clear-cancel-noop.md).
- [Pause and read-only health](goal-pause-status-health.md).

These four share `../scenarios/commands.jsonl` with `maxAutonomousRuns:0` to isolate commands from model continuation.

## Background lifecycle

- [Background waits and terminal reports](background-waits-and-reports.md).
- [Saved-session reload](reload-background-waits.md).
- [Confirmed legacy task recovery](confirmed-task-recovery.md).

Receipt replay tests the consumer protocol. Actual producer execution, persisted historical recovery replay and controlled-clock edge tests are separate evidence categories. Guided drafting, task tools and completion auditing remain unmapped; do not imply this map proves them.
