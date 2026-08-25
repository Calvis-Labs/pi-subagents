/**
 * package-resources.ts — Discover agent and workflow files that installed pi
 * packages declare in their `package.json`.
 *
 * ## Why this exists
 *
 * Pi already ships four resource types inside packages — `extensions`, `skills`,
 * `prompts`, `themes` — resolved from a `pi` manifest key or, when there is no
 * `pi` key at all, from convention directories. Subagents are *our* concept, so
 * pi knows nothing about them and a package author's only option was to copy
 * `.md` files into `.pi/agents/` on every container start (#109).
 *
 * ## The contract
 *
 * Two-sided, deliberately:
 *
 *   1. The package author opts in by naming the paths in `package.json`.
 *   2. The user opts in by running `pi install`, which is already the trust
 *      decision for that package — pi executes its `extensions/` and injects its
 *      `skills/` into the system prompt with no further prompt. A declared `.md`
 *      agent is strictly less privileged than either, so it rides the boundary
 *      the user already crossed rather than inventing a second one.
 *
 * There is deliberately **no convention-directory fallback**. Pi scans `skills/`
 * only when a package has no `pi` key whatsoever; we never scan an undeclared
 * `agents/`. A package that happens to carry an `agents/` folder for some other
 * tool must not start contributing subagents to pi because it was installed for
 * an unrelated reason.
 *
 * ## Which packages are visible
 *
 * Only what pi itself has configured — `settings.json -> packages[]`, global and
 * project — read through pi's own `DefaultPackageManager.listConfiguredPackages()`.
 * That call is synchronous, pure, and never installs anything; it also resolves
 * npm / git / local install roots, pnpm global roots and legacy fallbacks, which
 * is why it is worth borrowing rather than reimplementing.
 *
 * `node_modules` is never scanned. Being a transitive dependency of the user's
 * project means nothing here — the same rule pi applies to itself.
 *
 * ## Accepted manifest spellings
 *
 * All four mean the same thing. The `pi-subagents` top-level key exists for
 * cross-compatibility with `nicobailon/pi-subagents`, which reads the same two
 * shapes, so a package author writes one manifest that works on either extension.
 *
 *   "pi":            { "subagents": { "agents": ["./agents"], "workflows": ["./flows"] } }
 *   "pi":            { "subagents": ["./agents"] }            // shorthand for { agents }
 *   "pi-subagents":  { "agents": ["./agents"] }
 *   "pi-subagents":  ["./agents"]                             // shorthand for { agents }
 *
 * Adding `pi.subagents` is safe for pi itself: its `readPiManifest` reads only
 * `extensions`/`skills`/`prompts`/`themes` and ignores every other key.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Resource kinds a package may declare. Agents are `.md`, workflows are `.js`. */
export type PackageResourceKind = "agents" | "workflows";

/** File extension scanned for each kind, mirroring the local roots for each. */
const KIND_EXTENSION: Record<PackageResourceKind, string> = {
  agents: ".md",
  workflows: ".js",
};

/**
 * Per-file size ceiling for package-provided resources, matching Claude Code's
 * plugin-agent limit. These files come from third-party packages and are read
 * eagerly on every agent load; a pathological one should be skipped, not
 * `readFileSync`'d into the session.
 */
export const MAX_PACKAGE_RESOURCE_BYTES = 1_048_576;

/** One installed pi package that declared something we understand. */
export interface PiPackage {
  /** The settings source string, e.g. `npm:@foo/bar@1.0.0` or an absolute path. */
  source: string;
  /** `package.json` `name`, when the manifest could be read. */
  name?: string;
  /** Unscoped, lowercased short name (`@scope/foo` becomes `foo`) for allowlist matching. */
  shortName?: string;
  /** Which settings scope configured it. */
  scope: "user" | "project";
  /** Absolute path of the installed package root. */
  root: string;
}

/**
 * The gate for one resource kind, as persisted in our settings:
 * `true` (default) = every declaring package, `false` = none, `string[]` =
 * only packages whose short name, full name, or source matches an entry.
 */
export type PackageGate = boolean | string[] | undefined;

export interface PackageDiscoveryOptions {
  /**
   * Pi's project-trust state for `cwd`, from `ctx.isProjectTrusted()`. When
   * false, `.pi/settings.json` is not read — so a package configured only by an
   * untrusted project is invisible to us, exactly as it is to pi. Omitted falls
   * back to the session state set by {@link setProjectTrusted}.
   */
  projectTrusted?: boolean;
  /** Gate override. Omitted falls back to the session state for the kind. */
  gate?: PackageGate;
}

