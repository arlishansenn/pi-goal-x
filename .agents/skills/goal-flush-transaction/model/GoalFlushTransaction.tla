--------------------------- MODULE GoalFlushTransaction ---------------------------
(***************************************************************************)
(* Design model of the GoalService per-turn goal transaction (pi-goal-x).   *)
(* Verified with TLC. Every action names the code it mirrors; see           *)
(* .agents/skills/goal-flush-transaction/SKILL.md for the coverage record.  *)
(***************************************************************************)
EXTENDS Naturals, TLC

CONSTANT g1, NoGoal

GoalId == {g1}
Statuses == {"active", "complete"}
REVS == 0..3
USAGES == 0..6
LEDGERMAX == 2
MUTSMAX == 2
TOTALMAX == 6

Max2(a, b) == IF a > b THEN a ELSE b

VARIABLES
  \* Authoritative active goal file on disk (.pi/goals/active_goal_*.md).
  diskRev, diskUsage, diskStatus, diskExists,
  \* Session in-memory view (goal-state.ts goalsById / focused record).
  memRev, memUsage, memStatus,
  \* GoalService.lastPersistedUsage baseline (usage-delta merge base).
  persistBase,
  \* Session focus (goal-state.ts focusedGoalId).
  focused,
  \* Per-turn transaction buffer (goal-service.ts this.turn / this.turnBase).
  bufActive, bufGoal, bufHasGoal, bufArchive, bufStatus, bufLedger, bufMuts,
  bufBaseRev, bufBaseUsage,
  \* This session's goal lock (storage/goal-lock.ts).
  lock,
  \* FALSE once an external write made the session view stale.
  syncClean,
  \* Observers: ledger events appended, successful writes, mutation accounting.
  ledgerTotal, writesTotal, mutsBuffered, mutsCommitted, mutsRejected,
  \* Ghost copy of disk for decrease-detection invariants.
  prevUsage, prevRev

vars == <<diskRev, diskUsage, diskStatus, diskExists, memRev, memUsage, memStatus,
          persistBase, focused, bufActive, bufGoal, bufHasGoal, bufArchive,
          bufStatus, bufLedger, bufMuts, bufBaseRev, bufBaseUsage, lock,
          syncClean, ledgerTotal, writesTotal, mutsBuffered, mutsCommitted,
          mutsRejected, prevUsage, prevRev>>

GhostStep == /\ prevUsage' = diskUsage
             /\ prevRev' = diskRev

TypeOK ==
  /\ diskRev \in [GoalId -> REVS] /\ diskUsage \in [GoalId -> USAGES]
  /\ diskStatus \in [GoalId -> Statuses] /\ diskExists \in [GoalId -> BOOLEAN]
  /\ memRev \in [GoalId -> REVS] /\ memUsage \in [GoalId -> USAGES]
  /\ memStatus \in [GoalId -> Statuses]
  /\ persistBase \in [GoalId -> USAGES]
  /\ focused \in GoalId \cup {NoGoal}
  /\ bufActive \in BOOLEAN /\ bufGoal \in GoalId \cup {NoGoal}
  /\ bufHasGoal \in BOOLEAN /\ bufArchive \in BOOLEAN
  /\ bufStatus \in Statuses /\ bufLedger \in 0..LEDGERMAX /\ bufMuts \in 0..MUTSMAX
  /\ bufBaseRev \in REVS /\ bufBaseUsage \in USAGES
  /\ lock \in {"free", "mine"} /\ syncClean \in BOOLEAN
  /\ ledgerTotal \in 0..TOTALMAX /\ writesTotal \in 0..TOTALMAX
  /\ mutsBuffered \in 0..TOTALMAX
  /\ mutsCommitted \in 0..TOTALMAX /\ mutsRejected \in 0..TOTALMAX
  /\ prevUsage \in [GoalId -> USAGES] /\ prevRev \in [GoalId -> REVS]

