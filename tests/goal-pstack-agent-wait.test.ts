import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import type { GoalCore } from "../extensions/goal-state.ts";
import { createGoal, goalFocusDetails, type GoalRecord } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { invalidateGoalSettingsCache } from "../extensions/goal-settings.ts";
import { readGoalLedger } from "../extensions/goal-ledger.ts";
import { RECOVERY_BACKUP_DIR } from "../extensions/goal-recovery.ts";

/**
 * Issue 10 at the extension's public boundary. The launch receipt and the
 * notice follow the pstack 0.9.102 source (plugins/pstack/pi/agent-tools.ts,
 * agent-text.ts, agents.ts): `agent` with run_in_background returns
 * details { agentId, status: "running" }; the end sends customType
 * "pstack-agent" with details { agentId, status, exitCode, outputFile }, and a
 * stop sends it with triggerTurn=false, which pi appends without an extension
 * message event. Every end persists a "pstack-agents" session entry first.
 * The only producer-declared task deadline is nicobailon/pi-subagents'
 * absolute integer `details.deadlineAt` (verified native receipts); tool-input
 * timeouts are never read and no system deadline or check is manufactured.
 */

const NOW = 1_800_000_000_000;
const OWNER = "owner-1";

interface FixtureOptions { owner?: string; prepare?: (goal: GoalRecord) => void; confirm?: boolean; onConfirm?: (title: string, message: string) => unknown; settings?: Record<string, unknown> }

async function fixture(t: TestContext, options: FixtureOptions = {}) {
	const cwd = mkdtempSync(path.join(tmpdir(), "pgx-pstack-"));
	const sessionDir = path.join(cwd, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ strictExecutionContract: false, ...options.settings }));
	const prior = process.env.PI_GOAL_GLOBAL_SETTINGS_FILE;
	process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = path.join(cwd, "absent-global.json");
	invalidateGoalSettingsCache();
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
	const goal = createGoal({ objective: "Wait for a pstack agent", autoContinue: true, sisyphus: false });
	goal.id = "pstack-agent-fixture";
	options.prepare?.(goal);
	writeActiveGoalFile({ cwd }, goal);
	const handlers: Record<string, Function> = {};
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const sent: any[] = [];
	const notifications: string[] = [];
	const listeners = new Map<string, Function>();
	const branch: any[] = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }];
	const pi = {
		registerTool: () => {},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (event: string, handler: Function) => { handlers[event] = handler; },
		getActiveTools: () => ["read", "write", "agent"],
		setActiveTools: () => {},
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (message: unknown) => { sent.push(message); },
		events: { on: (name: string, fn: Function) => { listeners.set(name, fn); return () => listeners.delete(name); }, emit: (name: string, event: unknown) => listeners.get(name)?.(event) },
	};
	const ctx = {
		cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
		getSystemPrompt: () => "base",
		sessionManager: { getSessionId: () => options.owner ?? OWNER, getSessionDir: () => sessionDir, getCwd: () => cwd, getRoot: () => cwd, getBranch: () => branch },
		ui: { notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {}, confirm: async (title: string, message: string) => { await options.onConfirm?.(title, message); return options.confirm ?? true; } },
	} as unknown as ExtensionContext;
	goalExtension(pi as any);
	const core = (pi as any)._goalCore as GoalCore;
	await core.loadState(ctx);
	core.scheduler.attach(ctx);
	t.after(() => {
		core.scheduler.shutdown();
		core.runtime.clearContinuationState();
		rmSync(cwd, { recursive: true, force: true });
		if (prior === undefined) delete process.env.PI_GOAL_GLOBAL_SETTINGS_FILE; else process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = prior;
		invalidateGoalSettingsCache();
	});
	const launch = (agentId: string, input: Record<string, unknown> = {}) => handlers.tool_result!({
		toolName: "agent", toolCallId: `call-${agentId}`, isError: false,
		input: { description: "delegate", prompt: "work", run_in_background: true, ...input },
		details: { agentId, status: "running" },
		content: [{ type: "text", text: JSON.stringify({ agentId, status: "running" }) }],
	}, ctx);
	const notice = (agentId: string, status: string, extra: Record<string, unknown> = {}) => ({
		role: "custom", customType: "pstack-agent",
		content: `pstack agent finished.\nagentId: ${agentId}\nstatus: ${status}`,
		details: { agentId, status, exitCode: status === "completed" ? 0 : null, outputFile: undefined, ...extra },
	});
	const agentRecord = (agentId: string, status: string) => ({
		type: "custom", id: `entry-${agentId}-${status}`, parentId: null, timestamp: new Date(NOW).toISOString(), customType: "pstack-agents",
		data: { agent: { id: agentId, description: "delegate", subagentType: "general", sessionId: `child-${agentId}`, sessionDir, cwd, startedAt: new Date(NOW).toISOString() },
			status, exitCode: status === "completed" ? 0 : null, endedAt: new Date(NOW).toISOString(), finalText: "done" },
	});
	const nico = (runId: string, extra: Record<string, unknown> = {}) => handlers.tool_result!({
		toolName: "subagent", toolCallId: `launch-${runId}`, isError: false,
		input: { agent: "delegate", task: "work", async: true },
		details: { mode: "single", runId, asyncId: runId, asyncDir: `/tmp/async-subagent-runs/${runId}`, results: [], context: "fresh", timeoutMs: 1800000, ...extra },
		content: [{ type: "text", text: `Async: delegate [${runId}]` }],
	}, ctx);
	const run = async (fn: () => unknown) => { core.scheduler.begin(ctx); await fn(); core.scheduler.settled(ctx); };
	const current = () => core.state.goal!;
	const command = (name: string, args = "") => commands.get(name)!.handler(args, ctx);
	const result = (event: Record<string, unknown>) => handlers.tool_result!(event, ctx);
	return { cwd, ctx, core, sent, notifications, branch, sessionDir, launch, notice, agentRecord, nico, run, current, command, result };
}

