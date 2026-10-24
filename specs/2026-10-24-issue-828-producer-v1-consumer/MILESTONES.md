# Implementation and validation log

## Baseline and red tests

Preserved all existing group1/3 and group2 uncommitted changes. Saved the starting tracked diff in /tmp/pgx828-fix/consumer-v1-before.diff. Read brief, implemented wire, group2 result and proposal in full. No producer edits or dependency installs.

Seven new v1/F3/F4 cases initially failed, while the previous ten correlation tests passed. Evidence is consumer-v1-red.tap. A later actual workflow_control status-summary test failed before adding terminal-only summary handling, recorded in consumer-v1-control-red.tap.

The first implementation command used unavailable python, made no edits and left tests red. Reran with python3. A public JavaScript fixture import in a TypeScript test failed check, so the hook test moved into the existing mjs fixture rather than adding a suppression.

## Authorized expectation migrations

- Original34 case4 uses actual v1 launch, completed lifecycle and no-status host details in lifecycle-host order without a sibling.
- Case5 uses the same implemented wire with a sibling.
- Case6 uses actual v1 in host-lifecycle order without a sibling.
- Case7 uses that order with a sibling.
- Case20 uses actual v1 for the completed execution and a duplicate launch with a new receipt. It still asserts no implicit resume.
- Old24's task-report wake case now starts BG with details.task and delivers the verified native background-task-notification snapshot, instead of treating ordinary user text as a report.

These are the explicitly authorized contract-route migrations. Four equivalent public legacy order/sibling tests and an ordinary-user generic deadline test prove fail-closed behavior through the original 660000ms deadline. The legacy duplicate receipt is exercised in those order tests. No original requirement was skipped or deleted. Original explicit legacy resume remains covered separately.

## v1 and cold persistence checkpoint

The target suite reached 87/87 after the initial v1/control additions. New public-hook tests use both event orders, three siblings, a spent +10m check and independent work. A real child process deletes pool snapshots, parses canonical state, restores the extension, rejects conflicting and late-old delivery IDs, observes an idempotent epoch2 resume receipt and accepts only a fresh epoch2 report. It asserts a no-status report does not invent completed.

## Followup F1/F2/F5

After the v1 checkpoint, incorporated the parent's followup correct-behavior tests. Their current-repo run reproduced five failures among eleven cases. consumer-followup-red.tap captures the red run. Added per-task provenance inside the existing registry, explicit null call origin and boolean replacement failure propagation. A mechanical draft guard insertion initially landed in rehydrateDraft; check and the unchanged draft assertion caught it. Moved the guard to the real replaceGoal caller. The followup tests passed without weakening assertions.

Self-review added an optional-origin takeover regression and an additional current-owner filter to v1 host matching. New-owner report handling is tested independently from preserving old-session deadlines. The original direct-command warning assertions remain unchanged.

## Environment isolation and limits

Default complete unit initially reported 1133/1136 with three Oracle configuration failures. A separate untouched HEAD archive reproduced the same 62/65 in the two affected files. Setting only the test-process PI_GOAL_GLOBAL_SETTINGS_FILE to an absent scratch path yielded 65/65 on both baseline and candidate. No settings file or user model selection was changed. Candidate isolated full unit subsequently passed 1151/1151 before the last two followup tests. Final counts are recorded in the task result.

Existing flush and completion TLC runs passed. They do not model the new producer parsing, epoch association or per-task provenance. Real producer/model smoke is deferred to the parent. Producer queue/ACK completeness and storage snapshot-public-contract limits remain outside this consumer claim.

Decision trail and raw outputs are under /tmp/pgx828-fix/consumer-v1-decisions.tsv and consumer-*.log/tap. No commit, push, PR, ticket, install or global configuration change was made. The parent owns final review and commit.

## Final gates

- Target four files pass 100/100, including original34, correlation/public native/cold/followup, old24 and subagent receipts. consumer-final-target.log.
- Complete unit passes 1153/1153 with only process-local absent-global-settings isolation. consumer-final-unit.log.
- npm run check passes. consumer-final-check.log.
- npm run test:selfcheck passes with the same process isolation and 1153/1153. consumer-final-selfcheck.log.
- Candidate extension loads on real Pi RPC with no model call. Doctor returns ok=true, disposition=handled, sawUi=true. consumer-final-rpc.log and consumer-v1-rpc-doctor/rpc-transcript.jsonl.
- git diff --check passes. Staged files remain empty. No commit was created.

