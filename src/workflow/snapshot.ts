import { buildWorkflowPhaseGroups, collapse, displayState, type WorkflowDisplayState, type WorkflowRunStatus } from "./progress.js";
import type { WorkflowTask } from "./task.js";

export const WORKFLOW_PROGRESS_CHANNEL = "subagents:workflow-progress:v1";
export const WORKFLOW_PROGRESS_REQUEST_CHANNEL = "subagents:workflow-progress:request:v1";

export type WorkflowPhaseState = "not-started" | "observed" | "queued" | "running" | "done" | "failed" | "interrupted";

export interface WorkflowProgressSnapshot {
  version: 1;
  sessionId: string;
  workflows: {
    id: string;
    name: string;
    status: WorkflowRunStatus;
    startTime: number;
    endTime?: number;
    reason?: WorkflowTask["reason"];
    recoveryDisposition?: WorkflowTask["recoveryDisposition"];
    draining: boolean;
    phases: { title: string; state: WorkflowPhaseState; done: number; total: number }[];
    agents: { index: number; label: string; state: WorkflowDisplayState; phaseTitle?: string }[];
    done: number;
    total: number;
    plannedTotal?: number;
  }[];
}

type WorkflowProjection = WorkflowProgressSnapshot["workflows"][number];
const projections = new WeakMap<WorkflowTask, {
  fingerprint: string;
  progress: WorkflowTask["workflowProgress"];
  value: WorkflowProjection;
}>();

/** Public, detached projection; never spread a task or progress entry onto the bus. */
export function workflowProgressSnapshot(sessionId: string, tasks: Iterable<WorkflowTask>): WorkflowProgressSnapshot {
  return {
    version: 1,
    sessionId,
    workflows: [...tasks].map(task => {
      // Progress is append-only; other projected fields can change without a batch.
      const fingerprint = JSON.stringify([
        task.progressVersion, task.workflowProgress.length, task.id,
        task.meta?.name ?? task.workflowName ?? task.id, task.status,
        task.startTime, task.endTime, task.agentCount, task.meta?.phases?.map(phase => phase.title), task.meta?.totalAgents,
        task.reason, task.recoveryDisposition, task.draining,
      ]);
      const cached = projections.get(task);
      if (cached?.fingerprint === fingerprint && cached.progress === task.workflowProgress) return cached.value;
      const active = task.status === "running" || task.status === "paused";
      const { agents, phaseTitles } = collapse(task.workflowProgress);
      const groups = buildWorkflowPhaseGroups(task.workflowProgress, task.meta?.phases);
      const groupTitles = new Map(groups.flatMap(group => group.agents.map(agent => [agent.index, group.title] as const)));
      const phases = groups.map(group => {
        const states = group.agents.map(agent => displayState(agent, active));
        const state: WorkflowPhaseState =
          states.length === 0 ? (group.status === "not-started" ? "not-started" : "observed")
          : states.includes("running") ? "running"
          : states.includes("queued") ? "queued"
          : states.includes("interrupted") ? "interrupted"
          : states.some(state => state === "failed" || state === "skipped" || state === "blocked") ? "failed"
          : "done";
        return { title: group.title, state, done: group.doneCount, total: group.totalCount };
      });
      const value: WorkflowProjection = {
        id: task.id,
        name: task.meta?.name ?? task.workflowName ?? task.id,
        status: task.status,
        startTime: task.startTime,
        ...(task.endTime !== undefined ? { endTime: task.endTime } : {}),
        ...(task.reason !== undefined ? { reason: { ...task.reason } } : {}),
        ...(task.recoveryDisposition !== undefined ? { recoveryDisposition: task.recoveryDisposition } : {}),
        draining: task.draining === true,
        phases,
        agents: agents.map(agent => {
          const phaseTitle = agent.phaseTitle ?? (agent.phaseIndex !== undefined ? phaseTitles.get(agent.phaseIndex) ?? groupTitles.get(agent.index) : undefined);
          return {
            index: agent.index,
            label: agent.label,
            state: displayState(agent, active),
            ...(phaseTitle !== undefined ? { phaseTitle } : {}),
          };
        }),
        done: agents.filter(agent => agent.state === "done").length,
        total: Math.max(task.agentCount, agents.length),
        ...(task.meta?.totalAgents !== undefined ? { plannedTotal: task.meta.totalAgents } : {}),
      };
      projections.set(task, { fingerprint, progress: task.workflowProgress, value });
      return value;
    }).map(workflow => ({
      ...workflow,
      ...(workflow.reason ? { reason: { ...workflow.reason } } : {}),
      phases: workflow.phases.map(phase => ({ ...phase })),
      agents: workflow.agents.map(agent => ({ ...agent })),
    })),
  };
}
