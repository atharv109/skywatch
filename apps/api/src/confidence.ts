/**
 * THE single source of truth for confidence decay (Global Constraint 3: shelters
 * 30-min half-life, roads 15-min). Computed from `verifiedAt` at read time.
 *
 * Task 6 (`POST /tools/checkin`, `POST /roads/check`) MUST import from here instead
 * of re-deriving a half-life; map/state already does.
 */
export type ConfidenceKind = "shelter" | "road" | "mesh";

export const halfLifeMinutes: Record<ConfidenceKind, number> = {
  shelter: 30,
  road: 15,
  /** Task 8 mesh packets: 30-min half-life, same formula as shelters (base score stored at sync, decay composed at read). */
  mesh: 30,
};

/** 1.0 at verification, halved every kind-specific half-life, floored at 0. */
export function confidenceFor(kind: ConfidenceKind, verifiedAt: number | null, now = Date.now()): number {
  if (verifiedAt === null) return 0;
  const minutes = Math.max(0, (now - verifiedAt) / 60_000);
  return Math.max(0, Math.pow(0.5, minutes / halfLifeMinutes[kind]));
}