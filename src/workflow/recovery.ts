import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { readJournal } from "./journal.js";
import type { WorkflowMeta } from "./meta.js";
import type { WorkflowEntry, WorkflowRunStatus } from "./progress.js";
import { createWorkflowTask, updateWorkflowProgressBatch, type WorkflowTask } from "./task.js";

export const MAX_RECOVERY_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 1000;
const RUN_ID = /^wf_[a-z0-9-]{6,80}$/;

export interface WorkflowRecoveryOwner {
  cwd: string;
  sessionId: string;
}

/** Plain observations only: no replay cache, listeners, worker or control handles. */
export interface WorkflowRecoveryRecord {
  version: 1;
  owner: WorkflowRecoveryOwner;
  id: string;
  script: string;
  scriptHash: string;
  scriptPath: string;
  originalScriptPath?: string;
  reason?: WorkflowTask["reason"];
  persistenceError?: string;
  journalPath: string;
  journalIntegrity: WorkflowTask["journalIntegrity"];
  args?: unknown;
  meta?: WorkflowMeta;
  workflowName?: string;
  toolCallId?: string;
  resumedFrom?: string;
  status: WorkflowRunStatus;
  disposition: "active" | "terminal" | "interrupted";
  savedAt: number;
  startTime: number;
  endTime?: number;
  pausedAt?: number;
  totalPausedMs: number;
  workflowProgress: WorkflowEntry[];
  progressVersion: number;
  agentCount: number;
  replayedCount: number;
  value?: unknown;
  error?: string;
}

export class WorkflowRecoveryError extends Error {}

function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) throw new WorkflowRecoveryError(`Invalid workflow recovery: ${message}`);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function missing(error: unknown): boolean {
  return object(error) && error.code === "ENOENT";
}

function privatePath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  requireState(!stat.isSymbolicLink(), `symbolic link at ${path}`);
  requireState(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, `unexpected file type at ${path}`);
  requireState((stat.mode & 0o077) === 0, `non-private permissions at ${path}`);
  requireState(process.getuid === undefined || stat.uid === process.getuid(), `wrong file owner at ${path}`);
}