function pausedWithTasks(goal: GoalRecord, tasks: Record<string, unknown>[], owner: string, sessionId = owner): void {
	goal.status = "paused"; goal.autoContinue = false; goal.pauseReason = "Wait deadline reached."; goal.stopReason = "agent";
	goal.scheduler = { version: 1, owner, generation: "gen-legacy", used: 3, phase: "idle", repairUsed: false,
		backgroundTasks: { version: 1, scope: { goalId: goal.id, sessionId }, tasks: tasks as never } };
}

const legacyTask = (taskId: string, sessionId = OWNER) => ({
	producer: "structured:agent", taskId, aliases: [], label: `agent task ${taskId}`, toolName: "agent", receiptId: taskId,
	hostReported: false, scope: { goalId: "pstack-agent-fixture", sessionId },
	wait: { deadline: NOW - 1, checkAt: NOW - 60_001, remainingChecks: 0 },
});

for (const status of ["completed", "failed", "stopped"]) test(`a pstack-agent ${status} notice retires its task and the goal continues`, async t => {
	const h = await fixture(t);
	await h.run(() => h.launch("a-1"));
	assert.equal(h.current().scheduler?.phase, "waiting");
	h.core.scheduler.begin(h.ctx);
	h.core.scheduler.message(h.ctx, h.notice("a-1", status));
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks(), [], "the exact agentId retires the task");
	assert.equal(h.current().scheduler?.backgroundTasks?.tasks[0]?.outcome, status, "the producer status is kept as evidence");
	h.core.scheduler.settled(h.ctx);
	t.mock.timers.tick(1);
	assert.equal(h.current().status, "active");
	assert.equal(h.current().scheduler?.wait, undefined);
	assert.equal(h.sent.length, 1, "the goal continues after the report");
});

