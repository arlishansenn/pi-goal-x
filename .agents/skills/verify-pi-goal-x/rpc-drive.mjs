#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const [,, mode, ...args] = process.argv;
if (!["doctor", "run"].includes(mode) || (mode === "doctor" ? args.length !== 1 : args.length !== 3)) {
 console.error("Usage: rpc-drive.mjs doctor <new-evidence-dir> | run <auto|scratch-dir> <steps.jsonl> <new-evidence-dir>");
 process.exit(1);
}
const evidence = path.resolve(mode === "doctor" ? args[0] : args[2]);
assert.ok(!fs.existsSync(evidence), "Use a new evidence directory for each run; never overwrite proof");
fs.mkdirSync(evidence, { recursive: true });
const owned = mode === "doctor" || args[0] === "auto";
const work = owned ? fs.mkdtempSync(path.join(os.tmpdir(), "pgx-verify-")) : path.resolve(args[0]);
assert.ok(fs.existsSync(work), "Scratch workdir must already exist");
const settings = process.env.PI_GOAL_VERIFY_SETTINGS;
if (settings) {
 assert.ok(owned, "Settings scaffolding is allowed only in a new owned scratch project");
 fs.mkdirSync(path.join(work, ".pi"), { recursive: true });
 fs.writeFileSync(path.join(work, ".pi", "pi-goal-x-settings.json"), JSON.stringify(JSON.parse(settings)));
}
const command = ["--mode", "rpc", "-ne", "-ns", "-np", "--no-mcp", "-e", path.join(root, "extensions/goal.ts")];
if (process.env.PI_GOAL_VERIFY_SESSION) command.push("--session", path.resolve(process.env.PI_GOAL_VERIFY_SESSION));
else if (process.env.PI_GOAL_VERIFY_SESSION_DIR) command.push("--session-dir", path.resolve(process.env.PI_GOAL_VERIFY_SESSION_DIR));
else command.push("--no-session");
for (const extra of JSON.parse(process.env.PI_GOAL_VERIFY_EXTENSIONS ?? "[]")) command.push("-e", path.resolve(extra));
const child = spawn("pi", command, { cwd: work, stdio: ["pipe", "pipe", "pipe"] });
const records = [];
const log = fs.createWriteStream(path.join(evidence, "rpc-transcript.jsonl"), { flags: "wx" });
const record = (value) => log.write(JSON.stringify({ ts: new Date().toISOString(), ...value }) + "\n");
let buffer = Buffer.alloc(0);
let failure;
let policy = {};
let seq = 0;
child.on("error", error => { failure = error; });
child.stderr.on("data", data => record({ stderr: data.toString() }));
function send(value) { record({ sent: value }); child.stdin.write(JSON.stringify(value) + "\n"); }
child.stdout.on("data", data => {
 buffer = Buffer.concat([buffer, data]);
 let index;
 while ((index = buffer.indexOf(10)) !== -1) {
  const line = buffer.subarray(0, index).toString("utf8").replace(/\r$/, "");
  buffer = buffer.subarray(index + 1);
  if (!line) continue;
  let value;
  try { value = JSON.parse(line); } catch { failure = new Error("Non-JSON RPC output"); record({ unparsed: line }); continue; }
  records.push(value); record({ record: value });
  if (value.type === "extension_error") failure = new Error(`Extension error: ${value.error ?? value.message ?? JSON.stringify(value)}`);
  if (value.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(value.method)) {
   const answer = policy[value.method];
   if (!answer) { failure = new Error(`No explicit answer configured for ${value.method}`); send({ type: "extension_ui_response", id: value.id, cancelled: true }); }
   else send({ type: "extension_ui_response", id: value.id, ...answer });
  }
 }
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 15000) {
 const end = Date.now() + timeout;
 while (Date.now() < end) {
  if (failure) throw failure;
  if (predicate()) return;
  if (child.exitCode !== null) throw new Error(`pi exited ${child.exitCode}`);
  await delay(25);
 }
 throw new Error(`Condition timed out after ${timeout}ms`);
}
async function request(value, timeout) {
 const id = value.id ?? `verify-${++seq}`;
 const start = records.length;
 send({ ...value, id });
 await until(() => records.slice(start).some(r => r.type === "response" && r.id === id), timeout);
 const response = records.slice(start).find(r => r.type === "response" && r.id === id);
 assert.equal(response.success, true, response.error);
 return response;
}
function goals() {
 const dir = path.join(work, ".pi", "goals");
 if (!fs.existsSync(dir)) return [];
 return fs.readdirSync(dir).filter(n => /^active_goal_.*\.md$/.test(n)).map(n => {
  const raw = fs.readFileSync(path.join(dir, n), "utf8");
  const split = raw.indexOf("\n# Goal Prompt");
  return JSON.parse(split < 0 ? raw : raw.slice(0, split));
 });
}
function matches(object, fields) {
 return Object.entries(fields).every(([key, expected]) => {
  const value = key.split(".").reduce((obj, k) => obj?.[k], object);
  return expected === null ? value === undefined || value === null : value === expected;
 });
}
try {
 record({ launch: { work, command, settingsScaffold: settings ? JSON.parse(settings) : null } });
 await request({ type: "get_state" });
 const health = await request({ type: "prompt", message: "/goal-status health" });
 assert.equal(health.data?.disposition, "handled");
 assert.ok(records.some(r => r.type === "extension_ui_request" && r.statusKey === "goal"), "goal extension must answer doctor");
 if (mode === "run") {
  fs.copyFileSync(args[1], path.join(evidence, "drive.jsonl"));
  for (const line of fs.readFileSync(args[1], "utf8").split("\n").filter(l => l.trim())) {
   const step = JSON.parse(line);
   if (step.autoDialog) policy = step.autoDialog;
   else if (step.send) await request(step.send, step.timeoutMs);
   else if (step.waitForGoal) await until(() => goals().some(g => matches(g, step.waitForGoal)), step.timeoutMs);
   else if (step.waitForRecord) await until(() => records.some(r => matches(r, step.waitForRecord)), step.timeoutMs);
   else if (step.wait !== undefined) await delay(step.wait);
   else if (step.snap) {
    assert.match(step.snap, /^[a-zA-Z0-9_-]+$/);
    const dest = path.join(evidence, "snaps", step.snap);
    assert.ok(!fs.existsSync(dest), "Snapshot labels must be unique");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const source = path.join(work, ".pi", "goals");
    if (fs.existsSync(source)) fs.cpSync(source, dest, { recursive: true });
    else fs.mkdirSync(dest);
   } else throw new Error("Unknown drive step");
  }
 }
 if (failure) throw failure;
 console.log(JSON.stringify({ ok: true, work, evidence, ownedWorkdir: owned }));
} catch (error) {
 record({ failure: String(error) }); console.error(String(error)); process.exitCode = 1;
} finally {
 child.kill("SIGTERM");
 await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(1500)]);
 if (child.exitCode === null && child.signalCode === null) {
  child.kill("SIGKILL");
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(1500)]);
 }
 await new Promise(resolve => log.end(resolve));
 fs.writeFileSync(path.join(evidence, "cleanup.json"), JSON.stringify({ ownedWorkdir: owned, work, childPid: child.pid, exitCode: child.exitCode, signal: child.signalCode }));
 if (owned) fs.rmSync(work, { recursive: true, force: true });
 assert.ok(fs.existsSync(path.join(evidence, "rpc-transcript.jsonl")), "Evidence must survive cleanup");
}
