/**
 * completion-outbox.ts — When background completions reach the parent.
 *
 * Claude Code queues each completion and, after every tool batch, hands the
 * model everything that queued up in one go: a busy parent sees what finished
 * during the batch before its next model call, and nothing waits for a sibling.
 * pi's steering queue would split those into one model call each under its
 * default `one-at-a-time` mode, so the outbox holds them and sends ONE message
 * at the boundary instead.
 *
 * - Parent busy: held until `turn_end`, which pi emits after the tool batch and
 *   before it reads the steering queue.
 * - Parent idle: sent after a short hold, so near-simultaneous completions
 *   share a turn and `get_subagent_result` still gets a moment to consume one.
 * - Parent turn aborted (Esc): delivered with the user's next prompt instead of
 *   forcing a turn the user just interrupted.
 */

import type { NotificationDetails } from "./types.js";

/** How long an idle parent's notification is held before it is sent. */
export const NOTIFICATION_HOLD_MS = 200;

export interface OutboxMessage {
  content: string;
  details: NotificationDetails;
}

/**
 * Built when the outbox flushes, not when the item is added: a result consumed
 * in the meantime returns `undefined` and is never delivered.
 */
export type OutboxItem = () => OutboxMessage | undefined;

export type OutboxDelivery =
  | { deliverAs: "steer"; triggerTurn: true }
  | { deliverAs: "nextTurn" };

const STEER: OutboxDelivery = { deliverAs: "steer", triggerTurn: true };

export class CompletionOutbox {
  private items: OutboxItem[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private send: (message: OutboxMessage, delivery: OutboxDelivery) => void,
    /** Whether the parent has a run in flight, so a `turn_end` is coming. */
    private parentRunning: () => boolean,
  ) {}

  add(item: OutboxItem): void {
    this.items.push(item);
    if (!this.parentRunning()) this.arm();
  }

  /** The parent finished a turn: its tool batch is done, the next model call is not. */
  onTurnEnd(stopReason: string | undefined): void {
    if (stopReason === "aborted") this.flush({ deliverAs: "nextTurn" });
    // pi may retry a failed turn; anything held goes with the next boundary,
    // or with the run's end if there is none.
    else if (stopReason !== "error") this.flush(STEER);
  }

  /** Completions that landed after the run's last `turn_end` would otherwise wait for the next run. */
  onAgentEnd(): void {
    if (this.items.length > 0) this.arm();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.items = [];
  }

  /** Not reset by later items: the first completion is never pushed back. */
  private arm(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flush(STEER);
    }, NOTIFICATION_HOLD_MS);
  }

  private flush(delivery: OutboxDelivery): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const items = this.items;
    this.items = [];
    const messages: OutboxMessage[] = [];
    for (const item of items) {
      try {
        const message = item();
        if (message) messages.push(message);
      } catch { /* a stale completion must not take the others down */ }
    }
    if (messages.length === 0) return;
    // A send from a timer can outlive the session it was meant for (pi -p
    // tearing down): pi throws on the stale context, and nothing is left to tell.
    try { this.send(combine(messages), delivery); } catch { /* stale context */ }
  }
}

/** One message stays as it was built; several become one message with every agent's details. */
function combine(messages: OutboxMessage[]): OutboxMessage {
  if (messages.length === 1) return messages[0];
  const [first, ...rest] = messages.flatMap(({ details: { others, ...own } }) => [own, ...(others ?? [])]);
  return {
    content: `${messages.length} background tasks finished.\n\n${messages.map(m => m.content).join("\n\n")}`,
    details: { ...first, others: rest },
  };
}
