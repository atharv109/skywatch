import { Hono } from "hono";
import type { Config } from "../config.ts";
import type { AppDeps } from "../deps.ts";
import { toolSecretDenied } from "../tools/auth.ts";
import { adapterFor, applyRoadCheck, RoadCheckError } from "./check.ts";

/**
 * POST /roads/check (Task 6) — one camera verdict from the vision service (or a
 * human fallback): {cameraId, status clear|flooded|blocked|unknown, confidence 0..1}.
 * Auth: the shared tool secret (src/tools/auth.ts) when TOOL_SECRET is set. The
 * vision adapter seam is reported in the response and stays NOT WIRED — the API
 * never makes live vision calls (PERCEPTRON_API_KEY holders POST verdicts here).
 */
export function roadRoutes(config: Config, deps: AppDeps): Hono {
  const app = new Hono();
  app.post("/check", async (c) => {
    if (toolSecretDenied(config, c.req.header())) return c.json({ error: "missing or wrong tool secret" }, 401);
    const body = await c.req.json<{ cameraId?: unknown; status?: unknown; confidence?: unknown }>().catch(() => null);
    if (!body || typeof body.cameraId !== "string" || body.cameraId.length === 0) {
      return c.json({ error: "body must include cameraId (string)" }, 400);
    }
    if (typeof body.status !== "string") {
      return c.json({ error: "body must include status (clear|flooded|blocked|unknown)" }, 400);
    }
    try {
      const store = await deps.store(config);
      const result = await applyRoadCheck(
        store,
        { cameraId: body.cameraId, status: body.status as never, confidence: body.confidence as number },
        Date.now(),
      );
      return c.json({
        ok: true,
        cameraId: result.stored.cameraId,
        status: result.status,
        confidence: result.confidence,
        verifiedAt: result.stored.verifiedAt,
        vision: adapterFor(config),
      });
    } catch (err) {
      if (err instanceof RoadCheckError) return c.json({ error: err.message }, err.code);
      console.error("roads/check failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "road check failed" }, 503);
    }
  });
  return app;
}