test("duplicate, foreign-session, wrong-producer, and wrong-id pstack notices settle nothing extra", async t => {
	const h = await fixture(t);
	await h.run(async () => {
		await h.launch("a-1");
		await h.launch("a-2");
	});
	const ids = () => h.core.scheduler.pendingBackgroundTasks().map(task => task.id).sort();
	assert.deepEqual(ids(), ["a-1", "a-2"]);
	h.core.scheduler.message(h.ctx, h.notice("a-1", "completed", { sessionId: "other-session" }));
	assert.deepEqual(ids(), ["a-1", "a-2"], "a supplied foreign session is rejected");
	h.core.scheduler.message(h.ctx, h.notice("a-9", "completed"));
	h.core.scheduler.message(h.ctx, h.notice("a-1", "running"));
	h.core.scheduler.message(h.ctx, h.notice("a-1", "done"));
	h.core.scheduler.message(h.ctx, { role: "custom", customType: "pstack-agent", details: { id: "a-1", status: "completed" } });
	h.core.scheduler.message(h.ctx, { role: "custom", customType: "subagent-notify", details: { runs: [{ runId: "a-1", status: "completed" }] } });
	h.core.scheduler.message(h.ctx, { role: "assistant", customType: "pstack-agent", details: { agentId: "a-1", status: "completed" } });
	assert.deepEqual(ids(), ["a-1", "a-2"], "unknown ids, non-terminal statuses, other fields and producers settle nothing");
	h.core.scheduler.message(h.ctx, h.notice("a-1", "completed"));
	h.core.scheduler.message(h.ctx, h.notice("a-1", "failed"));
	assert.deepEqual(ids(), ["a-2"], "the sibling stays tracked");
	assert.equal(h.current().scheduler?.backgroundTasks?.tasks.find(task => task.taskId === "a-1")?.outcome, "completed", "a duplicate notice does not rewrite the first outcome");
});

test("a pstack notice cannot settle a same-id task from another producer", async t => {
	const h = await fixture(t);
	await h.run(() => h.core.scheduler.noteToolResult(h.ctx, { toolName: "pwsh", toolCallId: "call-p", details: { taskId: "a-1", status: "running" }, isError: false }));
	h.core.scheduler.message(h.ctx, h.notice("a-1", "completed"));
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks().map(task => task.id), ["a-1"]);
});

test("an undeclared task waits past eleven minutes without a manufactured deadline or check", async t => {
	const h = await fixture(t);
	await h.run(() => h.launch("a-1"));
	const wait = h.current().scheduler?.wait;
	assert.equal(wait?.taskId, "a-1");
	assert.equal(wait?.deadline, undefined, "no deadline is invented");
	assert.equal(wait?.nextCheckAt, undefined, "no check is invented");
	t.mock.timers.tick(2 * 60 * 60_000);
	assert.equal(h.current().status, "active", "a long task does not pause the goal");
	assert.equal(h.current().scheduler?.phase, "waiting");
	assert.equal(h.sent.length, 0, "no polling run is dispatched");
});

test("a producer-declared deadlineAt bounds the wait and nothing renews it", async t => {
	const h = await fixture(t);
	await h.run(() => h.nico("n-1", { deadlineAt: NOW + 120_000 }));
	assert.equal(h.current().scheduler?.wait?.taskId, "n-1");
	assert.equal(h.current().scheduler?.wait?.deadline, NOW + 120_000, "the verified absolute deadlineAt is the deadline, without a margin");
	t.mock.timers.tick(60_000);
	h.core.scheduler.message(h.ctx, { role: "user", content: "keep going" });
	await h.run(() => h.nico("n-1", { deadlineAt: NOW + 600_000 }));
	assert.equal(h.current().scheduler?.wait?.deadline, NOW + 120_000, "a repeated receipt or a new wait does not renew it");
	t.mock.timers.tick(59_999);
	assert.equal(h.current().status, "active");
	t.mock.timers.tick(1);
	assert.equal(h.current().status, "paused");
	assert.match(h.current().pauseReason ?? "", /deadline/i);
});

test("no deadline is invented: tool input timeouts and invalid deadlineAt values are ignored", async t => {
	const h = await fixture(t);
	await h.run(() => h.launch("a-1", { timeoutMs: 120_000 }));
	assert.equal(h.current().scheduler?.wait?.deadline, undefined, "a tool-input timeoutMs is not a wait contract");
	await h.run(() => h.nico("n-bad", { deadlineAt: "soon" }));
	await h.run(() => h.nico("n-neg", { deadlineAt: -1 }));
	const waits = h.current().scheduler?.backgroundTasks?.tasks ?? [];
	assert.equal(waits.find(task => task.taskId === "n-bad")?.deadline, undefined, "a non-integer deadlineAt is not adopted");
	assert.equal(waits.find(task => task.taskId === "n-neg")?.deadline, undefined, "a negative deadlineAt is not adopted");
	t.mock.timers.tick(2 * 60 * 60_000);
	assert.equal(h.current().status, "active", "undeclared work waits event-driven");
});

