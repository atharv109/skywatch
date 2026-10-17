# Task 7 report — deploy wiring + Tiger optional mirror + smoke + README

Scope delivered (per task-7 brief; no refactors of landed code):

1. **Render deploy wiring** — `render.yaml` (root): web service, runtime node 20,
   plan free, branch main, build `npm ci && npm run build --workspaces`, start
   `npm run start -w @skywatch/api`, `healthCheckPath /health`; all secret envVars
   `sync: false`; `NODE_VERSION=20` and `REPLAY=1` pinned.
   - `apps/api/package.json`: `"build": "tsc --noEmit -p ."`, `"start": "node --import tsx src/index.ts"` (prod-safe: node process with the tsx ESM loader; tsx is a root devDep so `npm ci` provides it), `"engines": {"node": "20.x"}`.
   - Root `package.json`: `"build": "npm run build --workspaces"`.
   - Build choice documented in render.yaml/README: module imports use `.ts`
     extensions under `allowImportingTsExtensions` + base `noEmit`, so a dist
     emit would touch every landed file (out of Task 7 scope); the build is a
     typecheck gate and the start path is `node --import tsx` over src.

2. **Start-command proof (local, exact render start path):**

```text
$ REPLAY=1 MONGODB_URI="mongodb://127.0.0.1:27017/skywatch-task7-run" PORT=3333 npm run start -w @skywatch/api
> @skywatch/api@0.0.0 start
> node --import tsx src/index.ts
WARNING: TOOL_SECRET is unset — /tools/*, /verify/run and /roads/check accept unauthenticated calls (demo-grade; set TOOL_SECRET before exposing the API)
$ curl http://localhost:3333/health
{"ok":true}
```

   Also proven with `TOOL_SECRET=smoke-secret` set: `GET /tools/brief/<id>` without the header returns 401; with the header the brief is returned.

3. **Env checklist in README** — one table row per var (17 rows incl. the new
   `TIGER_DATABASE_URL`) with purpose / owner (backend|delivery|vision) / where
   it's set (Render env, provider dashboard where relevant) / fail-closed
   semantics (webhook 401s fail-closed for both signing secrets, NOT_WIRED
   sends for Photon creds, in-fixture-only camera sources, Gemini fallback
   templates in REPLAY=1, unauth tool writes when TOOL_SECRET unset). README
   also gained the architecture ASCII (feeds -> ingest -> Mongo -> match/build
   -> render/deliver -> Photon/ElevenLabs, webhooks back in) and the
   "verify before demo" checklist (smoke run; TOOL_SECRET set; Photon signing
   secret on both sides; ElevenLabs agent ids point at brief-caller +
   checkin-caller routes; REPLAY=1).

4. **Tiger optional layer** — `apps/api/src/verify/tiger.ts`:
   `buildStatusEvent(ResourceDoc)` (pure row-shape mapper, null when
   `verifiedAt` null) + `forwardStatusEvents(config, events)` — `pg` client,
   fire-and-forget, self-creating `status_events` table
   `(resource_id, observed_at)` PK + ON CONFLICT DO NOTHING, all failures
   logged only, no-op when `TIGER_DATABASE_URL` unset. Hooked into the check-in
   route only (one added statement in `src/verify/routes.ts`), never blocks the
   pipeline. 3 hermetic tests in `apps/api/test/tiger.test.ts` (row mapping /
   never-verified null / no-op guards). `pg@8.23.1` + `@types/pg` added to
   `apps/api` (install was clean, prebuilt, no compile trouble). Mongo
   `verifiedAt` remains the demo path (per ruling).

5. **Smoke script** — `apps/api/scripts/smoke.ts`, parameterized by
   `SMOKE_BASE_URL` (default `http://localhost:$PORT`/3000), requires
   `MONGODB_URI`, optional `TOOL_SECRET` (sent as `X-Skywatch-Tool-Secret`
   matching `src/tools/auth.ts`). Steps, PASS/FAIL printed per step, exit code
   0/1: /health -> POST /scenario/smoke/replay -> GET /map/state (hazards>0,
   resources>0) -> direct-Mongo seed of a consented, `active` test user placed
   inside a replayed smoke polygon (point verified via the same `$geoIntersects`
   query the match layer uses) -> `GET /tools/brief/:userId` over HTTP ->
   locked-brief shape assertions (userId/lang/hazards, actions<=5 ordered shape,
   shelter null-or-full shape with confidence 0..1 and status open|unknown,
   blockedRoads<=2, officialSource, 911 line, hazards>0 for the in-polygon
   point) -> test user deleted. No new routes were added; signup's Photon
   webhook dependency is bypassed by direct Mongo seeding, per brief.

