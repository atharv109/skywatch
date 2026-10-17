import type { InboundMessage } from "./photon.ts";

/**
 * In-process webhook work queue (Global Constraint 5: "Webhook handlers enqueue
 * work and ack 2xx immediately"). Sequential: messages for one user must not race
 * the signup state machine. Id-guarded on messageId — Photon retries redeliver the
 * same message id (at-least-once), so the guard must not let it process twice.
 */
export interface InboundQueue<T = InboundMessage> {
  enqueue(msg: T): void;
  /** Resolves when everything enqueued up to this call has finished processing. */
  drain(): Promise<void>;
}

/**
 * Generic over the message type so the voice post-call queue (Task 6, deduped on
 * conversation_id) reuses the same id-guarded sequential machinery; the Photon
 * inbound queue dedupes on InboundMessage.messageId (the default key).
 */
export function createInboundQueue<T>(
  process: (msg: T) => Promise<void>,
  opts: { dedupeLimit?: number; dedupeKey?: (msg: T) => string | undefined } = {},
): InboundQueue<T> {
  const dedupeLimit = opts.dedupeLimit ?? 10_000;
  const keyOf = opts.dedupeKey ?? ((msg: T) => (msg as { messageId?: string } | undefined)?.messageId);
  // Insertion-ordered id set with a cap so a long-lived process can not grow it
  // unbounded; Photon's retry window (~3.5 min worst case) is far inside the limit.
  const seen = new Map<string, true>();
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(msg) {
      const key = keyOf(msg);
      if (key && seen.has(key)) return;
      if (key) {
        seen.set(key, true);
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