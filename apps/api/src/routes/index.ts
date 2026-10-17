import { Hono } from "hono";
import type { Config } from "../config.ts";
import { defaultDeps, type AppDeps } from "../deps.ts";
import { scenarioRoutes } from "./scenario.ts";
import { mapRoutes } from "./map.ts";
import { webhookRoutes } from "./webhooks.ts";

/**
 * Route groups: scenario replay (Task 2), map state/stream (Task 2),
 * webhooks (Task 3), later: tools (Task 6).
 */
export function routes(config: Config, deps: AppDeps = defaultDeps(config)): Hono {
  const app = new Hono();
  app.route("/scenario", scenarioRoutes(config, deps));
  app.route("/map", mapRoutes(config, deps));
  app.route("/webhooks", webhookRoutes(config, deps));
  return app;
}