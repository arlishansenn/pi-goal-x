---
name: verify-pi-goal-x
description: "Drives the real pi coding-agent with the pi-goal-x extension loaded (RPC mode over stdio) to verify goal lifecycle behavior end to end. Use when a change touches extensions/ or scripts/ and you need proof on the real surface, or when asked to verify, reproduce, or dogfood any /goal command, goal tool, dashboard, or audit flow."
---

# Verify pi-goal-x

pi-goal-x is a pi coding-agent extension. The real surface is a pi session with the extension loaded. This skill drives that session headlessly through pi's RPC mode, exercises commands the way a user would, and captures RPC transcript plus on-disk goal state as evidence. No model calls and no npm install are needed for command-only verification.

## Launch

One-shot print mode runs a single command and exits. It writes goal state but prints nothing; use it only for setup steps.

```bash
pi -ne -e /Users/admin/project/pi-goal-x/extensions/goal.ts --print "/goal-direct <objective>"
```

The interactive harness is RPC mode. Always run it in a throwaway project directory: goal state lives in `<cwd>/.pi/goals/` and is real user data in any other directory.

```bash
WORK=$(mktemp -d /tmp/pgx-verify.XXXXXX)
cd "$WORK" && pi --mode rpc --no-session -ne -e /Users/admin/project/pi-goal-x/extensions/goal.ts
```

- `-ne` disables every discovered/configured extension so only this extension answers. `-e <path>` loads it for one invocation without touching any settings file.
- pi loads the TypeScript through jiti; the repo's empty `node_modules` is fine (verified).
- Ready signal: the process stays alive and emits JSONL on stdout. It is ready when `{"id":"...","type":"get_state"}` gets a `success: true` response.
- Teardown: kill the pi process you spawned (`rpc-drive.mjs` does this). Never kill by name; `pgrep -f "pi-goal-x/extensions/goal.ts"` may match the user's own sessions.
- Two instances run side by side in separate scratch directories (locks and state are per-directory). Never point two drives at the same directory.

## Doctor

Run before anything looks off, read-only:

```bash
node /Users/admin/project/pi-goal-x/.agents/skills/verify-pi-goal-x/rpc-drive.mjs \
  doctor <evidence-dir>
```

The helper creates its own scratch dir, sends `/goal-status health`, and passes when the `prompt` response has `disposition: "handled"` and at least one `extension_ui_request` record appeared (only our extension emits UI under `-ne`). Failure means the extension did not load: check `pi --version`, the repo path, and stderr in `<evidence-dir>/rpc-transcript.jsonl`.

## Drive

Use `rpc-drive.mjs`. A drive script is JSONL with four step kinds:

```json
{"autoDialog": {"confirm": {"confirmed": false}, "select": {"cancelled": true}, "input": {"cancelled": true}}}
{"send": {"id": "c1", "type": "prompt", "message": "/goal-list"}}
{"wait": 1500}
{"snap": "after-goal-direct"}
```

- `send` writes any RPC record to pi (`prompt`, `get_state`, ...).
- `autoDialog` installs answers for blocking dialogs. pi blocks until each dialog gets an `extension_ui_response`; set the policy BEFORE the command that opens the dialog. Respond with the full response body, e.g. `{"confirmed": false}` or `{"value": "Option A"}` or `{"cancelled": true}`.
- `wait` sleeps milliseconds (commands are asynchronous; the `response` record means accepted, not finished).
- `snap` copies the whole `.pi/goals/` tree into the evidence dir under a label.
- Command output is observable as `extension_ui_request` records: `notify` carries the printed text (e.g. `/goal-list` output), `setStatus` carries the status line (e.g. `goal: unfocused [1 open]`), `setWidget` the dashboard payload.

Run a drive:

```bash
node /Users/admin/project/pi-goal-x/.agents/skills/verify-pi-goal-x/rpc-drive.mjs \
  run <workdir|auto> <drive-script.jsonl> <evidence-dir>
```

`auto` creates a fresh scratch dir. The helper tees every stdout record (with receive timestamps) to `<evidence-dir>/rpc-transcript.jsonl`, kills pi at the end, and prints record counts.

The TUI surface (Goal Beacon widget rendering, Esc pause, Ctrl+Shift+T overlay) is not visible in RPC mode. For those, run the same launch line without `--mode rpc` inside a tmux pane in the scratch dir and drive keys (`tmux send-keys`), capturing `tmux capture-pane -p`. Same scratch-dir rule applies.

## Evidence

A proof needs all three, captured per feature run:

1. The action: the drive script plus the request/response records in `<evidence-dir>/rpc-transcript.jsonl` (`disposition: "handled"` for each command).
2. The resulting state: `<evidence-dir>/snaps/<label>/...` copies of `.pi/goals/` (goal markdown, `goal_events.jsonl`, lock dir state). Key files: `active_goal_<timestamp>_<id>.md` (v3 JSON record) and `goal_events.jsonl` (append-only ledger).
3. Side-effect checks beyond the visible: hash the goal file and ledger before and after a no-op claim (`shasum -a 256`), count ledger lines before/after, and diff snapshot trees.

Standards: exercise the real user path (slash commands through `prompt`), never write goal files directly to set up state; use `/goal-direct` for setup. Mocks are unnecessary: the extension's external boundary (the auditor's model call) is only reached by `update_goal complete`, which the feature map drives with the auditor disabled or leaves to manual runs. Evidence survives cleanup; it lives under `/tmp/pi-goal-x-verify-evidence/<timestamp>-<label>/` until the machine restarts (copy it into the repo or an issue when it must persist).

## Cleanup

`rpc-drive.mjs` kills the pi process it spawned and leaves everything else. After a manual run:

```bash
rm -rf "$WORK"            # the scratch project dir this run created
```

Do not delete the evidence dir. Do not run cleanup against any directory that existed before the drive; the skill never writes outside `$WORK` and the evidence dir.

## Helpers

- `rpc-drive.mjs` — the launcher/driver above. `node rpc-drive.mjs` with no args prints usage. Invocations shown in Doctor and Drive.
- `features/` — the feature map. `features/README.md` indexes it; each file gives the user-POV steps, the drive script, and the observable end state for one feature. A proof that drives one convenient entry point is incomplete when the map lists others.

After app changes, `/skill:maintain-verification-skill` keeps the map honest.
