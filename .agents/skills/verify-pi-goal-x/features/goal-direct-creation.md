# Direct goal creation

## Sub-features

- Create with /goal-direct and persist one goal across a fresh process.
- Focus is session-local; the file is JSON plus markdown.

## How to get to it (user POV)

Type /goal-direct <objective>, then /goal-list. A new --no-session process sees the same open goal but starts unfocused.

## Driving it with rpc-drive.mjs

Run scenarios/commands.jsonl with maxAutonomousRuns:0 and inspect created. For restart, use an explicitly created scratch workdir in two runs, create once, then only /goal-list and a new snapshot. Each run performs its own doctor.

## Gotchas

Assert one active_goal file with the same id/objective and a nonnegative integer revision in both snapshots. Read the starred goal-list line as focused evidence; focused setStatus may be empty. Exactly one goal_created exists. Do not require a creation-time goal_focused event; the live command run did not emit one. AutoContinue can start paid model work unless isolated.
