---------------------------- MODULE GoalCompletionAudit ----------------------------
(***************************************************************************)
(* Design model of the pi-goal-x completion flow: update_goal(complete) -> *)
(* flushForAudit -> gates -> focus-token capture -> skip or independent    *)
(* auditor -> single completion commit -> deferred archival at turn_end.   *)
(* Verified with TLC; see .agents/skills/goal-completion-audit/SKILL.md.   *)
(***************************************************************************)
EXTENDS Naturals, TLC

CONSTANT g, NoGoal

REVMAX == 4
ATTMAX == 2

Phases == {"idle", "flushing", "gate", "captured", "auditing", "dialog", "committing"}
Outcomes == {"none", "committed", "rejected", "cancelled"}
AuditOutcomes == {"none", "approved", "disapproved", "error", "aborted", "skipped"}

VARIABLES
  \* Session focus (goal-state.ts focusedGoalId / focusRevision).
  focused, focusRev,
  \* Goal lifecycle status and archival state.
  status, archived,
  \* Completion flow phase (goal-completion.ts runGoalCompletionFlow).
  phase,
  \* Terminal outcome of the last attempt and the auditor verdict.
  attemptOutcome, auditorOutcome,
  \* Escape-dialog user choice (widgets/goal-escape-dialog.ts).
  userChoice,
  \* Ledger counters: completion_requested appends, terminal audit events.
  attemptsStarted, auditTerm,
  \* Observers: completion commits, archival moves, terminate flag.
  completeWrites, archiveMoves, termRequested,
  \* Ghosts: token revision at capture and at commit; turn-end marker.
  lastCaptRev, lastCommitRev, turnEndedFlag,
  \* Attempt conservation counters.
  attempts, nComm, nRej, nCan

vars == <<focused, focusRev, status, archived, phase, attemptOutcome,
          auditorOutcome, userChoice, attemptsStarted, auditTerm,
          completeWrites, archiveMoves, termRequested, lastCaptRev,
          lastCommitRev, turnEndedFlag, attempts, nComm, nRej, nCan>>

tokenCurrent == focused = g /\ focusRev = lastCaptRev

TypeOK ==
  /\ focused \in {g, NoGoal} /\ focusRev \in 0..REVMAX
  /\ status \in {"active", "complete"} /\ archived \in BOOLEAN
  /\ phase \in Phases /\ attemptOutcome \in Outcomes
  /\ auditorOutcome \in AuditOutcomes
  /\ userChoice \in {"none", "bypass", "continue"}
  /\ attemptsStarted \in 0..ATTMAX /\ auditTerm \in 0..ATTMAX
  /\ completeWrites \in 0..1 /\ archiveMoves \in 0..1
  /\ termRequested \in BOOLEAN
  /\ lastCaptRev \in 0..REVMAX /\ lastCommitRev \in 0..REVMAX
  /\ turnEndedFlag \in BOOLEAN
  /\ attempts \in 0..ATTMAX
  /\ nComm \in 0..ATTMAX /\ nRej \in 0..ATTMAX /\ nCan \in 0..ATTMAX

Init ==
  /\ focused = g /\ focusRev = 0
  /\ status = "active" /\ archived = FALSE
  /\ phase = "idle" /\ attemptOutcome = "none"
  /\ auditorOutcome = "none" /\ userChoice = "none"
  /\ attemptsStarted = 0 /\ auditTerm = 0
  /\ completeWrites = 0 /\ archiveMoves = 0 /\ termRequested = FALSE
  /\ lastCaptRev = 0 /\ lastCommitRev = 0 /\ turnEndedFlag = FALSE
  /\ attempts = 0 /\ nComm = 0 /\ nRej = 0 /\ nCan = 0

(*************************************************************************)
(* update_goal(status="complete") on the focused active goal starts the  *)
(* flow (goal-core-tools.ts executor -> runGoalCompletionFlow).          *)
(*************************************************************************)
RequestComplete ==
  /\ phase = "idle" /\ status = "active" /\ focused = g
  /\ attempts < ATTMAX
  /\ attemptOutcome' = "none" /\ auditorOutcome' = "none" /\ userChoice' = "none"
  /\ phase' = "flushing" /\ attempts' = attempts + 1
  /\ UNCHANGED <<focused, focusRev, status, archived, attemptsStarted,
                 auditTerm, completeWrites, archiveMoves, termRequested,
                 lastCaptRev, lastCommitRev, turnEndedFlag, nComm, nRej, nCan>>

