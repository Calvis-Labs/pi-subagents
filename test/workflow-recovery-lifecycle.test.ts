import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import * as runner from "../src/agent-runner.js";
import extension, { WORKFLOW_FILE_FLAG } from "../src/index.js";
import * as journal from "../src/workflow/journal.js";
import { WorkflowRecoveryStore } from "../src/workflow/recovery.js";
import * as runtime from "../src/workflow/runtime.js";
import { completeWorkflowTask, createWorkflowTask } from "../src/workflow/task.js";
import type * as worktree from "../src/worktree.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";
import { type BootedPi, ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async original => ({ ...await original<typeof runner>(), runAgent: vi.fn() }));
vi.mock("../src/worktree.js", async original => ({ ...await original<typeof worktree>(), createWorktree: vi.fn(), cleanupWorktree: vi.fn() }));

let env: Hermetic;
let boots: BootedPi[];
const script = 'export const meta = { name: "recovery", description: "offline" }; return await agent("effect");';
const meta = { name: "recovery", description: "offline" };
const id = "wf_123456abcdef";
const store = () => new WorkflowRecoveryStore(getAgentDir(), { cwd: process.cwd(), sessionId: "s1" });
async function boot(flags = {}, branch: unknown[] = []) {
  const value = makePi(flags);
  boots.push(value);
  extension(value.pi);
  await value.lifecycle.get("session_start")({}, ctx({ signal: new AbortController().signal, sessionManager: { getSessionId: () => "s1", getBranch: () => branch } }));
  return value;
}
const launch = (value: BootedPi, params = { script }) => value.tools.get("SubagentWorkflow").execute("wf", params, undefined, undefined, ctx());
const snapshot = (value: BootedPi) => value.pi.events.emit.mock.calls.filter((c: unknown[]) => c[0] === "subagents:workflow-progress:v1").at(-1)?.[1];

beforeEach(() => {
  env = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: true, defaultJoinMode: "group", outputTranscript: false } });
  boots = [];
  vi.clearAllMocks();
  vi.mocked(runner.runAgent).mockImplementation(() => new Promise(() => {}));
});
afterEach(async () => {
  for (const value of boots) await value.lifecycle.get("session_shutdown")?.();
  vi.restoreAllMocks();
  vi.useRealTimers();
  env.restore();
});

