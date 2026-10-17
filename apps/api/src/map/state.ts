import type { HazardDoc, ResourceDoc, RoadDoc } from "../types/docs.ts";

/**
 * GET /map/state payload. Privacy (Global Constraint 7): this shape is checked against
 * phone numbers in tests — user dots are rounded to ~1 km hex-free grid squares and no
 * user identifier of any kind is emitted.
 */

export interface MapState {
  generatedAt: number;
  hazards: Array<{
    sourceId: string;
    type: string;
    severity: number;
    title: string;
    geometry: HazardDoc["geometry"];
    validFrom: number;
    validTo: number;
    source: string;
  }>;
  resources: Array<{
    sourceId: string;
    kind: string;
    name: string;
    status: "open" | "unknown" | "closed";
    confidence: number;
    partner: boolean;
    lat: number;
    lon: number;
  }>;
  roads: Array<{
    cameraId: string;
    name: string;
    status: string;
    confidence: number;
    lat: number;
    lon: number;
  }>;
  /** rounded user location dots — anonymized, never ids/phones */
  userDots: Array<{ lat: number; lon: number }>;
  /** number of active users (= briefs issued per pipeline cycle) */
  briefCount: number;
}

/**
 * Confidence from the 30-min half-life rule (Global Constraint 3): 1.0 at
 * verification, halved every 30 min, floored at 0. confidence < 0.5 forces the
 * displayed status to "unknown" — computed at read time so stored docs never lie.
 */
export const CONFIDENCE_HALF_LIFE_MIN = 30;

export function confidenceFromVerified(verifiedAt: number | null, now = Date.now()): number {
  if (verifiedAt === null) return 0;
  const minutes = Math.max(0, (now - verifiedAt) / 60_000);
  return Math.max(0, Math.pow(0.5, minutes / CONFIDENCE_HALF_LIFE_MIN));
}

export function displayedStatus(status: string, confidence: number): "open" | "unknown" | "closed" {
  if (status === "open" && confidence < 0.5) return "unknown";
  if (status === "open") return "open";
  if (status === "closed") return "closed";
  return "unknown";
}

export interface MapInputs {
  hazards: HazardDoc[];
  resources: ResourceDoc[];
  roads: RoadDoc[];
  /** [lon, lat] pairs (users.loc coordinates), already projected */
  dots: Array<[number, number]>;
  userCount: number;
  now?: number;
}

/** Anonymization: round to 2 decimals (~1.1 km grid) — not precise enough to re-identify. */
function anonymize(lon: number, lat: number): { lat: number; lon: number } {
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

export function assembleMapState(inputs: MapInputs): MapState {
  const now = inputs.now ?? Date.now();
  return {
    generatedAt: now,
    hazards: inputs.hazards.map((h) => ({
      sourceId: h.sourceId,
      type: h.type,
      severity: h.severity,
      title: h.title,
      geometry: h.geometry,
      validFrom: h.validFrom,
      validTo: h.validTo,
      source: h.source,
    })),
    resources: inputs.resources.map((r) => {
      const confidence = confidenceFromVerified(r.verifiedAt, now);
      return {
        sourceId: r.sourceId,
        kind: r.kind,
        name: r.name,
        status: displayedStatus(r.status, confidence),
        confidence: Math.round(confidence * 100) / 100,
        partner: r.partner,
        lat: r.loc.coordinates[1],
        lon: r.loc.coordinates[0],
      };
    }),
    roads: inputs.roads.map((r) => {
      const confidence = confidenceFromVerified(r.verifiedAt, now);
      return {
        cameraId: r.cameraId,
        name: r.name,
        // Road statuses (flooded/blocked/clear/unknown) are shown as stored; the
        // confidence<0.5 => "unknown" downgrade is a briefing-time rule (Task 4),
        // while expired verdicts simply carry low confidence here.
        status: r.status,
        confidence: Math.round(confidence * 100) / 100,
        lat: r.loc.coordinates[1],
        lon: r.loc.coordinates[0],
      };
    }),
    userDots: inputs.dots.map(([lon, lat]) => anonymize(lon, lat)),
    briefCount: inputs.userCount,
  };
}