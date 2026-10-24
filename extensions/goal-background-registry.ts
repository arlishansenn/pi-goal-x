import { asRecord } from "./goal-record.ts";
import { observeBackgroundTask, type TaskResultLike } from "./goal-background-task.ts";

type ProducerId =
	| "nicobailon/pi-subagents"
	| "ismailsaleekh/pi-background-tasks"
	| `structured:${string}`;

/** Terminal evidence about external work; not a goal lifecycle status. */
type TaskOutcome = "completed" | "failed" | "paused" | "stopped";

/** Untrusted ids stay bounded; presentation labels stay short. */
const MAX_ID_CHARS = 200;

export interface TrackedTask {
	scope?: { goalId: string; sessionId: string };
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
	scope?: { goalId: string; sessionId: string };
	tasks: readonly TrackedTask[];
}

export const BACKGROUND_TASK_WAIT_MS = 10 * 60_000;
const BACKGROUND_TASK_DEADLINE_MARGIN_MS = 60_000;

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
	return null;
}

function outcomeOf(status: string): TaskOutcome | undefined {
	if (["completed", "complete", "done", "succeeded", "success", "settled"].includes(status)) return "completed";
	if (["failed", "failure", "error"].includes(status)) return "failed";
	if (status === "paused") return "paused";
	if (["cancelled", "canceled", "aborted", "timedout", "timeout", "timed_out", "stopped", "deleted", "exited"].includes(status)) return "stopped";
	return undefined;
}

function structuredProducer(toolName: string): ProducerId {
	return ["bg_run", "bg_status"].includes(toolName) ? "ismailsaleekh/pi-background-tasks" : `structured:${toolName}`;
}

function genericObservation(event: TaskResultLike): { launched?: TrackedTask; settled?: { taskId: string; outcome: TaskOutcome } } {
	const observation = observeBackgroundTask(event);
	if (!observation) return {};
	if (observation.kind === "running") {
		return { launched: { producer: structuredProducer(event.toolName), taskId: observation.task.id, aliases: [],
			label: observation.task.label, toolName: event.toolName,
			receiptId: observation.task.id || `${event.toolName}:anonymous`, hostReported: false } };
	}
	return { settled: { taskId: observation.taskId, outcome: outcomeOf(observation.status) ?? "completed" } };
}

interface ToolResultObservation {
	state: BackgroundTasksState;
	/** A newly enrolled task, for the launch notice. */
	launched?: TrackedTask;
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
	sessionId = current?.scope?.sessionId,
): ToolResultObservation {
	let tasks = current ? [...current.tasks] : [];
	const state = (): BackgroundTasksState => ({ ...current, version: 1, scope: current?.scope, tasks });
	const launchScope = current?.scope && sessionId ? { goalId: current.scope.goalId, sessionId } : undefined;
	const owns = (t: TrackedTask) => (t.scope ?? current?.scope)?.sessionId === sessionId;
	const details = asRecord(event.details);
	if (details?.sessionId !== undefined && details.sessionId !== sessionId) return { state: state(), observed: true };
	if (event.toolName === "bg_status" && Array.isArray(details?.tasks)) {
		let observed = false;
		for (const task of details.tasks) {
			const result = observeToolResult(state(), { ...event, details: { task } }, sessionId);
			tasks = [...result.state.tasks];
			observed ||= result.observed;
		}
		return { state: state(), observed };
	}

	const parsedLaunch = producerLaunch(event);
	const launch = parsedLaunch ? { ...parsedLaunch, scope: launchScope } : null;
	if (launch) {
		const index = tasks.findIndex(t => owns(t) && t.producer === launch.producer && t.taskId === launch.taskId);
		if (index < 0) {
			tasks.push(launch);
			return { state: state(), launched: launch, observed: true };
		}
		return { state: state(), observed: true };
	}
	const nestedTask = asRecord(details?.task);
	if (nestedTask?.sessionId !== undefined && nestedTask.sessionId !== sessionId) return { state: state(), observed: true };
	const generic = genericObservation(event);
	if (generic.settled) {
		const { taskId, outcome } = generic.settled;
		const producer = structuredProducer(event.toolName);
		tasks = tasks.map(t => {
			if (!owns(t) || t.producer !== producer || t.taskId !== taskId || t.hostReported) return t;
			return { ...t, outcome, hostReported: true };
		});
		return { state: state(), observed: true };
	}
	if (generic.launched) {
		const launched = { ...generic.launched, scope: launchScope };
		const existing = tasks.find(t => owns(t) && t.producer === launched.producer && t.taskId === launched.taskId);
		if (event.toolName === "bg_status") return { state: state(), observed: true };
		if (!existing) tasks.push(launched);
		return { state: state(), launched: existing ? undefined : launched, observed: true };
	}
	return { state: state(), observed: false };
}

