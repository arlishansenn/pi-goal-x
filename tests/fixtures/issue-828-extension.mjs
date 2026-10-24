import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import goalExtension from "../../extensions/goal.ts";
import { createGoal, goalFocusDetails } from "../../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../../extensions/storage/goal-files.ts";
import { invalidateGoalSettingsCache } from "../../extensions/goal-settings.ts";

export const GOAL_ID = "issue-828-goal-a";
export const OWNER = "issue-828-session-a";

export async function extensionFixture({ cwd: existing, owner = OWNER, hasUI = false, selectGoal } = {}) {
	const cwd = existing ?? mkdtempSync(path.join(tmpdir(), "pgx828-red-"));
	const saved = new Map(["PI_SUBAGENT_CHILD", "PI_SUBAGENT_DEPTH", "PI_GOAL_GLOBAL_SETTINGS_FILE"].map(key => [key, process.env[key]]));
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_DEPTH;
	process.env.PI_GOAL_GLOBAL_SETTINGS_FILE = path.join(cwd, "no-global-settings.json");
	if (!existing) {
		mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ strictExecutionContract: false }));
		const goal = createGoal({ objective: "Wait for detached work", autoContinue: true, sisyphus: false });
		goal.id = GOAL_ID;
		writeActiveGoalFile({ cwd }, goal);
	}
	invalidateGoalSettingsCache();
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const listeners = new Map();
	const sent = [];
	const entries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(GOAL_ID, "created") }];
	const notifications = [];
	const ctx = {
		cwd, hasUI, isIdle: () => true, hasPendingMessages: () => false, abort() {},
		getSystemPrompt: () => "base",
		sessionManager: { getSessionId: () => owner, getCwd: () => cwd, getRoot: () => cwd, getBranch: () => entries },
		ui: { notify: message => notifications.push(message), setStatus() {}, setWidget() {}, confirm: async () => true, select: async (_title, labels) => labels.find(label => label.includes(selectGoal)), onTerminalInput: () => () => {} },
	};
	const pi = {
		registerTool: tool => tools.set(tool.name, tool),
		registerCommand: (name, command) => commands.set(name, command),
		on: (name, handler) => handlers.set(name, handler),
		getActiveTools: () => ["read", "write", "workflow", "subagent", "bg_run", "bg_status"],
		setActiveTools() {}, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		registerMessageRenderer() {}, sendMessage: message => sent.push(message),
		events: { on: (name, handler) => { listeners.set(name, handler); return () => listeners.delete(name); } },
	};
	goalExtension(pi);
	const event = async (name, payload = {}) => {
		assert.ok(handlers.has(name), `registered event ${name}; delegated-session guard must not disable the fixture`);
		return handlers.get(name)(payload, ctx);
	};
	const tool = async (name, input = {}) => {
		assert.ok(tools.has(name), `registered tool ${name}`);
		return tools.get(name).execute(`fixture-${name}`, input, undefined, undefined, ctx);
	};
	const command = async name => {
		assert.ok(commands.has(name), `registered command ${name}`);
		return commands.get(name).handler("", ctx);
	};
	await event("session_start", { reason: existing ? "resume" : "startup" });
	return {
		cwd, ctx, sent, notifications, event, tool, command,
		goal: async () => (await tool("get_goal", { verbose: true })).details.goal,
		begin: async () => { await event("agent_start"); return event("turn_start"); },
		settle: async () => {
			await event("turn_end", { message: { role: "assistant", content: [], stopReason: "stop" } });
			await event("agent_end", { messages: [] });
			return event("agent_settled");
		},
		result: receipt => event("tool_result", receipt),
		message: message => event("message_start", { message }),
		call: (toolName, input) => event("tool_call", { type: "tool_call", toolCallId: "poll", toolName, input }),
		lifecycle: payload => {
			assert.ok(listeners.has("pi-dynamic-workflows:lifecycle"), "workflow lifecycle subscription");
			return listeners.get("pi-dynamic-workflows:lifecycle")(payload);
		},
		close: async () => {
			await event("session_shutdown");
			if (!existing) rmSync(cwd, { recursive: true, force: true });
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			invalidateGoalSettingsCache();
		},
	};
}

const text = value => [{ type: "text", text: value }];
export const producers = {
	workflow: {
		launch: (id, receipt = `launch-${id}`) => ({ toolName: "workflow", toolCallId: receipt, input: { background: true }, isError: false, details: { runId: id, background: true }, structuredContent: { runId: id, status: "started" }, content: text("Background workflow started.") }),
		resume: (id, receipt = `resume-${id}`) => ({ toolName: "workflow", toolCallId: receipt, input: { resume: id }, isError: false, details: { runId: id, background: true, resumedFrom: id }, structuredContent: { runId: id, status: "resumed" }, content: text("Background workflow resumed.") }),
		host: deliveryId => ({ role: "custom", customType: "workflow-result", details: { deliveryId }, content: "Detached work finished." }),
		poll: id => ["workflow_status", { runId: id }],
	},
	subagent: {
		launch: (id, receipt = `launch-${id}`) => ({ toolName: "subagent", toolCallId: receipt, input: { agent: "delegate", task: "Report a result", async: true }, isError: false, details: { mode: "single", runId: id, toolCallId: receipt, results: [], asyncId: id, asyncDir: `/tmp/async-subagent-runs/${id}`, context: "fresh", timeoutMs: 1800000 }, content: text(`Async: delegate [${id}]`) }),
		host: (id, status = "completed") => ({ role: "custom", customType: "subagent-notify", details: { runs: [{ agent: "delegate", runId: id, status, asyncDir: `/tmp/async-subagent-runs/${id}`, durationMs: 1000 }] }, content: "Detached work finished." }),
		poll: id => ["subagent", { action: "status", id }],
	},
	generic: {
		launch: id => ({ toolName: "bg_run", toolCallId: `launch-${id}`, input: { command: "sleep" }, isError: false, details: { task: { id, name: "detached work", status: "running" } }, content: text("running") }),
		poll: id => ["bg_status", { id }],
	},
};

export const lifecycle = (runId, status, sessionId = OWNER) => ({ runId, status, sessionId, name: "detached work" });
export const work = { toolName: "read", toolCallId: "independent-read", input: { file_path: "independent.txt" }, isError: false, content: [{ type: "text", text: "independent result" }] };
