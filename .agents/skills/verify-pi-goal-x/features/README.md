# pi-goal-x feature map

Index of user-facing features verified on the real surface (pi RPC mode with the extension loaded). Each file is self-contained: user-POV path, drive script, and the observable end state that proves the feature. Read `../SKILL.md` first for launch, doctor, and evidence rules.

| Feature | File | Proves |
| --- | --- | --- |
| Direct goal creation | [goal-direct-creation.md](goal-direct-creation.md) | `/goal-direct` writes a v3 goal file, appends `goal_created`, focuses in-session, and the pool survives process restart |
| Goal list and focus | [goal-list-and-focus.md](goal-list-and-focus.md) | `/goal-list` matches disk, `/goal-focus` selects without touching files, `/goal-unfocus` is session-only |
| Cancelled clear is a no-op | [goal-clear-cancel-noop.md](goal-clear-cancel-noop.md) | `/goal-clear` cancelled at the confirm dialog changes nothing, byte for byte |
| Pause and health check | [goal-pause-status-health.md](goal-pause-status-health.md) | `/goal-pause` persists `paused` to the file and ledger; `/goal-status health` reports coherently |

Not yet mapped: guided drafting (`/goal` questionnaire dialogs), task tools, the completion auditor (needs a model), the TUI widget/overlay/Esc keys (tmux recipe in `../SKILL.md`).
