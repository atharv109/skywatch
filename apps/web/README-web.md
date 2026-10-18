# apps/web — demo harness (DubHacks '26)

Vanilla single-file pages, dark theme, no build step and no npm deps. The real frontend is a separate project.

## What each page does

- `index.html` — hub of links + live `GET /health` chip.
- `ops.html` — operator board: live MapState via `/map/stream` SSE (auto-fallback to 2 s polling of `/map/state`; mode shown), hazards/resources/roads with confidence bars, `data.mesh` dark-zone layer, scenario replay (`POST /scenario/{smoke|flood}/replay`), manual check-in (`POST /tools/checkin`, `manual:true`), verify runs (`POST /verify/run`).
- `judge-sim.html` — plays Photon: signs payloads (`x-spectrum-signature: v0=<hex HMAC-SHA256 of "v0:{ts}:{rawBody}">`, 5-min replay window) and POSTs `/webhooks/photon/message`; drives signup hi → address → language; surfaces the agent-side state via `GET /tools/brief/byPhone/:platform/:phone` (the honest end-to-end signal; bot replies are Photon-outbound, unwired → outbox). Also the signed `post_call_transcription` webhook (header `t=<sec>,v1=<hex>` over `<t>.<raw>`) with an id-guard dedupe replay. STOP consent tested end to end.
- `mesh-sim.html` — 3 dark-zone devices: WebCrypto Ed25519-signed packets (`sha` over `id|type|ts|lat|lon|deviceId`, base64 raw key/sig, `legacy:true` fallback), queue → gateway `POST /mesh/sync`, downlink bundle view, corroboration helper (two devices, same type ≤150 m — the `+0.1 independent nearby reports` reason), dedupe replay, live `/mesh/state` (2 s).
- `server.mjs` — zero-dep static server + API proxy (below) so no CORS is needed.

## Secrets

All pasted per page (localStorage): `TOOL_SECRET` (ops + byPhone brief reads), `PHOTON_WEBHOOK_SIGNING_SECRET` (judge-sim), `ELEVENLABS_VOICE_WEBHOOK_SECRET` (judge-sim post-call). `?api=` overrides the API base; default API base is same origin. Config is shared via `localStorage["skywatch.cfg"]`.

## Run

```sh
node apps/web/server.mjs                  # -> http://localhost:8080 (API default http://localhost:3000)
SKYWATCH_API_URL=https://your.onrender.com PORT=9999 node apps/web/server.mjs   # deployed API, still same-origin via proxy
# or: npx serve apps/web -l 4444          # static only; cross-origin API calls then hit the API's lack of CORS headers
```

**On deploy** no harness proxy is needed: the `@skywatch/api` build runs `scripts/copy-web.mjs`, copying this directory to `apps/api/public/`, and the API serves it same-origin (`/`, `/app.html`, `/ops.html`, sims, `sw.js`, manifest + icons). `app.html` is PWA-installable — open the Render URL → Add to Home Screen.

No apps/api files were touched by this work.

## Real frontend should carry vs harness-only

Carry over (production-worthy ideas): the MapState render semantics, displayed status/confidence rules, mesh downlink bundle rendering, brief JSON → human rendering, STOP/consent handling, WebCrypto Ed25519 packet signing.
Harness-only (do NOT copy): localStorage secret pasting, replay buttons, wire log, proxy server, hardcoded demo phone constants, corroboration helpers.