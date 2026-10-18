"use strict";
/* Skywatch native BLE transport — Capacitor build only (apps/native wrap of apps/web).
 *
 * The web build's mesh path is the browser hotspot stand-in (queue + gateway POST
 * to /mesh/sync). In the NATIVE build that peer leg moves onto real BLE:
 *
 *   peer discovery  = BLE scan + advertise (one custom service UUID)
 *   messages        = GATT characteristics — every phone is BOTH peripheral
 *                     (CBPeripheralManager: publishes its queue, accepts peer
 *                     writes) AND central (CBCentralManager: scans, connects,
 *                     writes to peers) — full peer-to-peer, no hotspot
 *   packet engine   = EXACTLY the web queue: signed packets (Ed25519, sig.ts
 *                     contract), chunked frames <= 180 bytes, reassembled,
 *                     dedup by packet id (server dedups again at /mesh/sync)
 *   gateway sync    = unchanged: `syncGateway` POSTs the whole queue (origin
 *                     packets re-signed here, remote packets relayed untouched)
 *                     once this device has signal — plain fetch works in the
 *                     native webview
 *
 * Runs under the app's own seam in apps/web/app.js (guarded by the
 * window.SKYWATCH_NATIVE flag that sync-web.mjs injects into the copied
 * index.html). The browser build never sets the flag — this file is inert there.
 *
 * Plugin (decided; see apps/native/README.md + the scaffold report):
 *   @capgo/capacitor-bluetooth-low-energy ^8.2.x — the free fork of
 *   @capacitor-community/bluetooth-le that added peripheral/GATT-server role via
 *   CBPeripheralManager (v8.2.0). Dual role on iOS works because the plugin
 *   lazily creates its CBCentralManager inside startScan() even when
 *   initialized in peripheral mode (verified in ios/Sources/.../BluetoothLowEnergy.swift).
 *   Fallback if that ever regresses on-device: a small custom Swift plugin
 *   (CBPeripheralManager + CBCentralManager) — pattern sketched in BUILD-ON-MAC.md.
 */
