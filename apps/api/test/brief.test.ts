import { describe, expect, it } from "vitest";
import { ACTION_TEXT, MAX_ACTIONS, RULES, selectActions } from "../src/brief/rules.ts";
import { assembleBrief, buildUserBrief, EMERGENCY_LINE, timingText } from "../src/brief/build.ts";
import { memoryMatchStore, ROAD_RADIUS_KM, type MatchedResource, type MatchedRoad } from "../src/match/store.ts";
import { haversineKm, pointInGeometry } from "../src/match/geo.ts";
import { memoryStore } from "../src/store.ts";
import { confidenceFor, halfLifeMinutes } from "../src/confidence.ts";
import type { UserBrief } from "../src/types/brief.ts";
import type { HazardDoc, Point, ResourceDoc, RoadDoc } from "../src/types/docs.ts";

const NOW = Date.parse("2026-10-18T01:00:00.000Z");

/** Downtown Seattle demo point (inside the flood demo polygon + smoke plumes). */
const SEATTLE: [number, number] = [-122.335, 47.605];

function smokeHazard(severity: number, sourceId = "hms-smoke:test"): HazardDoc {
  return {
    sourceId,
    type: "smoke",
    severity,
    title: `Smoke plume (heavy) — test ${severity}`,
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
    validFrom: NOW - 3_600_000,
    validTo: NOW + 12 * 3_600_000,
    source: "test",
  };
}

function shelterDoc(overrides: Partial<ResourceDoc> = {}): ResourceDoc {
  return {
    sourceId: "seed-shelter-1",
    kind: "shelter",
    name: "Test Shelter",
    hours: "24/7",
    partner: true,
    status: "open",
    verifiedAt: NOW - 10 * 60_000,
    loc: { type: "Point", coordinates: [-122.34, 47.61] },
    ...overrides,
  };
}

function roadDoc(overrides: Partial<RoadDoc> = {}): RoadDoc {
  return {
    cameraId: "wsdot-9800",
    name: "SR 99 demo",
    loc: { type: "Point", coordinates: [-122.34, 47.6] },
    status: "flooded",
    verifiedAt: NOW - 5 * 60_000,
    imageUrl: "https://images.example/test.jpg",
    ...overrides,
  };
}

