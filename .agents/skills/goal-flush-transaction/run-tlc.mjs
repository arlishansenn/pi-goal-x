#!/usr/bin/env node
// TLC runner for the GoalFlushTransaction design model.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.7.4";
const URL = `https://github.com/tlaplus/tlaplus/releases/download/v${VERSION}/tla2tools.jar`;
const jar = process.env.PI_GOAL_X_TLA_JAR
	?? path.join(os.homedir(), ".cache", "pi-goal-x-tla", `tla2tools-${VERSION}.jar`);

if (!fs.existsSync(jar) || fs.statSync(jar).size < 2_000_000) {
	fs.mkdirSync(path.dirname(jar), { recursive: true });
	const tmp = path.join(os.tmpdir(), `tla2tools-${VERSION}.download`);
	console.log(`downloading tla2tools ${VERSION} to ${jar}`);
	execFileSync("curl", ["-sS", "-L", "--fail", "--retry", "3", "-o", tmp, URL], { stdio: "inherit" });
	fs.renameSync(tmp, jar);
}

const modelDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "model");
const meta = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-x-tlc-"));
try {
	execFileSync(
		"java",
		["-cp", jar, "tlc2.TLC", "-cleanup", "-metadir", meta, "GoalFlushTransaction"],
		{ cwd: modelDir, stdio: "inherit" },
	);
} finally {
	fs.rmSync(meta, { recursive: true, force: true });
}
