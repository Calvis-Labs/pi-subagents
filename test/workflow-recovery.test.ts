import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendJournal, journalKey } from "../src/workflow/journal.js";
import { elapsedMs } from "../src/workflow/progress.js";
import { MAX_RECOVERY_BYTES, WorkflowRecoveryStore } from "../src/workflow/recovery.js";
import { runWorkflow } from "../src/workflow/runtime.js";
import { completeWorkflowTask, createWorkflowTask, resolveResumeTarget, updateWorkflowProgressBatch } from "../src/workflow/task.js";

vi.mock("../src/workflow/runtime.js", () => ({ runWorkflow: vi.fn() }));

let dir: string;
let cwd: string;
let agentDir: string;
let store: WorkflowRecoveryStore;
const script = 'export const meta = { name: "probe", description: "test" }; return 1;';
const id = "wf_abcdef123456";
const task = () => createWorkflowTask({ id, script, startTime: 1000, args: { n: 1 }, meta: { name: "probe", description: "test" } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.setSystemTime(5000);
  dir = mkdtempSync(join(tmpdir(), "wf-recovery-"));
  cwd = join(dir, "app");
  agentDir = join(dir, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  store = new WorkflowRecoveryStore(agentDir, { cwd, sessionId: "exact-session" });
});
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe("observational recovery", () => {
  it("does not repeat a side effect after a crash before its checkpoint", async () => {
    const original = task();
    original.script = 'export const meta = { name: "probe", description: "test" }; return await agent("record-effect");';
    const effect = vi.fn(() => Promise.resolve({ ok: true, text: "side effect committed" }));
    const wake = vi.fn();
    original.onChange = wake;
    original.control = { pause: vi.fn(), resume: vi.fn(), isPaused: () => false, skip: vi.fn(), retry: vi.fn() };
    store.save(original);
    vi.mocked(runWorkflow).mockImplementation(async options => {
      await options.host.spawnAgent({ agentId: "child", index: 0, prompt: "record-effect", label: "effect", agentType: "scripted" });
      throw new Error("simulated crash before checkpoint");
    });
    await expect(runWorkflow({ script: original.script, host: { spawnAgent: effect, abortAgent: vi.fn() } })).rejects.toThrow("simulated crash");
    // The process disappears before the result/progress/journal is checkpointed.
    vi.setSystemTime(86_400_000);
    const [restored] = new WorkflowRecoveryStore(agentDir, { cwd, sessionId: "exact-session" }).restore();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(wake).not.toHaveBeenCalled();
    expect(restored.status).toBe("failed");
    expect(restored.recoveryDisposition).toBe("interrupted");
    expect(restored.error).toContain("Interrupted");
    expect(restored.control).toBeUndefined();
    expect(restored.onChange).toBeUndefined();
    expect(restored.replay).toBeUndefined();
    expect(restored.abortController.signal.aborted).toBe(true);
    expect(elapsedMs(restored, Date.now())).toBe(4000);
    vi.advanceTimersByTime(86_400_000);
    expect(elapsedMs(restored, Date.now())).toBe(4000);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(runWorkflow).toHaveBeenCalledTimes(1);
  });

  it("closes an outstanding pause at the saved timestamp", () => {
    const original = task();
    original.status = "paused";
    original.pausedAt = 3000;
    original.totalPausedMs = 500;
    store.save(original);
    vi.setSystemTime(99_000);
    const [restored] = store.restore();
    expect(restored.status).toBe("failed");
    expect(restored.pausedAt).toBeUndefined();
    expect(restored.totalPausedMs).toBe(2500);
    expect(elapsedMs(restored, Date.now())).toBe(1500);
    store.save(restored);
    expect(store.restore()[0].recoveryDisposition).toBe("interrupted");
    expect(elapsedMs(store.restore()[0], Date.now())).toBe(1500);
  });

  it("preserves terminal outcomes and reconstructs progress counters", () => {
    const original = task();
    updateWorkflowProgressBatch(original, [{ type: "workflow_agent", index: 0, label: "child", state: "done", tokens: 25, toolCalls: 2 }]);
    completeWorkflowTask(original, { status: "completed", meta: original.meta!, value: { answer: 42 }, progress: original.workflowProgress, agentCount: 1, replayedCount: 0 });
    store.save(original);
    const [restored] = store.restore();
    expect(restored).toMatchObject({ status: "completed", value: { answer: 42 }, doneCount: 1, totalTokens: 25, totalToolCalls: 2, args: { n: 1 }, script, meta: original.meta });
    expect(restored.recoveryDisposition).toBe("terminal");
    expect(restored.endTime).toBe(5000);
    expect(restored.workflowProgress).toEqual(original.workflowProgress);
  });

  it.each(["failed", "killed"] as const)("preserves a %s outcome without changing its error", status => {
    const original = task();
    completeWorkflowTask(original, { status, error: "original failure", meta: original.meta!, progress: [], agentCount: 0, replayedCount: 0 });
    store.save(original);
    vi.setSystemTime(100_000);
    expect(store.restore()[0]).toMatchObject({ status, error: "original failure", endTime: 5000, recoveryDisposition: "terminal" });
  });

  it("isolates exact sessions and cwd identities", () => {
    store.save(task());
    expect(new WorkflowRecoveryStore(agentDir, { cwd, sessionId: "exact-session " }).restore()).toEqual([]);
    const other = join(dir, "other-app");
    mkdirSync(other);
    expect(new WorkflowRecoveryStore(agentDir, { cwd: other, sessionId: "exact-session" }).restore()).toEqual([]);
    expect(store.restore()).toHaveLength(1);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("uses a versioned explicit schema and private atomic files", () => {
    const original = task();
    original.onChange = vi.fn();
    store.save(original);
    const paths = store.paths(id);
    const record = JSON.parse(readFileSync(paths.recordPath, "utf8"));
    expect(record.version).toBe(1);
    expect(record.owner).toEqual({ cwd: realpathSync(cwd), sessionId: "exact-session" });
    expect(record.scriptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.journalPath).toBe(paths.journalPath);
    expect(record.disposition).toBe("active");
    expect(record.abortController).toBeUndefined();
    expect(record.onChange).toBeUndefined();
    expect(statSync(paths.recordPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(paths.recordPath)).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(paths.recordPath)).some(name => name.endsWith(".tmp"))).toBe(false);
  });
});

describe("recovery admission", () => {
  it("canonicalizes symlink cwd identities", () => {
    const alias = join(dir, "alias");
    symlinkSync(cwd, alias);
    store.save(task());
    expect(new WorkflowRecoveryStore(agentDir, { cwd: alias, sessionId: "exact-session" }).restore()).toHaveLength(1);
  });

  it("refuses the 1001st checkpoint before creating artifacts but allows updates", () => {
    store.save(task());
    const directory = dirname(store.paths(id).recordPath);
    for (let n = 1; n < 1000; n++) writeFileSync(join(directory, `wf_${String(n).padStart(6, "0")}.json`), "{}", { mode: 0o600 });
    expect(() => store.save(task())).not.toThrow();
    const next = createWorkflowTask({ id: "wf_newrun", script });
    expect(() => store.save(next)).toThrow(/record count/i);
    expect(readdirSync(directory).filter(name => name.startsWith(next.id))).toEqual([]);
  });

  it.each(["terminal", "interrupted"] as const)("rejects %s observations as replay targets", recoveryDisposition => {
    const prior = task();
    prior.status = "failed";
    prior.recoveryDisposition = recoveryDisposition;
    prior.journalPath = store.paths(id).journalPath;
    expect(resolveResumeTarget(id, new Map([[id, prior]]))).toMatchObject({ ok: false, message: expect.stringMatching(/reconcile.*fresh/i) });
  });

  it("rejects draining tasks and carries timeout reasons through recovery and notification", () => {
    const prior = task();
    const reason = { code: "timeout" as const, deadlineAt: 5000 };
    completeWorkflowTask(prior, { status: "failed", reason, meta: prior.meta!, progress: [], agentCount: 0, replayedCount: 0 });
    prior.draining = true;
    prior.journalPath = store.paths(id).journalPath;
    expect(resolveResumeTarget(id, new Map([[id, prior]]))).toMatchObject({ ok: false, message: expect.stringMatching(/drain/i) });
    expect(prior.reason).toEqual(reason);
    store.save(prior);
    expect(store.restore()[0].reason).toEqual(reason);
  });
});

describe("invalid durable state", () => {
  it("accepts a zero-acknowledgement empty journal and verifies acknowledged contents on save", () => {
    const original = task();
    store.save(original);
    original.journalPath = store.paths(id).journalPath;
    original.status = "completed";
    original.endTime = Date.now();
    expect(resolveResumeTarget(id, new Map([[id, original]]))).toMatchObject({ ok: true, replay: [] });
    appendJournal(original.journalPath, { index: 0, key: journalKey({ prompt: "effect" }), ok: true, text: "kept" }, { durable: true, acknowledged: original.journalIntegrity });
    store.save(original);
    const recordBefore = readFileSync(store.paths(id).recordPath, "utf8");
    expect(original.journalIntegrity).toMatchObject({ count: 1, bytes: expect.any(Number), hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    writeFileSync(original.journalPath, readFileSync(original.journalPath, "utf8").replace("kept", "edit"));
    expect(() => store.save(original)).toThrow(/integrity/i);
    expect(readFileSync(store.paths(id).recordPath, "utf8")).toBe(recordBefore);
    expect(resolveResumeTarget(id, new Map([[id, original]]))).toMatchObject({ ok: false });
  });
  it.each(["recordPath", "scriptPath", "journalPath"] as const)("never recreates a lost existing %s on save", artifact => {
    const original = task();
    store.save(original);
    const path = store.paths(id)[artifact];
    rmSync(path);
    expect(() => store.save(original)).toThrow();
    expect(existsSync(path)).toBe(false);
    expect(() => new WorkflowRecoveryStore(agentDir, { cwd, sessionId: "exact-session" }).restore()).toThrow();
  });

  it("remembers admissions even if every artifact disappears", () => {
    const original = task();
    store.save(original);
    rmSync(dirname(store.paths(id).recordPath), { recursive: true });
    expect(() => store.save(original)).toThrow();
    expect(() => store.restore()).toThrow();
  });

  it.each(["scriptPath", "journalPath"] as const)("rejects orphan owned %s on restore and admission", artifact => {
    const path = store.paths(id)[artifact];
    mkdirSync(dirname(dirname(path)), { mode: 0o700 });
    mkdirSync(dirname(path), { mode: 0o700 });
    writeFileSync(path, "", { mode: 0o600 });
    expect(() => store.restore()).toThrow(/missing.*record|orphan/i);
    expect(() => store.save(task())).toThrow(/missing|orphan/i);
  });

  it("does not describe an unknown resume ID as proof nothing ran", () => {
    const result = resolveResumeTarget(id, new Map());
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/unknown.*interrupted.*reconcile.*side effects/i) });
    expect(result?.ok === false && result.message).not.toMatch(/nothing has run|call this without/i);
  });

  it.each([
    ["version", 99], ["owner", { cwd: "/wrong", sessionId: "exact-session" }],
    ["scriptHash", "0".repeat(64)], ["journalPath", "/outside/run.jsonl"],
    ["status", "invented"], ["workflowProgress", [{ type: "workflow_agent", index: 0, label: "x", state: ["done"] }]], ["workflowProgress", [{ type: "workflow_agent", index: 0, label: "x", state: "invented" }]],
    ["savedAt", -1], ["agentCount", "one"], ["disposition", "terminal"],
  ])("rejects corrupt %s instead of a fresh run", (key, value) => {
    store.save(task());
    const path = store.paths(id).recordPath;
    const record = JSON.parse(readFileSync(path, "utf8"));
    record[key] = value;
    writeFileSync(path, JSON.stringify(record));
    expect(() => store.restore()).toThrow(/recovery/i);
  });

  it("rejects torn JSON and oversized files visibly", () => {
    store.save(task());
    const path = store.paths(id).recordPath;
    writeFileSync(path, "{");
    expect(() => store.restore()).toThrow(/recovery/i);
    writeFileSync(path, " ".repeat(MAX_RECOVERY_BYTES + 1));
    expect(() => store.restore()).toThrow(/limit|large/i);
  });

  it("rejects traversal, invalid session identity and storage inside the application", () => {
    expect(() => store.paths("../../escape")).toThrow();
    expect(() => new WorkflowRecoveryStore(agentDir, { cwd, sessionId: "" })).toThrow();
    expect(() => new WorkflowRecoveryStore(cwd, { cwd, sessionId: "x" })).toThrow();
  });

  it("rejects symlinked records and session directories", () => {
    store.save(task());
    const path = store.paths(id).recordPath;
    const external = join(dir, "external.json");
    writeFileSync(external, readFileSync(path));
    rmSync(path);
    symlinkSync(external, path);
    expect(() => store.restore()).toThrow(/symbolic|symlink/i);
    rmSync(dirname(path), { recursive: true });
    symlinkSync(cwd, dirname(path));
    expect(() => store.save(task())).toThrow(/symbolic|symlink/i);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("does not hydrate executable or replay handles from extra record properties", () => {
    store.save(task());
    const path = store.paths(id).recordPath;
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.replay = [{ index: 0, key: "unsafe", ok: true, text: "injected" }];
    record.control = { resume: "not a controller" };
    record.abortController = { signal: { aborted: false } };
    writeFileSync(path, JSON.stringify(record));
    const [restored] = store.restore();
    expect(restored.replay).toBeUndefined();
    expect(restored.control).toBeUndefined();
    expect(restored.abortController.signal.aborted).toBe(true);
  });

  it("fails visibly if a journal is moved outside the private store", () => {
    const original = task();
    original.journalPath = join(cwd, "journal.jsonl");
    expect(() => store.save(original)).toThrow(/journal path/i);
  });

  it("rejects oversized/non-JSON inputs without replacing the last good checkpoint", () => {
    store.save(task());
    const path = store.paths(id).recordPath;
    const before = readFileSync(path, "utf8");
    const original = task();
    original.args = { bad: BigInt(1) };
    expect(() => store.save(original)).toThrow();
    original.args = "x".repeat(MAX_RECOVERY_BYTES + 1);
    expect(() => store.save(original)).toThrow();
    original.args = undefined;
    original.script = "x".repeat(524_289);
    expect(() => store.save(original)).toThrow(/script size/i);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
