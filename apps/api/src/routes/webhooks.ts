import { Hono } from "hono";
import type { Config } from "../config.ts";
import type { AppDeps } from "../deps.ts";

/**
 * POST /webhooks/photon/message — Stable Spectrum inbound-message delivery
 * (photon-interface.md): verify X-Spectrum-Signature/Timestamp on the RAW body,
 * ack 2xx immediately, enqueue the (id-guarded) in-process queue, process async.
 * Per the delivery contract: 4xx here is fatal-no-retry, so signature failures are
 * deliberate 401s and only "ok" bodies reach the queue.
 */
export function webhookRoutes(config: Config, deps: AppDeps): Hono {
  void config;
  const app = new Hono();
  app.post("/photon/message", async (c) => {
    // Raw body text only — never re-serialized before HMAC (verification contract).
    const raw = await c.req.text();
    const verdict = deps.inbound.verify(
      raw,
      {
        signature: c.req.header("X-Spectrum-Signature"),
        timestamp: c.req.header("X-Spectrum-Timestamp"),
      },
      Date.now(),
    );
    switch (verdict) {
      case "ok":
        break;
      case "missing-headers":
        return c.json({ error: "missing X-Spectrum-Signature / X-Spectrum-Timestamp headers" }, 400);
      case "no-signing-secret":
        // Fail closed: with no signing secret nothing can be verified (documented
        // divergence — Photon cannot deliver until PHOTON_WEBHOOK_SIGNING_SECRET is set).
        return c.json({ error: "server has no PHOTON_WEBHOOK_SIGNING_SECRET configured; rejecting" }, 401);
      default:
        return c.json({ error: `bad signature (${verdict})` }, 401);
    }
    // Non-"messages" events / non-text content arms / malformed JSON ack and drop.
    const { enqueued } = deps.inbound.accept(raw);
    return c.json({ ok: true, enqueued }, 200);
  });

  /**
   * POST /webhooks/voice/post-call — the ElevenLabs post_call_transcription webhook
   * (Task 6): fail-closed HMAC verify on the RAW body
   * (ELEVENLABS_VOICE_WEBHOOK_SECRET, scheme in src/deliver/voice.ts), then ack 200
   * immediately and process async (id-guarded on conversation_id).
   */
  app.post("/voice/post-call", async (c) => {
    const raw = await c.req.text();
    const verdict = deps.voice.check(raw, c.req.header("elevenlabs-signature"), Date.now());
    switch (verdict) {
      case "ok":
        break;
      case "missing-header":
        return c.json({ error: "missing elevenlabs-signature header" }, 400);
      case "no-secret":
        return c.json({ error: "server has no ELEVENLABS_VOICE_WEBHOOK_SECRET configured; rejecting" }, 401);
      default:
        return c.json({ error: `bad signature (${verdict})` }, 401);
    }
    const { enqueued } = deps.voice.accept(raw);
    return c.json({ ok: true, enqueued }, 200);
  });
  return app;
}