// ---- Session state ----
//
// Held here rather than threaded through every caller, matching how the rest of
// this extension carries session-wide settings (`setMaxSubagentDepth`,
// `setWorktreeIsolationEnabled`, ...). The alternative was an options bag
// travelling from `index.ts` through `resolveWorkflowScript`,
// `resolveWorkflowSource`, `readSavedWorkflow` and `listSavedWorkflows` purely
// so a gate could be consulted at the bottom.
//
// Both gates start `undefined`, which reads as `true`: absent settings mean
// every declaring package contributes, matching pi's own default for the
// resources it owns.

let agentsGate: PackageGate;
let workflowsGate: PackageGate;
/**
 * Defaults to `false` — an extension activates before any session context
 * exists, and reading an untrusted project's package list only to take it away
 * again is the wrong direction to fail. `index.ts` corrects it from
 * `ctx.isProjectTrusted()` on `session_start`.
 */
let projectTrustedState = false;

/** Apply the `packageAgents` setting. Drops the cache, since roots may change. */
export function setPackageAgentsGate(gate: PackageGate): void {
  agentsGate = gate;
  invalidatePackageCache();
}

/** Apply the `packageWorkflows` setting. Drops the cache, since roots may change. */
export function setPackageWorkflowsGate(gate: PackageGate): void {
  workflowsGate = gate;
  invalidatePackageCache();
}

export function getPackageAgentsGate(): PackageGate {
  return agentsGate;
}

export function getPackageWorkflowsGate(): PackageGate {
  return workflowsGate;
}

/**
 * Record pi's project-trust answer. Drops the cache when the answer changes,
 * since a project's `packages[]` becomes visible or invisible with it. A repeat
 * of the same answer is a no-op — `session_start` fires on every new, resumed
 * and forked session, and it has its own reason to invalidate.
 */
export function setProjectTrusted(trusted: boolean): void {
  if (projectTrustedState === trusted) return;
  projectTrustedState = trusted;
  invalidatePackageCache();
}

export function isProjectTrusted(): boolean {
  return projectTrustedState;
}

/** Reset every session-scoped value. Tests only — the extension never un-loads. */
export function resetPackageState(): void {
  agentsGate = undefined;
  workflowsGate = undefined;
  projectTrustedState = false;
  invalidatePackageCache();
}

/** What a package declared, after normalising the accepted spellings. */
export interface DeclaredEntries {
  agents?: string[];
  workflows?: string[];
}

/** Absolute paths a declaration resolved to, split by what the loader needs. */
export interface ResolvedResourcePaths {
  dirs: string[];
  files: string[];
}

// ---- Manifest reading ----

/** A string array, or undefined for anything else. Mirrors pi's `readPiManifest` strictness. */
function stringArray(val: unknown): string[] | undefined {
  return Array.isArray(val) && val.every(e => typeof e === "string") ? (val as string[]) : undefined;
}

/**
 * Normalize one accepted spelling into `{ agents, workflows }`.
 * A bare array is the `agents` shorthand — the only kind that existed when the
 * shorthand was worth having, and the shape the other fork's docs show.
 */
function normalizeDeclaration(val: unknown): DeclaredEntries | undefined {
  const asArray = stringArray(val);
  if (asArray) return { agents: asArray };
  if (!val || typeof val !== "object" || Array.isArray(val)) return undefined;
  const obj = val as Record<string, unknown>;
  const agents = stringArray(obj.agents);
  const workflows = stringArray(obj.workflows);
  if (!agents && !workflows) return undefined;
  return { agents, workflows };
}

/**
 * Read the subagent declaration out of a parsed `package.json`.
 *
 * `pi.subagents` wins over the top-level `pi-subagents` when a package carries
 * both — the pi-namespaced key is the primary spelling here, and a package that
 * writes both almost certainly means them to be identical anyway.
 */
export function readSubagentManifest(pkg: unknown): DeclaredEntries | undefined {
  if (!pkg || typeof pkg !== "object") return undefined;
  const obj = pkg as Record<string, unknown>;
  const piKey = obj.pi;
  if (piKey && typeof piKey === "object" && !Array.isArray(piKey)) {
    const nested = normalizeDeclaration((piKey as Record<string, unknown>).subagents);
    if (nested) return nested;
  }
  return normalizeDeclaration(obj["pi-subagents"]);
}

