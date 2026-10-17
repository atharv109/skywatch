import type { HazardDoc } from "../types/docs.ts";

/**
 * Sync-time scoring (Task 8, explainable): the {score, reasons[]} pair is computed
 * ONCE per packet at /mesh/sync and stored (scoredAt beside it) — the dashboard
 * composes the 30-min read-time decay from src/confidence.ts, it never recomputes
 * this. Boosts/penalties:
 *   base 0.5; +0.2 inside an active hazard zone (match's intersectingHazards);
 *   photo: seam stub (below) that records a reason and moves the score by 0;
 *   +0.1 per independent nearby verified report (different deviceId, same type,
 *   <= 150 m, capped at 3 — corroboration is nice-to-have, never required);
 *   unsigned (legacy:true) packets get an "unsigned device" reason.
 * Rescue beacons are score-boosted like this at sync but NEVER decayed/downgraded
 * at read time (their cluster keeps the max verified score).
 */
export const MESH_SCORE_BASE = 0.5;
export const HAZARD_ZONE_BOOST = 0.2;
export const CORROBORATION_BOOST = 0.1;
export const MAX_CORROBORATION = 3;

export const PHOTO_UNSCORED_REASON = "photo-unscored (vision not wired)";
export const UNSIGNED_DEVICE_REASON = "unsigned device (legacy packet, not signature-verified)";

export interface PhotoCheck {
  /** "not_wired" = the vision seam is up but does not score yet (plan's accepted state). */
  status: "not_wired";
}

/**
 * Photo seam (vision teammate): the POST /roads/check-style adapter. Today's stub
 * records the reason and moves confidence by 0 — NO API calls, no network, and a
 * wired version must stay sync-time-only so stored scores keep the never-recomputed
 * invariant (a wired adapter would go to packets synced after its deploy).
 */
export async function checkPhoto(_photoPresent: boolean): Promise<PhotoCheck> {
  return { status: "not_wired" };
}

export interface ScoreInput {
  hazards: HazardDoc[];
  /** Count of independent (different deviceId, same type, <= 150 m, verified) nearby packets. */
  corroborators: number;
  photo: boolean;
  unsigned: boolean;
}

export interface Scored {
  score: number;
  reasons: string[];
}

/** Pure scoring for one uplink packet — reasons carry their own deltas (dashboard shows them verbatim). */
export function scoreUplink(input: ScoreInput): Scored {
  const reasons: string[] = [`base ${MESH_SCORE_BASE}`];
  let score = MESH_SCORE_BASE;
  const hazard = input.hazards[0];
  if (hazard) {
    score += HAZARD_ZONE_BOOST;
    reasons.push(`+${HAZARD_ZONE_BOOST} inside active hazard zone (${hazard.sourceId})`);
  }
  if (input.photo) reasons.push(PHOTO_UNSCORED_REASON);
  const corroborators = Math.max(0, Math.min(MAX_CORROBORATION, Math.floor(input.corroborators)));
  if (corroborators > 0) {
    score += corroborators * CORROBORATION_BOOST;
    reasons.push(
      `+${(corroborators * CORROBORATION_BOOST).toFixed(1)} independent nearby reports x${corroborators} (<=150 m, different devices)`,
    );
  }
  if (input.unsigned) reasons.push(UNSIGNED_DEVICE_REASON);
  return { score: Math.round(score * 100) / 100, reasons };
}