# Task 8f report — Grok Voice TTS (post-call summary audio, SpaceX "Make it Legendary")

Status: COMPLETE on main, additive; the live Photon/ElevenLabs prize path is untouched (the TTS is synthesized alongside the text send and its failure mode is SILENCE). Verification: tsc clean; hermetic 217 total (207 passed + 10 gated-skip; 208 + 9 new); gated full suite vs Atlas throwaway db `skywatch-8f` → **217/217 twice** (first run: the documented checkin.test.ts remote-latency flake — pre-existing class, passes alone + every re-run); db dropped, verified zero collections. No real XAI key was used anywhere — all TTS tests inject the fetcher; the live path is env-gated OFF without `XAI_API_KEY` (documented).

## What landed

- `src/config.ts`: `xaiApiKey` (env **`XAI_API_KEY`**, exact name per notes) + `.env.example` entry + README env-table row.
- `src/deliver/grok-tts.ts` (new):
  - `grokLanguage`: the EXACT map (`en→"en", es→"es-MX", zh→"zh", vi→"vi", ar→"ar-SA"`; **tl → null = Tagalog UNSUPPORTED** by /v1/tts → the caller keeps ElevenLabs/text; no audio synthesized).
  - `synthesize({config, cache?, fetcher?, now?}, text, lang)` → `{sha: sha256(text+lang), lang, contentType: "audio/mpeg", bytes: base64, cached}` **or null**: null for no key/empty text/unsupported lang (ZERO fetch calls); `POST https://api.x.ai/v1/tts` per the notes (`voice_id: "eve"`, Bearer, 5 s `AbortSignal.timeout`); response read BOTH ways (JSON envelope `audio|audio_base64` OR raw binary — and a binary body must carry real mp3 magic (ID3 / MPEG frame-sync), so a stray 200-text/error body fails, not plays); **5 s timeout + ANY failure ⇒ null — never throws, never blocks deliver, feature silently absent** (the same all-or-nothing posture as the 8e satellite section).
  - `TtsCache` (`get/put`, keyed sha256(text+lang)): `mongoTtsCache` (Atlas collection **`tts_cache`**, unique `key` index in db/client.ts — index surface asserted gated) + `memoryTtsCache` (hermetic). **Cache reads BEFORE network** — a hit makes zero HTTP calls.
- Wiring (post-call summary ONLY, per ruling — the alert path does NOT get TTS):
  - `src/deliver/voice.ts` `sendPostCallSummary`: after `postCallSummary(...)` composes the text, `synthesize(text, user.lang)` runs; when audio EXISTS the outbox row's meta gains `audio: {sha, lang, summaryText}` (meta otherwise UNCHANGED — without a key or on failure NO meta rides and the row is byte-identical to the landed 8d-era behavior); the text send itself is untouched.
  - `src/deliver/store.ts`: `OutboxMeta.audio?`, `OutboxRecord.id?` (immutable row handle: Mongo `_id` via docToRecord; memory rows are stamped `mem-outbox-n` at append) + `DeliverStore.getOutboxRow(id)` (malformed/foreign ids read as not-found, never throw — both stores).
  - `src/deliver/voice_runtime.ts`: `ttsCache` rides the stores seam (every field optional with per-field defaults — all landed harness call shapes unaffected); `deps.ts`: OPTIONAL `ttsCache?: () => Promise<TtsCache>` (mesh-dep precedent: landed harnesses untouched; production `defaultDeps` wires Mongo).
  - `src/routes/tools.ts`: `GET /tools/summary-audio/:outboxId` — TOOL_SECRET posture identical to the brief reads (unset = open-read, set = fail-closed 401); streams the cached mp3 (content-type audio/mpeg, `Cache-Control: immutable` — sha-keyed content is deterministic); row-without-audio / unknown row / no cache dep ⇒ 404/503, never a crash.
- README: "Grok Voice summary audio" offline-section line + the `XAI_API_KEY` row. Report = this file.

## Tests (9: 8 hermetic + 1 gated)

- lang-map exactness (es-MX / ar-SA / en / zh / vi / tl→null).
- no-key / empty-text / tl ⇒ null with ZERO fetch calls.
- cache-before-network: two synthesizes same text+lang ⇒ ONE fetch total, second = cache hit, sha = sha256(text+lang), and the request asserts the locked contract (`"voice_id":"eve"`, `es-MX`, `Bearer k`).
- failure matrix: HTTP 500 / JSON-without-audio (accepted-then-magic-rejected as binary)/ network error ⇒ null, nothing cached.
- end-to-end post-call: summary row carries `meta.audio {sha, lang, summaryText}`; `GET /tools/summary-audio/:id` serves the base64 mp3 (200 audio/mpeg, immutable) behind `X-Skywatch-Tool-Secret`; 401 missing/wrong secret; 404 unknown row; second identical post-call = pure cache-hit (still one fetch).
- no-key + Grok-failure: NO meta.audio, deliver completes (text recap shipped, `not_wired` Photon semantics unchanged, conversation entries as before).
- tl user: no fetch, no meta.audio (ElevenLabs/text is the only audio), and a no-audio row reads 404.
- gated real Mongo: `tts_cache` unique `key` index + `mongoTtsCache` put/get/overwrite round-trip (cleans only `8f-test:` keys).

## Decisions recorded

1. **mp3 magic-sniff on the binary branch** (found by the failure test): a 200 with non-audio bytes is a FAILURE (null), not a cache-and-serve — prevents serving a junk "player" from a mis-shaped response.
2. **Envelope field fallback** (`audio` → `audio_base64`): the notes say "base64 audio" without pinning the JSON field name; try the plausible fields, then raw-binary+magic — one unknown shape degrades to null, never crashes the queue.
3. **meta.audio only when audio EXISTS**: the landed summary row (meta unused, "no rendering happened") stays byte-identical on the no-key path — the dashboard keys its player off the presence of `meta.audio`.
4. **OutboxRecord.id is optional/additive** and the memory store stamps ids at append — the dashboard can address rows identically in both stores; row objects built by send.ts get the id at storage time.
5. **Route = streaming bytes, immutable** (a sha-keyed cache row is deterministic forever — same semantics as the 8e photo refs).
6. **Zero risk ordering**: the synthesize call sits BETWEEN the (pure, deterministic) summary composition and the send; every failure shape is a caught throw → null → unchanged text-only row.

## Parks / carries

- The response's JSON field name / binary content-type are UNVERIFIED beyond the notes' batch description — one live call against a real key (`XAI_API_KEY` in Render env) proves the path; the code accepts both shapes.
- `with_timestamps`/word timings unexercised (not needed for the player).
- tl/Tagalog recap audio would need ElevenLabs-side rendering (out of scope tonight, noted for the demo script as "es/zh/vi/ar via Grok, tl via ElevenLabs").
- The alert-fallback text deliberately does NOT get TTS (per ruling: only the post-call summary).