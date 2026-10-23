import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import type { GoalCore } from "../extensions/goal-state.ts";
import { createGoal, goalFocusDetails } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { invalidateGoalSettingsCache } from "../extensions/goal-settings.ts";

/**
 * Issue 828 acceptance at the extension's public boundary: the actual
 * nicobailon/pi-subagents 0.81.0 async receipt (captured from a real session,
 * sanitized) has no top-level status/phase, so upstream PR #83 alone cannot
 * detect it and the goal busy-loops on checkpoints. Each fixture shape below
 * is a sanitized copy of a real receipt; no field is invented.
 */

const RECEIPT_ID = "88ef703d-a58e-466f-be4c-ea42e425a3be";

async function fixture(t: TestContext) {
	const cwd = await new Promise<string>(resolve => {
		const dir = mkdtempSync(path.join(tmpdir(), "pgx-subagents-"));
		mkdirSync(path.join(dir, ".pi"), { recursive: true });
		writeFileSync(path.join(dir, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ strictExecutionContract: false }));
		resolve(dir);
	});
	invalidateGoalSettingsCache();
	const goal = createGoal({ objective: "Wait for detached subagent", autoContinue: true, sisyphus: false });
	goal.id = "subagents-receipt-fixture";
	writeActiveGoalFile({ cwd }, goal);
	const handlers: Record<string, Function> = {};
	const tools = new Map<string, any>();
	const sent: any[] = [];
	const listeners = new Map<string, Function>();
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (event: string, handler: Function) => { handlers[event] = handler; },
		getActiveTools: () => ["read", "write", "subagent"],
		setActiveTools: () => {},
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (message: unknown) => { sent.push(message); },
		events: { on: (name: string, fn: Function) => { listeners.set(name, fn); return () => listeners.delete(name); }, emit: (name: string, event: unknown) => listeners.get(name)?.(event) },
	};
	const ctx = {
		cwd, hasUI: false, isIdle: () => true, hasPendingMessages: () => false, abort: () => {},
		getSystemPrompt: () => "base",
		sessionManager: { getSessionId: () => "owner-1", getCwd: () => cwd, getRoot: () => cwd, getBranch: () => [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }] },
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
	} as unknown as ExtensionContext;
	goalExtension(pi as any);
	const core = (pi as any)._goalCore as GoalCore;
	await core.loadState(ctx);
	core.scheduler.attach(ctx);
	t.after(() => {
		core.scheduler.shutdown();
		core.runtime.clearContinuationState();
		rmSync(cwd, { recursive: true, force: true });
		invalidateGoalSettingsCache();
	});
	const result = (event: Record<string, unknown>) => handlers.tool_result!(event, ctx);
	const call = (toolName: string, input: Record<string, unknown>) => handlers.tool_call!({ type: "tool_call", toolCallId: "call-poll", toolName, input }, ctx);
	/** The real async launch receipt: no status/phase, asyncId+asyncDir+empty results carry the contract. */
	const asyncLaunch = (id: string, toolCallId = `call-${id.slice(0, 8)}`) => ({
		toolName: "subagent", toolCallId, isError: false,
		details: { mode: "single", runId: id, toolCallId, results: [], asyncId: id, asyncDir: `/tmp/async-subagent-runs/${id}`, context: "fresh", timeoutMs: 1800000 },
		input: { agent: "delegate", task: "sleep 110 then report DONE", async: true },
		content: [{ type: "text" as const, text: `Async: delegate [${id}]` }],
	});
	/** The real management receipt: carries asyncId but must never enroll a task. */
	const managementReceipt = (id: string) => ({
		toolName: "subagent", toolCallId: "call-mgmt", isError: false,
		details: { mode: "management", runId: id, results: [], asyncId: id, asyncDir: `/tmp/async-subagent-runs/${id}` },
		input: { action: "status", id },
		content: [{ type: "text" as const, text: "status: running" }],
	});
	/** The real completion notification: custom message, details.runs[] with runId+status. */
	const notifyComplete = (id: string, status = "completed") => ({
		role: "custom", customType: "subagent-notify",
		details: { runs: [{ agent: "delegate", status, asyncDir: `/tmp/async-subagent-runs/${id}`, durationMs: 128384, runId: id }] },
		content: `Background task completed: **delegate**`,
	});
	const settle = () => core.scheduler.settled(ctx);
	return { cwd, ctx, core, handlers, sent, result, call, asyncLaunch, managementReceipt, notifyComplete, settle };
}

