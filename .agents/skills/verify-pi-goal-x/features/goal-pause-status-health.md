# Pause and health check

## Sub-features

- Pause an active goal.
- Read health without changing stored state.

## How to get to it (user POV)

Create a goal, run /goal-pause, then /goal-status health.

## Driving it with rpc-drive.mjs

Run scenarios/commands.jsonl. Compare created to paused, then paused to health.

## Gotchas

Paused goal has status paused and a higher revision; ledger includes goal_paused. Health must leave goal and ledger bytes unchanged. Health is a coherence report, not proof that a background notification was consumed or that its deadline is valid. For that inspect task fields in the background recipe.
