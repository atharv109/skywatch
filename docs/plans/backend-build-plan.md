# Skywatch backend build plan (DubHacks '26)

Plan of record for `apps/api` + fixtures + data collection. Binding spec: `Downloads/Skywatch — DubHacks '26 Spec.md` (safety rules 1–6, demo script, endpoints) + research contracts in `../skywatch-notes/photon-interface.md`, `elevenlabs-sip-notes.md`, `data-sources-report.md`.

## Global constraints

1. **Stack:** TypeScript, Node 20, Hono, native `mongodb` driver (no ODM), `vitest` for tests, `turf` where geometry is needed. Deploy target: Render free web service from branch `main`.
2. **Brief JSON contract (locked, the team interface):**
```jsonc
{
  "userId": "opaque", "lang": "es",   // es|zh|tl|vi|ar (+en); never the phone number in briefs visible to agents
  "hazards": [ { "type": "smoke|flood|aqi|alert", "severity": 1..4, "title": "", "timing": "", "validFrom": 0, "validTo": 0 } ],
  "actions": [ { "id": "kebab-id", "text": "" } ],          // from rule table, max 5, ordered
  "shelter": null | { "id","name","distanceKm","status":"open|unknown","confidence":0..1,"hours":"","verifiedMinutesAgo":0 },
  "blockedRoads": [ { "cameraId","name","status":"flooded|blocked","confidence" } ],  // max 2, only non-clear
  "officialSource": { "name": "", "url": "" },
  "emergency": "Call 911 if you are in danger."
}
```
3. **Safety rules (enforced in code):** never name a place/number/road not in the brief (validator); confidence < 0.5 ⇒ status "unknown" (shelter half-life 30 min, roads 15 min, computed from `verifiedAt` in Mongo — Tiger Data integration is a thin later layer, not a dependency); every brief carries officialSource + 911 line; no send without consent; max 1 alert per user per hazard per 2 h; every outbound written to `outbox`.
4. **Consent (locked):** first "hi" grants text **and** voice; STOP kills both, no reply to STOP after.
5. **Fixture-first:** every feed reads from `fixtures/` when `REPLAY=1`; live fetch code exists but the demo path is fixtures. Webhook handlers enqueue work and ack 2xx immediately.
6. **Photon behind adapter:** normalized `InboundMessage { spaceId, platform: "imessage"|"sms", text, senderId }`; `fromPhoton/raw` and `toPhoton` isolated in one file. Webhook auth: `X-Spectrum-Signature: v0=` HMAC-SHA256 over `v0:{timestamp}:{rawBody}` with signing secret; reject otherwise.
7. **Privacy:** `/map/state` + `/map/stream` never emit phone numbers.
8. **Languages:** en + es, zh, tl, vi, ar.
9. **VEYZL sequencing:** the renderer lands BEFORE validator/staleness/consent hardening (Task 5 first PR = "before" state where LLM writes freely; Task 6 adds gates = "after"). Screenshots are the user's manual job; commits must be distinct.

## Tasks

### Task 1 — Scaffold + Mongo + Hono skeleton
- Monorepo: `apps/api/` (owner: builds fully), `apps/web/`, `apps/vision/` (placeholder READMEs only). Root `package.json` with workspaces, TS config, vitest config.
- `apps/api/src/config.ts` (env: `MONGODB_URI, GEMINI_API_KEY, AIRNOW_API_KEY, WSDOT_ACCESS_CODE, PERCEPTRON_API_KEY, PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET, PHOTON_WEBHOOK_SIGNING_SECRET, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID_BRIEF, ELEVENLABS_AGENT_ID_CHECKIN, ELEVENLABS_VOICE_WEBHOOK_SECRET, PUBLIC_BASE_URL, REPLAY, PORT`), root `.env.example` matching.
- Hono app `apps/api/src/server.ts`: starts HTTP listener, mounts `/health` (returns ok), registers route groups (imported but possibly empty in this task). `dev.ts`/`index.ts` entry.
- `src/db/client.ts`: shared Mongo connection (cached), collection names, index creation on boot: users(2dsphere loc, unique phone), hazards(2dsphere geometry), resources(2dsphere loc), roads(2dsphere loc), conversations(userId), outbox(sentAt).
- `src/types/brief.ts`: the brief contract above as TS interfaces (single source of truth).
- Tests: config validation, health route, index-creation smoke (mongo-mock or against real URI if env set — skip cleanly when unset).
- Commit(s) on main, push ready.

