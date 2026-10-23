import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import * as runner from "../src/agent-runner.js";
import extension from "../src/index.js";
import { type BootedPi, ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async original => ({ ...await original<typeof runner>(), runAgent: vi.fn(), resumeAgent: vi.fn() }));
let env: Hermetic;
let boots: BootedPi[];
const outcome = () => ({ responseText: "ok", session: { dispose: vi.fn(), messages: [] } as never, aborted: false, steered: false });
async function boot() {
  const value = makePi();
  boots.push(value);
  extension(value.pi);
  await value.lifecycle.get("session_start")({}, ctx());
  return value;
}
const launch = (value: BootedPi, extra = {}) => value.tools.get("Agent").execute("a", { prompt: "work", description: "work", subagent_type: "general-purpose", ...extra }, undefined, undefined, ctx());
const inspect = (value: BootedPi, id: string) => value.tools.get("get_subagent_result").execute("r", { agent_id: id }, undefined, undefined, ctx());
beforeEach(() => {
  env = hermeticDir({ settings: { schedulingEnabled: false, outputTranscript: false } });
  boots = [];
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(async () => {
  for (const value of boots) await value.lifecycle.get("session_shutdown")?.();
  vi.restoreAllMocks();
  vi.useRealTimers();
  env.restore();
});

it("reports timeout before and after physical drain, and blocks fresh replacement", async () => {
  let finish!: (result: runner.RunResult) => void;
  vi.mocked(runner.runAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const value = await boot();
  const receipt = await launch(value, { timeout_seconds: 1 });
  const id = receipt.details.agentId;
  await vi.advanceTimersByTimeAsync(1200);
  try {
    expect((await inspect(value, id)).details.agent).toEqual({ id, invocationId: expect.any(String), status: "error", draining: true });
    expect(receipt.details.agent).toEqual({ id, invocationId: expect.any(String), status: "running", draining: true });
    const notice = value.pi.sendMessage.mock.calls[0][0];
    expect(notice.details.agent).toMatchObject({ id, invocationId: receipt.details.agent.invocationId, draining: true });
    expect(value.pi.events.emit.mock.calls.find((call: unknown[]) => call[0] === "subagents:failed")[1]).toMatchObject({ invocationId: receipt.details.agent.invocationId, draining: true });
    await expect(launch(value)).rejects.toThrow(/drain/i);
  } finally { finish(outcome()); await flush(); }
  expect((await inspect(value, id)).details.agent).toMatchObject({ id, status: "error", draining: false });
});

it.each([true, false])("returns distinct invocation evidence on legitimate resume (background=%s)", async background => {
  vi.mocked(runner.runAgent).mockResolvedValue(outcome());
  vi.mocked(runner.resumeAgent).mockResolvedValue({ text: "continued" });
  const value = await boot();
  const first = await launch(value, { run_in_background: false });
  const next = await launch(value, { resume: first.details.agentId, run_in_background: background });
  expect(first.details.agent).toMatchObject({ id: first.details.agentId, invocationId: expect.any(String), status: "completed", draining: false });
  expect(next.details.agent).toMatchObject({ id: first.details.agentId, invocationId: expect.any(String) });
  expect(next.details.agent.invocationId).not.toBe(first.details.agent.invocationId);
});

it("blocks Agent admission in a replacement activation until old execution drains", async () => {
  let finish!: (result: runner.RunResult) => void;
  vi.mocked(runner.runAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = await boot();
  await launch(first);
  await first.lifecycle.get("session_shutdown")();
  const second = await boot();
  try { await expect(launch(second)).rejects.toThrow(/drain/i); }
  finally { finish(outcome()); await flush(); }
  vi.mocked(runner.runAgent).mockResolvedValue(outcome());
  expect((await launch(second)).details.agentId).toBeTruthy();
});

it("keeps each grouped notification's invocation identity", async () => {
  const finishes: ((result: runner.RunResult) => void)[] = [];
  vi.mocked(runner.runAgent).mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  const value = await boot();
  const first = await launch(value);
  const second = await launch(value);
  finishes.forEach(finish => { finish(outcome()); });
  await vi.advanceTimersByTimeAsync(200);
  const details = value.pi.sendMessage.mock.calls[0][0].details;
  const agents = [details, ...details.others].map(notice => notice.agent);
  expect(agents).toEqual([
    { ...first.details.agent, status: "completed", draining: false },
    { ...second.details.agent, status: "completed", draining: false },
  ]);
  expect(agents[0].invocationId).not.toBe(agents[1].invocationId);
});

it("does not claim cancellation drained based on completedAt", async () => {
  let finish!: (result: runner.RunResult) => void;
  vi.mocked(runner.runAgent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const spawn = vi.spyOn(AgentManager.prototype, "spawn");
  const value = await boot();
  const receipt = await launch(value);
  spawn.mock.instances[0].abort(receipt.details.agentId);
  try { expect((await inspect(value, receipt.details.agentId)).details.agent).toMatchObject({ status: "stopped", draining: true }); }
  finally { finish(outcome()); await flush(); }
  expect((await inspect(value, receipt.details.agentId)).details.agent).toMatchObject({ status: "stopped", draining: false });
});
