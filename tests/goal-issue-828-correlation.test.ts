import test from "node:test";
import assert from "node:assert/strict";
import { observeToolResult, observeHostMessage, type BackgroundTasksState } from "../extensions/goal-background-registry.ts";

const scope = { goalId: "goal-a", sessionId: "session-a" };
const empty = (): BackgroundTasksState => ({ version: 1, scope, tasks: [] });
const generic = (toolName: string, id: string, status: string) => ({ toolName, details: { task: { id, status } } });

test("structured failed results settle only their own producer and retain failure", () => {
	let state = observeToolResult(empty(), generic("other", "same", "running")).state;
	state = observeToolResult(state, generic("bg_run", "same", "running")).state;
	const result = observeToolResult(state, generic("bg_status", "same", "failed"));
	assert.equal(result.state.tasks.find(t => t.toolName === "other")?.outcome, undefined);
	assert.equal(result.state.tasks.find(t => t.toolName === "bg_run")?.outcome, "failed");
	assert.equal(result.state.tasks.find(t => t.toolName === "bg_run")?.hostReported, true);
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

import "./fixtures/issue-828-background-native.mjs";

test("background status lists never enroll tasks without a launch receipt", () => {
	const state = observeToolResult(empty(), { toolName: "bg_status", details: { tasks: [{ id: "foreign", status: "running" }] } }).state;
	assert.equal(state.tasks.length, 0);
});

import "./fixtures/issue-828-followup.mjs";
