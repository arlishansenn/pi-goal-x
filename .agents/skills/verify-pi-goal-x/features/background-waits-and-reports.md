# Background waits and terminal reports

## Sub-features

- Wait without a manufactured check or deadline.
- Consume completed, failed and stopped producer outcomes.
- Keep unrelated identities and sibling tasks isolated.

## How to get to it (user POV)

The model launches background agent work, ends its turn, and resumes after its producer reports a terminal result.

## Driving it with rpc-drive.mjs

Set PI_GOAL_VERIFY_EXTENSIONS to the absolute path of receipt-producer.ts and PI_GOAL_VERIFY_SETTINGS to {"maxAutonomousRuns":3,"disabled":true}; run scenarios/background.jsonl. For failed and stopped, copy the scenario and change only /verify-report completed and expected outcome. The scaffold starts no child.

## Gotchas

waiting snapshot must be active/waiting with hostReported:false and no scheduler.wait.deadline or nextCheckAt. reported must retain the same task, hostReported:true and exact terminal outcome. Require the emitted native-shaped record plus result-writing/explicit verification pause. This proves consumer protocol, not actual producer execution. Use experiments/issue-10 for prior real producer recipe and rerun it when claiming integration. Explicit nicobailon deadlineAt and >11-minute edges require separately labeled controlled-clock tests, not a short RPC run.
