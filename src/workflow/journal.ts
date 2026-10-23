/**
 * journal.ts — the record a workflow run leaves so a later run can skip work.
 *
 * ## What resume actually buys
 *
 * The documented iteration loop is "edit the persisted script and re-run it".
 * Without a journal that re-pays every agent from scratch, which for a 40-agent
 * audit is the entire cost of the run — to change one line of the last stage.
 * With one, the unchanged prefix comes back from disk and only the edit runs.
 *
 * ## Why a *prefix*, and not a lookup table
 *
 * Each entry is keyed by both its position in the run and a hash of everything
 * that decides what that agent does. A replay walks positions in order and
 * stops reusing at the first entry that does not match — every call from there
 * on runs live. Reusing later matches out of order would be reusing a result
 * produced under different upstream conditions: the same prompt at position 12
 * of a *different* run is not the same work, because what fed it changed.
 *
 * A failed agent is journaled as a failure and never replayed as one. Resuming
 * a run that died at agent 5 exists to retry agent 5, so the prefix ends there
 * and 5 onwards run live — the alternative would make a failure permanent.
 *
 * ## Runs that use `agent({ resume })`
 *
 * Those are not replayed at all. A replayed agent is text from a file, not a
 * live child, so there is no conversation in this run for a later `resume` to
 * continue — and the id map that would find one belongs to the run that did
 * the spawning. Rather than replay a prefix that strands the first `resume`
 * call, a journal carrying one declines the whole cache and the run pays in
 * full. Coarse on purpose: the alternative is tracking which label each entry
 * ran under and capping the prefix below the earliest one that gets resumed,
 * which is a second key concept for a case that costs one run.
 *
 * ## Ordering under concurrency
 *
 * Positions are assigned as calls arrive, and with `pipeline` that order
 * depends on which agent finished first. A replay usually reproduces it, since
 * cached calls answer in journal order, but it is not guaranteed. That is why
 * the key is checked as well as the position: a run that interleaves
 * differently loses cache hits, it never returns another agent's answer.
 *
 * The file is JSON Lines, appended as each agent settles, so a run that is
 * killed mid-flight still leaves everything it had finished. The behavior above
 * describes the same-activation cache. Durable callers opt into strict reads and
 * throwing, fsynced writes; recovery must never turn missing history into work.
 */

import { createHash } from "node:crypto";
import { appendFileSync, closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync } from "node:fs";

const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_JOURNAL_ENTRIES = 1000;
export class WorkflowJournalError extends Error {}

export interface JournalIntegrity { count: number; bytes: number; hash: string }

export function journalIntegrity(raw = "", count = 0): JournalIntegrity {
  return { count, bytes: Buffer.byteLength(raw), hash: createHash("sha256").update(raw).digest("hex") };
}

function verifyIntegrity(raw: string, count: number, expected: JournalIntegrity): void {
  const actual = journalIntegrity(raw, count);
  if (actual.count !== expected.count || actual.bytes !== expected.bytes || actual.hash !== expected.hash) {
    throw new WorkflowJournalError("Acknowledged journal integrity mismatch; reconcile side effects before new work.");
  }
}

/** One settled agent call, as replayed. */
export interface WorkflowJournalEntry {
  /** Position in the run — the same counter that names `wf-agent-N`. */
  index: number;
  /** Hash of the call's payload; a mismatch ends the replayable prefix. */
  key: string;
  /** Whether the agent succeeded. A failure ends the prefix on replay. */
  ok: boolean;
  /** The agent's answer, when it had one. */
  text?: string;
  /**
   * Whether the call continued an earlier child (`agent({ resume })`).
   *
   * A replayed agent leaves no session behind in the run that replays it — the
   * conversation belongs to the run that actually spawned it, and the host's
   * id map is per-run — so a later `resume` would have nothing to continue.
   * Recording it lets the next run decline to replay at all rather than fail
   * partway through, which is why the flag is on the journal and not derived.
   */
  resumed?: true;
}

/**
 * The fields that decide what an agent does.
 *
 * Deliberately not the whole payload: `phaseIndex` and `phaseTitle` move the
 * row around in the progress tree without changing a single token the agent
 * sees, so re-grouping phases should not throw away an hour of results.
 */
export interface JournalKeyInput {
  prompt: string;
  label?: string;
  model?: string;
  agentType?: string;
  effort?: string;
  isolation?: string;
  gate?: string;
  resume?: string;
  /** Serialized `agent({ schema })`, when the call asked for one. */
  schema?: string;
}

