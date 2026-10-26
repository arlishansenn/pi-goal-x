# Cancelled clear is a no-op

## Sub-features

- Cancel the clear confirmation without archiving the goal.

## How to get to it (user POV)

Run /goal-clear on the focused goal and decline its confirmation.

## Driving it with rpc-drive.mjs

Run scenarios/commands.jsonl with maxAutonomousRuns:0. It pauses the goal before taking before-clear, configures confirm=false, sends /goal-clear, and takes after-clear.

## Gotchas

Require an actual confirm request and matching confirmed:false response. Compare every goal/ledger file in before-clear and after-clear byte for byte. Perform the comparison only while paused and quiescent; active accounting or autonomous turns invalidate isolation. Unanswered dialogs fail the helper.
