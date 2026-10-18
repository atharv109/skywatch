import { describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { memoryStore } from "../src/store.ts";
import { memoryMatchStore } from "../src/match/store.ts";
import { memoryDeliverStore, type DeliverStore, type UserRecord } from "../src/deliver/store.ts";
import { stubInboundRuntime } from "../src/deliver/runtime.ts";
import { memoryVerifyStore, type VerifyStore } from "../src/verify/store.ts";
import { stubVoiceRuntime } from "../src/deliver/voice_runtime.ts";
import { emptyPipelineResult } from "../src/pipeline/run.ts";
import type { UserBrief } from "../src/types/brief.ts";
import type { HazardDoc, ResourceDoc, RoadDoc } from "../src/types/docs.ts";

const NOW = Date.now();
const SECRET = "test-tool-secret";

function smokeHazard(sourceId: string, t: number): HazardDoc {
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
    validFrom: t - 3_600_000,
    validTo: t + 6 * 3_600_000,
    source: "test",
  };
}

const resource = (over: Partial<ResourceDoc> = {}): ResourceDoc => ({
  sourceId: "seed-shelter-1",
  kind: "shelter",
  name: "Test Shelter",
  hours: "24/7",
  partner: true,
  status: "unknown",
  verifiedAt: null,
  loc: { type: "Point", coordinates: [-122.1, 47.5] },
  ...over,
});

const nonPartner = (): ResourceDoc => ({
  sourceId: "seed-shelter-2",
  kind: "shelter",
  name: "Other Shelter",
  partner: false,
  status: "unknown",
  verifiedAt: null,
  loc: { type: "Point", coordinates: [-122.1, 47.5] },
});

const camera = (over: Partial<RoadDoc> = {}): RoadDoc => ({
  cameraId: "wsdot-9800",
  name: "SR 99 demo",
  loc: { type: "Point", coordinates: [-122.101, 47.501] },
  status: "unknown",
  verifiedAt: null,
  imageUrl: "https://images.example/test.jpg",
  ...over,
});

