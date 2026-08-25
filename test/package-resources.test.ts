import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listPiPackages,
  packageAgentDirs,
  packageAgentFiles,
  packageAllowed,
  packageWorkflowDirs,
  readSubagentManifest,
  resetPackageState,
  resolveDeclaredPaths,
  setPackageAgentsGate,
  setPackageWorkflowsGate,
  setProjectTrusted,
  unscopedShortName,
} from "../src/package-resources.js";

describe("readSubagentManifest", () => {
  const dirs = ["./agents"];

  it("reads the nested pi.subagents object form", () => {
    expect(readSubagentManifest({ pi: { subagents: { agents: dirs, workflows: ["./flows"] } } }))
      .toEqual({ agents: dirs, workflows: ["./flows"] });
  });

  it("reads pi.subagents as an array shorthand for agents", () => {
    expect(readSubagentManifest({ pi: { subagents: dirs } })).toEqual({ agents: dirs });
  });

  it("reads the top-level pi-subagents object form", () => {
    expect(readSubagentManifest({ "pi-subagents": { agents: dirs } })).toEqual({ agents: dirs });
  });

  it("reads pi-subagents as an array shorthand for agents", () => {
    expect(readSubagentManifest({ "pi-subagents": dirs })).toEqual({ agents: dirs });
  });

  it("prefers pi.subagents over the top-level key when a package carries both", () => {
    const manifest = { pi: { subagents: ["./a"] }, "pi-subagents": ["./b"] };
    expect(readSubagentManifest(manifest)).toEqual({ agents: ["./a"] });
  });

  it("ignores a pi key that declares only pi's own resource types", () => {
    // The whole point of requiring a declaration: a package that ships
    // extensions and skills contributes no subagents until it says so.
    expect(readSubagentManifest({ pi: { extensions: ["./src/index.ts"], skills: ["./skills"] } }))
      .toBeUndefined();
  });

  it("drops a declaration whose entries are not all strings", () => {
    expect(readSubagentManifest({ pi: { subagents: { agents: ["./a", 7] } } })).toBeUndefined();
  });

  it("returns undefined for a manifest with no declaration at all", () => {
    expect(readSubagentManifest({ name: "plain" })).toBeUndefined();
    expect(readSubagentManifest(undefined)).toBeUndefined();
    expect(readSubagentManifest("not an object")).toBeUndefined();
  });
});

describe("unscopedShortName", () => {
  it("strips the npm scope and lowercases", () => {
    expect(unscopedShortName("@tintinweb/pi-subagents")).toBe("pi-subagents");
    expect(unscopedShortName("My-Package")).toBe("my-package");
  });
});

describe("resolveDeclaredPaths", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-pkg-"));
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "extra"), { recursive: true });
    writeFileSync(join(root, "agents", "one.md"), "x");
    writeFileSync(join(root, "loose.md"), "x");
    writeFileSync(join(root, "notes.txt"), "x");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("splits directory entries from file entries", () => {
    const { dirs, files } = resolveDeclaredPaths(root, ["./agents", "./loose.md"], "agents");
    expect(dirs).toEqual([join(root, "agents")]);
    expect(files).toEqual([join(root, "loose.md")]);
  });

  it("ignores a file entry whose extension is wrong for the kind", () => {
    const { files } = resolveDeclaredPaths(root, ["./notes.txt"], "agents");
    expect(files).toEqual([]);
  });

  it("applies ! exclusions", () => {
    const { dirs } = resolveDeclaredPaths(root, ["./agents", "./extra", "!./extra"], "agents");
    expect(dirs).toEqual([join(root, "agents")]);
  });

  it("refuses an entry that escapes the package root", () => {
    // A package manifest is third-party input; `../..` must not become a
    // scanned directory. Pi refuses the same shape in its own resolver.
    expect(resolveDeclaredPaths(root, ["../", "../../etc", "/etc"], "agents"))
      .toEqual({ dirs: [], files: [] });
  });

  it("drops entries that do not exist", () => {
    expect(resolveDeclaredPaths(root, ["./nope"], "agents")).toEqual({ dirs: [], files: [] });
  });

  it("de-duplicates repeated entries", () => {
    const { dirs } = resolveDeclaredPaths(root, ["./agents", "agents", "./agents/"], "agents");
    expect(dirs).toEqual([join(root, "agents")]);
  });

  it("returns nothing for an absent declaration", () => {
    expect(resolveDeclaredPaths(root, undefined, "workflows")).toEqual({ dirs: [], files: [] });
  });
});

