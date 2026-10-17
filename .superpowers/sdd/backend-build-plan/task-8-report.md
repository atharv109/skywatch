# Task 8 report — Offline Mode backend (`/mesh/sync`)

Status: COMPLETE on main. Commits: `feat(api): task 8 offline-mode mesh backend (/mesh/sync, /mesh/state, downlink bundle)` + `docs: task 8 report + mesh runbook notes`.

## What landed

- `src/mesh/types.ts` — packet/device/beacon-doc/state/bundle types + the locked packet format envelope.
- `src/mesh/normalize.ts` — rescue-kind normalization at the door (`Trapped|Injured|Need Rescue`, casing/emoji variants collapse; unknown statuses read as non-rescue and are never clustered).
- `src/mesh/sig.ts` — Ed25519 demo-grade scheme: `sig = sign(`${id}|${type}|${ts}|${lat}|${lon}|${deviceId}`)`, each field through JS `String()` on parsed values; sig/pubkey are base64 of the RAW WebCrypto byte forms; backend verifies via node:crypto; all malformed input reads as "unverified", never throws.
- `src/mesh/score.ts` — sync-time scoring + reason strings (base 0.5; +0.2 inside an active hazard zone via the match store; photo stub seam `checkPhoto()` → "photo-unscored (vision not wired)", 0 delta, no API calls; +0.1 per independent verified nearby report, different deviceId, same type, ≤150 m, max 3; "unsigned device" reason on legacy packets). Stored ONCE with `scoredAt`; read-time decay composes from `src/confidence.ts` (new `mesh` kind, 30-min half-life).
- `src/mesh/store.ts` — `MeshStore` + `mongoMeshStore` + `memoryMeshStore`: packet insert with unique-dedup semantics, TOFU device pinning, beacon-cluster $geoNear find / $max merge / first-ack-wins, listPackets/listBeacons.
- `src/mesh/sync.ts` — the batch processor: shape validation → id dedup (idempotent gateway retries) → sig verify with first-packet pinning → order-independent corroboration over the batch union → scoring → verified-only rescue clustering (100 m, per kind, priority rank Trapped>Injured>Need Rescue) → downlink bundle. `MAX_BATCH=200`.
- `src/mesh/downlink.ts` — the downlink bundle builder: template-ONLY (fallbackRender over the brief; never Gemini; no validator needed because there is no free text), verified-or-null shelter, blockedRoads (max 2, locked semantics), acks for the gateway's contributed clusters. Per-language ack table `MESH_ACK_LINES` + the 911 line imported from fallback.ts/EMERGENCY_LINE (cross-ref comment mirrors the 911-string pattern; reciprocal comment added to post_call_summary.ts).
- `src/mesh/state.ts` — `assembleMeshState`: rescue clusters ranked priority→age; hazard reports with read-time-decayed score + reasons + verify flag; coverage dots = sha256(deviceId) 10-char hash prefix + ~1 km rounded point; counts. No phone, NO raw deviceId.
- `src/mesh/routes.ts` — `POST /mesh/sync` (packet-sig authed, no TOOL_SECRET) + `GET /mesh/state` (open-read like map/state).
- Wiring: `db/client.ts` (mesh_packets id-unique, beacons 2dsphere + clusterId-unique, mesh_devices deviceId-unique), `deps.ts` (optional `mesh` dep — optional so ZERO landed test harnesses had to change), `routes/index.ts`, `routes/map.ts` (data-gated `mesh` section in /map/state + /map/stream), `map/state.ts` (optional `mesh?: MeshState` field), `confidence.ts` (`mesh` kind).
- Tests: `apps/api/test/mesh.test.ts` — 15 hermetic (memory stores, real Ed25519 signers) + 1 gated real-Mongo block (index surface, cross-sync dedup over the unique index, server-side $geoNear cluster merge/clean their own `mesh-test-*` keys). README: new "Offline mode (mesh)" section + mesh collections in the env table.

## Decisions recorded

1. **Bundle language = en always.** The locked packet format carries no `lang` field, so device language is unknowable to the backend; the brief/acks render in en. When the frontend adds a lang, `buildDownlink`/`ackMessage(lang)` accept it (the per-language table is already there and tested).
2. **Photos are stored as a presence flag only** (`photo: boolean`), never the bytes: today's scorer reads no pixels and the never-recomputed scoring invariant means bytes could never be scored later — keeping PII-ish media with no scoring path would be the bad trade.
3. **Corroboration counts verified packets only** (and unsigned packets never create rescue clusters/acks): a spoofed/unverified packet can never boost another packet's score or materialize a rescue cluster. Unsigned packets themselves still get scored (boosts included, from verified peers), per the ruling "record + score but mark verify:'unsigned'".
4. **Shape-broken packets are counted in `rejected`/`rejectedIds` but not stored** (no dedup id exists); SIG-FAILED packets ARE stored (verify `invalid`/`mismatch`, score null, "never dropped silently" reason) — matching the brief exactly.
5. **Strictness:** packet `lat/lon/ts` must be JSON numbers (not numeric strings) — the frontend owns the format; this keeps the sig string definition unambiguous.
6. **TTL/hops decrements belong to the relay** (phones forward, the backend only receives at the gateway) — stored as received, nothing decremented server-side.
7. **Kinds cluster separately** (brief says "same kind within 100 m"): a Trapped beacon 10 m from a Need Rescue cluster forms its own cluster; `keep max priority` is still implemented on merge ($max) so a future same-cluster rank bump is safe.

## REPLAY decision (final-review carry)

`/mesh/sync` + `/mesh/state` run identically in REPLAY=0 and REPLAY=1 — the module never reads config at all; documented in `src/mesh/routes.ts` header. `/map/state`'s mesh section appears by DATA (any packet exists), never by flag.

## Verification

- tsc clean (`npm run typecheck`).
- Hermetic full suite (MONGODB_URI unset): 181 passed / 6 gated-skip / 187 total, 17 files.
- Gated full suite against Atlas throwaway DB: rebuilt from the root `.env` non-SRV URI with db `skywatch-mesh8`, `NODE_OPTIONS=--tls-max-v1.2`, `npx vitest run --no-file-parallelism` → 187/187. One pre-existing flake observed once (match.test.ts spatial test at the 5 s default timeout under full-suite remote latency; passes deterministically alone and in the re-run — no change to landed tests).
- Throwaway DB `skywatch-mesh8` dropped after the run (verified: zero collections).

## Parks / carries

- `POST /mesh/sms` (Delivery-owned SMS fallback) intentionally NOT implemented ("only if time").
- The photo seam is a stub by design — vision teammate wires the adapter; a wired adapter scores packets synced after its deploy (never-recomputed invariant).
- TOFU key pinning is acknowledged demo-grade (plan ruling): a garbage-sig first packet still pins its (unverified) key; a later legitimate device with a different key reads as mismatch and must re-sync as a new deviceId. Same posture as the plan ruling states for web apps.
- Coverage/hazard read paths load all packets per request (dashboard-scale fine; no indexes on receivedAt — add if mesh grows beyond demo scale).