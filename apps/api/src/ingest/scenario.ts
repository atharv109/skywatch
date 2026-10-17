
import type { HazardDoc, ResourceDoc, RoadDoc } from "../types/docs.ts";
import { normalizeNwsAlerts, type NwsAlertPayload } from "./nws.ts";
import { normalizeSmokeFeatures, type SmokeFeature } from "./smoke.ts";
import { DEMO_GAUGE_SITE, FLOOD_STAGES } from "./river.ts";
import { severityFromGage } from "./severity.ts";
import { readFixture, FIXTURES_DIR } from "./fixtureio.ts";
import { memoryStore, mongoStore, type AppStore } from "../store.ts";
import { getDb } from "../db/client.ts";
import type { Config } from "../config.ts";

/**
 * Fixture sets + replay loading. Idempotent: every doc type upserts by a
 * deterministic key (see store.ts and each normalizer's sourceId), so re-running
 * `POST /scenario/:id/replay` overwrites its own docs instead of duplicating them.
 * Fixture files live in apps/api/fixtures/ (readFixture in fixtureio.ts).
 */

export { FIXTURES_DIR };

export type ScenarioId = "smoke" | "flood";

export interface LoadedScenario {
  scenario: ScenarioId;
  hazards: number;
  resources: number;
  roads: number;
}

/**
 * Time anchor for replayed hazards: the fixtures record the Sept 2020 event, but the
 * match/map pipeline treats hazards as current relative to "now" (Task 4 filters on
 * validTo > now). Replayed hazards therefore get a window of now-1h .. now+12h, while
 * the original 2020 NOAA/NWS times are preserved in `extra`. Re-runs overwrite their
 * own docs (upsert), so this does not affect replay idempotence.
 */
const REPLAY_WINDOW = { beforeMin: 60, afterMin: 720 };

export async function loadScenario(store: AppStore, scenarioId: ScenarioId): Promise<LoadedScenario> {
  const validFrom = Date.now() - REPLAY_WINDOW.beforeMin * 60 * 1000;
  const validTo = Date.now() + REPLAY_WINDOW.afterMin * 60 * 1000;
  let hazards: HazardDoc[];
  if (scenarioId === "smoke") {
    const smoke = (await readFixture("sept-2020-smoke.geojson")) as { features?: SmokeFeature[] };
    const alerts = (await readFixture("nws-alert-sample.json")) as NwsAlertPayload;
    // Replay window overrides source times; the 2020 times stay in `extra`.
    hazards = [...normalizeSmokeFeatures(smoke.features ?? []), ...normalizeNwsAlerts(alerts)].map((doc) => ({
      ...doc,
      validFrom,
      validTo,
    }));
  } else {
    hazards = await buildFloodHazards(validFrom, validTo);
  }
  if (hazards.length === 0) {
    throw new Error(`scenario '${scenarioId}' produced no hazards from fixtures`);
  }
  for (const doc of hazards) {
    await store.upsertHazard(doc);
  }
  const seeded = await seedScenarioBase(store);
  return { scenario: scenarioId, hazards: hazards.length, resources: seeded.resources, roads: seeded.roads };
}

/**
 * Flood scenario: synthetic valley polygons anchored on the Snoqualmie gauge values
 * recorded in the fixture's top-level properties (gauge 12144500: 9.42 ft vs flood stage
 * 9.0 ft -> severity 3 through the same severityFromGage table as the live gauge path,
 * so fixture and live agree on severity).
 */