test("a native stop without an extension message retires the task from its session record", async t => {
	const h = await fixture(t);
	await h.run(() => h.launch("a-1"));
	await h.run(async () => {
		h.branch.push(h.agentRecord("a-1", "stopped"));
		await h.core.scheduler.noteToolResult(h.ctx, { toolName: "stop_agent", toolCallId: "call-stop", input: { id: "a-1" }, details: { agentId: "a-1", status: "stopped" }, isError: false });
	});
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks(), []);
	assert.equal(h.current().scheduler?.backgroundTasks?.tasks[0]?.outcome, "stopped");
	t.mock.timers.tick(1);
	assert.equal(h.current().scheduler?.phase === "waiting", false, "the goal does not wait on a stopped task");
	assert.equal(h.sent.length, 1, "the goal continues");
});

test("send_message re-enrolls the agent run and the old terminal record cannot settle it", async t => {
	const h = await fixture(t);
	await h.run(() => h.launch("a-1"));
	h.core.scheduler.message(h.ctx, h.notice("a-1", "completed"));
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks(), []);
	// send_message to a finished agent starts a new background run under the
	// same id (agents.ts): the receipt re-enrolls it, and the earlier terminal
	// session record must not settle the new run.
	await h.run(() => h.core.scheduler.noteToolResult(h.ctx, { toolName: "send_message", toolCallId: "send-1", input: { to: "a-1", message: "again" }, details: { agentId: "a-1", running: false }, isError: false }));
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks().map(task => task.id), ["a-1"], "the new run is tracked again under the same id");
	t.mock.timers.tick(10_000);
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks().map(task => task.id), ["a-1"], "the old completed record in the map never settles the new run");
	h.branch.push(h.agentRecord("a-1", "running"), h.agentRecord("a-1", "failed"));
	h.core.scheduler.restore(h.ctx);
	t.mock.timers.tick(1);
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks(), [], "the new run's own terminal record settles it");
	assert.equal(h.current().scheduler?.backgroundTasks?.tasks[0]?.outcome, "failed");
	t.mock.timers.tick(1);
	assert.equal(h.sent.length, 1, "the goal continues");
});

test("a terminal record already in the session prevents an eternal wait", async t => {
	const h = await fixture(t);
	h.branch.push(h.agentRecord("a-early", "completed"));
	await h.run(() => h.launch("a-early"));
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks(), [], "the record scanned at settlement retires the task at once; no wait is raised");
	t.mock.timers.tick(1);
	assert.equal(h.current().status, "active");
	assert.equal(h.sent.length, 1, "the goal continues");
});

test("a stop_agent result settles its agent even when the goal pauses in the same turn", async t => {
	const h = await fixture(t);
	await h.run(() => h.launch("a-1"));
	h.branch.push(h.agentRecord("a-1", "stopped"));
	// The real sequence: the tool_result event fires, then the model pauses the
	// goal with update_goal before any settlement could scan.
	await h.result({ toolName: "stop_agent", toolCallId: "stop-1", input: { id: "a-1" }, details: { agentId: "a-1", status: "stopped" }, isError: false, content: [{ type: "text", text: "stopped" }] });
	h.core.pauseActiveGoal(h.ctx);
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks(), [], "the stop result settles the agent it names");
	const task = h.current().scheduler?.backgroundTasks?.tasks[0];
	assert.equal(task?.hostReported, true);
	assert.equal(task?.outcome, "stopped");
});

