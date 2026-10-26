---
name: verify-pi-goal-x
description: "Drive pi-goal-x through real pi RPC or its terminal UI. Use to verify goal commands, background waits, pstack terminal reports, session reload and confirmed legacy-task recovery. Keep real producer, receipt replay and controlled-clock evidence separate."
---

# Verify pi-goal-x

## Launch

Run from the checkout root. The executable helper resolves `extensions/goal.ts` relative to itself. It disables ambient extensions, skills, prompt templates and MCP. `pi` must be on PATH. TypeScript loads through pi's runtime; model-backed scenarios additionally need an authenticated model.

```bash
V=.agents/skills/verify-pi-goal-x
node "$V/rpc-drive.mjs" doctor /tmp/pgx-proof-doctor-new
PI_GOAL_VERIFY_SETTINGS='{"maxAutonomousRuns":0}' \
  node "$V/rpc-drive.mjs" run auto "$V/scenarios/commands.jsonl" /tmp/pgx-proof-commands-new
```

`auto` creates and removes an owned scratch project. A supplied directory must be an explicitly created verification project, never the user's checkout or active goal directory. The helper leaves supplied directories for restart tests. It always terminates only its own child pi. Two runs may coexist only with different project, session and evidence directories.

## Doctor

Every `run` first sends `get_state` and `/goal-status health` to the same instance it will drive. Both must return successful correlated responses and goal UI output must appear. A surprising failure requires a fresh instance and a new evidence directory; do not continue on a wedged process.

A separate `doctor` is a launch smoke check, not a replacement for each run's own doctor. It creates no goal, calls no model and removes its scratch project. Evidence remains.

## Drive

The helper consumes JSONL steps. `send` waits for the matching response and fails on rejected commands. `autoDialog` answers dialogs immediately; an unconfigured dialog cancels and fails the drive. A prompt response means accepted, not completed. Use `waitForGoal` or `waitForRecord` for asynchronous work.

```json
{"autoDialog":{"confirm":{"confirmed":false}}}
{"send":{"type":"prompt","message":"/goal-clear"}}
{"waitForGoal":{"status":"paused"},"timeoutMs":15000}
{"snap":"after-command"}
```

Dot paths in conditions compare literal values. `null` means absent or null. Snapshot labels are unique. Each evidence directory must be new, so runs cannot overwrite or mingle transcripts.

Environment options are verification-only launch controls, not product settings:

- `PI_GOAL_VERIFY_SETTINGS` writes JSON project settings only for `auto` scratch projects. Use `maxAutonomousRuns:0` for command-only checks to prevent accidental model work. For a supplied scratch project, create its settings explicitly before launch.
- `PI_GOAL_VERIFY_EXTENSIONS` is a JSON array of extra extension paths. Use a real producer for integration proof or the clearly labeled `receipt-producer.ts` for notification-contract replay.
- `PI_GOAL_VERIFY_SESSION_DIR` enables persistent verification sessions in the specified scratch directory.
- `PI_GOAL_VERIFY_SESSION` opens one saved verification session for same-session reload. Do not point it at a user's real session. Without either option, `--no-session` makes each run unfocused on restart.

The four basic command features share `scenarios/commands.jsonl`. The background recipe is `scenarios/background.jsonl`. Read the feature map before choosing additional steps.

## Evidence

Each run records its launch options, sent actions, received JSONL, stderr and failures in `rpc-transcript.jsonl`. It copies the drive script, snapshots `.pi/goals/` under `snaps/<label>/`, and records owned-process teardown in `cleanup.json`. Goal markdown begins with JSON followed by `# Goal Prompt`; do not parse the entire file with `JSON.parse`.

Prove both action and side effect. Compare goal identity/status, task `hostReported/outcome`, absence or exact value of a declared deadline, ledger events, and recovery backup bytes. `goal_focused` is a legitimate ledger mutation. Do not assume focus/unfocus is a directory-wide no-op. Check cancel on a paused, quiescent goal and assert exact bytes.

Distinguish evidence types in every report:

- **Real producer.** Load the actual producer, run its child and retain native notifications plus child/session records. Historical issue #10 evidence is in `experiments/issue-10/`; it is not a new maintenance run.
- **Receipt replay.** `receipt-producer.ts` emits structural launch/terminal records through real pi, but starts no child. Its passing result proves the consumer protocol only.
- **Controlled clock.** Product tests prove eleven-minute and deadline edges without elapsed wall time. Reference their current results separately; do not call them live-runtime proof.
- **Application screenshot.** Run pi in an isolated terminal and capture that application window, together with terminal text and session records. A screenshot of a custom HTML evidence page is not an application screenshot.

Keep evidence outside scratch workdirs, for example `/tmp/pgx-map-maintenance/<run>/`. `/tmp` is not durable across restarts; copy required proof to a retained location before handoff. Never capture unrelated desktop windows or credentials.

## Cleanup

The helper terminates its exact child pid and removes only automatically created projects. Inspect `cleanup.json` and verify the transcript and snapshots still exist. For supplied scratch projects, remove only paths you explicitly created after the last restart/recovery drive. Producer-created children must also exit; the real producer's shutdown contract must be observed rather than assumed.

## Helpers

`rpc-drive.mjs` is executable and supports `doctor` and `run` as above. `receipt-producer.ts` is a pi extension scaffold, loaded only with explicit `-e`; it registers `agent` and `/verify-report completed|failed|stopped` and never launches a real child.

`features/README.md` indexes maintained feature recipes. Product failures belong in a separate report, never a documentation change that makes a broken behavior look correct. Use `/skill:maintain-verification-skill` after behavior changes.
