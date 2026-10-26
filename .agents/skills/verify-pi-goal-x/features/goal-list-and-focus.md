# Goal list and focus

## Sub-features

- List the open pool, select a goal, and detach session focus.

## How to get to it (user POV)

Run /goal-list, /goal-focus and /goal-unfocus. Multiple goals may require a select dialog; this recipe uses one.

## Driving it with rpc-drive.mjs

Run scenarios/commands.jsonl. Compare paused, focused and unfocused snapshots; read notify and setStatus records.

## Gotchas

Focus appends goal_focused. Unfocus may pause/persist through the current command path, so a whole-directory no-op or unchanged revision is not a valid general assertion. Require the same goal id/objective, starred listing when focused, and unfocused [1 open] after detachment. Never treat session focus as a goal-file field.
