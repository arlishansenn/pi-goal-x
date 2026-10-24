/**
 * Producer-aware background-task registry for the goal scheduler.
 *
 * PR #83 detects a single pending task from structured lifecycle fields and
 * parks it in scheduler memory. This registry keeps that generic detector as
 * one adapter and adds the producer contracts the fork actually runs
 * (nicobailon/pi-subagents async receipts, @quintinshaw/pi-dynamic-workflows
 * background launches), while persisting a task set keyed by
 * (producer, task id) so siblings survive launches, takeover and reload.
 *
 * The registry owns parsing, identity, terminal evidence and per-task wait
 * budgets. It never arms timers, sends messages or changes goal lifecycle:
 * authorization stays in GoalScheduler, which projects the earliest budget
 * onto the existing single wait.
 */

import { asRecord } from "./goal-record.ts";
import { observeBackgroundTask, type TaskResultLike } from "./goal-background-task.ts";

export type ProducerId =
	| "nicobailon/pi-subagents"
	| "@quintinshaw/pi-dynamic-workflows"
	| `structured:${string}`;

/** Terminal evidence about external work; not a goal lifecycle status. */
export type TaskOutcome = "completed" | "failed" | "paused" | "stopped";

/** Untrusted ids stay bounded; presentation labels stay short. */
const MAX_ID_CHARS = 200;

export interface TrackedTask {
	producer: ProducerId;
	/** Producer task id; empty for an anonymous generic observation. */
	taskId: string;
	/** Verified same-receipt alternates (e.g. runId alongside canonical asyncId). */
	aliases: readonly string[];
	label: string;
	toolName: string;
	/** Launch receipt occurrence (toolCallId) for idempotent re-observation. */
	receiptId: string;
	/** Terminal evidence; absent means running. */
	outcome?: TaskOutcome;
	/** The producer's native host report was observed for this task. */
	hostReported: boolean;
	/** Allocated at first actual waiting; immutable except remainingChecks. */
	wait?: { deadline: number; checkAt: number; remainingChecks: 0 | 1 };
}

export interface BackgroundTasksState {
	version: 1;
	tasks: readonly TrackedTask[];
}

export const BACKGROUND_TASK_WAIT_MS = 10 * 60_000;
export const BACKGROUND_TASK_DEADLINE_MARGIN_MS = 60_000;

const NICO_MODES = new Set(["single", "parallel", "chain", "workflow"]);

function boundedId(value: unknown): string {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_ID_CHARS) : "";
}

/** Launch adapters: only verified structural shapes enroll a running task. */
function producerLaunch(event: TaskResultLike & { toolCallId?: string }): TrackedTask | null {
	if (event.isError) return null;
	const details = asRecord(event.details);
	if (!details) return null;
	const receiptId = boundedId(event.toolCallId) || `${event.toolName}:${Date.now()}`;
	if (event.toolName === "subagent") {
		// nicobailon/pi-subagents async launch: mode + asyncId + asyncDir and an
		// empty results array. Management receipts carry asyncId too and must
		// not enroll; a synchronous result carries results or no async pair.
		const mode = boundedId(details.mode);
		const asyncId = boundedId(details.asyncId);
		const asyncDir = boundedId(details.asyncDir);
		const results = details.results;
		if (!NICO_MODES.has(mode) || !asyncId || !asyncDir || !Array.isArray(results) || results.length > 0) return null;
		const runId = boundedId(details.runId);
		return { producer: "nicobailon/pi-subagents", taskId: asyncId, aliases: runId && runId !== asyncId ? [runId] : [],
			label: `pi-subagents task ${asyncId}`, toolName: event.toolName, receiptId, hostReported: false };
	}
	if (event.toolName === "workflow") {
		// dynamic workflows: host details flag a background run; content prose
		// is never parsed and a foreground run does not enroll.
		const runId = boundedId(details.runId);
		if (details.background !== true || !runId) return null;
		return { producer: "@quintinshaw/pi-dynamic-workflows", taskId: runId, aliases: [],
			label: `workflow ${runId}`, toolName: event.toolName, receiptId, hostReported: false };
	}
	return null;
}

function outcomeOf(status: string): TaskOutcome | undefined {
	if (/complet|done|succeed|success/.test(status)) return "completed";
	if (/fail|error/.test(status)) return "failed";
	if (/pause/.test(status)) return "paused";
	if (/cancel|abort|timeout|timed_out|stop|delete|exit/.test(status)) return "stopped";
	return undefined;
}

