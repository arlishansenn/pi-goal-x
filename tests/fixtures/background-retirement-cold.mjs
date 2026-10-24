import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { goalPoolSnapshotPath, goalStorageRoot } from "../../extensions/storage/goal-root.ts";
import { mock } from "node:test";
import { parseGoalFile } from "../../extensions/storage/goal-files.ts";
import { extensionFixture } from "./issue-828-extension.mjs";

const [cwd, file, mode, encoded] = process.argv.slice(2);
const before = JSON.parse(encoded);
const goal = parseGoalFile(file);
assert.ok(goal, "canonical record survives retired DW");
const s = goal.scheduler;
assert.equal(s.phase, before.phase, "retirement does not invalidate scheduler");
assert.equal(s.used, before.used);
const expectedWait = { ...before.wait };
if (mode.includes("unspent")) {
	expectedWait.remainingChecks = mode === "mixed-unspent" ? 1 : 0;
	if (mode === "mixed-unspent") expectedWait.nextCheckAt += 20000;
	else delete expectedWait.nextCheckAt;
}
assert.deepEqual(s.wait, expectedWait, "only retained tasks project check opportunities without renewing the deadline");
assert.deepEqual(s.dispatch, before.dispatch, "pending dispatch cannot be reset or reauthorized");
assert.equal(s.backgroundTasks.deliveries, undefined);
assert.deepEqual(JSON.parse(JSON.stringify(s.backgroundTasks.tasks)), mode.startsWith("mixed") ? before.backgroundTasks.tasks.slice(1) : []);
mock.timers.enable({ apis: ["setTimeout", "Date"], now: mode.includes("unspent") ? 1800000000000 : 1800000600000 });
rmSync(goalPoolSnapshotPath({ cwd }), { force: true });
rmSync(path.join(goalStorageRoot({ cwd }), ".goals-pool-snapshot.json"), { force: true });
const h = await extensionFixture({ cwd });
try {
	assert.equal(h.sent.length, 0, "cold restore must not replay a check");
	if (mode === "claimed") {
		assert.equal((await h.goal()).status, "paused");
		assert.match((await h.goal()).pauseReason, /interrupt|resume/i);
	}
	assert.equal((await h.call("workflow", { runId: "old-dw" })), undefined, "retired task cannot grant or block polling");
	if (mode === "mixed") assert.equal((await h.call("subagent", { action: "status", id: "cold" }))?.block, true, "retired identity never transfers a check grant");
	if (mode.includes("unspent")) {
		mock.timers.tick(600000);
		assert.equal(h.sent.length, 0, "retired task cannot dispatch its unspent check");
		assert.equal((await h.goal()).scheduler.used, before.used);
		if (mode === "mixed-unspent") {
			mock.timers.tick(19999);
			assert.equal(h.sent.length, 0, "sibling cannot check before its original due time");
			mock.timers.tick(1);
			assert.equal(h.sent.length, 1, "retained sibling keeps its original check");
			const checked = await h.goal();
			const sibling = before.backgroundTasks.tasks[1];
			assert.deepEqual(checked.scheduler.dispatch.taskCheck.targets, [{ producer: sibling.producer, taskId: sibling.taskId, receiptId: sibling.receiptId }]);
			assert.equal(checked.scheduler.used, before.used + 1);
			await h.message({ ...h.sent[0], role: "custom" });
			await h.begin();
			await h.settle();
			mock.timers.tick(40000);
		} else mock.timers.tick(60000);
	} else mock.timers.tick(60000);
	assert.equal(h.sent.length, mode === "mixed-unspent" ? 1 : 0, "retirement must not gain an extra checkpoint");
	const restored = await h.goal();
	assert.equal(restored.scheduler.used, before.used + (mode === "mixed-unspent" ? 1 : 0));
	if (mode !== "claimed") assert.equal(restored.status, "paused", "original deadline still bounds the old wait");
	else {
		assert.equal(restored.status, "paused", "claimed dispatch must pause instead of replaying");
	}
} finally {
	await h.close();
	mock.timers.reset();
}
console.log(JSON.stringify({ mode, pid: process.pid, retained: s.backgroundTasks.tasks.length, used: s.used }));
