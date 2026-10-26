import { goalStoragePath, goalPoolSnapshotPath, ensureGoalStorageDirectory } from "./storage/goal-root.ts";
/**
 * /goal-recovery — read-only storage/recovery report + guarded repair.
 *
 * Reliability campaign 2026-08-09. The report scans four failure classes:
 *   - malformed goal files (active_goal_*.md that do not parse);
 *   - malformed ledger lines (counted by the ledger reader);
 *   - stale locks (.pi/goals/.locks/*.lock whose pid is dead or whose age
 *     exceeds the TTL — left behind by crashed sessions);
 *   - orphaned snapshot data (pool-snapshot goals with no matching file).
 *
 * Everything is read-only by default. Repair operations (stale-lock removal,
 * snapshot refresh) require an explicit confirmation AND copy the affected
 * files into a timestamped backup directory first. Malformed goal files and
 * malformed ledger lines are reported but never rewritten automatically —
 * rewriting user-owned data is deliberately out of scope (and automatic
 * ledger rewriting is a documented non-goal of the reliability campaign).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readGoalLedger } from "./goal-ledger.ts";
import { GOAL_LOCK_DIR } from "./storage/goal-lock.ts";
import { activePathForGoal, invalidateGoalPoolCache, parseGoalFile, readActiveGoalPool, type GoalFileContext } from "./storage/goal-files.ts";
import { readPstackAgentRecords, type PstackAgentRecordEntry, type TrackedTask } from "./goal-background-registry.ts";
import type { GoalRecord } from "./goal-record.ts";

export const GOALS_DIR = ".pi/goals";
export const RECOVERY_BACKUP_DIR = ".pi/goals/.recovery-backup";

export interface MalformedGoalFileEntry {
	relPath: string;
	error: string;
}

export interface StaleLockEntry {
	fileName: string;
	pid: number;
	startedAt: string;
	ageMs: number;
}

export interface OrphanedSnapshotEntry {
	goalId: string;
	activePath: string;
}

export interface RecoveryReport {
	scannedAt: string;
	malformedGoalFiles: MalformedGoalFileEntry[];
	malformedLedgerLines: number;
	staleLocks: StaleLockEntry[];
	orphanedSnapshotGoals: OrphanedSnapshotEntry[];
	healthy: boolean;
}

export interface RecoveryRepairResult {
	applied: string[];
	backupDir: string | null;
	confirmed: boolean;
}

const LOCK_STALE_TTL_MS = 30_000;

function safeLockName(goalId: string): string {
	return goalId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function goalsDir(ctx: GoalFileContext): string {
	return goalStoragePath(ctx, GOALS_DIR);
}

function locksDir(ctx: GoalFileContext): string {
	return goalStoragePath(ctx, GOAL_LOCK_DIR);
}

/** Scan the goals dir for active_goal files that fail to parse. */
function scanMalformedGoalFiles(ctx: GoalFileContext): MalformedGoalFileEntry[] {
	const root = goalsDir(ctx);
	const out: MalformedGoalFileEntry[] = [];
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return out;
	}
	for (const name of names) {
		if (!/^active_goal_.*\.md$/.test(name)) continue;
		const relPath = path.posix.join(GOALS_DIR, name);
		const parsed = parseGoalFile(path.join(root, name));
		if (!parsed) {
			out.push({ relPath, error: "file does not parse as a goal record" });
		}
	}
	return out;
}

/** Scan the lock dir for lock files whose pid is dead or whose age exceeds the TTL. */
function scanStaleLocks(ctx: GoalFileContext): StaleLockEntry[] {
	const dir = locksDir(ctx);
	const out: StaleLockEntry[] = [];
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return out;
	}
	const now = Date.now();
	for (const name of names) {
		if (!name.endsWith(".lock")) continue;
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as { pid?: unknown; startedAt?: unknown };
			const pid = typeof raw.pid === "number" ? raw.pid : 0;
			const startedAt = typeof raw.startedAt === "string" ? raw.startedAt : "";
			const startedMs = new Date(startedAt).getTime();
			const ageMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : now;
			if (!pidAlive(pid) || ageMs > LOCK_STALE_TTL_MS) {
				out.push({ fileName: name, pid, startedAt, ageMs });
			}
		} catch {
			// Unreadable lock body: report as stale (pid unknown).
			out.push({ fileName: name, pid: 0, startedAt: "", ageMs: now });
		}
	}
	return out;
}

