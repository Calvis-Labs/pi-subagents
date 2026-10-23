import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { runWorkflow, type WorkflowHost } from "../src/workflow/runtime.js";

const script = 'export const meta = { name: "deadline", description: "probe" };\n';
afterEach(() => vi.useRealTimers());

describe("workflow wall deadlines", () => {
  it("terminates a non-yielding worker at the default wall deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const host: WorkflowHost = { spawnAgent: vi.fn(), abortAgent: vi.fn(), abort: vi.fn() };
    const pending = runWorkflow({ script: script + "while (true) {}", host, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(3600000);
    // A test-side cancellation prevents a red run from leaving an infinite worker behind.
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: "failed", reason: { code: "timeout" } });
    expect(host.abort).toHaveBeenCalled();
  });

  it("pause cannot reset or suspend a deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const host: WorkflowHost = { spawnAgent: vi.fn(), abortAgent: vi.fn() };
    const pending = runWorkflow({ script: script + 'await agent("held");', host, signal: controller.signal,
      timeoutSeconds: 2, onControl: control => control.pause() });
    await vi.advanceTimersByTimeAsync(2000);
    controller.abort();
    expect(await pending).toMatchObject({ status: "failed", reason: { code: "timeout" } });
    expect(host.spawnAgent).not.toHaveBeenCalled();
  });

  it("aborts a gate through the real host and ignores its late completion", async () => {
    vi.useFakeTimers();
    const manager = new AgentManager();
    let signal: AbortSignal | undefined;
    let finish!: (value: { stdout: string; stderr: string; code: number; killed: boolean }) => void;
    const exec = vi.fn<ExtensionAPI["exec"]>((_command, _args, options) => {
      signal = options?.signal;
      return new Promise(resolve => { finish = resolve; });
    });
    const host = createWorkflowHost({ pi: { exec } as unknown as ExtensionAPI, ctx: { cwd: "/tmp" } as ExtensionContext, manager });
    host.spawnAgent = vi.fn(async () => ({ ok: true, text: "partial" }));
    const progress = vi.fn();
    const pending = runWorkflow({ script: script + 'return await agent("work", { gate: "probe" });', host, timeoutSeconds: 10, onProgress: progress });
    try {
      await vi.waitFor(() => expect(exec).toHaveBeenCalled(), { timeout: 2000 });
      await vi.advanceTimersByTimeAsync(10000);
      const result = await pending;
      expect(result).toMatchObject({ status: "failed", reason: { code: "timeout" } });
      expect(signal?.aborted).toBe(true);
      expect(result.drained).toBeInstanceOf(Promise);
      let drained = false;
      void result.drained!.then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(false);
      const calls = progress.mock.calls.length;
      finish({ stdout: "late", stderr: "", code: 0, killed: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(progress).toHaveBeenCalledTimes(calls);
      expect(result.status).toBe("failed");
      await result.drained;
      expect(drained).toBe(true);
    } finally {
      host.abort?.();
      host.dispose?.();
      await manager.dispose();
    }
  });

  it("journal failure stops queued admission and fails the run without an unhandled rejection", async () => {
    const host: WorkflowHost = { spawnAgent: vi.fn(async () => ({ ok: true, text: "done" })), abortAgent: vi.fn() };
    const result = await runWorkflow({
      script: script + 'return await parallel([() => agent("first"), () => agent("must not start")]);',
      host, concurrency: 1, timeoutSeconds: 0.2,
      journal: { append() { throw new Error("checkpoint unavailable"); } },
    });
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("checkpoint unavailable") });
    expect(host.spawnAgent).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, NaN, Infinity, 86401])("rejects timeout %s before launching", async timeoutSeconds => {
    const host: WorkflowHost = { spawnAgent: vi.fn(), abortAgent: vi.fn() };
    await expect(runWorkflow({ script: script + "return 1;", host, timeoutSeconds })).rejects.toThrow(/timeout/i);
  });
});