test("a session record names only its own agent; a later running record reopens nothing it settled", async t => {
	const h = await fixture(t);
	await h.run(async () => { await h.launch("a-1"); await h.launch("a-2"); });
	h.branch.push(h.agentRecord("a-1", "running"), h.agentRecord("a-2", "completed"), h.agentRecord("a-2", "running"));
	h.core.scheduler.restore(h.ctx);
	t.mock.timers.tick(1);
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks().map(task => task.id).sort(), ["a-1", "a-2"], "only the last record per agent counts");
	h.branch.push(h.agentRecord("a-2", "failed"));
	h.core.scheduler.restore(h.ctx);
	t.mock.timers.tick(1);
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks().map(task => task.id), ["a-1"], "partial completion keeps the sibling");
	assert.equal(h.current().scheduler?.phase, "waiting");
	assert.equal(h.current().scheduler?.wait?.taskId, "a-1");
});

test("a reload sees an orphan stop the producer records after the goal restores", async t => {
	const h = await fixture(t);
	await h.run(() => h.launch("a-1"));
	h.core.scheduler.shutdown();
	h.core.scheduler.restore(h.ctx);
	h.branch.push(h.agentRecord("a-1", "stopped"));
	t.mock.timers.tick(1);
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks(), [], "the stopped record retires the task without a notice");
	assert.equal(h.sent.length, 1, "the goal continues");
});

test("a persisted fixed-window task wait no longer pauses; the task and its identity survive", async t => {
	const h = await fixture(t, { prepare: goal => {
		goal.scheduler = { version: 1, owner: OWNER, generation: "gen-legacy", used: 2, phase: "waiting", repairUsed: false, decision: { kind: "wait" },
			wait: { id: "w-1", token: "tok-1", taskId: "a-1", reason: "Waiting for agent task a-1 to finish.", deadline: NOW + 60_000, intervalMs: 600_000, remainingChecks: 0 },
			backgroundTasks: { version: 1, scope: { goalId: goal.id, sessionId: OWNER }, tasks: [{ ...legacyTask("a-1"), wait: { deadline: NOW + 60_000, checkAt: NOW, remainingChecks: 0 } }] as never } };
	} });
	h.core.scheduler.restore(h.ctx);
	t.mock.timers.tick(60 * 60_000);
	const goal = h.current();
	assert.equal(goal.status, "active", "the system-made deadline no longer authorizes a pause");
	assert.equal(goal.scheduler?.phase, "waiting");
	assert.equal(goal.scheduler?.wait?.deadline, undefined);
	assert.equal(goal.scheduler?.used, 2, "spent allowance is not reset");
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks().map(task => task.id), ["a-1"], "the task is not erased");
});

test("a persisted caller wait keeps its declared deadline", async t => {
	const h = await fixture(t, { prepare: goal => {
		goal.scheduler = { version: 1, owner: OWNER, generation: "gen-caller", used: 1, phase: "waiting", repairUsed: false, decision: { kind: "wait" },
			wait: { id: "w-c", token: "tok-c", reason: "CI run", deadline: NOW + 60_000 } };
	} });
	h.core.scheduler.restore(h.ctx);
	assert.equal(h.current().scheduler?.wait?.deadline, NOW + 60_000);
	t.mock.timers.tick(60_000);
	assert.equal(h.current().status, "paused");
	assert.match(h.current().pauseReason ?? "", /deadline/i);
});

test("/goal-resume of an issue-10 goal retires the reported task and stays active", async t => {
	const h = await fixture(t, { prepare: goal => pausedWithTasks(goal, [legacyTask("a-1")], OWNER) });
	h.branch.push(h.agentRecord("a-1", "running"), h.agentRecord("a-1", "completed"));
	await h.command("goal-resume");
	t.mock.timers.tick(1);
	assert.equal(h.current().status, "active", "resume does not re-pause on the old deadline");
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks(), []);
	assert.ok(h.notifications.some(message => /Goal resumed/.test(message)));
});

test("/goal-resume stays truthful while the agent still runs", async t => {
	const h = await fixture(t, { prepare: goal => pausedWithTasks(goal, [legacyTask("a-1")], OWNER) });
	h.branch.push(h.agentRecord("a-1", "running"));
	await h.command("goal-resume");
	t.mock.timers.tick(1);
	assert.equal(h.current().status, "active", "resume continues the goal");
	assert.deepEqual(h.core.scheduler.pendingBackgroundTasks().map(task => task.id), ["a-1"], "a still-running agent is not faked complete");
	assert.ok(h.notifications.some(message => /Goal resumed/.test(message)));
});

