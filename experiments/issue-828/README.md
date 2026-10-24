# Issue 828 prototype evidence

Fix branch: `prototype/issue-828` on this fork. Spec:
[server-tool-extension#828](https://github.com/arlishansenn/server-tool-extension/issues/828).

| Artifact | What it proves |
|---|---|
| `20261023-235755-issue828-repro-main/rpc-transcript.jsonl` | Red: fork main (c5c7f33) busy-loops. Real model + real pi-subagents async run (`sleep 110`): 27 consecutive checkpoint→「仍在等待…结束回合」 cycles between launch settle (23.9s) and the completion notify (150.7s); goal record shows `scheduler.used: 30`. |
| `20261024-003119-issue828-fixed-prototype/rpc-transcript.jsonl` | Green: same drive on the fix. Exactly 1 checkpoint (kickoff); the async launch receipt raises a system wait (`phase=waiting`, task tracked with one +10m check / +11m deadline budget); zero checkpoints during the 126s wait; the native `subagent-notify` discharges the task, wakes the thread, and the model writes `result.txt` and completes the goal. `snaps/` holds the goal record at t=50s (waiting) and final (task completed + reported). |
| `tui-captures/` | Real TUI (tmux) at the same wall-clock moments. main: `goal: running [1m07s]` keeps self-continuing; fix: `goal: Waiting for pi-subagents task 7f92d02f… to finish`. Session totals: main ↑12k ↓1.9k $0.273 vs fix ↑4.5k ↓876 $0.047. |
| `issue828-proof.png` | Rendered comparison page of the four TUI captures with the KPI deltas. |

Red/green at the public boundary: `tests/goal-subagents-receipt.test.ts` (8
tests, sanitized real receipts) fails on c5c7f33 and passes on the fix branch.

Reproduction driver: `/tmp/pgx-repro/repro-drive.mjs` pattern (pi RPC mode,
`-e extensions/goal.ts -e …/pi-subagents/bundle/index.js`, objective asks for
one async subagent; evidence per the verify-pi-goal-x skill conventions).
