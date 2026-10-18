/**
 * Task 8f — Grok Voice TTS (xAI) for the post-call summary audio (SpaceX track).
 * Contract (skywatch-notes/grok-voice-notes.md, verified 2026-10-17):
 *   POST https://api.x.ai/v1/tts, `Authorization: Bearer $XAI_API_KEY`,
 *   JSON body { text, voice_id: "eve", language } -> base64 MP3 audio
 *   ($15/1M chars — recap-scale cheap). Language codes are exact: es -> "es-MX",
 *   ar -> "ar-SA"; plain "ar", "en"... map below; **tl (Tagalog) UNSUPPORTED** ->
 *   null -> the caller keeps the existing ElevenLabs/text path (no audio).
 *
 * Postures (identical to Task 8e's satellite): 5 s timeout, ANY failure -> null —
 * the feature is silently ABSENT and the deliver path NEVER blocks on it. MP3s are
 * CACHED in the tts_cache Atlas collection keyed by sha256(text+lang); the cache is
 * read BEFORE the network (a cache hit makes zero HTTP calls). The whole feature is
 * env-gated off without XAI_API_KEY (tests inject the fetcher; the live path never
 * runs locally).
 */
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { Config } from "../config.ts";
import type { Lang } from "../types/brief.ts";
import { COLLECTIONS } from "../db/client.ts";

export const GROK_TTS_URL = "https://api.x.ai/v1/tts";
/** The xAI docs' default voice (28 built-in; "eve" is the catalog default). */
export const GROK_TTS_VOICE_ID = "eve";
export const GROK_TTS_TIMEOUT_MS = 5_000;

/** Skywatch brief lang -> the EXACT xAI /v1/tts language code; null = unsupported (text-only path). */
export function grokLanguage(lang: Lang): string | null {
  switch (lang) {
    case "en":
      return "en";
    case "es":
      return "es-MX";
    case "zh":
      return "zh";
    case "tl":
      return null; // Tagalog is NOT supported by /v1/tts (notes §2)
    case "vi":
      return "vi";
    case "ar":
      return "ar-SA"; // plain "ar" unsupported — the notes' exact variant
  }
}

/** The MP3 cache (Atlas `tts_cache`): keyed by sha256(text+lang); `bytes` is base64 mp3. */
export interface TtsCache {
  get(key: string): Promise<{ contentType: "audio/mpeg"; bytes: string; ts: number } | null>;
  put(row: { key: string; contentType: "audio/mpeg"; bytes: string; ts: number }): Promise<void>;
}

export function mongoTtsCache(db: Db): TtsCache {
  const col = db.collection<Record<string, unknown>>(COLLECTIONS.ttsCache);
  return {
    async get(key) {
      const doc = (await col.findOne({ key }, { projection: { _id: 0 } })) as { contentType?: string; bytes?: string; ts?: number } | null;
      if (!doc || typeof doc.bytes !== "string") return null;
      return { contentType: (doc.contentType ?? "audio/mpeg") as "audio/mpeg", bytes: doc.bytes, ts: doc.ts ?? 0 };
    },
    async put(row) {
      await col.replaceOne({ key: row.key }, row as never, { upsert: true });
    },
  };
}

export function memoryTtsCache(): TtsCache {
  const rows = new Map<string, { contentType: "audio/mpeg"; bytes: string; ts: number }>();
  return {
    async get(key) {
      return rows.get(key) ?? null;
    },
    async put(row) {
      rows.set(row.key, { ...row });
    },
  };
}

export interface GrokTtsResult {
  /** sha256(text+lang) — the tts_cache key (this goes on the outbox meta). */
  sha: string;
  lang: string;
  contentType: "audio/mpeg";
  /** base64 mp3 bytes. */
  bytes: string;
  cached: boolean;
}

/**
 * synthesize(text, lang) -> mp3 result or null (unsupported lang / no key / fetch
 * failure / timeout). Cache reads precede the network; a success writes the cache.
 */
export async function synthesize(
  deps: { config: Pick<Config, "xaiApiKey">; cache?: TtsCache; fetcher?: typeof fetch; now?: number },
  text: string,
  lang: Lang,
): Promise<GrokTtsResult | null> {
  const code = grokLanguage(lang);
  if (code === null || !deps.config.xaiApiKey || text.trim().length === 0) return null;
  const sha = createHash("sha256").update(`${text}${lang}`).digest("hex");
  const now = deps.now ?? Date.now();
  // Cache BEFORE network: a hit never makes an HTTP call.
  if (deps.cache) {
    const hit = await deps.cache.get(sha);
    if (hit) return { sha, lang: code, contentType: hit.contentType, bytes: hit.bytes, cached: true };
  }
  try {
    const doFetch = deps.fetcher ?? fetch;
    const res = await doFetch(GROK_TTS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.config.xaiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice_id: GROK_TTS_VOICE_ID, language: code }),
      signal: AbortSignal.timeout(GROK_TTS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Grok TTS failed: HTTP ${res.status}`);
    // The batch call answers with base64 audio (JSON envelope) — read the raw bytes
    // too: a later api shape change must not crash the path here (all-else -> null).
    const resCt = res.headers.get("content-type") ?? "";
    let bytes: string;
    let contentType: "audio/mpeg" = "audio/mpeg";
    if (resCt.includes("json")) {
      const body = (await res.json()) as Record<string, unknown>;
      const field = body["audio"] ?? body["audio_base64"] ?? body["b64_audio"];
      if (typeof field !== "string" || field.length === 0) throw new Error("Grok TTS response carries no base64 audio");
      bytes = field;
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error("Grok TTS response is empty");
      const b0 = buf[0] ?? 0;
      const b1 = buf[1] ?? 0;
      const b2 = buf[2] ?? 0;
      // Only real mp3 audio passes: an ID3 header or an MPEG frame-sync start
      // (a stray 200 text/HTML error body is a failure, not an mp3).
      const isMp3 = (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) || (b0 === 0xff && (b1 & 0xe0) === 0xe0);
      if (!isMp3) throw new Error("Grok TTS response is not mp3 audio");
      bytes = buf.toString("base64");
      const ct = resCt.split(";")[0] ?? "";
      if (ct.startsWith("audio/")) contentType = ct as "audio/mpeg";
    }
    if (deps.cache) await deps.cache.put({ key: sha, contentType, bytes, ts: now });
    return { sha, lang: code, contentType, bytes, cached: false };
  } catch (err) {
    console.error("grok-tts failed (no audio, deliver unaffected):", err instanceof Error ? err.message : err);
    return null;
  }
}