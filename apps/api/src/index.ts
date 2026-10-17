import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { createApp } from "./server.ts";

export async function startServer(onStarted?: () => void) {
  const config = loadConfig();
  const app = createApp(config);
  const server = serve({ fetch: app.fetch, port: config.port }, onStarted);
  process.on("SIGTERM", () => server.close());
  return server;
}

startServer(() => {
  console.log(`skywatch api listening on :${process.env["PORT"] ?? "3000"}`);
});