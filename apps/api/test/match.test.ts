import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { memoryStore } from "../src/store.ts";
import { memoryDeliverStore, type DeliverStore, type UserRecord } from "../src/deliver/store.ts";
import { memoryMatchStore, mongoMatchStore } from "../src/match/store.ts";
import { runPipeline, type PipelineResult } from "../src/pipeline/run.ts";
import { stubInboundRuntime } from "../src/deliver/runtime.ts";
import { memoryVerifyStore } from "../src/verify/store.ts";
import { stubVoiceRuntime } from "../src/deliver/voice_runtime.ts";
import type { HazardDoc, ResourceDoc, RoadDoc } from "../src/types/docs.ts";
import type { UserBrief } from "../src/types/brief.ts";

const NOW = Date.parse("2026-10-18T01:00:00.000Z");
const SEATTLE: [number, number] = [-122.335, 47.605];

function smokeHazard(severity: number, sourceId: string, t0: number): HazardDoc {
  return {
    sourceId,
    type: "smoke",
    severity,
    title: `Smoke plume ${sourceId}`,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-123.5, 46.9],
          [-121.5, 46.9],
          [-121.5, 48.5],
          [-123.5, 48.5],
          [-123.5, 46.9],
        ],
      ],
    },
    validFrom: t0 - 3_600_000,
    validTo: t0 + 12 * 3_600_000,
    source: "test",
  };
}

const shelter = (t0: number, verifiedAt: number | null): ResourceDoc => ({
  sourceId: "seed-shelter-1",
  kind: "shelter",
  name: "Test Shelter",
  hours: "24/7",
  partner: true,
  status: "open",
  verifiedAt,
  loc: { type: "Point", coordinates: [-122.34, 47.61] },
});

const road = (t0: number, verifiedAt: number | null, status: RoadDoc["status"]): RoadDoc => ({
  cameraId: "wsdot-9800",
  name: "SR 99 demo",
  loc: { type: "Point", coordinates: [-122.336, 47.6055] },
  status,
  verifiedAt,
  imageUrl: "https://images.example/test.jpg",
});

function userDoc(): Omit<UserRecord, "id"> {
  return {
    phone: "+15551239999",
    platform: "sms",
    spaceId: "any;-;+15551239999",
    lang: "en",
    state: "active",
    loc: { type: "Point", coordinates: SEATTLE },
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
  clock: { value: number };
  app: ReturnType<typeof createApp>;
  pipeline: () => Promise<PipelineResult>;
}

/**
 * liveTime=false: everything anchors on the fixed NOW and the pipeline runs on an
 * injected clock (rate-gate determinism). liveTime=true: the /tools routes build
 * briefs on the real clock (`Date.now()`), so their fixtures anchor there too.
 */
function harness(opts: { withRoad?: boolean; configEnv?: Record<string, string>; liveTime?: boolean } = {}): Harness {
  const t0 = opts.liveTime ? Date.now() : NOW;
  const astore = memoryStore();
  const dstore = memoryDeliverStore();
  const clock = { value: NOW };
  void astore.upsertHazard(smokeHazard(3, "hms-smoke:demo", t0));
  void astore.upsertResource(shelter(t0, t0 - 10 * 60_000));
  if (opts.withRoad) void astore.upsertRoad(road(t0, t0 - 5 * 60_000, "flooded"));
  const match = () => Promise.resolve(memoryMatchStore(astore));
  const config = loadConfig({ REPLAY: "1", ...(opts.configEnv ?? {}) });
  return {
    astore,
    dstore,
    clock,
    app: createApp(config, {
      store: async () => astore,
      pipeline: async () => ({ briefedUsers: 0, alerts: { sent: 0, not_wired: 0, failed: 0, rate_limited: 0, consent_hold: 0 } }),
      inbound: stubInboundRuntime(),
      match,
      deliver: async () => dstore,
      verify: async () => memoryVerifyStore(),
      voice: stubVoiceRuntime(),
    }),
    pipeline: () =>
      runPipeline({
        config,
        store: astore,
        match,
        deliver: async () => dstore,
      now: () => clock.value,
      }),
  };
}

describe("runPipeline (delivery gates over the matched brief)", () => {
  it("briefs a consenting located user once and attempts delivery (NotWired path)", async () => {
    const h = harness({ withRoad: true });
    await h.dstore.createUser(userDoc());
    const result = await h.pipeline();
    expect(result).toMatchObject({ briefedUsers: 1, alerts: { not_wired: 1 } });
    const outbox = await h.dstore.listOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.status).toBe("not_wired");
    // Rate key = worst active hazard sourceId; alert text built only from brief fields.
    expect(outbox[0]?.rateKey).toBe("hms-smoke:demo");
    expect(outbox[0]?.text).toContain("Call 911 if you are in danger.");
    expect(outbox[0]?.text).toContain("Open shelter: Test Shelter");
  });

  it("second alert for the same hazard within 2 h is suppressed by the rate gate", async () => {
    const h = harness();
    await h.dstore.createUser(userDoc());
    const first = await h.pipeline();
    const second = await h.pipeline();
    expect(second).toMatchObject({ briefedUsers: 1, alerts: { rate_limited: 1 } });
    expect(first.alerts.not_wired).toBe(1);
    // After the 2 h window a new alert may go out again.
    h.clock.value = NOW + 2 * 60 * 60 * 1000 + 1;
    const third = await h.pipeline();
    expect(third).toMatchObject({ briefedUsers: 1, alerts: { not_wired: 1 } });
  });

  it("skips users with no active hazard and mid-signup users; revoked-consent users drop out entirely", async () => {
    const h = harness();
    await h.dstore.createUser(userDoc());
    await h.dstore.createUser({ ...userDoc(), phone: "+15551238888", state: "asked-address", loc: null });
    await h.dstore.createUser({ ...userDoc(), phone: "+15551237777", consentText: false, consentVoice: false });
    await h.dstore.createUser({ ...userDoc(), phone: "+15551236666", loc: { type: "Point", coordinates: [40, -105] } });
    const result = await h.pipeline();
    expect(result).toMatchObject({ briefedUsers: 1, alerts: { not_wired: 1 } });
    // the located-but-different-city user and the others produced nothing else
    expect((await h.dstore.listOutbox()).filter((o) => o.status === "not_wired")).toHaveLength(1);
  });
});