/** Snapshot goals whose active file no longer exists in the goals dir. */
function scanOrphanedSnapshotGoals(ctx: GoalFileContext): OrphanedSnapshotEntry[] {
	const root = goalsDir(ctx);
	const out: OrphanedSnapshotEntry[] = [];
	let present: Set<string>;
	try {
		present = new Set(fs.readdirSync(root));
	} catch {
		return out;
	}
	try {
		const snapshotPath = goalPoolSnapshotPath(ctx);
		const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as { goals?: Array<{ goalId?: unknown; activePath?: unknown }> };
		for (const goal of snapshot.goals ?? []) {
			const activePath = typeof goal.activePath === "string" ? goal.activePath : "";
			const base = path.posix.basename(activePath);
			if (base && !present.has(base)) {
				out.push({ goalId: typeof goal.goalId === "string" ? goal.goalId : base, activePath });
			}
		}
	} catch {
		// Missing/corrupt snapshot: no orphan data to report.
	}
	return out;
}

export interface VerifiedTaskReceipt {
	producer: string;
	taskId: string;
	receiptId: string;
	outcome: "completed" | "failed" | "stopped";
	sessionId: string;
	evidenceEntryId: string;
}

/**
 * Latest pstack-agents record per agent, across every session file whose own
 * header names `sessionId` (branch files included; a forged file name with a
 * foreign header id never matches, malformed files and symlinks are skipped).
 * Within one file, line order is the provenance. Across files, a conflicting
 * status is ordered by the entries' own timestamps; when that cannot decide
 * (timestamps missing or tied), the agent is returned with status "" and never
 * settles: ambiguity is rejected rather than guessed.
 */
export function scanSessionPstackReceipts(sessionDir: string, sessionId: string): Map<string, PstackAgentRecordEntry> {
	const latest = new Map<string, PstackAgentRecordEntry>();
	const ambiguous = new Set<string>();
	let names: string[];
	try { names = fs.readdirSync(sessionDir); } catch { return latest; }
	for (const name of names.filter(n => n.endsWith(".jsonl")).sort()) {
		const file = path.join(sessionDir, name);
		try {
			if (fs.lstatSync(file).isSymbolicLink()) continue;
		} catch { continue; }
		let lines: string[];
		try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { continue; }
		// A malformed or missing header only disqualifies that one file.
		try {
			const header = lines.length > 0 ? JSON.parse(lines[0]!) as { type?: unknown; id?: unknown } : undefined;
			if (!header || header.type !== "session" || header.id !== sessionId) continue;
		} catch { continue; }
		const entries: unknown[] = [];
		for (const line of lines.slice(1)) {
			if (!line.trim()) continue;
			try { entries.push(JSON.parse(line)); } catch { continue; }
		}
		// Within one file, line order is the provenance: the last record wins.
		for (const record of readPstackAgentRecords(entries).values()) {
			if (ambiguous.has(record.agentId)) continue;
			const prior = latest.get(record.agentId);
			if (!prior) { latest.set(record.agentId, record); continue; }
			if (prior.status === record.status) continue;
			// Conflicting statuses across files: the later entry wins by its own
			// timestamp; an undecidable conflict never settles.
			if (Number.isFinite(record.at) && Number.isFinite(prior.at) && record.at !== prior.at) {
				if (record.at > prior.at) latest.set(record.agentId, record);
				continue;
			}
			ambiguous.add(record.agentId);
			latest.set(record.agentId, { ...record, status: "" });
		}
	}
	return latest;
}

/**
 * Verify outstanding pstack agent tasks against the session records of the
 * session that launched them. The trusted binding is the agent id, the
 * session file header id, and the latest terminal record; `receiptId` is
 * copied from the task for audit and incarnation matching, the records do not
 * carry it. Anything else settles nothing. No task, ledger, or goal data is
 * modified here.
 */
export function verifyRecoverableTasks(
	tasks: readonly TrackedTask[],
	scopeSessionId: string | undefined,
	sessionDir: string | undefined,
): VerifiedTaskReceipt[] {
	if (!sessionDir) return [];
	const receipts = new Map<string, Map<string, PstackAgentRecordEntry>>();
	const verified: VerifiedTaskReceipt[] = [];
	for (const task of tasks) {
		if (task.hostReported || task.producer !== "structured:agent") continue;
		const sessionId = task.scope?.sessionId ?? scopeSessionId;
		if (!sessionId) continue;
		let latest = receipts.get(sessionId);
		if (!latest) { latest = scanSessionPstackReceipts(sessionDir, sessionId); receipts.set(sessionId, latest); }
		const record = latest.get(task.taskId);
		if (!record || !["completed", "failed", "stopped"].includes(record.status)) continue;
		verified.push({ producer: task.producer, taskId: task.taskId, receiptId: task.receiptId, outcome: record.status as VerifiedTaskReceipt["outcome"], sessionId, evidenceEntryId: record.entryId });
	}
	return verified;
}

/** Copy the goal's active file into the timestamped recovery backup; returns the stamp used. */
export function backupGoalFileForRecovery(ctx: GoalFileContext, goal: GoalRecord): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const relative = activePathForGoal(ctx, goal);
	ensureGoalStorageDirectory(ctx, `${RECOVERY_BACKUP_DIR}/${stamp}`);
	fs.copyFileSync(goalStoragePath(ctx, relative), goalStoragePath(ctx, `${RECOVERY_BACKUP_DIR}/${stamp}/${path.posix.basename(relative)}`));
	return stamp;
}

