# Direct goal creation

## Sub-features

- `/goal-direct <objective>` creates a regular active goal with autoContinue.
- Creation focuses the goal in the creating session.
- The goal pool on disk survives process restart; a fresh session starts unfocused with the goal open.

## How to get to it (user POV)

Type `/goal-direct <objective>` in a pi session. The dashboard shows the focused active goal. Restart pi in the same project: the goal is listed as open but the new session is unfocused until `/goal-focus`.

## Driving it with rpc-drive.mjs

Two runs against the same workdir (persist across restart). `create.jsonl` (run 1 only):

```json
{"send": {"id": "c1", "type": "prompt", "message": "/goal-direct Verify: create a scratch goal file"}}
{"wait": 1500}
{"snap": "after-create"}
{"send": {"id": "c2", "type": "prompt", "message": "/goal-list"}}
{"wait": 1200}
```

`restart-check.jsonl` (run 2, same workdir, NO /goal-direct — it would create a second goal):

```json
{"send": {"id": "r1", "type": "prompt", "message": "/goal-list"}}
{"wait": 1200}
{"snap": "after-restart"}
```

```bash
EV=/tmp/pi-goal-x-verify-evidence/$(date +%s)-goal-direct
mkdir -p "$EV"
node /Users/admin/project/pi-goal-x/.agents/skills/verify-pi-goal-x/rpc-drive.mjs run auto create.jsonl "$EV" > "$EV/run1.json"
WORK=$(tail -1 "$EV/run1.json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["work"])')
node /Users/admin/project/pi-goal-x/.agents/skills/verify-pi-goal-x/rpc-drive.mjs run "$WORK" restart-check.jsonl "$EV" > "$EV/run2.json"
```

## Observable end state

- `snaps/after-create/` and `snaps/after-restart/` each contain exactly one `active_goal_*.md` with the same id: JSON with `"status": "active"`, `"objective"` equal to the argument, `"revision"` ≥ 1, followed by a `# Goal Prompt` markdown section.
- `goal_events.jsonl` first line is `goal_created` with the same `goalId` as the file name. After run 2 it still has one `goal_created` (no duplicate creation).
- Run 1 transcript has a `setStatus` record containing `goal: ` (focused). Run 2 transcript has a `setStatus` record containing `unfocused [1 open]` and a `notify` from `/goal-list` naming the goal id.

## Gotchas

- `--no-session` means focus does not persist across the two runs; that is expected and is part of the proof, not a failure.
- Run 2 must not repeat `/goal-direct`: it would create a second goal and break the single-goal assertions.
- The queued autoContinue continuation may attempt a model turn; in RPC mode it needs configured credentials and the transcript may show retry events. They do not affect the disk assertions above.
