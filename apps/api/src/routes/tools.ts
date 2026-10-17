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
 * header; when it is unset they answer unauthenticated. A production pass would make
 * the secret mandatory.
 *
 * Privacy: the byPhone lookup never logs or echoes the phone number (no console
 * output containing it, 404 bodies are a fixed sentence) and reads write no outbox
 * row — a brief fetch is not a delivery, so the rate gates are untouched.
 */

const TOOL_SECRET_HEADER = "X-Skywatch-Tool-Secret";

export function toolRoutes(config: Config, deps: AppDeps): Hono {
  const app = new Hono();

  // Shared-secret check: null = allow (either unset config or matching header).
  const deniedFor = (headerValue: string | undefined) => {
    if (!config.toolSecret) return null;
    return headerValue === config.toolSecret ? null : true;
  };

  async function briefForUser(user: UserRecord | null, platform?: string): Promise<{ brief?: unknown; missing?: string }> {
    if (!user || (platform !== undefined && user.platform !== platform)) return { missing: "unknown user" };
    if (!user.loc) return { missing: "user has no resolved location" };
    const match = await deps.match();
    const brief = await buildUserBrief(match, { id: user.id, lang: user.lang, loc: user.loc }, Date.now());
    return { brief };
  }

  app.get("/brief/byPhone/:platform/:phone", async (c) => {
    if (deniedFor(c.req.header(TOOL_SECRET_HEADER))) return c.json({ error: "missing or wrong tool secret" }, 401);
    const platform = c.req.param("platform");
    if (platform !== "imessage" && platform !== "sms") {
      return c.json({ error: "unknown platform (use imessage|sms)" }, 404);
    }
    try {
      const deliver = await deps.deliver();
      const user = await deliver.getUserByPhone(c.req.param("phone"));
      const result = await briefForUser(user, platform);
      if (result.missing) return c.json({ error: result.missing }, 404);
      return c.json(result.brief);
    } catch (err) {
      console.error("tools/brief byPhone failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "brief unavailable" }, 503);
    }
  });

  app.get("/brief/:userId", async (c) => {
    if (deniedFor(c.req.header(TOOL_SECRET_HEADER))) return c.json({ error: "missing or wrong tool secret" }, 401);
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

  return app;
}