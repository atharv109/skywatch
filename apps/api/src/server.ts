import { Hono } from "hono";
import type { Config } from "./config.ts";
import { routes } from "./routes/index.ts";

export function createApp(config: Config): Hono {
  const app = new Hono();
  app.route("/", routes(config));
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}