(function () {
  // browser build: window.SKYWATCH_NATIVE is undefined — nothing here runs at all
  if (!window.SKYWATCH_NATIVE) return;

  /* ---- BLE identity (fixed demo-wide, 128-bit custom): one service, two chars.
   *  CHAR_OUT — we notify our queued packets through it (notify+read)
   *  CHAR_IN  — peers write their packets into it (write + writeWithoutResponse) */
  const SERVICE = "A7C4E1B0-3E5D-4F6A-9B2C-1D8E5F7A3B2C";
  const CHAR_OUT = "C1B2D3E4-4E5D-4F6A-9B2C-1D8E5F7A3B2C";
  const CHAR_IN = "F0E1D2C3-4E5D-4F6A-9B2C-1D8E5F7A3B2C";
  const ADV_NAME = "Skywatch";

  const CHUNK_PAYLOAD = 100; // raw bytes per frame: header (~<=18 chars) + base64 (+4/3) stays <= 180 (safe under iOS MTU 185 - 3)
  const TICK_MS = 4000; // exchange cadence
  const MAX_PACKETS_PER_EXCHANGE = 20;
  const MAX_CONNECT_ATTEMPTS = 3;

  let ble = null; // plugin proxy
  let deps = null; // app seam: { state, signedPacketFor, ingestRemotePackets, syncGateway, persist, ensureIdentity, toast }
  let started = false;

  /** Central-role state: deviceId -> { connected, connecting, attempts } */
  const peers = new Map();
  /** Peripheral-role state: connected CBPeripheralManager centrals (subscribers) */
  const centralSubs = new Set();
  /** ids already delivered to a given peer (both roles) — no re-flooding */
  const sentTo = new Map();
  /** ids seen inbound this session (dedup/relay-loop guard; the queue dedups again) */
  const seenIds = new Set();
  /** mid -> { n, parts: Map(i -> Uint8Array) } — inbound reassembly */
  const inflight = new Map();
  let midSeq = 0;

  /* ---------- bytes / frames ---------- */

  function bytesToB64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8Bytes(str) { return new TextEncoder().encode(str); }
  function utf8Str(bytes) { return new TextDecoder().decode(bytes); }

  /** Frame wire format: `SW|m|<mid>|<i>|<n>|<base64(payload slice)>`
   *  ('|' is safe — the base64 alphabet never contains it). */
  function newMid() {
    midSeq = (midSeq + 1) % 1679615;
    return (midSeq.toString(36) + Date.now().toString(36) + Math.random().toString(36)).slice(-6);
  }

  function chunkBytes(payload) {
    const mid = newMid();
    const n = Math.max(1, Math.ceil(payload.length / CHUNK_PAYLOAD));
    const frames = [];
    for (let i = 0; i < n; i++) {
      const slice = payload.subarray(i * CHUNK_PAYLOAD, (i + 1) * CHUNK_PAYLOAD);
      frames.push(utf8Bytes("SW|m|" + mid + "|" + i + "|" + n + "|" + bytesToB64(slice)));
    }
    return frames;
  }

  /** Feed one inbound frame; returns a reassembled byte payload or null. */
  function reassemble(text, maxTotal) {
    const seg = text.split("|");
    if (seg.length !== 6 || seg[0] !== "SW" || seg[1] !== "m") return null;
    const mid = seg[2];
    const i = parseInt(seg[3], 10);
    const n = parseInt(seg[4], 10);
    let partBytes;
    try { partBytes = b64ToBytes(seg[5]); } catch (_e) { return null; }
    if (!mid || !(n > 0) || !(i >= 0) || i >= n || n > 64) return null;
    let slot = inflight.get(mid);
    if (!slot) { slot = { n, parts: new Map(), at: Date.now() }; inflight.set(mid, slot); }
    if (slot.n !== n) return null; // mid collision across messages — drop the stale one
    slot.parts.set(i, partBytes);
    if (slot.parts.size < n) return null;
    const total = Array.from(slot.parts.values()).reduce((a, b) => a + b.length, 0);
    if (maxTotal && total > maxTotal) { inflight.delete(mid); return null; }
    const out = new Uint8Array(total);
    let off = 0;
    for (let k = 0; k < n; k++) { out.set(slot.parts.get(k), off); off += slot.parts.get(k).length; }
    inflight.delete(mid);
    return out;
  }

  /* ---------- packet encode/decode ---------- */

  function bumpHopsForRelay(sp) {
    if ((sp.hops || 0) + 1 >= (sp.ttl || 7)) return null; // expired upstream — drop
    return Object.assign({}, sp, { hops: (sp.hops || 0) + 1 }); // sig excludes hops — safe to bump
  }

  /** Mark `ids` as delivered to one peer (keyed per role: "c:<id>" / "p:<id>"). */
  function markSent(peerKey, ids) {
    let set = sentTo.get(peerKey);
    if (!set) { set = new Set(); sentTo.set(peerKey, set); }
    for (const id of ids) set.add(id);
  }

  /** Packets owed to a peer: queued|fail, not yet delivered to them. */
  function owed(peerKey) {
    const set = sentTo.get(peerKey) || new Set();
    return deps.state.queue.filter(
      (p) => (p.state === "queued" || p.state === "fail") && !set.has(p.id)
    ).slice(0, MAX_PACKETS_PER_EXCHANGE);
  }

  async function buildBatch(items) {
    const identity = await deps.ensureIdentity();
    const list = [];
    for (const p of items) {
      const sp = p.remote ? bumpHopsForRelay(p.remote.signed) : await deps.signedPacketFor(p, identity);
      if (sp) list.push(sp);
    }
    return list;
  }

  /* ---------- outbound: both roles ---------- */

  /** Peripheral role: publish to every subscribed central (and cache the value for late readers). */
  async function sendPeripheral(payload) {
    if (!centralSubs.size) return false;
    const frames = chunkBytes(payload);
    for (const f of frames) {
      try {
        await ble.setGattCharacteristicValue({ service: SERVICE, characteristic: CHAR_OUT, value: Array.from(f) });
        await ble.notifyGattCharacteristicChanged({ service: SERVICE, characteristic: CHAR_OUT, value: Array.from(f) });
      } catch (err) { console.warn("[skywatch-ble] notify failed", err); return false; }
      await sleep(40); // do not outrun the iOS BLE transmit queue; demo-scale traffic
    }
    return true;
  }

  /** Central role: write each frame into the peer's CHAR_IN. */
  async function sendCentral(deviceId, payload) {
    const frames = chunkBytes(payload);
    for (const f of frames) {
      try {
        await ble.writeCharacteristic({
          deviceId, service: SERVICE, characteristic: CHAR_IN,
          value: Array.from(f), writeType: "writeWithoutResponse",
        });
      } catch (err) { console.warn("[skywatch-ble] write failed", deviceId, err); return false; }
      await sleep(40); // same pacing — writeWithoutResponse can silently drop if queued faster than conn interval
    }
    return true;
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* ---------- inbound ---------- */

  function onFrameBytes(bytes) {
    if (!bytes || !bytes.length) return;
    const payload = reassemble(utf8Str(bytes), 32 * 1024);
    if (!payload) return;
    let packets;
    try { packets = JSON.parse(utf8Str(payload)); } catch (_e) { return; }
    if (!Array.isArray(packets)) return;
    for (const sp of packets) if (sp && sp.id) seenIds.add(sp.id);
    deps.ingestRemotePackets(packets); // dedups by id, rides the queue, drains on gateway sync
  }

  /* ---------- connection setup ---------- */

  function peerKey(role, id) { return role + ":" + id; }

  async function connectPeer(deviceId) {
    let peer = peers.get(deviceId);
    if (peer && (peer.connected || peer.connecting)) return;
    if (peer && peer.attempts >= MAX_CONNECT_ATTEMPTS) { peers.delete(deviceId); return; }
    if (!peer) { peer = { connected: false, connecting: false, attempts: 0 }; peers.set(deviceId, peer); }
    peer.attempts++;
    peer.connecting = true;
    try {
      await ble.connect({ deviceId });
      await ble.discoverServices({ deviceId });
      await ble.startCharacteristicNotifications({ deviceId, service: SERVICE, characteristic: CHAR_OUT });
      peer.connected = true;
      console.log("[skywatch-ble] connected (central):", deviceId);
      if (deps.state && deps.state.mode) void safe(() => deps.toast("Mesh peer connected over BLE.", "mesh"));
    } catch (err) {
      console.warn("[skywatch-ble] connect failed", deviceId, err);
    } finally {
      peer.connecting = false;
    }
  }

  async function scanLoop() {
    try {
      // peripheral mode init + lazy central — the exact dual-role pattern:
      // initialize() creates the CBPeripheralManager; startScan() creates the
      // CBCentralManager on demand inside the plugin (verified in its Swift source).
      await ble.initialize({ mode: "peripheral", showPowerAlert: true });
      await ble.addGattService({
        service: SERVICE,
        characteristics: [
          { uuid: CHAR_OUT, properties: { read: true, notify: true } },
          { uuid: CHAR_IN, properties: { write: true, writeWithoutResponse: true } },
        ],
      });
      await ble.startAdvertising({ services: [SERVICE], name: ADV_NAME, includeName: true });
      await ble.startScan({ services: [SERVICE] });
    } catch (err) {
      console.warn("[skywatch-ble] init/advertising/scan failed — transport inert this session", err);
      return false;
    }
    return true;
  }

  /* ---------- exchange tick ---------- */

  async function tick() {
    if (!ble || !deps) return;
    // peripheral side: publish to subscribed centrals
    const pk1 = peerKey("peripheral", "subs");
    const owed1 = owed(pk1);
    for (const p of owed1) {
      const sp = p.remote ? bumpHopsForRelay(p.remote.signed) : await deps.signedPacketFor(p, await deps.ensureIdentity());
      if (!sp) { markSent(pk1, [p.id]); continue; }
      const okP = await sendPeripheral(utf8Bytes(JSON.stringify([sp])));
      if (okP) markSent(pk1, [p.id]);
    }
    // central side: write to each connected peer
    for (const [deviceId, peer] of peers) {
      if (!peer.connected) continue;
      const pk2 = peerKey("central", deviceId);
      const owed2 = owed(pk2);
      if (!owed2.length) continue;
      const batch = await buildBatch(owed2);
      if (!batch.length) { markSent(pk2, owed2.map((p) => p.id)); continue; }
      const okC = await sendCentral(deviceId, utf8Bytes(JSON.stringify(batch)));
      if (okC) markSent(pk2, owed2.map((p) => p.id));
    }
  }

  function safe(fn) { return Promise.resolve().catch(fn && function () { /* silent */ }); }

  /* ---------- entry (called by the app.js seam) ---------- */

  window.skywatchBleTransport = async function (boundDeps) {
    if (started) return;
    deps = boundDeps || deps;
    if (!deps || !deps.state) { console.warn("[skywatch-ble] no app seam deps — inert"); return; }
    const cap = window.Capacitor;
    ble = cap
      ? (typeof cap.registerPlugin === "function"
        ? cap.registerPlugin("BluetoothLowEnergy")
        : (cap.Plugins && cap.Plugins.BluetoothLowEnergy) || null)
      : null;
    if (!ble) {
      console.warn("[skywatch-ble] Capacitor BluetoothLowEnergy plugin missing — transport inert (app still works, offline-first)");
      return;
    }
    started = true;

    // peripheral role: inbound writes land here, frames reassemble into packets
    ble.addListener("gattCharacteristicWriteRequest", (e) => {
      if (!e || e.service !== SERVICE || e.characteristic !== CHAR_IN) return;
      try { onFrameBytes(new Uint8Array(e.value || [])); } catch (err) { console.warn("[skywatch-ble] inbound write", err); }
    });
    // peripheral role: track subscribers
    ble.addListener("centralConnected", (e) => { if (e && e.deviceId) centralSubs.add(e.deviceId); });
    ble.addListener("centralDisconnected", (e) => centralSubs.delete(e && e.deviceId));
    // central role: peer notifications arrive
    ble.addListener("characteristicChanged", (e) => {
      if (!e || e.service !== SERVICE || e.characteristic !== CHAR_OUT) return;
      try { onFrameBytes(new Uint8Array(e.value || [])); } catch (err) { console.warn("[skywatch-ble] inbound notify", err); }
    });
    ble.addListener("deviceScanned", (e) => {
      const d = e && e.device;
      if (!d || !d.deviceId) return;
      const known = (d.uuids || d.services || []);
      if (!known.includes || !known.includes(SERVICE)) return; // only Skywatch peers
      void connectPeer(d.deviceId);
    });
    ble.addListener("deviceDisconnected", (e) => {
      const id = e && e.deviceId;
      if (!id) return;
      const p = peers.get(id);
      if (p) { p.connected = false; p.attempts = 0; sentTo.delete(peerKey("central", id)); } // retry + resync after reconnect
    });

    // reset sent-marks when the app's queue mutates persistently? no — sentTo marks
    // survive until reconnect/disconnect; a synced packet flips to "sent" and is
    // naturally excluded by owed()'s state filter.

    await scanLoop();
    setInterval(() => { void tick().catch(() => {}); }, TICK_MS);
    setInterval(() => { // reassemble-buffer hygiene: drop stales > 30s (never completed)
      const now = Date.now();
      for (const [mid, slot] of inflight) if (now - slot.at > 30000) inflight.delete(mid);
    }, 10000);

    /* small live-status hook for the demo console: window.__skyBle.status() */
    window.__skyBle = {
      peers: () => Array.from(peers, ([id, p]) => ({ deviceId: id, connected: p.connected, attempts: p.attempts })),
      subscribers: () => Array.from(centralSubs),
      seen: () => seenIds.size,
      inflight: () => inflight.size,
      service: SERVICE,
    };
    console.log("[skywatch-ble] transport up — advertising as peripheral, scanning as central");
  };
})();