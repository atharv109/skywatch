# skywatch

Backend for Skywatch — DubHacks '26. Public hazard data -> one household, one language, one verified shelter.

Monorepo: `apps/api` (this backend, fully built), `apps/web` + `apps/vision` (placeholder teammates' surfaces). Node 20, TypeScript, Hono, native `mongodb` driver, vitest.

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
| `MONGODB_URI` | The only DB (hazards/resources/roads/users/conversations/outbox/verify_requests) | backend | Render env (Atlas) | DB-backed routes return 503; boot itself still runs (lazy connect) |
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