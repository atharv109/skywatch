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

## What shipped

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