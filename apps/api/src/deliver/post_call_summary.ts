/**
 * The post-call summary skeleton table (Task 7 fix wave 3/4, demo beat 6): a
 * compact per-language skeleton for the deterministic summary text sent after a
 * user-routed post-call outcome — same philosophy as the Task 5 safety-floor
 * templates in brief/fallback.ts, but a SEPARATE small table:
 *
 * - No Gemini, no network — composition is pure interpolation.
 * - ONLY brief fields are interpolated, and the source-fact hazard TITLE goes in
 *   VERBATIM in every language. ACTION sentences are NOT re-translated here:
 *   per-action strings are IMPORTED from brief/fallback.ts TEMPLATES (wave 4) —
 *   the same action id the rule table chose renders the same sentence in the
 *   alert path and in the post-call summary, by construction.
 * - The brief's own `emergency` field is English in every brief
 *   (brief/build.ts EMERGENCY_LINE), so non-en rows carry a translated
 *   emergency line of their own.
 * - A missing row falls back to the en row (defensive — `Lang` is closed, so
 *   unreachable, but the lookup is still typed through a fallback helper).
 *
 * DUPLICATION FLAG (mirrors brief/fallback.ts header): the per-language
 * emergency strings for es/zh/tl/vi/ar are mirrored from brief/fallback.ts
 * TEMPLATES verbatim — those may not be extracted (fallback exports TEMPLATES
 * but its header/strings/logic stay untouched); if an emergency line is ever
 * corrected there, mirror the change here. Each file's header comments the other.
 * (Task 8 cross-ref: the mesh downlink ack table src/mesh/downlink.ts imports the
 * emergency strings from brief/fallback.ts / brief/build.ts rather than mirroring.)
 */
import type { Lang, UserBrief } from "../types/brief.ts";
import { TEMPLATES as FALLBACK_TEMPLATES } from "../brief/fallback.ts";

interface SummaryTemplate {
  /** The lead with the hazard title interpolated ("" title slot). */
  head: string;
  /** No-hazard lead (the title-free follow-up line). */
  headBare: string;
  /** Verified shelter line ({name} slot); used only when confidence >= 0.5 and status open. */
  shelterOpen: string;
  /** The check-official-source line for the unsure/unknown shelter. */
  checkOfficial: string;
  /** Translated emergency line; "" = use the brief's own emergency (en behavior). */
  emergency: string;
}

const TEMPLATES: Record<Lang, SummaryTemplate> = {
  en: {
    head: "Skywatch follow-up: {title}",
    headBare: "Skywatch follow-up",
    shelterOpen: "{name} is verified open",
    checkOfficial: "check official source for shelter status",
    emergency: "",
  },
  es: {
    head: "Seguimiento de Skywatch: {title}",
    headBare: "Seguimiento de Skywatch",
    shelterOpen: "Refugio {name} verificado como abierto",
    checkOfficial: "Consulte la fuente oficial para conocer el estado del refugio",
    emergency: "Llame al 911 si está en peligro.",
  },
  zh: {
    head: "Skywatch 跟进：{title}",
    headBare: "Skywatch 跟进",
    shelterOpen: "{name} 已核实为开放",
    checkOfficial: "请查阅官方来源了解避难所的最新状态",
    emergency: "如有危险，请拨打911。",
  },
  tl: {
    head: "Update mula sa Skywatch: {title}",
    headBare: "Update mula sa Skywatch",
    shelterOpen: "Napatunayang bukas ang tuluyan: {name}",
    checkOfficial: "Tingnan ang opisyal na sanggunian para sa status ng tuluyan",
    emergency: "Tumawag sa 911 kung nasa panganib ka.",
  },
  vi: {
    head: "Cập nhật từ Skywatch: {title}",
    headBare: "Cập nhật từ Skywatch",
    shelterOpen: "{name} đã được xác nhận còn mở",
    checkOfficial: "Kiểm tra nguồn chính thức về tình trạng nơi trú ẩn",
    emergency: "Gọi 911 nếu bạn gặp nguy hiểm.",
  },
  ar: {
    head: "تحديث من Skywatch: {title}",
    headBare: "تحديث من Skywatch",
    shelterOpen: "تم التأكد أن المأوى {name} مفتوح",
    checkOfficial: "راجع المصدر الرسمي لمعرفة حالة المأوى",
    emergency: "اتصل بالرقم 911 إذا كنت في خطر.",
  },
};

const EN_TEMPLATE = TEMPLATES["en"];

/** Deterministic post-call summary: hazard title + top action + verified shelter (confidence >= 0.5) else per-language official-source line + optional map link + the 911 line. Language from brief.lang; a missing row falls back to en. */
export function postCallSummary(
  brief: UserBrief,
  userId: string,
  publicBaseUrlSet: boolean,
  publicBaseUrl: string,
): string {
  const t = TEMPLATES[brief.lang] ?? EN_TEMPLATE;
  const title = brief.hazards[0]?.title ?? null;
  // Action sentence: the SAME per-language mapping the alert fallback path uses
  // (brief/fallback.ts TEMPLATES.actions keyed by the rule-table action id) —
  // untranslated/unknown id falls back to the brief's own verbatim text.
  const rawAction = brief.actions[0] ?? null;
  const fallbackActions = FALLBACK_TEMPLATES[brief.lang].actions;
  const actionText = rawAction ? (fallbackActions[rawAction.id] ?? rawAction.text) : null;
  const shelter =
    brief.shelter && brief.shelter.confidence >= 0.5 && brief.shelter.status === "open"
      ? t.shelterOpen.replace("{name}", brief.shelter.name)
      : t.checkOfficial;
  // en keeps the brief's own emergency line verbatim; other languages use the
  // translated emergency (the brief field is always the English EMERGENCY_LINE).
  const emergency = brief.lang === "en" && brief.emergency.trim().length > 0 ? brief.emergency : t.emergency;
  const link = publicBaseUrlSet ? `${publicBaseUrl.replace(/\/+$/, "")}/b/${userId}` : null;
  const parts = [
    (title ? t.head.replace("{title}", title) : t.headBare),
    actionText,
    shelter,
    link,
  ].filter((part): part is string => part !== null);
  return `${parts.join(" ")}\n${emergency}`;
}