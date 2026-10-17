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
import type { UserBrief } from "../types/brief.ts";
import type { DeliverStore, UserRecord } from "./store.ts";
import type { VerifyStore } from "../verify/store.ts";
import { sendOutbound, type SendContext } from "./send.ts";

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

/** Loose on-purpose: unknown event types (`post_call_audio`) ack+drop. */
export interface VoicePostCallPayload {
  type?: string;
  data?: {
    agent_id?: string;
    conversation_id?: string;
    status?: string;
    user_id?: string | null;
    failure_reason?: string;
    /** call_initiation_failure SIP detail (from_number/to_number/error_reason...). */
    sip?: { body?: { error_reason?: string } } | null;
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
 * The user-routed post-call summary (demo beat 6): right after the conversation
 * note, a deterministic summary text is composed ONLY from the user's lastBrief
 * fields and sent through the existing deliver path (toPhoton + outbox row).
 * No Gemini call, no network. Provenance marker: kind "alert" with the reserved
 * rateKey below (OutboxMeta is unused — no rendering happened); identifiable in
 * the outbox by that rateKey.
 *
 * RATE-LIMIT EXEMPTION (Global Constraint 3, documented): the 1/user/hazard/2h
 * gate never consults this rateKey (deliverAlert callers use hazard sourceIds),
 * and the summary is deliberately ungated here — it is part of the same alert
 * interaction the user just had on the phone, not a new hazard push.
 */
export const POST_CALL_SUMMARY_RATE_KEY = "post-call-summary";

/** Map link: PUBLIC_BASE_URL/b/<userId> when PUBLIC_BASE_URL is set; unset = no link (config defaulting makes config.publicBaseUrl undistinguishable from unset). */
function mapLink(publicBaseUrlSet: boolean, publicBaseUrl: string, userId: string): string | null {
  if (!publicBaseUrlSet) return null;
  return `${publicBaseUrl.replace(/\/+$/, "")}/b/${userId}`;
}

/** Deterministic post-call summary: hazard title + top action + verified shelter (confidence >= 0.5) else "check official source" + optional map link + the 911 line. */
export function postCallSummary(
  brief: UserBrief,
  userId: string,
  publicBaseUrlSet: boolean,
  publicBaseUrl: string,
): string {
  const title = brief.hazards[0]?.title ?? null;
  const topAction = brief.actions[0]?.text ?? null;
  const shelter =
    brief.shelter && brief.shelter.confidence >= 0.5 && brief.shelter.status === "open"
      ? `${brief.shelter.name} is verified open`
      : "check official source for shelter status";
  const parts = [
    title ? `Skywatch follow-up: ${title}` : "Skywatch follow-up",
    topAction,
    shelter,
    mapLink(publicBaseUrlSet, publicBaseUrl, userId),
  ].filter((part): part is string => part !== null);
  return `${parts.join(" ")}\n${brief.emergency}`;
}

/**
 * Deterministic summary send (no Gemini): consent-checked, skipped when the
 * conversation carries no lastBrief. Never throws — sendOutbound records
 * (not_wired/failed) instead, the routing result is unaffected.
 */
async function sendPostCallSummary(
  deps: { config: Config; deliver: DeliverStore; now: number },
  user: UserRecord,
): Promise<void> {
  if (!user.consentText) return; // STOP/revoked: nothing sent (Global Constraint 3)
  const brief = await deps.deliver.lastBrief(user.id);
  if (!brief) return; // no alert interaction to summarize; the conversation note still stands
  const set = Boolean(process.env["PUBLIC_BASE_URL"]);
  const text = postCallSummary(brief, user.id, set, deps.config.publicBaseUrl);
  const ctx: SendContext = { config: deps.config, store: async () => deps.deliver, now: () => deps.now };
  await sendOutbound(ctx, user, text, "alert", POST_CALL_SUMMARY_RATE_KEY);
}

/**
 * The queue's processing target. Two routable events:
 * - post_call_transcription: outcome + transcript routed to its conversation
 *   (user_id → user) or its verify request (agent_id → dispatch).
 * - call_initiation_failure: the call never happened — a dispatched request
 *   MUST leave "dispatched" (otherwise it latches forever and the next unrelated
 *   outcome pins onto it): recorded as answered `no-answer:<reason>`, plus a
 *   conversation note when the payload carries a user_id.
 */
export async function processVoiceOutcome(
  payload: VoicePostCallPayload,
  deps: { config: Config; deliver: DeliverStore; verify: VerifyStore; now: number },
): Promise<{ matched: "user" | "verify_request" | "none" }> {
  if (payload.type === "call_initiation_failure") return processCallFailure(payload, deps);
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
      // Demo beat 6: a post-call summary text accompanies the note (rate-limit
      // exempt, part of the same alert interaction — see sendPostCallSummary).
      await sendPostCallSummary(deps, user);
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

/** elevenlabs-sip-notes.md §2c/§4: failure_reason is "busy" | "no-answer" | "unknown". */
function failureReason(payload: VoicePostCallPayload): string {
  const data = payload.data ?? {};
  const reason = data.failure_reason ?? data.sip?.body?.error_reason;
  return typeof reason === "string" && reason.trim().length > 0 ? reason.trim().slice(0, 100) : "unknown";
}

async function processCallFailure(
  payload: VoicePostCallPayload,
  deps: { config: Config; deliver: DeliverStore; verify: VerifyStore; now: number },
): Promise<{ matched: "user" | "verify_request" | "none" }> {
  const data = payload.data ?? {};
  const reason = failureReason(payload);
  const userId = typeof data.user_id === "string" ? data.user_id : null;
  let matched: "user" | "verify_request" | "none" = "none";
  if (userId) {
    const user = await deps.deliver.getUserById(userId);
    if (user) {
      await deps.deliver.appendConversation({
        userId: user.id,
        from: "bot",
        text: `Voice call could not start (${reason}).`,
        at: deps.now,
      });
      matched = "user";
    }
  }
  const agentId = typeof data.agent_id === "string" ? data.agent_id : null;
  if (agentId) {
    const request = await deps.verify.latestDispatchedByAgent(agentId);
    if (request) {
      // Releasing the latch is the point: an answered failure can never swallow
      // a later outcome for this agent.
      await deps.verify.recordOutcome(request.requestId, `no-answer:${reason}`, data.conversation_id ?? null, deps.now);
      return { matched: "verify_request" };
    }
  }
  return { matched };
}