(* GoalService.flushForAudit: the audit never sees unflushed state; a
   flush error aborts completion before any audit event. *)
FlushAudit ==
  /\ phase = "flushing"
  /\ \/ /\ phase' = "gate"
        /\ UNCHANGED <<attempts, focused, focusRev, status, archived,
                       attemptOutcome, auditorOutcome, userChoice,
                       attemptsStarted, auditTerm, completeWrites,
                       archiveMoves, termRequested, lastCaptRev,
                       lastCommitRev, turnEndedFlag, nComm, nRej, nCan>>
     \/ /\ phase' = "idle" /\ attemptOutcome' = "rejected" /\ nRej' = nRej + 1
        /\ UNCHANGED <<attempts, focused, focusRev, status, archived,
                       auditorOutcome, userChoice, attemptsStarted, auditTerm,
                       completeWrites, archiveMoves, termRequested, lastCaptRev,
                       lastCommitRev, turnEndedFlag, nComm, nCan>>

(* validateGoalCompletion + task gate; on pass, capture the focus token
   (completionFocus) and append completion_requested. *)
Gate ==
  /\ phase = "gate"
  /\ attemptsStarted < ATTMAX
  /\ \/ /\ phase' = "captured" /\ attemptsStarted' = attemptsStarted + 1
           /\ lastCaptRev' = focusRev
           /\ UNCHANGED <<attempts, focused, focusRev, status, archived,
                          attemptOutcome, auditorOutcome, userChoice, auditTerm,
                          completeWrites, archiveMoves, termRequested,
                          lastCommitRev, turnEndedFlag, nComm, nRej, nCan>>
     \/ /\ phase' = "idle" /\ attemptOutcome' = "rejected" /\ nRej' = nRej + 1
        /\ UNCHANGED <<attempts, focused, focusRev, status, archived,
                       auditorOutcome, userChoice, attemptsStarted, auditTerm,
                       completeWrites, archiveMoves, termRequested, lastCaptRev,
                       lastCommitRev, turnEndedFlag, nComm, nCan>>

(* skipAuditor / settings.disabled: append audit_skipped, go straight to
   the single completion transaction. No pre-check here; the focus token
   guard lives inside the commit (GoalService.apply focusToken). *)
SkipCompletion ==
  /\ phase = "captured"
  /\ auditTerm' = auditTerm + 1
  /\ auditorOutcome' = "skipped"
  /\ phase' = "committing"
  /\ UNCHANGED <<attempts, focused, focusRev, status, archived, attemptOutcome,
                 userChoice, attemptsStarted, completeWrites, archiveMoves,
                 termRequested, lastCaptRev, lastCommitRev, turnEndedFlag,
                 nComm, nRej, nCan>>

(* Auditor enabled: the explicit isFocusedOperationCurrent check before
   audit_started cancels a detached completion. *)
StartAudit ==
  /\ phase = "captured"
  /\ \/ /\ tokenCurrent /\ phase' = "auditing"
        /\ UNCHANGED <<attempts, focused, focusRev, status, archived,
                       attemptOutcome, auditorOutcome, userChoice,
                       attemptsStarted, auditTerm, completeWrites, archiveMoves,
                       termRequested, lastCaptRev, lastCommitRev, turnEndedFlag,
                       nComm, nRej, nCan>>
     \/ /\ ~tokenCurrent
        /\ phase' = "idle" /\ attemptOutcome' = "cancelled" /\ nCan' = nCan + 1
        /\ UNCHANGED <<attempts, focused, focusRev, status, archived,
                       auditorOutcome, userChoice, attemptsStarted, auditTerm,
                       completeWrites, archiveMoves, termRequested, lastCaptRev,
                       lastCommitRev, turnEndedFlag, nComm, nRej>>

(* Auditor finished. The isFocusedOperationCurrent check right after the
   auditor returns cancels a detached attempt before any verdict event;
   a surviving token appends audit_result. Approval goes to the commit;
   disapproval/error leaves the goal open (no pause, no stop). *)
