import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { createApp } from "./server.ts";
import { seedOnBoot } from "./ingest/scenario.ts";

export async function startServer(onStarted?: () => void) {
  const config = loadConfig();
  const app = createApp(config);
  const server = serve({ fetch: app.fetch, port: config.port }, onStarted);
  process.on("SIGTERM", () => server.close());
  // Demo seed: with REPLAY=1 and an empty Mongo, load the shelter/camera fixtures.
  // Never blocks or fails boot — Mongo may still be down; the first replay call also seeds.
  seedOnBoot(config)
    .then((result) => {
      if (result) console.log("seed-on-boot: demo resources + cameras loaded");
    })
    .catch((err) => console.error("seed-on-boot skipped:", err instanceof Error ? err.message : err));
  return server;
}

startServer(() => {
  console.log(`skywatch api listening on :${process.env["PORT"] ?? "3000"}`);
});