import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extensionFixture, producers, work, GOAL_ID } from "./issue-828-extension.mjs";

async function fixture(t, options = {}) {
	const h = await extensionFixture(options);
	t.after(() => h.close());
	return h;
}

for (const [name, producer] of Object.entries(producers)) {
	test(`828 baseline ${name} waits without checkpoints and blocks ordinary polls`, async t => {
		const h = await fixture(t);
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
		await h.begin();
		await h.result(producer.launch("first"));
		await h.settle();
		assert.equal((await h.goal()).scheduler.phase, "waiting");
		assert.equal((await h.goal()).scheduler.wait.taskId, "first");
		t.mock.timers.tick(599999);
		assert.equal(h.sent.length, 0);
		assert.equal((await h.call(...producer.poll("first")))?.block, true);
		await h.message({ role: "user", content: "Stop the task." });
		await h.begin();
		assert.equal(await h.call(producer.poll("first")[0], { id: "first", action: "stop" }), undefined);
	});
}

test("828.2 create_goal cannot inherit previous goal tasks or old notifications", async t => {
	const h = await fixture(t);
	await h.begin();
	await h.result(producers.subagent.launch("old"));
	await h.settle();
	assert.equal((await h.goal()).scheduler.wait.taskId, "old");
	await h.tool("create_goal", { objective: "New independent goal" });
	await h.begin();
	await h.settle();
	const next = await h.goal();
	assert.notEqual(next.id, GOAL_ID);
	assert.equal(next.scheduler?.wait, undefined, "new goal must not sleep on old goal task");
	assert.deepEqual(next.scheduler?.backgroundTasks?.tasks ?? [], []);
	await h.message(producers.subagent.host("old"));
	assert.equal((await h.goal()).id, next.id);
});

test("828.2 focus existing goal cannot inherit prior goal task", async t => {
	const h = await fixture(t, { hasUI: true, selectGoal: "Wait for detached work" });
	await h.tool("create_goal", { objective: "Second independent goal" });
	await h.begin();
	await h.result(producers.subagent.launch("belongs-to-second"));
	await h.settle();
	assert.equal((await h.goal()).scheduler.wait.taskId, "belongs-to-second");
	await h.command("goal-focus");
	assert.equal((await h.goal()).id, GOAL_ID);
	await h.begin();
	await h.settle();
	assert.equal((await h.goal()).scheduler?.wait, undefined, "focus must bind only the selected goal's task set");
});

for (const control of ["goal-pause", "goal-clear"]) {
	test(`828 ownership ${control} cannot be undone by old native report`, async t => {
		const h = await fixture(t, { hasUI: true });
		await h.begin();
		await h.result(producers.subagent.launch("old"));
		await h.settle();
		assert.equal((await h.goal()).scheduler.phase, "waiting");
		await h.command(control);
		await h.message(producers.subagent.host("old"));
		await h.begin();
		await h.settle();
		const goal = await h.goal();
		if (control === "goal-clear") assert.equal(goal, null);
		else assert.equal(goal.status, "paused");
		assert.equal(h.sent.length, 0, "old report cannot dispatch a goal checkpoint after explicit control");
	});
}

for (const progress of [false, true]) {
	test(`828.3 a task wait survives user takeover without renewing or bounding itself progress=${progress}`, async t => {
		const h = await fixture(t);
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
		await h.begin();
		await h.result(producers.subagent.launch("long"));
		await h.settle();
		const raised = (await h.goal()).scheduler.wait;
		assert.equal(raised.deadline, undefined, "issue 10: no system deadline is manufactured");
		t.mock.timers.tick(659000);
		await h.message({ role: "user", content: "Do independent work first." });
		await h.begin();
		if (progress) await h.result(work);
		t.mock.timers.tick(2000);
		await h.settle();
		t.mock.timers.tick(1000);
		const goal = await h.goal();
		assert.equal(goal.scheduler.backgroundTasks.tasks[0].taskId, "long");
		assert.equal(goal.scheduler.backgroundTasks.tasks[0].hostReported, false, "user work must not masquerade as task completion");
		if (progress) {
			assert.equal(goal.scheduler.phase === "ready" || goal.scheduler.phase === "claimed" || goal.scheduler.dispatch !== undefined, true, "independent work continues the goal");
			assert.equal(h.sent.length, 1, "exactly one continuation is dispatched");
		} else {
			assert.equal(goal.scheduler.phase, "waiting", "without progress the goal waits on the task again");
			assert.equal(goal.scheduler.wait.taskId, "long");
			assert.equal(goal.scheduler.wait.deadline, undefined, "no re-wait invents a deadline");
			assert.equal(goal.status, "active", "no manufactured deadline pauses the goal");
		}
	});
}