test("/goal-resume after an expired producer deadlineAt reports the deadline, not success", async t => {
	const h = await fixture(t);
	await h.run(() => h.nico("n-1", { deadlineAt: NOW + 120_000 }));
	t.mock.timers.tick(120_000);
	assert.equal(h.current().status, "paused");
	const goalFile = path.resolve(h.cwd, h.current().activePath!);
	const before = readFileSync(goalFile, "utf8");
	const sentBefore = h.sent.length;
	await h.command("goal-resume");
	t.mock.timers.tick(1);
	assert.equal(h.current().status, "paused", "an expired explicit producer deadline still blocks the resume");
	assert.equal(readFileSync(goalFile, "utf8"), before, "the refused resume writes nothing; the task keeps its identity and deadline");
	assert.equal(h.sent.length, sentBefore, "no kickoff run is dispatched only to re-pause at settle");
	assert.ok(!h.notifications.some(message => /Goal resumed/.test(message)), h.notifications.join("\n"));
	assert.ok(h.notifications.some(message => /deadline/i.test(message) && message.includes(new Date(NOW + 120_000).toISOString())), h.notifications.join("\n"));
	assert.ok(!readGoalLedger(h.ctx).events.some(event => event.type === "goal_resumed"), "no resume is recorded");
});

test("/goal-resume reports no success when continuation is disabled", async t => {
	const h = await fixture(t, { settings: { maxAutonomousRuns: 0 }, prepare: goal => pausedWithTasks(goal, [legacyTask("a-1")], OWNER) });
	h.branch.push(h.agentRecord("a-1", "completed"));
	await h.command("goal-resume");
	assert.equal(h.current().status, "paused", "a disabled allowance changes nothing");
	assert.ok(!h.notifications.some(message => /Goal resumed/.test(message)), h.notifications.join("\n"));
	assert.ok(!readGoalLedger(h.ctx).events.some(event => event.type === "goal_resumed"), "no resume is recorded");
});

function writeSession(dir: string, sessionId: string, entries: unknown[], fileName = `2026-10-26T07-00-00-000Z_${sessionId}.jsonl`): string {
	const file = path.join(dir, fileName);
	const header = { type: "session", version: 3, id: sessionId, timestamp: new Date(NOW).toISOString(), cwd: dir };
	writeFileSync(file, [header, ...entries].map(line => JSON.stringify(line)).join("\n") + "\n");
	return file;
}

test("/goal-recovery tasks settles only receipt-verified tasks, after confirmation, with a backup and ledger", async t => {
	const h = await fixture(t, { owner: "new-session", prepare: goal => pausedWithTasks(goal, [legacyTask("a-done", "old-session"), legacyTask("a-other", "old-session"), legacyTask("a-running", "old-session")], "old-session") });
	writeSession(h.sessionDir, "old-session", [h.agentRecord("a-done", "running"), h.agentRecord("a-done", "completed"), h.agentRecord("a-running", "running")]);
	writeSession(h.sessionDir, "other-session", [h.agentRecord("a-other", "completed")]);
	writeSession(h.sessionDir, "forged-session", [h.agentRecord("a-other", "completed")], "2026-10-26T08-00-00-000Z_old-session.jsonl");
	const goalFile = path.resolve(h.cwd, h.current().activePath!);
	const original = readFileSync(goalFile, "utf8");
	await h.command("goal-recovery", "tasks");
	const tasks = h.current().scheduler?.backgroundTasks?.tasks ?? [];
	assert.deepEqual(tasks.map(task => [task.taskId, task.hostReported, task.outcome ?? null]), [["a-done", true, "completed"], ["a-other", false, null], ["a-running", false, null]]);
	assert.equal(h.current().status, "paused", "recovery settles evidence; it does not resume");
	const backupRoot = path.join(h.cwd, RECOVERY_BACKUP_DIR);
	const [stamp] = readdirSync(backupRoot);
	assert.equal(readFileSync(path.join(backupRoot, stamp!, path.basename(goalFile)), "utf8"), original, "the goal file is backed up before the change");
	const recovered = readGoalLedger(h.ctx).events.filter(event => event.type === "background_task_recovered");
	assert.equal(recovered.length, 1);
	assert.deepEqual({ ...recovered[0], at: undefined }, { type: "background_task_recovered", goalId: "pstack-agent-fixture", producer: "structured:agent", taskId: "a-done", receiptId: "a-done", outcome: "completed", sessionId: "old-session", evidenceEntryId: "entry-a-done-completed", at: undefined });
	assert.ok(h.notifications.some(message => /1 task/.test(message) && message.includes(stamp!)), h.notifications.join("\n"));
});

