/**
 * Photo verification via the xAI vision endpoint (mesh photo pipeline feature) —
 * the wired successor to score.ts's "not wired" seam. The backend now DOES make a
 * live call, per the new ruling: for a photoRef whose bytes are uploaded
 * (POST /mesh/photo), ask the multimodal model whether the image shows what the
 * packet claims, and return an explainable {verdict, boost, reason} triple.
 *
 * Postures (identical to grok-tts.ts + the satellite overlay): 8 s timeout, ANY
 * failure (no key, network, non-JSON, parse, bad model) -> return
 * {verdict:"unverified", boost:0, reason:"photo-unscored (vision not verified)"} —
 * NEVER throw into the pipeline, never block the upload, and the verdict's reason
 * rides the packet's reason list verbatim (every score shows its reason).
 *
 * Endpoint/model: POST https://api.x.ai/v1/chat/completions (OpenAI-compatible),
 * vision-capable model — the docs' current flagship is `grok-4.7` (image input
 * documented at docs.x.ai/docs/guides/image-understanding); the model is
 * overridable via SKYWATCH_XAI_VISION_MODEL so a naming change never needs a code
 * change. The image rides as a base64 data URL (`data:image/{type};base64,...`).
 */
import type { Config } from "../config.ts";
import type { MeshPhotoLabel } from "./types.ts";

export const XAI_VISION_URL = "https://api.x.ai/v1/chat/completions";
export const XAI_VISION_MODEL = "grok-4.7";
export const XAI_VISION_TIMEOUT_MS = 8_000;

/** Confirmed-match boost (the "strong evidence" leg of the photo scoring rule). */
export const PHOTO_CONFIRM_BOOST = 0.2;
/** match verdicts below this confidence are NEITHER confirmed NOR rejected (unscored). */
export const PHOTO_VISION_CONFIDENCE_FLOOR = 0.7;

/** Score reason legs (score.ts composes these; keep the strings deterministic — the packet's reason array is the audit trail) */
export const PHOTO_UNSCORED_REASON = "photo-unscored (vision not wired)";
export const PHOTO_PENDING_REASON = "photo-unscored (photo bytes not uploaded yet)";
export const PHOTO_UNVERIFIED_REASON = "photo-unscored (vision not verified)";
export const PHOTO_REJECTED_REASON = "photo check (vision): image does not match the reported status — no photo boost";

export interface PhotoVerdictInput {
  /** The photoRef pointer (trace/correlation; the LLM call reads the BYTES, not the pointer). */
  photoRef: string;
  /** Gateway-reported label (null = unlabeled — the claimed status text still rides). */
  label: MeshPhotoLabel | null;
  /** The packet's claimed status (report text); what the image is checked against. */
  status: string;
  /** "image/jpeg" | "image/png" — the data-URL type. */
  contentType: string;
  /** Raw base64 image bytes (the mesh photo store's stored form). */
  data: string;
}

/** Explainable photo verdict — {verdict, boost, reason} is the demo's score-shows-reason contract. */
export interface PhotoVerdict {
  verdict: "confirmed" | "rejected" | "unverified";
  /** 0, or PHOTO_CONFIRM_BOOST when confirmed. */
  boost: number;
  /** Verbatim score reason (goes onto the packet's reasons array). */
  reason: string;
  /** The model's free-text detail (stored doc-side, never composed into anything rendered). */
  detail: string;
  /** Parsed model confidence 0..1; 0.5 default when the model declined to give one. */
  confidence: number;
}

export type PhotoVision = (input: PhotoVerdictInput) => Promise<PhotoVerdict>;

const UNSCORED_VERDICT = (detail: string): PhotoVerdict => ({
  verdict: "unverified",
  boost: 0,
  reason: PHOTO_UNVERIFIED_REASON,
  detail,
  confidence: 0,
});

