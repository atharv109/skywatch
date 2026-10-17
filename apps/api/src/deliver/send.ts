/**
 * Outbound send + the deliver-time rate gate (backend-build-plan.md Task 3 /
 * Global Constraint 3: "no send without consent; max 1 alert per user per hazard
 * per 2 h; every outbound written to outbox" — outbox is the rate-limit lookup).
 */
import type { Config } from "../config.ts";
import { NotWiredError, toPhoton } from "./photon.ts";
import type { DeliverStore, OutboxKind, OutboxRecord, OutboxStatus, UserRecord } from "./store.ts";

export interface SendContext {
  config: Pick<Config, "photonProjectId" | "photonProjectSecret">;
  store: () => Promise<DeliverStore>;
  now: () => number;
}

/**
 * One outbound attempt: try toPhoton, whatever happens write the outbox row +
 * a bot-side conversation entry, and never propagate (NotWiredError and SDK
 * failures are statuses, not crashes — brief: "still write attempts to outbox so
 * the flow tests end-to-end without Delivery").
 */
export async function sendOutbound(
  ctx: SendContext,
  user: Pick<UserRecord, "id" | "spaceId" | "platform">,
  text: string,
  kind: OutboxKind = "reply",
  rateKey: string | null = null,
): Promise<OutboxStatus> {
  const store = await ctx.store();
  const now = ctx.now();
  const record: OutboxRecord = {
    userId: user.id,
    kind,
    rateKey,
    spaceId: user.spaceId,
    platform: user.platform,
    text,
    status: "failed",
    error: null,
    createdAt: now,
    sentAt: null,
  };
  try {
    await toPhoton(user.spaceId, text, ctx.config);
    record.status = "sent";
    record.sentAt = now;
  } catch (err) {
    record.status = err instanceof NotWiredError ? "not_wired" : "failed";
    record.error = err instanceof Error ? err.message : String(err);
  }
  await store.appendOutbox(record);
  await store.appendConversation({ userId: user.id, from: "bot", text, at: now });
  return record.status;
}

/** Global Constraint 3: max 1 alert per user per hazard per 2 h. */
export const ALERT_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * The gate itself (unit-tested with an injected clock). Only "sent"/"not_wired"
 * alert rows count — a rate_limited/failed row must not extend the block.
 */
export async function isAlertBlocked(
  store: DeliverStore,
  userId: string,
  rateKey: string,
  now: number,
): Promise<boolean> {
  const last = await store.lastOutboxAlert(userId, rateKey, now - ALERT_WINDOW_MS);
  return last !== null && (last.status === "sent" || last.status === "not_wired");
}

export type AlertOutcome = "sent" | "not_wired" | "failed" | "rate_limited";

/**
 * Deliver-time alert send for Task 5's pipeline: gate first by userId + rateKey
 * (scenario/type, commonly the hazard sourceId), then sendOutbound.
 */
export async function deliverAlert(
  ctx: SendContext,
  user: Pick<UserRecord, "id" | "spaceId" | "platform">,
  rateKey: string,
  text: string,
): Promise<AlertOutcome> {
  const store = await ctx.store();
  const now = ctx.now();
  if (await isAlertBlocked(store, user.id, rateKey, now)) {
    // Record the suppressed attempt so the gate is observable in the outbox
    // (status "rate_limited" — which the gate itself does not count).
    await store.appendOutbox({
      userId: user.id,
      kind: "alert",
      rateKey,
      spaceId: user.spaceId,
      platform: user.platform,
      text,
      status: "rate_limited",
      error: "rate limited: max 1 alert per user per hazard per 2 h",
      createdAt: now,
      sentAt: null,
    });
    return "rate_limited";
  }
  return sendOutbound(ctx, user, text, "alert", rateKey);
}