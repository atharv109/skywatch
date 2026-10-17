import { severityFromAqi } from "./severity.ts";
import type { GeoPoint, Fetcher } from "./nws.ts";
import type { HazardDoc } from "../types/docs.ts";
import { readFixture } from "./fixtureio.ts";

/**
 * Air quality observations (verified 2026-10-17, skywatch-notes/data-sources-report.md §2).
 * AirNow latLong/current needs a key; the no-key fallback is Open-Meteo on the
 * AIR-QUALITY host — `https://air-quality-api.open-meteo.com/v1/air-quality`
 * (NOT api.open-meteo.com, which 404s for this path).
 */

const AIRNOW_URL =
  "https://www.airnowapi.org/aq/observation/latLong/current/?format=application/json&latitude="; // + lat &longitude= &distance=25 &API_KEY=
const OPEN_METEO_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"; // ?latitude=&longitude=&current=pm2_5,us_aqi

export interface AqiObservation {
  /** US AQI (pre-computed by both sources; AirNow rows are per-pollutant AQI). */
  aqi: number | null;
  pm25: number | null;
  source: "AirNow" | "Open-Meteo";
  /** epoch ms of the observation */
  observedMs: number;
  lat: number;
  lon: number;
}

interface AirNowRow {
  DateObserved?: string;
  AQI?: number;
  Latitude?: number;
  Longitude?: number;
  ParameterName?: string;
  ReportingArea?: string;
}

interface OpenMeteoPayload {
  current?: { time?: string; pm2_5?: number; us_aqi?: number };
}

export async function fetchAqiObservation(
  point: GeoPoint,
  opts: { fetcher?: Fetcher; airnowApiKey?: string | null; replay?: boolean } = {},
): Promise<AqiObservation | null> {
  // REPLAY=1: recorded Open-Meteo payload from disk (no key needed on the demo path).
  if (opts.replay) {
    const fixture = (await readFixture("openmeteo-aqi.json")) as OpenMeteoPayload;
    return parseOpenMeteo(fixture, point);
  }
  const doFetch = opts.fetcher ?? fetch;
  if (opts.airnowApiKey) {
    const url = `${AIRNOW_URL}${point.lat}&longitude=${point.lon}&distance=25&API_KEY=${opts.airnowApiKey}`;
    const res = await doFetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`AirNow fetch failed: HTTP ${res.status}`);
    const rows = (await res.json()) as AirNowRow[];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const pm25 = rows.find((r) => r.ParameterName === "PM2.5") ?? rows[0]!;
    return {
      aqi: pm25.AQI ?? null,
      pm25: null,
      source: "AirNow",
      observedMs: pm25.DateObserved ? Date.parse(pm25.DateObserved) : Date.now(),
      lat: pm25.Latitude ?? point.lat,
      lon: pm25.Longitude ?? point.lon,
    };
  }
  const url = `${OPEN_METEO_URL}?latitude=${point.lat}&longitude=${point.lon}&current=pm2_5,us_aqi`;
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`Open-Meteo AQ fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as OpenMeteoPayload;
  return parseOpenMeteo(body, point);
}

function parseOpenMeteo(body: OpenMeteoPayload, point: GeoPoint): AqiObservation | null {
  const current = body.current;
  if (!current) return null;
  // Open-Meteo returns iso8601 without a zone (UTC by default for this endpoint).
  return {
    aqi: current.us_aqi ?? null,
    pm25: current.pm2_5 ?? null,
    source: "Open-Meteo",
    observedMs: current.time ? Math.max(0, Date.parse(`${current.time}Z`) || Date.parse(current.time)) : Date.now(),
    lat: point.lat,
    lon: point.lon,
  };
}

const AQI_BANDS: Array<[number, string]> = [
  [50, "Good"],
  [100, "Moderate"],
  [150, "Unhealthy for Sensitive Groups"],
  [Number.POSITIVE_INFINITY, "Unhealthy"],
];

/**
 * Normalize an AQ observation into an "aqi" hazard. Point geometry is stored even though
 * the demo (geo-matched) hazards are polygons: the brief/match task also reads it for
 * point users. Observations below the "action" half (severity 1 AQI) are kept — the map
 * shows them, briefing severity floors filter them.
 */
export function normalizeAqi(obs: AqiObservation): HazardDoc | null {
  if (obs.aqi === null || !Number.isFinite(obs.aqi)) return null;
  const band = AQI_BANDS.find(([max]) => obs.aqi !== null && obs.aqi <= max)?.[1] ?? "Unhealthy";
  // Hazard window: the observation is hourly and AQ changes slowly; 2 h of validity
  // covers demo cadence without looking stale on the map.
  const validTo = obs.observedMs + 2 * 60 * 60 * 1000;
  return {
    sourceId: `aqi:${obs.source}:${obs.observedMs}:${pointKey(obs)}`,
    type: "aqi",
    severity: severityFromAqi(obs.aqi),
    title: `Air quality: AQI ${obs.aqi} (${band})`,
    geometry: { type: "Point", coordinates: [obs.lon, obs.lat] },
    validFrom: obs.observedMs,
    validTo,
    source: obs.source === "AirNow" ? "AirNow" : "Open-Meteo Air Quality",
    extra: { aqi: obs.aqi, pm25: obs.pm25 },
  };
}

function pointKey(obs: AqiObservation): string {
  return `${obs.lat.toFixed(3)},${obs.lon.toFixed(3)}`;
}