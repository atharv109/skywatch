import { buildUserBrief, EMERGENCY_LINE } from "../brief/build.ts";
import { fallbackRender, TEMPLATES } from "../brief/fallback.ts";
import type { MatchStore } from "../match/store.ts";
import type { Lang } from "../types/brief.ts";
import type { MeshStore } from "./store.ts";
import type { DownlinkBundle } from "./types.ts";

/**
 * DOWNLINK BUNDLE (Task 8): the POST /mesh/sync response the gateway rebroadcasts
 * to the hotspot LAN. Every string in it is TEMPLATE-DERIVED — the brief text is
 * fallbackRender's fixed skeleton over brief fields (never Gemini), the ack lines
 * are the fixed table below, and the 911 sentence reuses the per-language
 * emergency strings the alert path already uses. With no free text anywhere, the
 * Task 5 validator is not required here (nothing to fence), but the template rule
 * is equally binding: bundle strings can never name a place/road/number that is
 * not a brief field or the ack/911 templates.
 */

/**
 * Per-language ack skeletons — MIRROR NOTE (911-string pattern, same convention the
 * Task 7 fix wave set between brief/fallback.ts and src/deliver/post_call_summary.ts):
 * this table is mesh-specific and the second sentence is NOT duplicated here — the
 * emergency line is imported (fallback.ts TEMPLATES per lang, EMERGENCY_LINE for en),
 * so a corrected 911 string in those files flows into acks automatically. Cross-ref:
 * brief/fallback.ts + deliver/post_call_summary.ts keep the alert-path mirrors.
 */
export const MESH_ACK_LINES: Record<Lang, string> = {
  en: "Responders have seen your beacon.",
  es: "Los rescatistas ya han visto su señal de auxilio.",
  zh: "救援人员已经看到您的求救信号。",
  tl: "Napansin na ng mga tumutulong ang iyong panawagan ng tulong.",
  vi: "Nhóm cứu hộ đã nhìn thấy tín hiệu cầu cứu của bạn.",
  ar: "فرق الإنقاذ رأت إشارتك.",
};

/** The complete template-only ack message: ack line + the 911 line for that language. */
export function ackMessage(lang: Lang = "en"): string {
  const emergency = lang === "en" ? EMERGENCY_LINE : TEMPLATES[lang].emergency;
  return `${MESH_ACK_LINES[lang]} ${emergency}`;
}

/**
 * The bundle for one gateway: the template-rendered brief at its lat/lon (lang "en"
 * — decision recorded in the task report: the locked packet format carries no lang
 * field, so the device language is unknown; when the frontend adds one, pass it
 * here), the shelter/blockedRoads verbatim from that brief (the locked field
 * semantics: shelter null unless verified-open, roads max 2 fresh non-clear), and
 * acks for every beacon cluster the requesting device contributed to (acks are set
 * on the cluster — first ack wins — so the dashboard shows the acknowledged state).
 */
export async function buildDownlink(
  store: MeshStore,
  match: MatchStore,
  gateway: { deviceId: string; lat: number; lon: number },
  now: number,
): Promise<DownlinkBundle> {
  const brief = await buildUserBrief(
    match,
    { id: "mesh-gateway", lang: "en", loc: { type: "Point", coordinates: [gateway.lon, gateway.lat] } },
    now,
  );
  const clusters = await store.listBeacons();
  const acks = [] as DownlinkBundle["acks"];
  for (const cluster of clusters) {
    if (!cluster.sources.includes(gateway.deviceId)) continue;
    acks.push({ beaconClusterId: cluster.clusterId, message: ackMessage("en") });
    if (cluster.ackedAt === null) await store.ackBeacon(cluster.clusterId, now);
  }
  return {
    generatedAt: now,
    brief: fallbackRender(brief),
    nearestVerifiedShelter: brief.shelter,
    blockedRoads: brief.blockedRoads,
    acks,
  };
}