/** Native reports require a producer-qualified structural identity. */
export function observeHostMessage(
	current: BackgroundTasksState | undefined,
	message: unknown,
	sessionId = current?.scope?.sessionId,
): { state: BackgroundTasksState | undefined; reported: readonly TrackedTask[] } {
	if (!current || current.tasks.length === 0) return { state: current, reported: [] };
	const msg = asRecord(message);
	if (!msg || !["user", "custom"].includes(String(msg.role))) return { state: current, reported: [] };
	const details = asRecord(msg.details);
	if (!details) return { state: current, reported: [] };
	if (details.sessionId !== undefined && details.sessionId !== sessionId) return { state: current, reported: [] };
	const reported: TrackedTask[] = [];
	let tasks = [...current.tasks];
	const reports = msg.customType === "subagent-notify" && Array.isArray(details.runs) ? details.runs
		: msg.customType === "background-task-notification" ? [details] : [];
	const producer = msg.customType === "subagent-notify" ? "nicobailon/pi-subagents" : "ismailsaleekh/pi-background-tasks";
	for (const report of reports) {
		const r = asRecord(report);
		if (!r || (r.sessionId !== undefined && r.sessionId !== sessionId)) continue;
		const runId = boundedId(producer === "nicobailon/pi-subagents" ? r.runId : r.id);
		const outcome = outcomeOf(boundedId(r.status).toLowerCase());
		if (!runId || !outcome) continue;
		tasks = tasks.map(t => {
			if ((t.scope ?? current.scope)?.sessionId !== sessionId || t.producer !== producer || t.hostReported || (t.taskId !== runId && !t.aliases.includes(runId))) return t;
			const updated = { ...t, outcome, hostReported: true };
			reported.push(updated);
			return updated;
		});
	}
	return { state: { ...current, tasks }, reported };
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
		: ["bg_run", "bg_status"].includes(toolName) ? "ismailsaleekh/pi-background-tasks"
		: undefined;
	let matches = outstanding.filter(t => ids.some(id => id === t.taskId || t.aliases.includes(id)));
	if (knownProducer) {
		matches = matches.filter(t => t.producer === knownProducer || t.producer.startsWith("structured:"));
		return matches.length > 0;
	}
	const producers = new Set(matches.map(t => t.producer));
	return matches.length > 0 && producers.size === 1;
}

/** Tasks still awaiting a native host report or structured terminal result. */
export function outstandingTasks(state: BackgroundTasksState | undefined): readonly TrackedTask[] {
	if (!state) return [];
	return state.tasks.filter(t => !t.hostReported);
}

/** Give every outstanding task without a budget its one immutable wait window. */
export function allocateWaits(state: BackgroundTasksState, now: number): BackgroundTasksState {
	const tasks = state.tasks.map(t =>
		!t.hostReported && !t.wait
			? { ...t, wait: { deadline: now + BACKGROUND_TASK_WAIT_MS + BACKGROUND_TASK_DEADLINE_MARGIN_MS, checkAt: now + BACKGROUND_TASK_WAIT_MS, remainingChecks: 1 as const } }
			: t,
	);
	return { ...state, tasks };
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
	return { ...state, tasks };
}

/** Fail-closed validation: corrupt data interrupts scheduling, it never grants a fresh set. */
export function normalizeBackgroundTasks(raw: unknown): BackgroundTasksState | undefined | "invalid" {
	if (raw === undefined || raw === null) return undefined;
	const record = asRecord(raw);
	if (!record || record.version !== 1 || !Array.isArray(record.tasks)) return "invalid";
	let scope: BackgroundTasksState["scope"];
	if (record.scope !== undefined) {
		const rawScope = asRecord(record.scope);
		if (!rawScope || typeof rawScope.goalId !== "string" || !rawScope.goalId || typeof rawScope.sessionId !== "string" || !rawScope.sessionId) return "invalid";
		scope = { goalId: rawScope.goalId, sessionId: rawScope.sessionId };
	}
	const tasks: TrackedTask[] = [];
	for (const item of record.tasks) {
		const t = asRecord(item);
		if (t?.producer === "@quintinshaw/pi-dynamic-workflows") continue;
		if (!t || typeof t.producer !== "string" || !t.producer || typeof t.taskId !== "string" || typeof t.label !== "string" || typeof t.toolName !== "string" || typeof t.receiptId !== "string" || typeof t.hostReported !== "boolean") return "invalid";
		let taskScope: TrackedTask["scope"];
		if (t.scope !== undefined) {
			const rawScope = asRecord(t.scope);
			if (!rawScope || typeof rawScope.goalId !== "string" || !rawScope.goalId || typeof rawScope.sessionId !== "string" || !rawScope.sessionId || (scope && rawScope.goalId !== scope.goalId)) return "invalid";
			taskScope = { goalId: rawScope.goalId, sessionId: rawScope.sessionId };
		}
		if (t.outcome !== undefined && !["completed", "failed", "paused", "stopped"].includes(String(t.outcome))) return "invalid";
		if (t.wait !== undefined) {
			const w = asRecord(t.wait);
			if (!w || !Number.isFinite(w.deadline) || !Number.isFinite(w.checkAt) || ![0, 1].includes(w.remainingChecks as number)) return "invalid";
		}
		tasks.push({
			producer: (["structured:bg_run", "structured:bg_status"].includes(t.producer) ? "ismailsaleekh/pi-background-tasks" : t.producer) as ProducerId, taskId: t.taskId,
			aliases: Array.isArray(t.aliases) ? t.aliases.map(String) : [],
			label: t.label, toolName: t.toolName, receiptId: t.receiptId,
			outcome: t.outcome as TaskOutcome | undefined,
			...(taskScope ? { scope: taskScope } : {}),
			hostReported: t.hostReported,
			wait: t.wait as TrackedTask["wait"],
		});
	}
	return { version: 1, ...(scope ? { scope } : {}), tasks };
}
