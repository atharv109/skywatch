import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../config.ts";
import type { AppDeps } from "../deps.ts";
import { assembleMapState, type MapState } from "../map/state.ts";

const REFRESH_MS = 5_000;

/**
 * GET /map/state  — full snapshot (no phone numbers/user ids, Global Constraint 7).
 * GET /map/stream — SSE: initial full state event, then a full-state summary every
 * 5 s. The loop is driven by `stream.sleep()` inside Hono's streaming helper: no
 * setInterval, so nothing holds the Node event loop or a timer hostage — the loop
 * simply ends when the client disconnects (`stream.aborted`).
 */
export function mapRoutes(config: Config, deps: AppDeps): Hono {
  const app = new Hono();

  async function currentState(): Promise<MapState> {
    const store = await deps.store(config);
    const [hazards, resources, roads, dots, userCount] = await Promise.all([
      store.listHazards(),
      store.listResources(),
      store.listRoads(),
      store.listUserDots(),
      store.countUsers(),
    ]);
    return assembleMapState({ hazards, resources, roads, dots, userCount });
  }

  app.get("/state", async (c) => {
    try {
      return c.json(await currentState());
    } catch (err) {
      console.error("map/state failed:", err);
      return c.json({ error: err instanceof Error ? err.message : "map state unavailable" }, 503);
    }
  });

  app.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      let failureSent = false;
      for (;;) {
        try {
          const state = await currentState();
          await stream.writeSSE({ event: "state", data: JSON.stringify(state) });
        } catch (err) {
          // Keep the connection alive (a short Mongo hiccup must not kill the stream);
          // send the reason once so the client can show a degraded indicator.
          console.error("map/stream tick failed:", err);
          if (!failureSent) {
            failureSent = true;
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({ error: err instanceof Error ? err.message : "state unavailable" }),
            });
          }
        }
        if (stream.aborted) break;
        await stream.sleep(REFRESH_MS);
        if (stream.aborted) break;
      }
    }),
  );

  return app;
}