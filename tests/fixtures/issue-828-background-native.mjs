import test from "node:test";
import assert from "node:assert/strict";

test("native background snapshot preserves a sibling's original budget through public hooks", async t => {
	const { extensionFixture, producers, work } = await import("./issue-828-extension.mjs");
	const h = await extensionFixture();
	t.after(() => h.close());
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	await h.result(producers.background.launch("fast"));
	await h.result(producers.background.launch("slow"));
	await h.settle();
	await h.message({ role: "custom", customType: "background-task-notification", details: { id: "fast", status: "failed" }, content: "native report" });
	await h.begin();
	await h.result(work);
	await h.result({ toolName: "bg_status", details: { tasks: [{ id: "fast", status: "failed" }, { id: "slow", status: "running" }] }, content: [] });
	await h.settle();
	const tasks = (await h.goal()).scheduler.backgroundTasks.tasks;
	assert.equal(tasks.find(task => task.taskId === "fast")?.outcome, "failed");
	assert.equal(tasks.find(task => task.taskId === "fast")?.hostReported, true);
	assert.equal(tasks.find(task => task.taskId === "slow")?.hostReported, false, "the sibling keeps waiting on its own report");
	assert.equal(tasks.find(task => task.taskId === "slow")?.wait, undefined, "issue 10: no system budget is attached");
	t.mock.timers.tick(660000);
	assert.equal((await h.goal()).status, "active", "no manufactured deadline pauses the goal");
	assert.equal((await h.goal()).scheduler.backgroundTasks.tasks.find(task => task.taskId === "slow")?.hostReported, false, "the sibling is never settled by elapsed time");
});

test("ordinary user cannot release generic wait or refresh its deadline", async t => {
	const { extensionFixture, producers } = await import("./issue-828-extension.mjs");
	const h = await extensionFixture();
	t.after(() => h.close());
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	await h.result(producers.background.launch("one"));
	await h.settle();
	t.mock.timers.tick(123000);
	await h.message({ role: "user", content: "Background task updates." });
	await h.begin();
	await h.settle();
	assert.equal((await h.goal()).scheduler.backgroundTasks.tasks[0].hostReported, false, "user text cannot release the wait");
	assert.equal((await h.goal()).scheduler.wait.deadline, undefined, "issue 10: no system deadline exists to refresh");
	assert.equal((await h.goal()).scheduler.wait.taskId, "one", "the task wait survives the user takeover");
	t.mock.timers.tick(537000);
	assert.equal((await h.goal()).status, "active", "no manufactured deadline pauses the goal");
});
