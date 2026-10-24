import test from "node:test";
import assert from "node:assert/strict";
import { allocateWaits, observeToolResult, observeHostMessage, observeLifecycle, normalizeBackgroundTasks, type BackgroundTasksState } from "../extensions/goal-background-registry.ts";

const scope = { goalId: "goal-a", sessionId: "session-a" };
const empty = (): BackgroundTasksState => ({ version: 1, scope, tasks: [] });
const workflow = (id: string, receipt = id) => ({ toolName: "workflow", toolCallId: receipt, details: { background: true, runId: id } });
const generic = (toolName: string, id: string, status: string) => ({ toolName, details: { task: { id, status } } });

test("legacy opaque workflow reports and ordinary user turns cannot claim tasks", () => {
	let state = observeToolResult(empty(), workflow("one")).state;
	state = observeToolResult(state, generic("other", "two", "running")).state;
	for (const message of [
		{ role: "user", content: "done" },
		{ role: "custom", customType: "workflow-result", details: { deliveryId: "opaque" } },
		{ role: "custom", customType: "unrelated", details: { deliveryId: "opaque" } },
	]) assert.deepEqual(observeHostMessage(state, message).reported, []);
});

test("structured failed results settle only their own producer and retain failure", () => {
	let state = observeToolResult(empty(), generic("other", "same", "running")).state;
	state = observeToolResult(state, generic("bg_run", "same", "running")).state;
	const result = observeToolResult(state, generic("bg_status", "same", "failed"));
	assert.equal(result.state.tasks.find(t => t.toolName === "other")?.outcome, undefined);
	assert.equal(result.state.tasks.find(t => t.toolName === "bg_run")?.outcome, "failed");
	assert.equal(result.state.tasks.find(t => t.toolName === "bg_run")?.hostReported, true);
});

test("workflow lifecycle cannot settle another producer or foreign session", () => {
	let state = observeToolResult(empty(), workflow("same")).state;
	state = observeToolResult(state, generic("other", "same", "running")).state;
	assert.equal(observeLifecycle(state, { runId: "same", status: "failed", sessionId: "foreign" }).changed, false);
	const result = observeLifecycle(state, { runId: "same", status: "failed", sessionId: scope.sessionId });
	assert.equal(result.state?.tasks[0]?.outcome, "failed");
	assert.equal(result.state?.tasks[1]?.outcome, undefined);
});

test("only an explicit legacy resume resets the wait, repeated receipts keep the budget", () => {
	let state = allocateWaits(observeToolResult(empty(), workflow("same")).state, 1000);
	state = observeLifecycle(state, { runId: "same", status: "completed", sessionId: scope.sessionId }).state!;
	assert.deepEqual(observeToolResult(state, workflow("same", "new-receipt")).state.tasks[0]?.wait, state.tasks[0]?.wait);
	const resume = { ...workflow("same", "resume"), details: { background: true, runId: "same", resumedFrom: "same" } };
	state = allocateWaits(observeToolResult(state, resume).state, 2000);
	assert.equal(state.tasks[0]?.outcome, undefined);
	assert.equal(state.tasks[0]?.wait?.deadline, 662000);
	state = observeToolResult(state, resume).state;
	assert.equal(state.tasks[0]?.wait?.deadline, 662000);
	assert.equal(observeLifecycle(state, { runId: "same", status: "completed", sessionId: scope.sessionId }).changed, false);
	assert.deepEqual(JSON.parse(JSON.stringify(normalizeBackgroundTasks(state))), JSON.parse(JSON.stringify(state)));
});

// Source fixtures use ismailsaleekh/pi-background-tasks@799182ff65d7040732aea23b2001ea860b688531.
// extension.ts returns details.task for bg_run and details.tasks for bg_status.
// core/registry.ts sends background-task-notification with the flat snapshot from core/common.ts.
test("fixed background-tasks status array and host snapshot use one explicit namespace", () => {
	let state = observeToolResult(empty(), generic("bg_run", "first", "running")).state;
	state = observeToolResult(state, generic("bg_run", "second", "running")).state;
	state = observeToolResult(state, { toolName: "bg_status", details: { tasks: [{ id: "first", status: "failed" }] } }).state;
	assert.equal(state.tasks[0]?.outcome, "failed");
	assert.equal(state.tasks[1]?.outcome, undefined);
	const report = observeHostMessage(state, { role: "custom", customType: "background-task-notification", details: { id: "second", status: "completed" } });
	assert.equal(report.reported.length, 1);
	assert.equal(report.state?.tasks[1]?.hostReported, true);
	assert.equal(report.state?.tasks[0]?.outcome, "failed");
});

