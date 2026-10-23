import { randomUUID } from "node:crypto";
import type { ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { GoalCore } from "./goal-state.ts";
import { asRecord, type GoalRecord } from "./goal-record.ts";
import { budgetReached } from "./goal-accounting.ts";
import { loadGoalSettings, invalidateGoalSettingsCache } from "./goal-settings.ts";
import { newGoalScheduler, schedulerSummary, type GoalContinuation, type GoalSchedulerState } from "./goal-scheduler-state.ts";
import {
	allocateWaits, consumeDueChecks, isTaskPoll, observeHostMessage, observeLifecycle, observeToolResult,
	outstandingTasks, projectWait, type BackgroundTasksState,
} from "./goal-background-registry.ts";
import { isPendingTaskPoll, observeBackgroundTask, type BackgroundTaskRef, type TaskResultLike } from "./goal-background-task.ts";
import { backgroundTaskDeferralPrompt } from "./prompts/goal-prompts.ts";
import { CORE_GOAL_TOOL_NAMES } from "./goal-tool-names.ts";

/** Goal bookkeeping results describe the goal; they are never deferring work. */
const BOOKKEEPING_TOOL_NAMES = new Set<string>(CORE_GOAL_TOOL_NAMES);

/**
 * How long a task wait sleeps before the scheduled re-check, in milliseconds.
 * The wait is event-driven: this interval only covers a result report that
 * never arrives.
 */
export const BACKGROUND_TASK_WAIT_MS = 10 * 60_000;

/** Slack over the re-check interval so the check dispatch always wins over the deadline pause. */
const BACKGROUND_TASK_DEADLINE_MARGIN_MS = 60_000;

/** Scheduling intent is durable; timers only arrange an opportunity to claim it. */
export class GoalScheduler {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private ctx: ExtensionContext | undefined;
	private inRun = false;
	private armedGeneration: string | undefined;
	private declared = false;
	private runGoalId: string | undefined;
	/** Detached work this session tracks; persisted into scheduler state at settlement. */
	private tasks: BackgroundTasksState | undefined;
	/** Whether this run did work after it recorded the pending task. Per run. */
	private postTaskProgress = false;
	private denied = false;
	private unsubscribe: (() => void) | undefined;
	private core: GoalCore;
	constructor(core: GoalCore) { this.core = core; }

	private owner(ctx: ExtensionContext): string { return ctx.sessionManager.getSessionId() || "unknown-session"; }
	private limit(ctx: ExtensionContext): number | undefined { return loadGoalSettings(ctx.cwd).maxAutonomousRuns; }
	private strict(ctx: ExtensionContext, s: GoalSchedulerState): boolean {
		// A wait the runtime raised for a detected background task stays
		// system-managed: it must not put the goal under the explicit execution
		// contract, or every later turn would owe a declaration the model did not
		// choose to make.
		return loadGoalSettings(ctx.cwd).strictExecutionContract === true || (!!s.wait && s.wait.taskId === undefined);
	}
	private implicitReady(s: GoalSchedulerState): void {
		s.phase = "ready"; s.dispatch = undefined; s.generation = randomUUID();
		// A task wait ends with the task: the result is the context for the next run.
		if (s.wait?.taskId !== undefined) s.wait = undefined;
		s.postTaskProgress = false;
		s.decision = { kind: "ready", purpose: "ready" };
	}
	private available(ctx: ExtensionContext, s: GoalSchedulerState): boolean {
		const limit = this.limit(ctx);
		return limit === undefined || s.used < limit;
	}
	private state(ctx: ExtensionContext, goal: GoalRecord): GoalSchedulerState {
		const s = goal.scheduler ?? newGoalScheduler(this.owner(ctx));
		if (s.owner !== this.owner(ctx) || s.phase === "interrupted") throw new Error("Goal scheduling belongs to another session or was interrupted. Use /goal-resume to take ownership.");
		return s;
	}
	private write(ctx: ExtensionContext, change: (g: GoalRecord) => GoalRecord): GoalRecord {
		const error = this.core.goalService.flushForAudit(ctx);
		if (error || this.core.goalService.isTurnBuffered()) throw new Error(error || "Goal changes have not reached disk.");
		const id = this.core.state.goal?.id;
		if (!id) throw new Error("No focused goal.");
		const result = this.core.goalService.apply(ctx, { expectedGoalId: id, mutate: change,
			ledger: g => g.status === "paused" ? [{ type: "goal_paused", goalId: g.id, reason: g.pauseReason ?? "Scheduling paused", source: "agent", at: new Date().toISOString() }] : [],
		});
		if (!result.ok) throw new Error(result.message);
		this.core.updateUI(ctx);
		return result.goal;
	}
	private update(ctx: ExtensionContext, change: (s: GoalSchedulerState, g: GoalRecord) => void): GoalRecord {
		return this.write(ctx, g => { const s = this.state(ctx, g); change(s, g); return { ...g, scheduler: s }; });
	}
	private safe(ctx: ExtensionContext, fn: () => void): void {
		try { fn(); } catch (error) {
			this.cancelTimer();
			this.core.runtime.clearContinuationState();
			ctx.ui.notify(`Goal scheduling stopped: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}
	cancelTimer(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.armedGeneration = undefined;
	}
	private later(ctx: ExtensionContext, delay: number, fn: () => void): void {
		this.cancelTimer();
		this.timer = setTimeout(() => { this.timer = undefined; this.safe(ctx, fn); }, Math.min(2_147_483_647, Math.max(0, delay)));
		this.timer.unref?.();
	}
	private pause(ctx: ExtensionContext, reason: string): void {
		this.cancelTimer();
		this.core.runtime.clearContinuationState();
		this.write(ctx, g => {
			if (g.scheduler && g.scheduler.owner !== this.owner(ctx)) throw new Error("Scheduling ownership changed; no pause was applied.");
			return { ...g, status: "paused", autoContinue: false, stopReason: "agent", pauseReason: reason,
				scheduler: g.scheduler ? { ...g.scheduler, generation: randomUUID(), phase: "idle", decision: undefined, dispatch: undefined, wait: undefined } : undefined };
		});
		this.core.clearActiveAccounting();
		ctx.ui.notify(reason, "warning");
	}
	private allowanceReason(ctx: ExtensionContext): string {
		return this.limit(ctx) === 0 ? "Automatic continuation disabled by maxAutonomousRuns=0. Change the setting in /goal-settings, then use /goal-resume." : "Autonomous-run allowance exhausted. Increase or remove maxAutonomousRuns, or use /goal-resume to renew.";
	}

	/** Bind once per live session. The event is deliberately not a triggerTurn message. */
	attach(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.unsubscribe?.();
		this.unsubscribe = this.core.pi.events?.on("pi-goal:wake", (event: unknown) => {
			const raw = asRecord(event);
			if (raw && this.ctx) this.signal(this.ctx, raw.goalId, raw.waitToken);
		});
	}
	shutdown(): void { this.cancelTimer(); this.unsubscribe?.(); this.unsubscribe = undefined; this.ctx = undefined; this.tasks = undefined; this.postTaskProgress = false; }

	/**
	 * Read a tool result for detached work through the producer registry. The
	 * in-memory set tracks the live session; the durable copy is written at
	 * settlement and on every successful scheduling update. A result that
	 * reports neither a running status nor a background launch is ignored.
	 *
	 * A result that arrives after this run recorded a task is also remembered as
	 * progress: settlement then defers the wait, because work that does not depend
	 * on the task's result must not be stranded behind it.
	 */
	noteToolResult(event: TaskResultLike & { toolCallId?: string }): BackgroundTaskRef | null {
		// Detached work only matters while the focused goal can sleep on it. A
		// complete, paused, or non-continuing goal neither tracks nor announces.
		const canWait = this.canWaitForTask();
		if (!canWait && !this.tasks) return null;
		const observation = observeToolResult(this.tasks, event);
		if (!observation.observed) { this.notePostTaskProgress(event); return null; }
		if (!canWait && observation.launched) {
			// Inert while the goal cannot wait: drop the launch, keep only
			// terminal evidence for tasks that were already tracked.
			this.tasks = { version: 1, tasks: observation.state.tasks.filter(t => this.tasks?.tasks.some(prev => prev.producer === t.producer && prev.taskId === t.taskId) ?? false) };
			return null;
		}
		this.tasks = observation.state;
		if (observation.settled) this.persistTasks();
		if (!observation.launched) return null;
		// The result that records the task is a launch, not progress: it announces
		// detached work instead of doing any. A later launch is treated the same.
		return { id: observation.launched.taskId, label: observation.launched.label, toolName: observation.launched.toolName };
	}

	/** A producer lifecycle bus event: terminal evidence without host delivery. */
	noteTaskLifecycle(payload: unknown): void {
		if (!this.tasks) return;
		const result = observeLifecycle(this.tasks, payload);
		if (result.changed) { this.tasks = result.state; this.persistTasks(); }
	}

	/** Best-effort durable sync of the in-memory task set; settlement writes authoritatively. */
	private persistTasks(): void {
		const ctx = this.ctx;
		if (!ctx || !this.tasks) return;
		try { this.update(ctx, s => { s.backgroundTasks = this.tasks; }); }
		catch { /* Mid-turn writes are buffered; settlement persists the whole set. */ }
	}

	/**
	 * Record that this run did work after it recorded a detached task. Goal
	 * bookkeeping and a refused poll of a tracked task are not work, so they
	 * never defer the wait. The flag is persisted once per run so a reload does
	 * not lose the deferral; settlement reads the in-memory value.
	 */
	private notePostTaskProgress(event: TaskResultLike): void {
		if (outstandingTasks(this.tasks).length === 0 || this.postTaskProgress) return;
		if (BOOKKEEPING_TOOL_NAMES.has(event.toolName)) return;
		if (isTaskPoll(this.tasks, event.toolName, event.input)) return;
		this.postTaskProgress = true;
		const ctx = this.ctx;
		if (!ctx) return;
		try { this.update(ctx, s => { s.postTaskProgress = true; }); }
		catch { /* Durability only: settlement still defers from the in-memory flag. */ }
	}

	/** Whether settlement would defer for a detected task: an active auto-continue goal. */
	private canWaitForTask(): boolean {
		const goal = this.core.state.goal;
		return goal !== null && goal.status === "active" && goal.autoContinue;
	}

	/** The outstanding background tasks of this session, oldest deadline first. */
	pendingBackgroundTasks(): BackgroundTaskRef[] {
		return outstandingTasks(this.tasks).map(t => ({ id: t.taskId, label: t.label, toolName: t.toolName }));
	}

	/** The primary task, kept for the ported single-task accessors and notices. */
	pendingBackgroundTask(): BackgroundTaskRef | null { return this.pendingBackgroundTasks()[0] ?? null; }

	/** Whether a call would wait on a tracked task again instead of ending the turn. */
	blocksTaskPoll(toolName: string, input: unknown): boolean {
		return this.canWaitForTask() && isTaskPoll(this.tasks, toolName, input);
	}

	/**
	 * Sleep until pi reports the pending task's result, with one scheduled
	 * re-check in case the report never arrives. The standing deadline bounds a
	 * goal whose report keeps getting lost; once it expires the deadline pause
	 * governs and no further task wait is raised.
	 */
	private deferForTask(ctx: ExtensionContext): void {
		const now = Date.now();
		// Budgets are canonical: the first wait allocates them, later waits only
		// re-project. No re-wait can renew a deadline or check quota.
		this.tasks = allocateWaits(this.tasks ?? { version: 1, tasks: [] }, now);
		const projection = projectWait(this.tasks!);
		if (!projection || projection.deadline <= now) {
			// The standing deadline governs: schedule() raises the deadline pause.
			this.schedule(ctx);
			return;
		}
		const goal = this.update(ctx, s => {
			s.backgroundTasks = this.tasks;
			s.wait = {
				id: s.wait?.taskId !== undefined ? s.wait.id : randomUUID(),
				token: randomUUID(),
				taskId: projection.id,
				reason: `Waiting for ${projection.label} to finish.`,
				deadline: projection.deadline,
				intervalMs: BACKGROUND_TASK_WAIT_MS,
				remainingChecks: projection.remainingChecks,
				nextCheckAt: projection.nextCheckAt,
			};
			s.phase = "waiting"; s.decision = { kind: "wait" }; s.dispatch = undefined; s.generation = randomUUID();
			s.postTaskProgress = false;
		});
		this.cancelTimer();
		this.core.runtime.clearContinuationState();
		this.core.runtime.markTurnStopped(goal.id);
		// No notification here: ui.notify renders a transient status row, which
		// resizes the editor and clips the goal widget for as long as it shows.
		// The wait is already visible in the widget's scheduling rows and in the
		// injected state, and it is a routine event, not something to announce.
		// Arm the re-check. The wait is event-driven, so this timer only covers a
		// result report that never arrives.
		this.schedule(ctx);
	}

	/**
	 * Defer the task wait because the run did work after the detection. Mirrors
	 * the declared-ready dispatch: persist a ready decision whose next action
	 * steers the model at the independent work, then arm the continuation. A
	 * later settle without new work raises the wait as usual.
	 */
	private deferForTaskProgress(ctx: ExtensionContext): void {
		this.update(ctx, s => {
			this.implicitReady(s);
			s.backgroundTasks = this.tasks;
			s.postTaskProgress = false;
			s.decision = { kind: "ready", purpose: "ready" };
		});
		this.schedule(ctx);
	}

	restore(ctx: ExtensionContext): void {
		this.attach(ctx);
		this.inRun = false; this.declared = false; this.runGoalId = undefined; this.postTaskProgress = false;
		this.cancelTimer();
		this.safe(ctx, () => {
			this.core.reconcileFocusedGoalFromDisk(ctx);
			const goal = this.core.state.goal;
			if (!goal || goal.status !== "active" || !goal.autoContinue || !goal.scheduler) { this.tasks = undefined; return; }
			this.tasks = goal.scheduler.backgroundTasks; // same-session reopen keeps identities and budgets
			const s = goal.scheduler;
			if (s.owner !== this.owner(ctx)) { ctx.ui.notify("Goal owned by another session. Use /goal-resume to take ownership.", "info"); return; }
			if (["claimed", "running", "interrupted"].includes(s.phase)) {
				this.pause(ctx, "Previous autonomous execution was interrupted. Use /goal-resume; its dispatch will not be replayed.");
				return;
			}
			this.schedule(ctx);
		});
	}

	/** Only explicit user resume resets spent allowance, including while already active/waiting. */
	resume(ctx: ExtensionContext): boolean {
		invalidateGoalSettingsCache();
		if (this.limit(ctx) === 0) { ctx.ui.notify(this.allowanceReason(ctx), "warning"); return false; }
		try {
			this.cancelTimer();
			this.core.runtime.clearContinuationState();
			this.write(ctx, g => {
				if (g.status === "complete" || budgetReached(g)) throw new Error("A completed or token-budget-limited goal cannot resume.");
				return { ...g, status: "active", autoContinue: true, stopReason: undefined, pauseReason: undefined, pauseSuggestedAction: undefined,
					// Resume renews allowance, not task evidence: surviving tasks keep
					// their identities and already-spent wait budgets.
					scheduler: { ...newGoalScheduler(this.owner(ctx)), backgroundTasks: g.scheduler?.backgroundTasks, phase: "ready", decision: { kind: "ready", purpose: "kickoff" } } };
			});
			this.tasks = this.core.state.goal?.scheduler?.backgroundTasks;
			// A resume during host work waits for settlement; another model turn
			// still invalidates it through turn(), just like a declaration.
			this.declared = this.inRun;
			this.schedule(ctx);
			return true;
		} catch (error) { ctx.ui.notify(String(error), "warning"); return false; }
	}
	kickoff(ctx: ExtensionContext): void {
		if (this.inRun) return; // creating a goal within a user run needs no extra run
		this.safe(ctx, () => {
			const goal = this.core.state.goal;
			if (!goal || goal.status !== "active" || !goal.autoContinue) return;
			if (this.limit(ctx) === 0) { this.update(ctx, () => {}); ctx.ui.notify(this.allowanceReason(ctx), "info"); return; }
			this.update(ctx, s => { s.phase = "ready"; s.decision = { kind: "ready", purpose: "kickoff" }; });
			this.schedule(ctx);
		});
	}

	declare(ctx: ExtensionContext, input: GoalContinuation): AgentToolResult<unknown> {
		try {
			if (!this.core.state.goal || this.core.state.goal.status !== "active" || !this.core.state.goal.autoContinue || this.denied) throw new Error("Scheduling requires an active auto-continue goal in this session.");
			invalidateGoalSettingsCache(); // an agent may have just configured the allowance
			const goal = this.update(ctx, s => {
				if (!this.available(ctx, s)) throw new Error(this.allowanceReason(ctx));
				if (input.kind === "ready") {
					s.phase = "ready"; s.decision = { kind: "ready", purpose: "ready" }; s.wait = undefined;
					s.postTaskProgress = false;
				} else if (input.kind === "wait") {
					if (!this.strict(ctx, s)) throw new Error("New waits require strictExecutionContract=true in /goal-settings. This is a user preference; continue pursuing the goal without a wait unless the user opts in.");
					if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 2000) throw new Error("wait requires a nonempty reason (at most 2000 characters).");
					const deadline = Date.parse(input.deadline);
					if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(input.deadline) || !Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new Error("wait requires a future ISO deadline with a timezone.");
					if (s.wait) {
						if (input.wait_id !== s.wait.id || deadline !== s.wait.deadline) throw new Error("Re-declare the current wait_id with its original deadline; checks cannot be reset.");
						if (input.polling && (input.polling.interval_seconds * 1000 !== s.wait.intervalMs || input.polling.max_checks !== s.wait.remainingChecks)) throw new Error("Existing wait polling cannot be reset; omit polling when re-declaring wait_id.");
						s.wait.token = randomUUID(); s.wait.signalled = false;
						if (s.wait.intervalMs) s.wait.nextCheckAt = Date.now() + s.wait.intervalMs;
					} else {
						if (input.wait_id) throw new Error("Unknown wait_id.");
						const polling = input.polling;
						if (polling && (!Number.isSafeInteger(polling.interval_seconds) || polling.interval_seconds < 1 || polling.interval_seconds > 2_147_483 || !Number.isSafeInteger(polling.max_checks) || polling.max_checks < 1)) throw new Error("Polling requires positive whole interval_seconds (at most 2147483) and max_checks.");
						s.wait = { id: randomUUID(), token: randomUUID(), reason: input.reason.trim(), deadline,
							...(polling ? { intervalMs: polling.interval_seconds * 1000, remainingChecks: polling.max_checks, nextCheckAt: Date.now() + polling.interval_seconds * 1000 } : {}) };
					}
					s.phase = "waiting"; s.decision = { kind: "wait" };
				} else throw new Error("Unknown continuation kind.");
				s.dispatch = undefined;
				s.generation = randomUUID();
			});
			this.declared = true;
			this.core.runtime.markTurnStopped(goal.id);
			const wait = goal.scheduler?.wait;
			return { content: [{ type: "text", text: `Scheduling decision saved. Stop this execution.\n${schedulerSummary(goal.scheduler, this.limit(ctx), loadGoalSettings(ctx.cwd).showAutonomousRuns)}${wait ? `\nWake token: ${wait.token}. Register this token with the producer before completion; adapters must retain early results.` : ""}` }], details: { goal, ...(wait ? { wait_id: wait.id, waitToken: wait.token } : {}) }, terminate: true };
		} catch (error) { return { content: [{ type: "text", text: `Scheduling decision NOT saved: ${error instanceof Error ? error.message : String(error)}` }], details: { error: true }, terminate: false }; }
	}

	/** One logical run can contain multiple agent_start events during native retry/compaction. */
	begin(ctx: ExtensionContext): void {
		this.ctx = ctx;
		if (this.inRun) { this.core.runningGoalId = this.core.state.goal?.id ?? null; return; }
		this.inRun = true; this.declared = false; this.denied = false;
		// A detached task outlives one run: the deferred continuation must still
		// see it so a run that does no new work can raise the wait. Only the
		// per-run progress flag resets here.
		this.postTaskProgress = false;
		this.runGoalId = this.core.state.goal?.id;
		this.cancelTimer(); this.core.runtime.clearContinuationTimer();
		this.core.runningGoalId = this.core.state.goal?.id ?? null;
	}
	turn(ctx: ExtensionContext): void {
		if (!this.declared) return;
		this.declared = false;
		this.safe(ctx, () => this.update(ctx, s => { s.decision = undefined; s.phase = "idle"; s.dispatch = undefined; }));
	}
	message(ctx: ExtensionContext, rawMessage: unknown): void {
		const msg = asRecord(rawMessage);
		if (!msg || !["user", "custom"].includes(String(msg.role))) return;
		if (msg.customType === "pi-goal-audit-event") return;
		if (msg.customType === "pi-goal-event") {
			const d = asRecord(msg.details);
			if (d?.kind !== "checkpoint") return;
			try {
				this.update(ctx, (s, g) => {
					if (d.version !== 3 || s.phase !== "claimed" || g.id !== d.goalId || s.generation !== d.generation || s.dispatch?.id !== d.dispatchId || g.status !== "active" || !g.autoContinue) throw new Error("Stale or unclaimed goal checkpoint.");
					// Retain the admitted action as context; phase prevents reusing its authorization.
					s.phase = "running";
				});
			} catch (error) {
				this.denied = true;
				this.core.runtime.setCheckpoint(String(d?.goalId ?? "invalid"));
				ctx.abort?.();
				ctx.ui.notify(`Goal checkpoint rejected: ${String(error)}`, "warning");
			}
			return;
		}
		// A producer's native report discharges the task it identifies before the
		// host turn takes over; unidentified reports change nothing.
		if (this.tasks) {
			const observed = observeHostMessage(this.tasks, rawMessage);
			if (observed.state !== this.tasks) { this.tasks = observed.state; this.persistTasks(); }
		}
		// Genuine host work supersedes an old scheduling claim, but never resets used.
		this.takeover(ctx);
	}
	takeover(ctx: ExtensionContext): void {
		this.cancelTimer(); this.core.runtime.clearContinuationState();
		this.declared = false;
		// The tracked task set survives takeover: a user instruction or producer
		// report must not drop other still-running tasks. Only the projected wait
		// and the per-run progress flag reset; budgets stay canonical in the set.
		this.postTaskProgress = false;
		const s = this.core.state.goal?.scheduler;
		if (!s || s.owner !== this.owner(ctx)) return;
		this.safe(ctx, () => this.update(ctx, state => {
			state.generation = randomUUID(); state.phase = "idle"; state.decision = undefined; state.dispatch = undefined; state.wait = undefined;
			state.backgroundTasks = this.tasks;
			state.repairUsed = false;
		}));
	}
	settled(ctx: ExtensionContext, successful = true): void {
		this.inRun = false;
		if (this.denied || (this.runGoalId && this.core.state.goal?.id !== this.runGoalId)) return;
		invalidateGoalSettingsCache();
		this.safe(ctx, () => {
			const goal = this.core.state.goal;
			if (!goal || goal.status !== "active" || !goal.autoContinue || !successful) return;
			if (this.declared && goal.scheduler?.decision) { this.schedule(ctx); return; }
			const s = this.state(ctx, goal);
			// Detached work is a wait, not a disposition: sleep instead of running a
			// continuation that could only poll the task pi already reports on. A run
			// that did work after the detection defers the wait instead, so that work
			// is not stranded behind the task.
			const outstanding = outstandingTasks(this.tasks);
			if (outstanding.length > 0) {
				const progressed = this.postTaskProgress;
				this.postTaskProgress = false;
				if (progressed) { this.deferForTaskProgress(ctx); return; }
				this.deferForTask(ctx); return;
			}
			this.postTaskProgress = false;
			this.tasks = this.tasks && this.tasks.tasks.length > 0 ? this.tasks : undefined;
			if (!this.strict(ctx, s)) {
				this.update(ctx, state => this.implicitReady(state));
				this.schedule(ctx); return;
			}
			if (s.repairUsed || !this.available(ctx, s)) {
				this.pause(ctx, !this.available(ctx, s) ? this.allowanceReason(ctx) : "No execution disposition after the contract-repair prompt. Use /goal-resume to continue.");
				return;
			}
			this.update(ctx, state => {
				state.phase = "ready"; state.dispatch = undefined;
				state.decision = { kind: "ready", purpose: "repair" };
			});
			this.schedule(ctx);
		});
	}
	recover(ctx: ExtensionContext): void {
		this.safe(ctx, () => {
			this.update(ctx, s => { s.phase = "ready"; s.dispatch = undefined; s.decision = { kind: "ready", purpose: "recovery" }; });
			this.schedule(ctx);
		});
	}

	signal(ctx: ExtensionContext, goalId: unknown, token: unknown): void {
		this.safe(ctx, () => {
			this.core.reconcileFocusedGoalFromDisk(ctx);
			const g = this.core.state.goal; const s = g?.scheduler;
			if (!g || g.id !== goalId || g.status !== "active" || !g.autoContinue || s?.owner !== this.owner(ctx) || s.phase !== "waiting" || !s.wait || s.wait.token !== token || s.wait.signalled) return;
			this.update(ctx, current => { if (current.wait?.token !== token || current.phase !== "waiting") throw new Error("Wait changed."); current.wait.signalled = true; });
			if (!this.inRun) this.schedule(ctx);
		});
	}
	schedule(ctx: ExtensionContext): void {
		if (this.inRun) return;
		invalidateGoalSettingsCache();
		this.safe(ctx, () => {
			this.core.reconcileFocusedGoalFromDisk(ctx);
			const g = this.core.state.goal;
			if (!g || g.status !== "active" || !g.autoContinue || !g.scheduler) return;
			let s = this.state(ctx, g);
			if (s.phase === "ready" && s.decision?.kind === "ready" && s.decision.purpose === "repair" && !this.strict(ctx, s)) {
				s = this.update(ctx, state => this.implicitReady(state)).scheduler!;
			}
			if (!["ready", "waiting"].includes(s.phase)) return;
			if (budgetReached(g)) { this.pause(ctx, "Goal token budget exhausted."); return; }
			if (!this.available(ctx, s)) { this.pause(ctx, this.allowanceReason(ctx)); return; }
			// Recovery and repair retain the wait while changing phase to ready.
			if (s.wait && Date.now() >= s.wait.deadline) { this.pause(ctx, "Wait deadline reached."); return; }
			if (s.phase === "waiting" && s.wait) {
				this.core.clearActiveAccounting();
				// A system task wait keeps sleeping until its deadline once its one
				// check is spent; only an explicit declared wait pauses here.
				if (!s.wait.signalled && s.wait.remainingChecks === 0 && s.wait.taskId === undefined) { this.pause(ctx, "Wait check allowance exhausted."); return; }
				if (!s.wait.signalled && (s.wait.nextCheckAt === undefined || s.wait.nextCheckAt > Date.now())) {
					const due = Math.min(s.wait.deadline, s.wait.nextCheckAt ?? Infinity);
					this.later(ctx, due - Date.now(), () => this.schedule(ctx)); return;
				}
			}
			this.cancelTimer();
			// Runtime readiness polling cannot authorize: claim() is called again at delivery.
			this.armedGeneration = s.generation;
			this.core.runtime.queueContinuation(ctx, g, true);
		});
	}
	claim(ctx: ExtensionContext): Record<string, unknown> | null {
		const generation = this.armedGeneration;
		if (!generation) return null;
		this.armedGeneration = undefined;
		invalidateGoalSettingsCache();
		try {
			let result: Record<string, unknown> | null = null;
			this.update(ctx, (s, g) => {
				if (s.generation !== generation) throw new Error("Scheduling generation changed.");
				if (g.status !== "active" || !g.autoContinue || budgetReached(g) || !this.available(ctx, s)) throw new Error(this.allowanceReason(ctx));
				if (s.wait && Date.now() >= s.wait.deadline) throw new Error("Wait deadline reached.");
				if (s.phase === "ready" && s.decision?.kind === "ready" && s.decision.purpose === "repair" && !this.strict(ctx, s)) this.implicitReady(s);
				let kind = s.phase === "ready" && s.decision?.kind === "ready" ? s.decision.purpose : undefined;
				if (s.phase === "waiting" && s.wait) {
					if (s.wait.signalled) kind = "wake";
					else if (s.wait.nextCheckAt !== undefined && s.wait.nextCheckAt <= Date.now() && (s.wait.remainingChecks ?? 0) > 0) {
						kind = "check";
						s.wait.remainingChecks!--;
						if (s.wait.taskId !== undefined && this.tasks) {
							// One dispatch spends every due task check; the projection
							// follows the canonical budgets.
							this.tasks = consumeDueChecks(this.tasks, Date.now());
							s.backgroundTasks = this.tasks;
							const projection = projectWait(this.tasks);
							if (projection) { s.wait.remainingChecks = projection.remainingChecks; s.wait.nextCheckAt = projection.nextCheckAt; }
						}
					}
				}
				if (!kind) throw new Error("No scheduling decision authorizes this checkpoint.");
				s.used++; s.phase = "claimed"; s.dispatch = { id: randomUUID(), kind, claimedAt: Date.now() };
				s.postTaskProgress = false;
				if (kind === "repair") s.repairUsed = true;
				else if (kind !== "recovery") s.repairUsed = false;
				if (s.wait) { s.wait.signalled = false; s.wait.token = randomUUID(); }
				result = { generation: s.generation, dispatchId: s.dispatch.id };
			});
			return result;
		} catch (error) {
			const current = this.core.state.goal?.scheduler;
			if (current && (current.owner !== this.owner(ctx) || current.generation !== generation)) return null;
			this.safe(ctx, () => this.pause(ctx, `Goal wake stopped: ${error instanceof Error ? error.message : String(error)}`));
			return null;
		}
	}
	failedDispatch(ctx: ExtensionContext): void {
		this.safe(ctx, () => this.pause(ctx, "Goal checkpoint delivery failed after claiming allowance. Use /goal-resume; it will not be replayed."));
	}
	isWaiting(): boolean { return !this.inRun && this.core.state.goal?.scheduler?.phase === "waiting"; }
	isDenied(): boolean { return this.denied; }
}
