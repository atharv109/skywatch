import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../config.ts";
import type { AppDeps } from "../deps.ts";
import { assembleMapState, type MapState } from "../map/state.ts";
import { assembleMeshState } from "../mesh/state.ts";

const REFRESH_MS = 5_000;

/**
 * GET /map/state  — full snapshot (no phone numbers/user ids, Global Constraint 7).
 * GET /map/stream — SSE: initial full state event, then a full-state summary every
 * 5 s. The loop is driven by `stream.sleep()` inside Hono's streaming helper: no
 * setInterval, so nothing holds the Node event loop or a timer hostage — the loop
 * simply ends when the client disconnects (`stream.aborted`).
 *
 * Task 8 (mesh): the assembled state carries an optional `mesh` section — the
 * dark-zone layer — present ONLY when at least one mesh packet exists. The
 * appearance of the section is data-driven, never config-gated (the REPLAY
 * decision for the mesh endpoints lives in src/mesh/routes.ts).
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
    const state = assembleMapState({ hazards, resources, roads, dots, userCount });
    if (deps.mesh) {
      // The same resources ride the mesh section's Task 8b `resources` pins.
      const meshState = await assembleMeshState(await deps.mesh(), Date.now(), resources);
      // One key, data-gated: zero packets = the zone is absent from the map.
      if (meshState.counts.packets > 0) state.mesh = meshState;
    }
    return state;
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