/** The compact classification question (STRICT JSON contract in the prompt itself). */
export function photoPrompt(claimed: string, label: MeshPhotoLabel | null): string {
  const claim = claimed.trim().length > 0 ? claimed.trim() : (label ?? "an unnamed status");
  return (
    `You are a disaster-report photo verifier. The image was attached to a community`
    + ` mesh report. Claimed status: "${claim}".`
    + ` Does the image show ${claim}? Answer STRICT JSON only, no prose around it: {"match": true|false, "confidence": 0..1, "detail": "<= 12 words"}`
  );
}

/**
 * Pull the FIRST JSON object out of the model text (models wrap in prose/code
 * fences; "robustly" per the ruling). Returns null when nothing JSON-shaped exists.
 */
export function extractJsonLoose(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  const end = cleaned.lastIndexOf("}");
  if (end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * verifyReportedPhoto — the classification call itself. Pure seam function: an
 * injected fetcher keeps tests hermetic; the live path uses global fetch.
 * A null-key or any failure reads as unscored, never thrown.
 */
export async function verifyReportedPhoto(
  deps: { config: Pick<Config, "xaiApiKey" | "xaiVisionModel">; fetcher?: typeof fetch },
  input: PhotoVerdictInput,
): Promise<PhotoVerdict> {
  if (!deps.config.xaiApiKey) {
    return { verdict: "unverified", boost: 0, reason: PHOTO_UNSCORED_REASON, detail: "no XAI_API_KEY — the vision seam is not wired", confidence: 0 };
  }
  if (input.contentType !== "image/jpeg" && input.contentType !== "image/png") {
    return UNSCORED_VERDICT(`content type ${input.contentType} is not a supported image type`);
  }
  try {
    const doFetch = deps.fetcher ?? fetch;
    const res = await doFetch(XAI_VISION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.config.xaiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: deps.config.xaiVisionModel ?? XAI_VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${input.contentType};base64,${input.data}` } },
              { type: "text", text: photoPrompt(input.status, input.label) },
            ],
          },
        ],
        max_tokens: 160,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(XAI_VISION_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`vision endpoint HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body.choices?.[0]?.message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c) => (typeof c === "object" && c !== null && "text" in (c as Record<string, unknown>) ? String((c as Record<string, unknown>).text) : "")).join(" ")
        : "";
    const json = extractJsonLoose(text);
    if (!json || typeof json["match"] !== "boolean") return UNSCORED_VERDICT(`unparseable model answer: ${text.slice(0, 120)}`);
    const confidence = typeof json["confidence"] === "number" && Number.isFinite(json["confidence"])
      ? Math.max(0, Math.min(1, json["confidence"]))
      : 0;
    const detail = typeof json["detail"] === "string" ? json["detail"].slice(0, 160) : "";
    const label = input.label ?? "unlabeled";
    if (json["match"] && confidence >= PHOTO_VISION_CONFIDENCE_FLOOR) {
      return {
        verdict: "confirmed",
        boost: PHOTO_CONFIRM_BOOST,
        reason: `+${PHOTO_CONFIRM_BOOST} photo confirms the report (vision: ${label}, confidence ${confidence.toFixed(2)})`,
        detail,
        confidence,
      };
    }
    if (!json["match"] && confidence >= PHOTO_VISION_CONFIDENCE_FLOOR) {
      return { verdict: "rejected", boost: 0, reason: PHOTO_REJECTED_REASON, detail, confidence };
    }
    return UNSCORED_VERDICT(detail.length > 0 ? `low vision confidence (${confidence.toFixed(2)}) — ${detail}` : "low vision confidence");
  } catch (err) {
    return UNSCORED_VERDICT(err instanceof Error ? err.message.slice(0, 120) : "vision call failed");
  }
}

/** The dep-shaped seam (AppDeps.photoVision): bound config + the module's fetch. */
export function makePhotoVision(config: Pick<Config, "xaiApiKey" | "xaiVisionModel">, injFetcher?: typeof fetch): PhotoVision {
  return (input) => verifyReportedPhoto({ config, fetcher: injFetcher }, input);
}