test("foreign structured session cannot settle a locally launched task", () => {
	const state = observeToolResult(empty(), generic("bg_run", "one", "running")).state;
	const result = observeToolResult(state, { toolName: "bg_status", details: { sessionId: "foreign", task: { id: "one", status: "failed" } } });
	assert.equal(result.state.tasks[0]?.outcome, undefined);
});

test("workflow_control resumes only an existing run after explicit successful resume", () => {
	let state = observeToolResult(empty(), workflow("one")).state;
	state = observeLifecycle(state, { runId: "one", status: "paused", sessionId: scope.sessionId }).state!;
	const base = { toolName: "workflow_control", toolCallId: "control-resume" };
	for (const details of [
		{ action: "status", result: "ok", run: { runId: "one" } },
		{ action: "resume", result: "error", run: { runId: "one" } },
	]) assert.equal(observeToolResult(state, { ...base, details }).state.tasks[0]?.outcome, "paused");
	const details = { action: "resume", result: "resumed", run: { runId: "one" } };
	const result = observeToolResult(state, { ...base, details });
	assert.equal(result.state.tasks[0]?.outcome, undefined);
	assert.equal(result.state.tasks[0]?.legacyResumed, true);
	assert.equal(observeToolResult(empty(), { ...base, details }).state.tasks.length, 0);
});

test("unscoped lifecycle and nested foreign status cannot attribute a terminal", () => {
	const workflowState = observeToolResult(empty(), workflow("one")).state;
	assert.equal(observeLifecycle(workflowState, { runId: "one", status: "failed" }).changed, false);
	const state = observeToolResult(empty(), generic("bg_run", "one", "running")).state;
	assert.equal(observeToolResult(state, { toolName: "bg_status", details: { task: { id: "one", status: "failed", sessionId: "foreign" } } }).state.tasks[0]?.outcome, undefined);
});

import "./fixtures/issue-828-background-native.mjs";

test("background status lists never enroll tasks without a launch receipt", () => {
	const state = observeToolResult(empty(), { toolName: "bg_status", details: { tasks: [{ id: "foreign", status: "running" }] } }).state;
	assert.equal(state.tasks.length, 0);
});

const identity = (runId: string, executionEpoch = 1) => ({ contractVersion: 1, runId, executionEpoch, originSessionId: scope.sessionId, sessionId: scope.sessionId });
const v1launch = (id: string, epoch = 1, resume = false) => ({ toolName: "workflow", toolCallId: `receipt-${id}-${epoch}`, details: { ...identity(id, epoch), background: true, ...(resume ? { resumedFrom: id } : {}) } });
const v1host = (id: string, deliveryId: string, epoch = 1) => ({ role: "custom", customType: "workflow-result", details: { ...identity(id, epoch), deliveryId } });

for (const order of ["lifecycle-first", "host-first"]) test(`v1 ${order} correlates no-status host and keeps multiple siblings`, () => {
	let state = empty();
	for (const id of ["fast", "slow", "third"]) state = observeToolResult(state, v1launch(id)).state;
	state = allocateWaits(state, 1000);
	const lifecycle = { ...identity("fast"), status: "failed", name: "workflow" };
	if (order === "lifecycle-first") state = observeLifecycle(state, lifecycle).state!;
	state = observeHostMessage(state, v1host("fast", "opaque")).state!;
	if (order === "host-first") state = observeLifecycle(state, lifecycle).state!;
	assert.equal(state.tasks[0]?.hostReported, true);
	assert.equal(state.tasks[0]?.outcome, "failed");
	assert.equal(state.tasks[1]?.hostReported, false);
	assert.equal(state.tasks[2]?.hostReported, false);
	assert.equal(state.tasks[1]?.wait?.deadline, 661000);
	assert.deepEqual(observeHostMessage(state, v1host("fast", "opaque")).reported, []);
});

