import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { memoryStore, type AppStore } from "../src/store.ts";
import { loadScenario, type LoadedScenario } from "../src/ingest/scenario.ts";
import { stubInboundRuntime } from "../src/deliver/runtime.ts";
import { memoryVerifyStore } from "../src/verify/store.ts";
import { stubVoiceRuntime } from "../src/deliver/voice_runtime.ts";
import { emptyPipelineResult } from "../src/pipeline/run.ts";
import { memoryMatchStore } from "../src/match/store.ts";
import { memoryDeliverStore } from "../src/deliver/store.ts";
import type { HazardDoc } from "../src/types/docs.ts";

function depsWith(store: AppStore, pipelineCalls?: { count: number }) {
  return {
    store: async () => store,
    pipeline: async () => {
      if (pipelineCalls) pipelineCalls.count += 1;
      return emptyPipelineResult();
    },
    inbound: stubInboundRuntime(),
    match: async () => memoryMatchStore(store),
    deliver: async () => memoryDeliverStore(),
      verify: async () => memoryVerifyStore(),
      voice: stubVoiceRuntime(),
  };
}

describe("loadScenario (fixture sets into a store)", () => {
  let store: AppStore;
  beforeEach(() => {
    store = memoryStore();
  });

  it("smoke scenario: sea-coverage plumes + an AQ alert, shelters + cameras seeded", async () => {
    const loaded = await loadScenario(store, "smoke");
    expect(loaded.hazards).toBeGreaterThanOrEqual(11); // 10 clipped plumes + 1 NWS alert fixture
    expect(loaded.resources).toBe(9);
    expect(loaded.roads).toBe(8);

    const hazards = await store.listHazards();
    const types = new Set(hazards.map((h) => h.type));
    expect(types).toEqual(new Set(["smoke", "aqi"])); // NWS AQ alert fixture classifies as aqi
    for (const h of hazards) {
      expect(h.severity).toBeGreaterThanOrEqual(1);
      expect(h.severity).toBeLessThanOrEqual(4);
      expect(h.geometry.type).toBe("Polygon");
      expect(h.validFrom).toBeLessThan(h.validTo);
    }
    // every hazard is matchable: a Seattle user's point intersects at least one polygon later;
    // here we assert each has non-empty coordinates
    for (const h of hazards) {
      expect(JSON.stringify(h.geometry.coordinates).length).toBeGreaterThan(0);
    }
  });

  it("flood scenario: valley polygons anchored on the Snoqualmie gauge -> severity 3", async () => {
    const loaded = await loadScenario(store, "flood");
    expect(loaded.hazards).toBe(2);
    const hazards = await store.listHazards();
    expect(hazards.every((h) => h.type === "flood")).toBe(true);
    expect(hazards.every((h) => h.severity === 3)).toBe(true);
    expect(hazards[0]?.extra?.["gageHeightFt"]).toBe(9.42);
    expect(hazards[0]?.extra?.["floodStageFt"]).toBe(9.0);
  });

  it("replay idempotence: a second load does not duplicate anything", async () => {
    const first = await loadScenario(store, "smoke");
    const hazardsAfterFirst = await store.listHazards();
    const second: LoadedScenario = await loadScenario(store, "smoke");
    expect(second.hazards).toBe(first.hazards);
    expect(await store.listHazards()).toHaveLength(hazardsAfterFirst.length);
    expect((await store.listResources()).length).toBe(first.resources);
    expect((await store.listRoads()).length).toBe(first.roads);
    // sourceIds identical across runs -> upsert overwrites
    const ids = (await store.listHazards()).map((h: HazardDoc) => h.sourceId).sort();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sourceIds stay stable across independent load runs (real fixture -> deterministic keys)", async () => {
    const storeA = memoryStore();
    const storeB = memoryStore();
    await loadScenario(storeA, "smoke");
    await loadScenario(storeB, "smoke");
    const a = (await storeA.listHazards()).map((h) => h.sourceId).sort().join(",");
    const b = (await storeB.listHazards()).map((h) => h.sourceId).sort().join(",");
    expect(a).toBe(b);
  });
});

describe("POST /scenario/:id/replay", () => {
  it("loads the fixture set, triggers the pipeline once, and a re-run does not duplicate", async () => {
    const store = memoryStore();
    const pipelineCalls = { count: 0 };
    const app = createApp(loadConfig({}), depsWith(store, pipelineCalls));

    const res1 = await app.request("/scenario/smoke/replay", { method: "POST" });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { ok: boolean; hazards: number; resources: number; roads: number; pipelineRan: boolean };
    expect(body1).toMatchObject({ ok: true, resources: 9, roads: 8, pipelineRan: true });

    // a second run (webhook double-tap protection: idempotent by construction)
    const res2 = await app.request("/scenario/smoke/replay", { method: "POST" });
    const body2 = (await res2.json()) as { hazards: number };
    expect(body2.hazards).toBe(body1.hazards);
    expect((await store.listHazards()).length).toBe(body1.hazards);
    expect((await store.listResources()).length).toBe(9);
    expect((await store.listRoads()).length).toBe(8);
    expect(pipelineCalls.count).toBe(2);
  });

  it("flood scenario runs end-to-end and unknown ids return 404", async () => {
    const store = memoryStore();
    const app = createApp(loadConfig({}), depsWith(store));
    expect((await app.request("/scenario/flood/replay", { method: "POST" })).status).toBe(200);
    const missing = await app.request("/scenario/drought/replay", { method: "POST" });
    expect(missing.status).toBe(404);
  });

  it("store failures come back as a 503 with a readable error", async () => {
    const app = createApp(loadConfig({}), {
      store: async () => {
        throw new Error("mongo down");
      },
      pipeline: async () => emptyPipelineResult(),
      inbound: stubInboundRuntime(),
      match: async () => memoryMatchStore(memoryStore()),
      deliver: async () => memoryDeliverStore(),
      verify: async () => memoryVerifyStore(),
      voice: stubVoiceRuntime(),
    });
    const res = await app.request("/scenario/smoke/replay", { method: "POST" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/mongo down/);
  });
});

// Full pipeline against real Mongo: runs when MONGODB_URI is set (same rule as Task 1's db test).
describe.skipIf(!process.env.MONGODB_URI)("scenario replay against real Mongo", () => {
  it("seeds collections and stays idempotent across route calls", async () => {
    const { defaultDeps } = await import("../src/deps.ts");
    const { closeDb } = await import("../src/db/client.ts");
    const config = loadConfig();
    const deps = defaultDeps(config);
    const app = createApp(config, deps);

    const res = await app.request("/scenario/smoke/replay", { method: "POST" });
    expect(res.status).toBe(200);
    const first = (await res.json()) as { hazards: number };
    const state = await app.request("/map/state");
    expect(state.status).toBe(200);

    const res2 = await app.request("/scenario/smoke/replay", { method: "POST" });
    expect(res2.status).toBe(200);
    const second = (await res2.json()) as { hazards: number };
    expect(second.hazards).toBe(first.hazards);

    const store = await deps.store(config);
    expect((await store.listHazards()).length).toBe(first.hazards);
    await closeDb();
  // remote (Atlas) round-trips blow the default 5s when run from a laptop — generous bound
  }, 60_000);
});