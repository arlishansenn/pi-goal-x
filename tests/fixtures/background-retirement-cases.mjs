import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { extensionFixture, producers, OWNER } from "./issue-828-extension.mjs";
import { normalizeBackgroundTasks, observeToolResult } from "../../extensions/goal-background-registry.ts";

const retired = { producer: "@quintinshaw/pi-dynamic-workflows", taskId: "old-dw", label: "old workflow", toolName: "workflow", receiptId: "old-receipt", aliases: [], hostReported: false, execution: { contractVersion: 1, executionEpoch: 2 }, superseded: true, legacyResumed: true, wait: { deadline: 1800000660000, checkAt: 1800000600000, remainingChecks: 0 } };

test("retirement ignores obsolete DW payload but still rejects corrupt retained tasks", () => {
	assert.deepEqual(normalizeBackgroundTasks({ version: 1, tasks: [{ producer: retired.producer, execution: "obsolete" }], deliveries: "obsolete" }), { version: 1, tasks: [] });
	assert.equal(normalizeBackgroundTasks({ version: 1, tasks: [retired, { producer: "nicobailon/pi-subagents" }] }), "invalid");
});

test("ordinary workflow-specific fields do not enroll background tasks", () => {
	for (const details of [{ background: true, runId: "ordinary" }, { contractVersion: 1, executionEpoch: 2, background: true, runId: "ordinary" }]) {
		const result = observeToolResult(undefined, { toolName: "workflow", details });
		assert.equal(result.observed, false);
		assert.deepEqual(result.state.tasks, []);
	}
});

test("public ordinary workflow results follow mechanical progress without enrolling or renewing siblings", async t => {
	const h = await extensionFixture();
	t.after(() => h.close());
	await h.begin();
	await h.result(producers.subagent.launch("waiting"));
	await h.settle();
	const before = (await h.goal()).scheduler.backgroundTasks;
	await h.begin();
	await h.result({ toolName: "workflow", toolCallId: "ordinary", details: { background: true, runId: "ignored", contractVersion: 1, executionEpoch: 2, originSessionId: OWNER, sessionId: OWNER }, content: [] });
	await h.settle();
	const after = await h.goal();
	assert.equal(after.scheduler.phase, "ready");
	assert.deepEqual(after.scheduler.backgroundTasks, before);
});

for (const mode of ["unspent", "mixed-unspent", "mixed", "waiting", "claimed"]) test(`canonical cold retirement ${mode} preserves authorization without replay`, async t => {
	const h = await extensionFixture();
	t.after(() => h.close());
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	await h.result(producers.subagent.launch("cold"));
	await h.settle();
	if (!mode.includes("unspent")) {
		t.mock.timers.tick(600000);
		await h.message({ ...h.sent[0], role: "custom" });
		await h.begin();
		await h.settle();
	}
	const before = await h.goal();
	const file = path.resolve(h.cwd, before.activePath);
	const state = before.scheduler;
	const oldTask = mode.includes("unspent") ? { ...retired, wait: { ...retired.wait, remainingChecks: 1 } } : retired;
	if (mode === "mixed-unspent") state.backgroundTasks.tasks[0].wait.checkAt += 20000;
	state.backgroundTasks.tasks = mode.startsWith("mixed") ? [oldTask, ...state.backgroundTasks.tasks] : [oldTask];
	state.backgroundTasks.deliveries = [{ deliveryId: "opaque-old", runId: "old-dw", executionEpoch: 2 }];
	if (mode === "claimed") {
		state.phase = "claimed";
		state.dispatch = { id: "old-dispatch", kind: "check", claimedAt: 1800000600000, taskCheck: { targets: [{ producer: retired.producer, taskId: retired.taskId, receiptId: retired.receiptId }] } };
	}
	const { serializeGoalFile } = await import("../../extensions/storage/goal-files.ts");
	writeFileSync(file, serializeGoalFile(before));
	const child = spawnSync(process.execPath, ["--import", "./scripts/test-adapter-hooks.mjs", "--experimental-strip-types", "./tests/fixtures/background-retirement-cold.mjs", h.cwd, file, mode, JSON.stringify(before.scheduler)], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PI_SUBAGENT_CHILD: "0", PI_SUBAGENT_DEPTH: "0" } });
	assert.equal(child.status, 0, child.stdout + child.stderr);
});
