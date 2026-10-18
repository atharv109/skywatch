# Skywatch iOS — build on a Mac

This scaffold was prepared on Windows (`apps/native/`): `apps/web` copied into
`www/` with the `window.SKYWATCH_NATIVE` flag + `native-ble.js` injected, the real
`ios/` project already generated (`npx cap add ios` — done on Windows, it is pure
Node), the BLE plugin auto-registered through SPM, and `IOS/App/App/Info.plist`
already patched with the BLE background modes. On the Mac you only: install,
sync assets, open Xcode, sign on a device.

## Prereqs (macOS 14.3+, one-time)

1. Xcode 16+ — App Store install, then launch once and accept the license and
   the "additional components" (iOS platform).
2. Xcode > Settings > Accounts — sign in with your Apple ID (a FREE Apple ID
   works for device installs; see Signing below).
3. Node.js 20+ (brew install node or nodejs.org).
4. An iPhone with iOS 16+ and a USB-C/Lightning cable. "Developer Mode" must be
   ON on the phone: Settings > Privacy & Security > Developer Mode.

## Commands

```bash
cd apps/native
npm install        # capacitor core/cli/ios + @capgo/capacitor-bluetooth-low-energy
npm run sync       # rebuilds www/ from ../web (idempotent) — rerun after any web edit
npx cap sync ios   # copies www/ into ios/App/App/public + refreshes plugin config
npx cap open ios   # opens ios/App/App.xcodeproj in Xcode
```

Do NOT create a new Xcode project — the `ios/` directory committed in this repo
is the project. Never edit files under `ios/App/App/public` by hand (generated
by cap sync from `www/`).

## Signing (free Apple ID, ad-hoc on-cable — no paid account needed)

1. Plug the iPhone into the Mac. Accept "Trust this computer" on the phone.
2. In Xcode: target **App** > Signing & Capabilities.
   - Team: your Personal Team (free Apple ID).
   - Bundle identifier: `com.skywatch.app` is likely TAKEN for personal teams —
     append your initials, e.g. `com.skywatch.app.yy` (unique-anystring is fine;
     it must match the app's device installs, nothing else).
3. Same tab: make sure **Background Modes** shows `bluetooth-central` +
   `bluetooth-peripheral` (already in `ios/App/App/Info.plist` — Xcode renders
   them as checkboxes). If missing: add via Capabilities > Background Modes.
4. Select the iPhone in the device scheme > Run (Cmd+R). First run on the phone:
   Settings > General > VPN & Device Management > your Apple ID > **Trust** —
   because free profiles are a few minutes only the first launch needs this.

Free-account caveat: provisioning expires after **7 days** — rebuild/R Run
before a demo day. Paid account ($99/yr): same tab, your team, no expiry.

## What is already wired (do not redo)

- `www/` = copy of the behavior-complete web app + `<script src="native-ble.js">`
  + `window.SKYWATCH_NATIVE = true` (see `apps/native/sync-web.mjs`).
- BLE plugin: `@capgo/capacitor-bluetooth-low-energy` — peripheral + central role.
  Registered via Swift Package Manager (`ios/App/CapApp-SPM/Package.swift`,
  auto-managed). Capacitor 8 is SPM-first — **no Podfile is used**; if the
  workspace shows "no Podfile", that is correct.
- `Info.plist` background modes + `NSBluetoothAlwaysUsageDescription`.
- Transport: `www/native-ble.js` — advertises service
  `A7C4E1B0-3E5D-4F6A-9B2C-1D8E5F7A3B2C` (chars `C1B2...` out / `F0E1...` in),
  scans+connects, chunked frames (<=180 B), reassembly, id-dedup; packets ride
  the SAME queue as the web build and drain to `/mesh/sync` when the device has
  signal (`fetch` works inside the webview — point `config.api` at the deployed
  API in the app's Mesh/config surface).

## Troubleshooting

- **Signing error "requires a provisioning profile"** — Bundle id collision:
  change the bundle id (step 2 above) and Run again.
- **"No code signing identities found"** — free Apple ID not signed into
  Xcode (step Prereqs 2); signing into the phone's App Store is NOT enough.
- **"Developer Mode disabled"** on-device — enable it (Prereqs 4); a first Xcode
  install makes the toggle appear after a reboot.
- **SPM fetch fails ("can't resolve CapgoCapacitorBluetoothLowEnergy")** —
  network blocked the GitHub fetch: File > Packages > Resolve Package
  Dependencies, or `cd apps/native && npx cap sync ios` again.
- **Bluetooth permission not prompted** — the usage string is in Info.plist;
  delete the app from the phone and Run again to re-prompt.
- **App builds but peers never connect** — both phones need the app in the
  FOREGROUND for the first connect (backgrounded peripherals stop advertising);
  airplane OFF, Bluetooth ON in Settings (not Control Center only).
- **`npx cap sync` says "webDir www does not exist"** — run `npm run sync`
  first (it builds www from `../web`).

## Demo checklist (2 phones, 1 gateway)

1. Build+install on both phones (free account, developer mode, trust).
2. Phone A: airplane mode ON, WiFi OFF, cellular OFF → app says offline (mesh).
3. Phone B: airplane mode OFF (signal) → app AUTO → gateway → ONLINE.
4. Phone A (airplane mode, just app foreground): send a "Trapped" beacon.
5. Expect A+B peering over BLE within a few seconds (console:
   `[skywatch-ble] connected (central)`); `window.__skyBle.peers()` non-empty.
6. Phone B's `/mesh/sync` run carries A's packet (check the Mesh tab: the
   neighbor's report appears; the API accepted it — origin sig verified).
7. Flip A's airplane mode OFF → A drains its own queue too; back ONLINE.