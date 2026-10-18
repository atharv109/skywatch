import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import type { Db } from "mongodb";
import { loadConfig, type Config } from "../src/config.ts";
import { COLLECTIONS, closeDb, getDb } from "../src/db/client.ts";
import { createApp } from "../src/server.ts";
import { memoryStore } from "../src/store.ts";
import { memoryMatchStore } from "../src/match/store.ts";
import { memoryDeliverStore } from "../src/deliver/store.ts";
import { stubInboundRuntime } from "../src/deliver/runtime.ts";
import { memoryVerifyStore } from "../src/verify/store.ts";
import { stubVoiceRuntime } from "../src/deliver/voice_runtime.ts";
import { emptyPipelineResult } from "../src/pipeline/run.ts";
import { memoryMeshStore } from "../src/mesh/store.ts";
import { assembleMeshState } from "../src/mesh/state.ts";
import { makeSkywatchChat } from "../src/mesh/skywatch.ts";
import { processSync } from "../src/mesh/sync.ts";
import { fetchRoute, profileFor } from "../src/routes/osrm.ts";
import { sigMessage } from "../src/mesh/sig.ts";
import { ackMessage, buildDownlink, MESH_ACK_LINES } from "../src/mesh/downlink.ts";
import { MESH_MSG_STATUS_MAX, SKYWATCH_CORE_ID, type MeshPacketIn } from "../src/mesh/types.ts";
import { fetchSatelliteSection } from "../src/mesh/satellite.ts";
import { buildUserBrief } from "../src/brief/build.ts";
import { fallbackRender } from "../src/brief/fallback.ts";
import type { HazardDoc, ResourceDoc, RoadDoc } from "../src/types/docs.ts";
import type { Lang } from "../src/types/brief.ts";

const NOW = Date.now();

function smokeHazard(sourceId: string): HazardDoc {
  return {
    sourceId,
    type: "smoke",
    severity: 3,
    title: "Smoke plume demo",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-123.0, 47.0],
          [-121.0, 47.0],
          [-121.0, 48.0],
          [-123.0, 48.0],
          [-123.0, 47.0],
        ],
      ],
    },
    validFrom: NOW - 3_600_000,
    validTo: NOW + 6 * 3_600_000,
    source: "test",
  };
}

const shelter = (over: Partial<ResourceDoc> = {}): ResourceDoc => ({
  sourceId: "mesh-test-shelter-1",
  kind: "shelter",
  name: "Test Shelter",
  hours: "24/7",
  partner: true,
  status: "open",
  verifiedAt: NOW,
  loc: { type: "Point", coordinates: [-122.331, 47.601] },
  ...over,
});

const floodedRoad = (over: Partial<RoadDoc> = {}): RoadDoc => ({
  cameraId: "wsdot-mesh-test-1",
  name: "Flooded demo road",
  loc: { type: "Point", coordinates: [-122.329, 47.599] },
  status: "flooded",
  verifiedAt: NOW,
  imageUrl: "https://images.example/test.jpg",
  ...over,
});

interface Signer {
  deviceId: string;
  pubkey: string;
  sign(fields: { id: string; type: string; ts: number; lat: number; lon: number }): string;
}

// Mirrors the frontend contract: WebCrypto-style RAW Ed25519 (32-byte pubkey,
// 64-byte sig) in base64 over sigMessage(...). SPKI DER ends with the 32 raw bytes.
function makeSigner(deviceId: string): Signer {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return {
    deviceId,
    pubkey: Buffer.from(der.subarray(der.length - 32)).toString("base64"),
    sign(fields) {
      return cryptoSign(null, Buffer.from(sigMessage({ ...fields, deviceId })), privateKey).toString("base64");
    },
  };
}

let seq = 0;
function packet(signer: Signer, over: Partial<MeshPacketIn> = {}): MeshPacketIn {
  seq += 1;
  const base = {
    id: `mesh-test-p-${seq}`,
    type: "beacon",
    status: "Trapped",
    lat: 47.6,
    lon: -122.33,
    ts: NOW - 60_000,
    hops: 0,
    ttl: 7,
    photo: null,
  };
  // Explicit === undefined checks (plain `??` would turn an intentional null into sign()).
  const merged: Record<string, unknown> = {
    ...base,
    ...over,
    deviceId: over.deviceId ?? signer.deviceId,
    pubkey: over.pubkey === undefined ? signer.pubkey : over.pubkey,
    legacy: over.legacy === true,
  };
  const fields = {
    id: merged["id"] as string,
    type: (merged["type"] as string) ?? "beacon",
    ts: (merged["ts"] as number) ?? NOW,
    lat: (merged["lat"] as number) ?? 47.6,
    lon: (merged["lon"] as number) ?? -122.33,
  };
  // A type/status override still must be signed over the SAME stringified fields the
  // backend will verify against (packet carries the overridden values).
  merged.sig = over.sig === undefined ? signer.sign(fields) : over.sig;
  return merged as unknown as MeshPacketIn;
}

interface Harness {
  astore: ReturnType<typeof memoryStore>;
  meshStore: ReturnType<typeof memoryMeshStore>;
  app: ReturnType<typeof createApp>;
  config: Config;
}

function harness(
  opts: { hazards?: HazardDoc[]; resources?: ResourceDoc[]; roads?: RoadDoc[]; env?: Record<string, string> } = {},
): Harness {
  const astore = memoryStore();
  for (const h of opts.hazards ?? []) void astore.upsertHazard(h);
  for (const r of opts.resources ?? []) void astore.upsertResource(r);
  for (const r of opts.roads ?? []) void astore.upsertRoad(r);
  const meshStore = memoryMeshStore();
  const config = loadConfig({ REPLAY: "1", ...opts.env });
  const app = createApp(config, {
    store: async () => astore,
    pipeline: async () => emptyPipelineResult(),
    inbound: stubInboundRuntime(),
    match: async () => memoryMatchStore(astore),
    deliver: async () => memoryDeliverStore(),
    verify: async () => memoryVerifyStore(),
    voice: stubVoiceRuntime(),
    mesh: async () => meshStore,
  });
  return { astore, meshStore, app, config };
}

async function syncPackets(h: Harness, deviceId: string, lat: number, lon: number, packets: MeshPacketIn[]) {
  return h.app.request("/mesh/sync", {
    method: "POST",
    body: JSON.stringify({ deviceId, lat, lon, packets }),
    headers: { "content-type": "application/json" },
  });
}

interface SyncBody {
  received: number;
  inserted: number;
  deduped: number;
  rejected: number;
  rejectedIds: string[];
  scored: number;
  unscored: number;
  bundle: {
    generatedAt: number;
    brief: { text: string; voiceScript: string };
    nearestVerifiedShelter: { name: string; status: string; confidence: number } | null;
    blockedRoads: Array<{ cameraId: string; status: string }>;
    acks: Array<{ beaconClusterId: string; message: string }>;
    messages: Array<{ id: string; from: string; to: string | null; text: string; ts: number; hops: number }>;
    satellite?: {
      fetchedAt: number;
      plumes: Array<{ geometry: unknown }>;
      alerts: Array<{ geometry: unknown }>;
      aqi: { aqi: number | null; pm25: number | null; source: string; observedMs: number } | null;
    };
    routes?: Array<{
      from: { lat: number; lon: number };
      to: { shelterId: string; name: string };
      profile: string;
      coords: Array<[number, number]>;
      distanceKm: number;
      durationMin: number;
      steps: Array<{ distanceM: number; name: string; instruction: string }>;
      fetchedAt: number;
      source: string;
    }>;
  };
}

const GW = "mesh-test-gateway";

// Same scheme as src/mesh/state.ts: first 10 hex chars of sha256(deviceId) — a msg
// packet's `to` (direct routing) is addressed in exactly these units.
const deviceHash = (deviceId: string): string =>
  createHash("sha256").update(deviceId).digest("hex").slice(0, 10);

