/**
 * Task 6: the single check-in entry point behind POST /tools/checkin. The voice
 * agent path (Delivery's Checkin agent mid-call, `manual` absent/false) and the
 * dashboard-button path (`manual: true`) use THE SAME endpoint and contract —
 * no separate manual endpoint.
 *
 * Effects: resource.status / verifiedAt = now / optional capacity + lastCheckin
 * receipt; and, when the caller carries a `userId`, a note appended to that
 * user's conversation via the shared deliver store (no direct conversation
 * writes). Both surfaces (next brief, GET /map/state) read the same resource
 * doc, so a check-in is visible on both immediately.
 */
import type { AppStore } from "../store.ts";
import type { CheckinNote, ResourceDoc, ResourceStatus } from "../types/docs.ts";

/** The check-in status enum — "full" is the at-capacity verdict (Task 6 brief). */
export type CheckinStatus = "open" | "full" | "closed" | "unknown";

export const CHECKIN_STATUSES: readonly CheckinStatus[] = ["open", "full", "closed", "unknown"];

export interface CheckinBody {
  resourceId: string;
  status: CheckinStatus;
  capacity?: number | null;
  notes?: string | null;
  manual?: boolean;
  /** Voice caller's user context (optional); a manual dashboard write omits it. */
  userId?: string | null;
}

export interface CheckinResult {
  resource: ResourceDoc;
  /** The note appended to the conversation, when one was written. */
  note: string | null;
}

export class CheckinError extends Error {
  constructor(readonly code: 404 | 400, message: string) {
    super(message);
  }
}

/** Notes are truncated so a stray paste can never become a log of unbounded text. */
export function truncateNotes(notes: string | null | undefined): string | null {
  const t = notes?.trim() ?? "";
  return t.length === 0 ? null : t.slice(0, 200);
}

export async function applyCheckin(
  store: AppStore,
  resourceId: string,
  body: CheckinBody,
  now: number,
): Promise<CheckinResult> {
  const resource = await store.getResource(resourceId);
  if (!resource) throw new CheckinError(404, `unknown resource '${resourceId}'`);
  const status = body.status;
  const capacity =
    body.capacity === undefined || body.capacity === null
      ? (resource.capacity ?? null)
      : Number.isFinite(Number(body.capacity)) && Number(body.capacity) >= 0
        ? Number(body.capacity)
        : null;
  const checkin: CheckinNote = {
    status: status as ResourceStatus,
    manual: body.manual === true,
    notes: truncateNotes(body.notes),
    at: now,
  };
  const updated: ResourceDoc = {
    ...resource,
    status: status as ResourceStatus,
    verifiedAt: now,
    capacity,
    lastCheckin: checkin,
  };
  await store.upsertResource(updated);
  const note = body.userId
    ? `Check-in for ${resource.name}: status ${status}.`
    : null;
  return { resource: updated, note };
}