import { buildUserBrief, EMERGENCY_LINE } from "../brief/build.ts";
import { fallbackRender, TEMPLATES } from "../brief/fallback.ts";
import { confidenceFor } from "../confidence.ts";
import { haversineKm } from "../match/geo.ts";
import type { MatchStore } from "../match/store.ts";
import type { Lang } from "../types/brief.ts";
import type { MeshRouteView } from "./types.ts";
import { hashPrefix, messageView, MESH_DECAY_KIND } from "./state.ts";
import type { MeshStore } from "./store.ts";
import type { DownlinkBundle, SatelliteSection } from "./types.ts";

/**
 * DOWNLINK BUNDLE (Task 8): the POST /mesh/sync response the gateway rebroadcasts
 * to the hotspot LAN. Every string in it is TEMPLATE-DERIVED — the brief text is
 * fallbackRender's fixed skeleton over brief fields (never Gemini), the ack lines
 * are the fixed table below, and the 911 sentence reuses the per-language
 * emergency strings the alert path already uses. With no free text anywhere, the
 * Task 5 validator is not required here (nothing to fence), but the template rule
 * is equally binding: bundle strings can never name a place/road/number that is
 * not a brief field or the ack/911 templates.
 *
 * Task 8b addition: `messages` — the newest MESH_MSG_BUNDLE_CAP mesh chat packets
 * relevant to this gateway (direct `to` its deviceId hash, or broadcast within
 * MESH_MSG_BUNDLE_RADIUS_KM of its position). The template rule binds only
 * SERVER-COMPOSED strings: message `text` is USER text, transported verbatim,
 * never composed or rendered here.
 */

/** Task 8b: how far from the gateway a broadcast message must be to ride its bundle. */
export const MESH_MSG_BUNDLE_RADIUS_KM = 5;
/** Task 8b: bundle message cap (newest first). */
export const MESH_MSG_BUNDLE_CAP = 20;

/** Photo pipeline: the bundle's brief-panel news rows (scored reports WITH resolved photos), newest first. */
export const MESH_PHOTO_REPORT_CAP = 5;

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
 * The bundle for one gateway: the template-rendered brief at its lat/lon, the
 * shelter/blockedRoads verbatim from that brief (the locked field semantics:
 * shelter null unless verified-open, roads max 2 fresh non-clear), acks for every
 * beacon cluster the requesting device contributed to (acks are set on the cluster
 * — first ack wins — so the dashboard shows the acknowledged state), and the newest
 * mesh messages addressed to/broadcast around the gateway (Task 8b).
 *
 * Language: `lang` is an optional param, default "en" — the locked packet format
 * carries no lang field, so the gateway must pass the device language explicitly
 * when the frontend adds one (ack strings come from the per-language table; no
 * language detection is done here).
 */
export async function buildDownlink(
  store: MeshStore,
  match: MatchStore,
  gateway: { deviceId: string; lat: number; lon: number },
  now: number,
  lang: Lang = "en",
  // Task 8e: the ALREADY-FETCHED satellite snapshot (undefined/null = omitted —
  // the fetch lives in the sync path, never inside the bundle build).
  satellite?: SatelliteSection | null,
  // Task 10: the directions seam — resolves the verified-open shelter's walking/
  // driving route (live OSRM or the demo prepared pack). Never throws into the
  // bundle; empty/failed = the key is simply omitted.
  directions?: (now: number) => Promise<MeshRouteView[]>,
): Promise<DownlinkBundle> {
  const brief = await buildUserBrief(
    match,
    { id: "mesh-gateway", lang, loc: { type: "Point", coordinates: [gateway.lon, gateway.lat] } },
    now,
  );
  const clusters = await store.listBeacons();
  const acks = [] as DownlinkBundle["acks"];
  for (const cluster of clusters) {
    if (!cluster.sources.includes(gateway.deviceId)) continue;
    acks.push({ beaconClusterId: cluster.clusterId, message: ackMessage(lang) });
    if (cluster.ackedAt === null) await store.ackBeacon(cluster.clusterId, now);
  }
  // Task 8b messages: newest cap 20 — direct `to` the gateway's hash (anywhere), or
  // broadcast messages within the radius of the gateway's position.
  const gatewayHash = hashPrefix(gateway.deviceId);
  const [packets, photos] = await Promise.all([store.listPackets(), store.listPhotos()]);
  const byRef = new Map(photos.map((p) => [p.photoRef, p] as const));
  const messages = packets
    .filter((p) => p.type === "msg")
    .filter(
      (p) =>
        p.to === gatewayHash ||
        (p.to === null &&
          haversineKm([gateway.lon, gateway.lat], [p.lon, p.lat]) <= MESH_MSG_BUNDLE_RADIUS_KM),
    )
    .sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id))
    .slice(0, MESH_MSG_BUNDLE_CAP)
    .map((p) => messageView(p, byRef));
  // Photo pipeline: the sync's brief-panel news — scored reports whose photo
  // pointers RESOLVE, each with its (read-time-decayed) score, the reason trail
  // (base/zone/photo-verdict/corroborators) and the AI verdict row verbatim.
  // Capped; included ONLY when any exist (never half-arrives).
  const photoReports = packets
    .filter((p) => p.photoRef !== null && p.score !== null && byRef.has(p.photoRef))
    .sort((a, b) => b.receivedAt - a.receivedAt || a.id.localeCompare(b.id))
    .slice(0, MESH_PHOTO_REPORT_CAP)
    .map((p) => {
      const photo = byRef.get(p.photoRef!);
      return {
        id: p.id,
        status: p.status,
        lat: p.lat,
        lon: p.lon,
        ts: p.ts,
        score:
          p.score === null
            ? 0
            : Math.round(p.score * confidenceFor(MESH_DECAY_KIND, p.scoredAt, now) * 100) / 100,
        reasons: p.reasons,
        photoVision: p.photoVision ?? null,
        photoKind: photo?.kind ?? null,
        photoUrl: `/mesh/photo/${p.photoRef}`,
      };
    });
  const photoSection = photoReports.length > 0 ? { photoReports } : undefined;
  // Task 10: the fact-based route (no validator) — omitted on failure/absence.
  let routes: MeshRouteView[] | undefined;
  if (directions) {
    try {
      const fetched = await directions(now);
      if (Array.isArray(fetched) && fetched.length > 0) routes = fetched;
    } catch (err) {
      console.error("directions failed (routes omitted):", err instanceof Error ? err.message : err);
    }
  }
  return {
    generatedAt: now,
    brief: fallbackRender(brief),
    nearestVerifiedShelter: brief.shelter,
    blockedRoads: brief.blockedRoads,
    acks,
    messages,
    ...(photoSection ?? {}),
    // Optional keys: a section/fact is present ONLY when it was genuinely fetched;
    // failure = absent (never half-arrive).
    ...(satellite ? { satellite } : {}),
    ...(routes ? { routes } : {}),
  };
}