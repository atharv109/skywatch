import { Hono } from "hono";
import type { Config } from "./config.ts";
import { defaultDeps, type AppDeps } from "./deps.ts";
import { routes } from "./routes/index.ts";

/** deps only widened for tests — default wiring goes through Mongo (db/client.ts). */
export function createApp(config: Config, deps: AppDeps = defaultDeps(config)): Hono {
  const app = new Hono();
  app.route("/", routes(config, deps));
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}