describe("packageAllowed", () => {
  const pkg = {
    source: "npm:@acme/tools",
    name: "@acme/tools",
    shortName: "tools",
    scope: "user" as const,
    root: "/somewhere",
  };

  it("admits everything for true and for an unset gate", () => {
    expect(packageAllowed(pkg, true)).toBe(true);
    expect(packageAllowed(pkg, undefined)).toBe(true);
  });

  it("admits nothing for false", () => {
    expect(packageAllowed(pkg, false)).toBe(false);
  });

  it("matches an allowlist on short name, full name, or source", () => {
    expect(packageAllowed(pkg, ["tools"])).toBe(true);
    expect(packageAllowed(pkg, ["@acme/tools"])).toBe(true);
    expect(packageAllowed(pkg, ["npm:@acme/tools"])).toBe(true);
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(packageAllowed(pkg, ["  TOOLS "])).toBe(true);
  });

  it("rejects a name that is not on the list", () => {
    expect(packageAllowed(pkg, ["other"])).toBe(false);
    expect(packageAllowed(pkg, [])).toBe(false);
  });
});

describe("discovery through pi's configured packages", () => {
  let tmpDir: string;
  let agentDir: string;
  let projectDir: string;
  let originalHome: string | undefined;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-pkgdisc-"));
    agentDir = join(tmpDir, "agentdir");
    projectDir = join(tmpDir, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    originalHome = process.env.HOME;
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmpDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    resetPackageState();
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    resetPackageState();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Build a package on disk and return its root. `manifest` is merged into package.json. */
  function makePackage(name: string, manifest: Record<string, unknown>): string {
    const root = join(tmpDir, name);
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
    writeFileSync(
      join(root, "agents", `${name}-agent.md`),
      `---\nname: ${name}-agent\ndescription: from ${name}\n---\nBody.\n`,
    );
    writeFileSync(join(root, "workflows", "flow.js"), "export const meta = { name: 'flow', description: 'd' }\n");
    return root;
  }

  /** Point pi's user settings at these package sources. */
  function installGlobally(...sources: string[]): void {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: sources }));
  }

  /** Point the project's settings at these package sources. */
  function installLocally(...sources: string[]): void {
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: sources }));
  }

  it("finds a declaring package configured in pi's user settings", () => {
    const root = makePackage("demo", { pi: { subagents: { agents: ["./agents"] } } });
    installGlobally(root);

    expect(listPiPackages(projectDir).map(p => p.root)).toEqual([root]);
    expect(packageAgentDirs(projectDir)).toEqual([join(root, "agents")]);
  });

  it("skips a package that declares nothing we understand", () => {
    installGlobally(makePackage("plain", { pi: { extensions: ["./index.js"] } }));
    expect(listPiPackages(projectDir)).toEqual([]);
    expect(packageAgentDirs(projectDir)).toEqual([]);
  });

  it("never scans an undeclared agents/ directory", () => {
    // Pi falls back to convention directories when a package has no `pi` key at
    // all. We deliberately do not: the author must opt in by name.
    installGlobally(makePackage("conventional", {}));
    expect(packageAgentDirs(projectDir)).toEqual([]);
  });

  it("ignores a package listed in settings but absent from disk", () => {
    installGlobally(join(tmpDir, "never-installed"));
    expect(listPiPackages(projectDir)).toEqual([]);
  });

  it("survives a malformed package.json without throwing", () => {
    const root = join(tmpDir, "broken");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), "{ not json");
    installGlobally(root);
    expect(listPiPackages(projectDir)).toEqual([]);
  });

  it("reads the workflows declaration into its own root list", () => {
    const root = makePackage("flows", { pi: { subagents: { workflows: ["./workflows"] } } });
    installGlobally(root);
    expect(packageWorkflowDirs(projectDir)).toEqual([join(root, "workflows")]);
    expect(packageAgentDirs(projectDir)).toEqual([]);
  });

  it("surfaces a declared file entry separately from directories", () => {
    const root = makePackage("filedecl", { pi: { subagents: { agents: ["./agents/filedecl-agent.md"] } } });
    installGlobally(root);
    expect(packageAgentDirs(projectDir)).toEqual([]);
    expect(packageAgentFiles(projectDir)).toEqual([join(root, "agents", "filedecl-agent.md")]);
  });

  describe("project trust", () => {
    it("hides a package configured only by an untrusted project", () => {
      installLocally(makePackage("local-only", { pi: { subagents: ["./agents"] } }));
      setProjectTrusted(false);
      expect(listPiPackages(projectDir, false)).toEqual([]);
      expect(packageAgentDirs(projectDir)).toEqual([]);
    });

    it("shows it once the project is trusted", () => {
      const root = makePackage("local-only", { pi: { subagents: ["./agents"] } });
      installLocally(root);
      setProjectTrusted(true);
      expect(packageAgentDirs(projectDir)).toEqual([join(root, "agents")]);
    });

    it("still shows a globally configured package in an untrusted project", () => {
      const root = makePackage("global", { pi: { subagents: ["./agents"] } });
      installGlobally(root);
      setProjectTrusted(false);
      expect(packageAgentDirs(projectDir)).toEqual([join(root, "agents")]);
    });
  });

  describe("gating", () => {
    let a: string;
    let b: string;

    beforeEach(() => {
      const decl = { pi: { subagents: { agents: ["./agents"], workflows: ["./workflows"] } } };
      a = makePackage("alpha", decl);
      b = makePackage("beta", decl);
      installGlobally(a, b);
    });

    it("admits every declaring package by default", () => {
      expect(packageAgentDirs(projectDir)).toEqual([join(a, "agents"), join(b, "agents")]);
    });

    it("admits none when the gate is false", () => {
      setPackageAgentsGate(false);
      expect(packageAgentDirs(projectDir)).toEqual([]);
    });

    it("admits only the named package for an allowlist", () => {
      setPackageAgentsGate(["beta"]);
      expect(packageAgentDirs(projectDir)).toEqual([join(b, "agents")]);
    });

    it("admits none for an empty allowlist", () => {
      setPackageAgentsGate([]);
      expect(packageAgentDirs(projectDir)).toEqual([]);
    });

    it("gates agents and workflows independently", () => {
      setPackageAgentsGate(false);
      setPackageWorkflowsGate(true);
      expect(packageAgentDirs(projectDir)).toEqual([]);
      expect(packageWorkflowDirs(projectDir)).toEqual([join(a, "workflows"), join(b, "workflows")]);
    });

    it("re-scans after the gate changes rather than serving the cached list", () => {
      expect(packageAgentDirs(projectDir)).toHaveLength(2);
      setPackageAgentsGate(["alpha"]);
      expect(packageAgentDirs(projectDir)).toEqual([join(a, "agents")]);
      setPackageAgentsGate(true);
      expect(packageAgentDirs(projectDir)).toHaveLength(2);
    });
  });

  it("hands back a copy, so a caller cannot corrupt the cached root list", () => {
    installGlobally(makePackage("demo", { pi: { subagents: ["./agents"] } }));
    const first = packageAgentDirs(projectDir);
    first.length = 0;
    expect(packageAgentDirs(projectDir)).toHaveLength(1);
  });
});
