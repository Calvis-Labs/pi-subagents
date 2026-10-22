import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInChildSessionContext } from "../src/child-context.js";
import subagentsExtension, { WORKFLOW_FILE_FLAG } from "../src/index.js";
import type { RunWorkflowOptions, WorkflowRunResult } from "../src/workflow/runtime.js";
import * as runtime from "../src/workflow/runtime.js";
import * as tasks from "../src/workflow/task.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const CHANNEL = "subagents:workflow-progress:v1";
const REQUEST = "subagents:workflow-progress:request:v1";
const meta = { name: "audit", description: "private description", phases: [{ title: "Scan" }, { title: "Unseen" }] };
const script = `export const meta = ${JSON.stringify(meta)}; return "private result";`;

describe("workflow progress EventBus snapshots", () => {
  let hermetic: Hermetic;
  let boot: ReturnType<typeof makePi>;
  let context: ReturnType<typeof ctx>;
  let listeners: Map<string, Set<(data: unknown) => void>>;
  let runs: { options: RunWorkflowOptions; resolve: (result: WorkflowRunResult) => void; reject: (error: Error) => void }[];
  let created: tasks.WorkflowTask[];

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: true } });
    boot = makePi();
    context = ctx();
    listeners = new Map();
    boot.pi.events.on.mockImplementation((event: string, handler: (data: unknown) => void) => {
      const handlers = listeners.get(event) ?? new Set();
      listeners.set(event, handlers);
      handlers.add(handler);
      return () => handlers.delete(handler);
    });
    boot.pi.events.emit.mockImplementation((event: string, data: unknown) => {
      for (const handler of listeners.get(event) ?? []) handler(data);
    });
    runs = [];
    created = [];
    const create = tasks.createWorkflowTask;
    vi.spyOn(tasks, "createWorkflowTask").mockImplementation(init => {
      const task = create(init);
      created.push(task);
      return task;
    });
    vi.spyOn(runtime, "runWorkflow").mockImplementation(options => new Promise((resolve, reject) => {
      runs.push({ options, resolve, reject });
      options.onControl?.({ pause() {}, resume() {}, isPaused: () => false, skip: () => true, retry: () => true });
    }));
  });

  afterEach(async () => {
    await boot.lifecycle.get("session_shutdown")?.({}, context);
    for (const run of runs) run.resolve({ status: "killed", meta, progress: [], agentCount: 0, replayedCount: 0 });
    await flush();
    vi.restoreAllMocks();
    hermetic.restore();
  });

  const snapshots = () => boot.pi.events.emit.mock.calls.filter((call: unknown[]) => call[0] === CHANNEL).map((call: unknown[]) => call[1]);
  const latest = () => snapshots().at(-1);
  const start = async () => {
    subagentsExtension(boot.pi);
    await boot.lifecycle.get("session_start")({}, context);
  };
  const launch = () => boot.tools.get("SubagentWorkflow").execute("tc", { script }, undefined, undefined, context);

  it("registers only when bound, answers once per request, and unregisters on shutdown", async () => {
    subagentsExtension(boot.pi);
    expect(listeners.has(REQUEST)).toBe(false);
    boot.pi.events.emit(REQUEST, {});
    expect(snapshots()).toEqual([]);
    const readySnapshot = vi.fn();
    boot.pi.events.on("subagents:ready", () => {
      boot.pi.events.emit(REQUEST, {});
      readySnapshot(latest());
    });
    await boot.lifecycle.get("session_start")({}, context);
    await boot.lifecycle.get("session_start")({}, context);
    expect(readySnapshot).toHaveBeenCalledWith({ version: 1, sessionId: "s1", workflows: [] });
    expect(listeners.get(REQUEST)?.size).toBe(1);
    boot.pi.events.emit.mockClear();
    boot.pi.events.emit(REQUEST, {});
    expect(snapshots()).toEqual([{ version: 1, sessionId: "s1", workflows: [] }]);
    await boot.lifecycle.get("session_shutdown")({}, context);
    expect(latest()).toEqual({ version: 1, sessionId: "s1", workflows: [] });
    boot.pi.events.emit.mockClear();
    boot.pi.events.emit(REQUEST, {});
    expect(snapshots()).toEqual([]);
  });

  it("publishes creation, collapsed progress, fresh requests, pause/resume and terminal snapshots", async () => {
    await start();
    await launch();
    const task = created[0];
    expect(latest()).toEqual({ version: 1, sessionId: "s1", workflows: [{
      id: task.id, name: "audit", status: "running", startTime: task.startTime,
      phases: [{ title: "Scan", state: "not-started", done: 0, total: 0 }, { title: "Unseen", state: "not-started", done: 0, total: 0 }],
      agents: [], done: 0, total: 0,
    }] });
    runs[0].options.onProgress?.([{ type: "workflow_phase", index: 1, title: "Scan" }]);
    expect(latest().workflows[0].phases[0]).toEqual({ title: "Scan", state: "observed", done: 0, total: 0 });
    const entry = { type: "workflow_agent" as const, index: 0, label: "scan", phaseIndex: 1, phaseTitle: "Scan", state: "start" as const, queuedAt: 1, promptPreview: "private prompt", resultPreview: "private answer" };
    runs[0].options.onProgress?.([entry]);
    expect(latest().workflows[0].agents).toEqual([{ index: 0, label: "scan", state: "queued", phaseTitle: "Scan" }]);
    expect(latest().workflows[0].phases[0].state).toBe("queued");
    const queued = latest();
    runs[0].options.onProgress?.([{ ...entry, startedAt: 2 }]);
    expect(latest().workflows[0].phases[0].state).toBe("running");
    expect(queued.workflows[0].agents[0].state).toBe("queued");
    tasks.pauseWorkflowTask(task);
    expect(latest().workflows[0].status).toBe("paused");
    expect(latest().workflows[0].agents[0].state).toBe("running");
    tasks.resumeWorkflowTask(task);
    expect(latest().workflows[0].status).toBe("running");
    const beforeBatch = snapshots().length;
    runs[0].options.onProgress?.([{ ...entry, state: "progress" }, { ...entry, state: "done" }]);
    expect(snapshots().length).toBe(beforeBatch + 1);
    runs[0].options.onProgress?.([]);
    expect(snapshots().length).toBe(beforeBatch + 1);
    runs[0].resolve({ status: "completed", meta, progress: [], agentCount: 1, replayedCount: 0, value: "private result" });
    await flush();
    expect(latest().workflows[0]).toMatchObject({ status: "completed", done: 1, total: 1, endTime: expect.any(Number) });
    expect(latest().workflows[0].phases).toEqual([{ title: "Scan", state: "done", done: 1, total: 1 }, { title: "Unseen", state: "not-started", done: 0, total: 0 }]);
    expect(JSON.stringify(latest())).not.toContain("private");
    latest().workflows[0].agents[0].label = "tampered";
    latest().workflows.length = 0;
    boot.pi.events.emit(REQUEST, {});
    expect(latest().workflows[0].agents[0].label).toBe("scan");
  });

  it("publishes full multi-run snapshots for failures and kills, then clears without late resurrection", async () => {
    await start();
    await launch();
    await launch();
    runs[0].reject(new Error("private failure"));
    runs[1].options.onProgress?.([{ type: "workflow_agent", index: 0, label: "pending", state: "start", queuedAt: 1 }]);
    runs[1].resolve({ status: "killed", meta, progress: [], agentCount: 1, replayedCount: 0 });
    await flush();
    expect(latest().workflows.map((w: { status: string }) => w.status)).toEqual(["failed", "killed"]);
    expect(latest().workflows[1].agents[0].state).toBe("interrupted");
    expect(latest().workflows[1].phases.at(-1).state).toBe("interrupted");
    await launch();
    await boot.lifecycle.get("session_shutdown")({}, context);
    expect(latest().workflows).toEqual([]);
    expect(created[2].abortController.signal.aborted).toBe(true);
    const count = snapshots().length;
    await boot.lifecycle.get("session_start")({}, ctx({ sessionManager: { getSessionId: () => "s2" } }));
    runs[2].options.onProgress?.([{ type: "workflow_log", message: "late" }]);
    runs[2].resolve({ status: "completed", meta, progress: [], agentCount: 0, replayedCount: 0 });
    await flush();
    expect(snapshots().length).toBe(count + 1);
    expect(latest()).toEqual({ version: 1, sessionId: "s2", workflows: [] });
  });

  it("clears the previous session if startup rebinds without shutdown", async () => {
    await start();
    await launch();
    const count = snapshots().length;
    await boot.lifecycle.get("session_start")({}, ctx({ sessionManager: { getSessionId: () => "s2" } }));
    expect(snapshots().slice(count)).toEqual([
      { version: 1, sessionId: "s1", workflows: [] },
      { version: 1, sessionId: "s2", workflows: [] },
    ]);
    expect(created[0].abortController.signal.aborted).toBe(true);
    expect(listeners.get(REQUEST)?.size).toBe(1);
  });

  it.each(["shutdown", "replacement"])("drops pending and queued completions on %s", async boundary => {
    await start();
    await launch();
    await launch();
    runs[0].resolve({ status: "completed", meta, progress: [], agentCount: 0, replayedCount: 0, value: "queued secret" });
    await flush();
    expect(boot.pi.sendMessage).not.toHaveBeenCalled();
    boot.pi.events.on(CHANNEL, () => {
      if (latest().workflows.length === 0) boot.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } });
    });
    if (boundary === "shutdown") await boot.lifecycle.get("session_shutdown")({}, context);
    context = ctx({ sessionManager: { getSessionId: () => "s2" } });
    await boot.lifecycle.get("session_start")({}, context);
    runs[1].resolve({ status: "completed", meta, progress: [], agentCount: 0, replayedCount: 0, value: "pending secret" });
    await flush();
    await boot.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } });
    expect(boot.pi.sendMessage).not.toHaveBeenCalled();
    await launch();
    runs[2].resolve({ status: "completed", meta, progress: [], agentCount: 0, replayedCount: 0, value: "current result" });
    await flush();
    await boot.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } });
    expect(boot.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(boot.pi.sendMessage.mock.calls[0][0].content).toContain("current result");
  });

  it.each(["shutdown", "replacement", "current"])("scopes CLI completion transcript writes to %s", async boundary => {
    const path = join(hermetic.dir, "workflow.js");
    writeFileSync(path, script);
    boot.pi.getFlag.mockReturnValue(path);
    await start();
    if (boundary === "shutdown") await boot.lifecycle.get("session_shutdown")({}, context);
    if (boundary !== "current") await boot.lifecycle.get("session_start")({}, ctx({ sessionManager: { getSessionId: () => "s2" } }));
    runs[0].resolve({ status: "completed", meta, progress: [], agentCount: 0, replayedCount: 0, value: "CLI result" });
    await flush();
    expect(boot.pi.appendEntry).toHaveBeenCalledTimes(boundary === "current" ? 1 : 0);
    expect(boot.pi.sendMessage).toHaveBeenCalledTimes(boundary === "current" ? 1 : 0);
  });

  it("publishes flag-created workflows and never activates in a child context", async () => {
    const path = join(hermetic.dir, "workflow.js");
    writeFileSync(path, script);
    boot.pi.getFlag.mockImplementation((name: string) => name === WORKFLOW_FILE_FLAG ? path : undefined);
    await start();
    expect(latest().workflows[0].name).toBe("audit");
    const child = makePi();
    child.pi.events = boot.pi.events;
    const count = snapshots().length;
    await runInChildSessionContext(async () => subagentsExtension(child.pi));
    expect(child.lifecycle.size).toBe(0);
    expect(listeners.get(REQUEST)?.size).toBe(1);
    expect(snapshots().length).toBe(count);
  });
});
