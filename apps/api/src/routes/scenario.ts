import { Hono } from "hono";
import type { Config } from "../config.ts";
import type { AppDeps } from "../deps.ts";
import { loadScenario, type ScenarioId } from "../ingest/scenario.ts";
import { toolSecretDenied } from "../tools/auth.ts";

const SCENARIOS: ScenarioId[] = ["smoke", "flood"];

/**
 * POST /scenario/:id/replay — load a fixture set into Mongo (upsert by doc keys,
 * so re-running never duplicates), then trigger the pipeline (stub until Task 4).
 *
 * Auth: SAME shared-secret scheme as the other tool/write routes (src/tools/auth.ts)
 * — a replay MUTATES the shared store, so it cannot stay open. When TOOL_SECRET is
 * unset it answers unauthenticated (demo-grade, matching the Task 4 decision; the
 * boot warning in index.ts covers that posture).
 */
export function scenarioRoutes(config: Config, deps: AppDeps): Hono {
  const app = new Hono();
  app.post("/:id/replay", async (c) => {
    if (toolSecretDenied(config, c.req.header())) return c.json({ error: "missing or wrong tool secret" }, 401);
    const id = c.req.param("id") as ScenarioId;
    if (!SCENARIOS.includes(id)) {
      return c.json({ error: `unknown scenario '${id}' (use smoke|flood)` }, 404);
    }
    try {
      const store = await deps.store(config);
      const loaded = await loadScenario(store, id);
      const pipeline = await deps.pipeline({ config, store, match: deps.match, deliver: deps.deliver });
      return c.json({ ok: true, ...loaded, pipelineRan: true, pipeline });
    } catch (err) {
      console.error(`replay '${id}' failed:`, err);
      return c.json({ error: err instanceof Error ? err.message : "replay failed" }, 503);
    }
  });
  return app;
}