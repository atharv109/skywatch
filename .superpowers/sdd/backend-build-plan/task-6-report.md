# Task 6 report — Verify + roads + conversational tools

**Commit:** `a8132e9` — `feat(api): check-in tool + verify/run queue + roads/check + conversational tool loop + voice post-call webhook (Task 6)`
**Suite after:** **151 passed / 4 skipped** (15 files; the 4 skips are the MONGODB_URI-gated real-Mongo blocks: 3 pre-existing + 1 new). `npx tsc --noEmit -p apps/api` clean. Not pushed (per instructions).

## What landed (all env names already existed in config.ts — zero new ones)

### 1. `POST /tools/checkin` — ONE endpoint, voice + manual
- `src/verify/checkin.ts` (`applyCheckin`) + `src/verify/routes.ts` (mounted under `/tools`).
- Body `{resourceId, status: open|full|closed|unknown, capacity?, notes?, manual?: true, userId?}`. Status validated 400/404; notes truncated to 200 chars.
- Effects: `resource.status`, `verifiedAt = now`, optional `capacity`, and a `lastCheckin` receipt `{status, manual, notes, at}` stored on the resource doc itself (dashboard/manual-verify UI reads resources, not a check-in collection — no phone exists anywhere in this path).
- **"full"** added to `ResourceStatus` (docs/types): an affirmative at-capacity verdict — never claimed as open by a brief (`match` filters `status: "open"` only); `/map/state` `displayedStatus` shows `"full"`.
- Conversation note ("Check-in for <name>: status <status>.") is appended **only when the caller carries `userId`** — via the shared deliver store (`appendConversation`), no direct conversational writes (T6↔T3 constraint). The voice agent passes the user it holds context for; a dashboard button write omits it.

### 2. `POST /verify/run` + the ONE consumption contract
- `src/verify/run.ts` + `src/verify/store.ts` (memory + Mongo impls); collection **`verify_requests`** registered in `COLLECTIONS` with a **unique `requestId` index** (`db/client.ts`).
- Targeting: `partner: true` resources whose loc falls **inside an active hazard's geometry** (hazard `validFrom <= now < validTo`), reusing `match/geo.pointInGeometry`; one request per resource even across multiple hazards.
- requestId is the deterministic dedupe key `vr:<resourceId>:<hazardSourceId>`: a re-run while a request is pending/dispatched creates nothing; answered/expired requests are re-armed. Idempotent.
- **Server-side consumption contract (chosen, documented): Delivery's Check-in agent POLLS `GET /tools/checkin/next?deviceId=<id>`** — pending requests tagged for that deviceId (or untagged for any dispatcher) are returned and marked `dispatched` (no redelivery). `/verify/run` also returns the created list in its response, but the poll is THE contract because nothing on the backend triggers ElevenLabs. Both under the tool-secret scheme.
- Requests carry `agentId` (from `config.elevenlabsAgentIdCheckin`) and `deviceId` but **never a phone number** — Delivery dials from its own partner contact book keyed by resourceId. No verify data is surfaced on `/map/state` (which reads resources only), so the privacy carry holds trivially.