Self-review inspected the stage-only scheduler diff reconstructed from the saved initial diff, plus registry parsing, canonical normalization and all replaceGoal callers. Existing group1/3 changes remain present. The mandatory no-comments and cross-model trail review delegation were not run because the explicit task prohibits agents. Independent final review belongs to the parent, not this self-review.

## Final producer reconciliation

Parent supplied committed producer 5a9913b34ac9cd67e3531091ed01202a26fb309d. Read the updated implemented contract in full, verified HEAD and clean producer worktree, and rechecked host src/dist, lifecycle execution identity, control.run and sync details. Queue/ACK is now implemented by producer. This supersedes the earlier minimal-wire-only producer status, without upgrading consumer fixture evidence to real cross-repository integration.

Added a foreground-sync fixture that carries real details identity and ordinary completed structuredContent but never enrolls a background wait. Final target is 101/101. Final isolated complete unit and selfcheck are both 1154/1154. Check passes. Raw final logs retain their consumer-final names. Producer remains read-only and runtime installation is unchanged.

## Final independent review R1/R2 corrections

Read consumer-final-review.md R1/R2 and adversarial.test.mjs. Only the two confirmed P2 findings were repaired. PRODUCT and TECH were updated before implementation. No agents, producer writes, installs, tickets, README changes, staging or commits.

Added three public regressions in issue-828-followup.mjs. Two create and settle real extension BG/v1 receipts, rewrite only the verified old BG namespace in the canonical file, and invoke parseGoalFile. They require normalized namespace, matching native report, unchanged task/root scopes, receipt, v1 sibling identity and allocated budgets. The third delivers the actual producer foreground sync details through tool_result and settles through public events. It requires ready, no foreground task, and unchanged sibling registry/budget.

Before production changes, the new cases failed 0/3, exit 1. The actual parser retained structured:bg_run or structured:bg_status; the actual sync settlement remained waiting instead of ready. Evidence is /tmp/pgx828-fix/r1-r2-red.tap. The scheduler root now retains normalizeBackgroundTasks's returned state. Host matchers have no added legacy namespace branch. A valid same-session successful non-background v1 workflow result returns observed=false and uses the existing mechanical progress path. Background, error and invalid-identity guards remain in place.

The first complete unit and selfcheck attempts each exited 1, 1156/1157. Existing scheduler rollback coverage caught an added backgroundTasks:undefined key on records that originally lacked the property. Preserved that absent-field shape without changing the test. The final complete unit and selfcheck each pass 1157/1157, exit 0, 0 skipped, 81 files. This supersedes the earlier 1154 count. Final targeted four files pass 104/104, exit 0, preserving the original 101 plus these three. Check and git diff --check exit 0. Logs are r1-r2-final-target.tap, r1-r2-final-check.log, r1-r2-final-test-unit.log and r1-r2-final-test-selfcheck.log under /tmp/pgx828-fix. All test gates use process-local absent-global-settings isolation and unset PI_SUBAGENT_CHILD/DEPTH.

An initial RPC doctor mistakenly inherited the child guard and exited 1 with disposition=started, sawUi=false. Retrying with those delegation variables unset passed, exit 0, ok=true, disposition=handled, sawUi=true. Evidence is /tmp/pgx828-fix/r1-r2-rpc-doctor-clean. This is extension load/health evidence, not real-model completion proof.

Manual review checked the two production changes, their registry/progress callers and canonical parser assertions. Existing uncommitted work remains intact. No new application comments, casts, suppressions, helpers or dependencies were added. Principles applied were Fix Root Causes for root normalization and observation semantics, Test Behavior Not Implementation for public parser/events, Model the Domain for retaining the existing registry, Laziness Protocol for reusing postTaskProgress, and Prove It Works for recording failed and final gate exits.

The main reviewer already owns the real sibling smoke evidence, including the 76waiting sample, unchanged budgets and two host reports. It was not repeated here. Completion audit is unfinished; this is not a claim of complete goal completion. test:all was not rerun. Its two known baseline network E2E failures remain separate and unmodified, per /tmp/pgx828-fix/network-e2e-diagnosis.md. That report also identifies the existing Pi 1.4 custom-before_agent_start compatibility limitation after fixture focus is corrected. No network compatibility or fixture fix is included. Prior storage/snapshot and cross-session transfer limitations remain unchanged.
