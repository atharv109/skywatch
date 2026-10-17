import { Hono } from "hono";
import type { Config } from "../config.ts";
import type { AppDeps } from "../deps.ts";
import { loadScenario, type ScenarioId } from "../ingest/scenario.ts";

const SCENARIOS: ScenarioId[] = ["smoke", "flood"];

/**
 * POST /scenario/:id/replay — load a fixture set into Mongo (upsert by doc keys,
 * so re-running never duplicates), then trigger the pipeline (stub until Task 4).
 */
export function scenarioRoutes(config: Config, deps: AppDeps): Hono {
  const app = new Hono();
  app.post("/:id/replay", async (c) => {
    const id = c.req.param("id") as ScenarioId;
    if (!SCENARIOS.includes(id)) {
      return c.json({ error: `unknown scenario '${id}' (use smoke|flood)` }, 404);
    }
    try {
      const store = await deps.store(config);
      const loaded = await loadScenario(store, id);
      await deps.pipeline({ config, store });
      return c.json({ ok: true, ...loaded, pipelineRan: true });
    } catch (err) {
      console.error(`replay '${id}' failed:`, err);
      return c.json({ error: err instanceof Error ? err.message : "replay failed" }, 503);
    }
  });
  return app;
}