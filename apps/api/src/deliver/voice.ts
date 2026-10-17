/**
 * Task 6: POST /webhooks/voice/post-call — the ElevenLabs post_call_transcription
 * webhook (skywatch-notes/elevenlabs-sip-notes.md §2c). Same shape as the Photon
 * webhook: verify the shared-secret HMAC on the RAW body, ack 200 immediately,
 * process async (id-guarded queue — the docs say webhooks can be retried, dedupe
 * on conversation_id).
 *
 * Signature contract (documented for Delivery): header `elevenlabs-signature:` with
 * value `t=<unix-seconds>,v1=<hex>` — HMAC-SHA256 over `<t>.<rawBody>` keyed by
 * ELEVENLABS_VOICE_WEBHOOK_SECRET. Fail closed: 401 when the secret is unset or the
 * signature mismatches.
 *
 * Conversation routing (the chosen key, documented in the task report):
 *   1. `data.user_id` — when present, it IS the Skywatch user id (Delivery sets it
 *      as the ElevenLabs `user_id` custom id); the outcome is appended to that
 *      user's conversation.
 *   2. else `data.agent_id` — matched to the most recent dispatched verify-request;
 *      the outcome is recorded on that request (resource check-in, no user
 *      conversation involved).
 *   3. else: acked, logged without any personal data.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.ts";
import type { DeliverStore } from "./store.ts";
import type { VerifyStore } from "../verify/store.ts";

export type VoiceVerifyResult = "ok" | "bad-signature" | "missing-header" | "stale-timestamp" | "no-secret";

const STALE_AFTER_SECONDS = 300;

export function verifyVoiceWebhook(args: {
  rawBody: string;
  signature?: string | null | undefined;
  secret: string | null;
  now: number;
}): VoiceVerifyResult {
  if (!args.secret) return "no-secret";
  const header = args.signature?.trim() ?? "";
  const params = new Map<string, string>();
  for (const pair of header.split(",")) {
    const [key, value] = pair.trim().split("=", 2);
    if (key && value) params.set(key, value);
  }
  const timestamp = params.get("t");
  const signature = params.get("v1");
  if (!timestamp || !signature) return "missing-header";
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(args.now / 1000 - ts) > STALE_AFTER_SECONDS) return "stale-timestamp";
  const expected = createHmac("sha256", args.secret).update(`${timestamp}.${args.rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "bad-signature";
  return "ok";
}

/** Loose on-purpose: unknown event types (`post_call_audio`, `call_initiation_failure`) ack+drop. */
export interface VoicePostCallPayload {
  type?: string;
  data?: {
    agent_id?: string;
    conversation_id?: string;
    status?: string;
    user_id?: string | null;
    transcript?: Array<{ role?: string; message?: string } | null>;
    analysis?: { summary?: unknown } | null;
  } | null;
}

/** Outcome text: the analysis summary when present, else the user's last spoken turn. */
export function outcomeFor(payload: VoicePostCallPayload): string | null {
  const data = payload.data;
  if (!data) return null;
  const summary = data.analysis?.summary;
  if (typeof summary === "string" && summary.trim().length > 0) return summary.trim().slice(0, 400);
  const userTurns = (data.transcript ?? [])
    .filter((turn): turn is { role?: string; message: string } => Boolean(turn?.message))
    .filter((turn) => turn.role === "user");
  const last = userTurns.at(-1)?.message ?? null;
  return last ? last.trim().slice(0, 400) : null;
}

/**
 * The queue's processing target: route the outcome + transcript to its
 * conversation (user_id → user) or its verify request (agent_id → dispatch).
 */
export async function processVoiceOutcome(
  payload: VoicePostCallPayload,
  deps: { config: Config; deliver: DeliverStore; verify: VerifyStore; now: number },
): Promise<{ matched: "user" | "verify_request" | "none" }> {
  const data = payload.data;
  const outcome = outcomeFor(payload);
  if (!data || !outcome) {
    console.error("voice post-call: no usable outcome (un-routable payload, acked)");
    return { matched: "none" };
  }
  const userId = typeof data.user_id === "string" ? data.user_id : null;
  if (userId) {
    const user = await deps.deliver.getUserById(userId);
    if (user) {
      const label = deps.config.elevenlabsAgentIdBrief && data.agent_id === deps.config.elevenlabsAgentIdBrief
        ? "Brief call"
        : "Voice check-in call";
      const note = `${label} (${outcome})`.slice(0, 500);
      await deps.deliver.appendConversation({ userId: user.id, from: "bot", text: note, at: deps.now });
      return { matched: "user" };
    }
  }
  const agentId = typeof data.agent_id === "string" ? data.agent_id : null;
  if (agentId) {
    const request = await deps.verify.latestDispatchedByAgent(agentId);
    if (request) {
      await deps.verify.recordOutcome(request.requestId, outcome, data.conversation_id ?? null, deps.now);
      return { matched: "verify_request" };
    }
  }
  console.error("voice post-call: no matching conversation (acked, recorded nowhere)");
  return { matched: "none" };
}