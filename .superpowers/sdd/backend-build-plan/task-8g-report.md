# Task 8g report — phone-native demo signup + area brief (backend side)

Status: COMPLETE on main, additive; NO landed route/state-machine code changed — the demo routes DRIVE the same real path the phone could never serve itself (the browser cannot hold the Photon webhook signing secret — the root cause of the onboarding 401s). Verification: tsc clean; hermetic 224 total (213 passed + 11 gated-skip; 217 + 7 new); gated full suite vs Atlas throwaway db `skywatch-8g` → **224/224 twice in a row**; db dropped, verified zero collections. `apps/web` untouched.

## What landed

- `src/config.ts`: `demoSignup` (env **`DEMO_SIGNUP`** exactly, `=== "1"`; default OFF) + `.env.example` entry + README env-table row; `src/index.ts`: the boot WARNING when demo mode is on (mirrors the TOOL_SECRET-warning pattern — nobody should boot production with the backdoor open).
- `src/routes/demo.ts` (new, mounted `/demo` in `routes/index.ts`):
  - **`POST /demo/signup`** `{ phone (E.164), platform: sms|imessage, texts[] }` (≤5 texts × ≤140 chars; violations ⇒ 400 + reasons list):
    for EVERY text the route constructs the FULL Stable Spectrum inbound envelope (the verbatim field shapes from photon-interface.md — event/space/message/sender/content, `any;-;<phone>` space id), SIGNS IT SERVER-SIDE (`v0=` HMAC-SHA256 over `v0:{ts}:{raw}` keyed by PHOTON_WEBHOOK_SIGNING_SECRET — the exact string `verifyPhotonSignature` checks), then drives the app's OWN inbound runtime: `verify()` must return "ok" (else 503: without the signing secret the demo cannot sign — honest failure), `accept(raw)` enqueues into the SAME id-guarded queue, and the route **awaits `drain()`** so the signup state machine HAS actually advanced before the response. It then reads the user by phone through the deliver store and answers `{ok, userId, state, lang, brief, mapLink}` — brief via the byPhone-equivalent `buildUserBrief` over the user's RESOLVED loc (null honestly when no location yet: a 1-text signup returns `brief: null`, not a crash); `mapLink = publicBaseUrl + "/b/" + userId`. NO SIGNUPS SHORTCUT: zero new state logic, `processInbound` untouched, consent granted by the same first-message rule.
  - **Privacy: the phone number is never echoed or logged anywhere beyond the request body** — the response keys on `userId`; a console-spy test asserts no log line carries the phone.
  - **`POST /demo/area-brief`** `{lat, lon}` — the AREA brief for a no-signup phone (Home fallback): the Task 8d point-brief variant (same `buildUserBrief` + validator semantics: hazards + rule-table actions + nearest VERIFIED-OPEN shelter with confidence or null + officialSource + the 911 line); 400 on out-of-range/malformed body; both routes 403 when the gate is off.
- Tests (`apps/api/test/demo.test.ts`, +6 hermetic + 1 gated): 403 gate on both routes; full round-trip (hi → 98104 → "espanol por favor" ⇒ state **active**, lang **es** via the SAME language matchers, brief carries the 98104-resolved hazard + ≥0.5-confidence shelter, mapLink exact, bot replies visible in the outbox via the real send path); real-transition assertions (1 text ⇒ `asked-address` + `brief: null`; 2 texts ⇒ `asked-lang`); validation caps (6 texts / 141 chars / bad phone / bad platform ⇒ 400, zero side effects); area-brief shape + honesty (verified-open shelter rides; an UNvalidated shelter is ABSENT even though the hazard branch is exercised; an all-clear point still carries officialSource + 911); phone-never-logged. Gated: the server-signed signup over defaultDeps lands in the REAL users collection (state asked-lang, 1 row) + area-brief over the real match store; cleanup sweeps its own user row + conversation/outbox rows by userId, and the users phone index is respected.
- README: env-table row + one offline-section-adjacent line (demo onboarding contract).

## Decisions recorded

1. **Gate = single DEMO_SIGNUP knob for both routes** (the brief read is also gated — the demo routes are a package; the /map/state surface remains the ungated public read).
2. **Signing happens per text at request time** (timestamp = route call time, well inside the 5-min replay window) — a demo signup is not a replayable canned batch.
3. **Envelope message ids are random UUIDs** (`demo-msg-<uuid>`): the queue's id-guard dedupes on messageId, so re-POSTing the same demo texts creates a FRESH run instead of being swallowed as webhook retries.
4. **brief: null (not {}) when the loc is unresolved** — honest "not briefed yet" for the app's loader; the state/lang fields still answer.
5. **Area-brief lang = "en"** (no user to infer from); the phone re-renders i18n client-side; the backend validator still guards anything later built FROM this brief.
6. **Honest 503s**: demo gate ON but PHOTON_WEBHOOK_SIGNING_SECRET unset ⇒ 503 ("cannot sign") rather than skipping verification — the route never bypasses the HMAC path it claims to exercise.

## Parks / carries

- `texts` cap 5 / 140 chars is demo-sized; the real webhook path's limits are unchanged.
- The route does not rate-limit (demo-only + env-gated); a hardened variant would need the TOOL_SECRET treatment or a rate gate before any non-demo reuse.
- The map link path `/b/:userId` is a frontend-landing convention — backend only composes the URL.

## Append — Task 8h: POST /demo/brief (continue with the already-SMS-signed-up account)

- Same `DEMO_SIGNUP=1` gate; body `{phone (E.164), platform?: sms|imessage}` (400 on a bad phone shape / union violation). A pure READ: `getUserByPhone` (a `platform` mismatch reads as "no account", mirroring the byPhone route's platform check) → `{ok, userId, state, lang, brief}` — the byPhone-equivalent brief over the user's resolved loc (`brief: null` honestly when the loc isn't set yet); **404 + a fixed honest sentence when no user exists for that phone; the phone is never echoed or logged** (console-spy asserted). No mapLink (the /b/:id page composes it; not in this response's contract).
- `/b/:id` landing-page route (controller append, same commit wave): id-injected `b.html` serve + `window.SKYWATCH_BRIEF_ID` preference — verified live on the deployed service (200 on skywatch-9kvd; see its section in the /b-fix commit).
- Tests: +1 hermetic (gate 403 / honest 404 pre-signup / full round-trip continuing the signed-up account with state+lang+brief / 400 shapes / platform-mismatch 404 / phone-never-logged). Hermetic suite: 233 total (222 passed + 11 gated-skip), 20 files — two consecutive green runs (one first-run collect-latency flake under parallel machine load).