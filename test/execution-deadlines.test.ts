import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { type RunResult, resumeAgent, runAgent } from "../src/agent-runner.js";
import { CompletionOutbox } from "../src/completion-outbox.js";
import { createWorktree } from "../src/worktree.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(), cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(), isWorktreeIsolationEnabled: () => true,
}));
const pi = {} as ExtensionAPI;
const ctx = { cwd: "/tmp" } as ExtensionContext;
const session = { dispose: vi.fn(), messages: [] } as unknown as AgentSession;
const outcome = { responseText: "late", session, aborted: false, steered: false };
let manager: AgentManager;
let outbox: CompletionOutbox | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); });
afterEach(async () => { outbox?.dispose(); outbox = undefined; await manager?.dispose(); vi.useRealTimers(); });
const spawn = (options: Partial<Parameters<AgentManager["spawn"]>[4]> = {}) =>
  manager.spawn(pi, ctx, "general-purpose", "work", { description: "work", isBackground: true, ...options });

describe("acceptance deadlines and physical capacity", () => {
  it("wakes the parent once with partial output even when the runner ignores abort", async () => {
    const send = vi.fn();
    outbox = new CompletionOutbox(send, () => false);
    manager = new AgentManager(record => outbox!.add({ ids: [record.id], build: () => ({
      content: record.error!, details: { id: record.id, description: record.description, status: record.status,
        toolUses: 0, turnCount: 0, totalTokens: 0, durationMs: 1200000, resultPreview: record.result ?? "" },
    }) }));
    let finish!: (value: RunResult) => void;
    vi.mocked(runAgent).mockImplementation((_c, _t, _p, options) => {
      options.onTextDelta?.("partial", "partial");
      options.onSessionCreated?.(session);
      return new Promise(resolve => { finish = resolve; });
    });
    const id = spawn();
    await vi.advanceTimersByTimeAsync(1200000);
    expect(manager.getRecord(id)).toMatchObject({ status: "error", terminalReason: { code: "timeout" }, result: "partial" });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("partial");
    await vi.advanceTimersByTimeAsync(200);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(manager.resume(id, "unsafe")).resolves.toBeUndefined();
    finish(outcome);
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.getRecord(id)?.status).toBe("error");
    expect(manager.getRecord(id)?.result).toBe("partial");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["abort", "timeout"])("recursively cancels descendants on %s before parents drain", async action => {
    manager = new AgentManager();
    manager.setMaxConcurrentTotal(3);
    const finishes: ((value: RunResult) => void)[] = [];
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
    const root = spawn({ timeoutSeconds: 1, workflowId: "wf_owner" });
    const child = spawn({ parentAgentId: root, timeoutSeconds: 60 });
    const grandchild = spawn({ parentAgentId: child, timeoutSeconds: 60 });
    if (action === "abort") manager.abort(root);
    else await vi.advanceTimersByTimeAsync(1000);
    expect(manager.getRecord(child)?.abortController?.signal.aborted).toBe(true);
    expect(manager.getRecord(grandchild)?.abortController?.signal.aborted).toBe(true);
    expect(() => spawn()).toThrow(/draining/i);
    let drained = false;
    void manager.waitForWorkflowDrain("wf_owner").then(() => { drained = true; });
    finishes[0](outcome);
    finishes[1](outcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    finishes[2](outcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(true);
  });

  it("expires queued agents from acceptance, without starting them", async () => {
    const complete = vi.fn();
    manager = new AgentManager(complete, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    spawn({ timeoutSeconds: 60 });
    const id = spawn({ timeoutSeconds: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.getRecord(id)).toMatchObject({ status: "error", terminalReason: { code: "timeout" } });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("bounds startup waits, but holds the aggregate slot until startup drains", async () => {
    manager = new AgentManager();
    manager.setMaxConcurrentTotal(1);
    let finish!: () => void;
    vi.mocked(createWorktree).mockImplementation(() => new Promise(resolve => { finish = () => resolve(undefined); }));
    vi.mocked(runAgent).mockResolvedValue(outcome);
    const id = spawn({ isolation: "worktree", timeoutSeconds: 1 });
    const startup = manager.awaitStartup(id);
    const queued = spawn({ bypassQueue: true });
    await vi.advanceTimersByTimeAsync(1000);
    await startup;
    expect(manager.getRecord(id)?.status).toBe("error");
    expect(manager.getRecord(queued)?.status).toBe("queued");
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getRecord(queued)?.status).toBe("completed");
  });

  it("does not release an uncooperative execution's aggregate slot", async () => {
    manager = new AgentManager();
    manager.setMaxConcurrentTotal(1);
    let finish!: (value: RunResult) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(outcome);
    const id = spawn({ timeoutSeconds: 1 });
    const queued = spawn({ bypassQueue: true, isBackground: false });
    await vi.advanceTimersByTimeAsync(1000);
    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeDefined();
    expect(manager.getRecord(queued)?.status).toBe("queued");
    expect(() => spawn({ parentAgentId: id })).toThrow(/capacity/i);
    finish(outcome);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getRecord(queued)?.status).toBe("completed");
  });

  it("keeps the same deadline through foreground/background handoff", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const waiting = manager.spawnAndWait(pi, ctx, "general-purpose", "work", { description: "work", timeoutSeconds: 2 });
    const id = manager.listAgents()[0].id;
    await vi.advanceTimersByTimeAsync(1500);
    expect(manager.sendToBackground(id)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect((await waiting).record.status).toBe("error");
  });

  it("gives resumes a fresh bounded invocation and fences late resume output", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue(outcome);
    const id = spawn();
    await manager.getRecord(id)!.promise;
    vi.mocked(resumeAgent).mockImplementation((_s, _p, options) => {
      options.onTextDelta?.("new partial", "new partial");
      return new Promise(() => {});
    });
    const resumed = manager.resume(id, "again", undefined, { timeoutSeconds: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await resumed).toMatchObject({ status: "error", result: "new partial", terminalReason: { code: "timeout" } });
    await expect(manager.resume(id, "again")).resolves.toBeUndefined();
  });

  it("retains workflow children through pause-length idle time then gives a normal retention window", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue(outcome);
    manager.retainWorkflow("wf_owner");
    const id = spawn({ workflowId: "wf_owner" });
    await manager.getRecord(id)!.promise;
    await vi.advanceTimersByTimeAsync(1800000);
    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeDefined();
    vi.mocked(resumeAgent).mockResolvedValue({ text: "continued" });
    expect(await manager.resume(id, "continue workflow")).toMatchObject({ status: "completed", result: "continued" });
    manager.releaseWorkflow("wf_owner");
    await vi.advanceTimersByTimeAsync(600000);
    expect(manager.getRecord(id)).toBeDefined();
    await vi.advanceTimersByTimeAsync(60000);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("bounds a queued foreground caller after it enters an uncooperative startup", async () => {
    manager = new AgentManager();
    manager.setMaxConcurrentTotal(1);
    let finish!: (value: RunResult) => void;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    spawn();
    vi.mocked(createWorktree).mockImplementation(() => new Promise(() => {}));
    let settled = false;
    void manager.spawnAndWait(pi, ctx, "general-purpose", "work", {
      description: "queued", isolation: "worktree", timeoutSeconds: 1,
    }).then(() => { settled = true; });
    finish(outcome);
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(true);
  });

  it("shares the aggregate cap across resumed, foreground, workflow and nested paths", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue(outcome);
    const resumable = spawn();
    await manager.getRecord(resumable)!.promise;
    manager.setMaxConcurrentTotal(2);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const parent = spawn({ workflowId: "wf_owner" });
    spawn({ parentAgentId: parent, bypassQueue: true });
    vi.mocked(resumeAgent).mockClear();
    const resumed = await manager.resume(resumable, "later", undefined, { isBackground: true, timeoutSeconds: 1 });
    expect(resumed?.status).toBe("queued");
    expect(resumeAgent).not.toHaveBeenCalled();
    const foreground = spawn({ isBackground: false, bypassQueue: true });
    expect(manager.getRecord(foreground)?.status).toBe("queued");
    expect(() => spawn({ parentAgentId: parent })).toThrow(/capacity/);
    await vi.advanceTimersByTimeAsync(1000);
    expect(resumed?.terminalReason?.code).toBe("timeout");
  });

  it("distinguishes user cancellation from timeout for an uncooperative run", async () => {
    const complete = vi.fn();
    manager = new AgentManager(complete);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = spawn({ timeoutSeconds: 1 });
    manager.abort(id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.getRecord(id)).toMatchObject({ status: "stopped", terminalReason: { code: "cancelled" } });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 1025])("rejects aggregate capacity %s", value => {
    manager = new AgentManager();
    expect(() => manager.setMaxConcurrentTotal(value)).toThrow(/concurrency/i);
  });

  it.each([0, -1, NaN, Infinity, 86401])("rejects timeout %s before admission", value => {
    manager = new AgentManager();
    expect(() => spawn({ timeoutSeconds: value })).toThrow(/timeout/i);
    expect(manager.listAgents()).toHaveLength(0);
  });
});
