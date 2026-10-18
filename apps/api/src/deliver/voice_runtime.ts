/**
 * Wiring between POST /webhooks/voice/post-call and the voice outcome modules
 * (Task 6) — mirrors src/deliver/runtime.ts: verify on the RAW body, id-guarded
 * sequential async processing after the 2xx ack (dedupe key: conversation_id).
 */
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { createInboundQueue } from "./queue.ts";
import { mongoDeliverStore, type DeliverStore } from "./store.ts";
import { mongoVerifyStore } from "../verify/store.ts";
import { mongoTtsCache, type TtsCache } from "./grok-tts.ts";
import { outcomeFor, processVoiceOutcome, verifyVoiceWebhook, type VoiceVerifyResult, type VoicePostCallPayload } from "./voice.ts";

export interface VoiceRuntime {
  check(rawBody: string, header: string | null | undefined, now: number): VoiceVerifyResult;
  /** Parse + guard + enqueue one raw webhook body; false = acked but nothing to do. */
  accept(rawBody: string): { enqueued: boolean };
  /** Test seam: resolves once everything enqueued so far has been processed. */
  drain(): Promise<void>;
}

/**
 * Every store is optional — a landed test harness overriding one does not disturb
 * the defaults. Task 8f: `ttsCache` rides to processVoiceOutcome (the post-call
 * summary's Grok TTS audio); unset = no cached audio is read/written (features
 * degrade to null, the text path is unaffected).
 */
export function createVoiceRuntime(
  config: Config,
  stores: {
    deliver?: () => Promise<DeliverStore>;
    verify?: () => Promise<import("../verify/store.ts").VerifyStore>;
    ttsCache?: () => Promise<TtsCache>;
  } = {},
): VoiceRuntime {
  const deliverOf = stores.deliver ?? (() => getDb(config).then(mongoDeliverStore));
  const verifyOf = stores.verify ?? (() => getDb(config).then(mongoVerifyStore));
  const queue = createInboundQueue<VoicePostCallPayload>(
    async (payload) => {
      await processVoiceOutcome(payload, {
        config,
        deliver: await deliverOf(),
        verify: await verifyOf(),
        ...(stores.ttsCache ? { ttsCache: stores.ttsCache } : {}),
        now: Date.now(),
      });
    },
    { dedupeKey: (payload) => payload.data?.conversation_id ?? undefined },
  );
  return {
    check(rawBody, header, now) {
      return verifyVoiceWebhook({ rawBody, signature: header, secret: config.elevenlabsVoiceWebhookSecret, now });
    },
    accept(rawBody) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return { enqueued: false };
      }
      // Routable types: post_call_transcription carrying an outcome, and
      // call_initiation_failure (the failure latch release, Task 6 fix round 1).
      // Everything else (post_call_audio, unknown future types) acks and drops.
      if (typeof parsed !== "object" || parsed === null) return { enqueued: false };
      const payload = parsed as VoicePostCallPayload;
      const routable =
        payload.type === "call_initiation_failure" || outcomeFor(payload) !== null;
      if (!routable) return { enqueued: false };
      queue.enqueue(payload);
      return { enqueued: true };
    },
    drain: () => queue.drain(),
  };
}

/** Null-object runtime for tests that never touch the voice webhook route. */
export function stubVoiceRuntime(): VoiceRuntime {
  return { check: () => "missing-header", accept: () => ({ enqueued: false }), drain: async () => undefined };
}