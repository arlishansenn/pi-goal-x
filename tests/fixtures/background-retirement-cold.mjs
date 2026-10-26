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
assert.equal(s.wait.taskId, "cold");
assert.equal(s.wait.deadline, undefined, "issue 10: the system-made task deadline is dropped on load");
assert.equal(s.wait.remainingChecks, undefined, "the legacy check budget is dropped, spent or unspent");
assert.equal(s.wait.nextCheckAt, undefined);
assert.equal(s.dispatch?.taskCheck, undefined, "a legacy taskCheck grant authorizes nothing");
assert.equal(s.backgroundTasks.deliveries, undefined);
assert.deepEqual(JSON.parse(JSON.stringify(s.backgroundTasks.tasks)), mode.startsWith("mixed") ? before.backgroundTasks.tasks.slice(1) : []);
mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000600000 });
rmSync(goalPoolSnapshotPath({ cwd }), { force: true });
rmSync(path.join(goalStorageRoot({ cwd }), ".goals-pool-snapshot.json"), { force: true });
const h = await extensionFixture({ cwd });
try {
	assert.equal(h.sent.length, 0, "cold restore must not replay a check");
	if (mode === "claimed") {
		assert.equal((await h.goal()).status, "paused");
		assert.match((await h.goal()).pauseReason, /interrupt|resume/i);
	}
	assert.equal(await h.call("workflow", { runId: "old-dw" }), undefined, "retired task cannot grant or block polling");
	if (mode === "mixed") assert.equal((await h.call("subagent", { action: "status", id: "cold" }))?.block, true, "retired identity never transfers a grant");
	mock.timers.tick(660000);
	const restored = await h.goal();
	if (mode === "mixed") {
		assert.equal(restored.scheduler.used, before.used, "no allowance is spent while reloading");
		assert.equal(h.sent.length, 0, "the dropped legacy budget dispatches nothing");
		assert.equal(restored.status, "active", "no system-made deadline pauses the reloaded goal");
		assert.equal(restored.scheduler.phase, "waiting", "the wait survives on the retained sibling alone");
	} else if (mode === "claimed") {
		assert.equal(h.sent.length, 0);
		assert.equal(restored.status, "paused", "claimed dispatch must pause instead of replaying");
	} else {
		// unspent/waiting: the retired identity was the only task, so the wait
		// ends with it and the goal continues instead of sleeping forever.
		assert.equal(h.sent.length, 1, "the wait ends with its retired task; one continuation dispatches");
		assert.equal(restored.status, "active");
		assert.equal(restored.scheduler.used, before.used + 1, "exactly that one continuation is charged");
	}
} finally {
	await h.close();
	mock.timers.reset();
}
console.log(JSON.stringify({ mode, pid: process.pid, retained: s.backgroundTasks.tasks.length, used: s.used }));
