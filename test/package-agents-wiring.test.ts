// Boots the REAL extension (src/index.ts) against a pi package that declares
// subagents, so the wiring between pi's settings, `session_start`'s project-trust
// read, and the `Agent` tool's type list is exercised end to end.
//
// The unit tests cover discovery and precedence directly; what only shows up
// here is the ordering problem the extension actually has — agents are
// registered at activation, hundreds of lines before any context exists, so the
// trust answer that decides whether a project's `packages[]` is visible arrives
// afterwards.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAllTypes } from "../src/agent-types.js";
import { resetPackageState } from "../src/package-resources.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const AGENT = "---\nname: pkg-researcher\ndescription: From a package\ntools: read, grep\n---\nYou research.\n";

describe("package-provided agents, wired through the extension", () => {
  let env: Hermetic;
  let booted: BootedPi;

  beforeEach(() => {
    resetPackageState();
  });

  afterEach(() => {
    env?.restore();
    resetPackageState();
    vi.restoreAllMocks();
  });

  /** Build a package on disk under the hermetic dir and return its root. */
  function makePackage(name = "demo-subagents"): string {
    const root = join(env.dir, "packages", name);
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        pi: { subagents: { agents: ["./agents"], workflows: ["./workflows"] } },
      }),
    );
    writeFileSync(join(root, "agents", "pkg-researcher.md"), AGENT);
    writeFileSync(
      join(root, "workflows", "pkg-flow.js"),
      "export const meta = { name: 'pkg-flow', description: 'shipped in a package' }\nreturn 'ok'\n",
    );
    return root;
  }

  /** Write pi's own settings (not ours) at the given scope. */
  function writePiSettings(scope: "user" | "project", packages: string[]): void {
    const path = scope === "user"
      ? join(process.env.PI_CODING_AGENT_DIR as string, "settings.json")
      : join(env.dir, ".pi", "settings.json");
    mkdirSync(join(path, "..").toString(), { recursive: true });
    writeFileSync(path, JSON.stringify({ packages }));
  }

  /** Activate the extension, without starting a session. */
  async function activate(): Promise<void> {
    booted = makePi();
    const factory = (await import("../src/index.js")).default;
    factory(booted.pi);
  }

  /** Activate the extension and run its `session_start` handler. */
  async function boot(projectTrusted: boolean): Promise<void> {
    await activate();
    await booted.lifecycle.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      ctx({ isProjectTrusted: () => projectTrusted }),
    );
  }

  it("registers an agent from a package in pi's user settings", async () => {
    env = hermeticDir();
    writePiSettings("user", [makePackage()]);

    await boot(false);
    expect(getAllTypes()).toContain("pkg-researcher");
  });

  it("offers it to the model in the Agent tool's type list", async () => {
    env = hermeticDir();
    writePiSettings("user", [makePackage()]);

    await boot(false);
    const agentTool = booted.tools.get("Agent");
    const spec = JSON.stringify(agentTool?.description ?? "") + JSON.stringify(agentTool?.parameters ?? {});
    expect(spec).toContain("pkg-researcher");
  });

  it("does not register one from an untrusted project's settings", async () => {
    env = hermeticDir();
    writePiSettings("project", [makePackage()]);

    await boot(false);
    expect(getAllTypes()).not.toContain("pkg-researcher");
  });

  it("registers one from a trusted project's settings, after session_start", async () => {
    env = hermeticDir();
    writePiSettings("project", [makePackage()]);

    // Activation runs before any context exists, so the trust answer only
    // arrives with `session_start` — the agent must appear on that reload, not
    // stay missing until the next `Agent` call.
    await boot(true);
    expect(getAllTypes()).toContain("pkg-researcher");
  });

  it("honours packageAgents: false from our own settings", async () => {
    env = hermeticDir({ settings: { packageAgents: false } });
    writePiSettings("user", [makePackage()]);

    await boot(false);
    expect(getAllTypes()).not.toContain("pkg-researcher");
  });

  it("honours an allowlist that names a different package", async () => {
    env = hermeticDir({ settings: { packageAgents: ["something-else"] } });
    writePiSettings("user", [makePackage()]);

    await boot(false);
    expect(getAllTypes()).not.toContain("pkg-researcher");
  });

  it("honours an allowlist that names this package by its short name", async () => {
    env = hermeticDir({ settings: { packageAgents: ["demo-subagents"] } });
    writePiSettings("user", [makePackage()]);

    await boot(false);
    expect(getAllTypes()).toContain("pkg-researcher");
  });

  // The gates are read from settings twice: once directly at boot, and again
  // through `applyAndEmitLoaded`'s appliers. The second read is too late for the
  // registration that happens at activation, which is what these two pin.
  describe("the gate applies to the activation-time load, not just the first session", () => {
    it("keeps package agents out of the registry before any session starts", async () => {
      env = hermeticDir({ settings: { packageAgents: false } });
      writePiSettings("user", [makePackage()]);

      await activate();
      expect(getAllTypes()).not.toContain("pkg-researcher");
    });

    it("does not abort a strict activation over a package file it was told to ignore", async () => {
      // `strictAgentFiles` makes an unparseable agent file throw at activation,
      // by design — a checked-in `.pi/agents/` should fail loudly. A package the
      // user switched off is not theirs to fix, so it must not be read at all.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        env = hermeticDir({ settings: { strictAgentFiles: true, packageAgents: false } });
        const root = makePackage();
        writeFileSync(join(root, "agents", "broken.md"), "---\nname: [unclosed\n---\nBody.");
        writePiSettings("user", [root]);

        await expect(activate()).resolves.toBeUndefined();
      } finally {
        warn.mockRestore();
      }
    });
  });

  // The workflow resolver reads the `packageWorkflows` gate out of the module
  // state this extension sets at boot, rather than taking it as a parameter
  // through four call layers. That only holds while there is exactly one module
  // instance — which is what booting the real extension here checks.
  describe("workflows", () => {
    it("resolves a saved name against a package's declared directory", async () => {
      env = hermeticDir();
      writePiSettings("user", [makePackage()]);

      await boot(false);
      const { listSavedWorkflows, readSavedWorkflow } = await import("../src/workflow/saved.js");
      expect(listSavedWorkflows(env.dir)).toContain("pkg-flow");
      expect(readSavedWorkflow("pkg-flow", env.dir).ok).toBe(true);
    });

    it("stops resolving it once packageWorkflows is off", async () => {
      env = hermeticDir({ settings: { packageWorkflows: false } });
      writePiSettings("user", [makePackage()]);

      await boot(false);
      const { listSavedWorkflows, readSavedWorkflow } = await import("../src/workflow/saved.js");
      expect(listSavedWorkflows(env.dir)).not.toContain("pkg-flow");
      expect(readSavedWorkflow("pkg-flow", env.dir).ok).toBe(false);
    });

    it("gates workflows separately from agents", async () => {
      env = hermeticDir({ settings: { packageAgents: true, packageWorkflows: false } });
      writePiSettings("user", [makePackage()]);

      await boot(false);
      const { listSavedWorkflows } = await import("../src/workflow/saved.js");
      expect(getAllTypes()).toContain("pkg-researcher");
      expect(listSavedWorkflows(env.dir)).not.toContain("pkg-flow");
    });
  });

  it("lets a project agent file take the name from the package", async () => {
    env = hermeticDir({
      agentFiles: { "pkg-researcher": "---\nname: pkg-researcher\ndescription: Mine\n---\nLocal.\n" },
    });
    writePiSettings("user", [makePackage()]);

    await boot(false);
    const { getAgentConfig } = await import("../src/agent-types.js");
    expect(getAgentConfig("pkg-researcher")?.source).toBe("project");
    expect(getAgentConfig("pkg-researcher")?.description).toBe("Mine");
  });
});