/** Generic structured lifecycle (PR #83 path) mapped onto a producer namespaced by tool. */
function genericObservation(event: TaskResultLike): { launched?: TrackedTask; settled?: { taskId: string; outcome?: TaskOutcome } } {
	const observation = observeBackgroundTask(event);
	if (!observation) return {};
	if (observation.kind === "running") {
		const producer: ProducerId = `structured:${event.toolName}`;
		return { launched: { producer, taskId: observation.task.id, aliases: [],
			label: observation.task.label, toolName: event.toolName,
			receiptId: observation.task.id || `${event.toolName}:anonymous`, hostReported: false } };
	}
	return { settled: { taskId: observation.taskId } };
}

export interface ToolResultObservation {
	state: BackgroundTasksState;
	/** A newly enrolled task, for the launch notice. */
	launched?: TrackedTask;
	/** Terminal evidence observed in this result (generic lifecycle path). */
	settled?: { identity: { producer: ProducerId; taskId: string }; outcome?: TaskOutcome };
	/** True when the result itself was a background-task observation: like PR #83, it never counts as progress. */
	observed: boolean;
}

/**
 * Apply one tool result to the task set. Idempotent by (producer, taskId) and
 * by launch receipt: a repeated hook or duplicate receipt never enrolls twice.
 */
export function observeToolResult(
	current: BackgroundTasksState | undefined,
	event: TaskResultLike & { toolCallId?: string },
): ToolResultObservation {
	const tasks = current ? [...current.tasks] : [];
	const launch = producerLaunch(event);
	if (launch) {
		const existing = tasks.find(t => t.producer === launch.producer && t.taskId === launch.taskId);
		if (existing && (existing.receiptId === launch.receiptId || !existing.outcome)) {
			// Same launch seen again (multi-hook) or a resumed execution of the
			// same id: one entry. A verified new receipt after a terminal
			// outcome is a new incarnation and reopens the task.
			const reopened = existing.outcome !== undefined && existing.receiptId !== launch.receiptId;
			const merged: TrackedTask = reopened
				? { ...launch, wait: undefined }
				: { ...existing, aliases: launch.aliases, receiptId: launch.receiptId };
			const index = tasks.indexOf(existing);
			tasks[index] = merged;
			return { state: { version: 1, tasks }, launched: reopened ? merged : undefined, observed: true };
		}
		if (!existing) {
			tasks.push(launch);
			return { state: { version: 1, tasks }, launched: launch, observed: true };
		}
		return { state: { version: 1, tasks }, observed: true };
	}
	const generic = genericObservation(event);
	if (generic.settled) {
		// A settled lifecycle report matches any producer holding that id
		// unambiguously; cross-producer same-id never merges.
		const outcome = outcomeOf("settled");
		const settledTaskId = generic.settled.taskId;
		const settledOutcome = outcomeOf("settled") ?? "completed";
		let matched = false;
		for (let i = 0; i < tasks.length; i++) {
			const t = tasks[i]!;
			if (t.taskId === settledTaskId && !t.outcome) {
				tasks[i] = { ...t, outcome: settledOutcome };
				matched = true;
			}
		}
		if (matched) return { state: { version: 1, tasks }, settled: { identity: { producer: "structured:*" as ProducerId, taskId: settledTaskId }, outcome: settledOutcome }, observed: true };
	}
	if (generic.launched) {
		const existing = tasks.find(t => t.producer === generic.launched!.producer && t.taskId === generic.launched!.taskId);
		if (!existing) tasks.push(generic.launched);
		return { state: { version: 1, tasks }, launched: existing ? undefined : generic.launched, observed: true };
	}
	return { state: { version: 1, tasks }, observed: false };
}

/**
 * Apply a producer host message. `subagent-notify` carries identified
 * completions; a workflow report carries only an opaque delivery id, so it
 * discharges the single outstanding workflow task and stays conservative
 * otherwise. Returns the tasks this message reported.
 */