test("the real pi-subagents async receipt raises a system wait, not a busy loop", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	const appended = await h.result(h.asyncLaunch(RECEIPT_ID));
	assert.match(String((appended?.content ?? []).map((p: any) => p.text).join("\n")), /PI GOAL WAITING ON BACKGROUND TASK/, "the launch is announced");
	await h.settle();
	const scheduler = h.core.state.goal?.scheduler;
	assert.equal(scheduler?.phase, "waiting", "the settle waits instead of implicit-continuing");
	assert.equal(scheduler?.wait?.taskId, RECEIPT_ID);
	// No checkpoint is dispatched while the async work runs.
	assert.equal(h.sent.length, 0);
});

test("a management receipt with asyncId never enrolls a task", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	assert.equal(await h.result(h.managementReceipt(RECEIPT_ID)), undefined);
	assert.equal(h.core.scheduler.pendingBackgroundTasks().length, 0);
});

test("the native subagent-notify discharges the task and wakes the goal", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	await h.result(h.asyncLaunch(RECEIPT_ID));
	await h.settle();
	assert.equal(h.core.state.goal?.scheduler?.phase, "waiting");
	// The producer's native message arrives: the task is discharged and the
	// host turn takes over; after it settles without other outstanding work the
	// goal returns to normal continuation.
	h.core.scheduler.message(h.ctx, h.notifyComplete(RECEIPT_ID));
	assert.equal(h.core.scheduler.pendingBackgroundTasks().length, 0, "the identified report discharges the task");
	await h.settle();
	assert.equal(h.core.state.goal?.scheduler?.wait, undefined, "no task wait remains");
	assert.notEqual(h.core.state.goal?.scheduler?.phase, "waiting");
});

test("a failed task reports through the same channel without pausing the goal", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	await h.result(h.asyncLaunch(RECEIPT_ID));
	await h.settle();
	h.core.scheduler.message(h.ctx, h.notifyComplete(RECEIPT_ID, "failed"));
	assert.equal(h.core.scheduler.pendingBackgroundTasks().length, 0);
	assert.equal(h.core.state.goal?.status, "active", "a failed task does not pause the goal");
});

test("two launches keep both tasks; partial completion keeps the sibling", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	await h.result(h.asyncLaunch("run-aaaaaaaa"));
	await h.result(h.asyncLaunch("run-bbbbbbbb"));
	assert.equal(h.core.scheduler.pendingBackgroundTasks().length, 2, "later launches never overwrite earlier ones");
	await h.settle();
	assert.equal(h.core.state.goal?.scheduler?.phase, "waiting");
	h.core.scheduler.message(h.ctx, h.notifyComplete("run-aaaaaaaa"));
	const remaining = h.core.scheduler.pendingBackgroundTasks();
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0]?.id, "run-bbbbbbbb", "the sibling stays tracked");
	await h.settle();
	assert.equal(h.core.state.goal?.scheduler?.phase, "waiting", "the goal still owes the sibling's wait");
	assert.equal(h.core.state.goal?.scheduler?.wait?.taskId, "run-bbbbbbbb");
});

test("polling the tracked task is refused; control actions pass", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	await h.result(h.asyncLaunch(RECEIPT_ID));
	const blocked = await h.call("subagent", { action: "status", id: RECEIPT_ID });
	assert.equal(blocked?.block, true, "a status poll of the tracked task is refused");
	const stop = await h.call("subagent", { action: "stop", id: RECEIPT_ID });
	assert.equal(stop, undefined, "a control action always passes");
	const other = await h.call("subagent", { action: "status", id: "unknown-run" });
	assert.equal(other, undefined, "an unrelated id is not blocked");
});

test("a plain user instruction keeps the tracked tasks", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	await h.result(h.asyncLaunch(RECEIPT_ID));
	await h.settle();
	// A user message takes over scheduling but must not lose the producer task.
	h.core.scheduler.message(h.ctx, { role: "user", content: "先做别的事" });
	assert.equal(h.core.scheduler.pendingBackgroundTasks().length, 1, "takeover preserves the task set");
	await h.settle();
	assert.equal(h.core.state.goal?.scheduler?.phase, "waiting", "the goal waits again for the still-running task");
	assert.equal(h.core.state.goal?.scheduler?.wait?.taskId, RECEIPT_ID);
});

test("same-session reload restores the tracked task and its wait", async t => {
	const h = await fixture(t);
	h.core.scheduler.begin(h.ctx);
	await h.result(h.asyncLaunch(RECEIPT_ID));
	await h.settle();
	const wait = h.core.state.goal?.scheduler?.wait;
	assert.ok(wait);
	// Simulate a session reopen: a fresh scheduler instance restores from disk.
	h.core.scheduler.shutdown();
	h.core.scheduler.restore(h.ctx);
	const restored = h.core.scheduler.pendingBackgroundTasks();
	assert.equal(restored.length, 1, "identities survive the reload");
	assert.equal(restored[0]?.id, RECEIPT_ID);
	assert.equal(h.core.state.goal?.scheduler?.wait?.deadline, wait!.deadline, "the original deadline is kept, not renewed");
});
