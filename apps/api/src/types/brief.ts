/**
 * The locked brief JSON contract (Global Constraint 2). Single source of truth:
 * later tasks import these types instead of duplicating schemas.
 */

/** es|zh|tl|vi|ar (+en) — never the phone number in briefs visible to agents. */
export type Lang = "en" | "es" | "zh" | "tl" | "vi" | "ar";

export type HazardType = "smoke" | "flood" | "aqi" | "alert";

export interface BriefHazard {
  type: HazardType;
  /** 1..4 */
  severity: number;
  title: string;
  timing: string;
  /** epoch ms */
  validFrom: number;
  /** epoch ms */
  validTo: number;
}

export interface BriefAction {
  /** kebab-id */
  id: string;
  text: string;
}

export interface ShelterBrief {
  id: string;
  name: string;
  distanceKm: number;
  /** confidence < 0.5 must be "unknown" (Global Constraint 3) */
  status: "open" | "unknown";
  /** 0..1 */
  confidence: number;
  hours: string;
  verifiedMinutesAgo: number;
}

export interface BlockedRoad {
  cameraId: string;
  name: string;
  status: "flooded" | "blocked";
  confidence: number;
}

export interface OfficialSource {
  name: string;
  url: string;
}

export interface UserBrief {
  userId: string;
  lang: Lang;
  /** max 5, ordered */
  actions: BriefAction[];
  hazards: BriefHazard[];
  shelter: ShelterBrief | null;
  /** max 2, only non-clear */
  blockedRoads: BlockedRoad[];
  officialSource: OfficialSource;
  emergency: string;
}