/** Stable hash of a call's payload. Field order is fixed here, not by the caller. */
export function journalKey(input: JournalKeyInput): string {
  const canonical = JSON.stringify([
    input.prompt,
    input.label ?? null,
    input.model ?? null,
    input.agentType ?? null,
    input.effort ?? null,
    input.isolation ?? null,
    input.gate ?? null,
    input.resume ?? null,
    // Appended only when present, which looks like a hack and is not: adding a
    // ninth slot unconditionally would change the canonical form of every entry
    // and invalidate every journal already on disk. Conditional, a schema-less
    // call keys exactly as it always did, and adding or changing a schema still
    // produces a different key.
    ...(input.schema !== undefined ? [input.schema] : []),
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Read a journal file into position order.
 *
 * Best-effort by default: a missing, truncated or hand-mangled journal means "nothing to
 * replay", which costs tokens. Refusing to run would cost the whole run.
 * A partial last line is normal — the file is appended to while agents settle.
 */
export function readJournal(path: string, options: { strict?: boolean; acknowledged?: JournalIntegrity } = {}): WorkflowJournalEntry[] {
  if (options.strict) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_JOURNAL_BYTES || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) throw new WorkflowJournalError("Invalid journal file or size limit exceeded.");
      const raw = readFileSync(fd, "utf8");
      const entries: WorkflowJournalEntry[] = raw.split("\n").filter(line => line.trim() !== "").map(line => {
        const value: unknown = JSON.parse(line);
        if (!isEntry(value)) throw new WorkflowJournalError("Malformed journal entry.");
        return value;
      });
      if (options.acknowledged) verifyIntegrity(raw, entries.length, options.acknowledged);
      entries.sort((a, b) => a.index - b.index);
      if (entries.length > MAX_JOURNAL_ENTRIES || entries.some((entry, index) =>
        entry.index >= MAX_JOURNAL_ENTRIES || !/^[a-f0-9]{32}$/.test(entry.key)
        || (index > 0 && entries[index - 1].index === entry.index))) {
        throw new WorkflowJournalError("Invalid journal positions or entry limit exceeded.");
      }
      return entries;
    } catch (error) {
      throw new WorkflowJournalError(`Cannot replay journal ${path}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const entries: WorkflowJournalEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isEntry(parsed)) continue;
      entries.push(parsed);
    } catch {
      // A half-written final line, or someone editing the file. Skipping it
      // keeps what came before, and a shorter prefix is still a useful one.
    }
  }
  entries.sort((a, b) => a.index - b.index);
  return entries;
}

/** Append one settled call. Durable callers require a private, fsynced write or an explicit error. */
export function appendJournal(path: string, entry: WorkflowJournalEntry, options: { durable?: boolean; acknowledged?: JournalIntegrity } = {}): void {
  if (options.durable) {
    let fd: number | undefined;
    try {
      if (!isEntry(entry) || !/^[a-f0-9]{32}$/.test(entry.key) || entry.index >= MAX_JOURNAL_ENTRIES) {
        throw new WorkflowJournalError("Invalid durable journal entry.");
      }
      const line = `${JSON.stringify(entry)}\n`;
      if (Buffer.byteLength(line) > MAX_JOURNAL_BYTES) throw new WorkflowJournalError("Journal size limit exceeded.");
      fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size + Buffer.byteLength(line) > MAX_JOURNAL_BYTES || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) {
        throw new WorkflowJournalError("Invalid private journal file or size limit exceeded.");
      }
      const raw = options.acknowledged ? readFileSync(fd, "utf8") : "";
      if (options.acknowledged) verifyIntegrity(raw, raw.split("\n").filter(line => line.trim() !== "").length, options.acknowledged);
      appendFileSync(fd, line, "utf8");
      fsyncSync(fd);
      if (options.acknowledged) Object.assign(options.acknowledged, journalIntegrity(raw + line, options.acknowledged.count + 1));
    } catch (error) {
      throw new WorkflowJournalError(`Cannot persist journal ${path}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return;
  }
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // A journal that cannot be written costs a future resume, nothing more.
  }
}

function isEntry(value: unknown): value is WorkflowJournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    Number.isInteger(entry.index) &&
    (entry.index as number) >= 0 &&
    typeof entry.key === "string" &&
    typeof entry.ok === "boolean" &&
    (entry.text === undefined || typeof entry.text === "string") &&
    (entry.resumed === undefined || entry.resumed === true)
  );
}
