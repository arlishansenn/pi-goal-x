# Cancelled clear is a no-op

## Sub-features

- `/goal-clear` asks for confirmation with the goal's one-line summary.
- Cancelling (or declining) the dialog is a byte-for-byte no-op: no file, focus, or ledger change.

## How to get to it (user POV)

Run `/goal-clear` on the focused goal. A confirm dialog shows the goal summary. Choose to cancel. The goal stays exactly as it was.

## Driving it with rpc-drive.mjs

```json
{"send": {"id": "c1", "type": "prompt", "message": "/goal-direct Verify: clear cancel no-op"}}
{"wait": 1200}
{"snap": "before-clear"}
{"autoDialog": {"confirm": {"confirmed": false}}}
{"send": {"id": "c2", "type": "prompt", "message": "/goal-clear"}}
{"wait": 1500}
{"snap": "after-clear"}
```

## Observable end state

- Transcript shows one `confirm` `extension_ui_request` (the goal summary in `title`/`message`) and the auto-sent `extension_ui_response` with `confirmed: false`.
- `shasum -a 256 snaps/before-clear/active_goal_*.md snaps/before-clear/goal_events.jsonl` equals the hash of the `after-clear` copies.
- `diff -r snaps/before-clear snaps/after-clear` is empty.

## Gotchas

- The `autoDialog` step must precede the `/goal-clear` send; pi blocks on the dialog until answered and a missing answer stalls the run until the dialog timeout.
- Headless runs (no TUI) return guidance instead of mutating anything when no dialog can be shown; in RPC mode the dialog always arrives as a record, so this path is the one exercised.
