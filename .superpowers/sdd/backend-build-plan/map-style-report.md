# Map tab rebuild + orange/black theme — report

Date: 2026-10-17/18 · Branch: main · Commits: see git log (visual + map-rendering only, all app behavior/data flow untouched)

## Follow-up fix (tile-pack expansion, no black voids)

The user's screenshot showed the original 16-tile pack ending on screen. Expanded + clamped (commit 2):

- Pack now 95 tiles / 2.63 MB (≤ 6 MB, ≤ 100 cap), all verified 256×256 PNGs (PNG magic + IHDR dims checked; 95/95 converted via ffmpeg from the keyless Esri World Dark Gray raster; 94 unique + 1 water-tile duplicate).
  - z13: x 1310–1314 × y 2858–2863 (5×6) — full Seattle bbox ≈ lat 47.53–47.70 × lon -122.44–-122.20.
  - z14: x 2620–2626 × y 5716–5723 (7×8) — downtown through the eastside.
  - z15: x 5249–5251 × y 11442–11444 (3×3) — Capitol Hill / First Hill / Central District cluster (1:2 retina-sharp at demo zoom).
- Pan/zoom clamped to the exact z13 coverage bounds (`BOUNDS`: -122.435..-122.205 / 47.535..47.695) — no black-void scrolling possible; edge pan snaps back. Min zoom clamped to 0.35 so the viewport can never exceed the z13 coverage (at min zoom the viewport's lon span is 0.176° < 0.24 coverage).
- Renderer keeps coarse→fine painting (z13 under z14 under z15) so any still-uncovered band upscales from the coarse layer (soft, never torn); if zero tiles would draw (impossible under clamps, kept as safety), the backdrop is `#0A0A0B` with a subtle 24px dot grid (the old line grid replaced).
- Boot view: `fitAll` centers on the demo cluster and caps at 2.6 → z14/z15 territory, fully covered edge-to-edge (verified by screenshot).
- SW: `CACHE_VERSION` → `sw-v3`; the precache list is generated from the same three zoom ranges (95 tile paths, matched 1:1 against disk).

Re-verified (headless Chromium 390×844): 16 tile requests during the screenshot run — all same-origin from the local pack, zero external tile hosts; `node --check` passes on app.js + sw.js.

## Follow-up 2 — on-device Home + scroll + Directs (same batch)

Fixes for the three on-device findings, verified headless Chromium 390×844 (scroll assertions: wheel & touch swipes change `.screen.active` scrollTop in the natural direction on Home AND Mesh; all 6 gestures pass):

- **Onboarding without secrets**: the browser-signed per-text webhook flow in onboarding is replaced — texts are collected in-thread and ONE same-origin `POST /demo/signup {phone, platform:"sms", texts}` fires at finish; the response `{userId, lang, brief, mapLink}` renders the brief on Home immediately and stores `userId` in config for later byPhone reads (`fetchBrief` now appends `?user=<userId>`). Offline at signup: the texts queue as `pendingDemoSignup` and the POST drains on the next signal (restoreOnline). `403/404` → honest inline card on Home ("Demo signup is off on this server — enter the server's TOOL_SECRET…") wired to the existing secret field; the manual byPhone path untouched.
- **Area-brief fallback**: with no personal brief, Home silently `POST /demo/area-brief {lat, lon}` (device position if shared, else demo center), renders it as the safety brief with an "area brief — sign up for personalized alerts" chip + a one-text join button; refresh throttled to ≥60 s; the honest empty state now only appears when BOTH routes are absent (`/demo/area-brief` proven 403/404/dead). Also fixes an offline-boot forever-skeleton (skeleton gated on `loading.brief` alone). /911 bar now reflects the viewed brief (personalized or area).
- **Scroll**: everything scrolls natively — added `touch-action: pan-y` + `-webkit-overflow-scrolling: touch` + `overscroll-behavior: contain` to every scrollable surface (screens, sheet, onboard, modal; gallery pan-x); `touch-action:none` stays ONLY on the map canvas; on-device (≤520px) the shell itself no longer scrolls/rubber-bands (`html,body overflow:hidden` at that width + `overscroll-behavior:none` globally) — the nested body bounce is what read as inverted scroll. No custom drag handlers exist (verified: the only touch JS is on the map canvas, and nav taps don't scroll-swipe).
- **DIRECTS delivery**: merged view already carries (a) my sent DMs from the queue, (b) `/mesh/state` messages with `to === myDeviceHash` as received bubbles (hashed `from` label), (c) downlink-bundle messages; now with a 2 s mesh-state poll in online/gateway (draft-preserving in-place render, focus only if it was in the box), a Directs tab badge + per-thread "new" chip for unseen `to:me` DMs (stamps seen on view), and the compose-bar line "Delivered through the mesh's next node with signal — even while your status bar says No Service."
- SW `CACHE_VERSION` → `sw-v4`; `/demo` added to the pass-through prefix list in sw.js + the harness proxy (server.mjs). Never cached, always live.

Screenshots: `map-ui-home-brief.png` (personalized), `map-ui-home-area.png` (area fallback + join), `map-ui-directs.png` (received-DM thread + badge behavior asserted).

## Follow-up 3 — standalone /b brief page (pushed)

`apps/web/b.html` (single file, imports app.css tokens) — reads `?id=<userId>` (or a `/b/<id>` path), fetches same-origin `GET /tools/brief/<id>` with `X-Skywatch-Tool-Secret` from localStorage config when set, and renders the brief in the app's own components: hazard cards + severity chips, ordered actions, verified shelter with the confidence bar (or its honest null-state card), official source, pinned 911 (hazards only). States: skeleton → content, plus honest cards for 404 ("not live"), 401 ("server checks the tool secret"), no-id, and network loss. `b/index.html` is a thin shim redirecting `…/b/…` to `b.html?id=…`. Registered in the SW precache (`sw-v5`). Smoke on the throwaway server: fake id → graceful 404 state (`map-ui-b-404.png`); pushed to origin/main (`a2a4c8e` + SW fix `fd220f8`).

Known gap (api-side): the map link the backend composes is `PUBLIC_BASE_URL + "/b/" + userId` — a static dir-serve answers `/b/<id>` with a 404 before any shim can run. The api repo needs one route (`app.get("/b/:id")` serving b.html's bytes / a rewrite) for text map links to land on the page; until then the page is reachable at `/b.html?id=<id>`.

## Follow-up 4 — resume a real SMS signup (pushed)

Step 0 of onboarding now carries an **"Already signed up over SMS?"** card: phone input (+ E.164, tolerates a country-code-less 10-digit entry) + Continue → `POST /demo/brief {phone}` (Task 8h contract) → on success the profile becomes `{phone, platform:"sms", lang, userId, onboarded}` (+ cfg.userId), the brief from the live record renders straight to Home with the toast "Resuming your real signup — brief from Skywatch's live record."; 404 → "That phone isn't signed up yet — do the quick signup below" (normal flow continues); 403 (gate off) / no-signal → honest inline messages; button shows "Checking…" while in flight. Step-0 stuck-feel: Continue now reads "Say hi and continue", every step re-renders with a `.ob-step` entrance animation and scrolls the onboarding sheet to top. Verified headless (mocked contract-shape responses): 404 / success→Home-with-brief / 403 / label+scroll-reset all asserted; SW `sw-v6`; pushed `931b07f`.

## Follow-up 5 — resume phone normalization (pushed)

Finding #5: a valid account's number ("4258329409") posted raw and got a false 404. The resume card now normalizes to E.164 BEFORE any POST (digits-only extraction handles ASCII + Unicode dashes/parens/spaces): 10 digits → `+1` + digits; 11 leading-1 → `+1` + last 10; leading `+` → kept; anything else → friendly inline error with no POST. "4258329409" → `+14258329409` (the controller-verified case). The resume Continue button is the orange primary (was `btn-ok` green). 404 copy unchanged for genuinely-unknown numbers. Headless smoke asserts all six input shapes POST exactly `+14258329409` and resume to Home, plus the invalid-input no-POST guard; SW `sw-v7`; pushed `e38b6dd`.

## What shipped (original build)

### 1. Offline tile pack (committed, no network at demo time)
- 16 tiles, 0.74 MB total (≤ 3 MB cap), all valid 256×256 PNGs (PNG magic + IHDR verified; 16/16 unique).
- Source: task mandated Carto `dark_all` — **no longer keyless**: every `basemaps.cartocdn.com` / fastly mirror host now returns a 2513-byte "API KEY REQUIRED" placeholder (Stadia also 401). Substituted **Esri Canvas World_Dark_Gray_Base** (keyless raster, standard z/x/y) and converted JPEG→PNG so the pack is all valid PNGs. Visual result is the same dark near-black street map as the reference. Small `© Esri · © OpenStreetMap contributors` attribution line bottom-left of the map HUD (honesty, per tile-source reality).
- Coverage committed under `apps/web/tiles/`: z14 downtown 4×3 (`x 2623–2626, y 5721–5723` ≈ lon -122.37…-122.28 / lat 47.62…47.576) + z13 context 2×2 (`x 1312–1313, y 2861–2862`). The JS renderer keeps the same manifest (`tileKeys` in app.js) and the SW precaches the identical 16 paths.
- Renderer: tile slippy map on the existing canvas — mercator projection so pins align with tiles; coarse z13 painted under fine z14; pan (touch drag), pinch/2-finger zoom, +/− buttons and wheel all work; load-on-demand from the local pack ONLY (a `tileKeys` manifest means no 404 spam outside the pack; views outside pack bounds render the base fill + glyphs). View clamped to the packed area so the demo never shows blank map.

### 2. Brand pins / markers on the map
- Resources: 44px white circles with dark glyphs per kind (shelter = house + residents, pharmacy = plus-cross, community_center = flag), status pill beneath: `open · 0.73` with dot — green ≥0.5, gray unknown, red closed, amber full. Partner = 2px orange ring. Selected pin gets an orange halo ring.
- Beacons: orange pulsing dot + dark priority chip (`P1`, `P2`). Blocked roads: red segment dots. User dots: 8px-equivalent 4px-radius white at 70%. Satellite plume/alert overlay recolored to the orange family.

### 3. Selected-pin interaction (the reference's core)
- Tap a pin → **animated glowing orange route line** (quadratic bow, layered glow strokes + moving dash core, rAF-animated) from the user dot to the pin; the view auto-reframes so pin + route sit in the strip above the card.
- Dark **detail sheet card** in the reference geometry: lower-third, 20px radius, hairline border, soft shadow — name, distance, status chip (`OPEN` + `verified just now · confidence 73%`), partner/kind chips, hours line, and a glowing orange **Directions** primary button (opens `geo:` on the phone). Soft scrim (28% dim) so the route stays visible; scrim tap / X / Escape closes and clears the route. Route line + card is demo guidance, not navigation (honest note on the card).

### 4. Theme refresh — whole app to orange/black
- Tokens: bg `#0A0A0B`, surfaces `#111114`/`#17171B`, raise `#1E1E23`, text `#F5F5F5`/`#9CA3AF`/`#6B7280`, accent `#F97316` (+ hover `#FB923C`, pressed `#EA580C`, dim rgba). Semantic green/amber/red kept.
- Orange owns the interactive layer: active tab, primary buttons (+ pressed shade), sheet CTA, toggles ON, mode-row/lang-row pressed states, status-bar signal arcs + gateway mode chip, gateway banner, route glow. Mesh/offline concept stays purple; 911 + danger stay red; battery/confidence stay green.
- `theme-color` (meta + manifest) → `#0A0A0B`.

### 5. Icons + brand moments
- Override honored: icons now come from the **real logo file** (`Downloads/WhatsApp Image 2026-10-17 at 22.51.10.jpeg`) via ffmpeg — square-crop + lanczos downscale: `icons/icon-512.png`, `icon-180.png`, **new `icons/icon-32.png` favicon** (32px link added to app.html), plus `apps/web/brand/logo.png` (800×533) used in-app: home hero card + onboarding header (with graceful `onerror` removal).

### 6. Service worker
- `CACHE_VERSION` bumped `sw-v1` → `sw-v2`; precache now includes the 16 tiles, brand/logo.png and icon-32.png (tiles fetched through the SW are cache-first, same-origin only).

## Verification
- `node --check apps/web/app.js` ✓, `node --check apps/web/sw.js` ✓.
- Served `apps/web` from a throwaway static server (port 8847, untouched 3000/8080/4317); Playwright at 390×844: all tile requests resolve to same-origin `/tiles/*` from the pack — zero external tile hosts — and the Map tab + selected-pin sheet render as in the reference.
- Screenshots: `.superpowers/sdd/backend-build-plan/map-ui-map.png`, `map-ui-sheet.png`.
- `apps/api/public/` (gitignored deploy copy) refreshed via `npm run copyweb` so the API-served demo ships the same assets.

## Concerns / notes
- Google Fonts (Outfit) still loads from the network on first paint — pre-existing behavior; offline it falls back to system-ui (not touched, per no-behavior-change).
- Initial fit zoom was retuned (`0.09°` min-span floor → `0.02°`; zoom clamp 0.3–2.8 + fit cap 2.6) so the demo cluster fills the screen inside the packed tile scale — that's map-rendering scope, not data/behavior.
- At tile scales finer than z14 the pack upscales ~1.4× (soft). Fine for the reference look; a z15 ring around downtown would sharpen it if wanted later.
- While iterating I killed all `node.exe` processes once (taskkill) to restart the conversion server — if anything else node-based was running on this box at 23:37, that's why it stopped.

### Follow-up 5.1 & 6 — say-hi dead button (ROOT CAUSE: a real JS bug, not stale SW) + update flow & build chip

Headless repro (390×844, touch emulated, cold context) DID reproduce: tapping "Say hi and continue" threw `TypeError: Cannot read properties of undefined (reading 'push') at obSend` — `startOnboarding()` mints `state.ob = { step, obQueue, … }` WITHOUT the `texts` field that the new round-trip collector assumed, so the first tap died before `threadPush`. One-line fix (`state.ob.texts = state.ob.texts || []`). Fixed-and-verified: tap → thread gains "hi" + bot welcome → step 1 ("Where should we watch?") renders with scrollTop 0; the FULL walkthrough (hi → address+lang → consent → finish) passes with the single `POST /demo/signup {phone:"…", platform:"sms", texts:["hi","101 Yesler Way, Seattle","english"]}` and the brief landing on Home.

Stale-SW hardening added anyway (finding #5 showed the phone can trail the repo): an app-shell `controllerchange` → one session-scoped `location.reload()` (fresh builds activate immediately with skipWaiting/clients.claim — already in the SW), a 30-min `registration.update()` check, and a **Profile → "app build" chip** reading the live shell's CACHE_VERSION through the running service worker (`sw-v8`) so on-device builds are visible at a glance (first version mis-grepped its own code line — anchored regex; second pass fetched the wrong file — both caught by the same smoke, chip now returns `sw-v8`).

SW `CACHE_VERSION` → `sw-v8`; pushed.

## Follow-up 7 — platform-aware Directions (pushed)

Finding #7: the detail sheet's Directions used `geo:`, which iOS Safari ignores. The sheet CTA is now platform-aware (`directionsUrl` in app.js, exposed on the `window.__sky` debug hook): iOS (iPhone/iPad/iPod incl. iPadOS-as-Mac via `maxTouchPoints > 1`) → `https://maps.apple.com/?daddr=<lat>,<lon>&q=<name>`; Android → `geo:<lat>,<lon>?q=<lat>+<lon>(<name>)`; other → `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lon>`; always `target="_blank" rel="noopener"`. Uses the pin's own coords + name from state. Verified headless across four UA matrices (iPhone UA, Android UA, desktop UA, iPadOS masquerade with maxTouchPoints=5 emulated): all four resolve to the right URL/target. SW `sw-v9`; pushed. Untested on a physical device — the Apple Maps URL shape is standard (`?daddr=` opens the Maps app with drive directions), but the coordinator should give it one tap on the demo iPhone before the live moment.