AuditResult ==
  /\ phase = "auditing"
  /\ \/ /\ ~tokenCurrent
        /\ phase' = "idle" /\ attemptOutcome' = "cancelled" /\ nCan' = nCan + 1
        /\ UNCHANGED <<attempts, focused, focusRev, status, archived,
                       auditorOutcome, userChoice, attemptsStarted, auditTerm,
                       completeWrites, archiveMoves, termRequested, lastCaptRev,
                       lastCommitRev, turnEndedFlag, nComm, nRej>>
     \/ /\ tokenCurrent
        /\ \E verdict \in {"approved", "disapproved", "error"} :
             /\ auditorOutcome' = verdict
             /\ auditTerm' = auditTerm + 1
             /\ IF verdict = "approved"
                THEN /\ phase' = "committing"
                     /\ UNCHANGED <<attempts, attemptOutcome, nComm, nRej, nCan>>
                ELSE /\ phase' = "idle" /\ attemptOutcome' = "rejected"
                     /\ nRej' = nRej + 1
                     /\ UNCHANGED <<attempts, nComm, nCan>>
             /\ UNCHANGED <<focused, focusRev, status, archived, userChoice,
                            attemptsStarted, completeWrites, archiveMoves,
                            termRequested, lastCaptRev, lastCommitRev, turnEndedFlag>>