test("v1 real resume preserves old epoch and delivery tombstones, same epoch receipts are idempotent", () => {
	let state = allocateWaits(observeToolResult(empty(), v1launch("one")).state, 1000);
	state = observeHostMessage(state, v1host("one", "old-id")).state!;
	state = observeLifecycle(state, { ...identity("one"), status: "paused" }).state!;
	state = allocateWaits(observeToolResult(state, v1launch("one", 2, true)).state, 2000);
	assert.equal(state.tasks.length, 2);
	state = observeToolResult(state, { ...v1launch("one", 2, true), toolCallId: "another-receipt" }).state;
	assert.equal(state.tasks.length, 2);
	assert.equal(state.tasks[1]?.wait?.deadline, 662000);
	state = observeHostMessage(state, v1host("one", "late-old", 1)).state!;
	assert.equal(state.tasks[1]?.hostReported, false);
	assert.deepEqual(observeHostMessage(state, v1host("one", "old-id", 2)).reported, []);
	state = observeHostMessage(state, v1host("one", "new-id", 2)).state!;
	assert.equal(state.tasks[1]?.hostReported, true);
	const normalized = normalizeBackgroundTasks(JSON.parse(JSON.stringify(state)));
	assert.deepEqual(JSON.parse(JSON.stringify(normalized)), JSON.parse(JSON.stringify(state)));
});

test("v1 rejects invalid, foreign, unknown, future and unproved new epochs", () => {
	const state = allocateWaits(observeToolResult(empty(), v1launch("one")).state, 1000);
	for (const patch of [{ contractVersion: 2 }, { contractVersion: "1" }, { executionEpoch: 0 }, { executionEpoch: 1.2 }, { executionEpoch: Number.MAX_SAFE_INTEGER + 1 }, { originSessionId: "foreign" }, { sessionId: "foreign" }, { originSessionId: "" }, { runId: "unknown" }, { executionEpoch: 2 }]) {
		assert.deepEqual(observeHostMessage(state, { ...v1host("one", "bad"), details: { ...v1host("one", "bad").details, ...patch } }).reported, []);
		assert.equal(observeLifecycle(state, { ...identity("one"), status: "completed", ...patch }).changed, false);
	}
	assert.equal(observeToolResult(state, v1launch("one", 2)).state.tasks.length, 1);
	assert.equal(observeLifecycle(state, { ...identity("one", 2), status: "resumed" }).changed, false);
	for (const patch of [{ contractVersion: 2 }, { executionEpoch: 0 }, { originSessionId: "foreign" }]) assert.equal(observeToolResult(empty(), { ...v1launch("bad"), details: { ...v1launch("bad").details, ...patch } }).state.tasks.length, 0);
});

test("workflow_control actual nested v1 resume advances only enrolled run", () => {
	const state = observeToolResult(empty(), v1launch("one")).state;
	const event = { toolName: "workflow_control", details: { action: "resume", result: "resumed", run: { ...identity("one", 2), status: "running", workflowName: "work" } } };
	const resumed = observeToolResult(state, event).state;
	assert.equal(resumed.tasks.length, 2);
	assert.equal(observeToolResult(resumed, event).state.tasks.length, 2);
	assert.equal(observeToolResult(empty(), event).state.tasks.length, 0);
});

test("deterministic old BG canonical namespace migrates without losing budget", () => {
	const original = allocateWaits(observeToolResult(empty(), generic("bg_run", "old", "running")).state, 1000);
	const raw = JSON.parse(JSON.stringify(original));
	raw.tasks[0].producer = "structured:bg_run";
	const normalized = normalizeBackgroundTasks(raw);
	assert.ok(normalized && normalized !== "invalid");
	assert.equal(normalized.tasks[0]?.producer, "ismailsaleekh/pi-background-tasks");
	assert.deepEqual(normalized.tasks[0]?.wait, original.tasks[0]?.wait);
	assert.equal(observeHostMessage(normalized, { role: "custom", customType: "background-task-notification", details: { id: "old", status: "completed" } }).reported.length, 1);
});


