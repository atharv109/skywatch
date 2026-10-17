import type { Fetcher } from "./nws.ts";
import type { HazardDoc } from "../types/docs.ts";
import { severityFromDensity } from "./severity.ts";
import { readFixture } from "./fixtureio.ts";

/**
 * NOAA HMS smoke plumes (verified 2026-10-17, skywatch-notes/data-sources-report.md §3).
 * The dead `/OMSPSM/` tree in the brief is replaced by NOAA's live ArcGIS FeatureService
 * (GeoJSON, no key) — also the backend of fire.airnow.gov. Gotchas baked in:
 * - the service name's parentheses MUST be URL-encoded `%28v1%29` or the request 404s;
 * - `properties.exceededTransferLimit: true` means more pages exist; paginate with `resultOffset`;
 * - `Start`/`End_` are NOAA day-of-year times, `2026290 1200` = day 290 of 2026, 12:00 UTC.
 */

export const HMS_SERVICE_URL =
  "https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_%28v1%29/FeatureServer/0/query";

export interface SmokeFeature {
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}

export interface SmokePayload {
  type: string;
  features: SmokeFeature[];
  properties?: { exceededTransferLimit?: boolean } | null;
}

/** NOAA day-of-year time (`2020255 1610`) -> epoch ms UTC. */
export function parseDoyTime(raw: string): number {
  const m = /^(\d{4})(\d{3}) (\d{4})$/.exec(raw.trim());
  if (!m) throw new Error(`Bad HMS day-of-year time: "${raw}"`);
  const year = Number(m[1]);
  const doy = Number(m[2]);
  const hh = Number(m[3]!.slice(0, 2));
  const mm = Number(m[3]!.slice(2, 4));
  return Date.UTC(year, 0, doy, hh, mm);
}

/**
 * Live query, paginated. `maxPages` caps the work; a 5,000-feature page is the
 * server max (`exceededTransferLimit`), 2-3 pages typically cover the CONUS.
 */
export async function fetchSmokeFeatures(
  opts: { fetcher?: Fetcher; maxPages?: number; pageSize?: number; replay?: boolean } = {},
): Promise<SmokeFeature[]> {
  // REPLAY=1: the pre-converted Sept 11 2020 HMS plumes from disk (same property
  // names as the live service, so one normalizer serves both).
  if (opts.replay) {
    const fixture = (await readFixture("sept-2020-smoke.geojson")) as SmokePayload;
    return fixture.features ?? [];
  }
  const doFetch = opts.fetcher ?? fetch;
  const pageSize = opts.pageSize ?? 2000;
  const maxPages = opts.maxPages ?? 5;
  const features: SmokeFeature[] = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const url = `${HMS_SERVICE_URL}?where=1%3D1&outFields=*&f=geojson&resultRecordCount=${pageSize}&resultOffset=${offset}`;
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`HMS ArcGIS query failed: HTTP ${res.status}`);
    const body = (await res.json()) as SmokePayload;
    features.push(...body.features);
    if (body.properties?.exceededTransferLimit !== true) break;
    offset += body.features.length;
  }
  return features;
}

/**
 * Normalize HMS smoke polygons. Works for the live ArcGIS service AND for the
 * committed fixture (sept-2020-smoke.geojson, converted from the Sept 11 2020 KML
 * with the same property names Density/Start/End/Satellite).
 *
 * sourceId is derived only from data (satellite + start + density + index within that
 * group), never from list position alone, so re-loading the same fixture file is
 * idempotent even though feature order could change.
 */
export function normalizeSmokeFeatures(features: SmokeFeature[]): HazardDoc[] {
  const docs: HazardDoc[] = [];
  const seenByGroup = new Map<string, number>();
  for (const feature of features) {
    const props = feature.properties ?? {};
    if (feature.geometry === null || feature.geometry === undefined) continue;
    const density = typeof props.Density === "string" ? props.Density : undefined;
    const start = typeof props.Start === "string" ? props.Start : undefined;
    const satellite = typeof props.Satellite === "string" ? props.Satellite : undefined;
    const groupKey = `${satellite ?? ""}:${start ?? ""}:${density ?? ""}`;
    const idx = seenByGroup.get(groupKey) ?? 0;
    seenByGroup.set(groupKey, idx + 1);
    const validFrom = start ? parseDoyTime(start) : Date.now();
    const validTo =
      typeof props.End === "string" ? Math.max(parseDoyTime(props.End), validFrom + 60 * 60 * 1000) : validFrom + 3 * 60 * 60 * 1000;
    docs.push({
      sourceId: `hms-smoke:${satellite ?? ""}:${start ?? String(validFrom)}:${density ?? "Unknown"}:${idx}`,
      type: "smoke",
      severity: severityFromDensity(density),
      title: `Smoke plume (${(density ?? "density unknown").toLowerCase()}) — NOAA HMS`,
      geometry: feature.geometry as HazardDoc["geometry"],
      validFrom,
      validTo,
      source: "NOAA HMS Smoke Mapping",
      extra: { density: density ?? null, satellite: satellite ?? null, start: start ?? null, end: props.End ?? null },
    });
  }
  return docs;
}