describe("POST /mesh/sync (Task 8, hermetic)", () => {
  it("pins the pubkey on the first packet, verifies, and scores +0.2 inside an active hazard zone", async () => {
    const h = harness({ hazards: [smokeHazard("hms-smoke:mesh-demo")] });
    const signer = makeSigner("mesh-test-device-1");
    const res = await syncPackets(h, GW, 47.6, -122.33, [packet(signer)]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncBody;
    expect(body.inserted).toBe(1);
    expect(body.bundle.brief.text.length).toBeGreaterThan(0);

    const stored = (await h.meshStore.listPackets())[0]!;
    expect(stored.verify).toBe("ok");
    expect(stored.score).toBe(0.7);
    expect(stored.reasons).toContain("+0.2 inside active hazard zone (hms-smoke:mesh-demo)");
    const device = await h.meshStore.getDevice("mesh-test-device-1");
    expect(device?.pubkey).toBe(signer.pubkey);
  });

  it("a sig signed by a different key is stored but unusable: not dropped, never scored, not clustered", async () => {
    const h = harness();
    const signerA = makeSigner("mesh-test-device-2");
    const signerB = makeSigner("mesh-test-device-3");
    // B's key pinned/presented, A's signature content — cryptographically invalid.
    const res = await syncPackets(h, GW, 47.6, -122.33, [packet(signerA, { pubkey: signerB.pubkey })]);
    const body = (await res.json()) as SyncBody;
    expect(body.inserted).toBe(1);
    expect(body.unscored).toBe(1);
    expect(body.bundle.acks).toHaveLength(0);

    const stored = (await h.meshStore.listPackets())[0]!;
    expect(stored.verify).toBe("invalid");
    expect(stored.verifyReason).toBe("sig verification failed (ed25519 mismatch)");
    expect(stored.score).toBeNull();
    expect(JSON.stringify(stored.reasons)).toContain("never dropped silently");
    expect(await h.meshStore.listBeacons()).toHaveLength(0);
  });

  it("misuse after pinning: unsigned packets and key swaps on a pinned device are rejected", async () => {
    const h = harness();
    const signer = makeSigner("mesh-test-device-4");
    const other = makeSigner("mesh-test-device-5");
    await syncPackets(h, GW, 47.6, -122.33, [packet(signer)]); // pins the key

    const res = await syncPackets(h, GW, 47.6, -122.33, [
      packet(signer, { pubkey: null, sig: null }), // unsigned after pinning
      packet(signer, { pubkey: other.pubkey, sig: other.sign({ id: "x", type: "beacon", ts: NOW, lat: 47.6, lon: -122.33 }) }), // wrong key
    ]);
    const body = (await res.json()) as SyncBody;
    expect(body.unscored).toBe(2);
    const packets = await h.meshStore.listPackets();
    const unsigned = packets.find((p) => p.verifyReason === "unsigned after pinning (device key is already pinned)");
    const swapped = packets.find((p) => p.verify === "mismatch" && p.verifyReason !== "unsigned after pinning (device key is already pinned)");
    expect(unsigned?.verify).toBe("mismatch");
    expect(unsigned?.score).toBeNull();
    expect(swapped?.score).toBeNull();
    expect(swapped?.reasons.join(" | ")).toContain("misuse after pinning");
    expect(JSON.stringify(packets.map((p) => p.reasons))).toContain("never dropped silently");
  });

  it("legacy:true packets are recorded + scored + marked unsigned, but never clustered (no unverified rescue acks)", async () => {
    const h = harness();
    const signer = makeSigner("mesh-test-device-6");
    const res = await syncPackets(h, GW, 47.6, -122.33, [packet(signer, { legacy: true, sig: null, pubkey: null })]);
    const body = (await res.json()) as SyncBody;
    expect(body.inserted).toBe(1);

    const stored = (await h.meshStore.listPackets())[0]!;
    expect(stored.verify).toBe("unsigned");
    expect(stored.score).toBe(0.5); // base only: no hazard boost, no photo, no corroborators
    expect(stored.reasons).toContain("unsigned device (legacy packet, not signature-verified)");
    // No rescue cluster exists for an unsigned beacon — clusters (and through them,
    // downlink acks) require a verified device.
    expect(await h.meshStore.listBeacons()).toHaveLength(0);
    expect(body.bundle.acks).toHaveLength(0);
  });

  it("dedup: a gateway retry of the same batch inserts nothing new (unique-id semantics)", async () => {
    const h = harness();
    const signer1 = makeSigner("mesh-test-device-7");
    const signer2 = makeSigner("mesh-test-device-8");
    const batch = [packet(signer1), packet(signer2, { status: "Need Rescue" })];
    const first = (await (await syncPackets(h, GW, 47.6, -122.33, batch)).json()) as SyncBody;
    expect(first.inserted).toBe(2);
    expect(first.deduped).toBe(0);

    const retry = (await (await syncPackets(h, GW, 47.6, -122.33, batch)).json()) as SyncBody;
    expect(retry.inserted).toBe(0);
    expect(retry.deduped).toBe(2);
    expect((await h.meshStore.listPackets()).map((p) => p.id).sort()).toEqual(batch.map((p) => p.id).sort());
  });

  it("clustering: same-kind beacons within 100 m merge (kind normalized across casing/emoji); priority ranks the dashboard", async () => {
    const h = harness();
    const a = makeSigner("mesh-test-device-9");
    const b = makeSigner("mesh-test-device-10");
    const c = makeSigner("mesh-test-device-11");
    const d = makeSigner("mesh-test-device-12");
    await syncPackets(h, GW, 47.6, -122.33, [
      packet(a),
      packet(b, { status: "\u{1F198} TRAPPED!", lat: 47.60009 }), // ~10 m north, different kind spelling/emoji
      packet(c, { status: "need rescue", lat: 47.6 }), // different kind, same spot -> own cluster
      packet(d, { lat: 47.603 }), // same kind, ~350 m away -> own cluster
    ]);

    const beacons = await h.meshStore.listBeacons();
    expect(beacons).toHaveLength(3);
    const merged = beacons.find((b) => b.packetIds.length === 2);
    expect(merged?.kind).toBe("Trapped");
    expect(merged?.priority).toBe(3);
    expect(merged?.sources).toHaveLength(2);

    const state = await assembleMeshState(h.meshStore, NOW);
    // priority first (Trapped), then most recently seen — score never drives beacon rank
    expect(state.beacons[0]?.priority).toBe(3);
    expect(state.beacons.map((b) => b.kind)).toContain("Need Rescue");
    expect(state.counts.beacons).toBe(3);
  });

  it("rescue beacons NEVER decay: an hour-old Trapped cluster keeps its score while a hazard report fades to the 30-min half-life", async () => {
    const h = harness({ hazards: [smokeHazard("hms-smoke:decay-demo")] });
    const beaconSigner = makeSigner("mesh-test-device-13");
    const hazardSigner = makeSigner("mesh-test-device-14");
    await syncPackets(h, GW, 47.6, -122.33, [
      packet(beaconSigner, { ts: NOW - 60 * 60_000 }),
      packet(hazardSigner, { type: "hazard", status: "flood water at the curb", ts: NOW - 60 * 60_000 }),
    ]);

    const later = await assembleMeshState(h.meshStore, NOW + 90 * 60_000);
    const beaconPacket = (await h.meshStore.listPackets()).find((p) => p.type === "beacon")!;
    const hazardPacket = (await h.meshStore.listPackets()).find((p) => p.type === "hazard")!;
    // hazard: stored 0.7, one-and-a-half half-lives later: 0.7 * 0.5 ^ 3
    expect(hazardPacket.score).toBe(0.7);
    expect(later.hazardReports.find((r) => r.id === hazardPacket.id)?.score).toBe(0.09);
    // beacon: rescue kind — never decayed/downgraded (cluster score shown as stored)
    const cluster = later.beacons.find((b) => b.kind === "Trapped")!;
    expect(cluster.score).toBe(0.7);
    expect(cluster.score).toBe(beaconPacket.score);
    expect(later.beacons[0]?.kind).toBe("Trapped");
  });

  it("corroboration: +0.1 per independent verified nearby report, capped at 3; unsigned neighbors never boost", async () => {
    const h = harness();
    const devices = ["mesh-test-device-15", "mesh-test-device-16", "mesh-test-device-17", "mesh-test-device-18"].map(makeSigner);
    const unsigned = makeSigner("mesh-test-device-19");
    await syncPackets(h, GW, 47.6, -122.33, [
      ...devices.map((s) => packet(s, { type: "hazard", status: "flood water at the curb" })),
      packet(unsigned, { type: "hazard", status: "flood water at the curb", legacy: true, sig: null, pubkey: null }),
    ]);
    const packets = await h.meshStore.listPackets();
    for (const s of devices) {
      const doc = packets.find((p) => p.deviceId === s.deviceId)!;
      // 4 signed devices -> only 3 corroborators count (cap); the unsigned peer adds nothing
      expect(doc.score).toBe(0.8);
      expect(doc.reasons).toContain("+0.3 independent nearby reports x3 (<=150 m, different devices)");
    }
    const unsignedDoc = packets.find((p) => p.verify === "unsigned")!;
    expect(unsignedDoc.score).toBe(0.8);
    expect(unsignedDoc.reasons).toContain("unsigned device (legacy packet, not signature-verified)");
  });

  it("photo: the stub vision seam records the not-wired reason and moves the score by 0", async () => {
    const h = harness();
    const signer = makeSigner("mesh-test-device-20");
    await syncPackets(h, GW, 47.6, -122.33, [packet(signer, { photo: "AAAA" })]);
    const stored = (await h.meshStore.listPackets())[0]!;
    expect(stored.photo).toBe(true);
    expect(stored.reasons).toContain("photo-unscored (vision not wired)");
    expect(stored.score).toBe(0.5);
  });

  it("batch cap: more than 200 packets is rejected 400; malformed body 400", async () => {
    const h = harness();
    const res = await syncPackets(h, GW, 47.6, -122.33, Array.from({ length: 201 }, () => ({})));
    expect(res.status).toBe(400);
    const bad = await syncPackets(h, GW, 47.6, -122.33, [] as MeshPacketIn[]);
    expect(bad.status).toBe(200);
    const noDevice = await h.app.request("/mesh/sync", {
      method: "POST",
      body: JSON.stringify({ lat: 47.6, lon: -122.33, packets: [] }),
      headers: { "content-type": "application/json" },
    });
    expect(noDevice.status).toBe(400);
  });

  it("downlink bundle: ack for the gateway's own contributed beacon (template-only message), verified-or-null shelter, blockedRoads max 2", async () => {
    const h1 = harness();
    const signer = makeSigner(GW); // the gateway itself trapped -> it contributed the beacon
    const res1 = await syncPackets(h1, signer.deviceId, 47.6, -122.33, [
      packet(signer, { deviceId: signer.deviceId }),
    ]);
    const body1 = (await res1.json()) as SyncBody;
    // No hazard at the gateway -> the all-clear posture: shelter null, no roads
    expect(body1.bundle.nearestVerifiedShelter).toBeNull();
    expect(body1.bundle.blockedRoads).toEqual([]);
    expect(body1.bundle.brief.text).toContain("Call 911 if you are in danger.");
    expect(body1.bundle.acks).toHaveLength(1);
    expect(body1.bundle.acks[0]!.message).toBe("Responders have seen your beacon. Call 911 if you are in danger.");
    const state1 = await assembleMeshState(h1.meshStore, NOW);
    expect(state1.beacons[0]?.clusterId).toBe(body1.bundle.acks[0]!.beaconClusterId);
    expect(state1.beacons[0]?.ackedAt).not.toBeNull();

    // With an active hazard + fresh verified shelter + flooded road: brief semantics ride the bundle
    const h2 = harness({
      hazards: [smokeHazard("hms-smoke:downlink")],
      resources: [shelter()],
      roads: [floodedRoad()],
    });
    const signer2 = makeSigner(GW);
    const res2 = await syncPackets(h2, GW, 47.6, -122.33, [packet(signer2, { deviceId: GW })]);
    const body2 = (await res2.json()) as SyncBody;
    expect(body2.bundle.nearestVerifiedShelter?.name).toBe("Test Shelter");
    expect(body2.bundle.nearestVerifiedShelter?.status).toBe("open");
    expect(body2.bundle.nearestVerifiedShelter!.confidence).toBeGreaterThanOrEqual(0.99);
    expect(body2.bundle.blockedRoads[0]?.status).toBe("flooded");
    expect(body2.bundle.brief.text).toContain("Test Shelter");
  });

  it("the ack table is pre-translated per language and every ack string is template-only", () => {
    const langs: Lang[] = ["en", "es", "zh", "tl", "vi", "ar"];
    for (const lang of langs) {
      const msg = ackMessage(lang);
      expect(msg.startsWith(MESH_ACK_LINES[lang])).toBe(true);
      expect(msg.length).toBeGreaterThan(MESH_ACK_LINES[lang]!.length);
    }
    expect(ackMessage("es")).toContain("911");
  });
});

describe("Task 8b: msg packets (mesh chat) + messages/resources read surfaces", () => {
  it("broadcast msg end-to-end: synced, preserved verbatim, never scored, carried on /mesh/state + bundle, and contributes neither a cluster nor a coverage dot", async () => {
    const h = harness();
    const signer = makeSigner("mesh-test-msg-device-1");
    const text = "streets flooding near 4th — heading to the library shelter";
    const res = await syncPackets(h, GW, 47.6, -122.33, [
      packet(signer, { id: "mesh-test-msg-broadcast-1", type: "msg", status: text }),
    ]);
    const body = (await res.json()) as SyncBody;
    expect(body.inserted).toBe(1);
    expect(body.scored).toBe(0);
    expect(body.unscored).toBe(1);
    expect(body.bundle.messages.map((m) => m.id)).toContain("mesh-test-msg-broadcast-1");

    const stored = (await h.meshStore.listPackets()).find((p) => p.type === "msg")!;
    expect(stored.status).toBe(text); // verbatim
    expect(stored.score).toBeNull();
    expect(stored.to).toBeNull(); // broadcast
    expect(stored.reasons).toContain("not scored (relay packet type)");
    // transport, not facts: no rescue cluster, no coverage dot, not a hazard report
    expect(await h.meshStore.listBeacons()).toHaveLength(0);

    const stateRes = await h.app.request("/mesh/state");
    expect(stateRes.status).toBe(200);
    const state = (await stateRes.json()) as {
      messages: Array<{ id: string; from: string; to: string | null; text: string; ts: number; hops: number }>;
      resources: unknown[];
      hazardReports: unknown[];
      coverage: unknown[];
      counts: { packets: number; devices: number };
    };
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual({
      id: stored.id,
      from: deviceHash("mesh-test-msg-device-1"),
      to: null,
      text,
      ts: NOW - 60_000,
      hops: 0,
      photoRef: null, // 8e I1 fix: messages expose the photo pointer + resolved view
      hasPhoto: false,
      photoKind: null,
      photoUrl: null,
      core: false,
    });
    expect(state.resources).toEqual([]); // no ResourceDocs seeded in this harness
    expect(state.hazardReports).toHaveLength(0);
    expect(state.coverage).toHaveLength(0);
    expect(state.counts).toMatchObject({ packets: 1, devices: 0 });
  });

  it("direct `to` routing + bundle relevance: addressed-to-gateway rides from anywhere, other targets and distant broadcasts do not; msgs never decay", async () => {
    const h = harness();
    const signer = makeSigner("mesh-test-msg-device-2");
    const gwHash = deviceHash(GW);
    const far = { lat: 47.85, lon: -122.1 }; // ~28 km from the gateway
    const res = await syncPackets(h, GW, 47.6, -122.33, [
      packet(signer, { type: "msg", status: "direct to gateway", ts: NOW - 40_000, ...far, to: gwHash }),
      packet(signer, { type: "msg", status: "direct to someone else", ts: NOW - 30_000, to: deviceHash("mesh-test-someone-else") }),
      packet(signer, { type: "msg", status: "broadcast far away", ts: NOW - 20_000, ...far }),
      packet(signer, { type: "msg", status: "broadcast nearby", ts: NOW - 10_000 }),
    ]);
    const body = (await res.json()) as SyncBody;
    expect(body.inserted).toBe(4);
    // direct-to-gateway (any distance) + nearby broadcasts, newest first
    expect(body.bundle.messages.map((m) => m.text)).toEqual([
      "broadcast nearby",
      "direct to gateway",
    ]);
    // /mesh/state stays unfiltered — all four, newest-first by ts, with hashes only
    const state = await assembleMeshState(h.meshStore, NOW);
    expect(state.messages.map((m) => m.from)).toEqual(Array.from({ length: 4 }, () => deviceHash("mesh-test-msg-device-2")));
    expect(JSON.stringify(state)).not.toContain("mesh-test-msg-device-2");
    expect(state.messages.map((m) => m.to)).toEqual([null, null, deviceHash("mesh-test-someone-else"), gwHash]);

    // Msgs are INERT to decay: 90 min later the message views are byte-identical
    // (no score key at all) — unlike hazard reports, whose score fades (see the
    // Task 8 decay test).
    const later = await assembleMeshState(h.meshStore, NOW + 90 * 60_000);
    expect(later.messages.map((m) => m.text)).toEqual(["broadcast nearby", "broadcast far away", "direct to someone else", "direct to gateway"]);
    for (const m of later.messages) {
      expect(Object.keys(m).sort()).toEqual(["core", "from", "hasPhoto", "hops", "id", "photoKind", "photoRef", "photoUrl", "text", "to", "ts"]);
    }
  });

  it("280-char cap: 280 preserved verbatim; 281 / empty / non-string / bad `to` are shape-broken (rejected, id echoed)", async () => {
    const h = harness();
    const signer = makeSigner("mesh-test-msg-device-3");
    const max = "x".repeat(280);
    const over = "x".repeat(281);
    const seq0 = seq;
    const res = await syncPackets(h, GW, 47.6, -122.33, [
      packet(signer, { id: `mesh-test-msg-cap-ok-${seq0 + 1}`, type: "msg", status: max }),
      packet(signer, { id: `mesh-test-msg-cap-over-${seq0 + 2}`, type: "msg", status: over }),
      packet(signer, { id: `mesh-test-msg-cap-empty-${seq0 + 3}`, type: "msg", status: "" }),
      packet(signer, { id: `mesh-test-msg-cap-nonstr-${seq0 + 4}`, type: "msg", status: 42 as unknown as string }),
      packet(signer, { id: `mesh-test-msg-cap-badto-${seq0 + 5}`, type: "msg", status: "hi", to: 123 as unknown as string }),
    ]);
    const body = (await res.json()) as SyncBody;
    expect(body.inserted).toBe(1);
    expect(body.rejected).toBe(4);
    const stored = (await h.meshStore.listPackets()).find((p) => p.type === "msg")!;
    expect(stored.status).toBe(max); // NOT the 200-slice the other types get
    expect(body.rejectedIds).toContain(`mesh-test-msg-cap-over-${seq0 + 2}`);
  });

  it("resources on /mesh/state + the /map/state mesh section follow the displayedStatus + confidence semantics (verified-open shows open, stale shows unknown)", async () => {
    const stale = NOW - 6 * 30 * 60_000; // 6 shelter half-lives -> confidence ~0.016
    const h = harness({
      resources: [
        shelter({ sourceId: "mesh-test-res-fresh", verifiedAt: NOW }),
        shelter({ sourceId: "mesh-test-res-stale-open", verifiedAt: stale }),
        shelter({ sourceId: "mesh-test-res-closed", status: "closed", verifiedAt: stale }),
      ],
    });
    const signer = makeSigner("mesh-test-msg-device-4");
    await syncPackets(h, GW, 47.6, -122.33, [packet(signer, { type: "msg", status: "shelters open?" })]);

    const stateRes = await h.app.request("/mesh/state");
    const state = (await stateRes.json()) as {
      generatedAt: number;
      beacons: unknown[];
      hazardReports: unknown[];
      coverage: unknown[];
      counts: unknown;
      messages: unknown[];
      resources: Array<{ sourceId: string; kind: string; name: string; status: string; lat: number; lon: number }>;
    };
    const bySource = Object.fromEntries(state.resources.map((r) => [r.sourceId, r]));
    expect(bySource["mesh-test-res-fresh"]).toEqual({
      sourceId: "mesh-test-res-fresh",
      kind: "shelter",
      name: "Test Shelter",
      status: "open",
      lat: 47.601,
      lon: -122.331,
    });
    expect(bySource["mesh-test-res-stale-open"]?.status).toBe("unknown");
    expect(bySource["mesh-test-res-closed"]?.status).toBe("closed");

    // Additive-shape regression: every pre-8b key is still present and untouched.
    for (const key of ["generatedAt", "beacons", "hazardReports", "coverage", "counts"]) {
      expect(state).toHaveProperty(key);
    }
    expect(state.messages).toHaveLength(1);

    // The same resources ride /map/state's data-gated mesh section.
    const map = (await (await h.app.request("/map/state")).json()) as {
      mesh?: { resources: Array<{ sourceId: string; status: string }>; messages: Array<{ text: string }> };
    };
    expect(map.mesh?.resources.find((r) => r.sourceId === "mesh-test-res-stale-open")?.status).toBe("unknown");
    expect(map.mesh?.resources.find((r) => r.sourceId === "mesh-test-res-fresh")?.status).toBe("open");
    expect(map.mesh?.messages.map((m) => m.text)).toContain("shelters open?");
  });

  it("buildDownlink accepts the device lang (optional param, default en): ack lines come from the per-language table; new messages key is additive", async () => {
    const h = harness();
    const signer = makeSigner(GW); // the gateway itself trapped -> contributes the cluster -> 1 ack
    await syncPackets(h, GW, 47.6, -122.33, [packet(signer, { deviceId: GW })]);
    const gatewayGeo = { deviceId: GW, lat: 47.6, lon: -122.33 };
    const es = await buildDownlink(h.meshStore, memoryMatchStore(h.astore), gatewayGeo, NOW, "es");
    expect(es.acks[0]!.message).toBe(ackMessage("es"));
    const enDefault = await buildDownlink(h.meshStore, memoryMatchStore(h.astore), gatewayGeo, NOW);
    expect(enDefault.acks[0]!.message).toBe(ackMessage("en"));
    expect(enDefault.messages).toEqual([]); // additive key, present even with no msgs
  });
});

describe("Task 8d: Ask Skywatch (chatbot over the mesh)", () => {
  interface MsgView {
    id: string;
    from: string;
    to: string | null;
    text: string;
    ts: number;
    hops: number;
  }

  function answerStubs(h: Harness) {
    return {
      config: h.config,
      match: async () => memoryMatchStore(h.astore),
      store: async () => h.astore,
      deliver: async () => memoryDeliverStore(),
    };
  }

  const askerPoint = { type: "Point" as const, coordinates: [-122.33, 47.6] as [number, number] };

  it("ask-question end-to-end (Gemini unset -> deterministic composed answer): reply stored from the trusted core, direct to the asker, in the same sync's bundle + /mesh/state", async () => {
    const h = harness({ hazards: [smokeHazard("hms-smoke:ask")], resources: [shelter()] });
    const asker = makeSigner(GW); // the gateway itself asks -> its hash routes the reply into its bundle too
    const res = await syncPackets(h, GW, 47.6, -122.33, [
      packet(asker, { id: "mesh-test-ask-1", type: "msg", status: "where can I shelter?", to: "skywatch" }), // lowercase: route is case-insensitive
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncBody;
    // the question is stored unscored; the ANSWER arrives inside the SAME response's bundle
    const question = body.bundle.messages.find((m) => m.id === "mesh-test-ask-1");
    expect(question).toBeUndefined();
    const answer = body.bundle.messages.find((m) => m.from === deviceHash(SKYWATCH_CORE_ID))!;
    expect(answer.to).toBe(deviceHash(GW));
    expect(answer.hops).toBe(0);

    // Deterministic composed answer: fallbackRender over the POINT brief resolved at
    // the ASKER's coordinates (not the gateway's — identical here, different on purpose in test 3).
    const brief = await buildUserBrief(memoryMatchStore(h.astore), { id: deviceHash(GW), lang: "en", loc: askerPoint }, Date.now());
    expect(answer.text).toBe(fallbackRender(brief).text);
    expect(answer.text).toContain("Test Shelter");
    expect(answer.text).toContain("Call 911 if you are in danger.");
    expect(answer.text.length).toBeLessThanOrEqual(MESH_MSG_STATUS_MAX);

    const questionDoc = (await h.meshStore.listPackets()).find((p) => p.id === "mesh-test-ask-1")!;
    expect(questionDoc.score).toBeNull();
    expect(questionDoc.to).toBe("SKYWATCH"); // canonicalized from lowercase
    const answerDoc = (await h.meshStore.listPackets()).find((p) => p.deviceId === SKYWATCH_CORE_ID)!;
    expect(answerDoc.verify).toBe("core");
    expect(answerDoc.score).toBeNull();
    expect(answerDoc.hops).toBe(0);
    expect(answerDoc.ttl).toBe(7);

    // /mesh/state thread: question + answer, hashed on BOTH ends — never the raw core id.
    const state = (await (await h.app.request("/mesh/state")).json()) as { messages: MsgView[] };
    expect(state.messages.map((m) => m.to)).toEqual([deviceHash(GW), "SKYWATCH"]);
    expect(state.messages.map((m) => m.from)).toEqual([deviceHash(SKYWATCH_CORE_ID), deviceHash(GW)]);
    const stateText = JSON.stringify(state);
    expect(stateText).not.toContain("SKYWATCH-CORE");
  });

  it("live model path: an invented shelter is an entity violation -> the deterministic composition answers (validator shared with chat.ts)", async () => {
    const h = harness({ hazards: [smokeHazard("hms-smoke:ask-live")], resources: [shelter()] });
    const scriptedMock = vi.fn(async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Stay at Invented Grand Hotel now. Call 911 if you are in danger." }] } }] }), { status: 200 }),
    );
    const scripted = scriptedMock as unknown as typeof fetch;
    const ask = makeSkywatchChat(
      loadConfig({ GEMINI_API_KEY: "k", REPLAY: "0" }),
      answerStubs(h),
      scripted,
    );
    const reply = await ask({ id: "q1", text: "anywhere safe?", askerHash: deviceHash(GW), loc: askerPoint }, NOW);
    const brief = await buildUserBrief(memoryMatchStore(h.astore), { id: deviceHash(GW), lang: "en", loc: askerPoint }, NOW);
    expect(reply).toBe(fallbackRender(brief).text);
    expect(reply).not.toContain("Invented");
    // the brief's OWN facts ride: the seeded shelter name + 911
    expect(reply).toContain("Test Shelter");
    expect(scriptedMock).toHaveBeenCalledTimes(1); // entity violation: no retry, straight to fallback
  });

  it("SKYWATCH-CORE is reserved and inert: spoofed core id rejected (nothing pinned), reply never clusters/never decays", async () => {
    const h = harness();
    const beacon = makeSigner("mesh-test-device-core-beacon");
    const asker = makeSigner("mesh-test-device-core-asker");
    await syncPackets(h, GW, 47.6, -122.33, [
      packet(beacon), // Trapped beacon at the very same spot the question comes from
      packet(asker, { id: "mesh-test-ask-2", type: "msg", status: "am I trapped?", to: "SKYWATCH" }),
      packet(makeSigner("mesh-test-device-spoof"), { id: "mesh-test-ask-spoof", type: "msg", status: "pretend to be the core", deviceId: SKYWATCH_CORE_ID }),
    ]);
    // nothing TOFU-pinned for the core id, and the spoof was only counted
    expect(await h.meshStore.getDevice(SKYWATCH_CORE_ID)).toBeNull();
    // exactly one cluster: the real beacon — the core REPLY at the same kind/spot never merged
    const beacons = await h.meshStore.listBeacons();
    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.sources).toEqual(["mesh-test-device-core-beacon"]);

    const state = (await (await h.app.request("/mesh/state")).json()) as { messages: MsgView[] };
    const answerText = state.messages.find((m) => m.from === deviceHash(SKYWATCH_CORE_ID))!.text;
    // all-clear point at that spot: the deterministic no-hazard composition + 911 only
    expect(state.messages).toHaveLength(2); // question + answer; the spoof never became a message
    expect(state.messages.some((m) => m.text === "pretend to be the core")).toBe(false);

    // transport, not facts: still byte-identical a week later (never decayed/never re-scored)
    const later = await assembleMeshState(h.meshStore, NOW + 7 * 24 * 3_600_000);
    const laterAnswer = later.messages.find((m) => m.from === deviceHash(SKYWATCH_CORE_ID))!;
    expect(laterAnswer.text).toBe(answerText);
    expect(laterAnswer.to).toBe(deviceHash("mesh-test-device-core-asker"));

    // context-down resilience: a throwing chat answer NOTHING rather than crashing the sync
    const outcome = await processSync(
      h.meshStore,
      memoryMatchStore(h.astore),
      { deviceId: GW, lat: 47.6, lon: -122.33, packets: [packet(asker, { id: "mesh-test-ask-3", type: "msg", status: "?", to: "SKYWATCH" })] },
      NOW,
      async () => {
        throw new Error("context down");
      },
    );
    expect(outcome.received).toBe(1);
    expect((await h.meshStore.listPackets()).filter((p) => p.deviceId === SKYWATCH_CORE_ID)).toHaveLength(1); // still just the one answer
  });
});

describe("Task 8e: mesh photos + satellite overlay", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Minimal JPEG/PNG bytes (magic-prefixed). */
  function imageBytes(n = 99, jpeg = true): Buffer {
    const b = Buffer.alloc(n, 0x11);
    if (jpeg) {
      b[0] = 0xff;
      b[1] = 0xd8;
      b[2] = 0xff;
      b[n - 1] = 0xd9;
    } else {
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(b, 0);
    }
    return b;
  }

  async function postPhoto(h: Harness, body: Record<string, unknown>): Promise<Response> {
    return h.app.request("/mesh/photo", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  async function pinnedDevice(h: Harness, deviceId: string): Promise<void> {
    await syncPackets(h, GW, 47.6, -122.33, [packet(makeSigner(deviceId), { type: "hazard", status: "signal check" })]);
  }

  it("photo upload is TOFU-pinned-device-only: unknown 403, legacy 403, signed 200; the reserved core id is rejected", async () => {
    const h = harness();
    const legacySigner = makeSigner("mesh-test-photo-legacy");
    await syncPackets(h, GW, 47.6, -122.33, [
      packet(legacySigner, { legacy: true, sig: null, pubkey: null }), // pinned WITHOUT a key
    ]);
    expect((await postPhoto(h, { deviceId: "mesh-test-photo-legacy", photoRef: "r-legacy", data: imageBytes().toString("base64") })).status).toBe(403);
    expect((await postPhoto(h, { deviceId: "mesh-test-photo-never-seen", photoRef: "r-ghost", data: imageBytes().toString("base64") })).status).toBe(403);
    expect((await postPhoto(h, { deviceId: SKYWATCH_CORE_ID, photoRef: "r-core", data: imageBytes().toString("base64") })).status).toBe(400);

    const deviceId = "mesh-test-photo-device-1";
    await pinnedDevice(h, deviceId);
    const ok = await postPhoto(h, { deviceId, photoRef: "mesh-test-photo-r1", data: imageBytes().toString("base64"), label: "road-broken" });
    expect(ok.status).toBe(200);
    expect((await (await h.meshStore.getPhoto("mesh-test-photo-r1"))!).kind).toBe("road-broken");
  });

  it("photo round-trip: GET bytes with immutable cache + content type; index is hash-only; unknown ref 404; retry overwrite is idempotent", async () => {
    const h = harness();
    const deviceId = "mesh-test-photo-device-2";
    await pinnedDevice(h, deviceId);
    const bytes = imageBytes();
    const data = bytes.toString("base64");
    await postPhoto(h, { deviceId, photoRef: "mesh-test-photo-r2", data, label: "fire" });
    await postPhoto(h, { deviceId, photoRef: "mesh-test-photo-r2", data: imageBytes(33).toString("base64"), label: "fire" }); // retry overwrites (same ref, same label)

    const res = await h.app.request("/mesh/photo/mesh-test-photo-r2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const served = Buffer.from(await res.arrayBuffer());
    expect(served.length).toBe(33);

    const index = (await (await h.app.request("/mesh/photos")).json()) as {
      photos: Array<{ photoRef: string; kind: string | null; contentType: string; bytes: number; ts: number; deviceId: string; url: string }>;
    };
    expect(index.photos).toHaveLength(1); // index holds ONE doc for the ref (overwrite is not an append)
    const entry = index.photos[0]!;
    expect(entry).toMatchObject({ photoRef: "mesh-test-photo-r2", kind: "fire", contentType: "image/jpeg", bytes: 33, deviceId: deviceHash(deviceId), url: "/mesh/photo/mesh-test-photo-r2" });
    expect(JSON.stringify(index)).not.toContain(deviceId);

    expect((await h.app.request("/mesh/photo/mesh-test-photo-nope")).status).toBe(404);

    // png variant serves image/png
    await postPhoto(h, { deviceId, photoRef: "mesh-test-photo-r3", data: imageBytes(40, false).toString("base64") });
    const png = await h.app.request("/mesh/photo/mesh-test-photo-r3");
    expect(png.headers.get("content-type")).toBe("image/png");
  });

  it("photo caps + validation: 413 over 150 KB with a reason list; malformed base64 / non-image magic / bad label 400; bytes never ride the packet batch", async () => {
    const h = harness();
    const deviceId = "mesh-test-photo-device-3";
    await pinnedDevice(h, deviceId);

    const big = await postPhoto(h, { deviceId, photoRef: "r-big", data: imageBytes(150 * 1024 + 4).toString("base64") });
    expect(big.status).toBe(413);
    const bigBody = (await big.json()) as { reasons: string[] };
    expect(bigBody.reasons.join(" ")).toContain("150 KB");

    expect((await postPhoto(h, { deviceId, photoRef: "r-b64", data: "not-b64!!" })).status).toBe(400);
    expect((await postPhoto(h, { deviceId, photoRef: "r-magic", data: Buffer.from("plain text").toString("base64") })).status).toBe(400);
    expect((await postPhoto(h, { deviceId, photoRef: "r-label", data: imageBytes().toString("base64"), label: "volcano" })).status).toBe(400);
    expect((await h.meshStore.getPhoto("r-big"))).toBeNull(); // rejected uploads store nothing
  });

  it("data-URL contract: an optional data:<mime>;base64, prefix is accepted and stripped (stores + serves the bare form); a malformed body names the prefix rule", async () => {
    const h = harness();
    const deviceId = "mesh-test-photo-device-dataurl";
    await pinnedDevice(h, deviceId);

    // browser FileReader form — previously a silent/unclear 400 against the regex
    const prefixed = `data:image/jpeg;base64,${imageBytes(64).toString("base64")}`;
    const ok = await postPhoto(h, { deviceId, photoRef: "mesh-test-photo-dataurl", data: prefixed, label: "flood" });
    expect(ok.status).toBe(200);
    const stored = await h.meshStore.getPhoto("mesh-test-photo-dataurl");
    expect(stored).not.toBeNull();
    expect(stored!.data.startsWith("data:")).toBe(false); // only the BARE form is ever stored
    expect(stored!.bytes).toBe(64);
    const served = await h.app.request("/mesh/photo/mesh-test-photo-dataurl");
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/jpeg");

    // a prefix whose remainder is NOT base64: 400 with a reason that says the prefix was stripped
    const bad = await postPhoto(h, { deviceId, photoRef: "r-bad-prefix", data: "data:image/jpeg;base64,not-b64!!" });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: string; reasons: string[] };
    expect(badBody.error).toContain("prefix was accepted and stripped");
    expect(badBody.reasons.length).toBeGreaterThan(0);

    // a bare-bad body names the bare contract
    const bareBad = await postPhoto(h, { deviceId, photoRef: "r-bad-bare", data: "@#$%" });
    expect(bareBad.status).toBe(400);
    expect(((await bareBad.json()) as { error: string }).error).toContain("bare base64");
  });

  it("photoRef rides packets: hazard reports render hasPhoto/photoKind/photoUrl once (and only once) the bytes arrive", async () => {
    const h = harness();
    const deviceId = "mesh-test-photo-device-4";
    const signer = makeSigner(deviceId);
    await syncPackets(h, GW, 47.6, -122.33, [
      packet(signer, { id: "mesh-test-photo-hz", type: "hazard", status: "road broken at 5th", photoRef: "mesh-test-photo-r5" }),
    ]);

    const before = (await (await h.app.request("/mesh/state")).json()) as {
      hazardReports: Array<{ hasPhoto: boolean; photoKind: string | null; photoUrl: string | null }>;
    };
    // declared but never uploaded: NO dangling link rendered
    expect(before.hazardReports[0]).toMatchObject({ hasPhoto: false, photoKind: null, photoUrl: null });

    await postPhoto(h, { deviceId, photoRef: "mesh-test-photo-r5", data: imageBytes(55).toString("base64"), label: "flood" });
    const state = (await (await h.app.request("/mesh/state")).json()) as typeof before & { generatedAt: number };
    expect(state.hazardReports[0]).toMatchObject({ hasPhoto: true, photoKind: "flood", photoUrl: "/mesh/photo/mesh-test-photo-r5" });

    // the same view rides /map/state's data-gated mesh section
    const map = (await (await h.app.request("/map/state")).json()) as { mesh?: typeof state };
    expect(map.mesh?.hazardReports[0]).toMatchObject({ hasPhoto: true, photoKind: "flood" });
  });

  // ---- satellite overlay ----

  const PLUME_GEOJSON = { type: "FeatureCollection", features: [] as unknown[] };
  let seqSat = 0;
  function plumeFeature(lon: number, lat: number): unknown {
    seqSat += 1;
    return {
      geometry: { type: "Polygon", coordinates: [[[lon, lat], [lon + 0.4, lat], [lon + 0.4, lat + 0.4], [lon, lat + 0.4], [lon, lat]]] },
      properties: { Density: "High", Start: "2026290 1200", End_: "2026290 1500", Satellite: "NOAA-20" },
    };
  }
  const alertFeature = (lon: number, lat: number): unknown => ({
    geometry: { type: "Polygon", coordinates: [[[lon, lat], [lon + 0.3, lat], [lon + 0.3, lat + 0.3], [lon, lat + 0.3], [lon, lat]]] },
    properties: { id: "nws-8e-1", event: "Flood Advisory", severity: "Moderate", headline: "Flood Advisory for the demo basin", effective: "2026-10-17T00:00:00Z", ends: "2026-10-18T00:00:00Z" },
  });
  const openMeteo = { current: { time: "2026-10-17T23:00", pm2_5: 12.3, us_aqi: 45 } };

  /** URL-routed fetch stub: arcgis -> plumes, weather.gov -> alerts, open-meteo -> aqi. */
  function satFetch(routes: Record<string, unknown>, fail?: string): typeof fetch {
    return vi.fn(async (url: Parameters<typeof fetch>[0]) => {
      const u = String(url);
      if (fail && u.includes(fail)) return new Response("boom", { status: 500 });
      if (u.includes("services2.arcgis.com")) return new Response(JSON.stringify({ ...PLUME_GEOJSON, features: routes.plumes }), { status: 200 });
      if (u.includes("api.weather.gov")) return new Response(JSON.stringify({ type: "FeatureCollection", features: routes.alerts }), { status: 200 });
      if (u.includes("open-meteo")) return new Response(JSON.stringify(openMeteo), { status: 200 });
      if (u.includes("airnowapi.org")) return new Response(JSON.stringify(routes.airnow ?? []), { status: 200 });
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;
  }

  it("AIRNOW_API_KEY wired: a set key switches the satellite AQI fetch to AirNow (key in the URL); unset keeps the Open-Meteo fallback", async () => {
    const airnowRows = [{ DateObserved: "2026-10-17", AQI: 88, Latitude: 47.6, Longitude: -122.3, ParameterName: "PM2.5", ReportingArea: "Seattle" }];
    const fetcher = satFetch({ plumes: [], alerts: [], airnow: airnowRows });
    const out = await fetchSatelliteSection({ lat: 47.6, lon: -122.33 }, NOW, fetcher, "airnow-test-key");
    expect(out).not.toBeNull();
    expect(out!.section.aqi).toMatchObject({ aqi: 88, source: "AirNow" });
    const calledUrls = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("airnowapi.org") && u.includes("API_KEY=airnow-test-key"))).toBe(true);
    expect(calledUrls.some((u) => u.includes("open-meteo"))).toBe(false);

    // route level: SKYWATCH_LIVE_SYNC + AIRNOW_API_KEY set -> the synced bundle carries the AirNow obs
    const hOn = harness({ env: { SKYWATCH_LIVE_SYNC: "1", AIRNOW_API_KEY: "airnow-test-key" } });
    vi.stubGlobal("fetch", satFetch({ plumes: [], alerts: [], airnow: airnowRows }));
    const synced = (await (await syncPackets(hOn, GW, 47.6, -122.33, [packet(makeSigner(GW))])).json()) as SyncBody;
    expect(synced.bundle.satellite?.aqi).toMatchObject({ aqi: 88, source: "AirNow" });
  });

  it("satellite snapshot (unit): plumes/alerts bbox-filtered + capped, AQI rides, normalized hazards come out of the EXISTING ingest normalizers", async () => {
    const fetcher = satFetch({
      plumes: [plumeFeature(-122.4, 47.6), plumeFeature(-100.0, 40.0)], // second is outside the bbox
      alerts: [alertFeature(-122.35, 47.55), alertFeature(-90.0, 40.0)],
    });
    const out = await fetchSatelliteSection({ lat: 47.6, lon: -122.33 }, NOW, fetcher);
    expect(out).not.toBeNull();
    expect(out!.section.plumes).toHaveLength(1);
    expect(out!.section.alerts).toHaveLength(1);
    expect(out!.section.aqi).toMatchObject({ aqi: 45, source: "Open-Meteo", pm25: 12.3 });
    const types = out!.hazards.map((h) => h.type);
    expect(types).toContain("smoke");
    expect(types).toContain("flood"); // Flood Advisory -> flood via the shared event map
    expect(types).toContain("aqi");
    expect(out!.hazards.every((h) => h.sourceId.startsWith("hms-smoke:") || h.sourceId.startsWith("nws:") || h.sourceId.startsWith("aqi:"))).toBe(true);
  });

  it("satellite caps: >25 plumes truncate to 25, >10 alerts to 10", async () => {
    const out = await fetchSatelliteSection(
      { lat: 47.6, lon: -122.33 },
      NOW,
      satFetch({ plumes: Array.from({ length: 30 }, (_unused, i) => plumeFeature(-122.45 + 0.02 * i, 47.6)), alerts: Array.from({ length: 12 }, () => alertFeature(-122.35, 47.55)) }),
    );
    expect(out!.section.plumes).toHaveLength(25);
    expect(out!.section.alerts).toHaveLength(10);
  });

  it("all-or-nothing: any source failure omits the WHOLE section; processSync leaves it off the bundle", async () => {
    const out = await fetchSatelliteSection(
      { lat: 47.6, lon: -122.33 },
      NOW,
      satFetch({ plumes: [plumeFeature(-122.4, 47.6)], alerts: [] }, "api.weather.gov"),
    );
    expect(out).toBeNull();
  });

  it("route gate: SKYWATCH_LIVE_SYNC=1 fetches + upserts hazards and the bundle carries the section; unset = no section, no fetch at all", async () => {
    // Gate ON (live knob is independent of REPLAY — both set here on purpose).
    const hOn = harness({ env: { SKYWATCH_LIVE_SYNC: "1" } });
    vi.stubGlobal("fetch", satFetch({ plumes: [plumeFeature(-122.4, 47.6)], alerts: [alertFeature(-122.35, 47.55)] }));
    const signer = makeSigner(GW);
    const synced = (await (await syncPackets(hOn, GW, 47.6, -122.33, [packet(signer)])).json()) as SyncBody;
    expect(synced.bundle.satellite).toBeTruthy();
    expect(synced.bundle.satellite!.plumes).toHaveLength(1);
    expect(synced.bundle.satellite!.aqi?.aqi).toBe(45);
    // normalized hazards are UPSERTED — dashboards + future briefs gain them
    const hazardIds = (await hOn.astore.listHazards()).map((h) => h.sourceId);
    expect(hazardIds.some((id) => id.startsWith("hms-smoke:"))).toBe(true);
    expect(hazardIds.some((id) => id.startsWith("nws:"))).toBe(true);

    // A failing source omits the section but NEVER fails the sync.
    vi.stubGlobal("fetch", satFetch({ plumes: [plumeFeature(-122.4, 47.6)], alerts: [] }, "api.weather.gov"));
    const syncedDegraded = (await (await syncPackets(hOn, GW, 47.6, -122.33, [packet(signer)])).json()) as SyncBody;
    expect(syncedDegraded.bundle.satellite).toBeUndefined();

    // Gate OFF (default): nothing fetched, no section — tests/hermetic demo stay offline.
    const hOff = harness();
    const guard = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", guard as unknown as typeof fetch);
    const syncedOff = (await (await syncPackets(hOff, GW, 47.6, -122.33, [packet(makeSigner(GW))])).json()) as SyncBody;
    expect(syncedOff.bundle.satellite).toBeUndefined();
    expect(guard).not.toHaveBeenCalled();
  });

  it("review I1 fix: msg messages expose photoRef, and hasPhoto/photoUrl only once (and exactly) the bytes land — in /mesh/state AND the bundle", async () => {
    const h = harness();
    const deviceId = "mesh-test-msg-photo-device";
    const signer = makeSigner(deviceId);
    // one device, one keypair: the hazard sync pins it, the msg rides the same key
    await syncPackets(h, GW, 47.6, -122.33, [packet(signer, { type: "hazard", status: "signal check" })]);
    await syncPackets(h, GW, 47.6, -122.33, [
      packet(signer, { id: "mesh-test-msg-photo-1", type: "msg", status: "look at this flood", to: deviceHash(GW), photoRef: "mesh-test-msg-photo-r1" }),
    ]);

    // declared but NOT yet uploaded: the pointer rides, no resolved photo rendered
    const before = (await (await h.app.request("/mesh/state")).json()) as { messages: Array<{ id: string; photoRef: string | null; hasPhoto: boolean; photoKind: string | null; photoUrl: string | null }> };
    expect(before.messages[0]).toMatchObject({ id: "mesh-test-msg-photo-1", photoRef: "mesh-test-msg-photo-r1", hasPhoto: false, photoKind: null, photoUrl: null });

    await postPhoto(h, { deviceId, photoRef: "mesh-test-msg-photo-r1", data: imageBytes(66).toString("base64"), label: "flood" });
    const state = (await (await h.app.request("/mesh/state")).json()) as typeof before;
    expect(state.messages[0]).toMatchObject({ photoRef: "mesh-test-msg-photo-r1", hasPhoto: true, photoKind: "flood", photoUrl: "/mesh/photo/mesh-test-msg-photo-r1" });

    // the bundle (direct to the gateway's hash here) mirrors the same semantics
    const bundle = await buildDownlink(h.meshStore, memoryMatchStore(h.astore), { deviceId: GW, lat: 47.6, lon: -122.33 }, NOW);
    const inBundle = bundle.messages.find((m) => m.id === "mesh-test-msg-photo-1")!;
    expect(inBundle.photoRef).toBe("mesh-test-msg-photo-r1");
    expect(inBundle).toMatchObject({ hasPhoto: true, photoKind: "flood", photoUrl: "/mesh/photo/mesh-test-msg-photo-r1" });
  });
});

describe("Task 10: offline directions via OSRM (facts, no validator)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fetchRoute (injected fetcher): [lat,lon] coords sampled to ≤120, steps capped at 12, distance/duration normalized; profileFor >3 km ⇒ driving", async () => {
    const bigGeom = Array.from({ length: 300 }, (_unused, i: number) => [-122.4 - i * 0.001, 47.6 + i * 0.0005]);
    const osrmBody = {
      routes: [
        {
          distance: 12345,
          duration: 990,
          geometry: { coordinates: bigGeom },
          legs: [
            {
              steps: Array.from({ length: 18 }, (_unused, i: number) => ({
                distance: 100 + i,
                name: "4th Ave S",
                maneuver: { type: i === 0 ? "depart" : i === 17 ? "arrive" : "turn", modifier: i % 2 ? "left" : "right" },
              })),
            },
          ],
        },
      ],
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(osrmBody), { status: 200 }));
    const route = await fetchRoute({ lat: 47.6, lon: -122.335 }, { lat: 47.605, lon: -122.3315 }, "foot", fetcher as unknown as typeof fetch);
    expect(route).not.toBeNull();
    expect(route!.coords).toHaveLength(120);
    expect(route!.coords[0]).toEqual([47.6, -122.4]); // GeoJSON [lon,lat] flipped to [lat,lon]
    expect(route!.distanceKm).toBe(12.35);
    expect(route!.durationMin).toBe(17);
    expect(route!.steps).toHaveLength(12); // cap even though the leg had 18
    expect(route!.steps[0]!.instruction).toBe("depart right on 4th Ave S"); // phrase: type + modifier + road
    // the evacuation default walks when plausible
    expect(profileFor(3.01)).toBe("driving");
    expect(profileFor(3)).toBe("foot");
    expect(fetcher).toHaveBeenCalledTimes(1);

    // failure → null (all-or-nothing; the app keeps its glow-line fallback)
    expect(await fetchRoute({ lat: 47.6, lon: -122.33 }, { lat: 47.605, lon: -122.3315 }, "foot", vi.fn(async () => new Response("x", { status: 503 })) as unknown as typeof fetch)).toBeNull();
  });

  it("prepared pack fallback (DEMO_SIGNUP=1 gate): the bundle serves the committed fixture route badged source:'fixture' + the honesty log; a non-pack shelter ⇒ key omitted", async () => {
    const h = harness({
      env: { DEMO_SIGNUP: "1" }, // no SKYWATCH_LIVE_SYNC: the fixture pack is the only source; zero network
      resources: [shelter({ sourceId: "seed-shelter-1", verifiedAt: NOW, status: "open" })], // a PACK-shelter, verified-open
    });
    const logSpy = vi.spyOn(console, "log");
    const signer = makeSigner("mesh-test-device-route");
    const body = (await (await syncPackets(h, GW, 47.605, -122.335, [packet(signer)])).json()) as SyncBody;
    expect(body.bundle.routes).toHaveLength(1);
    const route = body.bundle.routes![0]!;
    expect(route.source).toBe("fixture"); // prepared pack, never masquerading as live
    expect(route.to.shelterId).toBe("seed-shelter-1");
    expect(route.to.name).toBe("Test Shelter"); // the harness resource (sourceId overridden onto the pack id)
    expect(route.from).toEqual({ lat: 47.605, lon: -122.335 });
    expect(route.coords.length).toBeGreaterThan(1);
    expect(route.steps.length).toBeLessThanOrEqual(12);
    expect(route.steps.every((s) => typeof s.instruction === "string")).toBe(true);
    // A FACT, not decayed: no confidence/score-ish key exists anywhere on it
    expect("confidence" in route).toBe(false);
    expect("score" in route).toBe(false);
    expect(logSpy.mock.calls.some((a) => String(a[0]).includes("prepared route served (fixture pack)"))).toBe(true);

    // a NON-pack shelter is verified-open too — but no prepared route exists for it: routes stay ABSENT
    const h2 = harness({
      env: { DEMO_SIGNUP: "1" },
      resources: [shelter({ sourceId: "mesh-test-shelter-not-in-pack", verifiedAt: NOW, status: "open" })],
    });
    const body2 = (await (await syncPackets(h2, GW, 47.6, -122.33, [packet(signer)])).json()) as SyncBody;
    expect(body2.bundle.routes).toBeUndefined();
  });

  it("knobs off (default): no routes key and NO network at all — hermetic determinism unchanged", async () => {
    const guard = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", guard as unknown as typeof fetch);
    const h = harness({ resources: [shelter({ sourceId: "seed-shelter-1", verifiedAt: NOW, status: "open" })] });
    const body = (await (await syncPackets(h, GW, 47.6, -122.33, [packet(makeSigner("mesh-test-device-route-2"))])).json()) as SyncBody;
    expect(body.bundle.routes).toBeUndefined();
    expect(guard).not.toHaveBeenCalled();
  });
});