test("828.5 ordinary user input retains generic task tracking", async t => {
	const h = await fixture(t);
	await h.begin();
	await h.result(producers.generic.launch("generic"));
	await h.settle();
	assert.equal((await h.goal()).scheduler.wait.taskId, "generic");
	await h.message({ role: "user", content: "Do something else first." });
	await h.begin();
	await h.settle();
	const goal = await h.goal();
	assert.equal(goal.scheduler.wait?.taskId, "generic", "user takeover must not masquerade as task completion");
	assert.equal(goal.scheduler.backgroundTasks.tasks[0].hostReported, false);
});

test("828.5 BG failed result keeps failed outcome and cannot settle another producer", async t => {
	const h = await fixture(t);
	await h.begin();
	await h.result(producers.background.launch("same"));
	await h.result(producers.subagent.launch("same"));
	await h.settle();
	await h.result({ toolName: "bg_status", toolCallId: "terminal", input: { id: "same" }, isError: false, details: { task: { id: "same", status: "failed" } }, content: [] });
	const tasks = (await h.goal()).scheduler.backgroundTasks.tasks;
	assert.equal(tasks.find(task => task.toolName === "bg_run").outcome, "failed");
	assert.equal(tasks.find(task => task.toolName === "subagent").outcome, undefined);
});

test("828.7 no scheduled check exists; repeated polls stay blocked and control actions pass", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	await h.result(producers.subagent.launch("check"));
	await h.settle();
	assert.equal((await h.goal()).scheduler.phase, "waiting");
	assert.equal((await h.call(...producers.subagent.poll("check")))?.block, true);
	t.mock.timers.tick(599999);
	assert.equal(h.sent.length, 0);
	t.mock.timers.tick(1);
	assert.equal(h.sent.length, 0, "issue 10: the +10m authorized query is gone with the auto check");
	t.mock.timers.tick(60000);
	assert.equal(h.sent.length, 0, "no check or deadline run is ever dispatched");
	assert.equal((await h.goal()).status, "active");
	assert.equal((await h.goal()).scheduler.phase, "waiting");
	assert.equal((await h.call(...producers.subagent.poll("check")))?.block, true, "a repeated poll of the tracked task never passes");
	await h.message({ role: "user", content: "Stop the task." });
	await h.begin();
	assert.equal(await h.call(producers.subagent.poll("check")[0], { id: "check", action: "stop" }), undefined, "acting on the task stays allowed");
	await h.settle();
});

test("828 partial completion preserves the sibling wait without inventing a bound", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	await h.result(producers.subagent.launch("fast"));
	await h.result(producers.subagent.launch("slow"));
	await h.settle();
	const wait = (await h.goal()).scheduler.wait;
	assert.equal(wait.taskId, "fast");
	assert.equal(wait.deadline, undefined, "issue 10: no system deadline");
	await h.message(producers.subagent.host("fast"));
	await h.begin();
	await h.result(work);
	t.mock.timers.tick(2000);
	await h.settle();
	t.mock.timers.tick(1000);
	const goal = await h.goal();
	const slow = goal.scheduler.backgroundTasks.tasks.find(task => task.taskId === "slow");
	assert.equal(slow.hostReported, false, "the sibling keeps waiting on its own report");
	assert.equal(slow.wait, undefined, "no budget object is attached to tasks");
	assert.equal(h.sent.length, 1, "independent work dispatches exactly one continuation");
	await h.begin();
	await h.settle();
	const rewait = (await h.goal()).scheduler;
	assert.equal(rewait.phase, "waiting", "a quiet settle re-raises the wait on the sibling");
	assert.equal(rewait.wait.taskId, "slow");
	assert.equal(rewait.wait.deadline, undefined, "no re-wait invents a deadline");
	t.mock.timers.tick(660000);
	assert.equal((await h.goal()).status, "active", "no manufactured deadline pauses the goal");
	assert.equal(h.sent.length, 1);
});

