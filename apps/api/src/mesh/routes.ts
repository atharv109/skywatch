import { Hono } from "hono";
import type { Config } from "../config.ts";
import type { AppDeps } from "../deps.ts";
import { assembleMeshState } from "./state.ts";
import { SyncError, processSync } from "./sync.ts";

/**
 * Task 8 Offline Mode (mesh) endpoints — the backend side of the phones-only
 * transport: dark phones relay over a Wi-Fi hotspot LAN (WebRTC, frontend page);
 * the self-discovered GATEWAY node POSTs the whole queued batch here and
 * rebroadcasts the returned downlink bundle. TTL decrement / hop counting happen
 * at the relay — the backend knows nothing about WebRTC, this is a pure HTTP
 * batch contract.
 *
 *   POST /mesh/sync  { deviceId, lat, lon, packets[] } — gateway batch, packet sigs
 *                    are the auth (Ed25519, first-packet pubkey pinning, demo-grade
 *                    TOFU): deliberately NOT behind TOOL_SECRET. Batch cap 200.
 *   GET  /mesh/state — the dark-zone dashboard layer; open-read exactly like
 *                    GET /map/state (privacy: never a phone number or raw deviceId).
 *
 * REPLAY DECISION (final-review carry, explicit): both routes run IDENTICALLY in
 * REPLAY=0 and REPLAY=1 — there is NO config gate, and this module never even reads
 * `config`. A replayed fixture environment is simply a dark zone with no mesh
 * traffic until a gateway syncs; the decision to surface mesh data is made by data
 * existing, never by a flag silently switching endpoints off.
 */

/** Route-level guard: mesh dep unset (hermetic tests that did not wire it) = 503, not a crash. */
async function meshStore(deps: AppDeps) {
  if (!deps.mesh) throw new SyncError("mesh store not configured", 503);
  return deps.mesh();
}

export function meshRoutes(config: Config, deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/sync", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "body must be a JSON object" }, 400);
    try {
      const store = await meshStore(deps);
      const match = await deps.match();
      const result = await processSync(store, match, body, Date.now());
      return c.json(result);
    } catch (err) {
      if (err instanceof SyncError) {
        return c.json({ error: err.message }, err.status);
      }
      console.error("mesh/sync failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "mesh sync failed" }, 503);
    }
  });

  app.get("/state", async (c) => {
    try {
      const store = await meshStore(deps);
      return c.json(await assembleMeshState(store, Date.now()));
    } catch (err) {
      if (err instanceof SyncError) {
        return c.json({ error: err.message }, err.status);
      }
      console.error("mesh/state failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "mesh state unavailable" }, 503);
    }
  });

  return app;
}