export function observeHostMessage(
	current: BackgroundTasksState | undefined,
	message: unknown,
): { state: BackgroundTasksState | undefined; reported: readonly TrackedTask[] } {
	if (!current || current.tasks.length === 0) return { state: current, reported: [] };
	const msg = asRecord(message);
	if (!msg || !["user", "custom"].includes(String(msg.role))) return { state: current, reported: [] };
	const customType = typeof msg.customType === "string" ? msg.customType : "";
	const details = asRecord(msg.details);
	let tasks = [...current.tasks];
	const reported: TrackedTask[] = [];
	if (customType === "subagent-notify" && details && Array.isArray(details.runs)) {
		for (const run of details.runs) {
			const r = asRecord(run);
			if (!r) continue;
			const runId = boundedId(r.runId);
			const status = boundedId(r.status).toLowerCase();
			const outcome = outcomeOf(status);
			if (!runId) continue;
			tasks = tasks.map(t => {
				if (t.producer !== "nicobailon/pi-subagents" || t.hostReported) return t;
				if (t.taskId !== runId && !t.aliases.includes(runId)) return t;
				const updated = { ...t, outcome: outcome ?? t.outcome ?? ("completed" as TaskOutcome), hostReported: true };
				reported.push(updated);
				return updated;
			});
		}
		return { state: { version: 1, tasks }, reported };
	}
	if (String(msg.role) === "user" && !customType) {
		// Generic structured producers (PR #83 compatibility) report through the
		// host turn itself: its arrival is the delivery, whatever the text says.
		// Identified producers keep identity-matched discharge below.
		let changed = false;
		const tasks2 = tasks.map(t => {
			if (!t.producer.startsWith("structured:") || t.hostReported) return t;
			changed = true;
			const updated = { ...t, hostReported: true };
			reported.push(updated);
			return updated;
		});
		if (changed) return { state: { version: 1, tasks: tasks2 }, reported };
		return { state: current, reported: [] };
	}
	if (details && boundedId(details.deliveryId)) {
		// Dynamic workflows report delivery without task identity. Unique
		// attribution discharges exactly one outstanding workflow task; with
		// several candidates nothing is claimed conservatively.
		const outstandingWorkflow = tasks.filter(t => t.producer === "@quintinshaw/pi-dynamic-workflows" && !t.hostReported && t.outcome === undefined);
		if (outstandingWorkflow.length === 1) {
			tasks = tasks.map(t => t === outstandingWorkflow[0] ? { ...t, hostReported: true } : t);
			reported.push(tasks.find(t => t === outstandingWorkflow[0])!);
		}
		return { state: { version: 1, tasks }, reported };
	}
	return { state: current, reported };
}

/** Producer lifecycle bus event: terminal evidence without host delivery. */
export function observeLifecycle(
	current: BackgroundTasksState | undefined,
	payload: unknown,
): { state: BackgroundTasksState | undefined; changed: boolean } {
	if (!current || current.tasks.length === 0) return { state: current, changed: false };
	const p = asRecord(payload);
	if (!p) return { state: current, changed: false };
	const runId = boundedId(p.runId);
	const status = boundedId(p.status).toLowerCase();
	if (!runId || !status) return { state: current, changed: false };
	let changed = false;
	const tasks = current.tasks.map(t => {
		if (t.taskId !== runId || t.outcome !== undefined) return t;
		const outcome = outcomeOf(status);
		if (!outcome) return t;
		changed = true;
		return { ...t, outcome };
	});
	return changed ? { state: { version: 1, tasks }, changed } : { state: current, changed: false };
}

const CONTROL_TOOL = /stop|cancel|kill|terminate|abort|steer|interrupt|retry|resume|delete/i;
const CONTROL_ACTIONS = new Set(["stop", "cancel", "kill", "terminate", "abort", "steer", "interrupt", "retry", "resume", "delete"]);
const POLL_ID_FIELDS = ["taskId", "task_id", "agentId", "agent_id", "id", "runId", "run_id", "asyncId", "async_id"] as const;

function isControl(toolName: string, input: unknown): boolean {
	if (CONTROL_TOOL.test(toolName)) return true;
	const args = asRecord(input);
	if (!args) return false;
	if (args.stop === true || args.cancel === true) return true;
	const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
	return CONTROL_ACTIONS.has(action);
}

function explicitIds(input: unknown): string[] {
	const args = asRecord(input);
	if (!args) return [];
	const ids: string[] = [];
	for (const field of POLL_ID_FIELDS) {
		const id = boundedId(args[field]);
		if (id) ids.push(id);
	}
	// An action/status style call nests the target under options.
	const options = asRecord(args.options);
	if (options) for (const field of POLL_ID_FIELDS) {
		const id = boundedId(options[field]);
		if (id) ids.push(id);
	}
	return ids;
}

/**
 * Whether a call waits on an outstanding tracked task again. Control actions
 * always pass. A known producer tool resolves within that producer; an
 * unknown tool is blocked only when the explicit id resolves to exactly one
 * producer (issue 828: cross-producer same-id ambiguity passes).
 */
export function isTaskPoll(
	state: BackgroundTasksState | undefined,
	toolName: string,
	input: unknown,
): boolean {
	if (!state || state.tasks.length === 0) return false;
	if (isControl(toolName, input)) return false;
	const ids = explicitIds(input);
	if (ids.length === 0) return false;
	const outstanding = outstandingTasks(state);
	const knownProducer: ProducerId | undefined =
		toolName === "subagent" ? "nicobailon/pi-subagents"
		: toolName === "workflow" ? "@quintinshaw/pi-dynamic-workflows"
		: undefined;
	let matches = outstanding.filter(t => ids.some(id => id === t.taskId || t.aliases.includes(id)));
	if (knownProducer) {
		matches = matches.filter(t => t.producer === knownProducer || t.producer.startsWith("structured:"));
		return matches.length > 0;
	}
	const producers = new Set(matches.map(t => t.producer));
	return matches.length > 0 && producers.size === 1;
}

