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
let contexts: Map<BootedPi, ReturnType<typeof ctx>>;
const script = 'export const meta = { name: "recovery", description: "offline" }; return await agent("effect");';
const meta = { name: "recovery", description: "offline" };
const id = "wf_123456abcdef";
const store = () => new WorkflowRecoveryStore(getAgentDir(), { cwd: process.cwd(), sessionId: "s1" });
async function boot(flags = {}, branch: unknown[] = []) {
  const value = makePi(flags);
  boots.push(value);
  extension(value.pi);
  const context = ctx({ signal: new AbortController().signal, sessionManager: { getSessionId: () => "s1", getBranch: () => branch } });
  contexts.set(value, context);
  value.pi.appendEntry.mockImplementation((customType: string, data: unknown) => branch.push({ type: "custom", customType, data }));
  await value.lifecycle.get("session_start")({}, context);
  return value;
}
const launch = (value: BootedPi, params = { script }) => value.tools.get("SubagentWorkflow").execute("wf", params, undefined, undefined, contexts.get(value));
const snapshot = (value: BootedPi) => value.pi.events.emit.mock.calls.filter((c: unknown[]) => c[0] === "subagents:workflow-progress:v1").at(-1)?.[1];

beforeEach(() => {
  env = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: true, defaultJoinMode: "group", outputTranscript: false } });
  boots = [];
  contexts = new Map();
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

  const reconciliationType = "subagents-workflow-reconciliation-v1";
  const reconciliationEvent = "subagents:workflow-reconciled:v1";
  const note = "Checked external effects; outcome remains unknown.";
  function interactive(value: BootedPi, confirmed = true) {
    const context = contexts.get(value)!;
    context.hasUI = true;
    context.ui.confirm = vi.fn().mockResolvedValue(confirmed);
    context.ui.input = vi.fn().mockResolvedValue(note);
    return context;
  }
  const reconcile = (value: BootedPi, taskId = id, reconciliationNote = note) =>
    value.tools.get("workflow_reconcile").execute("ack", { taskId, note: reconciliationNote }, undefined, undefined, contexts.get(value));

  it.each(["tool", "command"])("confirmed %s reconciliation admits fresh work in the same activation, never old replay", async surface => {
    const branch = [receipt(id)];
    const value = await boot({}, branch);
    const context = interactive(value);
    const run = vi.spyOn(runtime, "runWorkflow").mockResolvedValue({ status: "completed", meta, progress: [], agentCount: 0, replayedCount: 0 });
    expect(textOf(await launch(value))).toMatch(/blocked.*missing/i);
    if (surface === "tool") {
      const result = await reconcile(value);
      expect(result.details).toEqual({ taskId: id, disposition: "unknown-acknowledged" });
      expect(result.structuredContent).toEqual(result.details);
      expect(textOf(result)).toMatch(/unknown-acknowledged/);
    } else {
      await value.commands.get("workflow-reconcile").handler(id, context);
      expect(context.ui.input).toHaveBeenCalledTimes(1);
    }
    expect(context.ui.confirm).toHaveBeenCalledTimes(1);
    expect(value.pi.appendEntry).toHaveBeenCalledWith(reconciliationType, {
      version: 1, sessionId: "s1", cwd: process.cwd(), taskId: id, note, at: expect.any(Number), disposition: "unknown-acknowledged",
    });
    expect(value.pi.events.emit.mock.calls.slice(-2)).toEqual([
      [reconciliationEvent, { version: 1, sessionId: "s1", id }],
      ["subagents:workflow-progress:v1", expect.objectContaining({ workflows: [] })],
    ]);
    expect(store().restore()).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(runner.runAgent).not.toHaveBeenCalled();
    expect(value.pi.sendMessage).not.toHaveBeenCalled();
    expect(textOf(await launch(value, { resumeFromRunId: id } as never))).toMatch(/unknown history/i);
    expect((await launch(value)).details.taskId).toMatch(/^wf_/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["decline", "headless", "unknown", "blank-note", "session", "cwd", "corrupt", "persistence"])("denies %s reconciliation without append or launch", async reason => {
    const value = await boot({}, [receipt(id)]);
    const context = interactive(value, reason !== "decline");
    if (reason === "headless") context.hasUI = false;
    if (reason === "session") context.sessionManager.getSessionId = () => "foreign";
    if (reason === "cwd") context.cwd = getAgentDir();
    if (reason === "corrupt") {
      store().save(createWorkflowTask({ id: "wf_other123", script, meta }));
      writeFileSync(store().paths("wf_other123").recordPath, "{");
    }
    if (reason === "persistence") vi.spyOn(WorkflowRecoveryStore.prototype, "restore").mockImplementation(() => { throw new Error("disk unavailable"); });
    const result = await reconcile(value, reason === "unknown" ? "wf_unknown123" : id, reason === "blank-note" ? " " : note);
    expect(result.details.disposition).toBe("denied");
    expect(value.pi.appendEntry).not.toHaveBeenCalled();
    expect(value.pi.events.emit.mock.calls.some((c: unknown[]) => c[0] === reconciliationEvent)).toBe(false);
    expect(runner.runAgent).not.toHaveBeenCalled();
  });

  it.each(["before", "during"])('denies cancellation %s confirmation without recording acknowledgment', async when => {
    const value = await boot({}, [receipt(id)]);
    const context = interactive(value);
    const controller = new AbortController();
    if (when === "before") controller.abort();
    else context.ui.confirm = vi.fn(async () => { controller.abort(); return true; });
    const result = await value.tools.get("workflow_reconcile").execute("ack", { taskId: id, note }, controller.signal, undefined, context);
    expect(result.details.disposition).toBe("denied");
    expect(value.pi.appendEntry).not.toHaveBeenCalled();
    expect(textOf(await launch(value))).toMatch(/blocked.*missing/i);
  });

  it("keeps acknowledgments branch-ordered, owner-scoped and durable across reload, without clearing another ID", async () => {
    const other = "wf_other123";
    const branch: unknown[] = [receipt(id), receipt(other)];
    const first = await boot({}, branch);
    interactive(first);
    await reconcile(first);
    expect(textOf(await launch(first))).toContain(other);
    await first.lifecycle.get("session_shutdown")();
    const second = await boot({}, branch);
    interactive(second);
    expect((await reconcile(second)).details.disposition).toBe("denied");
    expect(textOf(await launch(second))).toContain(other);
    await reconcile(second, other);
    vi.spyOn(runtime, "runWorkflow").mockResolvedValue({ status: "completed", meta, progress: [], agentCount: 0, replayedCount: 0 });
    expect((await launch(second)).details.taskId).toMatch(/^wf_/);
    await flush();
    branch.push(receipt(id));
    expect(textOf(await launch(second))).toMatch(/blocked.*missing/i);
  });

  it.each(["sessionId", "cwd", "version", "note", "at", "disposition", "type", "before"])("ignores invalid or misplaced acknowledgment: %s", async invalid => {
    const data = { version: 1, sessionId: "s1", cwd: process.cwd(), taskId: id, note, at: Date.now(), disposition: "unknown-acknowledged" };
    const ack = { type: "custom", customType: reconciliationType, data };
    if (invalid === "type") ack.type = "custom_message";
    else if (invalid !== "before") Object.assign(data, { [invalid]: invalid === "at" ? -1 : invalid === "note" ? " " : "wrong" });
    const value = await boot({}, invalid === "before" ? [ack, receipt(id)] : [receipt(id), ack]);
    expect(textOf(await launch(value))).toMatch(/blocked.*missing/i);
  });

  it.each(["active", "draining", "old-activation"])("denies reconciliation with %s work and does not cancel unrelated work for missing history", async state => {
    let finish!: (result: runtime.WorkflowRunResult) => void;
    let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    const run = vi.spyOn(runtime, "runWorkflow").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const branch: unknown[] = [];
    let value = await boot({}, branch);
    await launch(value);
    branch.push(receipt(id));
    expect(textOf(await launch(value))).toMatch(/blocked.*missing/i);
    expect(run.mock.calls[0][0].signal?.aborted).toBe(false);
    if (state !== "active") {
      finish({ status: "failed", meta, drained, progress: [], agentCount: 0, replayedCount: 0 });
      await flush();
    }
    if (state === "old-activation") {
      await value.lifecycle.get("session_shutdown")();
      value = await boot({}, branch);
    }
    interactive(value);
    try {
      expect((await reconcile(value)).details.disposition).toBe("denied");
      expect(value.pi.appendEntry).not.toHaveBeenCalled();
    } finally {
      if (state === "active") finish({ status: "failed", meta, progress: [], agentCount: 0, replayedCount: 0 });
      release();
      await flush();
    }
  });

  it("latches append failure, emits no reconciliation and never admits work from an in-memory-only acknowledgment", async () => {
    const value = await boot({}, [receipt(id)]);
    interactive(value);
    value.pi.appendEntry.mockImplementation(() => { throw new Error("append unavailable"); });
    expect((await reconcile(value)).details.disposition).toBe("denied");
    expect(textOf(await launch(value))).toMatch(/blocked.*append unavailable/i);
    expect(value.pi.events.emit.mock.calls.some((c: unknown[]) => c[0] === reconciliationEvent)).toBe(false);
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
