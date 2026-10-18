import type { Hazard, Resource } from "@/lib/types";

/** Puget Sound box that contains the Seattle fixtures (47.5–47.7, -122.45–-122.2). */
export const PUGET_BOUNDS: [[number, number], [number, number]] = [
  [47.45, -122.55],
  [47.78, -122.12],
];

export const SEATTLE_HOME: [number, number] = [47.5682, -122.3084];

export const SEATTLE_OEM = "https://www.seattle.gov/emergency-management";

export const EL_CENTRO: [number, number] = [47.5804, -122.312];

export const seattleSmoke: Hazard = {
  id: "seattle-smoke",
  name: "Smoke plume",
  severity: "danger",
  confidence: "high",
  summary: "A heavy smoke plume is over Seattle. NOAA HMS is the source.",
  timing: "Now through tonight",
  verifiedAgoSec: 120,
  polygon: [
    [47.63, -122.4],
    [47.66, -122.3],
    [47.6, -122.24],
    [47.52, -122.28],
    [47.51, -122.39],
  ],
};

export function seattleShelter(name: string): Resource {
  return {
    id: "seattle-shelter",
    name,
    kind: "shelter",
    status: "open",
    confidence: "medium",
    point: EL_CENTRO,
    address: "2524 16th Ave S",
    verifiedAgoSec: 20 * 60,
    note: "Named by the gateway brief.",
  };
}
