import { asRecord } from "./goal-record.ts";
import { observeBackgroundTask, type TaskResultLike } from "./goal-background-task.ts";

export type ProducerId =
	| "nicobailon/pi-subagents"
	| "@quintinshaw/pi-dynamic-workflows"
	| "ismailsaleekh/pi-background-tasks"
	| `structured:${string}`;

/** Terminal evidence about external work; not a goal lifecycle status. */
export type TaskOutcome = "completed" | "failed" | "paused" | "stopped";

/** Untrusted ids stay bounded; presentation labels stay short. */
const MAX_ID_CHARS = 200;

export interface WorkflowIdentity {
	contractVersion: 1;
	executionEpoch: number;
	originSessionId?: string;
}

export interface TrackedTask {
	scope?: { goalId: string; sessionId: string };
	execution?: WorkflowIdentity;
	superseded?: true;
	producer: ProducerId;
	/** Producer task id; empty for an anonymous generic observation. */
	taskId: string;
	/** Verified same-receipt alternates (e.g. runId alongside canonical asyncId). */
	aliases: readonly string[];
	label: string;
	toolName: string;
	/** Launch receipt occurrence (toolCallId) for idempotent re-observation. */
	receiptId: string;
	/** Legacy resumes cannot accept unversioned terminal events from an older execution. */
	legacyResumed?: true;
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
	deliveries?: readonly { deliveryId: string; runId: string; executionEpoch: number }[];
}

export const BACKGROUND_TASK_WAIT_MS = 10 * 60_000;
export const BACKGROUND_TASK_DEADLINE_MARGIN_MS = 60_000;

const NICO_MODES = new Set(["single", "parallel", "chain", "workflow"]);

function boundedId(value: unknown): string {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_ID_CHARS) : "";
}

const DW = "@quintinshaw/pi-dynamic-workflows";

function workflowIdentity(value: Record<string, unknown>): WorkflowIdentity | undefined {
	if (value.contractVersion !== 1 || !Number.isSafeInteger(value.executionEpoch) || Number(value.executionEpoch) <= 0) return undefined;
	if (value.originSessionId !== undefined && (typeof value.originSessionId !== "string" || !value.originSessionId.trim() || value.originSessionId.length > MAX_ID_CHARS)) return undefined;
	if (typeof value.runId !== "string" || !value.runId.trim() || value.runId.length > MAX_ID_CHARS) return undefined;
	return { contractVersion: 1, executionEpoch: Number(value.executionEpoch), ...(typeof value.originSessionId === "string" ? { originSessionId: value.originSessionId } : {}) };
}

