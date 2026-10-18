# Task 9 report — GEMINI_LIVE_IN_REPLAY (one knob: live Gemini inside replay mode)

Status: COMPLETE on main — a TWO-GATE change rendered as ONE knob. The fail-safe chain is untouched and verified identical in both modes. Verification: tsc clean; hermetic full suite **228 total (217 passed + 11 gated-skip) — everything green, zero landed-test changes**. ATLAS GATED RUN DELIBERATELY SKIPPED per the fix-round scope ruling: the change is READ-PATH ONLY (a boolean in the render/chat gate + a config boolean) — no store, no route, no write path changed, so there is no Mongo-shaped behavior to gate-verify; every reachable behavior is asserted hermetically (the four knob matrix tests).

## What landed

- `src/config.ts`: `geminiLiveInReplay: env["GEMINI_LIVE_IN_REPLAY"] === "1"` (default OFF — today's posture byte-identical).
- `src/brief/render.ts` — the render gate: `isLiveRender = Boolean(key) && (!replay || geminiLiveInReplay === true)`, with the 2-line knob comment ("demo: fixtures move, wording can still be live — one knob"). The `Pick`s that type the gate (`RenderArgs.config`, chat's `ChatArgs.config`, pipeline's `PipelineCtx.config`) gain the field — full `Config` callers are structurally unaffected.
- `src/deliver/chat.ts` — the chat loop's gate MIRRORS the same exported `isLiveRender` (single source of truth; the two gates can never drift), + the same comment. The fail-safe chain is EXACTLY as landed: validator → one retry (format violations) → per-lang fallback; a live-Gemini HTTP/validator failure under REPLAY = fallback render (never a dead beat-6).
- `.env.example` (+ `GEMINI_LIVE_IN_REPLAY=` stanza) + README env-table row (lead ownership, demo-only).
- Tests (`apps/api/test/gemini-live-replay.test.ts`, +4 hermetic; the render-path mock speaks the JSON render-object dialect, the chat-path mock the plain-text dialect — exactly their production shapes):
  1. knob OFF (default): REPLAY=1 + key ⇒ fallback render AND fallback chat with ZERO fetch calls (the landed posture).
  2. knob ON + key + REPLAY=1: live answer (source "gemini", validator-passing text), EXACTLY one Gemini call per path; chat source "gemini" too.
  3. knob ON but the live call fails (500): fallback render + fallback chat asserted byte-identical to the deterministic composition — and the fetch WAS attempted (the knob genuinely turned the path on, the fail-safe caught it).
  4. sanity: REPLAY=0 with the knob on ⇒ live (unchanged behavior).

## Decisions recorded

1. **The chat gate reuses render.ts's exported `isLiveRender`** (it already did — Task 9's comment documents the knob at both sites); one knob = one implementation, the "two gates" in the dispatch are one function.
2. **Knob is independent of the mesh/chat config Picks' shapes** — optional-field semantics: unset ⇒ false ⇒ unchanged.
3. **No REPLAY-fixture coupling**: the live render still validates against the SAME fixture-built brief the replay path composes, so live wording is provably entity-safe by the landed validator.
4. **Gated Atlas run skipped by ruling**, documented here: read-path-only boolean; hermetic matrix covers every reachable state (knob × key × replay × success/failure).

## Parks / carries

- A live beat-6 Q&A under replay consumes Gemini quota per demo re-run — turn the knob off (or keep REPLAY=1 default posture) when rehearsing.
- The knob does not touch the other Task 8f/8e env gates (`XAI_API_KEY`, `SKYWATCH_LIVE_SYNC`) — each remains its own demo surface.