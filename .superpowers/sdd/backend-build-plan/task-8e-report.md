# Task 8e report — mesh photos + satellite overlay

Status: COMPLETE on main, additive (8b/8c/8d untouched beyond seam extensions). Verification: tsc clean; hermetic 207 total (198 passed + 9 gated-skip; +8 new hermetic tests); gated full suite vs Atlas throwaway db `skywatch-8e` → **207/207 twice in a row** (first run: the documented checkin.test.ts full round-trip latency flake — pre-existing class, passes alone + on re-runs); db dropped, verified zero collections. `apps/web` untouched.

## What landed

### Feature 1 — mesh photos (gateway-upload; dark phones never touch the internet)
- `mesh/types.ts`: `MeshPhotoDoc` (photoRef/deviceId/data(base64)/contentType/kind/ts/bytes), `MESH_PHOTO_LABELS` (road-broken|fire|safe-place|flood|other), `MESH_PHOTO_BYTES_CAP` 150 KB; `photoRef: string | null` on MeshPacketIn (optional, validation 1..128 chars → shape-broken rejection), ParsedPacket, MeshPacketDoc; MeshState hazardReports entries gain `hasPhoto/photoKind/photoUrl`; DownlinkBundle satellite field.
- `mesh/store.ts` (+ `db/client.ts` collection `mesh_photos`, unique photoRef index — asserted in the gated test): upsert-by-photoRef (idempotent gateway retries overwrite byte-for-byte), getPhoto, listPhotos (both stores).
- `mesh/routes.ts`: `POST /mesh/photo` {deviceId, photoRef, data, label?} — AUTH keep-simple per the ruling: the deviceId must be a TOFU-PINNED device (mesh_devices with a real pubkey); unknown ⇒ 403, legacy/unsigned ⇒ 403, reserved core id ⇒ 400. Validation with a REASONS list in the response body: malformed base64 400, non-jpeg/png magic 400, bad label 400, over-cap ⇒ **413** + reasons. Sniffs image/jpeg|png by magic bytes. `GET /mesh/photo/:photoRef` (bytes, content-type, `Cache-Control: immutable` — refs are never rebound), `GET /mesh/photos` (newest-first gallery index, deviceId HASHED, url `/mesh/photo/<ref>`, no thumbnails).
- `mesh/state.ts`: hazard reports render the photo view ONLY when the photoRef resolves to uploaded bytes (declared-but-never-uploaded renders as no photo — no dangling 404 links on the dashboard). The same view rides `/map/state`'s mesh section (one assemble fn).

### Feature 2 — satellite overlay in the downlink bundle
- `config.ts`: `liveSync` (env `SKYWATCH_LIVE_SYNC`, default 0) — independent of REPLAY (set both to the same intent in a test on purpose: live fetch is allowed under REPLAY=1).
- `mesh/satellite.ts` (new): `fetchSatelliteSection(point, now, fetcher?)` — parallel live calls to ingest/smoke.ts (HMS ArcGIS query, 1 page of 2000 — bounds the snapshot to one 5 s timeout per source), ingest/nws.ts (alerts by point), ingest/aqi.ts (Open-Meteo — no key needed; AirNow key path untouched) — each source through a per-call 5 s AbortSignal timeout; **ALL-OR-NOTHING**: any failure/timout ⇒ the WHOLE section is omitted (the bundle must never block or half-arrive). bbox = gateway ±0.5°, coordinates-range intersect (envelope overlap, so giant plumes still match); plumes ≤25 / alerts ≤10; the normalized hazards (SAME ingest normalizers) = exactly what the section carries, upserted into `hazards` by `makeSatelliteFetcher(config, Pick<AppDeps,"store">, fetcher?)` (the sync seam; unset knob ⇒ a fn that always nulls, no fetch).
- `mesh/sync.ts`: `processSync(..., satFetcher?)` — the fetch runs AFTER all packet work, `.catch(() => null)`; buildDownlink gains the optional `satellite` param and includes `satellite` in the bundle ONLY when fetched. `processSync` packet parsing gains photoRef.
- Tests (8 hermetic + 1 gated): photo TOFU-only auth matrix (403/403/400/200); round-trip (bytes + content-type + immutable cache, 404, idempotent-retry overwrite, png variant, hash-only index, no raw deviceId); caps/validation matrix (413 reason list, base64/magic/label 400s, rejected uploads store nothing); photoRef packet render (`hasPhoto/photoKind/photoUrl` before-but-not-yet-uploaded ⇒ false, after ⇒ true, mirrored in /map/state); satellite unit (bbox filter cuts the far-AWAY feature, caps 25/10, AQI view, hazard sourceIds from the shared normalizers); all-or-nothing (NWS 500 ⇒ whole section null); route gate (LIVE_SYNC=1 ⇒ bundle.satellite + hazards upserted into the app store incl. `hms-smoke:`/`nws:`; degrading fetch ⇒ section absent, sync still 200; knob off ⇒ no section AND zero fetch calls).

## Decisions recorded

1. **All-or-nothing satellite**: "never half-arrive" taken literally — one source failing omits the section entirely rather than shipping partial truths; the sync itself never fails (mesh sync must not depend on the internet).
2. **Upsert = exactly the bundle's window** (bbox-filtered + capped), not the full CONUS page — keeps the store small and the returned/normalized data provably the same set.
3. **hasPhoto means bytes-arrived** (not ref-declared) — a dashboard link must never 404; the declared-but-pending case stays invisible until the gateway catches signal.
4. **Photo AUTH = TOFU pinned (real pubkey) only**, exactly per ruling (no sig over the POST body — demo-grade, documented; the deviceId must already have been proven by signed packets).
5. **photoRef is type-agnostic**: any packet may carry one (beacons/hazards/msg); the mesh_photos doc keeps only the kind label — linking back to packet ids is not tracked (gallery + state view is the only consumer).
6. **GET /mesh/photos caps at 100** newest — gallery-scale bound, documented in code.
7. **Kinds come from the gateway's label, not vision** — the vision hook stays the stub (label text only), per the Task 8 ruling.

## Parks / carries

- Thumbnails are intentionally absent ("thumbnail-free" per spec) — dashboards fetch full ≤150 KB images, cache-immutable forever.
- The satellite knob is env-only; turning it on in Render means real Atlas writes from the sync path at demo scale (bounded ≤36 upserts/sync).
- No live satellite/network test exists against the real services (all network tests are scripted; the live path shares the exact ingest functions the REPLAY pipeline already exercises live).