(* User pressed Escape mid-audit: no terminal ledger event until the
   dialog resolves. A stale token is caught by the dialog's own check. *)
AuditAbort ==
  /\ phase = "auditing"
  /\ auditorOutcome' = "aborted" /\ phase' = "dialog"
  /\ UNCHANGED <<attempts, focused, focusRev, status, archived, attemptOutcome,
                 userChoice, attemptsStarted, auditTerm, completeWrites,
                 archiveMoves, termRequested, lastCaptRev, lastCommitRev,
                 turnEndedFlag, nComm, nRej, nCan>>

(* Escape dialog: the second isFocusedOperationCurrent check runs after
   the user answers. Bypass appends audit_skipped (terminate false);
   continue-working leaves the goal active with no skip event. *)
DialogChoice ==
  /\ phase = "dialog"
  /\ \/ /\ tokenCurrent /\ userChoice' = "bypass"
        /\ auditTerm' = auditTerm + 1
        /\ phase' = "committing"
        /\ UNCHANGED <<attempts, focused, focusRev, status, archived,
                       attemptOutcome, auditorOutcome, attemptsStarted,
                       completeWrites, archiveMoves, termRequested, lastCaptRev,
                       lastCommitRev, turnEndedFlag, nComm, nRej, nCan>>
     \/ /\ tokenCurrent /\ userChoice' = "continue"
        /\ phase' = "idle" /\ attemptOutcome' = "rejected" /\ nRej' = nRej + 1
        /\ UNCHANGED <<attempts, focused, focusRev, status, archived,
                       auditorOutcome, attemptsStarted, auditTerm,
                       completeWrites, archiveMoves, termRequested, lastCaptRev,
                       lastCommitRev, turnEndedFlag, nComm, nCan>>
     \/ /\ ~tokenCurrent
        /\ phase' = "idle" /\ attemptOutcome' = "cancelled" /\ nCan' = nCan + 1
        /\ UNCHANGED <<attempts, focused, focusRev, status, archived,
                       auditorOutcome, userChoice, attemptsStarted, auditTerm,
                       completeWrites, archiveMoves, termRequested, lastCaptRev,
                       lastCommitRev, turnEndedFlag, nComm, nRej>>

(*************************************************************************)
(* commitGoalCompletion: GoalService.apply with the completion focus     *)
(* token; sets complete in memory + writes the active file WITHOUT       *)
(* archiving (deferred to turn_end). A stale token or a failed write     *)
(* never completes the goal and never requests termination.              *)
(*************************************************************************)
Commit ==
  /\ phase = "committing"
  /\ \/ /\ ~tokenCurrent
        /\ phase' = "idle" /\ attemptOutcome' = "cancelled" /\ nCan' = nCan + 1
        /\ UNCHANGED <<attempts, focused, focusRev, status, archived,
                       auditorOutcome, userChoice, attemptsStarted, auditTerm,
                       completeWrites, archiveMoves, termRequested, lastCaptRev,
                       lastCommitRev, turnEndedFlag, nComm, nRej>>
     \/ /\ tokenCurrent
        /\ (\/ (* the authoritative write fails: no completion, no termination *)
              /\ phase' = "idle" /\ attemptOutcome' = "rejected"
              /\ nRej' = nRej + 1
              /\ UNCHANGED <<attempts, focused, focusRev, status, archived,
                             auditorOutcome, userChoice, attemptsStarted,
                             auditTerm, completeWrites, archiveMoves,
                             termRequested, lastCaptRev, lastCommitRev,
                             turnEndedFlag, nComm, nCan>>
            \/ (* success: complete in memory + active file, archival deferred *)
              /\ status' = "complete"
              /\ completeWrites' = completeWrites + 1
              /\ lastCommitRev' = focusRev /\ turnEndedFlag' = FALSE
              /\ phase' = "idle" /\ attemptOutcome' = "committed"
              /\ nComm' = nComm + 1
              /\ termRequested' = (auditorOutcome # "aborted")
              /\ UNCHANGED <<attempts, focused, focusRev, archived, auditTerm,
                             auditorOutcome, userChoice, attemptsStarted,
                             archiveMoves, lastCaptRev, nRej, nCan>>)

(* turn_end deferred archival (goal-events.ts): only a completed goal
   archives, and only here. *)
TurnEnd ==
  /\ status = "complete" /\ ~archived
  /\ archived' = TRUE /\ archiveMoves' = archiveMoves + 1 /\ turnEndedFlag' = TRUE
  /\ UNCHANGED <<attempts, focused, focusRev, status, phase, attemptOutcome,
                 auditorOutcome, userChoice, attemptsStarted, auditTerm,
                 completeWrites, termRequested, lastCaptRev, lastCommitRev,
                 nComm, nRej, nCan>>

(* Any focus change bumps focusRevision and invalidates pending tokens
   (goal-state.ts assignFocusedGoalId / unfocus). *)
FocusToggle ==
  /\ focusRev < REVMAX
  /\ focused' = IF focused = g THEN NoGoal ELSE g
  /\ focusRev' = focusRev + 1
  /\ UNCHANGED <<attempts, status, archived, phase, attemptOutcome,
                 auditorOutcome, userChoice, attemptsStarted, auditTerm,
                 completeWrites, archiveMoves, termRequested, lastCaptRev,
                 lastCommitRev, turnEndedFlag, nComm, nRej, nCan>>

Next == \/ RequestComplete
        \/ FlushAudit
        \/ Gate
        \/ SkipCompletion
        \/ StartAudit
        \/ AuditResult
        \/ AuditAbort
        \/ DialogChoice
        \/ Commit
        \/ TurnEnd
        \/ FocusToggle

Spec == Init /\ [][Next]_vars

(****************************** Properties ******************************)

(* The goal completes at most once and archives at most once. *)
InvCompleteOnce == completeWrites \leq 1 /\ archiveMoves \leq 1

(* Archival happens only at turn_end after a committed completion, never
   inside the completion transaction itself. *)
InvArchiveOrder == archived => (completeWrites = 1 /\ turnEndedFlag)

(* A completion commit only ever ran with a still-current focus token. *)
InvTokenGuard == completeWrites = 1 => lastCommitRev = lastCaptRev

(* Each completion attempt appends at most one terminal audit event
   (audit_result or audit_skipped, never both). *)
InvOutcomeExclusive == auditTerm \leq attemptsStarted

(* A disapproved or errored audit never completes or archives the goal. *)
InvDisapprovedStaysOpen ==
  auditorOutcome \in {"disapproved", "error"} => /\ status = "active"
                                                 /\ ~archived

(* Termination is requested only from a successful commit. *)
InvTermAfterCommit == termRequested => completeWrites = 1

(* Every started attempt ends exactly once as committed, rejected, or
   cancelled; none vanishes mid-flow. *)
InvAttemptConservation ==
  attempts = nComm + nRej + nCan
          + (IF phase # "idle" THEN 1 ELSE 0)

InvLedgerWithinAttempts == attemptsStarted \leq attempts

=============================================================================