Init ==
  /\ diskRev = [f \in GoalId |-> 1]
  /\ diskUsage = [f \in GoalId |-> 0]
  /\ diskStatus = [f \in GoalId |-> "active"]
  /\ diskExists = [f \in GoalId |-> TRUE]
  /\ memRev = [f \in GoalId |-> 1]
  /\ memUsage = [f \in GoalId |-> 0]
  /\ memStatus = [f \in GoalId |-> "active"]
  /\ persistBase = [f \in GoalId |-> 0]
  /\ focused = g1
  /\ bufActive = FALSE /\ bufGoal = NoGoal /\ bufHasGoal = FALSE
  /\ bufArchive = FALSE /\ bufStatus = "active" /\ bufLedger = 0 /\ bufMuts = 0
  /\ bufBaseRev = 0 /\ bufBaseUsage = 0
  /\ lock = "free" /\ syncClean = TRUE
  /\ ledgerTotal = 0 /\ writesTotal = 0
  /\ mutsBuffered = 0 /\ mutsCommitted = 0 /\ mutsRejected = 0
  /\ prevUsage = [f \in GoalId |-> 0] /\ prevRev = [f \in GoalId |-> 1]

(*************************************************************************)
(* goal-events.ts:100 turn_start -> GoalService.beginTurn. An active old  *)
(* buffer is flushed first by the standalone Flush actions below.         *)
(*************************************************************************)
BeginTurn ==
  /\ ~bufActive
  /\ bufActive' = TRUE
  /\ bufGoal' = NoGoal /\ bufHasGoal' = FALSE
  /\ bufArchive' = FALSE /\ bufStatus' = "active"
  /\ bufLedger' = 0 /\ bufMuts' = 0
  /\ bufBaseRev' = 0 /\ bufBaseUsage' = 0
  /\ UNCHANGED <<diskRev, diskUsage, diskStatus, diskExists, memRev, memUsage,
                 memStatus, persistBase, focused, lock, syncClean,
                 ledgerTotal, writesTotal, mutsBuffered, mutsCommitted, mutsRejected>>
  /\ GhostStep

(*************************************************************************)
(* GoalService.apply / updateTask buffered path: mutate a clone of the    *)
(* focused record, bump memory revision speculatively, setFocused, queue  *)
(* ledger events in the turn buffer. A pending buffer for another focus   *)
(* blocks the mutation until that buffer flushes.                         *)
(*************************************************************************)
Mutate ==
  /\ bufActive
  /\ focused # NoGoal
  /\ (~bufHasGoal \/ bufGoal = focused)
  /\ bufMuts < MUTSMAX
  /\ mutsBuffered < TOTALMAX
  /\ LET f == focused IN
     \E delta \in {0,1}, ev \in {0,1},
       st \in {bufStatus, "complete"} :
       /\ memUsage[f] + delta \in USAGES
       /\ memRev[f] + 1 \in REVS
       /\ bufLedger + ev \in 0..LEDGERMAX
       /\ bufHasGoal' = TRUE /\ bufGoal' = f
       /\ bufBaseRev' = IF bufHasGoal THEN bufBaseRev ELSE memRev[f]
       /\ bufBaseUsage' = IF bufHasGoal THEN bufBaseUsage ELSE memUsage[f]
       /\ memUsage' = [memUsage EXCEPT ![f] = memUsage[f] + delta]
       /\ memRev' = [memRev EXCEPT ![f] = memRev[f] + 1]
       /\ memStatus' = [memStatus EXCEPT ![f] = st]
       /\ bufLedger' = bufLedger + ev
       /\ bufMuts' = bufMuts + 1
       /\ mutsBuffered' = mutsBuffered + 1
       /\ bufStatus' = st
       /\ UNCHANGED <<diskRev, diskUsage, diskStatus, diskExists, persistBase,
                      bufArchive, focused, bufActive, lock, syncClean,
                      ledgerTotal, writesTotal, mutsCommitted, mutsRejected>>
       /\ GhostStep

(* flushTurn on an empty buffer: just closes the transaction. *)
EndEmptyTurn ==
  /\ bufActive /\ ~bufHasGoal
  /\ bufActive' = FALSE
  /\ UNCHANGED <<diskRev, diskUsage, diskStatus, diskExists, memRev, memUsage,
                 memStatus, persistBase, focused, bufGoal, bufHasGoal,
                 bufArchive, bufStatus, bufLedger, bufMuts, bufBaseRev,
                 bufBaseUsage, lock, syncClean, ledgerTotal, writesTotal,
                 mutsBuffered, mutsCommitted, mutsRejected>>
  /\ GhostStep

