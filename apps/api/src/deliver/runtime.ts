/**
 * Wiring between the HTTP webhook route and the deliver modules. The default
 * context (createInboundContext) resolves Mongo collections lazily via the shared
 * db/client.ts connection; tests build the same shape over a memory store.
 */
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { geocodeAddress } from "../ingest/geocode.ts";
import { createInboundQueue } from "./queue.ts";
import { fromPhoton, verifyPhotonSignature, type InboundMessage, type VerifyResult } from "./photon.ts";
import { processInbound, type InboundContext } from "./signup.ts";
import { mongoDeliverStore, type DeliverStore } from "./store.ts";
import { mongoStore } from "../store.ts";

export type { InboundContext };

export interface InboundRuntime {
  verify(rawBody: string, headers: { signature?: string; timestamp?: string }, now: number): VerifyResult;
  /** Parse + guard + enqueue one raw webhook body; false = acked but nothing to do. */
  accept(rawBody: string): { enqueued: boolean };
  /** Test seam: resolves once everything enqueued so far has been processed. */
  drain(): Promise<void>;
}

export function createInboundContext(config: Config): InboundContext {
  return {
    config,
    store: () => getDb(config).then(mongoDeliverStore),
    now: () => Date.now(),
    geocode: (address) => geocodeAddress(address),
    appStore: () => getDb(config).then(mongoStore),
  };
}

export function createInboundRuntime(ctx: InboundContext): InboundRuntime {
  const queue = createInboundQueue<InboundMessage>((msg) => processInbound(msg, ctx));
  return {
    verify(rawBody, headers, now) {
      return verifyPhotonSignature({
        rawBody,
        signature: headers.signature,
        timestamp: headers.timestamp,
        secret: ctx.config.photonWebhookSigningSecret,
        now,
      });
    },
    accept(rawBody) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return { enqueued: false };
      }
      const msg = fromPhoton(parsed);
      if (!msg) return { enqueued: false };
      queue.enqueue(msg);
      return { enqueued: true };
    },
    drain: () => queue.drain(),
  };
}

/** Null-object runtime for tests that never touch the webhook route. */
export function stubInboundRuntime(): InboundRuntime {
  return { verify: () => "missing-headers", accept: () => ({ enqueued: false }), drain: async () => undefined };
}