function userDoc(phone = "+15551230001"): Omit<UserRecord, "id"> {
  return {
    phone,
    platform: "sms",
    spaceId: `any;-;${phone}`,
    lang: "en",
    state: "active",
    loc: { type: "Point", coordinates: [-122.1, 47.5] },
    zip: "98104",
    consentText: true,
    consentVoice: true,
    addressAttempts: 0,
    askedZip: false,
    langConfirmPending: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface Harness {
  astore: ReturnType<typeof memoryStore>;
  dstore: DeliverStore;
  verifyStore: VerifyStore;
  app: ReturnType<typeof createApp>;
  config: Config;
}

function harness(
  opts: {
    configEnv?: Record<string, string>;
    hazards?: HazardDoc[];
    resources?: ResourceDoc[];
    roads?: RoadDoc[];
  } = {},
): Harness {
  const astore = memoryStore();
  for (const r of opts.hazards ?? []) void astore.upsertHazard(r);
  for (const r of opts.resources ?? []) void astore.upsertResource(r);
  for (const r of opts.roads ?? []) void astore.upsertRoad(r);
  const dstore = memoryDeliverStore();
  const verifyStore = memoryVerifyStore();
  const config = loadConfig({ REPLAY: "1", ...(opts.configEnv ?? {}) });
  const app = createApp(config, {
    store: async () => astore,
    pipeline: async () => emptyPipelineResult(),
    inbound: stubInboundRuntime(),
    match: async () => memoryMatchStore(astore),
    deliver: async () => dstore,
    verify: async () => verifyStore,
    voice: stubVoiceRuntime(),
  });
  return { astore, dstore, verifyStore, app, config };
}

async function toolPost(app: Harness["app"], url: string, body: unknown, scheme: "header" | "bearer" | "none" = "header", secret = SECRET): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (scheme === "header") headers["X-Skywatch-Tool-Secret"] = secret;
  if (scheme === "bearer") headers["Authorization"] = `Bearer ${secret}`;
  return app.request(url, { method: "POST", body: JSON.stringify(body), headers });
}

async function mapState(app: Harness["app"]): Promise<{ resources: Array<{ sourceId: string; status: string; confidence: number; capacity?: number }> }> {
  return (await (await app.request("/map/state")).json()) as never;
}

describe("POST /tools/checkin (voice + manual, ONE endpoint)", () => {
  it("flips a resource open and the flip is visible in the next brief + map/state immediately", async () => {
    const h = harness({
      hazards: [smokeHazard("hms-smoke:demo", NOW)],
      resources: [resource({ partner: false })],
    });
    const created = await h.dstore.createUser(userDoc());

    const res = await toolPost(h.app, "/tools/checkin", { resourceId: "seed-shelter-1", status: "open", capacity: 40 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; resource: ResourceDoc };
    expect(body.ok).toBe(true);
    expect(body.resource.status).toBe("open");
    expect(body.resource.capacity).toBe(40);
    expect(body.resource.lastCheckin?.status).toBe("open");
    expect(body.resource.lastCheckin?.manual).toBe(false);

    // NEXT BRIEF: the (unpartnered-but-open) shelter match — confidence decayed from verifiedAt=now
    const briefRes = await h.app.request(`/tools/brief/${created.id}`, {
      headers: { "X-Skywatch-Tool-Secret": SECRET },
    });
    expect(briefRes.status).toBe(200);
    const brief = (await briefRes.json()) as UserBrief;
    expect(brief.shelter?.status).toBe("open");
    expect(brief.shelter?.name).toBe("Test Shelter");
    expect(brief.shelter?.confidence).toBeGreaterThanOrEqual(0.99);

    // MAP STATE: fresh status + capacity
    const map = await mapState(h.app);
    const shelter = map.resources.find((r) => r.sourceId === "seed-shelter-1");
    expect(shelter?.status).toBe("open");
    expect(shelter!.confidence).toBeGreaterThan(0.99);
  });

  it("manual:true uses the SAME endpoint, notes stored, 'full' visible on map; conversation note only with a userId", async () => {
    const h = harness({ resources: [resource()] });
    const created = await h.dstore.createUser(userDoc());
    const res = await toolPost(h.app, "/tools/checkin", {
      resourceId: "seed-shelter-1",
      status: "full",
      manual: true,
      userId: created.id,
      notes: "Front desk says at capacity",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { manual: boolean }).manual).toBe(true);
    expect((await h.dstore.listConversations()).filter((e) => e.userId === created.id)).toHaveLength(1);
    const convos = (await h.dstore.listConversations()).filter((e) => e.userId === created.id);
    expect(convos[0]).toMatchObject({ from: "bot", text: "Check-in for Test Shelter: status full." });
    const map = await mapState(h.app);
    expect(map.resources.find((r) => r.sourceId === "seed-shelter-1")?.status).toBe("full");

    // without userId (plain manual button write): no conversation write anywhere
    const h2 = harness({ resources: [resource()] });
    await h2.dstore.createUser(userDoc());
    await toolPost(h2.app, "/tools/checkin", { resourceId: "seed-shelter-1", status: "closed", manual: true });
    expect(await h2.dstore.listConversations()).toHaveLength(0);
  });

  it("validation: bad status 400, unknown resource 404, notes truncated", async () => {
    const h = harness({ resources: [resource()] });
    expect(
      (await toolPost(h.app, "/tools/checkin", { resourceId: "seed-shelter-1", status: "wat" })).status,
    ).toBe(400);
    expect((await toolPost(h.app, "/tools/checkin", { resourceId: "nope", status: "open" })).status).toBe(404);
    expect((await toolPost(h.app, "/tools/checkin", { status: "open" })).status).toBe(400);
    const long = "x".repeat(600);
    const res = (await (await toolPost(h.app, "/tools/checkin", { resourceId: "seed-shelter-1", status: "open", notes: long })).json()) as {
      resource: { lastCheckin: { notes: string | null } };
    };
    expect(res.resource.lastCheckin.notes).toHaveLength(200);
  });

  it("size caps at the edge: over-cap resourceId/notes/userId/capacity are 400 and never reach the store", async () => {
    const h = harness({ resources: [resource()] });
    const r = (body: Record<string, unknown>) => toolPost(h.app, "/tools/checkin", body);
    expect((await r({ resourceId: "r".repeat(129), status: "open" })).status).toBe(400);
    expect((await r({ resourceId: "seed-shelter-1", status: "open", notes: "x".repeat(4001) })).status).toBe(400);
    expect((await r({ resourceId: "seed-shelter-1", status: "open", userId: "u".repeat(129) })).status).toBe(400);
    expect((await r({ resourceId: "seed-shelter-1", status: "open", userId: 42 })).status).toBe(400);
    expect((await r({ resourceId: "seed-shelter-1", status: "open", capacity: 1_000_001 })).status).toBe(400);
    expect((await r({ resourceId: "seed-shelter-1", status: "open", capacity: "not-a-number" })).status).toBe(400);
    // nothing was applied (the resource is untouched)
    const stored = await h.astore.getResource("seed-shelter-1");
    expect(stored?.status).toBe("unknown");
    // in-range values still pass (caps bound, not block, normal calls)
    expect((await r({ resourceId: "seed-shelter-1", status: "open", capacity: 1_000_000, notes: "ok" })).status).toBe(200);
  });
});

describe("tool-secret auth (checkin + verify/run + roads)", () => {
  it("TOOL_SECRET set: 401 without/wrong; X-Skywatch-Tool-Secret AND Bearer forms both accepted", async () => {
    const h = harness({ configEnv: { TOOL_SECRET: "tool-secret" }, resources: [resource()] });
    const body = { resourceId: "seed-shelter-1", status: "open" };
    expect(
      (await h.app.request("/tools/checkin", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })).status,
    ).toBe(401);
    expect((await toolPost(h.app, "/tools/checkin", body, "header", "wrong")).status).toBe(401);
    expect((await toolPost(h.app, "/tools/checkin", body, "header", "tool-secret")).status).toBe(200);
    expect((await toolPost(h.app, "/tools/checkin", body, "bearer", "tool-secret")).status).toBe(200);
    expect(
      (await h.app.request("/verify/run", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status,
    ).toBe(401);
    // unauthenticated roads/check stays unauthenticated when TOOL_SECRET unset (demo-grade)
    const hU = harness({ roads: [camera()] });
    expect(
      (await hU.app.request("/roads/check", { method: "POST", body: JSON.stringify({ cameraId: "wsdot-9800", status: "clear", confidence: 0.9 }), headers: { "content-type": "application/json" } })).status,
    ).toBe(200);
  });
});

describe("POST /verify/run (partner-inside-hazard targeting, ONE consumption contract)", () => {
  it("creates a request for each partner inside an active hazard; none for non-partner or outside", async () => {
    const h = harness({
      hazards: [smokeHazard("hms-smoke:demo", NOW)],
      resources: [resource(), nonPartner(), resource({ sourceId: "seed-shelter-3", name: "Far Shelter", loc: { type: "Point", coordinates: [-119, 45] } })],
    });
    const res = await toolPost(h.app, "/verify/run", { deviceId: "device-1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: Array<{ requestId: string; resourceId: string; resourceName: string; deviceId: string | null; status: string }> };
    expect(body.created).toHaveLength(1);
    expect(body.created[0]).toMatchObject({
      requestId: "vr:seed-shelter-1:hms-smoke:demo",
      resourceId: "seed-shelter-1",
      resourceName: "Test Shelter",
      deviceId: "device-1",
      status: "pending",
    });
    // no phone numbers anywhere in the response (privacy carry)
    expect(JSON.stringify(body)).not.toContain("555");

    // re-run while the request is pending: idempotent, nothing created
    expect(((await (await toolPost(h.app, "/verify/run", {})).json()) as { created: unknown[] }).created).toHaveLength(0);
  });

  it("Delivery poll contract: GET /tools/checkin/next?deviceId= hands out pending requests and marks them dispatched", async () => {
    const h = harness({ hazards: [smokeHazard("hms-smoke:demo", NOW)], resources: [resource()] });
    expect((await toolPost(h.app, "/verify/run", { deviceId: "device-1" })).status).toBe(200);
    const poll = async () =>
      (await (await h.app.request("/tools/checkin/next?deviceId=device-1", {
        headers: { "X-Skywatch-Tool-Secret": SECRET },
      })).json()) as { requests: Array<{ requestId: string; resourceName: string; status: string; hazardSourceId: string }> };
    expect((await poll()).requests).toHaveLength(1);
    expect((await poll()).requests).toHaveLength(0); // dispatched requests do not redeliver
  });

  it("expired hazard (validTo past) -> no requests", async () => {
    const h = harness({
      hazards: [{ ...smokeHazard("hms-smoke:demo", NOW), validTo: NOW - 1_000 }],
      resources: [resource()],
    });
    expect(((await (await toolPost(h.app, "/verify/run", {})).json()) as { created: unknown[] }).created).toHaveLength(0);
    expect(await h.verifyStore.listRequests()).toHaveLength(0);
  });
});

// Real-Mongo checks (natural here: a check-in is a durable write): runs only when
// MONGODB_URI is set, cleans its own docs by key, never touches other collections
// beyond the unique verify_requests index it reads.
function indexInfo(indexes: { key: Record<string, string | number>; unique?: boolean }[]) {
  return indexes.map((i) => ({ key: i.key, unique: i.unique === true }));
}

describe.skipIf(!process.env.MONGODB_URI)("real Mongo: checkin write + verify_requests index", () => {
  it("applyCheckin updates the stored resource (status/verifiedAt/capacity/lastCheckin) and the verify_requests index exists", async () => {
    const { getDb, closeDb, COLLECTIONS } = await import("../src/db/client.ts");
    const { mongoStore } = await import("../src/store.ts");
    const { applyCheckin } = await import("../src/verify/checkin.ts");
    const { mongoVerifyStore } = await import("../src/verify/store.ts");
    const { ObjectId } = await import("mongodb");
    const db = await getDb(loadConfig());
    const store = mongoStore(db);
    const doc: ResourceDoc = {
      sourceId: "task6-mongo-checkin",
      kind: "shelter",
      name: "Mongo Test Shelter",
      partner: true,
      status: "unknown",
      verifiedAt: null,
      loc: { type: "Point", coordinates: [-122.1, 47.5] },
    };
    try {
      await db.collection(COLLECTIONS.resources).replaceOne(
        { sourceId: doc.sourceId },
        { ...doc, _id: new ObjectId() },
        { upsert: true },
      );
      const result = await applyCheckin(store, doc.sourceId, { resourceId: doc.sourceId, status: "open", capacity: 12 }, Date.now());
      expect(result.resource.status).toBe("open");
      expect(result.resource.capacity).toBe(12);
      const reread = await store.getResource(doc.sourceId);
      expect(reread?.verifiedAt).not.toBeNull();
      expect(reread?.lastCheckin?.manual).toBe(false);

      const verifyIndexes = indexInfo(await db.collection(COLLECTIONS.verifyRequests).indexes());
      expect(verifyIndexes).toContainEqual({ key: { requestId: 1 }, unique: true });
      // the store round-trips: create + checkoutPending against Mongo
      const verify = mongoVerifyStore(db);
      const created = await verify.createRequest({
        requestId: "vr:task6-mongo-checkin:hms-test",
        resourceId: doc.sourceId,
        resourceName: doc.name,
        hazardSourceId: "hms-test",
        agentId: null,
        deviceId: "dev-1",
        status: "pending",
        outcome: null,
        conversationId: null,
        manual: false,
        createdAt: Date.now(),
        dispatchedAt: null,
        answeredAt: null,
      });
      expect(created).not.toBeNull();
      await verify.createRequest({
        requestId: "vr:task6-mongo-checkin:hms-test",
        resourceId: doc.sourceId,
        resourceName: doc.name,
        hazardSourceId: "hms-test",
        agentId: null,
        deviceId: "dev-1",
        status: "pending",
        outcome: null,
        conversationId: null,
        manual: false,
        createdAt: Date.now(),
        dispatchedAt: null,
        answeredAt: null,
      });
      const polled = await verify.checkoutPending("dev-1", Date.now());
      expect(polled.map((r) => r.requestId)).toContain("vr:task6-mongo-checkin:hms-test");
    } finally {
      await db.collection(COLLECTIONS.resources).deleteMany({ sourceId: doc.sourceId });
      await db.collection(COLLECTIONS.verifyRequests).deleteOne({ requestId: "vr:task6-mongo-checkin:hms-test" });
      await closeDb();
    }
  });

  it("full API round-trip against real Mongo: check-in + roads/check (no immutable-_id 503) + verify run → checkout → failure release", async () => {
    const { getDb, closeDb, COLLECTIONS } = await import("../src/db/client.ts");
    const { mongoStore } = await import("../src/store.ts");
    const { mongoDeliverStore } = await import("../src/deliver/store.ts");
    const { mongoMatchStore } = await import("../src/match/store.ts");
    const { mongoVerifyStore } = await import("../src/verify/store.ts");
    const { createVoiceRuntime } = await import("../src/deliver/voice_runtime.ts");
    const { ObjectId } = await import("mongodb");
    const db = await getDb(loadConfig());
    const doc: ResourceDoc = {
      sourceId: "task6-mongo-api-1",
      kind: "shelter",
      name: "Mongo API Shelter",
      hours: "24/7",
      partner: true,
      status: "unknown",
      verifiedAt: null,
      loc: { type: "Point", coordinates: [-122.1, 47.5] },
    };
    const roadDoc: RoadDoc = {
      cameraId: "wsdot-mongo-1",
      name: "Mongo Test Rd",
      status: "unknown",
      verifiedAt: null,
      loc: { type: "Point", coordinates: [-122.101, 47.501] },
      imageUrl: "x",
    };
    const config = loadConfig({
      // REPLAY=0 on purpose: seed-on-boot (REPLAY=1 + empty DB) would add the fixture
      // partners as /verify/run targets, and the single failure-release routes to the
      // most-recently-dispatched request — not necessarily ours. This test is about
      // the round-trip, not seeding; replay route still works in REPLAY=0.
      REPLAY: "0",
      TOOL_SECRET: "tool-secret",
      ELEVENLABS_AGENT_ID_CHECKIN: "agent-checkin-1",
      ELEVENLABS_VOICE_WEBHOOK_SECRET: "voice-test",
    });
    const verifyStore = mongoVerifyStore(db);
    const voiceRuntime = (await import("../src/deliver/voice_runtime.ts")).createVoiceRuntime(config, {
      deliver: async () => mongoDeliverStore(db),
      verify: async () => verifyStore,
    });
    // Local DBs persist across suite runs; this test's own keys must start clean or
    // the verify re-arm cap (correct behavior) makes the request already-exist.
    await Promise.all([
      db.collection(COLLECTIONS.resources).deleteMany({ sourceId: doc.sourceId }),
      db.collection(COLLECTIONS.roads).deleteMany({ cameraId: roadDoc.cameraId }),
      db.collection(COLLECTIONS.verifyRequests).deleteMany({ requestId: { $regex: `^vr:${doc.sourceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:` } }),
    ]);
    const app = createApp(config, {
      store: async () => mongoStore(db),
      pipeline: async () => emptyPipelineResult(),
      inbound: stubInboundRuntime(),
      match: async () => mongoMatchStore(db),
      deliver: async () => mongoDeliverStore(db),
      verify: async () => verifyStore,
      voice: voiceRuntime,
    });
    try {
      await db.collection(COLLECTIONS.resources).updateOne(
        { sourceId: doc.sourceId },
        { $set: { ...doc, _id: new ObjectId() } },
        { upsert: true },
      );
      await db.collection(COLLECTIONS.roads).updateOne(
        { cameraId: roadDoc.cameraId },
        { $set: { ...roadDoc, _id: new ObjectId() } },
        { upsert: true },
      );
      // an active hazard covering the resource point, so /verify/run has a target
      await mongoStore(db).upsertHazard(smokeHazard("hms-smoke:demo", Date.now()));
      const secretHeaders = { "content-type": "application/json", Authorization: "Bearer tool-secret" };

      // check-in through the real HTTP surface (previously: 503 on Atlas, _id in $set)
      const checkin = await app.request("/tools/checkin", {
        method: "POST",
        body: JSON.stringify({ resourceId: doc.sourceId, status: "open", capacity: 9, manual: true }),
        headers: secretHeaders,
      });
      expect(checkin.status).toBe(200);
      const resourceDoc = await mongoStore(db).getResource(doc.sourceId);
      expect(resourceDoc?.status).toBe("open");
      expect(resourceDoc?.capacity).toBe(9);
      expect(resourceDoc?.verifiedAt).not.toBeNull();

      // roads/check round-trip (the second _id-in-$set crash path)
      const roadRes = await app.request("/roads/check", {
        method: "POST",
        body: JSON.stringify({ cameraId: roadDoc.cameraId, status: "flooded", confidence: 0.9 }),
        headers: secretHeaders,
      });
      expect(roadRes.status).toBe(200);
      const roadStored = await mongoStore(db).getRoad(roadDoc.cameraId);
      expect(roadStored?.status).toBe("flooded");
      expect(roadStored?.verifiedAt).not.toBeNull();

      // verify run creates a request, the poll checks it out, a failure webhook releases it
      const run = await app.request("/verify/run", { method: "POST", body: "{}", headers: secretHeaders });
      expect(run.status).toBe(200);
      const { created } = (await run.json()) as { created: Array<{ requestId: string }> };
      // assert by resource: the requestId embeds whichever active hazard the
      // target matcher landed on, and a shared local DB can hold older fixture
      // hazards that legitimately win that first-match order.
      expect(created.map((r) => (r as { requestId: string; resourceId: string }).resourceId)).toContain(doc.sourceId);
      const poll = await app.request("/tools/checkin/next?deviceId=dev-1", {
        headers: { Authorization: "Bearer tool-secret" },
      });
      expect(((await poll.json()) as { requests: unknown[] }).requests.length).toBeGreaterThanOrEqual(1);

      const { createHmac } = await import("node:crypto");
      const raw = JSON.stringify({ type: "call_initiation_failure", data: { agent_id: "agent-checkin-1", conversation_id: "conv-fail-1", failure_reason: "busy" } });
      const ts = Math.floor(Date.now() / 1000);
      const failure = await app.request("/webhooks/voice/post-call", {
        method: "POST",
        body: raw,
        headers: {
          "content-type": "application/json",
          "elevenlabs-signature": `t=${ts},v1=` + createHmac("sha256", "voice-test").update(`${ts}.${raw}`).digest("hex"),
        },
      });
      expect(failure.status).toBe(200);
      await voiceRuntime.drain();
      const released = await db.collection(COLLECTIONS.verifyRequests).find({ resourceId: doc.sourceId }).toArray();
      expect(released.some((r) => r["status"] === "answered" && r["outcome"] === "no-answer:busy")).toBe(true);
      expect(released.some((r) => r["status"] === "dispatched")).toBe(false);
    } finally {
      await db.collection(COLLECTIONS.resources).deleteMany({ sourceId: doc.sourceId });
      await db.collection(COLLECTIONS.roads).deleteMany({ cameraId: roadDoc.cameraId });
      await db.collection(COLLECTIONS.verifyRequests).deleteMany({ resourceId: doc.sourceId });
      await db.collection(COLLECTIONS.hazards).deleteMany({ sourceId: "hms-smoke:demo" });
      await closeDb();
    }
  // remote (Atlas) round-trips can brush the default 5s from a laptop — generous bound
  }, 60_000);
});

describe("src/roads check (confidence gate + adapter seam)", () => {
  it("flooded verdict at 0.9 is stored (verifiedAt=now) and lands in the next brief; < 0.5 verdict becomes unknown and is excluded", async () => {
    const assertable = harness({
      hazards: [smokeHazard("hms-smoke:demo", NOW)],
      resources: [resource({ partner: false })],
      roads: [camera()],
    });
    const created = await assertable.dstore.createUser(userDoc());
    const res = (await (await toolPost(assertable.app, "/roads/check", { cameraId: "wsdot-9800", status: "flooded", confidence: 0.9 })).json()) as {
      ok: boolean;
      status: string;
      verifiedAt: number | null;
      vision: { wired: boolean; mode: string };
    };
    expect(res.ok).toBe(true);
    expect(res.status).toBe("flooded");
    expect(res.verifiedAt).not.toBeNull();
    expect(res.vision.mode).toBe("not_wired"); // no live vision calls, by default, ever
    const brief = (await (await assertable.app.request(`/tools/brief/${created.id}`, { headers: { "X-Skywatch-Tool-Secret": SECRET } })).json()) as UserBrief;
    expect(brief.blockedRoads[0]?.status).toBe("flooded");

    // SAME route: confidence < 0.5 -> stored unknown + verifiedAt null -> NOT in the brief
    const unconvinced = harness({ hazards: [smokeHazard("hms-smoke:demo", NOW)], resources: [resource({ partner: false })], roads: [camera()] });
    const created2 = await unconvinced.dstore.createUser(userDoc());
    const res2 = (await (await toolPost(unconvinced.app, "/roads/check", { cameraId: "wsdot-9800", status: "flooded", confidence: 0.2 })).json()) as {
      status: string;
      verifiedAt: number | null;
    };
    expect(res2.status).toBe("unknown");
    expect(res2.verifiedAt).toBeNull();
    const brief2 = (await (await unconvinced.app.request(`/tools/brief/${created2.id}`, { headers: { "X-Skywatch-Tool-Secret": SECRET } })).json()) as UserBrief;
    expect(brief2.blockedRoads).toHaveLength(0);
  });

  it("confidence > 1 or missing is treated as unknown; unknown camera 404; bad status 400; clear resets the assertion", async () => {
    const h = harness({ roads: [camera()] });
    const over = (await (await toolPost(h.app, "/roads/check", { cameraId: "wsdot-9800", status: "flooded", confidence: 2 })).json()) as { status: string; verifiedAt: number | null };
    expect(over.status).toBe("unknown");
    expect(over.verifiedAt).toBeNull();
    expect((await toolPost(h.app, "/roads/check", { cameraId: "nope", status: "clear", confidence: 0.9 })).status).toBe(404);
    expect((await toolPost(h.app, "/roads/check", { cameraId: "wsdot-9800", status: "sideways", confidence: 0.9 })).status).toBe(400);
    const cleared = (await (await toolPost(h.app, "/roads/check", { cameraId: "wsdot-9800", status: "clear", confidence: 0.7 })).json()) as { status: string; verifiedAt: number | null };
    expect(cleared.status).toBe("clear");
    expect(cleared.verifiedAt).not.toBeNull();
  });
});