import type { BriefHazard, HazardType, Lang, OfficialSource, UserBrief } from "../types/brief.ts";
import type { HazardDoc, Point, ResourceDoc, RoadDoc } from "../types/docs.ts";
import { confidenceFor } from "../confidence.ts";
import { ROAD_RADIUS_KM, MAX_BLOCKED_ROADS, type MatchedResource, type MatchedRoad, type MatchStore } from "../match/store.ts";
import { selectActions } from "./rules.ts";

/**
 * Brief assembly (Global Constraint 2 shape, typed by types/brief.ts — the locked
 * contract is the single source). Every confidence comes from src/confidence.ts
 * decay; a shelter below the 0.5 confidence floor is absent (shelter null → the
 * "unknown" posture: nothing claims an open shelter), matching Global Constraint 3.
 */

export const EMERGENCY_LINE = "Call 911 if you are in danger.";

/**
 * Per-hazard-type official source. Decision (documented in the task report): alert
 * and smoke name the government source of record (NWS; AirNow Fire & Smoke Map which
 * the plan pairs with NOAA HMS); for flood there is no county-polygon join at demo
 * scale, so the brief says "your local county emergency management office" instead of
 * pretending to know which county the user is in.
 */
const OFFICIAL_SOURCES: Record<HazardType, OfficialSource> = {
  alert: { name: "National Weather Service", url: "https://alerts.weather.gov" },
  smoke: { name: "NWS / NOAA HMS Fire and Smoke Map", url: "https://fire.airnow.gov" },
  aqi: { name: "NWS / AirNow", url: "https://www.airnow.gov" },
  flood: { name: "Your local county emergency management office", url: "https://www.ready.gov/floods" },
};

/** With no hazard at all the brief still carries an official source (NWS). */
const DEFAULT_OFFICIAL_SOURCE: OfficialSource = OFFICIAL_SOURCES.alert;

/**
 * Timing in plain English from validFrom/validTo. The demo replay window is ≤ 12 h,
 * which reads as "now through tonight"; longer windows name the absolute end so the
 * sentence stays truthful outside the demo window.
 */
export function timingText(validFrom: number, validTo: number, now: number): string {
  if (validTo <= now) return "no longer in effect";
  const hours = (validTo - now) / 3_600_000;
  if (hours <= 12) return "now through tonight";
  return `now through ${new Date(validTo).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export interface BriefInputs {
  userId: string;
  lang: Lang;
  hazards: HazardDoc[];
  nearest: MatchedResource | null;
  roads: MatchedRoad[];
  now: number;
}

/** Pure assembly over an already-matched set (the golden/structural tests target this). */
export function assembleBrief(inputs: BriefInputs): UserBrief {
  // Deterministic order: worst severity first, sourceId tiebreak for stable output.
  const ordered = [...inputs.hazards].sort(
    (a, b) => b.severity - a.severity || a.sourceId.localeCompare(b.sourceId),
  );

  const hazards: BriefHazard[] = ordered.map((h) => ({
    type: h.type,
    severity: h.severity,
    title: h.title,
    timing: timingText(h.validFrom, h.validTo, inputs.now),
    validFrom: h.validFrom,
    validTo: h.validTo,
  }));

  let shelter: UserBrief["shelter"] = null;
  const nearest = inputs.nearest;
  if (nearest) {
    const shelterConfidence = confidenceFor("shelter", nearest.verifiedAt, inputs.now);
    if (nearest.verifiedAt !== null && shelterConfidence >= 0.5) {
      shelter = {
        id: nearest.sourceId,
        name: nearest.name,
        distanceKm: Math.round(nearest.distanceKm * 10) / 10,
        status: "open",
        confidence: Math.round(shelterConfidence * 100) / 100,
        hours: nearest.hours ?? "",
        verifiedMinutesAgo: Math.max(0, Math.round((inputs.now - nearest.verifiedAt) / 60_000)),
      };
    }
  }

  const blockedRoads = inputs.roads.slice(0, MAX_BLOCKED_ROADS).map((r: RoadDoc & { distanceKm: number }) => ({
    cameraId: r.cameraId,
    name: r.name,
    // Only fresh (>= 0.5) flooded/blocked verdicts reach the store, so the cast is
    // safe: expired/unknown road states are filtered out at match time.
    status: r.status as "flooded" | "blocked",
    confidence: Math.round(confidenceFor("road", r.verifiedAt, inputs.now) * 100) / 100,
  }));

  return {
    userId: inputs.userId,
    lang: inputs.lang,
    actions: selectActions(ordered),
    hazards,
    shelter,
    blockedRoads,
    officialSource: ordered[0] ? OFFICIAL_SOURCES[ordered[0].type] : DEFAULT_OFFICIAL_SOURCE,
    emergency: EMERGENCY_LINE,
  };
}

export interface BriefSubject {
  id: string;
  lang: Lang;
  loc: Point;
}

/** Match + assemble in one step: the entry point the pipeline and the tool routes share. */
export async function buildUserBrief(match: MatchStore, subject: BriefSubject, now: number): Promise<UserBrief> {
  const hazards = await match.intersectingHazards(subject.loc, now);
  // No active hazard -> the all-clear posture is OFFICIAL SOURCE ONLY: no shelter
  // mention, no blocked roads, no actions (the no-hazard contract case).
  if (hazards.length === 0) {
    return assembleBrief({ userId: subject.id, lang: subject.lang, hazards: [], nearest: null, roads: [], now });
  }
  const nearest: MatchedResource | null = await match.nearestOpenResource(subject.loc, now);
  const roads: MatchedRoad[] = await match.blockedRoadsNear(subject.loc, now, ROAD_RADIUS_KM);
  return assembleBrief({ userId: subject.id, lang: subject.lang, hazards, nearest, roads, now });
}