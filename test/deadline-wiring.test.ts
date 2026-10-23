import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runner from "../src/agent-runner.js";
import { runAgent } from "../src/agent-runner.js";
import extension, { WORKFLOW_FILE_FLAG } from "../src/index.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

vi.mock("../src/agent-runner.js", async importOriginal => ({
  ...await importOriginal<typeof runner>(), runAgent: vi.fn(),
}));
let env: Hermetic;
let boot: BootedPi;
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); });
afterEach(async () => {
  await boot?.lifecycle.get("session_shutdown")?.();
  env?.restore();
  vi.useRealTimers();
});
const script = 'export const meta = { name: "bounded", description: "probe" }; while (true) {}';

describe("deadline extension wiring", () => {
  it("applies the configured agent timeout, permits an override and notifies once", async () => {
    env = hermeticDir({ settings: { defaultAgentTimeoutSeconds: 2, maxConcurrentTotal: 1 } });
    boot = makePi();
    extension(boot.pi);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const tool = boot.tools.get("Agent");
    const context = ctx();
    await tool.execute("first", { prompt: "one", description: "one", subagent_type: "general-purpose" }, undefined, undefined, context);
    await tool.execute("queued", { prompt: "two", description: "two", subagent_type: "general-purpose", timeout_seconds: 1 }, undefined, undefined, context);
    await vi.advanceTimersByTimeAsync(1200);
    expect(boot.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(boot.pi.sendMessage.mock.calls[0][0].content).toContain("timed out after 1 seconds");
    await vi.advanceTimersByTimeAsync(1000);
    expect(boot.pi.sendMessage).toHaveBeenCalledTimes(2);
    expect(boot.pi.sendMessage.mock.calls[1][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it("wires the workflow tool override to the wall timer and outbox", async () => {
    env = hermeticDir({ settings: { defaultWorkflowTimeoutSeconds: 20 } });
    boot = makePi();
    extension(boot.pi);
    const result = await boot.tools.get("SubagentWorkflow").execute("wf", { script, timeoutSeconds: 1 }, undefined, undefined, ctx());
    expect(result.details.taskId).toMatch(/^wf_/);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(boot.pi.sendMessage).toHaveBeenCalledTimes(1));
    expect(boot.pi.sendMessage.mock.calls[0][0].content).toContain("timed out after 1 seconds");
    expect(boot.pi.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it("bounds CLI workflows using the workflow setting and wakes the parent", async () => {
    env = hermeticDir({ settings: { defaultWorkflowTimeoutSeconds: 1 } });
    const path = join(env.dir, "probe.js");
    writeFileSync(path, script);
    boot = makePi({ [WORKFLOW_FILE_FLAG]: path });
    extension(boot.pi);
    await boot.lifecycle.get("session_start")({}, ctx({ mode: "print" }));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(boot.pi.sendMessage).toHaveBeenCalledTimes(1));
    expect(boot.pi.sendMessage.mock.calls[0][0].content).toContain("timed out after 1 seconds");
    expect(boot.pi.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
  });
});