describe("GET /tools/brief/:userId + /tools/brief/byPhone/:platform/:phone", () => {
  function briefReq(app: Harness["app"], url: string, headerSecret?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (headerSecret !== undefined) headers["X-Skywatch-Tool-Secret"] = headerSecret;
    return Promise.resolve(app.request(url, { headers }));
  }

  it("resolves a brief by phone(+platform) AND by userId; tool reads write no outbox row", async () => {
    const h = harness({ withRoad: true, liveTime: true, configEnv: { TOOL_SECRET: "demo-tool-secret" } });
    const created = await h.dstore.createUser(userDoc());

    const byPhone = await briefReq(h.app, "/tools/brief/byPhone/sms/%2B15551239999", "demo-tool-secret");
    expect(byPhone.status).toBe(200);
    const brief = (await byPhone.json()) as UserBrief;
    expect(brief.userId).toBe(created.id);
    expect(brief.hazards).toHaveLength(1);
    expect(brief.shelter).not.toBeNull();
    expect(brief.shelter!.status).toBe("open");
    expect(brief.blockedRoads[0]?.status).toBe("flooded");
    expect(JSON.stringify(brief)).not.toContain("15551239999"); // never the phone number

    const byId = await briefReq(h.app, `/tools/brief/${created.id}`, "demo-tool-secret");
    expect(byId.status).toBe(200);
    expect((await byId.json()) as UserBrief).toEqual(brief);

    expect(await h.dstore.listOutbox()).toHaveLength(0); // read-only: no delivery side effects
  });

  it("404 for unknown, mismatched platform, location-less, and mid-signup users — fixed bodies, phone never echoed", async () => {
    const h = harness({ liveTime: true });
    await h.dstore.createUser(userDoc());

    expect((await briefReq(h.app, "/tools/brief/byPhone/sms/unknown-phone-555")).status).toBe(404);
    // wrong platform on an existing user
    expect((await briefReq(h.app, "/tools/brief/byPhone/imessage/+15551239999")).status).toBe(404);
    // unknown platform segment
    expect((await briefReq(h.app, "/tools/brief/byPhone/telegram/+15551239999")).status).toBe(404);
    // known id but incomplete signup (no loc)
    const partial = await h.dstore.createUser({ ...userDoc(), phone: "+15551231337", loc: null, state: "asked-address" });
    expect((await briefReq(h.app, `/tools/brief/${partial.id}`)).status).toBe(404);
    // malformed/foreign id
    expect((await briefReq(h.app, "/tools/brief/not-a-real-id")).status).toBe(404);
    // the byPhone 404 body itself never contains the dialed number
    const body = String(await (await briefReq(h.app, "/tools/brief/byPhone/sms/unknown-phone-555")).json());
    expect(body).not.toContain("unknown-phone-555");
  });

  it("no hazard -> officialSource-only brief (no actions, no hazards)", async () => {
    const h = harness({ liveTime: true });
    const created = await h.dstore.createUser(userDoc());
    // expire the only hazard so the user has nothing active
    await h.astore.upsertHazard({ ...smokeHazard(3, "hms-smoke:demo", Date.now()), validTo: Date.now() - 1 });
    const res = await briefReq(h.app, `/tools/brief/${created.id}`);
    expect(res.status).toBe(200);
    const brief = (await res.json()) as UserBrief;
    expect(brief.hazards).toEqual([]);
    expect(brief.actions).toEqual([]);
    expect(brief.shelter).toBeNull();
    expect(brief.officialSource.name).toBe("National Weather Service");
  });

  it("TOOL_SECRET set: 401 without/with wrong header, 200 with the right one", async () => {
    const secret = "demo-tool-secret";
    const h = harness({ configEnv: { TOOL_SECRET: secret } });
    const created = await h.dstore.createUser(userDoc());
    expect((await briefReq(h.app, `/tools/brief/${created.id}`)).status).toBe(401);
    expect((await briefReq(h.app, `/tools/brief/${created.id}`, "nope")).status).toBe(401);
    expect((await briefReq(h.app, `/tools/brief/${created.id}`, secret)).status).toBe(200);
    expect((await briefReq(h.app, "/tools/brief/byPhone/sms/+15551239999", secret)).status).toBe(200);
  });
});