/** Read-only recovery report. Never mutates goal storage. */
export function runRecoveryReport(ctx: GoalFileContext): RecoveryReport {
	const ledger = readGoalLedger(ctx);
	const malformedGoalFiles = scanMalformedGoalFiles(ctx);
	const staleLocks = scanStaleLocks(ctx);
	const orphanedSnapshotGoals = scanOrphanedSnapshotGoals(ctx);
	return {
		scannedAt: new Date().toISOString(),
		malformedGoalFiles,
		malformedLedgerLines: ledger.malformed,
		staleLocks,
		orphanedSnapshotGoals,
		healthy: malformedGoalFiles.length === 0 && ledger.malformed === 0 && staleLocks.length === 0 && orphanedSnapshotGoals.length === 0,
	};
}

/**
 * Apply the safe repair operations with confirmation + backup.
 *
 * Repairs: stale-lock removal (backed up then unlinked) and pool-snapshot
 * refresh (backed up then rewritten from a fresh scan). Returns what was
 * applied. When `confirm` rejects, nothing is touched.
 */
export async function runRecoveryRepair(
	ctx: GoalFileContext,
	report: RecoveryReport,
	confirm: () => Promise<boolean>,
): Promise<RecoveryRepairResult> {
	if (report.staleLocks.length === 0 && report.orphanedSnapshotGoals.length === 0) {
		return { applied: [], backupDir: null, confirmed: false };
	}
	const confirmed = await confirm();
	if (!confirmed) return { applied: [], backupDir: null, confirmed: false };

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupDir = goalStoragePath(ctx, `${RECOVERY_BACKUP_DIR}/${stamp}`);
	ensureGoalStorageDirectory(ctx, `${RECOVERY_BACKUP_DIR}/${stamp}`);
	const applied: string[] = [];

	for (const lock of report.staleLocks) {
		const source = path.join(locksDir(ctx), lock.fileName);
		try {
			fs.copyFileSync(source, path.join(backupDir, `lock-${safeLockName(lock.fileName)}`));
			fs.unlinkSync(source);
			applied.push(`removed stale lock ${lock.fileName}`);
		} catch {
			// best-effort per item
		}
	}

	if (report.orphanedSnapshotGoals.length > 0) {
		const snapshotPath = goalPoolSnapshotPath(ctx);
		try {
			if (fs.existsSync(snapshotPath)) {
				fs.copyFileSync(snapshotPath, path.join(backupDir, "pool-snapshot.json"));
			}
			// Refresh the pool snapshot from a fresh scan (invalidate first so
			// the re-read goes cold and rewrites the snapshot).
			invalidateGoalPoolCache();
			readActiveGoalPool(ctx);
			applied.push(`refreshed pool snapshot (${report.orphanedSnapshotGoals.length} orphaned entr${report.orphanedSnapshotGoals.length === 1 ? "y" : "ies"} dropped)`);
		} catch {
			// best-effort
		}
	}

	return { applied, backupDir, confirmed: true };
}

export function formatRecoveryReport(report: RecoveryReport): string {
	const lines: string[] = [];
	lines.push(report.healthy ? "Recovery report: OK — no issues found." : "Recovery report: issues found.");
	if (report.malformedGoalFiles.length > 0) {
		lines.push(`  - ${report.malformedGoalFiles.length} malformed goal file(s):`);
		for (const f of report.malformedGoalFiles) lines.push(`      ${f.relPath} — ${f.error}`);
	}
	if (report.malformedLedgerLines > 0) {
		lines.push(`  - ${report.malformedLedgerLines} malformed ledger line(s) (read-only; manual review advised)`);
	}
	if (report.staleLocks.length > 0) {
		lines.push(`  - ${report.staleLocks.length} stale lock(s):`);
		for (const l of report.staleLocks) lines.push(`      ${l.fileName} (pid ${l.pid}, ${Math.round(l.ageMs / 1000)}s old)`);
	}
	if (report.orphanedSnapshotGoals.length > 0) {
		lines.push(`  - ${report.orphanedSnapshotGoals.length} orphaned snapshot entr${report.orphanedSnapshotGoals.length === 1 ? "y" : "ies"}:`);
		for (const o of report.orphanedSnapshotGoals) lines.push(`      ${o.goalId} (${o.activePath})`);
	}
	if (report.staleLocks.length > 0 || report.orphanedSnapshotGoals.length > 0) {
		lines.push("Run `/goal-recovery repair` to remove stale locks and refresh the pool snapshot (confirmation + backup required).");
	}
	return lines.join("\n");
}
