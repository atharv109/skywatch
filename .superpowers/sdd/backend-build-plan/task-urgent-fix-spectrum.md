# URGENT fix round — the real spectrum-ts send path (+ the not_wired→failed relabel)

Status: COMPLETE. Commit `fix(api): spectrum-ts adapter rewritten to the REAL installed SDK surface (+ outbox relabel to_ failed on load bugs)`; pushed for the Render redeploy.

## Root cause + findings (verified live against the INSTALLED package, node 24)

1. **The metapackage's main export has NO `imessage`.** The landed `loadSpectrumSdk()` imported only `"spectrum-ts"` and demanded `mod.imessage` — the real main export is `Emoji, Spectrum, SpectrumCloudError, UnsupportedError, addMember, app, …` (no provider). **`imessage` lives on the SUBPATH `spectrum-ts/providers/imessage`** (exports `imessage` with the `.config()` builder + the platform selector).
2. **The real shape check**: `typeof core.Spectrum === "function" && typeof imessageProvider.imessage === "function" && typeof …config === "function"` (exported `spectrumShapeOk`, unit-tested against the INSTALLED package — no network).
3. **Send path verified from the dist typings** (`@spectrum-ts/core/dist/app-DULwijAH.d.ts`):
   `const app = await Spectrum({projectId, projectSecret, providers:[imessage.config()]})` → `const im = imessage(app)` (PlatformInstance) → `im.space.get(spaceId)` (construct from the persisted id, e.g. `any;-;+1555…`) → `await space.send(text)` (ContentInput overload). `im.user(senderId)` is available for the user→space-create route; the persisted-space-id route is the one a reply needs.
4. **LIVE probe (controller-directed, ONE attempt, real creds from the repo-root .env, target the dead-test number `+15551110000`)**: the FULL chain ran for real — cloud auth accepted the `PHOTON_PROJECT_ID/PROJECT_SECRET`, `imessage` provider selected, then after 4.4 s: **`AuthenticationError: [spectrum-imessage] Target not allowed for this project`** — i.e. the credentials + provider + space/send chain are correct; Spectrum's project-level DESTINATION ALLOWLIST rejected the probe TARGET (the dead-test number is not allowlisted for this project — the user's live number is, since its conversation exists). No further attempts made (no spam); nothing deleted.
5. **Relabel fix (the mislabeling)**: with creds SET, an SDK load/shape failure is now `SpectrumLoadError` → the outbox row says **"failed"** (a visible integration bug); **`not_wired` is now ONLY the genuinely-unset-creds case** (that boundary in `send.ts` was already `NotWiredError → not_wired; everything else → failed` — no send.ts change needed). Runtime SDK errors after load (SpectrumCloudError etc.) were already "failed" — unchanged.
6. **Deploy effect**: Render redeploy re-runs the pending queue's outbound with the REAL send path; the queued texts for the live user (+14258329409, state asked-lang) go out as `sent` (or "failed" with a REAL error message if Photon's allowlist rejects that specific target — now visible either way, not a bogus not_wired).

## Tests

- `deliver.test.ts` — 4 adapter tests (hermetic, no network... EXCEPT one live caveat, see below): unset-creds NotWiredError; creds-set + load-null ⇒ `SpectrumLoadError` (relabel asserted); **real installed package matches `spectrumShapeOk`** (import only); a full FAKE-SDK round-trip asserts the exact call contract (Spectrum auth body with projectId/secret/providers, `space.get(any;-;…)`, `space.send(text)` in order). One landed assertion UPDATED (was: creds-set ⇒ not_wired — it encoded the old "SDK missing" world; now: the relabel ruling).
- tsc clean; hermetic full suite **231 total (220 passed + 11 gated-skip) — all green** (incl. the 8f/9 suites, unaffected).

## Parks / carries

- The dead-test number must be ADDED to the Spectrum project's allowed targets (console) OR the probe re-pointed at the real user's number next time — `Target not allowed` is Photon's authorization, working as designed.
- The allowlist check adds latency BEFORE the error (4.4 s cloud round-trip) — acceptable; the outbox row's message names it exactly.