describe("GET /mesh/state + /map/state mesh section (privacy, data-gated merge)", () => {
  it("ranked clusters, decayed hazard reports, anonymized coverage dots — never a deviceId or phone", async () => {
    const h = harness();
    const signer = makeSigner("mesh-test-device-secret-DONT-LEAK");
    await syncPackets(h, GW, 47.6, -122.33, [
      packet(signer, { deviceId: "mesh-test-device-secret-DONT-LEAK", ts: NOW - 30 * 60_000 }),
    ]);
    const res = await h.app.request("/mesh/state");
    expect(res.status).toBe(200);
    const state = (await res.json()) as unknown;
    const text = JSON.stringify(state);
    expect(text).not.toContain("DONT-LEAK");
    expect(text).not.toMatch(/\+15\d{9}/);
    const s = state as {
      beacons: Array<{ kind: string; priority: number; lat: number; lon: number; reports: number }>;
      hazardReports: unknown[];
      coverage: Array<{ id: string; lat: number; lon: number }>;
      counts: { packets: number; beacons: number; devices: number };
    };
    expect(s.beacons[0]?.kind).toBe("Trapped");
    expect(s.beacons[0]?.reports).toBe(1);
    expect(s.coverage).toHaveLength(1);
    expect(s.coverage[0]!.id).toMatch(/^[0-9a-f]{10}$/);
    expect(s.coverage[0]!.lat).toBeCloseTo(47.6, 1);
    expect(s.counts).toMatchObject({ packets: 1, beacons: 1, devices: 1 });
  });

  it("map/state merges a mesh section ONLY when at least one packet exists", async () => {
    const h = harness();
    const before = (await (await h.app.request("/map/state")).json()) as { mesh?: unknown };
    expect(before.mesh).toBeUndefined();

    const signer = makeSigner("mesh-test-device-mapmerge");
    await syncPackets(h, GW, 47.6, -122.33, [packet(signer)]);
    const after = (await (await h.app.request("/map/state")).json()) as {
      mesh?: { counts: { packets: number }; beacons: unknown[] };
    };
    expect(after.mesh?.counts.packets).toBe(1);
    expect(after.mesh?.beacons).toHaveLength(1);
    expect(JSON.stringify(after)).not.toContain("mesh-test-device-mapmerge");
  });

  it("open-read like /map/state: no tool secret required to GET /mesh/state", async () => {
    const h = harness();
    const res = await h.app.request("/mesh/state");
    expect(res.status).toBe(200);
  });
});

