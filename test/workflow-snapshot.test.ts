import { describe, expect, it, vi } from "vitest";
import { initialWorkflowDialogState, resolveWorkflowDialog } from "../src/ui/workflow-dialog.js";
import type { WorkflowAgentEntry, WorkflowRunStatus } from "../src/workflow/progress.js";
import * as progress from "../src/workflow/progress.js";
import { workflowProgressSnapshot } from "../src/workflow/snapshot.js";
import { createWorkflowTask, updateWorkflowProgressBatch } from "../src/workflow/task.js";

const agent = (index: number, fields: Partial<WorkflowAgentEntry> = {}): WorkflowAgentEntry => ({
  type: "workflow_agent", index, label: `agent-${index}`, state: "start", ...fields,
});

describe("workflow snapshot projection", () => {
  it("projects a planned total before scheduling without inventing agents or changing known counts", () => {
    const task = createWorkflowTask({ id: "wf_planned", script: "", meta: { name: "six", description: "d", totalAgents: 6 } });
    const snapshot = () => workflowProgressSnapshot("s", [task]).workflows[0];
    expect(snapshot()).toMatchObject({ plannedTotal: 6, done: 0, total: 0, agents: [] });
    for (let index = 0; index < 7; index++) {
      updateWorkflowProgressBatch(task, [agent(index)]);
      expect(snapshot()).toMatchObject({ plannedTotal: 6, done: index, total: index + 1 });
      updateWorkflowProgressBatch(task, [agent(index, { state: "done" })]);
    }
    expect(snapshot()).toMatchObject({ plannedTotal: 6, done: 7, total: 7 });
    task.meta!.totalAgents = 8;
    expect(snapshot().plannedTotal).toBe(8);
    task.meta!.totalAgents = 0;
    expect(snapshot().plannedTotal).toBe(0);
    delete task.meta!.totalAgents;
    expect(snapshot()).not.toHaveProperty("plannedTotal");
  });

  it("projects only changed tasks and returns detached cached rows", () => {
    const tasks = Array.from({ length: 50 }, (_, index) => createWorkflowTask({ id: `wf_${index}`, script: "" }));
    for (const task of tasks) updateWorkflowProgressBatch(task, [agent(0)]);
    const project = vi.spyOn(progress, "buildWorkflowPhaseGroups");
    try {
      const first = workflowProgressSnapshot("s1", tasks);
      expect(project).toHaveBeenCalledTimes(50);
      project.mockClear();
      first.workflows[0].agents[0].label = "poison";
      first.workflows[0].phases.push({ title: "poison", state: "done", done: 1, total: 1 });
      first.workflows[0].name = "poison";
      const next = workflowProgressSnapshot("s2", tasks);
      expect(next.sessionId).toBe("s2");
      expect(next.workflows[0]).toMatchObject({ name: "wf_0", agents: [{ label: "agent-0" }], phases: [] });
      expect(project).not.toHaveBeenCalled();
      updateWorkflowProgressBatch(tasks[49], [agent(0, { state: "done" })]);
      expect(workflowProgressSnapshot("s2", tasks).workflows[49].done).toBe(1);
      expect(project).toHaveBeenCalledTimes(1);
    } finally { project.mockRestore(); }
  });

  it("invalidates for lifecycle, names, metadata, scheduled counts and progress replacement", () => {
    const task = createWorkflowTask({ id: "wf_cache", script: "" });
    updateWorkflowProgressBatch(task, [agent(0)]);
    const snapshot = () => workflowProgressSnapshot("s", [task]).workflows[0];
    expect(snapshot().agents[0].state).toBe("running");
    task.status = "paused";
    expect(snapshot().status).toBe("paused");
    task.status = "killed";
    task.endTime = 12;
    task.startTime = 2;
    task.agentCount = 9;
    task.workflowName = "renamed";
    expect(snapshot()).toMatchObject({ status: "killed", startTime: 2, endTime: 12, total: 9, name: "renamed", agents: [{ state: "interrupted" }] });
    task.meta = { name: "meta name", description: "d", phases: [{ title: "First" }] };
    expect(snapshot()).toMatchObject({ name: "meta name", phases: [{ title: "First" }, { title: "Ungrouped agents" }] });
    task.meta.name = "edited";
    task.meta.phases![0].title = "Second";
    expect(snapshot()).toMatchObject({ name: "edited", phases: [{ title: "Second" }, { title: "Ungrouped agents" }] });
    task.workflowProgress = [agent(0, { state: "done" })];
    expect(snapshot().done).toBe(1);
    task.workflowProgress.push(agent(1, { state: "done" }));
    expect(snapshot().done).toBe(2);
    task.endTime = undefined;
    expect(snapshot()).not.toHaveProperty("endTime");
  });

  it.each(["empty", "title-only", "mixed"])("agrees with inspector grouping for %s phases", kind => {
    const task = createWorkflowTask({ id: "wf_parity1", script: "secret", meta: {
      name: "parity", description: "d", phases: [{ title: "Scan files" }, { title: "Never" }],
    } });
    updateWorkflowProgressBatch(task, [
      { type: "workflow_phase", index: 0, title: "Scan" },
      ...(kind === "empty" ? [] : [agent(0, { phaseTitle: "Scan", state: "done", recordId: "record", promptPreview: "prompt" })]),
      ...(kind === "mixed" ? [agent(1, { phaseIndex: 0 }), agent(2)] : []),
    ]);
    const view = resolveWorkflowDialog({ progress: task.workflowProgress, task, meta: task.meta, state: initialWorkflowDialogState() });
    expect(view.groups.map(group => ({ title: group.title, done: group.doneCount, total: group.totalCount }))).toEqual(
      workflowProgressSnapshot("s1", [task]).workflows[0].phases.map(({ title, done, total }) => ({ title, done, total })),
    );
    if (kind !== "empty") expect(view.groups[0].agents[0]).toMatchObject({ recordId: "record", promptPreview: "prompt" });
  });

  it.each<WorkflowRunStatus>(["running", "paused", "completed", "failed", "killed"])("uses displayState and collapsed counts when %s", status => {
    const task = createWorkflowTask({ id: "wf_test123", script: "secret" });
    updateWorkflowProgressBatch(task, [
      agent(0), agent(0, { state: "done", cached: true }),
      agent(1, { state: "error" }), agent(2, { state: "error", skipped: true }),
      agent(3, { state: "error", blocked: true }), agent(4, { queuedAt: 1 }),
      agent(5, { queuedAt: 1, startedAt: 2 }),
    ]);
    task.status = status;
    task.agentCount = 9;
    const workflow = workflowProgressSnapshot("s1", [task]).workflows[0];
    const active = status === "running" || status === "paused";
    expect(workflow.agents.map(a => a.state)).toEqual([
      "done", "failed", "skipped", "blocked", active ? "queued" : "interrupted", active ? "running" : "interrupted",
    ]);
    expect(workflow).toMatchObject({ name: task.id, done: 1, total: 9 });
    expect(workflow.phases).toEqual([]);
    expect(workflow.agents).toHaveLength(6);
    expect(workflow).not.toHaveProperty("endTime");
    expect(workflow.agents[0]).not.toHaveProperty("phaseTitle");
  });

  it("preserves a declared phase actually named Agents", () => {
    const task = createWorkflowTask({ id: "wf_test123", script: "secret", meta: {
      name: "phases", description: "secret", phases: [{ title: "Agents" }],
    } });
    expect(workflowProgressSnapshot("s1", [task]).workflows[0].phases).toEqual([
      { title: "Agents", state: "not-started", done: 0, total: 0 },
    ]);
  });

  it.each([true, false])("keeps mixed unphased children separate from phase index zero (declared=%s)", declared => {
    const task = createWorkflowTask({ id: "wf_test123", script: "secret", meta: {
      name: "phases", description: "secret", ...(declared ? { phases: [{ title: "Agents" }, { title: "Never" }] } : {}),
    } });
    updateWorkflowProgressBatch(task, [
      { type: "workflow_phase", index: 0, title: "Agents" },
      agent(0, { state: "done" }),
      agent(1, { phaseIndex: 0, state: "error" }),
      agent(2, { queuedAt: 1 }),
    ]);
    const workflow = workflowProgressSnapshot("s1", [task]).workflows[0];
    expect(workflow.phases).toEqual([
      { title: "Agents", state: "failed", done: 0, total: 1 },
      ...(declared ? [{ title: "Never", state: "not-started", done: 0, total: 0 }] : []),
      { title: "Ungrouped agents", state: "queued", done: 1, total: 2 },
    ]);
    expect(workflow).toMatchObject({ done: 1, total: 3 });
    expect(workflow.agents).toHaveLength(3);
    expect(workflow.phases.reduce((n, phase) => n + phase.total, 0)).toBe(3);
    expect(workflow.phases.reduce((n, phase) => n + phase.done, 0)).toBe(1);
    expect(workflow.agents[0]).not.toHaveProperty("phaseTitle");
  });

  it("keeps declared-only phases and all six ungrouped children", () => {
    const task = createWorkflowTask({ id: "wf_test123", script: "secret", meta: {
      name: "phases", description: "secret", phases: [{ title: "Never" }],
    } });
    updateWorkflowProgressBatch(task, Array.from({ length: 6 }, (_, index) => agent(index)));
    const workflow = workflowProgressSnapshot("s1", [task]).workflows[0];
    expect(workflow.phases).toEqual([
      { title: "Never", state: "not-started", done: 0, total: 0 },
      { title: "Ungrouped agents", state: "running", done: 0, total: 6 },
    ]);
    expect(workflow.agents).toHaveLength(6);
  });

  it("retains the inferred phase title for index-only children", () => {
    const task = createWorkflowTask({ id: "wf_test123", script: "secret" });
    updateWorkflowProgressBatch(task, [agent(0, { phaseIndex: 7 })]);
    expect(workflowProgressSnapshot("s1", [task]).workflows[0].agents[0].phaseTitle).toBe("Phase 7");
  });

  it("recognizes agent phase assignments without a phase event", () => {
    const task = createWorkflowTask({ id: "wf_test123", script: "secret" });
    updateWorkflowProgressBatch(task, [
      agent(0, { phaseIndex: 0, phaseTitle: "Agents", state: "done" }),
      agent(1, { phaseTitle: "Title only", state: "done" }),
      agent(2),
    ]);
    expect(workflowProgressSnapshot("s1", [task]).workflows[0].phases).toEqual([
      { title: "Agents", state: "done", done: 1, total: 1 },
      { title: "Title only", state: "done", done: 1, total: 1 },
      { title: "Ungrouped agents", state: "running", done: 0, total: 1 },
    ]);
  });

  it("reconciles empty phase activity with declarations without inventing completion", () => {
    const task = createWorkflowTask({ id: "wf_test123", script: "secret", meta: {
      name: "phases", description: "secret", phases: [{ title: "Scan files" }, { title: "Never" }],
    } });
    updateWorkflowProgressBatch(task, [
      { type: "workflow_phase", index: 2, title: "Scan" },
      { type: "workflow_phase", index: 3, title: "Undeclared" },
      { type: "workflow_phase", index: 3, title: "Undeclared" },
    ]);
    task.status = "completed";
    expect(workflowProgressSnapshot("s1", [task]).workflows[0].phases).toEqual([
      { title: "Scan", state: "observed", done: 0, total: 0 },
      { title: "Never", state: "not-started", done: 0, total: 0 },
      { title: "Undeclared", state: "observed", done: 0, total: 0 },
    ]);
    updateWorkflowProgressBatch(task, [agent(0, { phaseIndex: 2, state: "done" })]);
    expect(workflowProgressSnapshot("s1", [task]).workflows[0].agents[0].phaseTitle).toBe("Scan");
  });

  it.each(["failed", "skipped", "blocked"])("rolls settled %s children up to phase failed", state => {
    const task = createWorkflowTask({ id: "wf_test123", script: "secret" });
    updateWorkflowProgressBatch(task, [
      { type: "workflow_phase", index: 0, title: "Agents" },
      agent(0, { phaseIndex: 0, state: "error", skipped: state === "skipped", blocked: state === "blocked" }),
    ]);
    expect(workflowProgressSnapshot("s1", [task]).workflows[0].phases).toEqual([
      { title: "Agents", state: "failed", done: 0, total: 1 },
    ]);
  });
});
