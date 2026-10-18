import { Hono } from "hono";
import type { Config } from "../config.ts";
import type { AppDeps } from "../deps.ts";
import { toolSecretDenied } from "../tools/auth.ts";
import { applyCheckin, CheckinError, CHECKIN_STATUSES, type CheckinBody } from "../verify/checkin.ts";
import { createVerifyRuns } from "../verify/run.ts";
import { buildStatusEvent, forwardStatusEvents } from "../verify/tiger.ts";

/**
 * Task 6 tool endpoints (shared-secret scheme: src/tools/auth.ts — checked only
 * when TOOL_SECRET is set):
 *   POST /tools/checkin       {resourceId, status open|full|closed|unknown, capacity?, notes?,
 *                              manual?: true, userId?: <opaque>} — the ONE check-in endpoint
 *                              (voice path and dashboard path differ only in `manual`).
 *   GET  /tools/checkin/next?deviceId= — Delivery's Check-in agent consumes its queue
 *                              (poll contract; marks requests dispatched).
 *   POST /verify/run          {deviceId?} — create check-in requests for partner
 *                              resources inside active hazards; returns the list.
 *
 * Privacy: phones never enter this path (see verify/store.ts header); a check-in
 * note lands on a conversation only when the caller explicitly carries a userId.
 */
export function checkinToolRoutes(config: Config, deps: AppDeps): Hono {
  const app = new Hono();
  const denied = (headers: Record<string, string | undefined>) => toolSecretDenied(config, headers);

  app.post("/checkin", async (c) => {
    if (denied(c.req.header())) return c.json({ error: "missing or wrong tool secret" }, 401);
    const body = await c.req.json<Partial<CheckinBody>>().catch(() => null);
    if (!body || typeof body.resourceId !== "string" || body.resourceId.length === 0 || body.resourceId.length > 128) {
      return c.json({ error: "body must include resourceId (string, 1..128 chars)" }, 400);
    }
    if (typeof body.status !== "string" || !(CHECKIN_STATUSES as readonly string[]).includes(body.status)) {
      return c.json({ error: `status must be one of: ${CHECKIN_STATUSES.join("|")}` }, 400);
    }
    // Size caps, same pattern as the rest of the codebase (mesh photo ids ≤128,
    // demo texts ≤140×5): an unbounded check-in body must never reach the store.
    // The persist path STILL truncates stored notes to 200 (verify/checkin.ts).
    if (typeof body.notes === "string" && body.notes.length > 4000) {
      return c.json({ error: "notes must be 4000 chars or fewer" }, 400);
    }
    if (body.userId !== undefined && body.userId !== null && (typeof body.userId !== "string" || body.userId.length === 0 || body.userId.length > 128)) {
      return c.json({ error: "userId must be a string of 1..128 chars" }, 400);
    }
    if (body.capacity !== undefined && body.capacity !== null && (!Number.isFinite(Number(body.capacity)) || Number(body.capacity) > 1_000_000)) {
      return c.json({ error: "capacity must be a finite number up to 1000000" }, 400);
    }
    try {
      const store = await deps.store(config);
      const result = await applyCheckin(
        store,
        body.resourceId,
        { ...body, resourceId: body.resourceId, status: body.status as CheckinBody["status"] },
        Date.now(),
      );
      // Optional Tiger Data mirror (Task 7): fire-and-forget, inert when
      // TIGER_DATABASE_URL is unset; a mirror failure must never fail the check-in.
      const tigerEvent = buildStatusEvent(result.resource);
      if (tigerEvent) forwardStatusEvents(config, [tigerEvent]);
      const deliver = await deps.deliver();
      if (result.note && body.userId) {
        const user = await deliver.getUserById(String(body.userId));
        if (user) {
          // Shared helper write only — no direct conversation inserts.
          await deliver.appendConversation({ userId: user.id, from: "bot", text: result.note, at: Date.now() });
        }
      }
      return c.json({
        ok: true,
        manual: body.manual === true,
        resource: {
          sourceId: result.resource.sourceId,
          name: result.resource.name,
          status: result.resource.status,
          verifiedAt: result.resource.verifiedAt,
          capacity: result.resource.capacity ?? null,
          lastCheckin: result.resource.lastCheckin ?? null,
        },
      });
    } catch (err) {
      if (err instanceof CheckinError) return c.json({ error: err.message }, err.code);
      console.error("tools/checkin failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "check-in failed" }, 503);
    }
  });

  app.get("/checkin/next", async (c) => {
    if (denied(c.req.header())) return c.json({ error: "missing or wrong tool secret" }, 401);
    try {
      const deviceIdRaw = c.req.query("deviceId") ?? null;
      const verify = await deps.verify();
      const requests = await verify.checkoutPending(deviceIdRaw, Date.now());
      return c.json({ requests });
    } catch (err) {
      console.error("tools/checkin/next failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "verify queue unavailable" }, 503);
    }
  });

  return app;
}

export function verifyRunRoutes(config: Config, deps: AppDeps): Hono {
  const app = new Hono();
  app.post("/run", async (c) => {
    if (toolSecretDenied(config, c.req.header())) return c.json({ error: "missing or wrong tool secret" }, 401);
    const body = await c.req.json<{ deviceId?: string | null }>().catch(() => ({}) as { deviceId?: string | null });
    try {
      const store = await deps.store(config);
      const verify = await deps.verify();
      const result = await createVerifyRuns(store, verify, config, { deviceId: body?.deviceId ?? null, now: Date.now() });
      return c.json({ ok: true, created: result.created });
    } catch (err) {
      console.error("verify/run failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "verify run failed" }, 503);
    }
  });
  return app;
}