/**
 * Tasks the goal still owes a wait for. A task leaves this set when its native
 * report has been observed, whether the report said completed, failed, paused
 * or stopped: terminal lifecycle evidence without a report stays outstanding as
 * a delivery guard until the report or the original deadline.
 */
export function outstandingTasks(state: BackgroundTasksState | undefined): readonly TrackedTask[] {
	if (!state) return [];
	return state.tasks.filter(t => !t.hostReported);
}

/** Give every outstanding task without a budget its one immutable wait window. */
export function allocateWaits(state: BackgroundTasksState, now: number): BackgroundTasksState {
	const tasks = state.tasks.map(t =>
		t.outcome === undefined && !t.wait
			? { ...t, wait: { deadline: now + BACKGROUND_TASK_WAIT_MS + BACKGROUND_TASK_DEADLINE_MARGIN_MS, checkAt: now + BACKGROUND_TASK_WAIT_MS, remainingChecks: 1 as const } }
			: t,
	);
	return { version: 1, tasks };
}

export interface WaitProjection {
	deadline: number;
	nextCheckAt?: number;
	remainingChecks: 0 | 1;
	id: string;
	label: string;
}

/** Earliest deadline and earliest unspent check across outstanding budgets. */
export function projectWait(state: BackgroundTasksState): WaitProjection | undefined {
	const withWaits = outstandingTasks(state).filter((t): t is TrackedTask & { wait: { deadline: number; checkAt: number; remainingChecks: 0 | 1 } } => t.wait !== undefined);
	if (withWaits.length === 0) return undefined;
	const deadline = Math.min(...withWaits.map(t => t.wait.deadline));
	const checkCandidates = withWaits.filter(t => t.wait.remainingChecks === 1);
	const nextCheckAt = checkCandidates.length > 0 ? Math.min(...checkCandidates.map(t => t.wait.checkAt)) : undefined;
	const primary = withWaits.slice().sort((a, b) => a.wait.deadline - b.wait.deadline)[0]!;
	return {
		deadline,
		nextCheckAt,
		remainingChecks: nextCheckAt === undefined ? 0 : 1,
		id: primary.taskId || primary.receiptId,
		label: withWaits.length === 1 ? primary.label : `${primary.label} (+${withWaits.length - 1} more)`,
	};
}

/** Spend the one check of every task whose check is due at `now`; one dispatch covers all. */
export function consumeDueChecks(state: BackgroundTasksState, now: number): BackgroundTasksState {
	const tasks = state.tasks.map(t =>
		t.wait && t.wait.remainingChecks === 1 && t.wait.checkAt <= now
			? { ...t, wait: { ...t.wait, remainingChecks: 0 as const } }
			: t,
	);
	return { version: 1, tasks };
}

/** Fail-closed validation: corrupt data interrupts scheduling, it never grants a fresh set. */
export function normalizeBackgroundTasks(raw: unknown): BackgroundTasksState | undefined | "invalid" {
	if (raw === undefined || raw === null) return undefined;
	const record = asRecord(raw);
	if (!record || record.version !== 1 || !Array.isArray(record.tasks)) return "invalid";
	const tasks: TrackedTask[] = [];
	for (const item of record.tasks) {
		const t = asRecord(item);
		if (!t || typeof t.producer !== "string" || !t.producer || typeof t.taskId !== "string" || typeof t.label !== "string" || typeof t.toolName !== "string" || typeof t.receiptId !== "string" || typeof t.hostReported !== "boolean") return "invalid";
		if (t.outcome !== undefined && !["completed", "failed", "paused", "stopped"].includes(String(t.outcome))) return "invalid";
		if (t.wait !== undefined) {
			const w = asRecord(t.wait);
			if (!w || !Number.isFinite(w.deadline) || !Number.isFinite(w.checkAt) || ![0, 1].includes(w.remainingChecks as number)) return "invalid";
		}
		tasks.push({
			producer: t.producer as ProducerId, taskId: t.taskId,
			aliases: Array.isArray(t.aliases) ? t.aliases.map(String) : [],
			label: t.label, toolName: t.toolName, receiptId: t.receiptId,
			outcome: t.outcome as TaskOutcome | undefined,
			hostReported: t.hostReported,
			wait: t.wait as TrackedTask["wait"],
		});
	}
	return { version: 1, tasks };
}
