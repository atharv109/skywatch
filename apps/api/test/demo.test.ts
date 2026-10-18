import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "mongodb";
import { loadConfig, type Config } from "../src/config.ts";
import { COLLECTIONS, closeDb, getDb } from "../src/db/client.ts";
import { createApp } from "../src/server.ts";
import { memoryStore } from "../src/store.ts";
import { memoryMatchStore } from "../src/match/store.ts";
import { memoryDeliverStore } from "../src/deliver/store.ts";
import { createInboundRuntime, stubInboundRuntime } from "../src/deliver/runtime.ts";
import { memoryVerifyStore } from "../src/verify/store.ts";
import { stubVoiceRuntime } from "../src/deliver/voice_runtime.ts";
import { emptyPipelineResult } from "../src/pipeline/run.ts";
import type { HazardDoc, ResourceDoc } from "../src/types/docs.ts";

// A REAL module clock (the routes brief at Date.now() — hazard windows built off a
// pinned past NOW would read expired and the briefs would honestly go empty).
const NOW = Date.now();
const PHONE = "+15557770001";

/** 98104's fixture coordinate (zips-wa.tsv) — the ZIP resolves with NO network (bare-ZIP fixture path). */
function zipPoint(zip: string): [number, number] {
  for (const line of FIXTURES_ROWS()) {
    const [z, lat, lon] = line.split("\t");
    if (z === zip) return [Number(lon), Number(lat)];
  }
  throw new Error(`zip ${zip} missing from the fixture table`);
}

// FIXTURES_DIR (src/deliver/signup.ts's resolveLocation source of truth) resolved from this file's location.
function FIXTURES_ROWS(): string[] {
  const dir = new URL("../fixtures/", import.meta.url);
  return readFileSync(fileURLToPath(new URL("./zips-wa.tsv", dir)), "utf8").split(/\r?\n/);
}

const [ZIP_LON, ZIP_LAT] = zipPoint("98104");

const hazardAround = (sourceId: string): HazardDoc => ({
  sourceId,
  type: "smoke",
  severity: 3,
  title: "8g smoke plume",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [ZIP_LON - 0.3, ZIP_LAT - 0.3],
        [ZIP_LON + 0.3, ZIP_LAT - 0.3],
        [ZIP_LON + 0.3, ZIP_LAT + 0.3],
        [ZIP_LON - 0.3, ZIP_LAT + 0.3],
        [ZIP_LON - 0.3, ZIP_LAT - 0.3],
      ],
    ],
  },
  validFrom: NOW - 60_000,
  validTo: NOW + 3_600_000,
  source: "test",
});

const shelterNear = (over: Partial<ResourceDoc> = {}): ResourceDoc => ({
  sourceId: "8g-shelter",
  kind: "shelter",
  name: "8g Test Shelter",
  partner: false,
  status: "open",
  verifiedAt: NOW,
  loc: { type: "Point", coordinates: [ZIP_LON + 0.01, ZIP_LAT + 0.01] },
  ...over,
});

interface HarnessOpts {
  env?: Record<string, string>;
  hazards?: HazardDoc[];
  resources?: ResourceDoc[];
}

function harness(opts: HarnessOpts = {}) {
  const logs: string[] = [];
  const astore = memoryStore();
  for (const h of opts.hazards ?? []) void astore.upsertHazard(h);
  for (const r of opts.resources ?? []) void astore.upsertResource(r);
  const dstore = memoryDeliverStore();
  const config = loadConfig({
    ...(opts.env ?? {}),
    // the demo route's signing prerequisite (every harness carries it; the gate test turns DEMO_SIGNUP off)
    PHOTON_WEBHOOK_SIGNING_SECRET: "demo-secret",
    PUBLIC_BASE_URL: "https://demo.example",
    REPLAY: "1",
  });
  const inbound = createInboundRuntime({
    config,
    store: async () => dstore,
    now: () => NOW,
    geocode: async () => null,
    appStore: async () => astore,
  });
  const app = createApp(config, {
    store: async () => astore,
    pipeline: async () => emptyPipelineResult(),
    inbound,
    match: async () => memoryMatchStore(astore),
    deliver: async () => dstore,
    verify: async () => memoryVerifyStore(),
    voice: stubVoiceRuntime(),
  });
  // Capture every console line so the tests can prove the phone is never logged.
  vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => logs.push(args.map(String).join(" ")));
  return { app, astore, dstore, config, logs: { lines: logs } };
}

