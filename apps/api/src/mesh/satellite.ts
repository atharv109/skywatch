import type { Config } from "../config.ts";
import type { AppDeps } from "../deps.ts";
import type { Fetcher } from "../ingest/nws.ts";
import { fetchNwsAlerts, normalizeNwsAlerts } from "../ingest/nws.ts";
import { fetchSmokeFeatures, normalizeSmokeFeatures, type SmokeFeature } from "../ingest/smoke.ts";
import { fetchAqiObservation, normalizeAqi } from "../ingest/aqi.ts";
import type { HazardDoc } from "../types/docs.ts";
import type { SatelliteSection } from "./types.ts";

/**
 * Task 8e SATELLITE OVERLAY ("when one node gets signal, the mesh gets the
 * satellite picture"): at gateway sync, LIVE-fetch the gateway area's
 *   (a) NOAA HMS smoke plumes — the existing ArcGIS GeoJSON query in ingest/smoke.ts,
 *   (b) NWS active alerts by point — ingest/nws.ts,
 *   (c) AirNow (key) or Open-Meteo AQI current obs — ingest/aqi.ts.
 * GATING: only when SKYWATCH_LIVE_SYNC=1 (default 0 — tests hermetic +
 * offline-deterministic). REPLAY does NOT gate this: replay=1 still fetches live
 * when the knob is on (the ingests are called without their own replay flag).
 *
 * ALL-OR-NOTHING: a 5 s fetch timeout on every remote call, all three sources in
 * parallel, ANY failure -> the whole section is omitted (the bundle must never
 * block, and must never half-arrive). Normalization reuses the exact ingest
 * normalizers, so the same HazardDocs the scenario pipeline produces — dashboards
 * and future briefs gain the data via the upsert the fetcher performs.
 */

export const SAT_BBOX_RADIUS_DEG = 0.5;
export const SAT_FETCH_TIMEOUT_MS = 5_000;
export const SAT_PLUMES_CAP = 25;
export const SAT_ALERTS_CAP = 10;

/** A flat GeoJSON geometry walked down to its coordinate extremes (polygon bbox). */
function positionsRange(geometry: unknown): { minLon: number; maxLon: number; minLat: number; maxLat: number } | null {
  const range = { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity };
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    const first = node[0];
    if (typeof first === "number" && typeof node[1] === "number") {
      range.minLon = Math.min(range.minLon, first);
      range.maxLon = Math.max(range.maxLon, first);
      range.minLat = Math.min(range.minLat, node[1]);
      range.maxLat = Math.max(range.maxLat, node[1]);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(geometry);
  return range.minLon === Infinity ? null : range;
}

function intersectsBbox(
  geometry: { type: string; coordinates: unknown } | null,
  bbox: { minLon: number; maxLon: number; minLat: number; maxLat: number },
): boolean {
  if (!geometry) return false;
  const range = positionsRange((geometry as { coordinates?: unknown }).coordinates);
  if (!range) return false;
  return range.minLon <= bbox.maxLon && range.maxLon >= bbox.minLon && range.minLat <= bbox.maxLat && range.maxLat >= bbox.minLat;
}

export function bboxAround(lat: number, lon: number): { minLon: number; maxLon: number; minLat: number; maxLat: number } {
  return { minLon: lon - SAT_BBOX_RADIUS_DEG, maxLon: lon + SAT_BBOX_RADIUS_DEG, minLat: lat - SAT_BBOX_RADIUS_DEG, maxLat: lat + SAT_BBOX_RADIUS_DEG };
}

export interface SatelliteFetch {
  section: SatelliteSection;
  hazards: HazardDoc[];
}

/**
 * One all-or-nothing satellite snapshot for a gateway point. Returns null when any
 * source fails/times out — the section is then simply ABSENT from the bundle.
 */
export async function fetchSatelliteSection(
  point: { lat: number; lon: number },
  now = Date.now(),
  injFetcher?: Fetcher,
  airnowApiKey: string | null = null,
): Promise<SatelliteFetch | null> {
  const doFetch: Fetcher =
    injFetcher ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(SAT_FETCH_TIMEOUT_MS) }));
  try {
    const [plumes, alertsPayload, obs] = await Promise.all([
      // Live only, whatever REPLAY says (SKYWATCH_LIVE_SYNC is the only gate).
      // One page of 2000 plumes is enough to cover the bbox at demo scale and
      // bounds the whole snapshot to one 5 s timeout per source (runs in parallel).
      fetchSmokeFeatures({ fetcher: doFetch, maxPages: 1, pageSize: 2000 }),
      fetchNwsAlerts(point, { fetcher: doFetch }),
      // AIRNOW_API_KEY wired from the config (fetchAqiObservation falls back to
      // Open-Meteo when null — the previous hardcoded behavior, no crash either way).
      fetchAqiObservation(point, { fetcher: doFetch, airnowApiKey }),
    ]);
    const bbox = bboxAround(point.lat, point.lon);
    const plumeHits = plumes.filter((f) => intersectsBbox(f.geometry, bbox)).slice(0, SAT_PLUMES_CAP);
    const alertHits = alertsPayload.features.filter((f) => intersectsBbox(f.geometry, bbox)).slice(0, SAT_ALERTS_CAP);
    const plumeHazards = normalizeSmokeFeatures(plumeHits);
    // Normalize exactly what the section carries (never upsert more than the bundle returns).
    const alertHazards = normalizeNwsAlerts({ ...alertsPayload, features: alertHits });
    const aqiHazard = obs ? normalizeAqi(obs) : null;
    return {
      hazards: [...plumeHazards, ...alertHazards, ...(aqiHazard ? [aqiHazard] : [])],
      section: {
        fetchedAt: now,
        plumes: plumeHits,
        alerts: alertHits,
        aqi: obs,
      },
    };
  } catch (err) {
    console.error("satellite fetch failed (section omitted):", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * The sync-path satellite seam: undefined-shaped behavior is encoded here — the
 * returned fn returns null (section omitted) whenever SKYWATCH_LIVE_SYNC is unset,
 * and otherwise fetches + upserts the normalized hazards into the app store. The
 * test seam is `fetcher` (undefined = real fetch with the 5 s timeout).
 */
export function makeSatelliteFetcher(
  config: Config,
  deps: Pick<AppDeps, "store">,
  injFetcher?: Fetcher,
): (lat: number, lon: number, now: number) => Promise<SatelliteSection | null> {
  if (!config.liveSync) return () => Promise.resolve(null);
  return async (lat, lon, now) => {
    const out = await fetchSatelliteSection({ lat, lon }, now, injFetcher, config.airnowApiKey);
    if (!out) return null;
    const store = await deps.store(config);
    for (const doc of out.hazards) await store.upsertHazard(doc);
    return out.section;
  };
}