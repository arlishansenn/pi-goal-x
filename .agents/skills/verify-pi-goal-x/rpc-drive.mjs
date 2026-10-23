#!/usr/bin/env node
// Drives pi RPC mode with the pi-goal-x extension for verification runs.
// Usage:
//   node rpc-drive.mjs doctor <evidence-dir>
//   node rpc-drive.mjs run <workdir|auto> <drive-script.jsonl> <evidence-dir>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXT = "/Users/admin/project/pi-goal-x/extensions/goal.ts";
const [,, cmd, ...args] = process.argv;

if (!["doctor", "run"].includes(cmd)) {
	console.log("usage: node rpc-drive.mjs doctor <evidence-dir> | run <workdir|auto> <drive-script.jsonl> <evidence-dir>");
	process.exit(cmd ? 1 : 0);
}

const evidence = cmd === "doctor" ? args[0] : args[2];
fs.mkdirSync(evidence, { recursive: true });
const work = cmd === "doctor" || args[0] === "auto" ? fs.mkdtempSync("/tmp/pgx-verify-") : args[0];
const transcriptPath = path.join(evidence, "rpc-transcript.jsonl");
const transcript = fs.createWriteStream(transcriptPath, { flags: "a" });

const child = spawn("pi", ["--mode", "rpc", "--no-session", "-ne", "-e", EXT], { cwd: work, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => transcript.write(JSON.stringify({ ts: new Date().toISOString(), stderr: d.toString() }) + "\n"));

let buf = "";
const pending = [];
const dialogs = [];
child.stdout.on("data", (d) => {
	buf += d.toString();
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (!line) continue;
		let rec;
		try { rec = JSON.parse(line); } catch { transcript.write(JSON.stringify({ ts: new Date().toISOString(), unparsed: line }) + "\n"); continue; }
		transcript.write(JSON.stringify({ ts: new Date().toISOString(), record: rec }) + "\n");
		for (let j = pending.length - 1; j >= 0; j--) if (pending[j].resolve(rec)) pending.splice(j, 1);
		if (rec.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(rec.method)) {
			dialogs.push(rec);
			for (let j = pending.length - 1; j >= 0; j--) if (pending[j].dialog(rec)) pending.splice(j, 1);
		}
	}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitRecords = (pred, timeoutMs) => new Promise((resolve) => {
	const entry = { resolve: (rec) => (pred(rec) ? (resolve(rec), true) : false), dialog: pred, deadline: Date.now() + timeoutMs };
	pending.push(entry);
	setTimeout(() => { const k = pending.indexOf(entry); if (k >= 0) { pending.splice(k, 1); resolve(null); } }, timeoutMs);
});
const snap = (label) => {
	const dest = path.join(evidence, "snaps", label);
	fs.mkdirSync(dest, { recursive: true });
	fs.cpSync(path.join(work, ".pi", "goals"), dest, { recursive: true, force: true });
};

const autoDialogs = {};
async function answerDialogs() {
	while (dialogs.length) {
		const req = dialogs.shift();
		const body = autoDialogs[req.method];
		if (!body) { transcript.write(JSON.stringify({ ts: new Date().toISOString(), note: `unanswered dialog ${req.method} ${req.id}` }) + "\n"); continue; }
		const resp = { type: "extension_ui_response", id: req.id, ...body };
		child.stdin.write(JSON.stringify(resp) + "\n");
		transcript.write(JSON.stringify({ ts: new Date().toISOString(), sent: resp }) + "\n");
	}
}

let counts = { records: 0, sent: 0, snaps: 0 };
try {
	if (cmd === "doctor") {
		const ready = await waitRecords((r) => r.type === "response" && r.command === "get_state" && r.success, 15000) ?? null;
		void ready;
		child.stdin.write(JSON.stringify({ id: "doctor-1", type: "prompt", message: "/goal-status health" }) + "\n");
		const handled = await waitRecords((r) => r.type === "response" && r.id === "doctor-1" && r.success, 10000);
		await sleep(1000);
		await answerDialogs();
		const sawUi = fs.readFileSync(transcriptPath, "utf8").includes('"method":"notify"') || fs.readFileSync(transcriptPath, "utf8").includes('"method":"setStatus"');
		const disposition = handled?.data?.disposition;
		console.log(JSON.stringify({ ok: handled?.success === true && disposition === "handled" && sawUi, disposition, sawUi, work, evidence }));
		process.exitCode = handled?.success === true && disposition === "handled" && sawUi ? 0 : 1;
	} else {
		const steps = fs.readFileSync(args[1], "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => JSON.parse(l));
		for (const step of steps) {
			if (step.autoDialog) { Object.assign(autoDialogs, step.autoDialog); continue; }
			if (step.wait) { await sleep(step.wait); await answerDialogs(); continue; }
			if (step.snap) { await answerDialogs(); snap(step.snap); counts.snaps++; continue; }
			if (step.send) {
				await answerDialogs();
				const rec = typeof step.send === "string" ? JSON.parse(step.send) : step.send;
				child.stdin.write(JSON.stringify(rec) + "\n");
				counts.sent++;
				continue;
			}
		}
		await sleep(1200);
		await answerDialogs();
		await sleep(800);
	}
} catch (err) {
	console.error(String(err));
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
	await sleep(200);
	child.kill("SIGKILL");
	transcript.end();
	counts.records = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, "utf8").split("\n").filter((l) => l.trim()).length : 0;
	if (cmd === "run") console.log(JSON.stringify({ ok: process.exitCode !== 1, work, evidence, counts }));
}