describe("rules.ts rule table", () => {
  it("every table action id has English text and is kebab-case", () => {
    const ids: string[] = [];
    for (const rule of RULES) {
      expect(rule.minSeverity).toBeGreaterThanOrEqual(1);
      expect(rule.maxSeverity).toBeLessThanOrEqual(4);
      expect(rule.minSeverity).toBeLessThanOrEqual(rule.maxSeverity);
      ids.push(...rule.actions);
    }
    for (const id of new Set(ids)) {
      expect(ACTION_TEXT[id], id).toBeTruthy();
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("alert severity 1-2 stays informational; 3-4 becomes actionable", () => {
    const low = selectActions([{ type: "alert", severity: 2 }]);
    expect(low.map((a) => a.id)).toEqual(["monitor-news", "check-on-people"]);
    const high = selectActions([{ type: "alert", severity: 3 }]);
    expect(high.map((a) => a.id)).toContain("follow-official-orders");
  });

  it("smoke severity 3 leads with close windows, mask outside, check neighbors", () => {
    const actions = selectActions([{ type: "smoke", severity: 3 }]);
    expect(actions.map((a) => a.id).slice(0, 3)).toEqual(["close-windows", "mask-if-outside", "check-on-neighbors"]);
    expect(actions.every((a) => a.text.length > 0)).toBe(true);
  });

  it("dedupes across hazards worst-first and caps at 5", () => {
    const actions = selectActions([
      { type: "flood", severity: 4 },
      { type: "smoke", severity: 2 },
      { type: "aqi", severity: 1 },
      { type: "alert", severity: 1 },
    ]);
    expect(actions).toHaveLength(MAX_ACTIONS);
    expect(new Set(actions.map((a) => a.id)).size).toBe(MAX_ACTIONS);
    // worst hazard (flood 4) leads; the smoke-2 informational actions fill the remaining slots
    expect(actions.map((a) => a.id)).toEqual([
      "avoid-floodwater",
      "move-upstairs",
      "get-ready-to-move",
      "close-windows",
      "reduce-outdoor-activity",
    ]);
  });
});

describe("assembleBrief (pure)", () => {
  const inputs = {
    userId: "u-1",
    lang: "en" as const,
    hazards: [smokeHazard(3), smokeHazard(1, "hms-smoke:light")],
    nearest: { ...shelterDoc(), distanceKm: 1.234 } as MatchedResource,
    roads: [
      { ...roadDoc(), distanceKm: 0.4 },
      { ...roadDoc({ cameraId: "wsdot-9999", name: "Far Road" }), distanceKm: 2.8 },
    ],
    now: NOW,
  };

  it("matches the types/brief.ts contract exactly (structural golden)", () => {
    const brief = assembleBrief(inputs);
    expect(Object.keys(brief).sort()).toEqual(["actions", "blockedRoads", "emergency", "hazards", "lang", "officialSource", "shelter", "userId"]);
    expect(brief.hazards[0]).toMatchObject({ type: "smoke", severity: 3, title: "Smoke plume (heavy) — test 3" });
    expect(Object.keys(brief.hazards[0]!).sort()).toEqual(["severity", "timing", "title", "type", "validFrom", "validTo"]);
    expect(Object.keys(brief.actions[0]!).sort()).toEqual(["id", "text"]);
    expect(Object.keys(brief.shelter!).sort()).toEqual(["confidence", "distanceKm", "hours", "id", "name", "status", "verifiedMinutesAgo"]);
    expect(Object.keys(brief.blockedRoads[0]!).sort()).toEqual(["cameraId", "confidence", "name", "status"]);
    expect(Object.keys(brief.officialSource).sort()).toEqual(["name", "url"]);
    brief.hazards.forEach((h) => expect(typeof h.validFrom).toBe("number"));
    // Golden snapshot: any change to the locked brief JSON shape fails here too.
    expect(brief).toMatchSnapshot();
  });

  it("hazards ordered worst-first; timing from validFrom/validTo ('now through tonight' inside 12 h)", () => {
    const brief = assembleBrief(inputs);
    expect(brief.hazards.map((h) => h.severity)).toEqual([3, 1]);
    expect(brief.hazards[0]!.timing).toBe("now through tonight");
    const later = assembleBrief({
      ...inputs,
      hazards: [smokeHazard(3)],
    }).hazards[0]!;
    expect(timingText(NOW, NOW + 3 * 24 * 3_600_000, NOW)).toMatch(/^now through \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(later.timing).toBe("now through tonight");
  });

  it("decay decays by verifiedAt: fresh shelter is open, verified minutes ago set by age", () => {
    const brief = assembleBrief(inputs);
    expect(brief.shelter!.status).toBe("open");
    expect(brief.shelter!.confidence).toBeCloseTo(Math.pow(0.5, 10 / halfLifeMinutes.shelter), 2);
    expect(brief.shelter!.verifiedMinutesAgo).toBe(10);
    expect(brief.shelter!.distanceKm).toBeCloseTo(1.2, 1);
  });

  it("expired shelter -> brief.confidence below floor means no shelter and nothing claims it", () => {
    const brief = assembleBrief({
      ...inputs,
      nearest: { ...shelterDoc({ verifiedAt: NOW - 2 * halfLifeMinutes.shelter * 60_000 }), distanceKm: 1 },
    });
    expect(confidenceFor("shelter", NOW - 2 * halfLifeMinutes.shelter * 60_000, NOW)).toBeLessThan(0.5);
    expect(brief.shelter).toBeNull();
  });

  it("never-verified resource cannot claim an open status (verifiedAt null)", () => {
    const brief = assembleBrief({ ...inputs, nearest: { ...shelterDoc({ verifiedAt: null }), distanceKm: 0.2 } });
    expect(brief.shelter).toBeNull();
  });

  it("no hazard -> brief with officialSource only, no actions, no shelter", () => {
    const brief = assembleBrief({ ...inputs, hazards: [], nearest: null, roads: [] });
    expect(brief.actions).toEqual([]);
    expect(brief.blockedRoads).toEqual([]);
    expect(brief.shelter).toBeNull();
    expect(brief.officialSource.name).toBe("National Weather Service");
    expect(brief.emergency).toBe(EMERGENCY_LINE);
  });

  it("blocked roads sorted by distance and capped at 2 with road-half-life confidence", () => {
    const brief = assembleBrief({
      ...inputs,
      roads: [0.1, 0.2, 0.3, 0.4].map((distanceKm, i) => ({ ...roadDoc({ cameraId: `cam-${i}` }), distanceKm })),
    });
    expect(brief.blockedRoads).toHaveLength(2); // cap
    brief.blockedRoads.forEach((r) => expect(r.status === "flooded" || r.status === "blocked").toBe(true));
    expect(brief.blockedRoads[0]!.cameraId).toBe("cam-0");
  });

  it("official source follows the worst hazard type (flood -> county, smoke -> NWS/AirNow)", () => {
    const flood = assembleBrief({
      ...inputs,
      hazards: [smokeHazard(3, "hms-smoke:a"), { ...smokeHazard(3, "flood-demo:x"), type: "flood" as const }],
    });
    expect(flood.officialSource.name).toMatch(/county/i);
    expect(assembleBrief({ ...inputs, hazards: [] }).officialSource.name).toBe("National Weather Service");
  });
});

describe("match geo + memory store (pure, no Mongo)", () => {
  const store = memoryStore();

  it("haversine sanity: 1 degree of latitude is ~111 km", () => {
    expect(haversineKm([0, 0], [0, 1])).toBeCloseTo(111.2, 0);
  });

  it("pointInGeometry: polygon ring, holes exclude, multipolygon works, expired geometry never read here", () => {
    const withHole = {
      type: "Polygon",
      coordinates: [
        [
          [-124, 46],
          [-120, 46],
          [-120, 49],
          [-124, 49],
          [-124, 46],
        ],
        [
          [-123, 47],
          [-121, 47],
          [-121, 48],
          [-123, 48],
          [-123, 47],
        ],
      ],
    };
    expect(pointInGeometry(SEATTLE, withHole)).toBe(false); // inside the hole
    expect(pointInGeometry([-123.5, 46.5], withHole)).toBe(true);
    expect(
      pointInGeometry([-123.5, 46.5], {
        type: "MultiPolygon",
        coordinates: [[
          [
            [-125, 45],
            [-123, 45],
            [-123, 47],
            [-125, 47],
            [-125, 45],
          ],
        ]],
      }),
    ).toBe(true);
    expect(pointInGeometry(SEATTLE, { type: "LineString", coordinates: [[-123, 47], [-121, 47]] })).toBe(false);
  });

  it("memoryMatchStore: active hazard in window; expired/out-of-window excluded", async () => {
    const match = memoryMatchStore(store);
    await store.upsertHazard(smokeHazard(3));
    await store.upsertHazard({ ...smokeHazard(2, "hms-smoke:old"), validTo: NOW - 1 });
    await store.upsertHazard({ ...smokeHazard(2, "hms-smoke:future"), validFrom: NOW + 1 });

    const active = await match.intersectingHazards({ type: "Point", coordinates: SEATTLE }, NOW);
    expect(active.map((h) => h.sourceId)).toEqual(["hms-smoke:test"]);
    // A point outside the plume gets nothing
    expect(await match.intersectingHazards({ type: "Point", coordinates: [0, 0] }, NOW)).toHaveLength(0);
  });

  it("memoryMatchStore: nearest open shelter within half-life wins; below half-life -> null", async () => {
    await store.upsertResource(shelterDoc());
    await store.upsertResource(shelterDoc({ sourceId: "seed-shelter-2", name: "Nearer", verifiedAt: NOW - 5 * 60_000, loc: { type: "Point", coordinates: [-122.336, 47.606] } }));
    const match = memoryMatchStore(store);
    const nearest = await match.nearestOpenResource({ type: "Point", coordinates: SEATTLE }, NOW);
    expect(nearest?.name).toBe("Nearer");
    expect(nearest!.distanceKm).toBeLessThan(0.2);

    const expired = NOW - (halfLifeMinutes.shelter + 1) * 60_000;
    // both shelters must decay below the floor for the empty set
    await store.upsertResource(shelterDoc({ verifiedAt: expired }));
    await store.upsertResource(shelterDoc({ sourceId: "seed-shelter-2", verifiedAt: expired }));
    expect(await match.nearestOpenResource({ type: "Point", coordinates: SEATTLE }, NOW)).toBeNull();
  });

  it("memoryMatchStore: blocked roads within 3 km sorted by distance, capped at 2; expired or far excluded", async () => {
    const roadStore = memoryStore();
    await roadStore.upsertRoad(roadDoc());
    await roadStore.upsertRoad(roadDoc({ cameraId: "cam-near", name: "Near Rd", verifiedAt: NOW - 14 * 60_000, loc: { type: "Point", coordinates: [-122.336, 47.6051] } }));
    await roadStore.upsertRoad(roadDoc({ cameraId: "cam-mid", name: "Mid Rd", loc: { type: "Point", coordinates: [-122.34, 47.7] } }));
    await roadStore.upsertRoad(roadDoc({ cameraId: "cam-far", name: "Far Rd", loc: { type: "Point", coordinates: [-123.8, 47.6] } })); // > 3 km
    await roadStore.upsertRoad(roadDoc({ cameraId: "cam-clear", name: "Clear Rd", status: "clear" }));
    await roadStore.upsertRoad(roadDoc({ cameraId: "cam-unknown", name: "Unverified Rd", status: "unknown", verifiedAt: null })); // confidence 0

    const match = memoryMatchStore(roadStore);
    const roads = await match.blockedRoadsNear({ type: "Point", coordinates: SEATTLE }, NOW, ROAD_RADIUS_KM);
    expect(roads.map((r: MatchedRoad) => r.cameraId)).toEqual(["cam-near", "wsdot-9800"]); // sorted by distance, capped 2
    expect(roads[0]!.distanceKm).toBeLessThan(roads[1]!.distanceKm);
  });
});

describe("buildUserBrief over an in-memory match store", () => {
  it("assembles the same brief as the pure path (shelter + roads + actions)", async () => {
    const store = memoryStore();
    await store.upsertHazard(smokeHazard(3));
    await store.upsertResource(shelterDoc());
    const match = memoryMatchStore(store);
    const brief = await buildUserBrief(match, { id: "u-1", lang: "es", loc: { type: "Point", coordinates: SEATTLE } }, NOW);
    expect(brief).toBeTypeOf("object");
    expect((brief as UserBrief).lang).toBe("es");
    expect((brief as UserBrief).shelter!.name).toBe("Test Shelter");
    expect((brief as UserBrief).actions).toHaveLength(4);
    expect((brief as UserBrief).hazards[0]!.timing).toBe("now through tonight");
  });
});