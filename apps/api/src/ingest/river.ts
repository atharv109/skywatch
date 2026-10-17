import type { Fetcher } from "./nws.ts";
import type { HazardDoc } from "../types/docs.ts";
import { severityFromGage } from "./severity.ts";
import { readFixture } from "./fixtureio.ts";

/** Verified gauge coordinates (from the live USGS response, 2026-10-17) for the replay path. */
export const GAUGE_COORDS: Record<string, [number, number]> = {
  // [lon, lat] — SNOQUALMIE RIVER NEAR SNOQUALMIE, WA
  "12144500": [-121.8423157, 47.5450765],
};

interface FloodFixturePayload {
  properties?: FloodFixtureMeta;
}

interface FloodFixtureMeta {
  gaugeSite?: string;
  gaugeName?: string;
  gageHeightFt?: number;
  floodStageFt?: number;
  qualifiers?: string[];
  observed?: string;
}

/**
 * USGS Instantaneous Values, gage height (verified 2026-10-17, data-sources-report.md §4):
 *   https://waterservices.usgs.gov/nwis/iv/?format=json&sites=<ids>&parameterCd=00065&siteStatus=active
 * - parameterCd 00065 = gage height in feet (00060 would be discharge).
 * - WaterML-shaped JSON: value.timeSeries[].values[].value[] — each reading carries
 *   `qualifiers: ["P"]` (provisional). We keep PROVISIONAL (`P`) readings only.
 * - Readings are 15/30-min cadence; only the newest qualifying reading per site is used.
 *
 * FLOOD_STAGES assumption (verify before any real use — not verified against NWS AHPS):
 * the demo gauge 12144500 (SNOQUALMIE RIVER NEAR SNOQUALMIE, WA) uses flood stage 9.0 ft;
 * the fixture flood-demo.geojson is anchored on these same values so the replay and the
 * live path agree. Gauge heights are site-specific — never reuse a stage across sites.
 */
export const FLOOD_STAGES: Record<string, number> = {
  "12144500": 9.0,
};

export const DEMO_GAUGE_SITE = "12144500";

export interface GaugeReading {
  siteId: string;
  siteName: string;
  lat: number;
  lon: number;
  /** gage height, feet (parameterCd 00065) */
  gageHeightFt: number;
  qualifiers: string[];
  /** epoch ms */
  observedMs: number;
}

interface UsgsPayload {
  value?: {
    timeSeries?: TimeSeriesEntry[];
  };
}

interface TimeSeriesEntry {
  sourceInfo?: {
    siteName?: string;
    siteCode?: Array<{ value?: string }>;
    geoLocation?: { geogLocation?: { latitude?: number; longitude?: number } };
  };
  variable?: { variableCode?: Array<{ value?: string }> };
  values?: Array<{ value?: ValueEntry[] }>;
}

interface ValueEntry {
  value?: string;
  qualifiers?: string[];
  dateTime?: string;
}

export async function fetchGaugeReadings(
  siteIds: string[],
  opts: { fetcher?: Fetcher; replay?: boolean } = {},
): Promise<GaugeReading[]> {
  // REPLAY=1: derive the recorded Snoqualmie gauge reading from the flood fixture.
  if (opts.replay) {
    const fixture = (await readFixture("flood-demo.geojson")) as FloodFixturePayload;
    const meta = fixture.properties ?? {};
    const observed = meta.observed ? Date.parse(meta.observed) : Date.now();
    const siteId = meta.gaugeSite ?? DEMO_GAUGE_SITE;
    const geo = GAUGE_COORDS[siteId];
    if (meta.gageHeightFt === undefined) return [];
    if (geo === undefined) return [];
    return [
      {
        siteId,
        siteName: meta.gaugeName ?? siteId,
        lat: geo[1],
        lon: geo[0],
        gageHeightFt: meta.gageHeightFt,
        qualifiers: meta.qualifiers ?? ["P"],
        observedMs: Number.isFinite(observed) ? observed : Date.now(),
      },
    ];
  }
  const doFetch = opts.fetcher ?? fetch;
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${siteIds.join(",")}&parameterCd=00065&siteStatus=active`;
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`USGS IV fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as UsgsPayload;
  const out: GaugeReading[] = [];
  for (const series of body.value?.timeSeries ?? []) {
    const reading = latestProvisional(series);
    if (reading) out.push(reading);
  }
  return out;
}

/** Newest reading whose qualifiers include "P" (provisional). Non-P readings are skipped, not errored. */
export function latestProvisional(series: TimeSeriesEntry): GaugeReading | null {
  const siteCode = series.sourceInfo?.siteCode?.find((c) => c.value)?.value;
  const geo = series.sourceInfo?.geoLocation?.geogLocation;
  if (!siteCode || !geo) return null;
  const candidates = (series.values ?? []).flatMap((v) => v.value ?? []).filter((v) => v.qualifiers?.includes("P"));
  const newest = candidates
    .map((v) => ({ raw: v, ms: v.dateTime ? Date.parse(v.dateTime) : Number.NaN }))
    .filter((v) => Number.isFinite(v.ms))
    .sort((a, b) => b.ms - a.ms)[0];
  const gage = newest?.raw.value !== undefined ? Number(newest.raw.value) : Number.NaN;
  if (!newest || !Number.isFinite(gage)) return null;
  return {
    siteId: siteCode,
    siteName: series.sourceInfo?.siteName ?? siteCode,
    lat: geo.latitude ?? Number.NaN,
    lon: geo.longitude ?? Number.NaN,
    gageHeightFt: gage,
    qualifiers: newest.raw.qualifiers ?? [],
    observedMs: newest.ms,
  };
}

/**
 * Normalize gauge readings into "flood" hazards. Geometry is a small square around the
 * gauge (~2 km) — a point would not intersect anything in match; the demo flood polygons
 * in fixtures/flood-demo.geojson remain the visual/valley representation. Sites without a
 * threshold in FLOOD_STAGES produce no hazard.
 */
export function normalizeGaugeReadings(readings: GaugeReading[]): HazardDoc[] {
  const docs: HazardDoc[] = [];
  for (const reading of readings) {
    const floodStage = FLOOD_STAGES[reading.siteId];
    if (floodStage === undefined) continue;
    const severity = severityFromGage(reading.gageHeightFt, floodStage);
    if (severity === null) continue;
    const half = 0.02;
    docs.push({
      sourceId: `usgs-gage:${reading.siteId}:${reading.observedMs}`,
      type: "flood",
      severity,
      title: `${reading.siteName}: gage ${reading.gageHeightFt.toFixed(2)} ft (flood stage ${floodStage})`,
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [reading.lon - half, reading.lat - half],
            [reading.lon + half, reading.lat - half],
            [reading.lon + half, reading.lat + half],
            [reading.lon - half, reading.lat + half],
            [reading.lon - half, reading.lat - half],
          ],
        ],
      },
      // The observation is 15/30-min cadence; give the hazard a 12 h window so it stays
      // visible on the map between cycles without pretending the river dropped.
      validFrom: reading.observedMs,
      validTo: reading.observedMs + 12 * 60 * 60 * 1000,
      source: "USGS Instantaneous Values",
      extra: { gageHeightFt: reading.gageHeightFt, floodStageFt: floodStage, siteId: reading.siteId },
    });
  }
  return docs;
}