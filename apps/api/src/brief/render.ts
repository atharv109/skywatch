/**
 * The Gemini alert renderer (backend-build-plan.md Task 5).
 *
 * Commit B ("after"): the "before" commit delivered whatever Gemini wrote from the
 * brief JSON; this commit adds the gates — every render passes src/brief/validator.ts
 * (each shelter/road/number the text mentions must be in the brief), entity
 * violations go straight to the pre-translated per-language fallback (no retry:
 * hallucination is not fixed by asking again), format violations (empty, too
 * long, unparseable, HTTP failure) get exactly one retry, and the per-language
 * fallback template is the guarantee behind all of it. When Gemini is unset or
 * REPLAY=1 the fallback template is used directly, no network.
 */
import type { Config } from "../config.ts";
import type { Lang, UserBrief } from "../types/brief.ts";
import { fallbackRender } from "./fallback.ts";
import { validateRendered, hasEntityViolation, type Violation } from "./validator.ts";

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
    "- Use ONLY the facts in the brief: never mention a shelter, road, place, capacity, distance or time that is not in the brief. If \"shelter\" is null, do not name any shelter.",
    "- Use ONLY numbers that already appear in the brief (911 may be used for the emergency line).",
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

export interface RenderArgs {
  brief: UserBrief;
  config: Pick<Config, "geminiApiKey" | "replay">;
  /** Injectable fetch for tests (mock Gemini); defaults to global fetch. */
  fetcher?: Fetcher;
}

export interface RenderedAlert extends GeminiRender {
  source: "gemini" | "fallback";
}

/** Live only when a key is set AND we are not in fixture replay mode. */
export function isLiveRender(config: Pick<Config, "geminiApiKey" | "replay">): boolean {
  return Boolean(config.geminiApiKey) && !config.replay;
}

type Attempt = { ok: true; render: GeminiRender } | { ok: false; violations: Violation[] };

async function attemptGemini(
  brief: UserBrief,
  apiKey: string,
  fetcher?: Fetcher,
): Promise<Attempt> {
  try {
    const render = await callGemini(promptFor(brief), apiKey, { fetcher });
    const verdict = validateRendered(render, brief);
    return verdict.ok ? { ok: true, render } : { ok: false, violations: verdict.violations };
  } catch (err) {
    return { ok: false, violations: [{ kind: "format", detail: err instanceof Error ? err.message : String(err) }] };
  }
}

/**
 * Task 5 render pipeline: live Gemini -> validator -> (format violations only)
 * one retry -> the per-language fallback template. Non-live (unset key /
 * REPLAY=1) is the fallback template directly, with no network call.
 */
export async function renderAlert(args: RenderArgs): Promise<RenderedAlert> {
  if (!isLiveRender(args.config)) {
    return { ...fallbackRender(args.brief), source: "fallback" };
  }
  const apiKey = args.config.geminiApiKey as string;
  const first = await attemptGemini(args.brief, apiKey, args.fetcher);
  if (first.ok) return { ...first.render, source: "gemini" };
  // Entity violation (invented shelter/road/number): no retry on a safety reject.
  if (hasEntityViolation({ ok: false, violations: first.violations })) {
    console.error(
      "render: rejected invented mentions (",
      first.violations.map((v) => v.detail).join("; "),
      ") -> fallback",
    );
    return { ...fallbackRender(args.brief), source: "fallback" };
  }
  const second = await attemptGemini(args.brief, apiKey, args.fetcher);
  if (second.ok) return { ...second.render, source: "gemini" };
  console.error("render: Gemini output invalid twice -> fallback");
  return { ...fallbackRender(args.brief), source: "fallback" };
}