(* acquireGoalLock succeeds. *)
Acquire ==
  /\ bufActive /\ bufHasGoal /\ lock = "free"
  /\ lock' = "mine"
  /\ UNCHANGED <<diskRev, diskUsage, diskStatus, diskExists, memRev, memUsage,
                 memStatus, persistBase, focused, bufActive, bufGoal,
                 bufHasGoal, bufArchive, bufStatus, bufLedger, bufMuts,
                 bufBaseRev, bufBaseUsage, syncClean, ledgerTotal, writesTotal,
                 mutsBuffered, mutsCommitted, mutsRejected>>
  /\ GhostStep

(* acquireGoalLock throws after the bounded window: buffer kept for retry. *)
AcquireFail ==
  /\ bufActive /\ bufHasGoal
  /\ UNCHANGED <<diskRev, diskUsage, diskStatus, diskExists, memRev, memUsage,
                 memStatus, persistBase, focused, bufActive, bufGoal,
                 bufHasGoal, bufArchive, bufStatus, bufLedger, bufMuts,
                 bufBaseRev, bufBaseUsage, lock, syncClean, ledgerTotal,
                 writesTotal, mutsBuffered, mutsCommitted, mutsRejected>>
  /\ GhostStep

(*************************************************************************)
(* flushTurn critical section under the lock: re-read the active file,    *)
(* compare revisions against turnBase, then archive/write + ledger batch  *)
(* + memory commit, or reject explicitly. endTurn / flushForAudit /       *)
(* flush-before-focus-switch all route here.                              *)
(*************************************************************************)
CritSect ==
  /\ bufActive /\ bufHasGoal /\ lock = "mine"
  /\ LET f == bufGoal IN
     \**************************************
     (* !freshDisk: goal vanished externally. *)
     \**************************************
     \/ /\ ~diskExists[f]
        /\ bufActive' = FALSE /\ bufHasGoal' = FALSE
        /\ bufMuts' = 0 /\ bufLedger' = 0
        /\ mutsRejected' = mutsRejected + bufMuts
        /\ lock' = "free"
        /\ focused' = IF focused = f THEN NoGoal ELSE focused
        /\ UNCHANGED <<diskRev, diskUsage, diskStatus, diskExists, memRev,
                       memUsage, memStatus, persistBase, syncClean,
                       ledgerTotal, writesTotal, mutsBuffered, mutsCommitted,
                       bufGoal, bufArchive, bufStatus, bufBaseRev, bufBaseUsage>>
        /\ GhostStep
     \**********************************************
     (* revision conflict: reject the speculative  *)
     (* transaction, merge the clamped usage delta *)
     (* onto the fresh disk record if still focused.*)
     \**********************************************
     \/ /\ diskExists[f]
        /\ diskRev[f] # bufBaseRev
        /\ LET delta == Max2(0, memUsage[f] - bufBaseUsage) IN
           /\ diskUsage[f] + delta \in USAGES
           /\ bufActive' = FALSE /\ bufHasGoal' = FALSE
           /\ bufMuts' = 0 /\ bufLedger' = 0
           /\ mutsRejected' = mutsRejected + bufMuts
           /\ lock' = "free"
           /\ memRev' = IF focused = f THEN [memRev EXCEPT ![f] = diskRev[f]] ELSE memRev
           /\ memUsage' = IF focused = f THEN [memUsage EXCEPT ![f] = diskUsage[f] + delta] ELSE memUsage
           /\ memStatus' = IF focused = f THEN [memStatus EXCEPT ![f] = diskStatus[f]] ELSE memStatus
           /\ persistBase' = IF focused = f THEN [persistBase EXCEPT ![f] = diskUsage[f]] ELSE persistBase
           /\ syncClean' = IF focused = f THEN TRUE ELSE syncClean
           /\ UNCHANGED <<diskRev, diskUsage, diskStatus, diskExists, focused,
                          ledgerTotal, writesTotal, mutsBuffered, mutsCommitted,
                          bufGoal, bufArchive, bufStatus, bufBaseRev, bufBaseUsage>>
           /\ GhostStep
     \*********************************************
     (* revision matches: the file write either *)
     (* throws (buffer kept) or commits.        *)
     \*********************************************
     \/ /\ diskExists[f]
        /\ diskRev[f] = bufBaseRev
        /\ \/ (* write throws: transaction stays buffered *)
             /\ lock' = "free"
             /\ UNCHANGED <<diskRev, diskUsage, diskStatus, diskExists, memRev,
                            memUsage, memStatus, persistBase, focused,
                            bufActive, bufGoal, bufHasGoal, bufArchive, bufStatus,
                            bufLedger, bufMuts, bufBaseRev, bufBaseUsage,
                            syncClean, ledgerTotal, writesTotal, mutsBuffered,
                            mutsCommitted, mutsRejected>>
             /\ GhostStep
           \/ /\ LET newRev == diskRev[f] + 1
                     archived == bufArchive \/ bufStatus = "complete"
                  IN /\ newRev \in REVS
                     /\ writesTotal < TOTALMAX
                     /\ writesTotal' = writesTotal + 1
                     /\ mutsCommitted' = mutsCommitted + bufMuts
                     /\ ledgerTotal' = ledgerTotal + bufLedger
                     /\ bufActive' = FALSE /\ bufHasGoal' = FALSE
                     /\ bufMuts' = 0 /\ bufLedger' = 0
                     /\ lock' = "free"
                     /\ memRev' = [memRev EXCEPT ![f] = newRev]
                     /\ memStatus' = [memStatus EXCEPT ![f] = bufStatus]
                     /\ persistBase' = [persistBase EXCEPT ![f] = memUsage[f]]
                     /\ IF archived
                        THEN /\ diskExists' = [diskExists EXCEPT ![f] = FALSE]
                             /\ UNCHANGED <<diskRev, diskUsage, diskStatus>>
                        ELSE /\ diskExists' = diskExists
                             /\ diskRev' = [diskRev EXCEPT ![f] = newRev]
                             /\ diskUsage' = [diskUsage EXCEPT ![f] = memUsage[f]]
                             /\ diskStatus' = [diskStatus EXCEPT ![f] = bufStatus]
                     /\ UNCHANGED <<memUsage, focused, syncClean,
                                    bufGoal, bufArchive, bufStatus, bufBaseRev,
                                    bufBaseUsage, mutsBuffered, mutsRejected>>
                     /\ GhostStep