const signup = async (h: ReturnType<typeof harness>, body: Record<string, unknown>): Promise<Response> =>
  h.app.request("/demo/signup", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

const areaBrief = async (h: ReturnType<typeof harness>, body: Record<string, unknown>): Promise<Response> =>
  h.app.request("/demo/area-brief", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("Task 8g: demo gate (env-gated, honest)", () => {
  it("403 on BOTH /demo routes when DEMO_SIGNUP is unset (default posture)", async () => {
    const h = harness();
    expect((await signup(h, { phone: PHONE, platform: "sms", texts: ["hi"] })).status).toBe(403);
    expect((await areaBrief(h, { lat: ZIP_LAT, lon: ZIP_LON })).status).toBe(403);
  });
});

describe("Task 8g: POST /demo/signup (server-signed real signup path)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("round-trip: hi -> 98104 -> espanol por favor drives the REAL state machine to active + the byPhone-equivalent brief", async () => {
    const h = harness({
      env: { DEMO_SIGNUP: "1" },
      hazards: [hazardAround("hms-smoke:8g")],
      resources: [shelterNear()],
    });
    const res = await signup(h, { phone: PHONE, platform: "sms", texts: ["hi", "98104", "espanol por favor"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      userId: string;
      state: string;
      lang: string;
      brief: { hazards: Array<{ title: string }>; shelter: { name: string; confidence: number } | null; officialSource: unknown; emergency: string };
      mapLink: string;
    };
    expect(body.ok).toBe(true);
    expect(body.state).toBe("active"); // the LAST signup state after the texts (not a shortcut)
    expect(body.lang).toBe("es"); // "espanol por favor" detected by the SAME matchers
    const stored = await h.dstore.getUserByPhone(PHONE);
    expect(stored?.state).toBe("active");
    expect(body.userId).toBe(stored!.id);
    // brief = the user's OWN resolved loc (98104 fixture point): hazard + verified shelter ride
    expect(body.brief.hazards.map((h) => h.title)).toContain("8g smoke plume");
    expect(body.brief.shelter).not.toBeNull();
    expect(body.brief.shelter!.confidence).toBeGreaterThanOrEqual(0.5);
    expect(body.mapLink).toBe(`https://demo.example/b/${body.userId}`);
    // the outbox carries the bot's replies through the REAL send path (not_wired = Photon unset)
    const outbox = await h.dstore.listOutbox();
    expect(outbox.length).toBeGreaterThanOrEqual(1);
    // the phone is NEVER echoed beyond the request body — no console line carries it
    expect(h.logs.lines.some((l) => l.includes(PHONE))).toBe(false);
  });

  it("state transitions are real (not a shortcut): 1 text -> asked-address, 2 texts -> asked-lang with loc resolved", async () => {
    const h = harness({ env: { DEMO_SIGNUP: "1" } });
    const one = (await (await signup(h, { phone: PHONE, platform: "sms", texts: ["hi"] })).json()) as { state: string; brief: unknown };
    expect(one.state).toBe("asked-address");
    expect(one.brief).toBeNull(); // no resolved location yet — honest null, no crash

    const phone2 = "+15557770002";
    const two = (await (await signup(h, { phone: phone2, platform: "sms", texts: ["hi", "98104"] })).json()) as { state: string; brief: { hazards: unknown[] } | null };
    expect(two.state).toBe("asked-lang");
    expect(Boolean(two.brief)).toBe((await h.dstore.getUserByPhone(phone2))?.loc !== null);
  });

  it("validation: caps + shapes are 400 with reasons; no side effects on bad input", async () => {
    const h = harness({ env: { DEMO_SIGNUP: "1" } });
    const sixTexts = await signup(h, { phone: PHONE, platform: "sms", texts: ["hi", "hi", "hi", "hi", "hi", "hi"] });
    expect(sixTexts.status).toBe(400);
    const longText = await signup(h, { phone: PHONE, platform: "sms", texts: ["x".repeat(141)] });
    expect(longText.status).toBe(400);
    const badPhone = await signup(h, { phone: "5551234", platform: "sms", texts: ["hi"] });
    expect(badPhone.status).toBe(400);
    const badPlatform = await signup(h, { phone: PHONE, platform: "web", texts: ["hi"] });
    expect(badPlatform.status).toBe(400);
    expect((await h.dstore.listOutbox())).toHaveLength(0); // nothing drove the state machine
  });
});

describe("Task 8g: POST /demo/area-brief (point brief from current map data, no signup)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shape: hazards + actions + shelter + officialSource + 911; honesty: an UNvalidated shelter is absent (null)", async () => {
    // validated-open shelter: rides
    const h1 = harness({ env: { DEMO_SIGNUP: "1" }, hazards: [hazardAround("hms-smoke:8g-area")], resources: [shelterNear()] });
    const ok = (await (await areaBrief(h1, { lat: ZIP_LAT, lon: ZIP_LON })).json()) as {
      ok: boolean;
      lang: string;
      brief: { hazards: Array<{ title: string }>; actions: Array<{ id: string }>; shelter: { name: string } | null; officialSource: { name: string }; emergency: string };
    };
    expect(ok.ok).toBe(true);
    expect(ok.brief.hazards.map((h) => h.title)).toContain("8g smoke plume");
    expect(ok.brief.shelter?.name).toBe("8g Test Shelter");
    expect(ok.brief.actions.length).toBeGreaterThan(0);
    expect(ok.brief.officialSource.name).toBeTruthy();
    expect(ok.brief.emergency).toContain("911");

    // unverified shelter (never checked in): shelter MUST be null (nothing claims an open shelter)
    const h2 = harness({
      env: { DEMO_SIGNUP: "1" },
      hazards: [hazardAround("hms-smoke:8g-area2")],
      resources: [shelterNear({ verifiedAt: null, sourceId: "8g-shelter-unverified" })],
    });
    const honest = (await (await areaBrief(h2, { lat: ZIP_LAT, lon: ZIP_LON })).json()) as { brief: { hazards: unknown[]; shelter: unknown } };
    expect(honest.brief.hazards).toHaveLength(1); // the hazard path still works (we ARE exercising the shelter branch)
    expect(honest.brief.shelter).toBeNull();

    // all-clear point far away: empty hazards, the brief still carries officialSource + 911
    const h3 = harness({ env: { DEMO_SIGNUP: "1" } });
    const clear = (await (await areaBrief(h3, { lat: 20.0, lon: 20.0 })).json()) as { brief: { hazards: unknown[]; emergency: string; officialSource: unknown } };
    expect(clear.brief.hazards).toHaveLength(0);
    expect(clear.brief.emergency).toContain("911");
    expect(clear.brief.officialSource).toBeTruthy();
    expect(h3.logs.lines.some((l) => l.includes("+15557770001"))).toBe(false);
  });

  it("403 gate + malformed body 400", async () => {
    const h0 = harness();
    expect((await areaBrief(h0, { lat: ZIP_LAT, lon: ZIP_LON })).status).toBe(403);
    const h = harness({ env: { DEMO_SIGNUP: "1" } });
    expect((await areaBrief(h, { lat: "x", lon: ZIP_LON })).status).toBe(400);
    expect((await areaBrief(h, { lat: 99, lon: ZIP_LON })).status).toBe(400);
  });
});

