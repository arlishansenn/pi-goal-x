# Confirmed legacy-task recovery

## Sub-features

- Decline recovery without mutation.
- Confirm exact terminal-record settlement with backup and ledger audit.

## How to get to it (user POV)

Focus an affected legacy goal, run /goal-recovery tasks, review the confirmation and accept or decline. Recovery does not automatically resume.

## Driving it with rpc-drive.mjs

Copy only the paused red-stopped goal/ledger and its original session JSONL from experiments/issue-10/raw-evidence.zip into dedicated scratch project/session directories. Point PI_GOAL_VERIFY_SESSION_DIR there, /goal-focus, snapshot before, confirm=false /goal-recovery tasks snapshot declined, then confirm=true and snapshot recovered. Never use the original active user goal.

## Gotchas

Declined bytes equal before. Recovered task remains in the table with hostReported:true/outcome stopped. Backup bytes equal the exact before file; ledger starts with old bytes and gains background_task_recovered naming the task and original session. Lifecycle remains unchanged. This maintenance path replays copied historical persisted evidence; it is not a newly executed producer. Wrong session and ambiguous records must not be presented as recoverable; product controlled tests cover these negatives.
