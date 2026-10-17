import type { Config, } from "../config.ts";
import type { AppStore } from "../store.ts";
import { deliverAlert, type AlertOutcome, type SendContext } from "../deliver/send.ts";
import type { DeliverStore, OutboxMeta, UserRecord } from "../deliver/store.ts";
import type { MatchStore } from "../match/store.ts";
import { buildUserBrief } from "../brief/build.ts";
import { renderAlert } from "../brief/render.ts";

/**
 * The Task 4 pipeline (the stub Task 2 left at the seam): after a scenario replay
 * loads hazards, for every consenting, located user — match active hazards -> build
 * the locked brief -> render the alert text (Task 5: Gemini renderer, with the
 * deterministic brief-fields join when Gemini is unset / REPLAY=1) -> deliver
 * through the existing consent + rate gates (deliverAlert). Deliveries never
 * bypass the deliver path; Global Constraint 3.
 *
 * One alert per user per pipeline cycle: rate key = the worst active hazard's
 * sourceId (a user inside several smoke plumes plus an alert gets a single message
 * about the worst hazard, not one text per polygon). A second cycle within 2 h on
 * the same hazard is suppressed by the gate.
 *
 * A single user failing never fails the cycle: the user is skipped and the error is
 * logged without any user-identifying data.
 */

export interface PipelineCtx {
  config: Pick<Config, "photonProjectId" | "photonProjectSecret" | "geminiApiKey" | "replay">;
  store: AppStore;
  match: () => Promise<MatchStore>;
  deliver: () => Promise<DeliverStore>;
  now?: () => number;
}

export interface PipelineResult {
  /** Users with >= 1 active intersecting hazard that got a brief built + delivered (attempted). */
  briefedUsers: number;
  alerts: Record<AlertOutcome, number>;
}

/** Convenience for test stubs that install a no-op pipeline. */
export function emptyPipelineResult(): PipelineResult {
  return { briefedUsers: 0, alerts: { sent: 0, not_wired: 0, failed: 0, rate_limited: 0, consent_hold: 0 } };
}

export async function runPipeline(ctx: PipelineCtx): Promise<PipelineResult> {
  const now = ctx.now ? ctx.now() : Date.now();
  const alerts: Record<AlertOutcome, number> = { sent: 0, not_wired: 0, failed: 0, rate_limited: 0, consent_hold: 0 };
  const deliver = await ctx.deliver();
  const match = await ctx.match();
  const send: SendContext = { config: ctx.config, store: ctx.deliver, now: ctx.now ?? (() => Date.now()) };
  const users = await deliver.listBriefableUsers();
  let briefedUsers = 0;
  for (const user of users) {
    if (!user.loc) continue;
    try {
      const active = await match.intersectingHazards(user.loc, now);
      if (active.length === 0) continue;
      const worst = [...active].sort((a, b) => b.severity - a.severity || a.sourceId.localeCompare(b.sourceId))[0]!;
      const brief = await buildUserBrief(match, { id: user.id, lang: user.lang, loc: user.loc }, now);
      briefedUsers += 1;
      const briefable: Pick<UserRecord, "id" | "spaceId" | "platform"> = {
        id: user.id,
        spaceId: user.spaceId,
        platform: user.platform,
      };
      // The brief is built inside the deliver loop (fresh at send time by
      // construction); the renderer only sees brief fields, never raw feed docs.
      const rendered = await renderAlert({ brief, config: ctx.config });
      const meta: OutboxMeta = { lang: brief.lang, source: rendered.source, brief };
      const outcome = await deliverAlert(send, briefable, worst.sourceId, rendered.text, meta);
      alerts[outcome] += 1;
    } catch (err) {
      // No user identifiers here, ever.
      console.error("pipeline: user brief/deliver failed:", err instanceof Error ? err.message : err);
    }
  }
  return { briefedUsers, alerts };
}