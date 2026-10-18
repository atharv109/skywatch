import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Config } from "./config.ts";
import { defaultDeps, type AppDeps } from "./deps.ts";
import { routes } from "./routes/index.ts";

/** deps only widened for tests — default wiring goes through Mongo (db/client.ts). */
export function createApp(config: Config, deps: AppDeps = defaultDeps(config)): Hono {
  const app = new Hono();
  app.route("/", routes(config, deps));
  app.get("/health", (c) => c.json({ ok: true }));
  // Static demo app (apps/web copied to apps/api/public by the build — scripts/copy-web.mjs).
  // Registered LAST so every API route above wins; a miss falls through to Hono's 404.
  // `root` resolves against cwd, which is apps/api on both dev and Render starts.
  app.use("*", serveStatic({ root: "./public", index: "index.html" }));
  return app;
}