test("v1 missing optional origin remains absent and status/list never enroll or advance", () => {
	const details = { contractVersion: 1, runId: "no-origin", executionEpoch: 4, background: true };
	let state = observeToolResult(empty(), { toolName: "workflow", details }).state;
	assert.equal(state.tasks[0]?.execution?.originSessionId, undefined);
	for (const action of ["status", "list"]) {
		state = observeToolResult(state, { toolName: "workflow_control", details: { action, run: { ...identity("no-origin", 5), status: "running" }, runs: [{ ...identity("unknown"), status: "running" }] } }).state;
		assert.equal(state.tasks.length, 1);
		assert.equal(state.tasks[0]?.execution?.executionEpoch, 4);
	}
	const report = observeHostMessage(state, { role: "custom", customType: "workflow-result", details: { contractVersion: 1, runId: "no-origin", executionEpoch: 4, sessionId: scope.sessionId, deliveryId: "opaque-no-origin" } });
	assert.equal(report.reported.length, 1);
	assert.equal(report.state?.tasks[0]?.outcome, undefined);
});

test("persistent delivery ID conflict never overwrites the first run identity", () => {
	let state = observeToolResult(empty(), v1launch("first")).state;
	state = observeToolResult(state, v1launch("second")).state;
	state = observeHostMessage(state, v1host("first", "shared-id")).state!;
	const normalized = normalizeBackgroundTasks(JSON.parse(JSON.stringify(state)));
	assert.ok(normalized && normalized !== "invalid");
	state = normalized;
	const conflict = observeHostMessage(state, v1host("second", "shared-id"));
	assert.equal(conflict.state?.tasks[1]?.hostReported, false);
	assert.deepEqual(conflict.state?.deliveries, [{ deliveryId: "shared-id", runId: "first", executionEpoch: 1 }]);
	assert.equal(normalizeBackgroundTasks({ ...state, deliveries: [...state.deliveries!, ...state.deliveries!] }), "invalid");
});

test("structuredContent alone cannot supply or upgrade workflow execution identity", () => {
	const event = { ...workflow("legacy"), structuredContent: identity("legacy") };
	const legacy = observeToolResult(empty(), event).state;
	assert.equal(legacy.tasks[0]?.execution, undefined);
	assert.deepEqual(observeHostMessage(legacy, v1host("legacy", "cannot-upgrade")).reported, []);
});

test("workflow_control actual status run is terminal evidence, not host delivery or progress", () => {
	const state = observeToolResult(empty(), v1launch("one")).state;
	const result = observeToolResult(state, { toolName: "workflow_control", details: { action: "status", run: { ...identity("one"), status: "paused", workflowName: "work" } } });
	assert.equal(result.observed, true);
	assert.equal(result.state.tasks[0]?.outcome, "paused");
	assert.equal(result.state.tasks[0]?.hostReported, false);
});

import "./fixtures/issue-828-followup.mjs";

test("v1 without origin still requires original receipt scope after scheduler takeover", () => {
	let state = observeToolResult(empty(), { toolName: "workflow", details: { contractVersion: 1, runId: "one", executionEpoch: 1, background: true } }).state;
	for (const sessionId of [scope.sessionId, "new-owner"]) {
		const result = observeHostMessage(state, { role: "custom", customType: "workflow-result", details: { contractVersion: 1, runId: "one", executionEpoch: 1, deliveryId: "late", sessionId } }, "new-owner");
		assert.equal(result.state?.tasks[0]?.hostReported, false);
		assert.equal(observeLifecycle(state, { contractVersion: 1, runId: "one", executionEpoch: 1, status: "failed", sessionId }, "new-owner").changed, false);
	}
	state = observeToolResult(state, v1launch("new-owner-task"), "new-owner").state;
	assert.equal(state.tasks.length, 1, "foreign origin receipt cannot enroll after takeover");
});

test("final producer foreground sync receipt does not enroll a background wait", () => {
	const sync = { toolName: "workflow", details: { ...identity("sync"), meta: { name: "work" }, phases: [], logs: [], result: "done", durationMs: 12, tokenUsage: {}, status: "completed" }, structuredContent: { runId: "sync", status: "completed", result: "done" } };
	assert.equal(observeToolResult(empty(), sync).state.tasks.length, 0);
	const waiting = allocateWaits(observeToolResult(empty(), v1launch("sibling")).state, 1000);
	assert.deepEqual(observeToolResult(waiting, sync).state.tasks, waiting.tasks);
});
