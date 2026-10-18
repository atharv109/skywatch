# APP-EXPERIENCE demo build report (DubHacks '26 lead demo)

**Files (only new files added, nothing existing touched):**
- `apps/web/app.html` — phone-frame shell, status bar, 4-tab scaffold, overlays
- `apps/web/app.css` — dark premium theme, tokens, animations
- `apps/web/app.js` — the whole app (vanilla JS, no build, talks to the real API only)

Run: the existing harness (`node apps/web/server.mjs`, same-origin proxy) serves the page at `http://localhost:8080/app.html`. `?api=` override works; config lives in `localStorage["skywatch.cfg"]` (API base, TOOL_SECRET, PHOTON_WEBHOOK_SIGNING_SECRET) prompted on first run.

## Screens built
1. **Onboarding** (3 steps, mirrors `deliver/signup.ts` exactly): "hi" phone-thread card (welcome reply is the verbatim `REPLY.welcome` copy, noted "replies arrive over SMS; in this demo read them here") → address/ZIP input + 6 native-language rows (español/中文/tagalog/tieng viet/عربي/english phrases that hit the real `matchLanguage`) → consent screen (mirrors Global Constraint 4: consent granted on first message). Every step also POSTs the real signed webhook, so the backend state machine actually advances.
2. **Home**: hazard cards worst-first with SEVERE/HIGH/ELEVATED/WATCH chips, numbered actions, VERIFIED shelter card with animated confidence bar + "verified N min ago", honest "No verified-open shelter near you" empty state, official source card, pinned 911 bar whenever hazards are active. Incoming texts render as thread cards (summary card labeled "call follow-up text").
3. **Voice call**: full-screen "incoming call — Skywatch Emergency" (accept/decline, ring pulse, haptics); on accept a scripted captions sequence reads the brief hazard → actions → shelter → 911 with a step rail and the note "This is the ElevenLabs agent's script — built from the same brief." Auto-fires once ~6s after onboarding completes when hazards exist; re-triggerable from Profile (online only).
4. **Map**: vector-only canvas (no tiles), pan/pinch/wheel/buttons, hazards filled by severity, pins (open green / full amber / closed+unknown gray / partner outer ring), roads red while flooded/blocked ≥ 0.5, anonymized user dots, mesh layer (pulsing ranked rescue beacons, score bubbles, coverage dots) when `data.mesh` exists, queued local pins with dashed style + "mesh sync needed" chip in offline, tap → detail sheet with confidence bar. Linear lat/lon→px projection, 1 bar ≈ "No Service"/"1 bar"/"5G" status bar states.
5. **Mesh tab**: community chat (real `GET /mesh/state` messages + own queued bubbles), composer (Trapped / Injured / Need rescue / Flooded road / Smoke chips + free text ≤ 280), my-packets list with sig state + "queued · will send when one of us gets signal" chips, gateway CTA, and the downlink-bundle view (brief-out / shelter / roads / acks / messages + rebroadcast animation) after a sync.
6. **Profile**: three-state network switch (ONLINE 5G / NO SERVICE / GATEWAY 1-bar "I have signal — become the link"), role line ("You're relaying neighbors' messages" while dark), identity card (deviceId, Ed25519·WebCrypto, platform, masked number, language), consent + STOP (sends the same signed webhook; app clears local state, notes "no reply follows — that's the contract"), simulate-call (online only), connection details editor.

## Live smoke (real backend on :3000 via the :8080 proxy)
- `POST /scenario/smoke/replay` + `flood/replay` → 200.
- Onboarding driven in a real browser: 3 signed `POST /webhooks/photon/message` (HMAC `v0=<hex>` over `v0:{ts}:{rawBody}`, secret from the lead's env) → all 200 `enqueued:true`; wrong-secret probe → 401 `bad-signature` (verify scheme replicated in node once, matches `verifyPhotonSignature`).
- `GET /tools/brief/byPhone/sms/+1555…` with `X-Skywatch-Tool-Secret` → 200 with a real brief (5 hazards, 5 actions, NWS source) rendered on Home.
- Mesh: 2 queued packets (msg + Trapped beacon) signed in-browser with WebCrypto Ed25519 (msg = `id|type|ts|lat|lon|deviceId` exactly per `mesh/sig.ts`) → `POST /mesh/sync` → `received 2, inserted 2, deduped 0, rejected 0`, `legacy:false` (server verified the sigs), downlink bundle returned with template brief + ack + messages; `GET /mesh/state` afterwards contains our message and a verify:"ok" scored hazard report; counts went 3→5 packets.
- Auto-degrade: pointed the app at a dead API base → first fetch failure flipped it to "Connection lost — entering mesh mode" + NO SERVICE status bar; health-retry loop returns it online when `/health` 200s again (manual offline deliberately does not auto-restore).
- `node --check` on a temp .mjs copy of app.js: clean.

## Backend findings (NOT fixed — apps/api untouchable, worth filing)
1. **`/map/state` 503s while any signup user has no resolved address**: `mongoStore.listUserDots` filter uses `loc !== undefined && loc.type === "Point"` — an explicit `loc: null` (which is exactly what a webhook "hi" creates in `asked-address` state) passes `!== undefined` and `null.type` throws → the whole map/dashboard 503s until that user resolves a location. This bit the demo during smoke (my onboarding "hi" poisoned it); heal = send a valid ZIP to that number. Suggested fix: `loc != null` in `apps/api/src/store.ts`.
2. **Census Geocoder appears unreachable locally** — full addresses ("101 Yesler Way, Seattle, WA 98104") only resolved after I also noted the embedded "98104" (the offline ZIP table path). Bare ZIPs work offline of geocoder. If the lead demos address onboarding, suggest a ZIP.

## Demo-relevant notes
- `deviceId = sha256(raw pubkey) 10-hex`, re-minted every reload (brick rule) — queued packets carry whatever identity signs at send time; ids dedupe server-side.
- WebCrypto Ed25519 needs a secure context (localhost/https) — non-secure fallback sends `legacy:true` (stored unverified, never clustered) exactly like the API documents.
- The mirrored signup replies/summary copy is labeled in-app ("reply as it would arrive by SMS"); nothing is presented as a real SMS.
- `PHOTON_WEBHOOK_SIGNING_SECRET` never appears in the page source; the first-run prompt points at the API's `.env`.
- Un-simulated: the SMS-gate chat tool loop (only the alert/summary/STOP flows are wired).