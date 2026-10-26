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

/**
 * Issue 10 at the extension's public boundary. The launch receipt and the
 * notice follow the pstack 0.9.102 source (plugins/pstack/pi/agent-tools.ts,
 * agent-text.ts, agents.ts): `agent` with run_in_background returns
 * details { agentId, status: "running" }; the end sends customType
 * "pstack-agent" with details { agentId, status, exitCode, outputFile }, and a
 * stop sends it with triggerTurn=false, which pi appends without an extension
 * message event. Every end persists a "pstack-agents" session entry first.
 */

const NOW = 1_800_000_000_000;
const OWNER = "owner-1";

interface FixtureOptions { owner?: string; prepare?: (goal: GoalRecord) => void; confirm?: boolean }

async function fixture(t: TestContext, options: FixtureOptions = {}) {
	const cwd = mkdtempSync(path.join(tmpdir(), "pgx-pstack-"));
	const sessionDir = path.join(cwd, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ strictExecutionContract: false }));
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
		ui: { notify: (message: string) => notifications.push(message), setStatus: () => {}, setWidget: () => {}, confirm: async () => options.confirm ?? true },
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
	const run = async (fn: () => unknown) => { core.scheduler.begin(ctx); await fn(); core.scheduler.settled(ctx); };
	const current = () => core.state.goal!;
	const command = (name: string, args = "") => commands.get(name)!.handler(args, ctx);
	return { cwd, ctx, core, sent, notifications, branch, sessionDir, launch, notice, agentRecord, run, current, command };
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

test("an explicit timeout bounds the wait and no later wait renews it", async t => {
	const h = await fixture(t);
	await h.run(() => h.launch("a-1", { timeoutMs: 120_000 }));
	assert.equal(h.current().scheduler?.wait?.deadline, NOW + 120_000, "the declared runtime is the deadline, without a margin");
	t.mock.timers.tick(60_000);
	h.core.scheduler.message(h.ctx, { role: "user", content: "keep going" });
	await h.run(() => h.launch("a-1", { timeoutMs: 600_000 }));
	assert.equal(h.current().scheduler?.wait?.deadline, NOW + 120_000, "a repeated receipt or a new wait does not renew it");
	t.mock.timers.tick(59_999);
	assert.equal(h.current().status, "active");
	t.mock.timers.tick(1);
	assert.equal(h.current().status, "paused");
	assert.match(h.current().pauseReason ?? "", /deadline/i);
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

test("/goal-resume reports no success when the goal re-pauses at once", async t => {
	const h = await fixture(t, { prepare: goal => pausedWithTasks(goal, [{ ...legacyTask("a-1"), wait: undefined, deadline: NOW - 1 }], OWNER) });
	await h.command("goal-resume");
	assert.equal(h.current().status, "paused", "an expired explicit deadline still pauses");
	assert.ok(!h.notifications.some(message => /Goal resumed/.test(message)), h.notifications.join("\n"));
	assert.ok(h.notifications.some(message => /deadline/i.test(message)));
	assert.ok(!readGoalLedger(h.ctx).events.some(event => event.type === "goal_resumed"), "no resume is recorded");
});