(* Well-behaved external process: takes the lock, bumps revision + usage. *)
ExtWrite ==
  /\ lock = "free"
  /\ \E f \in GoalId :
       /\ diskExists[f]
       /\ \E e \in {1,2} :
            /\ diskRev[f] + 1 \in REVS
            /\ diskUsage[f] + e \in USAGES
            /\ diskRev' = [diskRev EXCEPT ![f] = diskRev[f] + 1]
            /\ diskUsage' = [diskUsage EXCEPT ![f] = diskUsage[f] + e]
            /\ syncClean' = FALSE
            /\ UNCHANGED <<diskStatus, diskExists, memRev, memUsage, memStatus,
                           persistBase, focused, bufActive, bufGoal,
                           bufHasGoal, bufArchive, bufStatus, bufLedger, bufMuts,
                           bufBaseRev, bufBaseUsage, lock, ledgerTotal,
                           writesTotal, mutsBuffered, mutsCommitted, mutsRejected>>
            /\ GhostStep

(* External archive/delete of the active file. *)
ExtVanish ==
  /\ lock = "free"
  /\ \E f \in GoalId :
       /\ diskExists[f]
       /\ diskExists' = [diskExists EXCEPT ![f] = FALSE]
       /\ UNCHANGED <<diskRev, diskUsage, diskStatus, memRev, memUsage, memStatus,
                      persistBase, focused, bufActive, bufGoal,
                      bufHasGoal, bufArchive, bufStatus, bufLedger, bufMuts,
                      bufBaseRev, bufBaseUsage, lock, syncClean,
                      ledgerTotal, writesTotal, mutsBuffered, mutsCommitted,
                      mutsRejected>>
       /\ GhostStep

