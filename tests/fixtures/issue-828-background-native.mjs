import test from "node:test";
import assert from "node:assert/strict";

test("native background snapshot preserves a sibling's original budget through public hooks", async t => {
	const { extensionFixture, producers, work } = await import("./issue-828-extension.mjs");
	const h = await extensionFixture();
	t.after(() => h.close());
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	await h.result(producers.generic.launch("fast"));
	await h.result(producers.generic.launch("slow"));
	await h.settle();
	await h.message({ role: "custom", customType: "background-task-notification", details: { id: "fast", status: "failed" }, content: "native report" });
	await h.begin();
	await h.result(work);
	await h.result({ toolName: "bg_status", details: { tasks: [{ id: "fast", status: "failed" }, { id: "slow", status: "running" }] }, content: [] });
	await h.settle();
	const tasks = (await h.goal()).scheduler.backgroundTasks.tasks;
	assert.equal(tasks.find(task => task.taskId === "fast")?.outcome, "failed");
	assert.equal(tasks.find(task => task.taskId === "fast")?.hostReported, true);
	assert.equal(tasks.find(task => task.taskId === "slow")?.hostReported, false);
	assert.equal(tasks.find(task => task.taskId === "slow")?.wait.deadline, 1800000660000);
	t.mock.timers.tick(660000);
	assert.equal((await h.goal()).status, "paused");
});

test("first public workflow launch with actual sessionId enrolls before registry scope exists", async t => {
	const { extensionFixture, OWNER } = await import("./issue-828-extension.mjs");
	const h = await extensionFixture();
	t.after(() => h.close());
	await h.begin();
	await h.result({ toolName: "workflow", toolCallId: "first-v1", details: { contractVersion: 1, runId: "first", executionEpoch: 1, originSessionId: OWNER, sessionId: OWNER, background: true }, content: [] });
	await h.settle();
	assert.equal((await h.goal()).scheduler.backgroundTasks.tasks[0]?.taskId, "first");
});

for (const order of ["lifecycle-host", "host-lifecycle"]) {
	for (const sibling of [false, true]) test(`legacy ${order} fails closed with original deadline sibling=${sibling}`, async t => {
		const { extensionFixture, producers, lifecycle } = await import("./issue-828-extension.mjs");
		const h = await extensionFixture();
		t.after(() => h.close());
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
		await h.begin();
		await h.result(producers.workflow.launch("fast"));
		if (sibling) await h.result(producers.workflow.launch("slow"));
		await h.settle();
		if (order === "lifecycle-host") h.lifecycle(lifecycle("fast", "completed"));
		await h.message(producers.workflow.host("opaque"));
		if (order === "host-lifecycle") h.lifecycle(lifecycle("fast", "completed"));
		await h.begin();
		await h.result(producers.workflow.launch("fast", "duplicate"));
		await h.settle();
		for (const task of (await h.goal()).scheduler.backgroundTasks.tasks) {
			assert.equal(task.hostReported, false);
			assert.equal(task.wait.deadline, 1800000660000);
		}
		t.mock.timers.tick(660000);
		assert.equal((await h.goal()).status, "paused");
	});
}

test("ordinary user cannot release generic wait or refresh its deadline", async t => {
	const { extensionFixture, producers } = await import("./issue-828-extension.mjs");
	const h = await extensionFixture();
	t.after(() => h.close());
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	await h.result(producers.generic.launch("one"));
	await h.settle();
	t.mock.timers.tick(123000);
	await h.message({ role: "user", content: "Background task updates." });
	await h.begin();
	await h.settle();
	assert.equal((await h.goal()).scheduler.backgroundTasks.tasks[0].hostReported, false);
	assert.equal((await h.goal()).scheduler.wait.deadline, 1800000660000);
	t.mock.timers.tick(537000);
	assert.equal((await h.goal()).status, "paused");
});

for (const order of ["lifecycle-host", "host-lifecycle"]) test(`public v1 ${order} preserves two sibling budgets after independent work`, async t => {
	const { extensionFixture, workflowV1, work } = await import("./issue-828-extension.mjs");
	const h = await extensionFixture();
	t.after(() => h.close());
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	for (const id of ["fast", "slow", "third"]) await h.result(workflowV1.launch(id));
	await h.settle();
	t.mock.timers.tick(600000);
	assert.equal(h.sent.length, 1);
	if (order === "lifecycle-host") h.lifecycle(workflowV1.lifecycle("fast", "failed"));
	await h.message(workflowV1.host("fast", "opaque"));
	if (order === "host-lifecycle") h.lifecycle(workflowV1.lifecycle("fast", "failed"));
	await h.begin();
	await h.result(work);
	await h.message(workflowV1.host("fast", "opaque"));
	await h.begin();
	await h.settle();
	const tasks = (await h.goal()).scheduler.backgroundTasks.tasks;
	assert.equal(tasks[0].hostReported, true);
	assert.equal(tasks[0].outcome, "failed");
	for (const task of tasks.slice(1)) {
		assert.equal(task.hostReported, false);
		assert.equal(task.wait.deadline, 1800000660000);
		assert.equal(task.wait.remainingChecks, 0);
	}
	t.mock.timers.tick(60000);
	assert.equal((await h.goal()).status, "paused");
	assert.equal(h.sent.length, 1);
});

test("v1 epoch and delivery tombstones survive real canonical cold recovery", async t => {
	const { extensionFixture, workflowV1 } = await import("./issue-828-extension.mjs");
	const { spawnSync } = await import("node:child_process");
	const { fileURLToPath } = await import("node:url");
	const h = await extensionFixture();
	t.after(() => h.close());
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	await h.result(workflowV1.launch("cold-v1"));
	await h.settle();
	await h.message(workflowV1.host("cold-v1", "reserved-old"));
	h.lifecycle(workflowV1.lifecycle("cold-v1", "paused"));
	await h.begin();
	await h.result(workflowV1.resume("cold-v1"));
	await h.settle();
	const child = spawnSync(process.execPath, ["--import", "./scripts/test-adapter-hooks.mjs", "--experimental-strip-types", fileURLToPath(new URL("./issue-828-v1-cold.mjs", import.meta.url)), h.cwd], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
	assert.equal(child.status, 0, child.stdout + child.stderr);
	assert.match(child.stdout, /canonical epoch=2 delivery tombstones preserved/);
});