test("/goal-recovery tasks rejects latest-running, ambiguous, and malformed files; agreeing duplicates settle once", async t => {
	const h = await fixture(t, { owner: "new-session", prepare: goal => pausedWithTasks(goal, [legacyTask("a-done", "old-session"), legacyTask("a-fork", "old-session"), legacyTask("a-tie", "old-session")], "old-session") });
	writeSession(h.sessionDir, "old-session", [h.agentRecord("a-done", "running"), h.agentRecord("a-done", "completed"), h.agentRecord("a-done", "running")]);
	writeSession(h.sessionDir, "old-session", [h.agentRecord("a-fork", "completed")], "2026-10-26T09-00-00-000Z_old-session.jsonl");
	writeSession(h.sessionDir, "old-session", [h.agentRecord("a-fork", "completed")], "2026-10-26T09-15-00-000Z_old-session.jsonl");
	// Same-status forked copies agree; a lexically later copy cannot flip them.
	writeSession(h.sessionDir, "old-session", [h.agentRecord("a-tie", "completed")], "2026-10-26T09-30-00-000Z_old-session.jsonl");
	writeSession(h.sessionDir, "old-session", [h.agentRecord("a-tie", "running")], "2026-10-26T09-45-00-000Z_old-session.jsonl");
	// A malformed header in an unrelated file must not abort the scan.
	writeFileSync(path.join(h.sessionDir, "2026-10-26T10-00-00-000Z_old-session.jsonl"), "{not json\n");
	await h.command("goal-recovery", "tasks");
	const tasks = h.current().scheduler?.backgroundTasks?.tasks ?? [];
	assert.deepEqual(tasks.map(task => [task.taskId, task.hostReported]), [["a-done", false], ["a-fork", true], ["a-tie", false]], "only a latest, unambiguous terminal receipt verifies");
	const recovered = readGoalLedger(h.ctx).events.filter(event => event.type === "background_task_recovered");
	assert.equal(recovered.length, 1, "agreeing duplicates settle once, with one auditable event");
	assert.equal(recovered[0]?.taskId, "a-fork");
});

test("/goal-recovery tasks settles nothing when the goal changes during confirmation", async t => {
	const h = await fixture(t, { owner: "new-session", onConfirm: () => {
		// A concurrent writer settles the same task while the user reads the prompt.
		h.core.goalService.apply(h.ctx, { expectedGoalId: h.current().id, mutate: goal => {
			const scheduler = goal.scheduler!;
			scheduler.backgroundTasks = { ...scheduler.backgroundTasks!, tasks: scheduler.backgroundTasks!.tasks.map(task => task.taskId === "a-done" ? { ...task, hostReported: true, outcome: "completed" } : task) };
			return { ...goal, scheduler };
		} });
	}, prepare: goal => pausedWithTasks(goal, [legacyTask("a-done", "old-session")], "old-session") });
	writeSession(h.sessionDir, "old-session", [h.agentRecord("a-done", "completed")]);
	await h.command("goal-recovery", "tasks");
	assert.ok(h.notifications.some(message => /nothing changed/i.test(message)), h.notifications.join("\n"));
	assert.ok(!readGoalLedger(h.ctx).events.some(event => event.type === "background_task_recovered"), "no settlement is claimed that was not applied");
	assert.equal(existsSync(path.join(h.cwd, RECOVERY_BACKUP_DIR)), false, "no backup is taken when nothing is written");
});

