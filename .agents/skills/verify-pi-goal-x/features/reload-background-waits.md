# Reload background waits

## Sub-features

- Preserve unresolved task identity across a real saved-session restart.

## How to get to it (user POV)

Close pi while a task is waiting and reopen the exact saved verification session. Do not create another goal.

## Driving it with rpc-drive.mjs

Create a supplied scratch project with maxAutonomousRuns:3 and disabled:true. Run a launch-only version of the background scenario with PI_GOAL_VERIFY_SESSION_DIR and receipt-producer.ts; stop after waiting snapshot. Reopen its saved JSONL with PI_GOAL_VERIFY_SESSION and send /goal-list, wait for phase waiting, snapshot restored.

## Gotchas

Compare task producer/id/scope and hostReported:false before/after. Undeclared deadline and check remain absent, used allowance is not reset, no new launch occurs. This is a real pi restart with receipt replay. It does not prove a real producer orphan-stop implementation; that needs its actual pstack-agents record and source producer. --no-session is a different path and deliberately loses focus.