// Task-4 code must never log a phone number: cheap grep-style audit over the new files.
// Rule: no console.log/info at all, and console.* lines pass only static literals
// (no template interpolation where a user identifier could sneak in).
describe("no phone logging in new code", () => {
  it("console.* lines in Task-4 files are static, identifier-free errors only", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    for (const file of [
      "pipeline/run.ts",
      "routes/tools.ts",
      "brief/build.ts",
      "brief/rules.ts",
      "match/store.ts",
      // Task 6 files (checkin/verify/roads/chat/voice log only static literals or err messages)
      "verify/checkin.ts",
      "verify/run.ts",
      "verify/store.ts",
      "verify/routes.ts",
      "roads/check.ts",
      "roads/adapter.ts",
      "roads/routes.ts",
      "deliver/chat.ts",
      "deliver/voice.ts",
      "deliver/voice_runtime.ts",
    ]) {
      const text = await readFile(dir + file, "utf8");
      expect(text, file).not.toMatch(/console\.(log|info)\(/);
      for (const line of text.split("\n")) {
        if (line.includes("console.")) {
          expect(line, file).not.toMatch(/\$\{/);
        }
      }
    }
  });
});
// The Mongo spatial queries ($geoIntersects / $geoNear) against a real server:
// runs when MONGODB_URI is set (same rule as Task 1/2's db tests).
describe.skipIf(!process.env.MONGODB_URI)("mongoMatchStore (real Mongo)", () => {
  it("runs the spatial queries server-side over the boot 2dsphere indexes", async () => {
    const { getDb, closeDb, COLLECTIONS } = await import("../src/db/client.ts");
    const { mongoStore } = await import("../src/store.ts");
    const db = await getDb(loadConfig());
    const store = mongoStore(db);
    const t = Date.now();
    const testDocs = {
      hazard: smokeHazard(3, "hms-match:test", t),
      shelter: { ...shelter(t, t - 5 * 60_000), sourceId: "seed-match-test" },
      road: { ...road(t, t - 5 * 60_000, "flooded"), cameraId: "wsdot-match-test" },
    };
    await store.upsertHazard(testDocs.hazard);
    await store.upsertResource(testDocs.shelter);
    await store.upsertRoad(testDocs.road);
    try {
      const match = mongoMatchStore(db);
      const point = { type: "Point" as const, coordinates: SEATTLE };
      const active = await match.intersectingHazards(point, t);
      expect(active.map((h) => h.sourceId)).toContain("hms-match:test");
      const nearest = await match.nearestOpenResource(point, t);
      expect(nearest?.sourceId).toBe("seed-match-test");
      expect(nearest!.distanceKm).toBeLessThan(3);
      const roads = await match.blockedRoadsNear(point, t, 3);
      expect(roads.map((r) => r.cameraId)).toContain("wsdot-match-test");
    } finally {
      await db.collection(COLLECTIONS.hazards).deleteMany({ sourceId: "hms-match:test" });
      await db.collection(COLLECTIONS.resources).deleteMany({ sourceId: "seed-match-test" });
      await db.collection(COLLECTIONS.roads).deleteMany({ cameraId: "wsdot-match-test" });
      await closeDb();
    }
  });
});
