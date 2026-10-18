# Task 10 report — offline directions via OSRM at gateway sync

Status: COMPLETE on main, additive (downlink bundle gains an optional `routes` key; nothing landed changed beyond seam params). Verification: tsc clean; hermetic **240 total (229 passed + 11 gated-skip)**, 20 files — landed fixtures.test unchanged EXCEPT the curated-file whitelist gained `demo-routes.json` (deliberate: the prepared pack IS a committed curated fixture, unlike the raw-download ban it guards). Atlas gated skipped: the route fetch path is entirely hermetic-assertable (injected fetcher + committed fixture), and no Mongo-shaped surface changed (see report note). **PUSHED** (deploy live — no further action needed).

## What landed

- `src/routes/osrm.ts` (new seam): `fetchRoute(from, to, profile, injFetcher?)` — `GET https://router.project-osrm.org/route/v1/{profile}/{from;to}?overview=full&geometries=geojson&steps=true`, 5 s timeout, ANY failure ⇒ null (all-or-nothing posture). Normalized: `coords [[lat,lon]…]` (GeoJSON flipped, evenly SAMPLED to ≤120 vertices so the bundle stays small), `distanceKm/durationMin` (rounded), `steps ≤12` (`{distanceM, name, instruction}` — instruction = phrase-ified maneuver: "depart right on 4th Ave S" / "turn left on 5th Ave" / "arrive"). `profileFor(dist)` + `osrmDistanceKm` (haversine) + `OSRM_DRIVING_THRESHOLD_KM = 3`.
- `mesh/types.ts`: `OsrmProfile ("foot"|"driving")` + `MeshRouteView` (`from / to {shelterId,name,lat,lon} / profile / coords / distanceKm / durationMin / steps / fetchedAt / source:"osrm"|"fixture"`); `DownlinkBundle.routes?: MeshRouteView[]`.
- `mesh/downlink.ts`: `directions?`(now) → `MeshRouteView[]` param — the route is a FACT: no validator, and NOTHING decays it (no confidence/score key exists on the view at all — asserted by test). Failure/empty ⇒ the key is OMITTED (never half-arrive; the app's glow line is the fallback).
- `mesh/routes.ts` `makeDirectionsFetcher(config, deps, originOf, injFetcher?)` — the two-knob honesty gate:
  - **live OSRM fetch rides `SKYWATCH_LIVE_SYNC=1`** (the same "this sync may touch the internet" knob as the satellite overlay — hermetic tests stay offline by default);
  - **prepared-pack fallback rides `DEMO_SIGNUP=1`**: `fixtures/demo-routes.json` lookup by `to.shelterId` with the nearest-origin pick; badged `source:"fixture"`, `fetchedAt` stamped fresh, and a `"prepared route served (fixture pack): <name>"` console log — NEVER masquerading as live;
  - both knobs off ⇒ `routes` never appears (zero network, zero fixture reads).
  The shelter = `match.nearestOpenResource` — shelter-kind + open + confidence ≥ 0.5, i.e. exactly the bundle's `nearestVerifiedShelter` this sync.
- `apps/api/scripts/fetch-demo-routes.mjs`: the pack regenerator (`node scripts/fetch-demo-routes.mjs` from apps/api; REAL OSRM; aborts so no half-pack is ever committed) — RAN ONCE: 8 routes (seattle-center + waterfront → 4 seed shelters; foot and driving by the same threshold).
- README: the mesh architecture line + the `SKYWATCH_LIVE_SYNC`/`DEMO_SIGNUP` env rows now name OSRM routes + the prepared pack.
- Tests (+4 hermetic in mesh.test.ts): injected-fetcher normalization (coords flip + sample cap 120 from 300, steps cap 12 from 18, distance 12.35/duration 17, phrase shape, profileFor edges, HTTP 503 ⇒ null); prepared-pack fallback through the REAL route path (bundle.routes[0] = the committed fixture's route, source:"fixture", from=gateway, fact-honesty = no confidence/score keys, the log line asserted); non-pack verified-open shelter ⇒ key omitted; knobs-off ⇒ no key AND zero fetch calls (guard).

## Decisions recorded

1. **Live directions ride the SAME knob as the satellite overlay** (`SKYWATCH_LIVE_SYNC=1`): one meaning — "this sync is allowed to touch the network" — and the hermetic default (knob off) stays deterministic; the task brief specified no knob, so the established gate is reused instead of inventing a second.
2. **Prepared-pack = DEMO_SIGNUP=1-gated + logged + badged**: the demo fallback is deliberately a different knob than live (the pack is a demo artifact, not a feature); honesty is enforced three ways (badge, log, never both simultaneously presented).
3. **The route's `to` is the bundle's verified-open shelter matched by resource** (`nearestOpenResource` — the exact same query the brief uses in the same instant), so the bundle's shelter and its directions can never disagree (e.g. a pharmacy is never a directions target, matching the brief's narrowing).
4. **Coords sampled, steps capped** — bundle size bounded (~small JSON); the map shape stays recognizable at ≤120 vertices.
5. **`fetchedAt` freshly stamped at sync** (the fixture's own fetchedAt is overwritten): the badge says WHERE it came from, the timestamp says WHEN it rode the mesh.

## Parks / carries

- OSRM's demo server is a public good with no SLA — a production pass would self-host or use the Photon/Routable equivalent; the seam's `fetcher` injection keeps that a config change.
- Transit-like multilingual step phrasing ("turn left on …") stays English: it is route FACT phrasing, template-derived from maneuver types — translated step texts are a frontend i18n concern (the backend's validator rules don't apply to facts).
- No live OSRM test exists (network tests are always injected); the LIVE path shape was verified once by generating the pack against the real server (8/8 routes).