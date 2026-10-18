import { Hono } from "hono";
import type { Config } from "../config.ts";
import { defaultDeps, type AppDeps } from "../deps.ts";
import { scenarioRoutes } from "./scenario.ts";
import { mapRoutes } from "./map.ts";
import { webhookRoutes } from "./webhooks.ts";
import { toolRoutes } from "./tools.ts";
import { checkinToolRoutes, verifyRunRoutes } from "../verify/routes.ts";
import { roadRoutes } from "../roads/routes.ts";
import { meshRoutes } from "../mesh/routes.ts";
import { demoRoutes } from "./demo.ts";

/**
 * Route groups: scenario replay (Task 2), map state/stream (Task 2),
 * webhooks (Task 3 + Task 6 voice post-call), tool brief endpoints (Task 4),
 * check-in/verify tools (Task 6), roads check (Task 6), mesh (Task 8),
 * demo onboarding (Task 8g, DEMO_SIGNUP-gated).
 */
export function routes(config: Config, deps: AppDeps = defaultDeps(config)): Hono {
  const app = new Hono();
  app.route("/scenario", scenarioRoutes(config, deps));
  app.route("/map", mapRoutes(config, deps));
  app.route("/webhooks", webhookRoutes(config, deps));
  app.route("/tools", toolRoutes(config, deps));
  app.route("/tools", checkinToolRoutes(config, deps));
  app.route("/verify", verifyRunRoutes(config, deps));
  app.route("/roads", roadRoutes(config, deps));
  app.route("/mesh", meshRoutes(config, deps));
  app.route("/demo", demoRoutes(config, deps));
  return app;
}