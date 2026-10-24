# Issue 825 smoke evidence

Runtime under test: installed package `git:github.com/arlishansenn/pi-goal-x@38db4dc`
(fork main after PR #8), driven per the verify-pi-goal-x skill conventions.

| Run | Producer / path | Timeline | Verdict |
|---|---|---|---|
| `20261024-094843-issue825-smoke-workflow/` | dynamic workflows 3.14.0, `workflow background=true` | 1 checkpoint (kickoff) → launch 21.6s → settle 27.4s → system wait (`phase=waiting`, task tracked, budget +10m/+11m) → 0 busy checkpoints. Lifecycle `completed` recorded at wait time. | Detection + wait verified. Native delivery **deferred by the producer in RPC mode** (`[workflow-delivery] delivery … deferred: endpoint for session…`): RPC sessions expose no delivery endpoint, so the wake could not run there. |
| TUI session (interactive, same sources) | dynamic workflows, real terminal | Workflow finished → main thread woke → model read results (`word1=hello word2=world`), wrote `result.txt`, `update_goal complete`. | Native delivery wake verified interactively; RPC deferral is a producer/environment artifact, not a fix gap. |
| `20261024-094843-issue825-smoke-failure/` | pi-subagents, failing command inside a completing agent | 1 checkpoint → launch → wait → notify `completed` (agent reported the failure) → wrote `failure.txt` → complete. | Wake + handling on a success-status report carrying failure content. |
| `20261024-095156-issue825-smoke-failed-status/` | pi-subagents, `maxRuntimeMs: 20000` + `sleep 300` | 1 checkpoint → launch 42s → wait → notify **`failed`** ("Subagent timed out") 63.4s → model verified the kill, wrote `failure.txt`, `update_goal complete`; goal never auto-paused, no sibling cancellation. | Real failed-status wake and recovery. |

Baseline (ticket #825): 不空转 = every run exactly 1 checkpoint; 完成唤醒 =
subagent completed + failed statuses and workflow interactive delivery all wake the
thread exactly once; 失败可恢复 = failed notify handled without pausing the goal
or cancelling anything.

pi-background-tasks is not installed on this machine; per spec #828 its coverage
stays contract-level (generic nested-lifecycle path, upstream PR #83 live claim),
not a real smoke.