(*************************************************************************)
(* GoalService.persist outside a turn: under the lock, write the fresh    *)
(* disk record plus this session's clamped usage delta since the last    *)
(* baseline; concurrent disk usage is never dropped.                      *)
(*************************************************************************)
PersistTick ==
  /\ ~bufActive /\ focused # NoGoal /\ lock = "free"
  /\ diskExists[focused]
  /\ writesTotal < TOTALMAX
  /\ LET f == focused
         delta == Max2(0, memUsage[f] - persistBase[f])
     IN /\ diskRev[f] + 1 \in REVS
        /\ diskUsage[f] + delta \in USAGES
        /\ diskRev' = [diskRev EXCEPT ![f] = diskRev[f] + 1]
        /\ diskUsage' = [diskUsage EXCEPT ![f] = diskUsage[f] + delta]
        /\ memRev' = [memRev EXCEPT ![f] = diskRev[f] + 1]
        /\ memUsage' = [memUsage EXCEPT ![f] = diskUsage[f] + delta]
        /\ persistBase' = [persistBase EXCEPT ![f] = diskUsage[f] + delta]
        /\ writesTotal' = writesTotal + 1
        /\ syncClean' = TRUE
        /\ UNCHANGED <<diskStatus, diskExists, memStatus, focused,
                       bufActive, bufGoal, bufHasGoal, bufArchive, bufStatus,
                       bufLedger, bufMuts, bufBaseRev, bufBaseUsage, lock,
                       ledgerTotal, mutsBuffered, mutsCommitted,
                       mutsRejected>>
        /\ GhostStep

(*************************************************************************)
(* goal-state.ts:429 assignFocusedGoalId: flush old buffer (standalone    *)
(* CritSect above), then switch focus and reconcile from disk.            *)
(*************************************************************************)
FocusChange ==
  /\ focused # NoGoal
  /\ focused' = NoGoal
  /\ syncClean' = syncClean
  /\ UNCHANGED <<diskRev, diskUsage, diskStatus, diskExists, memRev, memUsage,
                 memStatus, persistBase, bufActive, bufGoal, bufHasGoal,
                 bufArchive, bufStatus, bufLedger, bufMuts, bufBaseRev,
                 bufBaseUsage, lock, ledgerTotal, writesTotal, mutsBuffered,
                 mutsCommitted, mutsRejected>>
  /\ GhostStep

Next == \/ BeginTurn
        \/ Mutate
        \/ EndEmptyTurn
        \/ Acquire
        \/ AcquireFail
        \/ CritSect
        \/ ExtWrite
        \/ ExtVanish
        \/ PersistTick
        \/ FocusChange

Spec == Init /\ [][Next]_vars

(****************************** Properties ******************************)

(* Disk revision and usage never decrease; a blind overwrite of a
   concurrent writer shows up here as a decrease. *)
InvRevMonotone == \A f \in GoalId : diskRev[f] \geq prevRev[f]
InvUsageMonotone == \A f \in GoalId : diskUsage[f] \geq prevUsage[f]

(* Every buffered mutation is either committed or explicitly rejected;
   none is silently dropped. *)
MutationConservation ==
  mutsBuffered = mutsCommitted + mutsRejected + (IF bufActive THEN bufMuts ELSE 0)

(* Ledger events are only appended with the write that committed them;
   a rejected transaction appends nothing. *)
LedgerCausality ==
  ledgerTotal + (IF bufActive THEN bufLedger ELSE 0)
    \leq mutsCommitted + (IF bufActive THEN bufMuts ELSE 0)

(* At quiescence with no external write since the last sync, memory equals
   the disk revision and never trails disk usage (no partial commit, no
   clobbered concurrent work). *)
InvQuiescent ==
  (syncClean /\ ~bufActive /\ focused # NoGoal /\ diskExists[focused])
    => /\ memRev[focused] = diskRev[focused]
       /\ memUsage[focused] \geq diskUsage[focused]

=============================================================================