for (const owner of ["new-session", "old-session"]) test(`/goal-recovery tasks leaves an active goal's lifecycle unchanged (${owner === "new-session" ? "same" : "foreign"} owner)`, async t => {
	let prompt = "";
	const h = await fixture(t, { owner: "new-session", onConfirm: (title, message) => { prompt = `${title}\n${message}`; }, prepare: goal => {
		goal.scheduler = { version: 1, owner, generation: "gen-active", used: 1, phase: "idle", repairUsed: false,
			backgroundTasks: { version: 1, scope: { goalId: goal.id, sessionId: "old-session" }, tasks: [legacyTask("a-done", "old-session")] as never } };
	} });
	writeSession(h.sessionDir, "old-session", [h.agentRecord("a-done", "completed")]);
	const lifecycle = () => { const g = h.current(); return [g.status, g.autoContinue, g.pauseReason ?? null, g.scheduler?.owner, g.scheduler?.phase, g.scheduler?.used]; };
	const before = lifecycle();
	assert.equal(before[0], "active");
	await h.command("goal-recovery", "tasks");
	assert.deepEqual(h.current().scheduler?.backgroundTasks?.tasks.map(task => task.hostReported), [true]);
	assert.deepEqual(lifecycle(), before, "recovery settles task evidence only");
	assert.match(prompt, /lifecycle/i);
	assert.doesNotMatch(prompt, /stays paused/i, "the prompt does not claim a pause it does not enforce");
});

test("/goal-recovery tasks settles only the confirmed set when receipts, scopes, or tasks change during confirmation", async t => {
	const h = await fixture(t, { owner: "new-session", onConfirm: () => {
		h.core.goalService.apply(h.ctx, { expectedGoalId: h.current().id, mutate: goal => {
			const scheduler = goal.scheduler!;
			const tasks = scheduler.backgroundTasks!.tasks.map(task => task.taskId === "a-receipt" ? { ...task, receiptId: "a-receipt-run-2" }
				: task.taskId === "a-scope" ? { ...task, scope: { goalId: goal.id, sessionId: "other-session" } } : task);
			scheduler.backgroundTasks = { ...scheduler.backgroundTasks!, tasks: [...tasks, legacyTask("a-new", "old-session") as never] };
			return { ...goal, scheduler };
		} });
	}, prepare: goal => pausedWithTasks(goal, [legacyTask("a-done", "old-session"), legacyTask("a-receipt", "old-session"), legacyTask("a-scope", "old-session")], "old-session") });
	writeSession(h.sessionDir, "old-session", ["a-done", "a-receipt", "a-scope", "a-new"].map(id => h.agentRecord(id, "completed")));
	writeSession(h.sessionDir, "other-session", [h.agentRecord("a-scope", "completed")]);
	await h.command("goal-recovery", "tasks");
	const tasks = h.current().scheduler?.backgroundTasks?.tasks ?? [];
	assert.deepEqual(tasks.map(task => [task.taskId, task.hostReported]), [["a-done", true], ["a-receipt", false], ["a-scope", false], ["a-new", false]], "a changed or new target is never settled by a confirmation that did not show it");
	assert.deepEqual(readGoalLedger(h.ctx).events.filter(event => event.type === "background_task_recovered").map(event => (event as { taskId: string }).taskId), ["a-done"]);
});

test("/goal-recovery tasks changes nothing when declined or without a receipt", async t => {
	const h = await fixture(t, { owner: "new-session", confirm: false, prepare: goal => pausedWithTasks(goal, [legacyTask("a-done", "old-session")], "old-session") });
	writeSession(h.sessionDir, "old-session", [h.agentRecord("a-done", "completed")]);
	const goalFile = path.resolve(h.cwd, h.current().activePath!);
	const original = readFileSync(goalFile, "utf8");
	await h.command("goal-recovery", "tasks");
	assert.equal(readFileSync(goalFile, "utf8"), original, "a declined confirmation writes nothing");
	assert.equal(existsSync(path.join(h.cwd, RECOVERY_BACKUP_DIR)), false);
	rmSync(path.join(h.sessionDir), { recursive: true, force: true });
	mkdirSync(h.sessionDir);
	await h.command("goal-recovery", "tasks");
	assert.ok(h.notifications.some(message => /no verified/i.test(message)), h.notifications.join("\n"));
	assert.equal(readFileSync(goalFile, "utf8"), original);
});