### 3. `src/roads/` — camera verdicts with the 15-min half-life
- `POST /roads/check` `{cameraId, status clear|flooded|blocked|unknown, confidence 0..1}` (`src/roads/check.ts` + `src/roads/routes.ts`), authed by the tool-secret scheme when `TOOL_SECRET` is set.
- Gate at the door: `confidence < 0.5` (or `> 1`, or non-numeric) is recorded as `status: "unknown"`, `verifiedAt: null` — a sub-threshold verdict can never be stored as flooded/blocked, so `build.ts`'s road-status cast ("only fresh verdicts reach the store") stays true without loosening it. Decay itself is never re-derived: everything reads `src/confidence.ts` (`halfLifeMinutes.road = 15`).
- `AppStore` gained single-doc reads `getResource` / `getRoad` (check-in + roads keep name/loc/image on RMW).
- Adapter seam `src/roads/adapter.ts`: **not wired, by decision** — the API never makes live vision calls (`mode: "not_wired"` either way; `wired` just reports whether `PERCEPTRON_API_KEY` is set, meaning the vision teammate's service POSTS verdicts to `/roads/check`). The response echoes `vision: {}` so the demo can show the seam.

### 4. Conversational tool loop (`src/deliver/chat.ts`)
- Hook: `signup.ts` active case — the gate is **`deliver.lastBrief(userId)`** (new `DeliverStore` method: newest `kind:"alert"` outbox row's `meta.brief`). **No lastBrief ⇒ hold-the-line reply exactly as before** (Task 3 tests untouched; the fixture "question" sample still gets the hold reply).
- Gemini REST tool loop (`gemini-2.0-flash:generateContent`): three tools only — `getBrief`, `getResourceStatus` (by resourceId or name text), `getRoadStatus` (by cameraId or name). **Tool bodies read DB only** (`AppStore` + the lastBrief); they never call `match` or `render`, so a chat question can never trigger a match cycle or a send.
- **Cap: 4 tool rounds + one final round with tool declarations dropped** (so the model must answer); tool outputs are whitelisted-field views (`sourceId/name/kind/status/capacity/verifiedMinutesAgo` for resources; `cameraId/name/status/confidence` for roads, status downgraded below 0.5 via the shared decay) — never an address, never a phone.
- **Same safety rules as alerts**: the reply is `validateRendered(reply, lastBrief)` (Task 5 validator, safety rule 1 applies to chat) — entity violation ⇒ direct per-language fallback (no retry), format violation ⇒ one plain retry, then fallback.
- **Gemini unset / REPLAY=1 ⇒ zero network**, deterministic composition = `fallbackRender(lastBrief)` (lastBrief fields + pre-translated template, the same constant set as alerts).
- Send path unchanged: `signup.ts` delivers the reply via `sendOutbound` (outbox `kind:"reply"`, Photon `toPhoton` NOT_WIRED semantics, conversation turns appended on BOTH sides — the user turn by `processInbound`, the bot turn by `sendOutbound`).

### 5. `POST /webhooks/voice/post-call`
- `src/deliver/voice.ts` + `src/deliver/voice_runtime.ts`, route added to `src/routes/webhooks.ts`.
- **Signature (documented for Delivery):** header `elevenlabs-signature: t=<unix-seconds>,v1=<hex>`; HMAC-SHA256 over `<t>.<rawBody>` keyed by `ELEVENLABS_VOICE_WEBHOOK_SECRET`; ±300 s replay window; **fail-closed 401** when the secret is unset or the signature mismatches (400 on a missing/malformed header).
- Same shape as the Photon webhook: verify on the RAW body, ack `{ok, enqueued}` 200 immediately, process async through the (now generic) id-guarded queue — **dedupe on `conversation_id`** since ElevenLabs retries post-call deliveries.
- Inbound only `post_call_transcription` payloads with an extractable outcome; `post_call_audio` / `call_initiation_failure` / junk ack 200 + enqueue nothing (default-branch rule). Outcome = `analysis.summary` when present, else the user's last spoken turn (capped 400 chars).
- **Conversation key (chosen, documented):** `data.user_id` — when present it IS the SkywatchUserId (Delivery sets it as the ElevenLabs custom `user_id`); the outcome is appended to that user's conversation as a bot entry. Fallback (no usable `user_id`): `data.agent_id` is matched against the most recent **dispatched** `verify_requests` doc (the `agentId` recorded at `/verify/run`) and the outcome is recorded on that request (`status: "answered"`, outcome, conversationId) — a partner-resource check-in has no user conversation to append to. Anything else: acked, logged with no personal data.

### Shared auth helper
- `src/tools/auth.ts`: the scheme is now single-source — `X-Skywatch-Tool-Secret: <TOOL_SECRET>` **or** `Authorization: Bearer <TOOL_SECRET>`; checked only when `TOOL_SECRET` is set (unset = unauthenticated, same demo-grade decision as Task 4, header names read case-insensitively for both Hono header shapes). `routes/tools.ts` (Task 4 endpoints) refitted onto it; the shared-secret audit test in `match.test.ts` now covers every Task-6 source file too (no console.log/info, no `${}` log lines).

## Tests (23 new across `test/checkin.test.ts` 9, `test/voice.test.ts` 5, `test/chat.test.ts` 7, + 1 real-Mongo gated, + audit extension)

- checkin flips a resource open and the flip is visible in the **next brief** (shelter match + confidence just decayed) **and in `/map/state`**; `manual: true` on the SAME endpoint (notes stored, `"full"` on the map); conversation note only with `userId`; validation 400s/404/notes truncation.
- verify/run: created for the partner inside the active hazard (exact `vr:` requestId, deviceId carried), **none for a non-partner or outside-geometry resource**, none on an expired hazard; idempotent re-run; the poll endpoint hands out once then stays empty; **no phone anywhere in the response**; 401 when `TOOL_SECRET` is set and the header is missing/wrong; both accepted header forms.
- roads: flooded@0.9 stored + lands in the brief; **confidence < 0.5 stored unknown + excluded from the brief**; `confidence > 1` treated unknown; clear resets the assertion; 404/400 paths; vision seam always `mode: "not_wired"`.
- post-call HMAC: 400 missing header / 401 bad signature / **401 fail-closed with no server secret** / good signature accepted; outcome appended to the conversation keyed on `data.user_id`; agent_id fallback answers the dispatched verify request (and writes NO conversation); retry dedupe on conversation_id; non-transcription event types ack+drop; `outcomeFor` extraction order.
- chat: mocked Gemini loop (tool call → validated answer; history + question present in the prompts; functionResponse fed back); **cap enforced** (4 tool rounds + 1 no-tool final round with no `functionDeclarations` in the body); invented-shelter entity violation ⇒ exact `fallbackRender(lastBrief)` output; Gemini network failure ⇒ fallback; unset key / REPLAY=1 ⇒ zero fetch calls; tool outputs carry only whitelisted fields (no address/phone); unknown tool errors.
- Deliver round-trip over the signed Photon webhook: active user WITH a lastBrief gets the composed (validator-safe) answer through `sendOutbound` (outbox `kind:"reply"` `not_wired`, both-direction turns recorded); active user WITHOUT a lastBrief keeps the hold-the-line text ⇒ **SMS-gate interplay unchanged** (all pre-existing deliver/rate-gate tests still green).
- Real-Mongo gated (`MONGODB_URI`): `applyCheckin` write path on `mongoStore` + the `verify_requests` unique index + Mongo verify store create/dedupe/checkout; cleans its own docs.

## Documents for Delivery (the exact integration surface)

- Auth: send `Authorization: Bearer $TOOL_SECRET` (or the custom header) on `/tools/checkin`, `/tools/checkin/next`, `/verify/run`, `/roads/check` when the backend has `TOOL_SECRET` set.
- Consuming the queue: poll `GET /tools/checkin/next?deviceId=<your device id>` (requests come back `dispatched` exactly once), dial the resource from your own partner contact book by `resourceId`, and mid-call set the ElevenLabs custom `user_id` = the Skywatch user id you hold context for, so the post-call webhook routes the outcome to the right conversation.
- Post-call webhook: point the workspace Agents-settings webhook at `POST {PUBLIC_BASE_URL}/webhooks/voice/post-call`; signature is `elevenlabs-signature: t=<unix>,v1=hex(HMAC_SHA256(secret, "<t>.<rawBody>"))`; must return 200 (the backend acks immediately and processes async; repeated deliveries dedupe on `conversation_id`).

## Concerns / honest limits

1. **The check-in "conversation note" requires an explicit `userId` in the body.** The phrase "appends to any active conversation log for that user" has no inherent user for a resource-targeted check-in (partners, not users, are called); the caller carries the user context. Without `userId`, nothing conversational is written and the resource update still lands.
2. **Post-call routing fallback is agent-based, not user-based:** a check-in call with no `user_id` updates the most recent dispatched `verify_requests` doc for that `agent_id` — if two check-in calls for different resources race inside one dispatch cycle, the second outcome could land on the first request. In the single-agent demo flow this cannot happen (requests are dispatched serially per deviceId; `latestDispatchedByAgent` requires status `dispatched`), but it is a documented seam, not a claim.
3. **Signature format assumption:** the `t=,v1=` scheme over `<ts>.<body>` follows the documented ElevenLabs SDK behavior (`webhooks.constructEvent`); the notes pages fetched for `elevenlabs-sip-notes.md` did not print the header format verbatim, so Delivery should confirm against their Agents-settings page (the verifier is one small function in `voice.ts` if it differs).
4. **Capacity can never appear in a chat/alert reply:** the Task 5 validator still rejects capacity-like claims (the locked brief has no capacity field) — capacity is only visible on the map/dashboard resource surface. Intended, but worth knowing: an agent asked "how many beds?" gets the fallback wording.
5. **Chat cap overflow behavior:** when the model spends all 4 rounds on tool calls, the final no-tool round's output is validated; if even that fails, the reply is the fallback composition (with `toolsUsed` preserved so the transcript stays explainable).
6. Untracked `apps/api/.env.example` (Task 4 review leftover) predates this task; left alone — root `.env.example` already covers `TOOL_SECRET`.