async function buildFloodHazards(validFrom: number, validTo: number): Promise<HazardDoc[]> {
  // Gauge metadata sits in the FeatureCollection's `properties` (as the real NOAA/USGS
  // GeoJSON feeds do), features carry the valley polygons.
  const flood = (await readFixture("flood-demo.geojson")) as {
    properties?: {
      gaugeSite?: string;
      gaugeName?: string;
      gageHeightFt?: number;
      floodStageFt?: number;
      qualifiers?: string[];
      observed?: string;
    };
    features?: Array<{ geometry?: HazardDoc["geometry"]; properties?: Record<string, unknown> }>;
  };
  const meta = flood.properties ?? {};
  const site = meta.gaugeSite ?? DEMO_GAUGE_SITE;
  const gage = meta.gageHeightFt ?? 0;
  const stage = meta.floodStageFt ?? FLOOD_STAGES[site] ?? 0;
  const severity = severityFromGage(gage, stage);
  if (severity === null) {
    throw new Error("flood fixture gauge reading is below half of flood stage; no flood hazard");
  }
  return (flood.features ?? [])
    .filter((f) => f.geometry !== undefined && f.geometry !== null)
    .map((f, i) => ({
      sourceId: `flood-demo:${site}:${i}`,
      type: "flood" as const,
      severity,
      title: `Skywatch demo flood — ${f.properties?.["area"] ?? "Snoqualmie valley"} (gage ${gage.toFixed(2)} ft, flood stage ${stage})`,
      geometry: f.geometry as HazardDoc["geometry"],
      validFrom,
      validTo,
      source: "USGS gauge (demo fixture)",
      extra: {
        gaugeSite: site,
        gaugeName: meta.gaugeName ?? null,
        gageHeightFt: gage,
        floodStageFt: stage,
        observed: meta.observed ?? null,
        qualifiers: meta.qualifiers ?? ["P"],
      },
    }));
}

/**
 * Seed/demo POIs + cameras (idempotent, used by every scenario and by seed-on-boot):
 * shelters into resources, cameras into roads. Entries carry status "unknown" +
 * verifiedAt null -> confidence 0 until Task 6 check-ins; the 30/15-min half-life decay
 * is computed at read time, so these stay "unknown" by construction.
 */
export async function seedScenarioBase(store: AppStore): Promise<{ resources: number; roads: number }> {
  const shelters = (await readFixture("shelters-seed.geojson")) as {
    features?: Array<{
      geometry?: { type: string; coordinates: [number, number] };
      properties?: Record<string, unknown>;
    }>;
  };
  let resourceCount = 0;
  for (const f of shelters.features ?? []) {
    const props = f.properties ?? {};
    const coords = f.geometry?.coordinates;
    if (f.geometry?.type !== "Point" || !coords || props.sourceId === undefined) continue;
    const doc: ResourceDoc = {
      sourceId: String(props.sourceId),
      kind: (props.kind as ResourceDoc["kind"]) ?? "shelter",
      name: String(props.name ?? "Unnamed"),
      address: typeof props.address === "string" ? props.address : undefined,
      hours: typeof props.hours === "string" ? props.hours : undefined,
      partner: props.partner === true,
      status: "unknown",
      verifiedAt: null,
      loc: { type: "Point", coordinates: coords },
    };
    await store.upsertResource(doc);
    resourceCount += 1;
  }
  const cameras = (await readFixture("cameras.json")) as {
    cameras?: Array<{
      CameraID: number;
      Title: string | null;
      Region: string | null;
      CameraLocation: { Direction: string | null; RoadName: string | null; Latitude: number; Longitude: number } | null;
      ImageURL: string;
      IsActive: boolean;
    }>;
  };
  let roadCount = 0;
  for (const cam of cameras.cameras ?? []) {
    const loc = cam.CameraLocation;
    if (!loc) continue;
    const doc: RoadDoc = {
      cameraId: `wsdot-${cam.CameraID}`,
      name: cam.Title ?? loc.RoadName ?? `Camera ${cam.CameraID}`,
      roadName: loc.RoadName ?? undefined,
      direction: loc.Direction ?? undefined,
      loc: { type: "Point", coordinates: [loc.Longitude, loc.Latitude] },
      status: "unknown",
      verifiedAt: null,
      imageUrl: cam.ImageURL,
      region: cam.Region ?? undefined,
      isActive: cam.IsActive,
    };
    await store.upsertRoad(doc);
    roadCount += 1;
  }
  return { resources: resourceCount, roads: roadCount };
}

/**
 * Seed-on-boot: with REPLAY=1 and no resources in Mongo yet, load the demo POIs +
 * cameras (no hazards — scenarios own those). Returns null when skipped.
 */
export async function seedOnBoot(config: Config): Promise<{ seeded: boolean } | null> {
  if (!config.replay) return null;
  const db = await getDb(config);
  const store = mongoStore(db);
  const existing = await store.listResources();
  if (existing.length > 0) return null;
  await seedScenarioBase(store);
  return { seeded: true };
}

export function defaultStore(config: Config): Promise<AppStore> {
  return getDb(config).then(mongoStore);
}

export { memoryStore, mongoStore };
export type { AppStore };