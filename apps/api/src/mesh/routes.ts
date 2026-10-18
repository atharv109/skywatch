import { Hono } from "hono";
import type { Config } from "../config.ts";
import type { AppDeps } from "../deps.ts";
import { makeSatelliteFetcher } from "./satellite.ts";
import { fetchRoute, osrmDistanceKm, preparedRoute, profileFor } from "../routes/osrm.ts";
import { assembleMeshState, hashPrefix } from "./state.ts";
import { makeSkywatchChat } from "./skywatch.ts";
import { SyncError, processSync } from "./sync.ts";
import {
  MESH_PHOTO_BYTES_CAP,
  MESH_PHOTO_LABELS,
  SKYWATCH_CORE_ID,
  type MeshPhotoDoc,
  type MeshPhotoLabel,
  type MeshRouteView,
} from "./types.ts";

/**
 * Task 10 directions seam: live OSRM ONLY when SKYWATCH_LIVE_SYNC=1 (the same
 * "this sync may touch the internet" knob as the satellite overlay); the COMMITTED
 * prepared pack (Wi-Fi-death fallback) serves ONLY under DEMO_SIGNUP=1 and logs
 * "prepared route served" — never presented as live. Both off = no routes key at
 * all (hermetic/offline determinism unchanged).
 */
function makeDirectionsFetcher(
  config: Config,
  deps: Pick<AppDeps, "match">,
  originOf: () => { lat: unknown; lon: unknown },
  injFetcher?: typeof fetch,
): (now: number) => Promise<MeshRouteView[]> {
  if (!config.liveSync && !config.demoSignup) return () => Promise.resolve([]);
  return async (now: number): Promise<MeshRouteView[]> => {
    const originRaw = originOf();
    const lat = originRaw.lat;
    const lon = originRaw.lon;
    if (typeof lat !== "number" || !Number.isFinite(lat) || typeof lon !== "number" || !Number.isFinite(lon)) return [];
    const match = await deps.match();
    // The VERIFIED-OPEN shelter (shelter-kind, open, confidence >= 0.5) — the same
    // resource the bundle's `nearestVerifiedShelter` shows this sync.
    const nearest = await match.nearestOpenResource({ type: "Point", coordinates: [lon, lat] }, now);
    if (!nearest) return [];
    const to = {
      shelterId: nearest.sourceId,
      name: nearest.name,
      lat: nearest.loc.coordinates[1],
      lon: nearest.loc.coordinates[0],
    };
    let route: MeshRouteView | null = null;
    if (config.liveSync) {
      const profile = profileFor(nearest.distanceKm > 0 ? nearest.distanceKm : osrmDistanceKm({ lat, lon }, { lat: to.lat, lon: to.lon }));
      const fetched = await fetchRoute({ lat, lon }, { lat: to.lat, lon: to.lon }, profile, injFetcher);
      if (fetched) {
        route = { ...fetched, from: { lat, lon }, to, profile, fetchedAt: now, source: "live" };
      }
    }
    if (!route && config.demoSignup) {
      const pack = await preparedRoute({ lat, lon }, to.shelterId);
      if (pack) {
        route = {
          ...pack.route,
          from: { lat, lon },
          to,
          profile: profileFor(osrmDistanceKm({ lat, lon }, { lat: to.lat, lon: to.lon })),
          fetchedAt: now,
          source: "fixture",
        };
        // Honesty marker: the fixture pack must NEVER masquerade as live.
        console.log("prepared route served (fixture pack):", to.name);
      }
    }
    return route ? [route] : [];
  };
}

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
 *   POST /mesh/photo { deviceId, photoRef, data: base64, label? } — the GATEWAY's
 *                    photo upload for a packet's photoRef (bytes NEVER ride the
 *                    batch); AUTH: the deviceId must be a TOFU-PINNED (signed)
 *                    device — legacy/unsigned devices cannot upload. 150 KB cap.
 *   GET  /mesh/photo/:photoRef — image bytes (image/jpeg|png, immutable cache).
 *   GET  /mesh/photos      — dashboard gallery index (photoRef/kind/size/ts/deviceId-HASH only).
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
      // Task 8d Ask Skywatch: the chat seam rides the app's own deps (Task 6 chat
      // loop over the brief tooling + the validator); no mesh-specific config.
      // Task 8e satellite: the live-sync gate lives in makeSatelliteFetcher
      // (SKYWATCH_LIVE_SYNC=1; any fetch failure = the section is omitted).
      const result = await processSync(
        store,
        match,
        body,
        Date.now(),
        makeSkywatchChat(config, deps),
        makeSatelliteFetcher(config, deps),
        makeDirectionsFetcher(config, deps, () => ({ lat: body.lat, lon: body.lon })),
      );
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
      // Task 8b: resource pins (shelters etc.) come from the main app store — the
      // exact ResourceDocs /map/state serves, so node maps match the dashboard.
      const resources = await (await deps.store(config)).listResources();
      return c.json(await assembleMeshState(store, Date.now(), resources));
    } catch (err) {
      if (err instanceof SyncError) {
        return c.json({ error: err.message }, err.status);
      }
      console.error("mesh/state failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "mesh state unavailable" }, 503);
    }
  });

  // ---- Task 8e photo upload/serve (gateway-only upload; open reads like state) ----

  app.post("/photo", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return c.json({ error: "body must be a JSON object" }, 400);
    const reject = (status: 400 | 403 | 413, reasons: string[]) => c.json({ error: reasons[0], reasons }, status);
    try {
      const store = await meshStore(deps);
      const reasons: string[] = [];
      const deviceId = typeof body["deviceId"] === "string" ? body["deviceId"] : null;
      const photoRef = typeof body["photoRef"] === "string" ? body["photoRef"] : null;
      const data = typeof body["data"] === "string" ? body["data"] : null;
      const label = body["label"];
      // AUTH (TOFU, keep-simple): the deviceId must already be a PINNED device —
      // a real pubkey — so the upload is bound to a device whose packets verify.
      // Legacy (unsigned) devices and unknown ids cannot upload photos.
      if (deviceId === null || deviceId.length === 0 || deviceId.length > 128) {
        return reject(400, ["deviceId must be a string of 1..128 chars"]);
      }
      if (deviceId === SKYWATCH_CORE_ID) return reject(400, ["deviceId is reserved (the trusted core does not upload photos)"]);
      const device = await store.getDevice(deviceId);
      if (!device) return reject(403, ["photo upload requires a TOFU-pinned device (this deviceId is unknown)"]);
      if (device.pubkey === null) return reject(403, ["photo upload requires a signature-pinned device (legacy/unsigned devices cannot upload photos)"]);
      if (photoRef === null || photoRef.length === 0 || photoRef.length > 128) {
        reasons.push("photoRef must be a string of 1..128 chars");
      }
      let bytes: Buffer | null = null;
      if (data === null) {
        reasons.push("data must be base64 image bytes");
      } else if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) {
        reasons.push("data must be well-formed base64");
      } else {
        const decoded = Buffer.from(data, "base64");
        if (decoded.length === 0) reasons.push("data decodes to zero bytes");
        else if (decoded.length > MESH_PHOTO_BYTES_CAP) {
          return reject(413, [`photo over cap: ${decoded.length} bytes > ${MESH_PHOTO_BYTES_CAP} (150 KB)`]);
        } else {
          // Content sniff: only jpeg/png are served (that is what dark phones emit).
          const jpeg = decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff;
          const png = decoded[0] === 0x89 && decoded[1] === 0x50 && decoded[2] === 0x4e && decoded[3] === 0x47;
          if (!jpeg && !png) {
            reasons.push("data is neither JPEG nor PNG (magic bytes)");
          } else {
            bytes = decoded;
          }
        }
      }
      let kind: MeshPhotoLabel | null = null;
      if (label !== undefined && label !== null) {
        if (typeof label !== "string" || !(MESH_PHOTO_LABELS as readonly string[]).includes(label)) {
          reasons.push(`label must be one of: ${MESH_PHOTO_LABELS.join("|")}`);
        } else {
          kind = label as MeshPhotoLabel;
        }
      }
      if (reasons.length > 0 || bytes === null || photoRef === null) {
        return reject(400, reasons.length > 0 ? reasons : ["photoRef must be a string of 1..128 chars"]);
      }
      const doc: MeshPhotoDoc = {
        photoRef,
        deviceId,
        // bytes !== null implies data decoded — TS cannot see through the branch above.
        data: data as string,
        contentType: bytes[0] === 0xff ? "image/jpeg" : "image/png",
        kind,
        ts: Date.now(),
        bytes: bytes.length,
      };
      // Upsert: idempotent gateway retries overwrite byte-for-byte.
      await store.putPhoto(doc);
      return c.json({ ok: true, photoRef, bytes: doc.bytes, contentType: doc.contentType, kind });
    } catch (err) {
      console.error("mesh/photo upload failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "photo upload failed" }, 503);
    }
  });

  app.get("/photo/:photoRef", async (c) => {
    try {
      const store = await meshStore(deps);
      const doc = await store.getPhoto(c.req.param("photoRef"));
      if (!doc) return c.json({ error: "no such photo" }, 404);
      return c.body(Buffer.from(doc.data, "base64"), 200, {
        "Content-Type": doc.contentType,
        // Immutable: a photoRef is never rebound to different bytes (putPhoto
        // overwrites only on retries of the SAME ref) — dashboards cache forever.
        "Cache-Control": "public, max-age=31536000, immutable",
      });
    } catch (err) {
      console.error("mesh/photo serve failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "photo unavailable" }, 503);
    }
  });

  app.get("/photos", async (c) => {
    try {
      const store = await meshStore(deps);
      const photos = await store.listPhotos();
      // Newest first, capped for the dashboard gallery; deviceId hashed only
      // (same privacy posture as /mesh/state: never a raw deviceId or phone).
      const photosView = photos
        .sort((a, b) => b.ts - a.ts || a.photoRef.localeCompare(b.photoRef))
        .slice(0, 100)
        .map((p) => ({
          photoRef: p.photoRef,
          kind: p.kind,
          contentType: p.contentType,
          bytes: p.bytes,
          ts: p.ts,
          deviceId: hashPrefix(p.deviceId),
          url: `/mesh/photo/${p.photoRef}`,
        }));
      return c.json({ photos: photosView });
    } catch (err) {
      console.error("mesh/photos index failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "photo index unavailable" }, 503);
    }
  });

  return app;
}