import { Hono } from "hono";
import type { Config } from "../config.ts";
import type { AppDeps } from "../deps.ts";
import { buildUserBrief } from "../brief/build.ts";
import type { UserRecord } from "../deliver/store.ts";

/**
 * Tool endpoints for the ElevenLabs agents (backend-build-plan.md Task 4) — NOT on
 * the public map routes:
 *   GET /tools/brief/:userId                    — the current brief as dynamic variables
 *   GET /tools/brief/byPhone/:platform/:phone   — the voice agent resolves by number
 *
 * Auth decision (demo-grade, documented for the task report + open to VEYZL comment):
 * when TOOL_SECRET is set both routes require a matching `X-Skywatch-Tool-Secret`
 * header (or `Authorization: Bearer <TOOL_SECRET>`); when it is unset they answer
 * unauthenticated. A production pass would make the secret mandatory. The check
 * itself lives in src/tools/auth.ts (shared with the Task 6 tool endpoints).
 *
 * Privacy: the byPhone lookup never logs or echoes the phone number (no console
 * output containing it, 404 bodies are a fixed sentence) and reads write no outbox
 * row — a brief fetch is not a delivery, so the rate gates are untouched.
 */
import { toolSecretDenied } from "../tools/auth.ts";

export function toolRoutes(config: Config, deps: AppDeps): Hono {
  const app = new Hono();

  // Shared-secret check: null = allow (unset config or a matching header — the
  // exact accepted header forms live in src/tools/auth.ts).
  const deniedFor = (headers: Record<string, string | undefined>) => toolSecretDenied(config, headers);

  async function briefForUser(user: UserRecord | null): Promise<{ brief?: unknown; missing?: string }> {
    // Task 8-urgent ruling: the PHONE is the identity — the platform is only the
    // delivery-channel preference, so the byPhone lookup filters by phone ONLY
    // (never by platform): a user signed up on the Photon iMessage line must brief
    // through the sms-segment URL too (live-proven: the judge's brief caller).
    if (!user) return { missing: "unknown user" };
    if (!user.loc) return { missing: "user has no resolved location" };
    const match = await deps.match();
    const brief = await buildUserBrief(match, { id: user.id, lang: user.lang, loc: user.loc }, Date.now());
    return { brief };
  }

  app.get("/brief/byPhone/:platform/:phone", async (c) => {
    if (deniedFor(c.req.header())) return c.json({ error: "missing or wrong tool secret" }, 401);
    // The :platform segment is URL-COMPAT only (the ElevenLabs agent tool config
    // keeps its shape); spelling doesn't matter ('iMessage'/'SMS' pass) — the
    // lookup is by phone. Truly unknown segments still 404 (honest garbage guard).
    const platform = c.req.param("platform").toLowerCase();
    if (platform !== "imessage" && platform !== "sms") {
      return c.json({ error: "unknown platform (use imessage|sms)" }, 404);
    }
    try {
      const deliver = await deps.deliver();
      const user = await deliver.getUserByPhone(c.req.param("phone"));
      const result = await briefForUser(user);
      if (result.missing) return c.json({ error: result.missing }, 404);
      return c.json(result.brief);
    } catch (err) {
      console.error("tools/brief byPhone failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "brief unavailable" }, 503);
    }
  });

  app.get("/brief/:userId", async (c) => {
    if (deniedFor(c.req.header())) return c.json({ error: "missing or wrong tool secret" }, 401);
    try {
      const deliver = await deps.deliver();
      const user = await deliver.getUserById(c.req.param("userId"));
      const result = await briefForUser(user);
      if (result.missing) return c.json({ error: result.missing }, 404);
      return c.json(result.brief);
    } catch (err) {
      console.error("tools/brief failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "brief unavailable" }, 503);
    }
  });

  /**
   * Task 8f: the cached Grok Voice mp3 of a user's post-call summary recap, by
   * OUTBOX ROW id (the dashboard links it from outbox views). Streams the bytes
   * (immutable — a sha-keyed cache row is deterministic); nothing cached/absent
   * = 404. Same tool-secret posture as the brief reads.
   */
  app.get("/summary-audio/:outboxId", async (c) => {
    if (deniedFor(c.req.header())) return c.json({ error: "missing or wrong tool secret" }, 401);
    try {
      const deliver = await deps.deliver();
      const row = await deliver.getOutboxRow(c.req.param("outboxId"));
      const sha = row?.meta?.audio?.sha ?? null;
      if (!sha) return c.json({ error: "no summary audio for this outbox row" }, 404);
      // No ttsCache dep wired (hermetic harnesses) = nothing to serve.
      if (!deps.ttsCache) return c.json({ error: "summary audio cache not configured" }, 503);
      const cached = await (await deps.ttsCache()).get(sha);
      if (!cached) return c.json({ error: "no such summary audio" }, 404);
      return c.body(Buffer.from(cached.bytes, "base64"), 200, {
        "Content-Type": cached.contentType,
        // sha-keyed content is deterministic mp3 — immutable forever.
        "Cache-Control": "public, max-age=31536000, immutable",
      });
    } catch (err) {
      console.error("tools/summary-audio failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "summary audio unavailable" }, 503);
    }
  });

  return app;
}