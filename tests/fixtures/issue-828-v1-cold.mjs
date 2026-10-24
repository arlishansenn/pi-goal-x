import assert from "node:assert/strict";
import { mock } from "node:test";
import { rmSync } from "node:fs";
import path from "node:path";
import { goalPoolSnapshotPath, goalStorageRoot } from "../../extensions/storage/goal-root.ts";
import { readActiveGoalPool, parseGoalFile } from "../../extensions/storage/goal-files.ts";
import { extensionFixture, GOAL_ID, workflowV1 } from "./issue-828-extension.mjs";

const [cwd] = process.argv.slice(2);
assert.ok(cwd);
assert.notEqual(process.pid, process.ppid);
rmSync(goalPoolSnapshotPath({ cwd }), { force: true });
rmSync(path.join(goalStorageRoot({ cwd }), ".goals-pool-snapshot.json"), { force: true });
const pooled = [...readActiveGoalPool({ cwd }).values()].find(g => g.id === GOAL_ID);
assert.ok(pooled);
const canonical = parseGoalFile(path.resolve(cwd, pooled.activePath));
assert.equal(canonical.scheduler.backgroundTasks.tasks.length, 2);
assert.equal(canonical.scheduler.backgroundTasks.tasks[1].execution.executionEpoch, 2);
assert.deepEqual(canonical.scheduler.backgroundTasks.deliveries, [{ deliveryId: "reserved-old", runId: "cold-v1", executionEpoch: 1 }]);
mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
const h = await extensionFixture({ cwd });
try {
	const before = (await h.goal()).scheduler.backgroundTasks.tasks[1].wait;
	await h.message(workflowV1.host("cold-v1", "reserved-old", 2));
	await h.message(workflowV1.host("cold-v1", "late-old", 1));
	h.lifecycle(workflowV1.lifecycle("cold-v1", "completed", 1));
	await h.begin();
	await h.result(workflowV1.resume("cold-v1"));
	await h.settle();
	let state = (await h.goal()).scheduler.backgroundTasks;
	assert.equal(state.tasks.length, 2);
	assert.equal(state.tasks[1].hostReported, false);
	assert.equal(state.tasks[1].outcome, undefined);
	assert.deepEqual(state.tasks[1].wait, before);
	assert.equal(state.deliveries.find(d => d.deliveryId === "reserved-old").executionEpoch, 1);
	await h.message(workflowV1.host("cold-v1", "new-delivery", 2));
	await h.begin();
	await h.settle();
	state = (await h.goal()).scheduler.backgroundTasks;
	assert.equal(state.tasks[1].hostReported, true);
	assert.equal(state.tasks[1].outcome, undefined, "no-status host does not invent completion");
	assert.equal((await h.goal()).scheduler.wait, undefined);
	console.log("canonical epoch=2 delivery tombstones preserved");
} finally {
	await h.close();
	mock.timers.reset();
}