**Local smoke output (real runs):**

```text
$ MONGODB_URI=... SMOKE_BASE_URL=http://localhost:3333 npx tsx apps/api/scripts/smoke.ts
smoke: base=http://localhost:3333 mongo=(set) toolSecret=(unset)
PASS  1 /health ok
PASS  2 /scenario/smoke/replay
PASS  3 /map/state hazards>0 resources>0
PASS  4 brief end-to-end
PASS  5 privacy: no phone in brief
SMOKE PASS (all steps)

$ # restarted with TOOL_SECRET=smoke-secret, run twice back-to-back (replay idempotence):
smoke: base=http://localhost:3333 mongo=(set) toolSecret=(set)
PASS  1 /health ok
PASS  2 /scenario/smoke/replay
PASS  3 /map/state hazards>0 resources>0
PASS  4 brief end-to-end
PASS  5 privacy: no phone in brief
SMOKE PASS (all steps)   x2

$ curl -o /dev/null -w "%{http_code}" http://localhost:3333/tools/brief/000000000000000000000000
401   # no-secret request against TOOL_SECRET-set server (fail-closed tool auth)
```

Throwaway db `skywatch-task7-run` used for all runs, restored after (dropped).

**Tests:** hermetic 154 pass / 5 skip (was 151+5; +3 tiger). With
`MONGODB_URI` set against local mongod: **159/159 pass**. `npm run build
--workspaces` clean. Typecheck clean.

**Concerns / notes for the controller:**

1. Atlas URI + all provider keys are still NOT provided; the Render deployment
   itself has not been created — the wiring is prove-locally only. The smoke
   has never run against a deployed URL.
2. Deploy "build" is a typecheck gate, not an emitted dist: with
   `allowImportingTsExtensions` + `noEmit` across landed code, emitting a
   `dist/` would have required rewriting every import (out of scope). The
   proven prod path is `node --import tsx src/index.ts`; if Render's node20
   ever fails to load `--import tsx`, fallback is `tsx src/index.ts` (also
   proven in Task 1-6 sessions as the prior start script).
3. TIGER_DATABASE_URL is unset anywhere: the layer is inert by design; the pg
   write path itself is exercised by 0 tests (no Postgres available locally) —
   only the pure builder + guards are tested. Documented NOT-EXERCISED rather
   than NOT-WIRED: the code path exists and pg installed cleanly.
4. Left uncommitted in the working tree (not mine to commit): the controller's
   later-added "Fix round 1" section in
   `.superpowers/sdd/backend-build-plan/task-6-report.md`, and the untracked
   `apps/api/.env.example` Task-4 leftover (left alone per Task 6 report note).
5. `ELEVENLABS_API_KEY` genuinely has no backend code path (backend never
   calls the ElevenLabs API by design); it is in the table so Delivery knows
   it is still required to run their agents.
---

## Fix round 1 (post-review, single commit, not pushed)

Addressed C1 (critical, deploy-blocking) + README minors 1-2 from review; scope guard respected (minors 3-5 ledgered for coordination, not touched).

- **C1:** Render sets `NODE_ENV=production` on Node runtimes, so plain `npm ci` omits devDependencies, leaving both `tsc` (build gate) and `tsx` (start `node --import tsx src/index.ts`) absent. Fixed with both requested belts:
  (a) `tsx@^4.20.6` moved from root devDependencies into `@skywatch/api` dependencies (typescript intentionally stays a build-only dep);
  (b) `render.yaml` buildCommand is now `npm ci --include=dev && npm run build --workspaces` (with an explanatory comment).
