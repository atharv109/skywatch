/**
 * Mongo document shapes (distinct from the locked brief contract in brief.ts).
 * Documents match the indexes created in db/client.ts: hazards.geometry 2dsphere,
 * resources.loc and roads.loc 2dsphere, users.loc 2dsphere + users.phone unique.
 */

import type { HazardType } from "./brief.ts";

/** Point geometry: coordinates are [lon, lat] (GeoJSON order). */
export interface Point {
  type: "Point";
  coordinates: [number, number];
}

/**
 * One hazard, normalized from any ingest source (NWS / AirNow / Open-Meteo /
 * NOAA HMS smoke / USGS gauge). Upsert key is `sourceId`, which every source
 * derives deterministically from its own data so replay is idempotent.
 */
export interface HazardDoc {
  /** Deterministic upsert key, e.g. "hms-smoke:GOES-WEST:2020255 1610:Medium:3". */
  sourceId: string;
  type: HazardType;
  /** 1..4 (see src/ingest/severity.ts). */
  severity: number;
  title: string;
  /** GeoJSON geometry (Polygon / MultiPolygon / Point). */
  geometry: { type: string; coordinates: unknown };
  /** epoch ms */
  validFrom: number;
  /** epoch ms */
  validTo: number;
  /** Human-readable source name, e.g. "NOAA HMS Smoke Mapping". */
  source: string;
  /** Source-preserved extras (density, gauge reading, aqi value, original event times...). */
  extra?: Record<string, unknown>;
}

export type ResourceKind = "shelter" | "pharmacy" | "community_center";
export type ResourceStatus = "unknown" | "open" | "closed";

export interface ResourceDoc {
  /** Deterministic upsert key, e.g. "seed-shelter-1". */
  sourceId: string;
  kind: ResourceKind;
  name: string;
  address?: string;
  hours?: string;
  /** true = Skywatch partner: eligible for voice check-in (Task 6). */
  partner: boolean;
  status: ResourceStatus;
  /** epoch ms of last verification, null = never verified. */
  verifiedAt: number | null;
  loc: Point;
}

export type RoadStatus = "clear" | "flooded" | "blocked" | "unknown";

export interface RoadDoc {
  /** Deterministic upsert key, e.g. "wsdot-9800". */
  cameraId: string;
  name: string;
  roadName?: string;
  direction?: string;
  /** GeoJSON Point [lon, lat]. */
  loc: Point;
  status: RoadStatus;
  /** epoch ms of the vision verdict, null = never assessed. */
  verifiedAt: number | null;
  imageUrl: string;
  region?: string;
  isActive?: boolean;
}