function workflowMatches(task: TrackedTask, value: Record<string, unknown>, scope: BackgroundTasksState["scope"]): boolean {
	const execution = workflowIdentity(value);
	return !!scope && !!execution && task.producer === DW && task.taskId === value.runId
		&& task.execution?.executionEpoch === execution.executionEpoch
		&& task.execution.originSessionId === execution.originSessionId
		&& (value.sessionId === undefined || value.sessionId === scope.sessionId)
		&& (execution.originSessionId === undefined || execution.originSessionId === scope.sessionId);
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
	sessionId = current?.scope?.sessionId,
): ToolResultObservation {
	let tasks = current ? [...current.tasks] : [];
	const state = (): BackgroundTasksState => ({ ...current, version: 1, scope: current?.scope, tasks });
	const launchScope = current?.scope && sessionId ? { goalId: current.scope.goalId, sessionId } : undefined;
	const owns = (t: TrackedTask) => (t.scope ?? current?.scope)?.sessionId === sessionId;
	const details = asRecord(event.details);
	if (details?.sessionId !== undefined && details.sessionId !== sessionId) return { state: state(), observed: true };
	if (event.toolName === "workflow_control" && details?.action === "resume" && details.result === "resumed" && !event.isError) {
		const run = asRecord(details.run);
		const runId = boundedId(run?.runId);
		const existing = tasks.find(t => owns(t) && t.producer === "@quintinshaw/pi-dynamic-workflows" && t.taskId === runId);
		if (!existing) return { state: state(), observed: true };
		return observeToolResult(current, { ...event, toolName: "workflow", details: { ...run, background: true, resumedFrom: runId } }, sessionId);
	}
	if (event.toolName === "workflow_control") {
		if (event.isError || details?.result === "error") return { state: state(), observed: true };
		const runs = Array.isArray(details?.runs) ? details.runs : [details?.run];
		for (const run of runs) tasks = [...observeLifecycle(state(), run, sessionId).state?.tasks ?? tasks];
		return { state: state(), observed: true };
	}
	if (event.toolName === "bg_status" && Array.isArray(details?.tasks)) {
		let observed = false;
		for (const task of details.tasks) {
			const result = observeToolResult(state(), { ...event, details: { task } }, sessionId);
			tasks = [...result.state.tasks];
			observed ||= result.observed;
		}
		return { state: state(), observed };
	}
	if (event.toolName === "workflow" && details) {
		const versioned = details.contractVersion !== undefined || details.executionEpoch !== undefined || details.originSessionId !== undefined;
		if (versioned) {
			const execution = workflowIdentity(details);
			if (!execution || !current?.scope || (execution.originSessionId !== undefined && execution.originSessionId !== sessionId)) return { state: state(), observed: true };
			const parsedLaunch = producerLaunch(event);
			const launch = parsedLaunch ? { ...parsedLaunch, scope: launchScope } : null;
			if (!launch) return { state: state(), observed: event.isError === true || details.background === true };
			const previous = tasks.filter(t => owns(t) && t.producer === DW && t.taskId === launch.taskId);
			if (previous.some(t => workflowMatches(t, details, t.scope ?? current.scope))) return { state: state(), observed: true };
			const latest = previous.reduce((epoch, t) => Math.max(epoch, t.execution?.executionEpoch ?? 0), 0);
			if (previous.length && (details.resumedFrom !== launch.taskId || execution.executionEpoch <= latest)) return { state: state(), observed: true };
			if (!previous.length && details.resumedFrom !== undefined) return { state: state(), observed: true };
			tasks = tasks.map(t => owns(t) && t.producer === DW && t.taskId === launch.taskId ? { ...t, superseded: true as const } : t);
			const enrolled = { ...launch, execution };
			tasks.push(enrolled);
			return { state: state(), launched: enrolled, observed: true };
		}
		if (tasks.some(t => owns(t) && t.producer === DW && t.taskId === details.runId && t.execution)) return { state: state(), observed: true };
	}
	const parsedLaunch = producerLaunch(event);
	const launch = parsedLaunch ? { ...parsedLaunch, scope: launchScope } : null;
	if (launch) {
		const index = tasks.findIndex(t => owns(t) && t.producer === launch.producer && t.taskId === launch.taskId);
		if (index < 0) {
			tasks.push(launch);
			return { state: state(), launched: launch, observed: true };
		}
		const existing = tasks[index]!;
		if (existing.receiptId !== launch.receiptId && existing.outcome && details?.resumedFrom === launch.taskId) {
			const resumed: TrackedTask = { ...launch, legacyResumed: true };
			tasks[index] = resumed;
			return { state: state(), launched: resumed, observed: true };
		}
		return { state: state(), observed: true };
	}
	const nestedTask = asRecord(details?.task);
	if (nestedTask?.sessionId !== undefined && nestedTask.sessionId !== sessionId) return { state: state(), observed: true };
	const generic = genericObservation(event);
	if (generic.settled) {
		const { taskId, outcome } = generic.settled;
		const producer = structuredProducer(event.toolName);
		let matched = false;
		tasks = tasks.map(t => {
			if (!owns(t) || t.producer !== producer || t.taskId !== taskId || t.hostReported) return t;
			matched = true;
			return { ...t, outcome, hostReported: true };
		});
		return { state: state(), ...(matched ? { settled: { identity: { producer, taskId }, outcome } } : {}), observed: true };
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
	if (msg.customType === "workflow-result") {
		const deliveryId = boundedId(details.deliveryId);
		if (!deliveryId || deliveryId !== details.deliveryId || details.sessionId !== sessionId || !workflowIdentity(details)) return { state: current, reported: [] };
		const index = current.tasks.findIndex(t => (t.scope ?? current.scope)?.sessionId === sessionId && workflowMatches(t, details, t.scope ?? current.scope));
		if (index < 0 || current.deliveries?.some(d => d.deliveryId === deliveryId)) return { state: current, reported: [] };
		const task = current.tasks[index]!;
		const updated = { ...task, hostReported: true };
		const tasks = current.tasks.map((t, i) => i === index ? updated : t);
		const deliveries = [...current.deliveries ?? [], { deliveryId, runId: task.taskId, executionEpoch: task.execution!.executionEpoch }];
		return { state: { ...current, tasks, deliveries }, reported: task.hostReported || task.superseded ? [] : [updated] };
	}
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

/** The subscribed bus belongs to dynamic workflows, not every producer with this ID. */
export function observeLifecycle(
	current: BackgroundTasksState | undefined,
	payload: unknown,
	sessionId = current?.scope?.sessionId,
): { state: BackgroundTasksState | undefined; changed: boolean } {
	if (!current || current.tasks.length === 0) return { state: current, changed: false };
	const p = asRecord(payload);
	if (!p || !current.scope || (p.sessionId !== undefined && p.sessionId !== sessionId)) return { state: current, changed: false };
	const runId = boundedId(p.runId);
	const outcome = outcomeOf(boundedId(p.status).toLowerCase());
	if (!runId || !outcome) return { state: current, changed: false };
	let changed = false;
	const tasks = current.tasks.map(t => {
		if ((t.scope ?? current.scope)?.sessionId !== sessionId || t.producer !== DW || t.taskId !== runId || t.outcome || t.legacyResumed) return t;
		if (t.execution ? !workflowMatches(t, p, t.scope ?? current.scope) : p.contractVersion !== undefined || p.executionEpoch !== undefined || p.originSessionId !== undefined || p.sessionId !== sessionId) return t;
		changed = true;
		return { ...t, outcome };
	});
	return { state: { ...current, tasks }, changed };
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

/**
 * Tasks the goal still owes a wait for. A task leaves this set when its native
 * report has been observed, whether the report said completed, failed, paused
 * or stopped: terminal lifecycle evidence without a report stays outstanding as
 * a delivery guard until the report or the original deadline.
 */
export function outstandingTasks(state: BackgroundTasksState | undefined): readonly TrackedTask[] {
	if (!state) return [];
	return state.tasks.filter(t => !t.hostReported && !t.superseded);
}

/** Give every outstanding task without a budget its one immutable wait window. */
export function allocateWaits(state: BackgroundTasksState, now: number): BackgroundTasksState {
	const tasks = state.tasks.map(t =>
		!t.hostReported && !t.superseded && !t.wait
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
		if (!t || typeof t.producer !== "string" || !t.producer || typeof t.taskId !== "string" || typeof t.label !== "string" || typeof t.toolName !== "string" || typeof t.receiptId !== "string" || typeof t.hostReported !== "boolean") return "invalid";
		let taskScope: TrackedTask["scope"];
		if (t.scope !== undefined) {
			const rawScope = asRecord(t.scope);
			if (!rawScope || typeof rawScope.goalId !== "string" || !rawScope.goalId || typeof rawScope.sessionId !== "string" || !rawScope.sessionId || (scope && rawScope.goalId !== scope.goalId)) return "invalid";
			taskScope = { goalId: rawScope.goalId, sessionId: rawScope.sessionId };
		}
		let execution: WorkflowIdentity | undefined;
		if (t.execution !== undefined) {
			const rawExecution = asRecord(t.execution);
			execution = rawExecution ? workflowIdentity({ ...rawExecution, runId: t.taskId }) : undefined;
			if (!execution || t.producer !== DW) return "invalid";
		}
		if (t.superseded !== undefined && t.superseded !== true) return "invalid";
		if (t.legacyResumed !== undefined && t.legacyResumed !== true) return "invalid";
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
			...(t.legacyResumed === true ? { legacyResumed: true as const } : {}),
			...(taskScope ? { scope: taskScope } : {}),
			...(execution ? { execution } : {}),
			...(t.superseded === true ? { superseded: true as const } : {}),
			hostReported: t.hostReported,
			wait: t.wait as TrackedTask["wait"],
		});
	}
	const deliveries: NonNullable<BackgroundTasksState["deliveries"]>[number][] = [];
	if (record.deliveries !== undefined) {
		if (!Array.isArray(record.deliveries)) return "invalid";
		for (const value of record.deliveries) {
			const d = asRecord(value);
			if (!d || !boundedId(d.deliveryId) || boundedId(d.deliveryId) !== d.deliveryId || !boundedId(d.runId) || !Number.isSafeInteger(d.executionEpoch) || Number(d.executionEpoch) <= 0 || deliveries.some(prior => prior.deliveryId === d.deliveryId)) return "invalid";
			deliveries.push({ deliveryId: String(d.deliveryId), runId: String(d.runId), executionEpoch: Number(d.executionEpoch) });
		}
	}
	return { version: 1, ...(scope ? { scope } : {}), tasks, ...(record.deliveries !== undefined ? { deliveries } : {}) };
}
