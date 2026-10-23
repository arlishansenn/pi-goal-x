---
name: goal-flush-transaction
description: "Model-checks the GoalService per-turn goal transaction (turn buffer, flush, revision conflict, external writers, usage-delta merge) with TLC. Use after editing extensions/goal-service.ts, extensions/storage/goal-lock.ts, the turn_start/turn_end handlers in extensions/goal-events.ts, or the flush-before-focus-switch in extensions/goal-state.ts, and before claiming a change to the goal mutation boundary is safe."
---

# Goal flush transaction verification

Verified property, one sentence: the per-turn goal transaction in `GoalService` commits its buffered mutations only on top of the exact disk revision it captured, never silently drops a buffered mutation, never overwrites a concurrent writer's revision or usage, never appends ledger events for a write that did not happen, and leaves memory consistent with disk at quiescence.

Harm if broken: `.pi/goals/active_goal_*.md` loses task/status/usage updates or is overwritten with stale data; the JSONL ledger records events that never happened.

## Run

```bash
node .agents/skills/goal-flush-transaction/run-tlc.mjs
```

Needs `java` (17+) on PATH. First run downloads tla2tools 1.7.4 to `~/.cache/pi-goal-x-tla/` (override with `PI_GOAL_X_TLA_JAR`). Success prints `Model checking completed. No errors have been found.` and exits 0; any invariant violation exits non-zero with a step trace.

## Coverage record

Every action in `model/GoalFlushTransaction.tla` carries a comment naming the code it mirrors.

- `extensions/goal-service.ts`: `beginTurn`, `flushTurn` (vanish / revision-conflict / write-throw / commit branches), buffered `apply`, buffered `updateTask`, `persist` usage-delta merge, `usageDelta`/`trackBaseline`
- `extensions/storage/goal-lock.ts`: `acquireGoalLock` mutual exclusion and bounded contention
- `extensions/goal-events.ts`: turn_start `beginTurn` (line 100), turn_end `endTurn` (line 249), pre-reload flushes
- `extensions/goal-state.ts`: flush-before-focus-switch in `assignFocusedGoalId` (line 429)
- Bounds: revisions 0–3, usage 0–6, statuses {active, complete}, one goal plus unfocus, ≤2 buffered mutations per turn. Unfocus exercises every flush branch that a second concrete goal would (buffer pending for a goal that is no longer focused); `flushError` and `focusRevision` are not modeled (no invariant depends on them).
- Sync commit: `64c5ace` (verified 2026-10-23). If any file above changed after that commit, re-derive the model before trusting a pass.

## Read a failure

Map TLC's trace steps to code via the action's code-reference comment, then check drift first.

- `MutationConservation` — a path clears or loses the turn buffer without committing or explicitly rejecting it: silent loss of user mutations.
- `LedgerCausality` — ledger events appended for a transaction that was rejected or never written.
- `InvUsageMonotone` / `InvRevMonotone` — a flush overwrote a concurrent writer's revision or usage (lost update).
- `InvQuiescent` — memory kept a record the disk never had after a clean flush (partial commit).
- A violation can be modeling drift rather than a code bug: diff the named function against the action before touching product code.

## Update after intentional changes

1. Edit the matching action in the `.tla` to mirror the new code path (bounds are the `REVS`/`USAGES`/`*MAX` definitions at the top).
2. Re-run. Move the sync commit forward only after confirming the model still describes the code at the new commit.
3. Sanity-check the property can still fail: apply one mutation from the baseline below, confirm TLC reports the violation, revert it.

## Mutation baseline (each was shown to fail the check)

- Delete the `freshDisk.revision !== expected.revision` conflict branch in `flushTurn` (commit anyway) → `InvUsageMonotone` / `InvRevMonotone` counterexample.
- Append `turn.ledger` on the conflict-reject path (ledger before/without its write) → `LedgerCausality` counterexample.
- Clear `turn.goal` on conflict without counting a rejection → `MutationConservation` counterexample.

## Not covered

- Focus-token invalidation for async completions (`isTokenCurrent` guards; unit-tested in `tests/goal-service.test.ts`, not modeled).
- `updateTasks` immediate path and `updateTaskAttempt` retry (same lock-plus-recheck pattern as the immediate `apply` path, not modeled).
- Lock-ignoring rogue writers inside the critical section; stale-lock recovery races in `goal-lock.ts`.
- Usage over-charging beyond monotonicity; `GoalAccounting` double-charge; budget `budget_limited` transition (covered by `tests/goal-budget.test.ts`).
- Ledger IO failure diagnostics (best-effort `onDiagnostic` path).

After changes that touched the covered files without rechecking the model, `/maintain-formal-verification-skill` brings it back in line.