/** Parse `<root>/package.json`, or undefined when it is missing or malformed. */
function readPackageJson(root: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `@scope/foo` becomes `foo`, lowercased. The name a user types in an allowlist. */
export function unscopedShortName(name: string): string {
  const short = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return short.toLowerCase();
}

// ---- Path resolution ----

/**
 * True when `candidate` is inside `root`. Package manifests are third-party
 * input, so `"../../.ssh"` must not become a scanned directory — pi refuses the
 * same shape with "Refusing to use path outside package install root".
 */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolve one manifest entry against the package root, returning the path only
 * when it stays inside the package and exists.
 *
 * Globs are deliberately not supported. Pi's own manifest expands them because
 * it resolves four resource types across arbitrary layouts; here the entries are
 * one or two directories, and a glob would mean walking a third-party tree to
 * answer. A directory or a file path covers the declared use cases.
 */
function expandEntry(root: string, entry: string): string | undefined {
  const target = resolve(root, entry);
  if (!isInside(root, target) || !existsSync(target)) return undefined;
  return target;
}

/**
 * Resolve one kind's declared entries into concrete absolute paths inside the
 * package: directories to scan, and individual files.
 *
 * Split into `{ dirs, files }` rather than a flat list because the agent loader
 * takes directories (it does its own `readdirSync` and frontmatter handling),
 * while a manifest entry naming a single file has to be surfaced on its own.
 *
 * `!entry` marks an exclusion, matching pi's manifest semantics.
 */
export function resolveDeclaredPaths(
  root: string,
  entries: string[] | undefined,
  kind: PackageResourceKind,
): ResolvedResourcePaths {
  const dirs: string[] = [];
  const files: string[] = [];
  if (!entries) return { dirs, files };

  const excluded = new Set<string>();
  for (const entry of entries) {
    if (!entry.startsWith("!")) continue;
    const path = expandEntry(root, entry.slice(1));
    if (path) excluded.add(path);
  }

  const ext = KIND_EXTENSION[kind];
  for (const entry of entries) {
    if (entry.startsWith("!")) continue;
    const path = expandEntry(root, entry);
    if (!path || excluded.has(path)) continue;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!dirs.includes(path)) dirs.push(path);
    } else if (stat.isFile() && path.endsWith(ext) && !files.includes(path)) {
      files.push(path);
    }
  }
  return { dirs, files };
}

// ---- Package enumeration ----

interface ConfiguredPackageRow {
  source: string;
  scope: "user" | "project";
  installedPath?: string;
}

/**
 * Build a read-only view of pi's configured packages.
 *
 * Feature-detected rather than assumed: the peer floor is `>=0.84.0` and this
 * API is not exercised by CI across that whole range, so a host that does not
 * expose it contributes no packages instead of failing activation.
 */
function configuredPackages(cwd: string, projectTrusted: boolean): ConfiguredPackageRow[] {
  try {
    if (typeof DefaultPackageManager !== "function") return [];
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
    const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    if (typeof manager.listConfiguredPackages !== "function") return [];
    return manager.listConfiguredPackages();
  } catch {
    return [];
  }
}

/**
 * Every installed pi package that declares subagent resources, in pi's own
 * order (global entries first, then project). Duplicates by root are collapsed —
 * a package listed in both scopes is one package on disk.
 */
export function listPiPackages(cwd: string, projectTrusted = false): PiPackage[] {
  const seen = new Set<string>();
  const out: PiPackage[] = [];
  for (const entry of configuredPackages(cwd, projectTrusted)) {
    const root = entry.installedPath;
    if (!root || seen.has(root)) continue;
    const manifest = readPackageJson(root);
    if (!manifest || !readSubagentManifest(manifest)) continue;
    seen.add(root);
    const name = typeof manifest.name === "string" ? manifest.name : undefined;
    out.push({
      source: entry.source,
      name,
      shortName: name ? unscopedShortName(name) : undefined,
      scope: entry.scope,
      root,
    });
  }
  return out;
}

/**
 * Whether `pkg` passes the gate. `true`/omitted admits everything; an array
 * matches case-insensitively against the unscoped short name, the full package
 * name, or the settings source string — users reach for whichever of the three
 * they happen to have in front of them.
 */
