# Background wait core

Issue #10 core behavior. Track producer/session-qualified tasks without automatic ten-minute checks or eleven-minute deadlines. Consume pstack completed, failed and stopped records, preserve multi-task/reload/anti-spin behavior, honor immutable nicobailon deadlineAt and caller-declared waits. Resume must report actual state and refuse an already expired producer deadline.

This is the first stack layer. Confirmed backed-up recovery of already paused legacy goals belongs to the dependent recovery PR. Do not claim the whole issue closed until both layers and runtime evidence land.