- **Deploy-shaped boot proof (fresh install):**
```text
$ rm -rf node_modules
$ NODE_ENV=production npm ci --no-audit --include=dev        # success; lockfile synced first to the moved tsx
$ node -e "require.resolve('tsx')"   -> C:\...\skywatch\node_modules\tsx\dist\loader.mjs  (tsx + typescript present)
$ NODE_ENV=production REPLAY=1 MONGODB_URI="mongodb://127.0.0.1:27017/skywatch-task7-run" PORT=3334 npm run start -w @skywatch/api
> node --import tsx src/index.ts
$ curl http://localhost:3334/health  -> {"ok":true}
$ smoke -> 5/5 PASS
```
- **README minors:** PUBLIC_BASE_URL row now says to set the onrender.com URL after first deploy and redeploy; verify-before-demo gained the free-tier sleep note (~15 min idle, ~50 s cold start; keep-alive via open dashboard tab or manual dashboard resume ~1 min before demo) as item 9; Tiger note renumbered to 10.
- **Re-verification after fix:** gated suite 159/159 (16 files, MONGODB_URI to local mongod, throwaway db `skywatch-task7-run`, dropped after); smoke 5/5 PASS on the NODE_ENV=production boot; typecheck/build unchanged and clean.
- **Ledgered (not mine):** minor 3 (smoke step-5 record behavior), minor 4 (tiger per-checkin pg connection lifetime), minor 5 (untracked apps/api/.env.example still left alone).
- **Correction to the timeline above:** the first fresh `npm ci --include=dev` ran against a not-yet-updated lockfile (npm accepted it); the lockfile was then regenerated with `npm install --package-lock-only` after the commit and the commit amended to include it (`npm ci --dry-run` now reports manifests in sync). The boot proof above used the freshly installed tree from that first ci — the tree content is identical to what the regenerated lock installs (same tsx, no version change).

---

## Fix round 2 (final-review wave, separate commit 0f3bbdc, not pushed)

I1 (demo beat 6, voice.ts only — no store.ts/send.ts edits) + T3 minor (signup.ts, bare ISO codes); scope guard respected.

- **Post-call summary (processVoiceOutcome user path):** after the conversation
  note, `sendPostCallSummary` composes a DETERMINISTIC text (no Gemini, no
  network) from the conversation's `lastBrief` only and sends it through the
  existing deliver path (`toPhoton` + outbox row + conversation entry via
  `sendOutbound`). Composition: hazard title + top action + ("verified" shelter
  only when confidence >= 0.5 AND status open, else "check official source for
  shelter status") + map link `${PUBLIC_BASE_URL}/b/${userId}` (only when
  PUBLIC_BASE_URL is genuinely set in env — config.publicBaseUrl always
  defaults to localhost, which cannot be distinguished from unset) + the brief
  emergency (911) line. Rate-limit exempt BY CONSTRUCTION: kind "alert" with
  reserved rateKey `post-call-summary` that no deliverAlert caller uses for the
  1/user/hazard/2h gate — exemption rationale + provenance marker commented in
  voice.ts (OutboxMeta deliberately unused: no rendering happened). Sends are
  consent-fenced (consentText required); STOPped (record deleted) and revoked
  users get nothing; no lastBrief -> no summary (note still stands); summary
  failure never affects outcome routing (sendOutbound records not_wired/failed
  instead of throwing).
- **Tests (voice.test.ts, +3):** brief outcome -> note AND summary outbox row
  (status not_wired = attempted send with Photon unset) containing title/action/
  map link/emergency, no phone anywhere in outbox; STOPped + revoked-consent
  users -> nothing; pure postCallSummary coverage (confident vs unsure shelter,
  link presence, trailing-slash URL normalization).
- **Bare ISO codes (signup.ts):** `matchLanguage` now answers
  en|es|zh|tl|vi|ar as standalone tokens (trimmed) BEFORE the phrase regexes —
  the ask-language step AND the English-confirm loop both complete on a bare
  "es" (previously it fell into confirm-pending purgatory and looped). Phrases/
  hyphens/non-codes unchanged ("est" is still null).
- **Tests (deliver.test.ts, +3):** bare "es" completes signup directly and the
  state stays active afterwards; "es" escapes the confirm loop after an
  ambiguous reply; matchLanguage table for all six codes + regression cases.
- **Verification:** typecheck clean; hermetic 160 pass / 5 skip (165 total);
  gated suite with MONGODB_URI on local mongod (throwaway db
  `skywatch-fixwave`, dropped after): 165/165, 16 files.
