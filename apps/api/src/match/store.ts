import type { Db } from "mongodb";
import type { AppStore } from "../store.ts";
import { COLLECTIONS } from "../db/client.ts";
import { confidenceFor, halfLifeMinutes } from "../confidence.ts";
import type { HazardDoc, Point, ResourceDoc, RoadDoc } from "../types/docs.ts";
import { haversineKm, pointInGeometry } from "./geo.ts";

/**
 * The geo queries match needs (backend-build-plan.md Task 4). Two implementations:
 * - `mongoMatchStore` — the production path; spatial work happens server-side over
 *   the boot 2dsphere indexes (hazards.geometry $geoIntersects, resources/roads
 *   $geoNear with filter expressions).
 * - `memoryMatchStore` — same semantics over an AppStore's list* accessors for
 *   tests / non-Mongo runs, with the geometry math from ./geo.ts.
 *
 * Confidence thresholds translate to time bounds (verifiedAt) so Mongo can do them
 * in the query: confidence >= 0.5 iff age <= the kind's half-life. Below that,
 * Global Constraint 3 says the verdict is not assertable — an expired shelter drops
 * out entirely (shelter null / unknown posture) and an expired road verdict is no
 * longer "flooded"/"blocked" enough to claim in a brief.
 */

export const ROAD_RADIUS_KM = 3;
/** Hard cap from the locked brief contract (blockedRoads). */
export const MAX_BLOCKED_ROADS = 2;

export type MatchedResource = ResourceDoc & { distanceKm: number };
export type MatchedRoad = RoadDoc & { distanceKm: number };

export interface MatchStore {
  /** Hazards whose geometry intersects the point and that are active at `now` (validFrom <= now < validTo). */
  intersectingHazards(point: Point, now: number): Promise<HazardDoc[]>;
  /**
   * Nearest *shelter-kind* resource with status "open" and shelter confidence >= 0.5
   * (verified at most one shelter half-life ago). Narrowing documented decision: a
   * pharmacy open for business is not a shelter, and the brief field is called out
   * as shelter, so naming a pharmacy there would read as a shelter claim.
   */
  nearestOpenResource(point: Point, now: number): Promise<MatchedResource | null>;
  /** Fresh (confidence >= 0.5) flooded/blocked roads within radiusKm; sorted by distance, capped at 2. */
  blockedRoadsNear(point: Point, now: number, radiusKm: number): Promise<MatchedRoad[]>;
}

const pointGeometry = (point: Point) => ({ type: "Point", coordinates: point.coordinates });

export function mongoMatchStore(db: Db): MatchStore {
  return {
    async intersectingHazards(point, now) {
      return db
        .collection<HazardDoc>(COLLECTIONS.hazards)
        .find({
          geometry: { $geoIntersects: { $geometry: pointGeometry(point) } },
          validFrom: { $lte: now },
          validTo: { $gt: now },
        })
        .toArray();
    },
    async nearestOpenResource(point, now) {
      const doc = await db
        .collection<ResourceDoc>(COLLECTIONS.resources)
        .aggregate<{ distanceM: number } & ResourceDoc>()
        .geoNear({
          near: pointGeometry(point),
          distanceField: "distanceM",
          // $geoNear's own `limit` is rejected on newer servers (Atlas included):
          // cap with a $limit stage after instead.
          query: {
            kind: "shelter",
            status: "open",
            verifiedAt: { $gte: now - halfLifeMinutes.shelter * 60_000 },
          },
        })
        .limit(1)
        .toArray();
      const hit = doc[0];
      return hit ? { ...hit, distanceKm: hit.distanceM / 1000 } : null;
    },
    async blockedRoadsNear(point, now, radiusKm) {
      return db
        .collection<RoadDoc>(COLLECTIONS.roads)
        .aggregate<{ distanceM: number } & RoadDoc>()
        .geoNear({
          near: pointGeometry(point),
          distanceField: "distanceM",
          maxDistance: radiusKm * 1000,
          query: {
            status: { $in: ["flooded", "blocked"] },
            verifiedAt: { $gte: now - halfLifeMinutes.road * 60_000 },
          },
        })
        .toArray()
        .then((docs) =>
          docs
            .sort((a, b) => a.distanceM - b.distanceM)
            .slice(0, MAX_BLOCKED_ROADS)
            .map((d) => ({ ...d, distanceKm: d.distanceM / 1000 })),
        );
    },
  };
}

/**
 * In-memory variant for tests and store-less runs. Reads the AppStore lists and
 * re-does the matching per call (small doc counts by construction). Confidence
 * comes from the shared decay in src/confidence.ts — never re-derived here.
 */
export function memoryMatchStore(app: AppStore): MatchStore {
  const withDistance = <T>(docs: T[], point: Point): Array<T & { distanceKm: number }> =>
    docs.map((doc) => ({
      ...doc,
      distanceKm: haversineKm(point.coordinates, (doc as ResourceDoc | RoadDoc).loc.coordinates),
    }));
  return {
    async intersectingHazards(point, now) {
      return (await app.listHazards()).filter(
        (h) => h.validFrom <= now && h.validTo > now && pointInGeometry(point.coordinates, h.geometry),
      );
    },
    async nearestOpenResource(point, now) {
      const candidates = (await app.listResources())
        .filter(
          (r) => r.kind === "shelter" && r.status === "open" && confidenceFor("shelter", r.verifiedAt, now) >= 0.5,
        )
        .map((r) => ({ ...r, distanceKm: haversineKm(point.coordinates, r.loc.coordinates) }));
      return candidates.sort((a, b) => a.distanceKm - b.distanceKm)[0] ?? null;
    },
    async blockedRoadsNear(point, now, radiusKm) {
      const candidates = (await app.listRoads())
        .filter(
          (r) =>
            (r.status === "flooded" || r.status === "blocked") && confidenceFor("road", r.verifiedAt, now) >= 0.5,
        )
        .map((r) => ({ ...r, distanceKm: haversineKm(point.coordinates, r.loc.coordinates) }))
        .filter((r) => r.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm);
      return candidates.slice(0, MAX_BLOCKED_ROADS);
    },
  };
}