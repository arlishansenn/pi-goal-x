# Formal model applicability

Read both local SKILL.md coverage records and reran both model runners on fork baseline9038241. Flush model: 13,316 distinct states, pass. Completion model: 1,181 distinct states, pass.

Neither existing model contains registry tasks, host notifications, producer/session matching, background waits, deadline policy or recovery receipts. Their passes do not establish the issue10 acceptance conditions. Current intended implementation changes registry/scheduler/state validation/recovery, not GoalService write ordering or completion audit ordering. Existing models require no behavioral update solely for this deadline/notification policy. Final diff must be checked for accidental mutation-boundary or completion-flow changes; rerun if relevant event handlers changed. Coverage sync commits remain old and must not be advanced without rederivation.

A new scheduler model would add a separate proof obligation and cannot replace actual app runtime evidence; no new model is assumed necessary until final safety review. Controlled-clock public-boundary tests cover new scheduler behavior deterministically. Explicit noncoverage will be recorded in PR.