for (const status of ["completed", "failed", "paused", "stopped"]) {
	test(`828 early duplicate subagent ${status} hooks preserve sibling`, async t => {
		const h = await fixture(t);
		await h.begin();
		await h.result(producers.subagent.launch("fast"));
		await h.result(producers.subagent.launch("fast"));
		await h.result(producers.subagent.launch("slow"));
		await h.message(producers.subagent.host("fast", status));
		await h.message(producers.subagent.host("fast", status));
		await h.begin();
		await h.settle();
		const goal = await h.goal();
		assert.equal(goal.status, "active");
		assert.equal(goal.scheduler.wait.taskId, "slow");
		assert.equal(goal.scheduler.backgroundTasks.tasks.length, 2);
		assert.equal(goal.scheduler.backgroundTasks.tasks.find(task => task.taskId === "fast").outcome, status);
		assert.equal(h.sent.length, 0, "native duplicate hooks must not add a goal checkpoint");
	});
}

for (const mode of ["canonical", "snapshot", "restore", "scan-restore", "foreign-session"]) {
	test(`828.8 cold process keeps the event-driven wait ${mode}`, async t => {
		const h = await fixture(t);
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
		await h.begin();
		await h.result(producers.subagent.launch("cold"));
		await h.settle();
		const child = spawnSync(process.execPath, ["--import", "./scripts/test-adapter-hooks.mjs", "--experimental-strip-types", "./tests/fixtures/issue-828-cold.mjs", h.cwd, mode], {
			cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", env: { ...process.env, PI_SUBAGENT_CHILD: "0", PI_SUBAGENT_DEPTH: "0" },
		});
		assert.equal(child.status, 0, `cold ${mode} process exit=${child.status}\n${child.stdout}\n${child.stderr}`);
	});
}


// 828.3 "standing deadline pauses at exactly 660000ms" tested the removed
// +10min/+11min auto policy. Its replacement lives in
// goal-pstack-agent-wait.test.ts: only a producer-declared deadlineAt bounds a
// task wait, and caller-declared waits keep their own deadline and polling. Both are asserted there against the real public surface.
test("828.3 the removed auto policy leaves no standing deadline", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	await h.result(producers.subagent.launch("deadline"));
	await h.settle();
	assert.equal((await h.goal()).scheduler.wait.deadline, undefined);
	t.mock.timers.tick(660000);
	assert.equal((await h.goal()).status, "active", "no system deadline pauses the goal");
	assert.equal(h.sent.length, 0);
});

test("828 partial result rewait keeps the sibling wait, unbounded and check-free", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	await h.result(producers.subagent.launch("fast"));
	await h.result(producers.subagent.launch("slow"));
	await h.settle();
	await h.message(producers.subagent.host("fast"));
	await h.message(producers.subagent.host("fast"));
	await h.begin();
	await h.settle();
	const goal = await h.goal();
	assert.equal(goal.scheduler.wait.taskId, "slow");
	assert.equal(goal.scheduler.wait.deadline, undefined);
	assert.equal(goal.scheduler.wait.remainingChecks, undefined);
	assert.equal(goal.scheduler.wait.nextCheckAt, undefined);
	t.mock.timers.tick(660000);
	assert.equal((await h.goal()).status, "active", "no manufactured deadline pauses the goal");
	assert.equal(h.sent.length, 0, "no check quota exists to dispatch");
});