function atomicWrite(path: string, content: string): void {
  try { privatePath(path, false); } catch (error) { if (!missing(error)) throw error; }
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    fd = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

function jsonText(value: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  function check(item: unknown, depth: number): void {
    bytes += typeof item === "string" ? Buffer.byteLength(item) : 8;
    requireState(bytes <= MAX_RECOVERY_BYTES, "JSON size limit exceeded");
    requireState(++nodes <= 100_000 && depth <= 64, "JSON complexity limit exceeded");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string") {
      requireState(Buffer.byteLength(item) <= MAX_RECOVERY_BYTES, "JSON string size limit exceeded");
      return;
    }
    if (typeof item === "number") { requireState(Number.isFinite(item), "non-finite JSON number"); return; }
    requireState(typeof item === "object" && item !== null, "non-JSON value");
    requireState(!ancestors.has(item), "circular JSON value");
    requireState(Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, "non-plain JSON object");
    requireState(Object.getOwnPropertySymbols(item).length === 0, "symbol JSON keys");
    ancestors.add(item);
    if (Array.isArray(item)) {
      requireState(item.length <= 100_000, "JSON array size limit exceeded");
      for (let index = 0; index < item.length; index++) check(item[index], depth + 1);
    } else {
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        bytes += Buffer.byteLength(key);
        requireState("value" in descriptor, "JSON accessor");
        check(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  }
  check(value, 0);
  const text = JSON.stringify(value);
  requireState(Buffer.byteLength(text) <= MAX_RECOVERY_BYTES, "record size limit exceeded");
  return text;
}

function validMeta(value: unknown): boolean {
  return object(value) && typeof value.name === "string" && value.name.trim() !== ""
    && typeof value.description === "string" && value.description.trim() !== ""
    && (value.whenToUse === undefined || typeof value.whenToUse === "string")
    && (value.phases === undefined || (Array.isArray(value.phases) && value.phases.length <= 4096 && value.phases.every(phase =>
      object(phase) && typeof phase.title === "string" && phase.title.trim() !== ""
      && (phase.detail === undefined || typeof phase.detail === "string") && (phase.model === undefined || typeof phase.model === "string"))));
}

function validProgress(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.type === "workflow_log") return typeof value.message === "string";
  if (!integer(value.index)) return false;
  if (value.type === "workflow_phase") return typeof value.title === "string";
  if (value.index >= 1000 || value.type !== "workflow_agent" || typeof value.label !== "string" || typeof value.state !== "string" || !["start", "progress", "done", "error"].includes(value.state)) return false;
  for (const key of ["phaseTitle", "agentId", "recordId", "agentType", "model", "modelId", "thinking", "requestedThinking", "requestedModel", "fallbackModel", "error", "promptPreview", "resultPreview"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  for (const key of ["phaseIndex", "queuedAt", "startedAt", "lastProgressAt", "attempt", "tokens", "toolCalls", "durationMs"]) {
    if (value[key] !== undefined && !integer(value[key])) return false;
  }
  for (const key of ["skipped", "blocked", "cached"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
  }
  return (value.isolation === undefined || value.isolation === "worktree")
    && (value.lastAttemptReason === undefined || (typeof value.lastAttemptReason === "string" && ["throttled", "user-retry", "stalled"].includes(value.lastAttemptReason)));
}

export const WORKFLOW_RECONCILIATION_TYPE = "subagents-workflow-reconciliation-v1";

export function missingWorkflowHistory(entries: readonly unknown[], tasks: ReadonlyMap<string, WorkflowTask>, owner?: WorkflowRecoveryOwner): string[] {
  const unresolved = new Set<string>();
  for (const entry of entries) {
    if (!object(entry)) continue;
    if (entry.type === "message" && object(entry.message) && entry.message.role === "toolResult" && entry.message.toolName === "SubagentWorkflow") {
      const details = entry.message.details;
      if (object(details) && typeof details.taskId === "string") unresolved.add(details.taskId);
    }
    if (owner && entry.type === "custom" && entry.customType === WORKFLOW_RECONCILIATION_TYPE && object(entry.data)) {
      const data = entry.data;
      if (data.version === 1 && data.sessionId === owner.sessionId && data.cwd === owner.cwd
        && typeof data.taskId === "string" && RUN_ID.test(data.taskId)
        && typeof data.note === "string" && data.note.trim() !== "" && integer(data.at)
        && data.disposition === "unknown-acknowledged") unresolved.delete(data.taskId);
    }
    if (entry.type === "custom_message" && entry.customType === "subagent-notification" && object(entry.details)) {
      for (const notice of [entry.details, ...(Array.isArray(entry.details.others) ? entry.details.others : [])]) {
        if (object(notice) && typeof notice.id === "string" && typeof notice.status === "string"
          && ["completed", "failed", "killed", "error", "stopped", "aborted", "steered"].includes(notice.status)) unresolved.delete(notice.id);
      }
    }
  }
  return [...unresolved].filter(id => !tasks.has(id));
}

export function assertWorkflowHistory(entries: readonly unknown[], tasks: ReadonlyMap<string, WorkflowTask>, owner?: WorkflowRecoveryOwner): void {
  const missing = missingWorkflowHistory(entries, tasks, owner);
  if (missing.length > 0) throw new WorkflowRecoveryError(`Workflow admission blocked: missing records for unresolved workflow receipts: ${missing.join(", ")}. Reconcile side effects, then use workflow_reconcile or /workflow-reconcile with user confirmation. Missing history is not proof nothing ran.`);
}

/** Pass getAgentDir() explicitly; construction and restore never start or wake work. */
export class WorkflowRecoveryStore {
  private readonly owner: WorkflowRecoveryOwner;
  private readonly root: string;
  private readonly directory: string;
  private readonly admitted = new Set<string>();

  constructor(agentDir: string, owner: WorkflowRecoveryOwner) {
    requireState(typeof owner.cwd === "string" && isAbsolute(owner.cwd) && owner.cwd.length <= 4096 && !owner.cwd.includes("\0"), "absolute owner cwd required");
    requireState(typeof owner.sessionId === "string" && owner.sessionId.trim().length > 0 && owner.sessionId.length <= 1024 && !owner.sessionId.includes("\0"), "exact session identity required");
    requireState(isAbsolute(agentDir), "absolute agent directory required");
    const canonicalAgentDir = realpathSync(agentDir);
    let applicationRoot = realpathSync(owner.cwd);
    for (let path = applicationRoot; ; path = dirname(path)) {
      if (existsSync(join(path, ".git"))) { applicationRoot = path; break; }
      if (dirname(path) === path) break;
    }
    this.root = join(canonicalAgentDir, "workflow-recovery");
    requireState(!inside(applicationRoot, this.root), "storage must be outside the application repository");
    this.owner = { cwd: realpathSync(owner.cwd), sessionId: owner.sessionId };
    this.directory = join(this.root, hash(JSON.stringify([this.owner.cwd, this.owner.sessionId])));
  }

  paths(id: string): { recordPath: string; scriptPath: string; journalPath: string } {
    requireState(RUN_ID.test(id), "invalid run id");
    return {
      recordPath: join(this.directory, `${id}.json`),
      scriptPath: join(this.directory, `${id}.workflow.js`),
      journalPath: join(this.directory, `${id}.workflow.jsonl`),
    };
  }

  private checkDirectory(create: boolean): void {
    for (const path of [this.root, this.directory]) {
      if (create) {
        try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (!object(error) || error.code !== "EEXIST") throw error; }
      }
      privatePath(path, true);
    }
  }

  private checkRecords(names: string[]): void {
    const expected = new Set(this.admitted);
    for (const name of names) {
      const artifact = /^(wf_[a-z0-9-]{6,80})\.workflow\.(?:js|jsonl)$/.exec(name);
      if (artifact) expected.add(artifact[1]);
    }
    for (const id of expected) requireState(names.includes(`${id}.json`), `orphan workflow ${id}: missing admission record`);
  }

  private validate(value: unknown, id: string): WorkflowRecoveryRecord {
    requireState(object(value), "record is not an object");
    requireState(value.version === 1 && value.id === id && RUN_ID.test(id), "record version/id mismatch");
    requireState(object(value.owner) && value.owner.cwd === this.owner.cwd && value.owner.sessionId === this.owner.sessionId, "owner identity mismatch");
    requireState(typeof value.script === "string" && value.script.length <= 524_288 && value.scriptHash === hash(value.script), "captured script/hash mismatch");
    const paths = this.paths(id);
    requireState(value.scriptPath === paths.scriptPath && value.journalPath === paths.journalPath, "paths escape the owned run");
    requireState(object(value.journalIntegrity) && integer(value.journalIntegrity.count) && value.journalIntegrity.count <= 1000
      && integer(value.journalIntegrity.bytes) && value.journalIntegrity.bytes <= MAX_RECOVERY_BYTES
      && typeof value.journalIntegrity.hash === "string" && /^[a-f0-9]{64}$/.test(value.journalIntegrity.hash), "invalid acknowledged journal integrity");
    requireState(typeof value.status === "string" && ["running", "paused", "completed", "failed", "killed"].includes(value.status), "invalid status");
    const active = value.status === "running" || value.status === "paused";
    requireState(active ? value.disposition === "active" : value.disposition === "terminal" || (value.disposition === "interrupted" && value.status === "failed"), "disposition/status mismatch");
    for (const key of ["savedAt", "startTime", "totalPausedMs", "progressVersion", "agentCount", "replayedCount"]) {
      requireState(integer(value[key]), `invalid ${key}`);
    }
    const savedAt = value.savedAt as number;
    const startTime = value.startTime as number;
    requireState(savedAt >= startTime, "saved timestamp precedes start");
    requireState(value.endTime === undefined || (integer(value.endTime) && value.endTime >= startTime && value.endTime <= savedAt), "invalid end timestamp");
    requireState(active ? value.endTime === undefined : value.endTime !== undefined, "end timestamp/status mismatch");
    requireState(value.status === "paused" ? integer(value.pausedAt) && value.pausedAt >= startTime && value.pausedAt <= savedAt : value.pausedAt === undefined, "pause timestamp/status mismatch");
    requireState((value.totalPausedMs as number) <= ((value.pausedAt ?? value.endTime ?? savedAt) as number) - startTime, "paused duration exceeds elapsed time");
    requireState((value.agentCount as number) <= 1000 && (value.replayedCount as number) <= (value.agentCount as number), "agent count limit exceeded");
    requireState(value.meta === undefined || validMeta(value.meta), "invalid metadata");
    requireState(Array.isArray(value.workflowProgress) && value.workflowProgress.length <= 20_000 && value.workflowProgress.every(validProgress), "invalid workflowProgress");
    requireState(value.reason === undefined || (object(value.reason) && value.reason.code === "timeout" && typeof value.reason.deadlineAt === "number" && Number.isFinite(value.reason.deadlineAt) && value.reason.deadlineAt >= 0), "invalid terminal reason");
    for (const key of ["workflowName", "toolCallId", "error", "persistenceError", "originalScriptPath"]) requireState(value[key] === undefined || typeof value[key] === "string", `invalid ${key}`);
    requireState(value.resumedFrom === undefined || (typeof value.resumedFrom === "string" && RUN_ID.test(value.resumedFrom)), "invalid resumedFrom");
    return value as unknown as WorkflowRecoveryRecord;
  }

  save(task: WorkflowTask, now = Date.now()): void {
    const paths = this.paths(task.id);
    requireState(typeof task.script === "string" && task.script.length <= 524_288, "script size limit exceeded");
    requireState(task.journalPath === undefined || task.journalPath === paths.journalPath, "journal path must belong to this store");
    const active = task.status === "running" || task.status === "paused";
    const record: WorkflowRecoveryRecord = {
      version: 1, owner: this.owner, id: task.id, script: task.script, scriptHash: hash(task.script),
      scriptPath: paths.scriptPath, journalPath: paths.journalPath, journalIntegrity: task.journalIntegrity,
      status: task.status, disposition: active ? "active" : task.recoveryDisposition ?? "terminal",
      savedAt: now, startTime: task.startTime, totalPausedMs: task.totalPausedMs,
      workflowProgress: task.workflowProgress, progressVersion: task.progressVersion,
      agentCount: task.agentCount, replayedCount: task.replayedCount,
      ...Object.fromEntries(Object.entries({ args: task.args, meta: task.meta, workflowName: task.workflowName, toolCallId: task.toolCallId, resumedFrom: task.resumedFrom, endTime: task.endTime, pausedAt: task.pausedAt, value: task.value, error: task.error, reason: task.reason, persistenceError: task.persistenceError, originalScriptPath: task.scriptPath }).filter(([, value]) => value !== undefined)),
    };
    const text = jsonText(record);
    this.validate(JSON.parse(text), task.id);
    this.checkDirectory(this.admitted.size === 0);
    const files = readdirSync(this.directory);
    this.checkRecords(files);
    const existing = this.admitted.has(task.id) || Object.values(paths).some(path => {
      try { lstatSync(path); return true; } catch (error) { if (!missing(error)) throw error; return false; }
    });
    if (existing) {
      for (const path of Object.values(paths)) {
        requireState(existsSync(path), `missing admitted artifact ${path}`);
        privatePath(path, false);
      }
    } else {
      requireState(files.filter(name => name.endsWith(".json")).length < MAX_RECORDS, "record count limit exceeded");
      this.admitted.add(task.id);
      atomicWrite(paths.scriptPath, task.script);
      atomicWrite(paths.journalPath, "");
    }
    readJournal(paths.journalPath, { strict: true, acknowledged: task.journalIntegrity });
    atomicWrite(paths.recordPath, text);
    this.admitted.add(task.id);
  }

  restore(): WorkflowTask[] {
    try { this.checkDirectory(false); } catch (error) { if (missing(error) && this.admitted.size === 0) return []; throw error; }
    const names = readdirSync(this.directory);
    const files = names.filter(name => name.endsWith(".json"));
    this.checkRecords(names);
    requireState(files.length <= MAX_RECORDS, "record count limit exceeded");
    return files.sort().map(file => {
      const id = file.slice(0, -5);
      const path = this.paths(id).recordPath;
      let fd: number | undefined;
      try {
        privatePath(path, false);
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        requireState(fstatSync(fd).size <= MAX_RECOVERY_BYTES, "record size limit exceeded");
        const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
        jsonText(value);
        const record = this.validate(value, id);
        for (const artifact of [record.scriptPath, record.journalPath]) {
          privatePath(artifact, false);
        }
        readJournal(record.journalPath, { strict: true, acknowledged: record.journalIntegrity });
        const restored = createWorkflowTask({
          id: record.id, script: record.script, scriptPath: record.originalScriptPath ?? record.scriptPath, journalPath: record.journalPath,
          args: record.args, meta: record.meta, toolCallId: record.toolCallId,
          resumedFrom: record.resumedFrom, startTime: record.startTime,
        });
        updateWorkflowProgressBatch(restored, record.workflowProgress);
        restored.journalIntegrity = { ...record.journalIntegrity };
        restored.progressVersion = record.progressVersion;
        restored.agentCount = Math.max(restored.agentCount, record.agentCount);
        restored.replayedCount = record.replayedCount;
        restored.workflowName = record.workflowName ?? record.meta?.name;
        restored.value = record.value;
        restored.reason = record.reason;
        restored.persistenceError = record.persistenceError;
        const interrupted = record.status === "running" || record.status === "paused";
        restored.status = interrupted ? "failed" : record.status;
        restored.recoveryDisposition = interrupted ? "interrupted" : record.disposition as "terminal" | "interrupted";
        restored.error = interrupted ? "Interrupted before completion; restored for observation only. No work was restarted." : record.error;
        restored.endTime = record.endTime ?? record.savedAt;
        restored.totalPausedMs = record.totalPausedMs + (record.pausedAt === undefined ? 0 : record.savedAt - record.pausedAt);
        restored.abortController.abort();
        this.admitted.add(id);
        return restored;
      } catch (error) {
        throw new WorkflowRecoveryError(`Cannot restore workflow recovery ${path}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    });
  }
}
