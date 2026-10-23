# Pause and health check

## Sub-features

- `/goal-pause` persists the `paused` status to the goal file and appends a ledger event.
- `/goal-status health` reports a read-only coherence check: focus, lifecycle, file presence, ledger, task progress.

## How to get to it (user POV)

Create or focus a goal, run `/goal-pause` to stop autonomous continuation, run `/goal-status health` any time for a checkup.

## Driving it with rpc-drive.mjs

```json
{"send": {"id": "c1", "type": "prompt", "message": "/goal-direct Verify: pause and health"}}
{"wait": 1200}
{"snap": "active"}
{"send": {"id": "c2", "type": "prompt", "message": "/goal-pause"}}
{"wait": 1500}
{"snap": "paused"}
{"send": {"id": "c3", "type": "prompt", "message": "/goal-status health"}}
{"wait": 1200}
```

## Observable end state

- `snaps/paused/active_goal_*.md` has `"status": "paused"` (was `"active"` in `snaps/active/`), and its `revision` incremented.
- `goal_events.jsonl` gained a pause event after the `goal_created` line.
- The `/goal-status health` `notify` record in the transcript names the goal and reports coherent state without changing anything: `diff -r snaps/paused <post-health snap>` empty if you add one.

## Gotchas

- `/goal-pause` needs a focused goal in this session; create with `/goal-direct` in the same run (focus is session-local).
- With several open goals and no focus, `/goal-pause` opens a `select` dialog; the drive above keeps a single focused goal to avoid it.