describe("offline extension recovery lifecycle", () => {
  const receipt = (taskId: string) => ({ type: "message", message: { role: "toolResult", toolName: "SubagentWorkflow", details: { taskId } } });

  it.each(["legacy", "lost-current"])("blocks fresh work for unresolved %s receipts even with an empty store", async kind => {
    if (kind === "lost-current") {
      store().save(createWorkflowTask({ id, script, meta }));
      rmSync(dirname(store().paths(id).recordPath), { recursive: true });
    }
    const run = vi.spyOn(runtime, "runWorkflow");
    const value = await boot({}, [receipt(id)]);
    expect(textOf(await launch(value))).toMatch(/blocked.*missing.*reconcile.*side effects/i);
    expect(run).not.toHaveBeenCalled();
    expect(value.pi.sendMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])("terminal historical receipts allow unrelated fresh work (batched=%s)", batched => {
    const notice = { id, status: "completed" };
    const branch = [receipt(id), { type: "custom_message", customType: "subagent-notification", details: batched ? { id: "other", status: "error", others: [notice] } : notice }];
    vi.spyOn(runtime, "runWorkflow").mockResolvedValue({ status: "completed", meta, progress: [], agentCount: 0, replayedCount: 0 });
    return boot({}, branch).then(async value => {
      expect((await launch(value)).details.taskId).toMatch(/^wf_/);
      await flush();
      expect(runtime.runWorkflow).toHaveBeenCalledTimes(1);
    });
  });

  it("a nonterminal notice does not resolve missing history", async () => {
    const run = vi.spyOn(runtime, "runWorkflow");
    const value = await boot({}, [receipt(id), { type: "custom_message", customType: "subagent-notification", details: { id, status: "running" } }]);
    expect(textOf(await launch(value))).toMatch(/blocked.*missing/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("blocks any fresh launch while a previous run drains", async () => {
    let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    const run = vi.spyOn(runtime, "runWorkflow").mockResolvedValue({ status: "failed", meta, drained, progress: [], agentCount: 0, replayedCount: 0 });
    const value = await boot();
    await launch(value);
    await flush();
    try {
      expect(textOf(await launch(value))).toMatch(/blocked.*drain/i);
      expect(run).toHaveBeenCalledTimes(1);
    } finally { release(); await flush(); }
    expect((await launch(value)).details.taskId).toMatch(/^wf_/);
  });

  it.each(["workflow", "standalone"])("reload fences uncooperative %s executions until actual drain", async kind => {
    let release!: (result: runner.RunResult) => void;
    vi.mocked(runner.runAgent).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = await boot();
    if (kind === "workflow") await launch(first);
    else await first.tools.get("Agent").execute("a", { prompt: "effect", description: "effect", subagent_type: "general-purpose" }, undefined, undefined, ctx());
    await vi.waitFor(() => expect(runner.runAgent).toHaveBeenCalledTimes(1));
    await first.lifecycle.get("session_shutdown")();
    const second = await boot();
    try {
      expect(textOf(await launch(second))).toMatch(/blocked.*drain/i);
      expect(runner.runAgent).toHaveBeenCalledTimes(1);
      if (kind === "workflow") expect(snapshot(second).workflows[0]).toMatchObject({ recoveryDisposition: "interrupted", draining: true });
    } finally {
      release({ responseText: "late", session: { dispose: vi.fn(), messages: [] } as never, aborted: false, steered: false });
      await flush();
    }
    if (kind === "workflow") {
      second.pi.events.emit("subagents:workflow-progress:request:v1", {});
      expect(textOf(await launch(second, { resumeFromRunId: snapshot(second).workflows[0].id } as never))).toMatch(/reconcile/i);
    }
    vi.mocked(runner.runAgent).mockResolvedValue({ responseText: "ok", session: { dispose: vi.fn(), messages: [] } as never, aborted: false, steered: false });
    expect((await launch(second)).details.taskId).toMatch(/^wf_/);
    await vi.waitFor(() => expect(snapshot(second).workflows.at(-1).status).toBe("completed"));
    expect(first.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("retains host-operation drain through reload even with no running child", async () => {
    let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    const reason = { code: "timeout" as const, deadlineAt: Date.now() };
    const run = vi.spyOn(runtime, "runWorkflow").mockResolvedValue({ status: "failed", meta, reason, drained, progress: [], agentCount: 0, replayedCount: 0 });
    const first = await boot();
    await launch(first);
    await flush();
    await first.lifecycle.get("session_shutdown")();
    const second = await boot();
    try {
      expect(snapshot(second).workflows[0]).toMatchObject({ draining: true, reason });
      expect(textOf(await launch(second))).toMatch(/blocked.*drain/i);
      expect(run).toHaveBeenCalledTimes(1);
    } finally { release(); await flush(); }
    expect(snapshot(second).workflows[0]).toMatchObject({ draining: false, reason });
    expect((await launch(second)).details.taskId).toMatch(/^wf_/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not backfill a running cancellation before logical settlement", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let release!: (result: runner.RunResult) => void;
    vi.mocked(runner.runAgent).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const spawn = vi.spyOn(AgentManager.prototype, "spawn");
    const value = await boot();
    const result = await value.tools.get("Agent").execute("a", {
      prompt: "work", description: "work", subagent_type: "general-purpose", timeout_seconds: 1,
    }, undefined, undefined, ctx());
    const manager = spawn.mock.instances[0];
    manager.abort(result.details.agentId);
    await value.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } });
    expect(value.pi.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await value.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } });
    expect(value.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(value.pi.sendMessage.mock.calls[0][0].content).toContain("Stopped");
    release({ responseText: "late", session: { dispose: vi.fn(), messages: [] } as never, aborted: false, steered: false });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(value.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])("does not backfill success before delayed cleanup settles (%s members)", async members => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let release!: (result: worktree.WorktreeCleanupResult) => void;
    vi.mocked(createWorktree).mockResolvedValue({ path: "/fake", workPath: "/fake", branch: "fake" } as never);
    vi.mocked(cleanupWorktree).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    vi.mocked(runner.runAgent).mockResolvedValue({ responseText: "success before cleanup", session: { dispose: vi.fn(), messages: [] } as never, aborted: false, steered: false });
    const value = await boot();
    for (let n = 0; n < members; n++) await value.tools.get("Agent").execute(`a${n}`, {
      prompt: "work", description: "work", subagent_type: "general-purpose", ...(n === 0 ? { isolation: "worktree", timeout_seconds: 1 } : {}),
    }, undefined, undefined, ctx());
    await flush();
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);
    await value.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } });
    expect(value.pi.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await value.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } });
    expect(value.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(value.pi.sendMessage.mock.calls[0][0].content).toContain("timed out");
    release({ hasChanges: false } as never);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await value.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } });
    expect(value.pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["running", "completed"])("restores %s observations with zero spawn or wake, suppressing the CLI flag", async status => {
    const task = createWorkflowTask({ id, script, meta });
    if (status === "completed") completeWorkflowTask(task, { status, meta, value: "kept", progress: [], agentCount: 0, replayedCount: 0 });
    store().save(task);
    const path = join(env.dir, "flag.js");
    writeFileSync(path, script);
    const run = vi.spyOn(runtime, "runWorkflow");
    const value = await boot({ [WORKFLOW_FILE_FLAG]: path });
    expect(snapshot(value).workflows[0]).toMatchObject({ id, status: status === "running" ? "failed" : "completed", recoveryDisposition: status === "running" ? "interrupted" : "terminal" });
    await value.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } });
    expect(run).not.toHaveBeenCalled();
    expect(runner.runAgent).not.toHaveBeenCalled();
    expect(value.pi.sendMessage).not.toHaveBeenCalled();
    const result = await launch(value, { resumeFromRunId: id } as never);
    expect(textOf(result)).toMatch(/reconcile.*fresh/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("persists admission, captured source and empty journal before the runtime starts, then fences old writes", async () => {
    let options!: runtime.RunWorkflowOptions;
    let finish!: (result: runtime.WorkflowRunResult) => void;
    const run = vi.spyOn(runtime, "runWorkflow").mockImplementation(input => {
      options = input;
      const [saved] = store().restore();
      expect(saved.script).toBe(script);
      expect(readFileSync(saved.journalPath!, "utf8")).toBe("");
      return new Promise(resolve => { finish = resolve; });
    });
    const first = await boot();
    const result = await launch(first);
    expect(run).toHaveBeenCalledTimes(1);
    const path = store().paths(result.details.taskId).recordPath;
    options.onProgress?.([{ type: "workflow_log", message: "checkpoint" }]);
    expect(JSON.parse(readFileSync(path, "utf8")).workflowProgress).toHaveLength(1);
    await first.lifecycle.get("session_shutdown")();
    const second = await boot();
    const before = readFileSync(path, "utf8");
    options.onProgress?.([{ type: "workflow_log", message: "late" }]);
    expect(() => options.journal?.append?.({ index: 0, key: "0".repeat(32), ok: true, text: "late" })).toThrow(/replaced|inactive/i);
    finish({ status: "completed", meta, progress: [], agentCount: 0, replayedCount: 0 });
    await flush();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(snapshot(second).workflows[0].recoveryDisposition).toBe("interrupted");
    expect(second.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("blocks corrupt recovery and admission write failure with zero runtime spawn", async () => {
    const value = await boot();
    const run = vi.spyOn(runtime, "runWorkflow");
    vi.spyOn(WorkflowRecoveryStore.prototype, "save").mockImplementation(() => { throw new Error("disk unavailable"); });
    expect(textOf(await launch(value))).toMatch(/blocked.*disk unavailable/i);
    expect(run).not.toHaveBeenCalled();
    expect(runner.runAgent).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    store().save(createWorkflowTask({ id, script, meta }));
    writeFileSync(store().paths(id).recordPath, "{");
    const next = await boot();
    const spy = vi.spyOn(runtime, "runWorkflow");
    expect(textOf(await launch(next))).toMatch(/blocked.*recovery/i);
    expect(spy).not.toHaveBeenCalled();
    expect(next.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("blocks replay until host drain and preserves the timeout reason in snapshots and checkpoints", async () => {
    let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    const reason = { code: "timeout" as const, deadlineAt: Date.now() };
    vi.spyOn(runtime, "runWorkflow").mockResolvedValue({ status: "failed", meta, reason, drained, progress: [], agentCount: 0, replayedCount: 0 });
    const value = await boot();
    const result = await launch(value);
    await flush();
    expect(snapshot(value).workflows[0]).toMatchObject({ draining: true, reason });
    expect(store().restore()[0].reason).toEqual(reason);
    expect(textOf(await launch(value, { resumeFromRunId: result.details.taskId } as never))).toMatch(/draining/i);
    release();
    await flush();
    expect(snapshot(value).workflows[0].draining).toBe(false);
  });

  it("checkpoints fresh CLI runs before runtime entry and suppresses reload even with no history", async () => {
    const path = join(env.dir, "flag.js");
    writeFileSync(path, script);
    const run = vi.spyOn(runtime, "runWorkflow").mockImplementation(async () => {
      expect(store().restore()[0].scriptPath).toBe(path);
      return { status: "completed", meta, progress: [], agentCount: 0, replayedCount: 0 };
    });
    await boot({ [WORKFLOW_FILE_FLAG]: path });
    expect(run).toHaveBeenCalledTimes(1);
    expect(store().restore()[0].status).toBe("completed");
    const reloaded = makePi({ [WORKFLOW_FILE_FLAG]: path });
    boots.push(reloaded);
    extension(reloaded.pi);
    await reloaded.lifecycle.get("session_start")({ reason: "reload" }, ctx({ sessionManager: { getSessionId: () => "new-owner", getBranch: () => [] } }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("strict append failure stops the next child and blocks further workflow admission", async () => {
    vi.mocked(runner.runAgent).mockResolvedValue({ responseText: "ok", session: { dispose: vi.fn(), messages: [] } as never, aborted: false, steered: false });
    vi.spyOn(journal, "appendJournal").mockImplementation(() => { throw new Error("journal unavailable"); });
    const value = await boot();
    await launch(value, { script: script.replace('return await agent("effect");', 'await agent("effect"); return await agent("next");') });
    await vi.waitFor(() => expect(snapshot(value).workflows[0].status).toBe("failed"));
    expect(runner.runAgent).toHaveBeenCalledTimes(1);
    expect(textOf(await launch(value))).toMatch(/blocked.*journal unavailable/i);
    expect(runner.runAgent).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])("refuses a valid journal truncated to %s acknowledged calls", async kept => {
    vi.mocked(runner.runAgent).mockResolvedValue({ responseText: "ok", session: { dispose: vi.fn(), messages: [] } as never, aborted: false, steered: false });
    const value = await boot();
    const result = await launch(value, { script: script.replace('return await agent("effect");', 'await agent("effect"); return await agent("next");') });
    await vi.waitFor(() => expect(snapshot(value).workflows[0]).toMatchObject({ status: "completed", draining: false }));
    const path = store().paths(result.details.taskId).journalPath;
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    writeFileSync(path, kept ? `${lines[0]}\n` : "");
    expect(textOf(await launch(value, { resumeFromRunId: result.details.taskId } as never))).toMatch(/integrity|acknowledged/i);
    expect(runner.runAgent).toHaveBeenCalledTimes(2);
    expect(() => store().restore()).toThrow(/integrity|acknowledged/i);
  });

  it("rejects schedule plus timeout instead of silently dropping it", async () => {
    const value = await boot();
    const result = await value.tools.get("Agent").execute("a", {
      prompt: "work", description: "work", subagent_type: "general-purpose", schedule: "+1h", timeout_seconds: 2,
    }, undefined, undefined, ctx());
    expect(textOf(result)).toMatch(/schedule.*timeout_seconds/);
    expect(runner.runAgent).not.toHaveBeenCalled();
  });

  it("holds group membership during startup timeout and notifies exactly once", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.mocked(createWorktree).mockImplementation(() => new Promise(() => {}));
    const value = await boot();
    let finish!: (result: runner.RunResult) => void;
    vi.mocked(runner.runAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await value.tools.get("Agent").execute("b", { prompt: "sibling", description: "sibling", subagent_type: "general-purpose" }, undefined, undefined, ctx());
    const pending = value.tools.get("Agent").execute("a", {
      prompt: "work", description: "work", subagent_type: "general-purpose", isolation: "worktree", timeout_seconds: 1,
    }, undefined, undefined, ctx());
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(value.pi.sendMessage).not.toHaveBeenCalled();
    await value.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(value.pi.sendMessage).not.toHaveBeenCalled();
    finish({ responseText: "ok", session: { dispose: vi.fn(), messages: [] } as never, aborted: false, steered: false });
    await vi.advanceTimersByTimeAsync(1000);
    await value.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } });
    expect(value.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(value.pi.sendMessage.mock.calls[0][0].content).toContain("timed out");
  });
});
