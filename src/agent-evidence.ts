import type { AgentEvidence, AgentRecord } from "./types.js";

export function agentExecutionDetails(record: AgentRecord | undefined): { agent?: AgentEvidence } {
  if (!record?.invocationId || typeof record.draining !== "boolean") return {};
  return { agent: { id: record.id, invocationId: record.invocationId, status: record.status, draining: record.draining } };
}
