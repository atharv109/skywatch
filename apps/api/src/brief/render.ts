/**
 * The Gemini alert renderer (backend-build-plan.md Task 5).
 *
 * This file is the VEYZL "before" commit: the model writes freely from the brief
 * JSON and whatever comes back is delivered — the mention validator, the retry/
 * fallback chain and the staleness enforcement land in the next commit. The only
 * hard gate already present (Global Constraint 3 via the brief builder): the
 * renderer never sees feed docs, just the locked UserBrief; when Gemini is unset
 * (or REPLAY=1) the deterministic brief-fields join below is used instead.
 */
import type { Config } from "../config.ts";
import type { Lang, UserBrief } from "../types/brief.ts";

export type Fetcher = typeof fetch;

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_TIMEOUT_MS = 15_000;

const LANG_NAMES: Record<Lang, string> = {
  en: "English",
  es: "Spanish",
  zh: "Simplified Chinese",
  tl: "Tagalog",
  vi: "Vietnamese",
  ar: "Arabic",
};

/**
 * The prompt is generated FROM the brief type/shape: every field of the locked
 * UserBrief contract is enumerated, then the brief itself is pasted as JSON. No
 * phone number ever reaches this prompt (briefs never carry one).
 */
export function promptFor(brief: UserBrief): string {
  return [
    "You are the alert writer for Skywatch, a disaster-response alerting service.",
    "Below is one alert brief (JSON) - the fact set gathered for one person. Write a short alert message for them from it.",
    "",
    "The brief has exactly these fields:",
    '- "lang": the message language, one of en|es|zh|tl|vi|ar',
    '- "hazards": array of { type: smoke|flood|aqi|alert, severity: 1..4, title, timing, validFrom, validTo }',
    '- "actions": array of { id, text } - short safety instructions (English text)',
    '- "shelter": null, or { name, distanceKm, status, confidence, hours, verifiedMinutesAgo }',
    '- "blockedRoads": array of { cameraId, name, status, confidence }',
    '- "officialSource": { name, url }',
    '- "emergency": a fixed safety line',
    "",
    "Brief JSON:",
    JSON.stringify(brief, null, 2),
    "",
    "Rules:",
    `- Write "text" in ${LANG_NAMES[brief.lang]} (language code "${brief.lang}"), at most 300 characters.`,
    '- "voiceScript" is what a voice agent reads aloud to the same person, in the same language.',
    "- Work naturally from the hazards and actions; keep the tone calm and direct.",
    "",
    'Reply with ONLY minified JSON, no markdown fences: {"text":"...","voiceScript":"..."}',
  ].join("\n");
}

export interface GeminiRender {
  text: string;
  voiceScript: string;
}

/**
 * One Gemini generateContent call (REST); parse candidates[0] text as the JSON
 * render object. Throws on HTTP error / unparseable output - the caller decides
 * what to fall back to.
 */
export async function callGemini(
  prompt: string,
  apiKey: string,
  opts: { fetcher?: Fetcher } = {},
): Promise<GeminiRender> {
  const doFetch = opts.fetcher ?? fetch;
  const res = await doFetch(`${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.7, maxOutputTokens: 1024 },
    }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Gemini render failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const out = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text ?? "")
    .filter(Boolean)
    .join("");
  const parsed = JSON.parse(out) as { text?: unknown; voiceScript?: unknown };
  if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
    throw new Error("Gemini render: missing text in response JSON");
  }
  return {
    text: parsed.text.trim(),
    voiceScript: typeof parsed.voiceScript === "string" && parsed.voiceScript.trim().length > 0
      ? parsed.voiceScript.trim()
      : parsed.text.trim(),
  };
}

/**
 * Deliver-time deterministic text, built ONLY from brief fields so the safety rule
 * (never name a place/road/number that is not in the brief) holds whenever Gemini
 * is not usable. Moved here from pipeline/run.ts for Task 5.
 */
export function briefText(brief: UserBrief): string {
  const lines: string[] = [];
  const worst = brief.hazards[0];
  if (worst) lines.push(`${worst.title} — ${worst.timing}.`);
  for (const action of brief.actions.slice(0, 2)) lines.push(action.text);
  if (brief.shelter) lines.push(`Open shelter: ${brief.shelter.name}, about ${brief.shelter.distanceKm} km away.`);
  lines.push(brief.emergency);
  return lines.join(" ");
}

export interface RenderArgs {
  brief: UserBrief;
  config: Pick<Config, "geminiApiKey" | "replay">;
  /** Injectable fetch for tests (mock Gemini); defaults to global fetch. */
  fetcher?: Fetcher;
}

export interface RenderedAlert extends GeminiRender {
  source: "gemini" | "brief-fallback";
}

/** Live only when a key is set AND we are not in fixture replay mode. */
export function isLiveRender(config: Pick<Config, "geminiApiKey" | "replay">): boolean {
  return Boolean(config.geminiApiKey) && !config.replay;
}

/**
 * Commit A: one Gemini attempt when live, whatever comes back is delivered;
 * anything that throws (unset key, REPLAY, HTTP/JDGE failure) falls back to the
 * deterministic brief-fields join. No validator, no retry, no staleness gate yet.
 */
export async function renderAlert(args: RenderArgs): Promise<RenderedAlert> {
  if (isLiveRender(args.config)) {
    try {
      const out = await callGemini(promptFor(args.brief), args.config.geminiApiKey as string, { fetcher: args.fetcher });
      return { ...out, source: "gemini" };
    } catch (err) {
      console.error("render: Gemini failed, using brief fallback:", err instanceof Error ? err.message : err);
    }
  }
  const fallback = briefText(args.brief);
  return { text: fallback, voiceScript: fallback, source: "brief-fallback" };
}