describe("Task 8g: GET /b/:id (brief map-link page, id-injected)", () => {
  it("serves the copied b.html with window.SKYWATCH_BRIEF_ID injected before </head>; a garbage id is a 404", async () => {
    const h = harness(); // route is static-file serving: no gate, no store involved
    const id = "6f48aa91c2e77b3d5601a2bb";
    const res = await h.app.request(`/b/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`window.SKYWATCH_BRIEF_ID="${id}"`);
    expect(html.indexOf(`window.SKYWATCH_BRIEF_ID="${id}"`)).toBeLessThan(html.indexOf("</head>"));
    expect(html).toContain("Skywatch"); // the actual page body rode the injection
    // uppercase/short/naked ids are never an injection surface
    expect((await h.app.request("/b/ABCDEF")).status).toBe(404);
    expect((await h.app.request("/b/short")).status).toBe(404);
    expect((await h.app.request("/b/<script>")).status).toBe(404);
  });
});

// Real-Mongo block: the demo route over defaultDeps (same real signup path the
// webhook route serves; cleans ONLY its own keys).
describe.skipIf(!process.env.MONGODB_URI)("real Mongo: /demo/signup + /demo/area-brief (8g)", () => {
  it("a server-signed signup lands in the REAL users collection and the brief serves; cleanup restores the collections", async () => {
    const { defaultDeps } = await import("../src/deps.ts");
    const config = loadConfig({
      ...process.env,
      DEMO_SIGNUP: "1",
      PHOTON_WEBHOOK_SIGNING_SECRET: "demo-secret-real",
      PUBLIC_BASE_URL: "https://demo.example",
    });
    const deps = defaultDeps(config);
    const app = createApp(config, deps);
    const db = await getDb(config);
    await db.collection(COLLECTIONS.users).deleteMany({ phone: PHONE });
    try {
      const res = await app.request("/demo/signup", {
        method: "POST",
        body: JSON.stringify({ phone: PHONE, platform: "sms", texts: ["hi", "98104"] }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; state: string; userId: string };
      expect(body.ok).toBe(true);
      expect(body.state).toBe("asked-lang");
      const count = await db.collection(COLLECTIONS.users).countDocuments({ phone: PHONE });
      expect(count).toBe(1);
      // area-brief over the real match store (empty map data far away -> all-clear shape)
      const ab = await app.request("/demo/area-brief", {
        method: "POST",
        body: JSON.stringify({ lat: 20.0, lon: 20.0 }),
        headers: { "content-type": "application/json" },
      });
      expect(ab.status).toBe(200);
      expect(((await ab.json()) as { brief: { hazards: unknown[] } }).brief.hazards).toHaveLength(0);

      // Sweep ONLY this test's keys: the user row + its conversation/outbox rows.
      const row = await db.collection(COLLECTIONS.users).findOne({ phone: PHONE });
      const userId = row ? String(row["_id"]) : body.userId;
      await db.collection(COLLECTIONS.users).deleteOne({ phone: PHONE });
      await db.collection(COLLECTIONS.conversations).deleteMany({ userId });
      await db.collection(COLLECTIONS.outbox).deleteMany({ userId });
    } finally {
      await db.collection(COLLECTIONS.users).deleteMany({ phone: PHONE });
      await closeDb();
    }
  }, 60_000);

  afterAll(async () => {
    const db = await getDb(loadConfig());
    await db.collection(COLLECTIONS.users).deleteMany({ phone: PHONE });
    await closeDb();
  });
});