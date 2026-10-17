import type { HazardDoc } from "../types/docs.ts";
import { severityFromNws } from "./severity.ts";
import { readFixture } from "./fixtureio.ts";

/**
 * NWS active alerts for a point (verified 2026-10-17, skywatch-notes/data-sources-report.md §1):
 *   https://api.weather.gov/alerts/active?point=<lat>,<lon>
 * - GeoJSON FeatureCollection; `features: []` is the normal empty case (success).
 * - Requires a User-Agent; UNKNOWN QUERY PARAMS ARE HARD-REJECTED (400) — do not add any.
 */

export type Fetcher = typeof fetch;

export const NWS_USER_AGENT =
  // NWS asks for an identifying UA with a contact. Placeholder mailbox documented in the README;
  // swap before any longer-lived deployment.
  "SkywatchHack/DubHacks26 (contact: skywatch.dubhacks@gmail.com)";

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface NwsAlertPayload {
  type: string;
  features: Array<{
    geometry: { type: string; coordinates: unknown } | null;
    properties: {
      id?: string;
      event?: string;
      severity?: string;
      headline?: string;
      areaDesc?: string;
      effective?: string;
      onset?: string;
      sent?: string;
      ends?: string | null;
      expires?: string | null;
    };
  }>;
}

export async function fetchNwsAlerts(
  point: GeoPoint,
  opts: { fetcher?: Fetcher; replay?: boolean } = {},
): Promise<NwsAlertPayload> {
  // REPLAY=1: read the recorded NWS payload from disk instead of live HTTP.
  if (opts.replay) {
    return (await readFixture("nws-alert-sample.json")) as NwsAlertPayload;
  }
  const doFetch = opts.fetcher ?? fetch;
  const res = await doFetch(`https://api.weather.gov/alerts/active?point=${point.lat},${point.lon}`, {
    headers: { "User-Agent": NWS_USER_AGENT, Accept: "application/geo+json" },
  });
  if (!res.ok) {
    throw new Error(`NWS alerts fetch failed: HTTP ${res.status}`);
  }
  return (await res.json()) as NwsAlertPayload;
}

/** Event name -> brief hazard type (Global Constraint 2 union). */
export function nwsEventType(event: string | undefined): HazardDoc["type"] {
  if (event?.includes("Air Quality")) return "aqi";
  if (event?.includes("Flood")) return "flood";
  return "alert";
}

/**
 * Normalize NWS alert features into hazards. Features without a geometry are skipped:
 * they still describe the affected area (via affectedZones), but zone shapes must be
 * fetched from a second endpoint to be matchable, and none of the demo paths ship that.
 */
export function normalizeNwsAlerts(payload: NwsAlertPayload): HazardDoc[] {
  const docs: HazardDoc[] = [];
  for (const feature of payload.features) {
    const props = feature.properties;
    const sourceId = `nws:${props.id ?? ""}`;
    if (!props.id || feature.geometry === null) continue;
    const validFrom = parseDate(props.effective ?? props.onset ?? props.sent);
    const validTo = parseDate(props.ends ?? props.expires);
    if (validFrom === null || validTo === null) continue;
    docs.push({
      sourceId,
      type: nwsEventType(props.event),
      severity: severityFromNws(props.severity, props.event),
      title: props.headline ?? `${props.event ?? "Weather alert"} — ${props.areaDesc ?? ""}`,
      geometry: feature.geometry as HazardDoc["geometry"],
      validFrom,
      validTo,
      source: "NWS",
      extra: { event: props.event, areaDesc: props.areaDesc },
    });
  }
  return docs;
}

function parseDate(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}