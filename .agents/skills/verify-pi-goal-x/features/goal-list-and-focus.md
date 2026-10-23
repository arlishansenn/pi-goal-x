# Goal list and focus

## Sub-features

- `/goal-list` prints id, status, objective title, and file path for every open goal.
- `/goal-focus` selects the sole open goal without a dialog; focus is session-local.
- `/goal-unfocus` clears only the session focus; the goal file and pool are untouched.

## How to get to it (user POV)

With at least one open goal, run `/goal-list` to see the pool, `/goal-focus` to work on one, `/goal-unfocus` to detach the session while leaving the goal open.

## Driving it with rpc-drive.mjs

Setup in run 1 (`/goal-direct`), then in the same run:

```json
{"send": {"id": "c1", "type": "prompt", "message": "/goal-direct Verify: focus flow"}}
{"wait": 1200}
{"snap": "before-focus"}
{"send": {"id": "c2", "type": "prompt", "message": "/goal-focus"}}
{"wait": 1200}
{"send": {"id": "c3", "type": "prompt", "message": "/goal-unfocus"}}
{"wait": 1200}
{"snap": "after-unfocus"}
```

## Observable end state

- `/goal-list`'s `notify` record lists the same goal id and path present in `snaps/before-focus/`.
- After `/goal-focus`: a `setStatus` record names the focused goal (no `unfocused`).
- After `/goal-unfocus`: `setStatus` shows `unfocused [1 open]`.
- `diff -r snaps/before-focus snaps/after-unfocus` shows no goal-file or ledger change (focus lives in session entries, not files; with `--no-session` nothing is persisted at all).

## Gotchas

- `/goal-focus` with multiple open goals opens a `select` dialog; set `{"autoDialog": {"select": {"value": "<option label>"}}}` first. The sole-goal path avoids the dialog and is what this feature drives.
- `/goal-list` output arrives as one `notify` record; read it from the transcript, not stdout of the helper.
