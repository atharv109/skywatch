import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { assembleMapState, displayedStatus, confidenceFor, halfLifeMinutes, type MapInputs } from "../src/map/state.ts";
import { memoryStore } from "../src/store.ts";
import type { HazardDoc, ResourceDoc, RoadDoc } from "../src/types/docs.ts";
import { seedScenarioBase } from "../src/ingest/scenario.ts";
import { stubInboundRuntime } from "../src/deliver/runtime.ts";

const NOW = Date.UTC(2026, 9, 17, 20, 0);

function hazardDoc(i: number): HazardDoc {
  return {
    sourceId: `flood-demo:12144500:${i}`,
    type: "flood",
    severity: 3,
    title: "demo flood",
    geometry: { type: "Polygon", coordinates: [[[-121.9, 47.6], [-121.8, 47.6], [-121.8, 47.7], [-121.9, 47.6]]] },
    validFrom: NOW - 1,
    validTo: NOW + 1,
    source: "test",
  };
}

const resourceDoc = (verifiedAt: number | null, status: ResourceDoc["status"] = "open"): ResourceDoc => ({
  sourceId: "seed-shelter-1",
  kind: "shelter",
  name: "Test Shelter",
  partner: false,
  status,
  verifiedAt,
  loc: { type: "Point", coordinates: [-122.3, 47.6] },
});

const roadDoc = (verifiedAt: number | null, status: RoadDoc["status"]): RoadDoc => ({
  cameraId: "wsdot-9800",
  name: "SR 99 demo",
  loc: { type: "Point", coordinates: [-122.33, 47.6] },
  status,
  verifiedAt,
  imageUrl: "https://images.wsdot.wa.gov/nw/099vc03098.jpg",
});

describe("assembleMapState (pure)", () => {
  const inputs: MapInputs = {
    hazards: [hazardDoc(0)],
    resources: [resourceDoc(NOW - halfLifeMinutes.shelter * 60_000), resourceDoc(null, "unknown")],
    roads: [roadDoc(NOW - 10 * 60_000, "flooded"), roadDoc(null, "clear")],
    dots: [
      [-122.334981, 47.606214],
      [-122.334981, 47.606214],
    ],
    userCount: 2,
    now: NOW,
  };

  it("decays resource confidence with the shelter (30-min) half-life and rounds to 2 decimals", () => {
    expect(confidenceFor("shelter", null, NOW)).toBe(0);
    expect(confidenceFor("shelter", NOW, NOW)).toBe(1);
    // one shelter half-life = 0.5
    expect(confidenceFor("shelter", NOW - halfLifeMinutes.shelter * 60_000, NOW)).toBeCloseTo(0.5, 5);
    expect(assembleMapState(inputs).resources[0]?.confidence).toBe(0.5);
  });

  it("decays road confidence with the 15-min half-life (half of the shelter decay at the same age)", () => {
    expect(halfLifeMinutes.road).toBe(15);
    expect(halfLifeMinutes.shelter).toBe(30);
    expect(confidenceFor("road", NOW - 10 * 60_000, NOW)).toBeCloseTo(0.63, 2);
    expect(assembleMapState(inputs).roads[0]?.confidence).toBe(0.63);
  });

  it("downgrades open statuses with confidence < 0.5 to unknown (Global Constraint 3 display rule)", () => {
    expect(displayedStatus("open", 0.9)).toBe("open");
    expect(displayedStatus("open", 0.49)).toBe("unknown");
    expect(displayedStatus("unknown", 0.9)).toBe("unknown");
    const state = assembleMapState({ ...inputs, resources: [resourceDoc(NOW - 45 * 60_000)] });
    expect(state.resources[0]?.status).toBe("unknown");
    expect(state.resources[0]?.confidence).toBe(0.35);
  });

  it("review case: 20-min-old road verdict shows unknown at 0.44 while a 20-min-old resource stays open at ~0.63", () => {
    const state = assembleMapState({
      ...inputs,
      resources: [resourceDoc(NOW - 20 * 60_000)],
      roads: [roadDoc(NOW - 20 * 60_000, "flooded")],
    });
    // resource: 0.5^(20/30) = 0.63 >= 0.5 -> status unchanged
    expect(state.resources[0]?.confidence).toBe(0.63);
    expect(state.resources[0]?.status).toBe("open");
    // road: 0.5^(20/15) = 0.397 < 0.5 -> flipped to unknown (same age, different half-life)
    expect(state.roads[0]?.confidence).toBe(0.4);
    expect(state.roads[0]?.status).toBe("unknown");
  });

  it("fresh flooded roads keep their verdict; unverified ones are unknown; clear stays clear", () => {
    const state = assembleMapState(inputs);
    expect(state.roads).toHaveLength(2);
    expect(state.roads[0]?.status).toBe("flooded"); // 10-min-old road verdict = 0.63, above the floor
    expect(state.roads[0]?.cameraId).toBe("wsdot-9800");
    expect(state.roads[1]?.status).toBe("clear");
    const staleBlocked = assembleMapState({ ...inputs, roads: [roadDoc(NOW - 30 * 60_000, "blocked")] });
    expect(staleBlocked.roads[0]?.status).toBe("unknown");
    expect(staleBlocked.roads[0]?.confidence).toBe(0.25);
  });

  it("anonymizes user dots: rounded to ~1 km grid, never ids or phones", () => {
    const state = assembleMapState(inputs);
    expect(state.userDots).toEqual([
      { lat: 47.61, lon: -122.33 },
      { lat: 47.61, lon: -122.33 },
    ]);
    expect(state.briefCount).toBe(2);
    expect(state.generatedAt).toBe(NOW);
    expect(JSON.stringify(state)).not.toMatch(/phone|\+15\d{9}/);
  });
});

