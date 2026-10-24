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
	test(`828.3 original deadline survives user takeover progress=${progress}`, async t => {
		const h = await fixture(t);
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
		await h.begin();
		await h.result(producers.subagent.launch("long"));
		await h.settle();
		const deadline = (await h.goal()).scheduler.wait.deadline;
		assert.equal(deadline, 1800000660000);
		t.mock.timers.tick(659000);
		await h.message({ role: "user", content: "Do independent work first." });
		await h.begin();
		if (progress) await h.result(work);
		t.mock.timers.tick(2000);
		await h.settle();
		const goal = await h.goal();
		assert.equal(goal.status, "paused", "settlement beyond original 11m deadline must pause without another turn");
		assert.match(goal.pauseReason, /deadline/i);
		assert.equal(goal.scheduler.backgroundTasks.tasks[0].taskId, "long");
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

test("828.7 exact +10m permits one authorized query then blocks repeated poll", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	await h.result(producers.subagent.launch("check"));
	await h.settle();
	assert.equal((await h.call(...producers.subagent.poll("check")))?.block, true);
	t.mock.timers.tick(599999);
	assert.equal(h.sent.length, 0);
	t.mock.timers.tick(1);
	assert.equal(h.sent.length, 1, "one check at exactly 600000ms");
	await h.message({ ...h.sent[0], role: "custom" });
	await h.begin();
	assert.equal(await h.call(...producers.subagent.poll("check")), undefined, "scheduled check must pass the public tool gate");
	await h.result({ toolName: "subagent", toolCallId: "status-check", input: { action: "status", id: "check" }, isError: false, details: { mode: "management", runId: "check", asyncId: "check", results: [] }, content: [] });
	assert.equal((await h.call(...producers.subagent.poll("check")))?.block, true, "no second query in same check turn");
	await h.settle();
	t.mock.timers.tick(60000);
	assert.equal((await h.goal()).status, "paused");
	assert.equal(h.sent.length, 1);
});

test("828 partial completion preserves sibling deadline and spent check budget", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	await h.result(producers.subagent.launch("fast"));
	await h.result(producers.subagent.launch("slow"));
	await h.settle();
	t.mock.timers.tick(600000);
	assert.equal(h.sent.length, 1);
	await h.message({ ...h.sent[0], role: "custom" });
	await h.begin();
	await h.settle();
	t.mock.timers.tick(59000);
	await h.message(producers.subagent.host("fast"));
	await h.begin();
	await h.result(work);
	t.mock.timers.tick(2000);
	await h.settle();
	const goal = await h.goal();
	assert.equal(goal.status, "paused", "partial report and result processing cannot extend sibling deadline");
	const slow = goal.scheduler.backgroundTasks.tasks.find(task => task.taskId === "slow");
	assert.equal(slow.hostReported, false);
	assert.equal(slow.wait.deadline, 1800000660000);
	assert.equal(slow.wait.remainingChecks, 0);
	assert.equal(h.sent.length, 1, "no renewed check quota");
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
	test(`828.8 cold process after spent check ${mode}`, async t => {
		const h = await fixture(t);
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
		await h.begin();
		await h.result(producers.subagent.launch("cold"));
		await h.settle();
		t.mock.timers.tick(600000);
		assert.equal(h.sent.length, 1);
		await h.message({ ...h.sent[0], role: "custom" });
		await h.begin();
		await h.settle();
		const child = spawnSync(process.execPath, ["--import", "./scripts/test-adapter-hooks.mjs", "--experimental-strip-types", "./tests/fixtures/issue-828-cold.mjs", h.cwd, mode], {
			cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", env: { ...process.env, PI_SUBAGENT_CHILD: "0", PI_SUBAGENT_DEPTH: "0" },
		});
		assert.equal(child.status, 0, `cold ${mode} process exit=${child.status}\n${child.stdout}\n${child.stderr}`);
	});
}


test("828.3 standing deadline pauses at exactly 660000ms after consumed check", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	await h.result(producers.subagent.launch("deadline"));
	await h.settle();
	t.mock.timers.tick(600000);
	assert.equal(h.sent.length, 1);
	await h.message({ ...h.sent[0], role: "custom" });
	await h.begin();
	await h.settle();
	t.mock.timers.tick(59999);
	assert.equal((await h.goal()).status, "active");
	t.mock.timers.tick(1);
	assert.equal((await h.goal()).status, "paused");
	assert.match((await h.goal()).pauseReason, /deadline/i);
	assert.equal(h.sent.length, 1);
});

test("828 partial result rewait keeps original sibling quota before deadline", async t => {
	const h = await fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
	await h.begin();
	await h.result(producers.subagent.launch("fast"));
	await h.result(producers.subagent.launch("slow"));
	await h.settle();
	t.mock.timers.tick(600000);
	await h.message({ ...h.sent[0], role: "custom" });
	await h.begin();
	await h.settle();
	await h.message(producers.subagent.host("fast"));
	await h.message(producers.subagent.host("fast"));
	await h.begin();
	await h.settle();
	const goal = await h.goal();
	assert.equal(goal.scheduler.wait.taskId, "slow");
	assert.equal(goal.scheduler.wait.deadline, 1800000660000);
	assert.equal(goal.scheduler.wait.remainingChecks, 0);
	assert.equal(goal.scheduler.wait.nextCheckAt, undefined);
	t.mock.timers.tick(60000);
	assert.equal((await h.goal()).status, "paused");
	assert.equal(h.sent.length, 1);
});