export function packageAllowed(pkg: PiPackage, gate: PackageGate): boolean {
  if (gate === false) return false;
  if (gate === undefined || gate === true) return true;
  const candidates = new Set(
    [pkg.shortName, pkg.name?.toLowerCase(), pkg.source.toLowerCase()].filter(
      (v): v is string => typeof v === "string",
    ),
  );
  return gate.some(allowed => candidates.has(allowed.trim().toLowerCase()));
}

// ---- Caching ----

/**
 * `loadCustomAgents` runs on activation and again on every `Agent` call, so an
 * uncached scan would re-read pi's settings and every package manifest per
 * spawn. What is cached is only the *root list* — which packages declare what —
 * because that changes when settings change, not when a file is edited. The
 * agent files themselves are still re-read on every load, so editing a linked
 * package's agent still takes effect immediately.
 *
 * Keyed by cwd because nested subagents load from `context.configCwd`, which is
 * not necessarily the main session's directory, and by the gate because a
 * settings change must not be served a stale allowlist.
 */
interface CacheEntry {
  agents: ResolvedResourcePaths;
  workflows: ResolvedResourcePaths;
}
const cache = new Map<string, CacheEntry>();

/** Drop the memoized package scan. Called on `/reload` and after settings changes. */
export function invalidatePackageCache(): void {
  cache.clear();
}

function scan(cwd: string, projectTrusted: boolean, gate: PackageGate): CacheEntry {
  const entry: CacheEntry = { agents: { dirs: [], files: [] }, workflows: { dirs: [], files: [] } };
  for (const pkg of listPiPackages(cwd, projectTrusted)) {
    if (!packageAllowed(pkg, gate)) continue;
    const manifest = readPackageJson(pkg.root);
    const declared = manifest ? readSubagentManifest(manifest) : undefined;
    if (!declared) continue;
    for (const kind of ["agents", "workflows"] as const) {
      const { dirs, files } = resolveDeclaredPaths(pkg.root, declared[kind], kind);
      entry[kind].dirs.push(...dirs);
      entry[kind].files.push(...files);
    }
  }
  return entry;
}

function resolved(cwd: string, kind: PackageResourceKind, opts: PackageDiscoveryOptions): ResolvedResourcePaths {
  const gate = opts.gate ?? (kind === "agents" ? agentsGate : workflowsGate);
  // An empty allowlist matches nothing, like `false` — see `sanitizePackageGate`
  // in settings.ts for why an empty array is kept rather than dropped.
  if (gate === false || (Array.isArray(gate) && gate.length === 0)) return { dirs: [], files: [] };
  const projectTrusted = opts.projectTrusted ?? projectTrustedState;
  const key = `${cwd} ${projectTrusted ? 1 : 0} ${JSON.stringify(gate ?? true)}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = scan(cwd, projectTrusted, gate);
    cache.set(key, hit);
  }
  return hit[kind];
}

/**
 * Directories of package-declared agent files, lowest-precedence first.
 * Fed to `loadCustomAgents` ahead of the global and project roots.
 */
export function packageAgentDirs(cwd: string, opts: PackageDiscoveryOptions = {}): string[] {
  // A copy: the cache holds this array for the rest of the session, so a caller
  // that sorted or spliced it would corrupt every later load.
  return [...resolved(cwd, "agents", opts).dirs];
}

/** Individually declared agent `.md` files (a manifest entry naming a file, not a directory). */
export function packageAgentFiles(cwd: string, opts: PackageDiscoveryOptions = {}): string[] {
  return [...resolved(cwd, "agents", opts).files];
}

/**
 * Directories of package-declared workflow scripts, appended to
 * `savedWorkflowRoots` so a name resolves there last.
 */
export function packageWorkflowDirs(cwd: string, opts: PackageDiscoveryOptions = {}): string[] {
  const { dirs, files } = resolved(cwd, "workflows", opts);
  // A declared workflow *file* has no root for a name lookup, so its parent
  // directory stands in. That widens the root to the file's siblings, which is
  // safe: `readSavedWorkflow` and `listSavedWorkflows` both require the
  // `export const meta =` declaration, so a sibling that is not a workflow is
  // never offered as one.
  const fromFiles = files.map(f => dirname(f));
  return [...dirs, ...fromFiles.filter(d => !dirs.includes(d))];
}
