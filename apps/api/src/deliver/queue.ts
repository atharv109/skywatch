import type { InboundMessage } from "./photon.ts";

/**
 * In-process webhook work queue (Global Constraint 5: "Webhook handlers enqueue
 * work and ack 2xx immediately"). Sequential: messages for one user must not race
 * the signup state machine. Id-guarded on messageId — Photon retries redeliver the
 * same message id (at-least-once), so the guard must not let it process twice.
 */
export interface InboundQueue {
  enqueue(msg: InboundMessage): void;
  /** Resolves when everything enqueued up to this call has finished processing. */
  drain(): Promise<void>;
}

export function createInboundQueue(
  process: (msg: InboundMessage) => Promise<void>,
  opts: { dedupeLimit?: number } = {},
): InboundQueue {
  const dedupeLimit = opts.dedupeLimit ?? 10_000;
  // Insertion-ordered id set with a cap so a long-lived process can not grow it
  // unbounded; Photon's retry window (~3.5 min worst case) is far inside the limit.
  const seen = new Map<string, true>();
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(msg) {
      if (msg.messageId && seen.has(msg.messageId)) return;
      if (msg.messageId) {
        seen.set(msg.messageId, true);
        if (seen.size > dedupeLimit) {
          const oldest = seen.keys().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
      }
      tail = tail.then(() =>
        process(msg).catch((err) => console.error("inbound message processing failed:", err)),
      );
    },
    async drain() {
      await tail;
    },
  };
}