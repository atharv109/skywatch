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