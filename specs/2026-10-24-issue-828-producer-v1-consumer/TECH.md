# Consumer identity and caller reach

## Canonical representation

BackgroundTasksState stays version 1. TrackedTask adds execution with contractVersion, executionEpoch and optional originSessionId. taskId remains the producer runId. A real resume preserves the old task as superseded and appends the new execution. Superseded records retain old delivery evidence but do not receive new waits or poll grants.

Each newly enrolled task stores scope with goalId and initiating sessionId. Old tasks without scope inherit the existing registry scope. The root scope is never relabeled during takeover. Scheduler.owner is the trusted current scheduling session, passed separately to registry observation functions. All task correlation checks require that session to own the receipt. Budget projections still include surviving old-session tasks.

BackgroundTasksState.deliveries persists opaque deliveryId, runId and executionEpoch. Duplicate or conflicting IDs are ignored before mutation. Allocation and check consumption preserve the complete registry, including tombstones. Canonical normalization validates and retains execution, task scope, superseded and delivery fields. Duplicate tombstone IDs fail closed.

## Public adapter shapes

workflow reads background launch identity from result.details only. structuredContent is not identity authority. workflow_control reads details.action/result/run and details.runs. Only action=resume with result=resumed can advance an enrolled run. Other successful control summaries provide terminal evidence only. Lifecycle reads pi-dynamic-workflows:lifecycle and never marks hostReported. workflow-result reads details identity, deliveryId and actual sessionId, and never derives an outcome from the report text.

Legacy workflow launches retain their old representation. Explicit legacy resume preserves the legacyResumed fail-closed marker and does not manufacture a producer epoch. Generic structured terminal results retain their actual outcome and are their own result delivery. Native BG snapshots and subagent-notify retain their verified producer namespaces.

Canonical scheduler normalization uses the returned normalizeBackgroundTasks state rather than merely validating it. Namespace migration therefore reaches parseGoalFile without a legacy branch in host matching.

A valid, same-session, successful v1 workflow result with no background launch flag returns observed=false. The existing scheduler postTaskProgress path handles it as independent work without task enrollment or wait renewal. Invalid identities and actual background receipts retain observed=true.

## Caller reach

- goal-events routes tool_call to noteToolCall and poll admission, tool_result to noteToolResult, and message_start to scheduler.message. The scheduler's subscribed workflow lifecycle callback calls noteTaskLifecycle.
- noteToolResult supplies a trusted initial registry scope before both preview and canonical mutation. This permits a first real receipt carrying sessionId without dropping the task.
- background and changeBackground retain goal and scheduler-owner authorization but do not compare initiating registry session with the current owner. Registry observers receive the actual owner separately.
- pending tasks, taskDeadline, wait allocation, settlement and task-check admission still read the single GoalService canonical record. There is no task mirror or new store.
- toolScopes stores goalId=null for an observed unowned call. Its first call-ID assignment and shutdown clearing remain unchanged.
- GoalCore.replaceGoal returns boolean. create_goal and propose_goal_draft check false before success text, terminate or draft clearing. handleDirectGoalSet has no success continuation to change. The direct scheduler test ignores the result safely. Repository search found no replaceGoal test doubles requiring migration.

## Source authority

The read-only producer checkout is /Users/admin/project/pi-dynamic-workflows. Inspected files include src/run-persistence.ts, workflow-tool.ts, workflow-control-tool.ts, task-panel.ts and corresponding dist wire. Minimal wire status is documented in /tmp/pgx828-fix/architecture/producer-contract-implemented.md. The design proposal is not implementation evidence. The final producer candidate is 5a9913b34ac9cd67e3531091ed01202a26fb309d with a clean worktree. Final src/dist shapes were rechecked after the parent supplied the commit. It is not installed by this task.
