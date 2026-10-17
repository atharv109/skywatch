/**
 * Task 6: POST /verify/run — partner resources inside an active hazard's geometry
 * get a voice check-in request enqueued into `verify_requests`. No direct
 * ElevenLabs call from the backend: Delivery's Check-in agent either consumes the
 * /verify/run response or polls GET /tools/checkin/next?deviceId= (the ONE
 * server-side consumption contract, documented in the task report).
 */
import type { AppStore } from "../store.ts";
import type { Config } from "../config.ts";
import { pointInGeometry } from "../match/geo.ts";
import type { ResourceDoc } from "../types/docs.ts";
import type { VerifyRequestDoc, VerifyStore } from "./store.ts";

export interface RunVerifyResult {
  created: VerifyRequestDoc[];
}

/**
 * Which partner resources need a live check-in: partner === true AND its location
 * falls inside at least one ACTIVE hazard's geometry (validFrom <= now < validTo).
 * In-memory over the shared AppStore lists (demo-scale doc counts, same posture as
 * memoryMatchStore); the hazard doc's sourceId is the script's hazard citation.
 */
async function partnerResourcesInsideHazards(
  store: AppStore,
  now: number,
): Promise<Array<{ resource: ResourceDoc; hazardSourceId: string }>> {
  const [hazards, resources] = await Promise.all([store.listHazards(), store.listResources()]);
  const active = hazards.filter((h) => h.validFrom <= now && h.validTo > now);
  const out: Array<{ resource: ResourceDoc; hazardSourceId: string }> = [];
  for (const resource of resources) {
    if (!resource.partner) continue;
    for (const hazard of active) {
      if (!pointInGeometry(resource.loc.coordinates, hazard.geometry)) continue;
      out.push({ resource, hazardSourceId: hazard.sourceId });
      break; // one request per resource: a partner inside several hazards gets one call
    }
  }
  return out;
}

/**
 * Idempotent: a re-run while a request for the same resource+hazard is still
 * pending/dispatched creates nothing; an answered one re-arms at most once per
 * hour (verify/store.ts), and the whole resource is capped at
 * MAX_CHECKINS_PER_RESOURCE_PER_HOUR answered check-ins per rolling hour —
 * voice check-ins are the expensive, interrupting surface, so the cadence is
 * bounded server-side (the judges-facing promise) regardless of who re-runs.
 */
export const MAX_CHECKINS_PER_RESOURCE_PER_HOUR = 3;

export async function createVerifyRuns(
  store: AppStore,
  verify: VerifyStore,
  config: Pick<Config, "elevenlabsAgentIdCheckin">,
  body: { deviceId?: string | null; now: number },
): Promise<RunVerifyResult> {
  const targets = await partnerResourcesInsideHazards(store, body.now);
  const created: VerifyRequestDoc[] = [];
  for (const { resource, hazardSourceId } of targets) {
    const answeredLastHour = await verify.countAnsweredSince(resource.sourceId, body.now - 3_600_000, body.now);
    if (answeredLastHour >= MAX_CHECKINS_PER_RESOURCE_PER_HOUR) continue;
    const saved = await verify.createRequest({
      requestId: `vr:${resource.sourceId}:${hazardSourceId}`,
      resourceId: resource.sourceId,
      resourceName: resource.name,
      hazardSourceId,
      agentId: config.elevenlabsAgentIdCheckin,
      deviceId: body.deviceId ?? null,
      status: "pending",
      outcome: null,
      conversationId: null,
      manual: false,
      createdAt: body.now,
      dispatchedAt: null,
      answeredAt: null,
    });
    if (saved) created.push(saved);
  }
  return { created };
}