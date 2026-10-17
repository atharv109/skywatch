import { Hono } from "hono";
import type { Config } from "../config.ts";
import { defaultDeps, type AppDeps } from "../deps.ts";
import { scenarioRoutes } from "./scenario.ts";
import { mapRoutes } from "./map.ts";
import { webhookRoutes } from "./webhooks.ts";
import { toolRoutes } from "./tools.ts";

/**
 * Route groups: scenario replay (Task 2), map state/stream (Task 2),
 * webhooks (Task 3), tool brief endpoints (Task 4).
 */
export function routes(config: Config, deps: AppDeps = defaultDeps(config)): Hono {
  const app = new Hono();
  app.route("/scenario", scenarioRoutes(config, deps));
  app.route("/map", mapRoutes(config, deps));
  app.route("/webhooks", webhookRoutes(config, deps));
  app.route("/tools", toolRoutes(config, deps));
  return app;
}