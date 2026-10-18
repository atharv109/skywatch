import type { HazardDoc } from "../types/docs.ts";
import type { MeshPacketDoc } from "./types.ts";
import { PHOTO_UNSCORED_REASON, type PhotoVerdict } from "./photovision.ts";

/**
 * Sync-time scoring (Task 8, explainable): the {score, reasons[]} pair is computed
 * ONCE per packet at /mesh/sync and stored (scoredAt beside it) — the dashboard
 * composes the 30-min read-time decay from src/confidence.ts, it never recomputes
 * this. Boosts/penalties with recorded reasons array — [+0.2 if packet location falls inside an active Skywatch smoke/flood zone or high AQI area; photo check (photo-verifier adapter in photovision.ts — may be NOT_WIRED → recorded as "unscored" reason); +0.1 per independent nearby report (≤3), never required; time decay half-life 30 min same formula as shelters]. Output {score, reasons[]} stored on packet; reasons shown on dashboard.
 *
 * Boosts/penalties:
 *   base 0.5; +0.2 inside an active hazard zone (match's intersectingHazards);
 *   photo: the photo-verifier result (photovision.ts) — a CONFIRMED verdict boosts
 *   +0.2 ("strong evidence"), a REJECTED verdict records a neutral note (score
 *   moves by 0), anything else records an "unscored" reason; when the verifier is
 *   not wired at all the legacy "photo-unscored (vision not wired)" reason stands;
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

/** Re-exported from photovision.ts (the reason strings' single source; older importers kept working). */
export { PHOTO_UNSCORED_REASON };

export const UNSIGNED_DEVICE_REASON = "unsigned device (legacy packet, not signature-verified)";

export interface ScoreInput {
  hazards: HazardDoc[];
  /** Count of independent (different deviceId, same type, <= 150 m, verified) nearby packets. */
  corroborators: number;
  /** Legacy photo presence flag (`photo` string on the packet) — unscored unless the photoRef path verifies. */
  photo: boolean;
  /** The photo-verifier result for the packet's photoRef (null/absent = no verifier run this sync). */
  photoVerdict?: PhotoVerdict | null;
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
  if (input.photoVerdict) {
    // photovision.ts owns {boost, reason}: confirmed = +0.2 strong evidence;
    // rejected/unscored = a neutral note, the score moves by exactly the boost (0).
    score += input.photoVerdict.boost;
    reasons.push(input.photoVerdict.reason);
  } else if (input.photo) {
    reasons.push(PHOTO_UNSCORED_REASON);
  }
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

/**
 * Apply a photo-verifier verdict to an ALREADY-SCORED packet doc (photo pipeline:
 * the verdict usually arrives at upload time, after the sync that scored the
 * packet). Forwarding-only refinement of the stored score — never a recompute:
 * only a CONFIRMED verdict moves the score, and only once (a packet already carrying
 * a confirmed photoVision verdict is returned unchanged, so gateway retries of the
 * same photoRef can never double-boost). The applied verdict is recorded on the
 * doc (photoVision) and, for beacons, the cluster's best score keeps the max.
 * Returns the updated doc, or null when there is nothing to apply to.
 */
export function applyPhotoVerdictToDoc(doc: MeshPacketDoc, verdict: PhotoVerdict): MeshPacketDoc | null {
  if (doc.score === null) return null; // unscored (relay/verify-failure) packets have no score to refine
  if (doc.photoVision?.verdict === "confirmed") return doc; // idempotent: the boost can never double-apply
  const confirmed = verdict.verdict === "confirmed";
  const updated: MeshPacketDoc = {
    ...doc,
    score: confirmed ? Math.round((doc.score + verdict.boost) * 100) / 100 : doc.score,
    reasons: doc.reasons.includes(verdict.reason) ? doc.reasons : [...doc.reasons, verdict.reason],
    photoVision: { verdict: verdict.verdict, confidence: verdict.confidence, detail: verdict.detail },
  };
  return updated;
}