// Real-Mongo block: runs only when MONGODB_URI is set (same rule as the other gated
// files — run vitest with --no-file-parallelism). Cleans ONLY its own mesh-test-*
// keys before and after.
describe.skipIf(!process.env.MONGODB_URI)("real Mongo: mesh stores (dedup index, 2dsphere clustering)", () => {
  const signerA = makeSigner("mesh-test-device-real-1");
  const signerB = makeSigner("mesh-test-device-real-2");
  const signerC = makeSigner("mesh-test-device-real-3");

  // Indexes come back with name/v too — normalize to {key, unique} like db.test.ts.
  function indexInfo(indexes: Array<{ key: Record<string, string | number>; unique?: boolean }>) {
    return indexes.map((i) => ({ key: i.key, unique: i.unique === true }));
  }

  async function cleanup(db: Db) {
    await db.collection(COLLECTIONS.meshPackets).deleteMany({ id: { $regex: /^mesh-test-/ } });
    // 8d answers ride the reserved core id (ids start "chat:") — clean by deviceId.
    await db.collection(COLLECTIONS.meshPackets).deleteMany({ deviceId: SKYWATCH_CORE_ID });
    // 8e photos clean by their mesh-test- refs.
    await db.collection(COLLECTIONS.meshPhotos).deleteMany({ photoRef: { $regex: /^mesh-test-/ } });
    await db.collection(COLLECTIONS.beacons).deleteMany({
      $or: [{ sources: { $regex: /^mesh-test-/ } }, { packetIds: { $regex: /^mesh-test-/ } }],
    });
    await db.collection(COLLECTIONS.meshDevices).deleteMany({ deviceId: { $regex: /^mesh-test-/ } });
  }

  it("unique id index dedups across two gateway syncs; same-kind clusters merge server-side; index surface is registered", async () => {
    const { defaultDeps } = await import("../src/deps.ts");
    const config = loadConfig();
    const deps = defaultDeps(config);
    const app = createApp(config, deps);

    const db = await getDb(config);
    await cleanup(db);

    // Index surface: mesh_packets.id unique, beacons 2dsphere + unique clusterId, mesh_devices.deviceId unique
    const meshIdx = indexInfo((await db.collection(COLLECTIONS.meshPackets).indexes()) as never);
    expect(meshIdx).toContainEqual({ key: { id: 1 }, unique: true });
    const beaconIdx = indexInfo((await db.collection(COLLECTIONS.beacons).indexes()) as never);
    expect(beaconIdx).toContainEqual({ key: { loc: "2dsphere" }, unique: false });
    expect(beaconIdx).toContainEqual({ key: { clusterId: 1 }, unique: true });
    const deviceIdx = indexInfo((await db.collection(COLLECTIONS.meshDevices).indexes()) as never);
    expect(deviceIdx).toContainEqual({ key: { deviceId: 1 }, unique: true });

    const batch = [
      packet(signerA, { id: "mesh-test-real-1" }),
      packet(signerB, { id: "mesh-test-real-2", lat: 47.60009 }), // ~10 m from A -> merges
      packet(signerC, { id: "mesh-test-real-3", lat: 47.605 }), // ~550 m -> own cluster
    ];
    const first = (await (await app.request("/mesh/sync", {
      method: "POST",
      body: JSON.stringify({ deviceId: GW, lat: 47.6, lon: -122.33, packets: batch }),
      headers: { "content-type": "application/json" },
    })).json()) as SyncBody;
    expect(first.inserted).toBe(3);

    const retry = (await (await app.request("/mesh/sync", {
      method: "POST",
      body: JSON.stringify({ deviceId: GW, lat: 47.6, lon: -122.33, packets: batch }),
      headers: { "content-type": "application/json" },
    })).json()) as SyncBody;
    expect(retry.inserted).toBe(0);
    expect(retry.deduped).toBe(3);

    const store = await deps.mesh!();
    const beacons = await store.listBeacons();
    const trappedNear = beacons.filter((b) => b.kind === "Trapped");
    expect(trappedNear).toHaveLength(2);
    expect(trappedNear.find((b) => b.packetIds.length === 2)).toBeTruthy();
    expect((await store.listPackets()).filter((p) => p.id.startsWith("mesh-test-real-"))).toHaveLength(3);

    await cleanup(db);
    await closeDb();
  }, 60_000);

  it("8d: an ask-to-SKYWATCH msg over real Mongo gets a trusted-core answer in the same sync's bundle (deterministic: no Gemini key in the gated run)", async () => {
    const { defaultDeps } = await import("../src/deps.ts");
    const config = loadConfig();
    const deps = defaultDeps(config);
    const app = createApp(config, deps);

    const db = await getDb(config);
    await cleanup(db);
    const gatewayDeviceId = "mesh-test-real-8d-gw";
    const asker = makeSigner(gatewayDeviceId);
    const res = await app.request("/mesh/sync", {
      method: "POST",
      body: JSON.stringify({
        deviceId: gatewayDeviceId,
        lat: 47.6,
        lon: -122.33,
        packets: [packet(asker, { id: "mesh-test-ask-real-8d", type: "msg", status: "any water near me?", to: "SKYWATCH" })],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    // No Gemini key in the gated run -> the deterministic composition answers; the
    // reply rides the bundle (asker = gateway) without any mesh-specific config.
    const synced = (await res.json()) as SyncBody;
    const answer = synced.bundle.messages.find(
      (m) => m.from === deviceHash(SKYWATCH_CORE_ID) && m.to === deviceHash(gatewayDeviceId),
    )!;
    expect(answer.text.length).toBeLessThanOrEqual(MESH_MSG_STATUS_MAX);
    expect(answer.text.length).toBeGreaterThan(0);

    const state = (await (await app.request("/mesh/state")).json()) as { messages: Array<{ from: string; to: string | null }> };
    expect(state.messages.some((m) => m.from === deviceHash(SKYWATCH_CORE_ID))).toBe(true);

    await cleanup(db);
    await closeDb();
  }, 60_000);

  it("8e: photo upload/serve round-trip over real Mongo (mesh_photos unique photoRef; TOFU-pinned device only)", async () => {
    const { defaultDeps } = await import("../src/deps.ts");
    const config = loadConfig();
    const deps = defaultDeps(config);
    const app = createApp(config, deps);
    const db = await getDb(config);
    await cleanup(db);

    // photoRef index surface
    const photoIdx = indexInfo((await db.collection(COLLECTIONS.meshPhotos).indexes()) as never);
    expect(photoIdx).toContainEqual({ key: { photoRef: 1 }, unique: true });

    // pin the device with a signed packet (photos require a TOFU-pinned device)
    const deviceId = "mesh-test-real-photo-device";
    const signer = makeSigner(deviceId);
    const synced = (await (await app.request("/mesh/sync", {
      method: "POST",
      body: JSON.stringify({ deviceId: GW, lat: 47.6, lon: -122.33, packets: [packet(signer, { id: "mesh-test-real-photo-pkt", type: "hazard", status: "broken road", photoRef: "mesh-test-real-photo-1" })] }),
      headers: { "content-type": "application/json" },
    })).json()) as SyncBody;
    expect(synced.inserted).toBe(1);

    const data = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0xd9]).toString("base64");
    const post = await app.request("/mesh/photo", {
      method: "POST",
      body: JSON.stringify({ deviceId, photoRef: "mesh-test-real-photo-1", data, label: "road-broken" }),
      headers: { "content-type": "application/json" },
    });
    expect(post.status).toBe(200);
    // idempotent retry: one doc for the ref
    await app.request("/mesh/photo", {
      method: "POST",
      body: JSON.stringify({ deviceId, photoRef: "mesh-test-real-photo-1", data, label: "road-broken" }),
      headers: { "content-type": "application/json" },
    });

    const served = await app.request("/mesh/photo/mesh-test-real-photo-1");
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/jpeg");
    expect(served.headers.get("cache-control")).toContain("immutable");

    const doc = await db.collection(COLLECTIONS.meshPhotos).countDocuments({ photoRef: "mesh-test-real-photo-1" });
    expect(doc).toBe(1);
    // /mesh/state renders the resolved photo on the report
    const state = (await (await app.request("/mesh/state")).json()) as {
      hazardReports: Array<{ hasPhoto: boolean; photoKind: string | null; photoUrl: string | null }>;
    };
    expect(state.hazardReports[0]).toMatchObject({ hasPhoto: true, photoKind: "road-broken", photoUrl: "/mesh/photo/mesh-test-real-photo-1" });

    // over-cap is 413 over the wire too
    const big = await app.request("/mesh/photo", {
      method: "POST",
      body: JSON.stringify({ deviceId, photoRef: "mesh-test-real-photo-big", data: Buffer.alloc(151 * 1024, 0x20).toString("base64") }),
      headers: { "content-type": "application/json" },
    });
    expect(big.status).toBe(413);

    await cleanup(db);
    await closeDb();
  }, 60_000);

  afterAll(async () => {
    const db = await getDb(loadConfig());
    await cleanup(db);
    await closeDb();
  });
});