### Task 2 — Fixtures + ingest + scenario replay + map endpoints
- `apps/api/src/ingest/` fetchers for: NWS alerts-by-point (`api.weather.gov/alerts/active?point=` + UA header), AirNow current obs by latLong (key), Open-Meteo AQ fallback host `air-quality-api.open-meteo.com/v1/air-quality?current=pm2_5,us_aqi`, NOAA HMS smoke (ArcGIS FeatureServer GeoJSON query w/ encoded `(v1)` + pagination `exceededTransferLimit`; live only), USGS IV gauge (`sites=12144500&parameterCd=00065`, filter qualifier `P`), Census Geocoder (`/locations/onelineaddress`, x=lon y=lat). All normalize into `hazards` docs (type/severity/geojson geometry/validFrom/To/source).
- All ingest fetchers accept an injected fetcher; in `REPLAY=1` reads fixtures from disk. Fixtures in `apps/api/fixtures/`: `sept-2020-smoke.geojson` (converted from the Sep 11 2020 HMS KML already downloaded at `skywatch-notes/dl/` — converter script committed under `apps/api/scripts/`), `flood-demo.geojson` (synthetic polygon anchored on Snoqualmie gauge values), `nws-alert-sample.json`, `shelters-seed.geojson` (8–10 Seattle-area POIs: shelters + pharmacy + community center, `partner: true` flags on 3 demo ones, status `unknown`), `cameras.json` (6+ WSDOT camera entries w/ public JPEG URLs near demo neighborhoods, status unknown), `zips-wa.tsv` (WA ZIP → lat,lon, carved from GeoNames `US.txt` — committed; used by Task 3 for ZIP-only signup), `photon-inbound-samples.json` (hi / address / language / STOP / question / opt-in-voice).
- `POST /scenario/:id/replay`: load fixture set into Mongo (`smoke` / `flood` scenarios), then run pipeline (pipeline trigger hook, may be a stub call Task 4 fills). Idempotent re-run.
- `GET /map/state` (hazard features, resources w/ status+confidence, roads, user dots anonymized, brief count) + `GET /map/stream` (SSE, same shape, initial full state + updates on a debounced change signal).
- Seed-on-boot: ensure shelters/cameras fixtures loaded when Mongo empty and `REPLAY=1`.
- Tests: fixture load → match-able hazard geometry present; SSE emits initial state; replay idempotence (second run doesn't duplicate).

### Task 3 — Photon adapter + signup + conversations
- `src/deliver/photon.ts`: adapter with `fromPhoton(raw)` (per documented payload) + signature verification + `toPhoton(spaceId, text)` (SDK or Beta HTTP per photon-interface.md — isolate behind function; if SDK details diverge, throw `NOT_WIRED` with clear error and still write attempts to `outbox` so the flow tests end-to-end without Delivery).
- `POST /webhooks/photon/message`: verify HMAC, ack 2xx immediately, enqueue into in-process queue (id-guarded), process async.
- Signup state machine in `src/deliver/signup.ts`: states none→asked-address→asked-lang→active; accepts address string (Census Geocoder) or bare ZIP (zips-wa.tsv); consent text+voice granted on first message; STOP removes user; invalid address → friendly retry, max 2 then ask ZIP.
- `users` + `conversations` writes; every bot reply via `toPhoton` + outbox entry.
- Rate limit: 1 alert/user/hazard/2h enforced in deliver (outbox lookup).
- Tests: full mock round-trip via supertest firing signed webhook payloads from `photon-inbound-samples.json`; STOP test; ZIP test; replayed old message idempotence (webhook retries).

### Task 4 — Match + brief builder
- `src/match/`: for a user point — `$geoIntersects` hazards; nearest resource `$near` status open AND `verifiedAt` within half-life; roads status!=clear within 3 km. Rule table `src/brief/rules.ts`: hazard type+severity → action ids (text stubs in English; max 5, ordered), severity floors: alert 1–2 informational, 3–4 actionable; smoke 3 example: windows closed, mask outside, check neighbors. Timing from validFrom/To.
- Builder assembles the locked brief JSON incl. confidence (from verifiedAt decay), shelter null-state, officialSource (NWS per hazard type). `GET /tools/brief/:userId` returns brief (for ElevenLabs dynamic variables) — userId is Mongo `_id`; also `GET /tools/brief/byPhone/:platform/:phone` for the voice agent to resolve (Delivery needs it; never logged).
- Tests: no hazard → empty brief with officialSource only; below half-life ⇒ shelter null; blocked road inclusion; actions order/cap.

### Task 5 — Gemini renderer + validator + outbox (VEYZL "before" PR)
- `src/brief/render.ts`: prompt generated from brief JSON shape — Gemini returns `{text (<=300 chars), voiceScript}` in user lang; retry once on validator reject; fallback per-language template (pre-translated constants) that only interpolates brief fields. No retry on safety reject → template.
- `src/brief/validator.ts`: extract mentioned shelter names/roads/numbers from rendered text; every one must appear in brief; else reject. Numbers: capacity, distances allowed only if in brief.
- Deliver wiring: render → send → outbox write.
- Commit order matters: first push renderer WITHOUT validator+staleness enforcement (still gated by brief-only tools), separate commit adds validator + staleness rule. Leave the two commits cleanly separable (VEYZL diff story).
- Tests: validator catches invented shelter; fallback on empty Gemini response (mocked); text length bound.

### Task 6 — Verify + roads + conversational tools
- `POST /tools/checkin` `{resourceId, status, capacity?, notes?}` → update resource status/verifiedAt + conversation note; HMAC-authed (shared secret header, Delivery's voice agent uses it) + a `manual: true` path with same endpoint contract for dashboard-button writes.
- `POST /verify/run` (auth header): for partner resources within active hazard radius → enqueue voice check-in requests (writes a `verifyQueue` record Delivery consumes; returns the list). No direct ElevenLabs API dependency in backend.
- `src/roads/`: `POST /roads/check` accepts `{cameraId, status, confidence}` (from vision service adapter with NOT_WIRED default), stores with 15-min half-life; road fetch hook in match.
- Conversational: inbound text in active conversation with lastBrief → Gemini tool-call loop limited to `getBrief, getResourceStatus, getRoadStatus` + last N turns; tool implementations read DB only.
- `POST /webhooks/voice/post-call`: ElevenLabs `post_call_transcription` webhook — verify `elevenlabs-signature` HMAC with `ELEVENLABS_VOICE_WEBHOOK_SECRET`, extract outcome/transcript, append to conversation, ack 200. Contract details from `elevenlabs-sip-notes.md`.
- Tests: checkin flips status visible in next brief + map state; expired confidence ⇒ unknown; post-call HMAC reject path; tool loop mocked.

### Task 7 — Deploy + wiring + README + final smoke
- Render-friendly start (`render.yaml` or docs), Node 20, health check path `/health`; production env var checklist README table (what's set where, who owns which secret).
- README: mention Photon, ElevenLabs, Gemini, MongoDB Atlas, Tiger Data (thin integration: status_events mirror write behind `src/verify/tiger.ts`, optional-by-env — only if time; else document).
- End-to-end smoke script `apps/api/scripts/smoke.ts`: replay → seeded user → brief → render (fixture-Gemini optional) → map state asserts; runs against local or deployed URI with `SMOKE_BASE_URL`.
- Push all; leave Render env setup + VEYZL connect + screenshots to the user (documented steps).

## Preflight conflict scan

| Pair | Produces→consumes | Finding / ruling |
|---|---|---|
| T1↔T2 | types/brief + db client used by ingest | T2 must import T1's types, no duplicate schemas |
| T2↔T3 | fixtures/photon-inbound-samples consumed by T3 tests | naming locked in T2 |
| T3↔T5 | outbox schema; rate limit in deliver | rate-limit ownership: deliver (T3) writes gate, T5 respects |
| T4↔T5 | brief contract | T5 validator driven by brief shape file from T1 |
| T5 commits order | VEYZL before/after | renderer without gates lands as its own commit; gates as next |
| T6↔T3 | conversations writes | T6 appends via same helper, no direct writes |

All resolved: single source files named; no contradiction with Global Constraints. No plan-mandated rubric violations (tests all assert real behavior).