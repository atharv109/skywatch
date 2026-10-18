# Native scaffold report — iOS (+ Android) Capacitor wrap of apps/web

Date: 2026-10-18 · Branch: main · Commit: "feat(native): Capacitor iOS/Android scaffold..."

## Status

DONE (pre-Mac). `apps/native/` is a real Capacitor project with BOTH platforms
added (no placeholder templates — `npx cap add ios` / `npx cap add android` are
pure Node and ran on Windows, so the committed `ios/` and `android/` are
authentic generated projects, already registered with the BLE plugin and
patched for permissions/entitlements). App.js transport seam landed in
`apps/web/app.js` (committed inside e31154e — a parallel session swept the
in-flight edit into its "fix(web): demo signup..." commit; content identical,
no re-commit possible without racing an active writer).

## Plugin decision + rationale

**Chosen: `@capgo/capacitor-bluetooth-low-energy` ^8.2.7 (MPL-2.0, free).**

iPhone↔iPhone peer chat needs BOTH roles on iOS in one app: CBPeripheralManager
(advertise a custom service, accept peer writes, notify peer subscribers) AND
CBCentralManager (scan, connect, write, subscribe). Candidates:

- `@capacitor-community/bluetooth-le` — central role only. Disqualified.
- Capawesome `@capawesome/capacitor-bluetooth-low-energy` — paid Insiders-only;
  its docs admit iOS peripheral characteristic writes/notify events are
  Android-only in places. Disqualified on cost + iOS gaps.
- **Cap-go fork (chosen)** — merged PR #13 (v8.2.0) added the full GATT-server
  role: `addGattService`, `setGattCharacteristicValue`,
  `notifyGattCharacteristicChanged`, events `centralConnected/Disconnected`,
  `gattCharacteristicReadRequest/WriteRequest`, `startAdvertising({services})`,
  all implemented on iOS with CBPeripheralManager. VERIFIED DUAL ROLE by reading
  `ios/Sources/.../BluetoothLowEnergy.swift`: `initialize({mode:'peripheral'})`
  creates the CBPeripheralManager, and `startScan()` lazily creates a second,
  concurrent CBCentralManager (it is NOT mode-gated) — one app, both roles.
- Custom Swift plugin — NOT needed; fallback documented (~200-line
  CBPeripheralManager+CBCentralManager pair behind the same 6 JS methods) in
  `apps/native/BUILD-ON-MAC.md` + below. No custom Swift shipped since an
  existing maintained plugin covers the exact need.

## What was built

- `apps/native/sync-web.mjs` — copies apps/web → `www/` (webDir), injects
  `<script src="native-ble.js">` + `window.SKYWATCH_NATIVE = true` into the
  index.html, drops `sw.js` (browser-only caching). Idempotent; `npm run sync`.
- `apps/native/native-ble.js` — the transport adapter. Both roles: advertise
  service `A7C4E1B0-3E5D-4F6A-9B2C-1D8E5F7A3B2C` (chars `C1B2…`=out/notify,
  `F0E1…`=in/write) + scan the same UUID, auto-connect Skywatch peers.
  Frames `SW|m|<mid>|<i>|<n>|<b64>` ≤180 B, reassembled, dedup by id (queue +
  server both dedup again), TTL/hops bump on relay (sig excludes hops).
- `apps/web/app.js` seam (guarded, browser build untouched):
  - new `signedPacketFor(p, identity)` extracted from syncGateway (pure move);
  - `syncGateway` relays packets carried as `p.remote.signed` untouched
    (origin device's Ed25519 sig — never re-signed); own packets signed as
    before, exactly per apps/api/src/mesh/sig.ts;
  - new `ingestRemotePackets(packets)` — BLE-arrived peer packets ride the SAME
    queue, dedup by id, drain to `/mesh/sync` when this device has signal;
  - boot() seam: `window.skywatchBleTransport({state, signedPacketFor,
    ingestRemotePackets, syncGateway, persist, ensureIdentity, toast})` — only
    when the flag is set. Gateway path (POST /mesh/sync via plain fetch in the
    webview, config.api URL) unchanged.
- `ios/` — real project (SPM; Capacitor 8 — no Podfile, `Podfile.placeholder`
  explains why). Info.plist patched: `UIBackgroundModes`
  [bluetooth-central, bluetooth-peripheral] + both BT usage strings.
- `android/` — real project; manifest patched: BLUETOOTH_SCAN (neverForLocation),
  BLUETOOTH_ADVERTISE, BLUETOOTH_CONNECT, ACCESS_FINE_LOCATION.
- `apps/native/BUILD-ON-MAC.md` — prereqs, exact commands, FREE-Apple-ID
  signing walk-through (com.skywatch.app likely taken → append initials),
  7-day profile caveat, troubleshooting (provisioning, SPM fetch, dev mode,
  BLE permission re-prompt), 2-phone demo checklist.
- `apps/native/README.md` — structure + plugin rationale.

## Verified WITHOUT a Mac

- `node --check` on app.js, native-ble.js, sync-web.mjs and the copied www
  copies — all pass.
- `npm install` + `npx cap add ios` + `npx cap add android` + `npx cap sync
  android` all succeeded on Windows; `packageClassList` shows the BLE plugin
  registered into both platforms; `ios/App/App/public` + Android assets got the
  injected index.html (flag verified present).
- Info.plist + AndroidManifest parse as well-formed XML; all JSON lints.
- Web build (flag OFF) still boots via apps/web/server.mjs on :8099 —
  app.html/app.js/index 200, seam inert (no flag, no call).

## NOT verifiable without a Mac + 2 iPhones (known risks)

1. On-device BLE dual-role behavior end-to-end (the lazy-central pattern is
   verified in plugin source, not at runtime).
2. MTU: frames are ≤156 B (header + b64 of 100-byte chunks) — safe under the
   iOS-negotiated iPhone↔iPhone MTU 185; NOT safe if an MTU-23 link ever
   negotiates (writes could truncate → frame lost; re-sent only on reconnect,
   40 ms pacing mitigates queue drops). A robust NACK/retry is a follow-up.
3. iOS backgrounded advertising: first peer connection must happen with both
   apps foregrounded (in BUILD-ON-MAC.md demo checklist).
4. Signing/expiry with a free Apple ID (7-day profile).
5. Android gradle/Xcode builds.