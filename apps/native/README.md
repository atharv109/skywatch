# Skywatch native (apps/native/)

Capacitor wrap of the behavior-complete web app (`apps/web`) with the peer
transport swapped from the browser hotspot stand-in to real BLE peer-to-peer.

```
package.json            capacitor 8 + @capgo/capacitor-bluetooth-low-energy 8.2.x
capacitor.config.json   appId com.skywatch.app · appName Skywatch · webDir www
sync-web.mjs            copies apps/web → www/ (the BUILT COPY webDir serves) and
                        injects <script src="native-ble.js"> + window.SKYWATCH_NATIVE
native-ble.js           the BLE transport adapter (runs only behind that flag)
ios/, android/          REAL platform projects, generated here (`npx cap add ios/android`
                        is pure Node) — already registered for the BLE plugin via SPM;
                        Info.plist (background modes) + AndroidManifest (BLE permissions) patched
BUILD-ON-MAC.md         the exact Mac build/sign/demo steps
```

## Verify on this machine / run web build

```bash
npm run sync          # rebuilds www/ from apps/web (idempotent)
node --check native-ble.js
```

## Why @capgo/capacitor-bluetooth-low-energy

iPhone-iPhone peer chat needs BOTH roles on iOS: `CBPeripheralManager`
(advertise + accept writes) AND `CBCentralManager` (scan + connect + write).
`@capacitor-community/bluetooth-le` is central-only. Cap-go's free fork (MPL-2.0)
added the full peripheral role in v8.2.0 (`addGattService`,
`notifyGattCharacteristicChanged`, `gattCharacteristicWriteRequest` events,
`CBPeripheralManager` on iOS / `BluetoothGattServer` on Android). Dual role works
because the plugin lazily creates its CBCentralManager inside `startScan()`
even when initialized in peripheral mode (verified in its `BluetoothLowEnergy.swift`).
Fallback pattern if this ever regresses on-device: a ~200-line custom Swift
plugin exposing the same 6 methods (CBPeripheralManager + CBCentralManager) —
documented in the scaffold report.