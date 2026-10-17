/**
 * Task 6: POST /roads/check — one camera verdict from the vision service (or a
 * human fallback), stored with verifiedAt = now. Confidence decay (15-min road
 * half-life) lives ONLY in src/confidence.ts — nothing re-derives it here.
 *
 * Gating at the door (keeps the brief's road-status cast contract in build.ts
 * intact): only a verdict with confidence >= 0.5 may enter the store asserting
 * "flooded"/"blocked" — a sub-0.5 (or >1 / non-numeric) confidence is recorded as
 * status "unknown" with verifiedAt null, so a stale/unconvinced verdict can never
 * be echoed into a brief as a flooded/blocked claim (build.ts "only fresh
 * verdicts reach the store" comment).
 */
import type { Config } from "../config.ts";
import { visionAdapter, type VisionAdapter } from "./adapter.ts";
import type { RoadDoc, RoadStatus } from "../types/docs.ts";
import type { AppStore } from "../store.ts";

const ROAD_STATUSES: readonly RoadStatus[] = ["clear", "flooded", "blocked", "unknown"];

/** The 0.5 assertability floor (Global Constraint 3); match applies the same bound. */
export const ASSERTABLE_CONFIDENCE = 0.5;

export class RoadCheckError extends Error {
  constructor(readonly code: 404 | 400, message: string) {
    super(message);
  }
}

export interface RoadCheckBody {
  cameraId: string;
  status: RoadStatus;
  confidence: number;
}

export interface RoadCheckResult {
  /** The camera verdict input, echoed with the effective status actually stored. */
  status: RoadStatus;
  confidence: number | null;
  stored: RoadDoc;
}

export async function applyRoadCheck(
  store: AppStore,
  body: RoadCheckBody,
  now: number,
): Promise<RoadCheckResult> {
  const road = await store.getRoad(body.cameraId);
  if (!road) throw new RoadCheckError(404, `unknown camera '${body.cameraId}'`);
  if (typeof body.status !== "string" || !ROAD_STATUSES.includes(body.status)) {
    throw new RoadCheckError(400, `status must be one of: ${ROAD_STATUSES.join("|")}`);
  }

  const confidenceRaw = Number(body.confidence);
  const invalidConfidence =
    !Number.isFinite(confidenceRaw) || confidenceRaw < 0 || confidenceRaw > 1;
  // confidence > 1 (and any malformed value) is treated as unknown — an
  // unbounded confidence is not an assertable verdict.
  const effective: { status: RoadStatus; verifiedAt: number | null; confidence: number | null } = invalidConfidence
    ? { status: "unknown", verifiedAt: null, confidence: null }
    : confidenceRaw >= ASSERTABLE_CONFIDENCE && body.status !== "unknown"
      ? { status: body.status, verifiedAt: now, confidence: confidenceRaw }
      : { status: "unknown", verifiedAt: null, confidence: confidenceRaw };

  const stored: RoadDoc = { ...road, status: effective.status, verifiedAt: effective.verifiedAt };
  await store.upsertRoad(stored);
  return { status: effective.status, confidence: effective.confidence, stored };
}

/** The vision seam for the response payload (no live calls, ever — see adapter.ts). */
export function adapterFor(config: Pick<Config, "perceptronApiKey">): VisionAdapter {
  return visionAdapter(config);
}