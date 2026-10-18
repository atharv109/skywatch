# skywatch

Backend for Skywatch — DubHacks '26. Public hazard data -> one household, one language, one verified shelter.

Monorepo: `apps/api` (this backend, fully built), `apps/web` + `apps/vision` (placeholder teammates' surfaces). Node 20, TypeScript, Hono, native `mongodb` driver, vitest. On deploy, `apps/api`'s build also copies `apps/web` to `apps/api/public/` and serves it same-origin, so the PWA demo app installs on phones straight from the Render URL.

## Architecture

```
                 fixtures/ (REPLAY=1 demo path)         live fetch code exists,
                 ├─ sept-2020-smoke.geojson             but demo = fixtures
                 ├─ nws-alert-sample.json                      │
                 ├─ flood-demo.geojson                         v
  ┌─────────────────── INGEST ───────────────────┐   ┌──────── normal feeds ────────┐
  │ NWS alerts · AirNow/Open-Meteo AQ · NOAA HMS │   │ api.weather.gov · airnow.gov │
  │ smoke · USGS gauge · shelters/cameras seed   │   │ open-meteo · NOAA HMS · USGS │
  └──────────────────────┬───────────────────────┘   └──────────────────────────────┘
                         v                            Census Geocoder (address ->
                   Mongo (hazards, resources w/ verifiedAt, roads, users w/ loc) <- ZIP)
                         │
                         v
  ┌───────────── MATCH + BUILD (per user) ──────────────┐    ┌──────────────── VERIFY ───────────────┐
  │ $geoIntersects hazards · nearest open shelter       │    │ POST /tools/checkin  (voice + manual) │
  │ (verifiedAt half-life confidence) · roads within    │    │ POST /verify/run     (partner queue)  │
  │ 3 km · rule table -> actions (max 5, ordered)       │    │ POST /roads/check    (vision verdict) │
  │ -> LOCKED BRIEF JSON (validator-fenced)             │    └───────────────┬───────────────────────┘
  └───────────────┬──────────────────┬──────────────────┘                    │ voice
                  v                  v                                       v
         GET /tools/brief/:id   render (Gemini OR fallback  ┌───────────────────────────────┐
                  │           template -> validator -> send)  │ ElevenLabs Brief + Check-in   │
                  v                                            │ agents (Delivery owns)        │
  ┌──────────────── DELIVER ────────────────┐                 └───────────────┬───────────────┘
  │ user texts -> POST /webhooks/photon     │                                 v
  │ /message (HMAC v0=, ack 2xx, queue)     │                          POST /webhooks/voice/
  │ signup state machine -> consent on      │                          post-call (HMAC, fail-closed)
  │ first "hi"; STOP kills both, no reply   │
  │ outbox row for EVERY outbound           │
  └────────────────┬────────────────────────┘
                   v
            Photon (iMessage/SMS)  <──────────────── webhooks back in
```

Two hard fences: **brief validator** (never name a place/number/road not in the brief) and **consent** (first "hi" grants text+voice, STOP kills both). `/map/state` + `/map/stream` never emit phone numbers (or anything else user-identifying).

## Env vars

Copy `.env.example` to `.env` (root, gitignored). Secrets never land in git and on Render they are set in the **dashboard**, never synced (`render.yaml` marks them `sync: false`).

| Var | What it's for | Owner | Where it's set | Without it |
| --- | --- | --- | --- | --- |
| `MONGODB_URI` | The only DB (hazards/resources/roads/users/conversations/outbox/verify_requests + mesh: mesh_packets/beacons/mesh_devices) | backend | Render env (Atlas) | DB-backed routes return 503; boot itself still runs (lazy connect) |
| `GEMINI_API_KEY` | Live LLM rendering of alerts | backend | Render env (Google AI Studio) | Fallback per-language pre-translated templates render the alert instead (also happens whenever `REPLAY=1` — the demo path uses templates, no Gemini call) |
| `AIRNOW_API_KEY` | Live AQ obs by lat/long | backend | Render env (AirNow) | Ingest falls back to Open-Meteo air-quality host (no key); AQI fixture on the demo path |
| `WSDOT_ACCESS_CODE` | Live WSDOT camera metadata / snapshots | backend | Render env (WSDOT) | Cameras only come from the committed fixture; roads/check verdicts still accepted |
| `PERCEPTRON_API_KEY` | Marks the vision-service seam "wired" — the vision teammate's service POSTs verdicts to `/roads/check`; the API never makes live vision calls | vision | Render env | `/roads/check` accepts manual/teamed verdicts only; adapter reports `not_wired` |
| `PHOTON_PROJECT_ID` | Photon project identity for outbound sends | delivery | Render env (Photon dashboard) | `toPhoton` throws `NotWiredError` BEFORE any network call; sends recorded as `not_wired` in outbox |
| `PHOTON_PROJECT_SECRET` | Photon project secret (paired above) | delivery | Render env (Photon dashboard) | same `NOT_WIRED` sends behavior as the ID |
| `PHOTON_WEBHOOK_SIGNING_SECRET` | HMAC over `v0:{timestamp}:{rawBody}` for inbound `/webhooks/photon/message` | delivery | Render env + Photon dashboard must hold the same value | **fail-closed: inbound webhooks are rejected 401** — signup/delivery dead |
| `ELEVENLABS_API_KEY` | Delivery's agents use it to run; the backend itself never calls the API | delivery | Render env (ElevenLabs) | nothing breaks on the backend; agents can't run |
| `ELEVENLABS_AGENT_ID_BRIEF` | Identifies which calls come FROM the Brief caller in the post-call webhook | delivery | Render env + the ElevenLabs dashboard (agent config pointing at `PUBLIC_BASE_URL/tools/brief/...`) | post-call calls can't be labeled as brief-caller |
| `ELEVENLABS_AGENT_ID_CHECKIN` | Stamped onto `verify_requests`; post-call outcome routing matches on it | delivery | Render env + ElevenLabs dashboard (Check-in agent; consumes `GET /tools/checkin/next`) | check-in outcomes can't be routed back to the right request |
| `ELEVENLABS_VOICE_WEBHOOK_SECRET` | `elevenlabs-signature` HMAC on `/webhooks/voice/post-call` | delivery | Render env + ElevenLabs webhook settings | **fail-closed: post-call webhooks rejected 401** — outcomes lost |
| `PUBLIC_BASE_URL` | Canonical URL of the deployment for agents to point their tools at | backend | Render env (defaults `http://localhost:PORT`) | After the first Render deploy set it to the service's `onrender.com` URL and redeploy; agent dashboards should use it explicitly |
| `REPLAY` | `1` = every feed reads committed fixtures + renders via fallback templates (the demo path); `0` = live feeds + live Gemini | backend | Render env, `1` for the demo | `REPLAY=1` is the only proven path; `0` hits live feeds |
| `PORT` | HTTP listener port (Render injects its own) | backend | Render env | defaults 3000 |
| `TOOL_SECRET` | Shared secret for `/tools/*`, `/verify/run`, `/roads/check` (`X-Skywatch-Tool-Secret:` or `Authorization: Bearer`) | backend | Render env; the same value goes to the ElevenLabs agent tool configs | unset = endpoints accept **unauthenticated writes** (demo-grade decision; a boot-log warning fires). Set before exposing. |
| `TIGER_DATABASE_URL` | Optional mirror of check-ins into Tiger Data `status_events` (Timescale Postgres, `pg`) | backend | Render env | unset = **no Tiger writes at all** (Mongo `verifiedAt` is the demo source of truth); set = fire-and-forget mirror, failures logged, never blocking the pipeline |
| `SKYWATCH_LIVE_SYNC` | `1` = gateway sync live-fetches the satellite overlay (Task 8e) + upserts it into `hazards` | backend | Render env; default unset/`0` | unset = **no satellite section, no fetch** (tests hermetic + offline-deterministic); REPLAY never gates this |
| `XAI_API_KEY` | Grok Voice TTS (xAI) key — `POST api.x.ai/v1/tts` (`voice_id=eve`) renders the post-call summary recap mp3, cached in `tts_cache` (sha256(text+lang)) and played via `GET /tools/summary-audio/:outboxId` (Task 8f, SpaceX track) | backend (lead) | Render env + console.x.ai | unset = **text-only path, zero TTS calls**; tl (Tagalog) is UNSUPPORTED by /v1/tts — those users keep the ElevenLabs/text path |
| `DEMO_SIGNUP` | `1` = the phone-native demo onboarding routes are ON (`POST /demo/signup`, `POST /demo/area-brief` — Task 8g; server-side-signed envelopes over the EXACT real webhook/signup path) | backend (lead) | Render env, demo only | unset = **403 on both /demo routes** (boot warning when on); requires `PHOTON_WEBHOOK_SIGNING_SECRET` set to sign |
| `GEMINI_LIVE_IN_REPLAY` | `1` = LIVE Gemini inside `REPLAY=1` for the alert render + beat-6 chat Q&A (Task 9, MLH Gemini track — fixtures move, wording can still be live) | backend (lead) | Render env, demo only | unset/`0` = **demo stays the deterministic fallback under REPLAY** (fail-safe unchanged); the validator→retry→per-lang fallback chain is identical either way — a live failure under replay = fallback, never a dead beat |

## Offline mode (mesh, Task 8)

Phones-only transport: dark phones relay over a Wi-Fi hotspot LAN (WebRTC — frontend page); the self-discovered **gateway** node POSTs the whole batch and rebroadcasts the returned downlink bundle.

- `POST /mesh/sync` — `{deviceId, lat, lon, packets[]}` (max 200/packet batch). Each packet: `{id, type: beacon|hazard|ack|brief|msg, status, lat, lon, ts, hops, ttl: 7, photo?, deviceId, sig, pubkey?, legacy?}` (`msg`: status = the chat text, 1..280 chars verbatim, optional `to:` null = broadcast / deviceId hash = direct message; stored `mesh_packets`, never scored, never decayed — transport, not facts). Auth is the packets themselves: Ed25519 over `` `${id}|${type}|${ts}|${lat}|${lon}|${deviceId}` `` (each field passed through `String()`, sig + pubkey as base64 of the **raw** WebCrypto bytes); the pubkey is pinned on a device's first packet (`mesh_devices`, trust-on-first-use, demo-grade). Devices without Ed25519 send `legacy:true` — stored unverified, scored with an "unsigned device" reason, but never clustered and never acked. Packs with failed sigs are recorded unscored ("never dropped silently"). Dedup by packet id (idempotent gateway retries). Scoring is computed ONCE at sync with a reasons array; the 30-min decay composes at read time. Rescue beacons (`Trapped|Injured|Need Rescue`, any casing/emoji) are never decayed/downgraded and cluster per kind within 100 m.
- The sync response is the **downlink bundle**: template-only brief text (never Gemini), verified-or-null shelter, blocked roads (max 2), `acks` ("responders have seen your beacon", + 911 line) for the gateway's contributed beacon clusters, and Task 8b `messages` — the newest 20 mesh chat messages addressed `to` the gateway's deviceId hash or broadcast within 5 km (user text verbatim; ack language now takes the device lang as an optional param, default `en`). All server-COMPOSED bundle strings stay template-derived.
- `GET /mesh/state` — dark-zone dashboard layer (open-read, same posture as `/map/state`: never a phone number or raw deviceId; coverage dots are a sha256 deviceId hash prefix + ~1 km rounded point; msg packets add no coverage dots). Task 8b additions, additive to the Task 8 shape: `messages` — newest 50 mesh chat messages `{id, from: deviceIdHash, to, text, ts, hops}` (type `msg` only) — and `resources` — the dashboard's shelter/resource pins `{sourceId, kind, name, status, lat, lon}` with the same map-display status/open-confidence rule. It is also merged into `/map/state` as a `mesh` section only when packets exist — data-gated, never config-gated: **both mesh routes run identically in `REPLAY=0` and `REPLAY=1`** (explicit final-review decision).
- **Ask Skywatch over the mesh (Task 8d)** — a msg packet with `to:"SKYWATCH"` (case-insensitive) routes at sync to the Task 6 chat loop; the answer is a NEW trusted-core msg packet (`deviceId:"SKYWATCH-CORE"`, `verify:"core"` — the server is the author, nothing to verify; never scored/clustered/decayed, and the id is reserved: gateways can't claim it) direct to the asker's hash, with the brief resolved at the **asker's** coordinates (a point-based brief — same builder/validator as /tools/brief). Gemini key + REPLAY=0 = live validated tool-loop answer (invented entities -> fallback); no key or REPLAY=1 = the deterministic brief-fields composition. Gateway claiming the core id is rejected.
- **Mesh photos (Task 8e)** — a packet may carry `photoRef` (a POINTER only: photo bytes NEVER ride the batch); the gateway uploads the bytes with `POST /mesh/photo {deviceId, photoRef, data: base64, label?: road-broken|fire|safe-place|flood|other}` (≤150 KB, jpeg/png; 413/400 with a reason list). AUTH = the packet TOFU scheme, keep-simple: the deviceId must be a PINNED (signed) device — legacy/unsigned devices cannot upload. Reads: `GET /mesh/photo/:photoRef` (bytes, immutable cache) + `GET /mesh/photos` (gallery index: ref/kind/size/ts/deviceId-HASH).
- **Satellite overlay (Task 8e)** — with `SKYWATCH_LIVE_SYNC=1` (default `0`; REPLAY does not gate this), every `/mesh/sync` for the gateway's area (±0.5°) live-fetches NOAA HMS plumes (the ingest/smoke.ts ArcGIS query), NWS active alerts (by point) and Open-Meteo AQI, ALL-OR-NOTHING (5 s timeout per source; any failure = the whole `satellite` section is omitted from the bundle). The normalized docs ride the SAME ingest normalizers and are upserted into `hazards` — dashboards and future briefs gain them too. No knob → no section, no fetch.
- **Photo demo flow** — dark phone shoots a broken road → the report (with `photoRef`) rides the mesh relay → the gateway catches signal and ships the batch → the gateway's browser then `POST /mesh/photo` with the cached bytes → `hasPhoto/photoKind/photoUrl` light up on `/mesh/state` + `/map/state`'s mesh panels and `GET /mesh/photos` shows the gallery. (Vision scoring stays a stub — label text only.)
- **Grok Voice summary audio (Task 8f, SpaceX track)** — when `XAI_API_KEY` is set, the post-call summary is ALSO rendered to mp3 by xAI's `/v1/tts` (`voice_id=eve`, exact language codes `es-MX`/`ar-SA`/`zh`/`vi`; **tl unsupported** → text-only), cached in `tts_cache` (sha256(text+lang), cache-read before network) and stamped onto the summary's outbox meta; the dashboard plays it via `GET /tools/summary-audio/:outboxId` (TOOL_SECRET-gated like all /tools reads). 5 s timeout, any failure ⇒ **no audio, deliver never blocks**; without the key the feature is absent and the text path is byte-identical to before.
- **Phone-native demo onboarding (Task 8g)** — `DEMO_SIGNUP=1` (demo only; boot warning fires) enables `POST /demo/signup` `{phone (E.164), platform, texts[]}`: the backend builds the FULL Stable Spectrum envelope per text, signs it with `PHOTON_WEBHOOK_SIGNING_SECRET` (the secret the phone app can never hold) and drives the EXACT real webhook → verify → queue → signup-state-machine path, then returns `{ok, userId, state, lang, brief, mapLink}` — the phone number is never echoed or logged. `POST /demo/area-brief` `{lat, lon}` returns the area brief (same builder/validator semantics as the per-user pipeline; unvalidated shelter = null) for the phone's no-signup Home fallback.

## Run

```bash
npm ci
npm test                      # hermetic suite (no Mongo needed)
REPLAY=1 MONGODB_URI=mongodb://localhost:27017/skywatch-dev npm run dev   # tsx watch
npm run start -w @skywatch/api                            # prod start path (node --import tsx)
npm run build --workspaces                                # deploy build step (tsc typecheck-as-build)
npx tsx apps/api/scripts/smoke.ts             # end-to-end smoke (needs the app running + MONGODB_URI)
```

Deploy target is Render (free web service): branch `main` with `render.yaml`

```yaml
runtime: node (NODE_VERSION 20), node 20 plan free, healthCheckPath /health
build: `npm ci && npm run build --workspaces`, start: `npm run start -w @skywatch/api`
REPLAY=1 pinned in render.yaml; every secret var is `sync: false` (set in the dashboard)
```

## Verify before demo

1. `GET /health` returns `{"ok":true}`.
2. Run the end-to-end smoke against the running app: `MONGODB_URI=... npx tsx apps/api/scripts/smoke.ts` — all steps PASS, exit 0. It exercises `/health` → `POST /scenario/smoke/replay` → `/map/state` (hazards>0, resources>0) → seeds a throwaway consented user inside a replayed smoke polygon, fetches `GET /tools/brief/:id` and asserts the locked brief shape (it never sends anything through Photon).
3. `TOOL_SECRET` is set AND the smoke is run with the same `TOOL_SECRET` env (unset = unauthenticated tool writes; set = brief routes must carry `X-Skywatch-Tool-Secret`).
4. `PHOTON_WEBHOOK_SIGNING_SECRET` set on both sides (Render + Photon) — an inbound test webhook must not 401.
5. ElevenLabs: the Brief agent's dynamic-variables tool points at `PUBLIC_BASE_URL/tools/brief/:userId`; the Check-in agent consumes `GET /tools/checkin/next?deviceId=` and both agent IDs are set in Render env (`ELEVENLABS_AGENT_ID_BRIEF` / `_CHECKIN`).
6. `ELEVENLABS_VOICE_WEBHOOK_SECRET` set on both sides - post-call outcomes must land in conversations.
7. `REPLAY=1` on the API service; a `POST /scenario/smoke/replay` just before the demo refreshes the fixture snapshot.
8. GEMINI deliberately NOT exercised here — `REPLAY=1` yields fallback templates by design (set `REPLAY=0` + `GEMINI_API_KEY` only when the live render path is wanted).
9. Render free tier sleeps after ~15 min idle (~50 s cold start): keep the dashboard tab open for keep-alive, or resume the service from the dashboard about a minute before the demo.
10. `TIGER_DATABASE_URL` either unset (no-op, no demo impact) or set with its table reachable; check-ins must never wait on it (fire-and-forget is verified by design).

Note on `TOOL_SECRET`: when it is unset, the tool endpoints (`/tools/*`, `/verify/run`, `/roads/check`) accept **unauthenticated writes** — that is a demo-grade decision, the boot log warns about it, and it must be set before the API is exposed.
### Verifying with real Mongo
Gated tests use the MONGODB_URI (throwaway DB). Two rules:
- Run `npx vitest run --no-file-parallelism` — the gated files share one DB by design and must not interleave.
- If the network breaks TLS 1.3 (campus VPNs/proxies: 'tlsv1 alert internal error' or ENOTFOUND on the mongodb+srv seed), use the non-SRV string + `NODE_OPTIONS=--tls-max-v1.2` (both are in root `.env` locally; on Render the plain `mongodb+srv` string works).

### Repo layout
- `main` = backend (apps/api + fixtures + docs) and the reference demo app + harness (apps/web).
- **`client` branch = the shipping frontend** (skywatch-client, Next.js 16 + React 19: landing / alert / offline-mesh / ops) — same API, server-side proxy + signing.
Both branches: public, live, real-backend everywhere.
