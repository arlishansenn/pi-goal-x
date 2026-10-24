# Producer-aware background task delivery

Goal users can process one background workflow report and continue independent work while other tasks retain their original wait budgets. A lifecycle event does not prove the producer report reached the host.

## Approved behavior

- Dynamic workflows v1 uses numeric contractVersion=1, runId and a positive safe-integer executionEpoch. Optional originSessionId describes the execution source. Optional sessionId on receipts and lifecycle describes routing. Host workflow-result also carries opaque deliveryId and actual sessionId, without status.
- Only launch receipts enroll tasks. A successful explicit resume receipt may advance an existing run to the producer's published epoch. Repeating that epoch does not create another task or renew a budget. Status, list, lifecycle and host messages cannot enroll unknown or future identities.
- Terminal evidence and delivery evidence merge in either order. Host receipt alone does not invent a completed outcome. Old-epoch reports cannot discharge a resumed execution. A delivery ID permanently keeps its first identity within the goal registry, including after cold recovery.
- Ordinary user messages and opaque legacy workflow reports cannot discharge tasks. No unique-candidate, text, FIFO or delivery-ID parsing attribution is allowed. Legacy waits keep their original deadline and check allowance.
- A goal and the initiating session own each task receipt. Explicit goal resume changes scheduling owner, not task provenance. The new owner may schedule surviving tasks and launch new tasks but cannot consume old-session reports without explicit producer transfer evidence. Such transfer evidence is not supplied by this contract.
- A tool call observed without a focused goal remains unowned when its result arrives. An unobserved call retains existing compatibility behavior.
- If goal replacement cannot flush existing work, create_goal and confirmed drafting return failure without successful termination or draft deletion. Direct commands retain their existing warning behavior.

## Unchanged behavior and limits

The existing scheduler remains the only scheduling authority. Progress stays mechanical. Receipt, no-status and upstream background-progress rules remain covered by the unit suite. Each outstanding execution receives one check at 600000ms and a deadline at 660000ms. Re-observation, takeover and sibling completion do not renew that allocation.

Only the publicly verified old structured:bg_run and structured:bg_status namespace mappings migrate to ismailsaleekh/pi-background-tasks. The canonical goal parser must retain this normalization, including receipt scopes and allocated budgets. Other structured namespaces remain isolated.

Successful v1 foreground workflow results do not enroll background tasks. Like ordinary read results, they count as independent post-detection mechanical progress while siblings remain outstanding. Background observations and rejected identities do not gain that progress treatment.

The final producer candidate 5a9913b supplies v1 wire and queue flush with cross-generation ACK handling. Its affected tests pass 430/430, but its complete suite retains two reproduced baseline UI failures. Consumer tests do not independently prove producer queue safety. Real model smoke and cross-repository integration are reserved for the parent review.
