---
name: goal-completion-audit
description: "Model-checks the goal completion flow (update_goal complete -> flushForAudit -> focus-token capture -> independent auditor or skip -> single commit -> deferred archival at turn_end) with TLC. Use after editing extensions/goal-completion.ts, the complete executor in extensions/goal-core-tools.ts, the auditor dispatch in extensions/goal-auditor.ts, or the turn_end archival handler in extensions/goal-events.ts, and before claiming a change to completion, auditing, or archival ordering is safe."
---

# Goal completion audit verification

Verified property, one sentence: a completion attempt either archives nothing or commits the goal to complete exactly once through a still-current focus token, appends at most one terminal audit event (audit_result or audit_skipped, never both), never completes on a disapproved or errored audit, never requests termination from a failed commit, and archives only at turn_end after the commit.

Harm if broken: a goal the auditor rejected gets archived anyway; a completion queued before the user switched focus mutates a detached session's goal; the ledger records contradictory audit outcomes; the goal archives before the agent sees the audit result.

## Run

```bash
node .agents/skills/goal-completion-audit/run-tlc.mjs
```

Needs `java` (17+) on PATH. First run downloads tla2tools 1.7.4 to `~/.cache/pi-goal-x-tla/` (override with `PI_GOAL_X_TLA_JAR`). Success prints `Model checking completed. No error has been found.` and exits 0. The runner passes `-deadlock`: terminal quiescent states (archived goal, budget of attempts spent) are expected, not errors; only invariant violations fail.

## Coverage record

Every action in `model/GoalCompletionAudit.tla` names the code it mirrors.

- `extensions/goal-completion.ts`: `runGoalCompletionFlow` (flushForAudit gate, validateGoalCompletion + task gate, `completionFocus` capture, skip branches, the two mid-flight `isFocusedOperationCurrent` checks, the post-audit check, Escape dialog bypass/continue), `commitGoalCompletion` (apply with focusToken, write-failure result, `markTurnStopped`, terminate flag, deferred non-archival)
- `extensions/goal-state.ts`: `focusedOperationToken` / `isFocusedOperationCurrent` semantics, `assignFocusedGoalId` revision bumps
- `extensions/goal-events.ts`: turn_end deferred archival
- Bounds: ≤2 completion attempts, focus revision 0–4, single goal. Auditor agent internals (`goal-auditor.ts` prompt, marker parsing) are abstracted to a nondeterministic verdict.
- Sync commit: `2870376` (verified 2026-10-23). If any file above changed after that commit, re-derive the model before trusting a pass.

## Read a failure

Map TLC's trace steps to code via the action's code-reference comment, then check drift first.

- `InvTokenGuard` — a completion committed with a stale focus token (detached/switched session mutated the shared goal).
- `InvOutcomeExclusive` — an attempt appended more than one terminal audit event, or events without a started attempt (phantom ledger outcome).
- `InvArchiveOrder` — archival happened inside the completion transaction instead of at turn_end, or without a committed completion.
- `InvDisapprovedStaysOpen` — a disapproved or errored audit completed or archived the goal.
- `InvTermAfterCommit` — termination was requested from a failed or cancelled commit.
- `InvCompleteOnce` / `InvAttemptConservation` — double completion; an attempt vanished without committing, rejecting, or cancelling.
- A violation can be modeling drift rather than a code bug: diff the named function against the action before touching product code.

## Update after intentional changes

1. Edit the matching action in the `.tla` to mirror the new code path (bounds are `REVMAX`/`ATTMAX` at the top).
2. Re-run. Move the sync commit forward only after confirming the model still describes the code at the new commit.
3. Sanity-check the property can still fail: apply one mutation from the baseline below, confirm TLC reports the violation, revert it.

## Mutation baseline (each was shown to fail the check)

- Commit without the focus-token guard → `InvTokenGuard` counterexample.
- Append a terminal audit event when entering the Escape dialog (before the user chooses) → `InvOutcomeExclusive` counterexample.
- Archive inside the commit instead of at turn_end → `InvArchiveOrder` counterexample.
- Route disapproved/errored verdicts to the commit → `InvDisapprovedStaysOpen` counterexample.

## Not covered

- Auditor agent internals: prompt construction, `<approved/>` marker parsing, model/provider selection, warm-start context (abstracted to a nondeterministic verdict).
- The GoalService apply/flush internals under the commit (covered by the `goal-flush-transaction` skill).
- Rejection UX (result cards, audit messages), accounting at commit, widget invalidation.
- Concurrency between two simultaneous completion attempts (pi serializes tool calls per session; the model assumes one attempt at a time).

After changes that touched the covered files without rechecking the model, `/maintain-formal-verification-skill` brings it back in line.
