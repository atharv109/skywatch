import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
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
import { sigMessage } from "../src/mesh/sig.ts";
import { ackMessage, MESH_ACK_LINES } from "../src/mesh/downlink.ts";
import type { MeshPacketIn } from "../src/mesh/types.ts";
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
  opts: { hazards?: HazardDoc[]; resources?: ResourceDoc[]; roads?: RoadDoc[] } = {},
): Harness {
  const astore = memoryStore();
  for (const h of opts.hazards ?? []) void astore.upsertHazard(h);
  for (const r of opts.resources ?? []) void astore.upsertResource(r);
  for (const r of opts.roads ?? []) void astore.upsertRoad(r);
  const meshStore = memoryMeshStore();
  const config = loadConfig({ REPLAY: "1" });
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
  scored: number;
  unscored: number;
  bundle: {
    generatedAt: number;
    brief: { text: string; voiceScript: string };
    nearestVerifiedShelter: { name: string; status: string; confidence: number } | null;
    blockedRoads: Array<{ cameraId: string; status: string }>;
    acks: Array<{ beaconClusterId: string; message: string }>;
  };
}

const GW = "mesh-test-gateway";

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

  afterAll(async () => {
    const db = await getDb(loadConfig());
    await cleanup(db);
    await closeDb();
  });
});