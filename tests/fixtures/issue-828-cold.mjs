import assert from "node:assert/strict";
import { mock } from "node:test";
import { rmSync } from "node:fs";
import { goalPoolSnapshotPath, goalStorageRoot } from "../../extensions/storage/goal-root.ts";
import { readActiveGoalPool, parseGoalFile } from "../../extensions/storage/goal-files.ts";
import path from "node:path";
import { extensionFixture, GOAL_ID } from "./issue-828-extension.mjs";

const [cwd, mode] = process.argv.slice(2);
assert.ok(cwd && mode, "cold worker requires cwd and mode");
assert.notEqual(process.pid, process.ppid, "separate process");
if (mode === "scan-restore") {
	rmSync(goalPoolSnapshotPath({ cwd }), { force: true });
	rmSync(path.join(goalStorageRoot({ cwd }), ".goals-pool-snapshot.json"), { force: true });
}
const pooled = [...readActiveGoalPool({ cwd }).values()].find(goal => goal.id === GOAL_ID);
assert.ok(pooled, "persisted goal exists");
const goal = mode === "canonical" ? parseGoalFile(path.resolve(cwd, pooled.activePath)) : pooled;
assert.equal(goal.scheduler.phase, "waiting", `${mode} must retain exhausted-check wait rather than mark invalid`);
assert.equal(goal.scheduler.owner, "issue-828-session-a");
assert.equal(goal.scheduler.wait.deadline, 1800000660000);
assert.equal(goal.scheduler.wait.remainingChecks, 0);
assert.equal(goal.scheduler.wait.nextCheckAt, undefined);
assert.equal(goal.scheduler.backgroundTasks.tasks[0].taskId, "cold");
assert.equal(goal.scheduler.backgroundTasks.tasks[0].wait.remainingChecks, 0);
if (mode === "restore" || mode === "scan-restore" || mode === "foreign-session") {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000600000 });
	const h = await extensionFixture({ cwd, owner: mode === "foreign-session" ? "another-session" : "issue-828-session-a" });
	try {
		const restored = await h.goal();
		if (mode === "foreign-session") {
			assert.equal(restored.scheduler.owner, "issue-828-session-a", "different session cannot silently take ownership");
			mock.timers.tick(60000);
			assert.equal(h.sent.length, 0, "different session cannot schedule old owner's checkpoint");
			assert.equal((await h.goal()).scheduler.owner, "issue-828-session-a", "ordinary session reopen cannot acquire ownership");
		} else {
			assert.equal(restored.scheduler.phase, "waiting");
			assert.equal(restored.scheduler.wait.deadline, 1800000660000);
			assert.equal(restored.scheduler.wait.remainingChecks, 0);
			assert.equal((await h.call("subagent", { action: "status", id: "cold" }))?.block, true);
			mock.timers.tick(60000);
			assert.equal((await h.goal()).status, "paused", "cold restore retains original deadline timer");
			assert.equal(h.sent.length, 0, "spent quota cannot dispatch another check");
		}
	} finally {
		await h.close();
		mock.timers.reset();
	}
}
console.log(JSON.stringify({ mode, pid: process.pid, phase: goal.scheduler.phase, deadline: goal.scheduler.wait.deadline, remainingChecks: goal.scheduler.wait.remainingChecks }));
