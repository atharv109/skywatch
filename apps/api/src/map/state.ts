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
 * Confidence decays from `verifiedAt` with the spec half-lives (shelters 30 min,
 * roads 15 min) — the per-kind source of truth lives in src/confidence.ts and
 * Task 6's check-in endpoints import it from there.
 */
export { confidenceFor, halfLifeMinutes } from "../confidence.ts";
import { confidenceFor } from "../confidence.ts";

export function displayedStatus(status: string, confidence: number): "open" | "unknown" | "closed" {
  if (status === "open" && confidence < 0.5) return "unknown";
  if (status === "open") return "open";
  if (status === "closed") return "closed";
  return "unknown";
}

/**
 * Road variant of the same display rule: a fresh flooded/blocked verdict (confidence
 * >= 0.5) shows as stored; below 0.5 the map shows "unknown" while keeping the
 * (low) confidence. clear/unknown stay as stored.
 */
function isExpiredRoadStatus(status: string, confidence: number): string {
  if ((status === "flooded" || status === "blocked") && confidence < 0.5) return "unknown";
  return status;
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
      // All non-road resources (shelters, pharmacies, community centers) ride the
      // shelter half-life; only road verdicts are more perishable (15 min).
      const confidence = confidenceFor("shelter", r.verifiedAt, now);
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
      const confidence = confidenceFor("road", r.verifiedAt, now);
      return {
        cameraId: r.cameraId,
        name: r.name,
        // Road verdicts decay twice as fast (15-min half-life): an expired
        // flooded/blocked verdict keeps its label's low confidence but flips to
        // "unknown" once below 0.5, matching the Global Constraint 3 display rule.
        status: isExpiredRoadStatus(r.status, confidence),
        confidence: Math.round(confidence * 100) / 100,
        lat: r.loc.coordinates[1],
        lon: r.loc.coordinates[0],
      };
    }),
    userDots: inputs.dots.map(([lon, lat]) => anonymize(lon, lat)),
    briefCount: inputs.userCount,
  };
}