describe("GET /map/state + /map/stream (injected store, no Mongo)", () => {
  async function appWithSeed() {
    const store = memoryStore();
    await seedScenarioBase(store);
    await store.upsertHazard(hazardDoc(0));
    return createApp(loadConfig({}), {
      store: async () => store,
      pipeline: async () => undefined,
      inbound: stubInboundRuntime(),
    });
  }

  it("/map/state serves the assembled payload; 9 resources, 8 roads, 1 hazard", async () => {
    const app = await appWithSeed();
    const res = await app.request("/map/state");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hazards: unknown[]; resources: unknown[]; roads: unknown[]; briefCount: number };
    expect(body.hazards).toHaveLength(1);
    expect(body.resources).toHaveLength(9);
    expect(body.roads).toHaveLength(8);
    expect(body.briefCount).toBe(0);
    expect(JSON.stringify(body).toLowerCase()).not.toContain("phone");
  });

  it("/map/state returns 503 when the store is unavailable", async () => {
    const app = createApp(loadConfig({}), {
      store: async () => {
        throw new Error("mongo down");
      },
      pipeline: async () => undefined,
      inbound: stubInboundRuntime(),
    });
    const res = await app.request("/map/state");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/mongo down/);
  });

  it(
    "/map/stream emits an initial full-state event, then a refresh tick, without holding the loop",
    async () => {
      const app = await appWithSeed();
      const ac = new AbortController();
      const res = await app.request("/map/stream", { signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const chunk = new TextDecoder().decode(value ?? new Uint8Array());
      expect(chunk).toContain("event: state");
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
      expect(dataLine).toBeTruthy();
      const state = JSON.parse((dataLine ?? "").slice(5).trim()) as {
        hazards: unknown[];
        resources: unknown[];
        userDots: unknown[];
      };
      expect(state.hazards).toHaveLength(1);
      expect(state.resources).toHaveLength(9);

      // second broadcast on the 5 s refresh cadence, same shape (full-state summary)
      await ac.abort();
      const secondRead = await reader.read();
      const second = new TextDecoder().decode(secondRead.value ?? new Uint8Array());
      if (second.length > 0) {
        expect(second).toContain("event: state");
      }
      await reader.cancel();
    },
    15_000,
  );
});