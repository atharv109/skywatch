/**
 * Task 7 final smoke: exercise the demo path end to end over HTTP.
 *   1. GET /health
 *   2. POST /scenario/smoke/replay (fixture load into Mongo + pipeline)
 *   3. GET /map/state (hazards > 0, resources > 0)
 *   4. Seed a test user directly into Mongo (consent + loc inside a replayed
 *      smoke polygon), GET /tools/brief/:userId over HTTP, assert the locked
 *      brief shape, delete the user.
 *
 * Env:
 *   SMOKE_BASE_URL — where the API is running (default http://localhost:$PORT or :3000)
 *   MONGODB_URI    — required (same db the app is running against, so /tools/brief reads it)
 *   TOOL_SECRET    — optional; sent as X-Skywatch-Tool-Secret when set (matches src/tools/auth.ts)
 *
 * Run: npx tsx apps/api/scripts/smoke.ts   — prints PASS/FAIL per step, exit 0/1.
 */
import { MongoClient } from "mongodb";

const BASE = process.env["SMOKE_BASE_URL"] ?? `http://localhost:${process.env["PORT"] ?? "3000"}`;
const MONGODB_URI = process.env["MONGODB_URI"] ?? null;
const TOOL_SECRET = process.env["TOOL_SECRET"] ?? null;

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: StepResult[] = [];
function record(name: string, ok: boolean, detail: string): boolean {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${ok ? "" : "— " + detail}`);
  return ok;
}

/** Build briefable user fields exactly as the smoke requires (SignupState active + both consents). */
function testUserDoc(loc: { type: "Point"; coordinates: [number, number] }): Record<string, unknown> {
  const now = Date.now();
  const phone = `+1999${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  return {
    phone,
    platform: "sms",
    spaceId: `smoke-test;-;${phone}`,
    lang: "en",
    state: "active",
    loc,
    zip: null,
    consentText: true,
    consentVoice: true,
    addressAttempts: 0,
    askedZip: false,
    langConfirmPending: false,
    createdAt: now,
    updatedAt: now,
  };
}

/** Contract-shape assertions on a brief (Global Constraint 2 / locked JSON). */
function briefShapeOk(brief: Record<string, unknown>): string | null {
  if (typeof brief["userId"] !== "string" || !brief["userId"]) return "userId missing";
  const lang = brief["lang"];
  if (typeof lang !== "string" || !["en", "es", "zh", "tl", "vi", "ar"].includes(lang)) return "bad lang";
  const hazards = brief["hazards"];
  if (!Array.isArray(hazards)) return "hazards not an array";
  const actions = brief["actions"];
  if (!Array.isArray(actions) || actions.length > 5) return "actions missing or > 5";
  for (const a of actions) {
    if (typeof a !== "object" || typeof (a as { id?: unknown }).id !== "string" || typeof (a as { text?: unknown }).text !== "string") return "bad action shape";
  }
  const shelter = brief["shelter"];
  if (shelter !== null && typeof shelter !== "undefined") {
    const s = shelter as Record<string, unknown>;
    if (typeof s["name"] !== "string" || typeof s["distanceKm"] !== "number") return "bad shelter shape";
    if (s["status"] !== "open" && s["status"] !== "unknown") return "shelter status not open|unknown";
    if (typeof s["confidence"] !== "number" || s["confidence"] < 0 || s["confidence"] > 1) return "shelter confidence out of range";
  }
  const blocked = brief["blockedRoads"];
  if (!Array.isArray(blocked) || blocked.length > 2) return "blockedRoads missing or > 2";
  const official = brief["officialSource"];
  if (typeof official !== "object" || official === null) return "officialSource missing";
  const o = official as Record<string, unknown>;
  if (typeof o["name"] !== "string" || typeof o["url"] !== "string") return "officialSource fields missing";
  if (typeof brief["emergency"] !== "string" || !String(brief["emergency"]).includes("911")) return "emergency 911 line missing";
  return null;
}

/** First vertex of the first outer ring — on the boundary, so $geoIntersects matches. */
function candidatePoint(geometry: Record<string, unknown>): [number, number] | null {
  if (geometry["type"] !== "Polygon") return null;
  const coords = geometry["coordinates"];
  const ring = Array.isArray(coords) && Array.isArray(coords[0]) ? (coords[0] as unknown[]) : null;
  const first = ring && Array.isArray(ring[0]) ? (ring[0] as number[]) : null;
  if (!first || first.length < 2 || !Number.isFinite(first[0]) || !Number.isFinite(first[1])) return null;
  return [first[0], first[1]];
}

async function main(): Promise<0 | 1> {
  console.log(`smoke: base=${BASE} mongo=${MONGODB_URI ? "(set)" : "(MISSING)"} toolSecret=${TOOL_SECRET ? "(set)" : "(unset)"}`);
  if (!MONGODB_URI) {
    console.log("FAIL  env  — MONGODB_URI required so the smoke can seed/verify the test user");
    return 1;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (TOOL_SECRET) headers["X-Skywatch-Tool-Secret"] = TOOL_SECRET;

  // Step 1: /health
  let ok = true;
  try {
    const res = await fetch(`${BASE}/health`);
    const body = (await res.json()) as { ok?: unknown };
    ok = res.status === 200 && body.ok === true;
    record("1 /health ok", ok, `status=${res.status}`);
  } catch (err) {
    record("1 /health ok", false, err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (!ok) return 1;

  // Step 2: scenario replay
  try {
    const res = await fetch(`${BASE}/scenario/smoke/replay`, { method: "POST", headers });
    const body = (await res.json()) as { ok?: unknown; hazards?: unknown };
    ok = res.status === 200 && body.ok === true && Number(body.hazards) > 0;
    record("2 /scenario/smoke/replay", ok, `status=${res.status} hazards=${String(body?.hazards)}`);
  } catch (err) {
    record("2 /scenario/smoke/replay", false, err instanceof Error ? err.message : String(err));
    return 1;
  }

  // Step 3: map state
  try {
    const res = await fetch(`${BASE}/map/state`);
    const body = (await res.json()) as { hazards?: unknown[]; resources?: unknown[] };
    const nz = Array.isArray(body?.hazards) && body.hazards.length > 0;
    const nr = Array.isArray(body?.resources) && body.resources.length > 0;
    record("3 /map/state hazards>0 resources>0", nz && nr, `hazards=${body?.hazards?.length ?? "??"} resources=${body?.resources?.length ?? "??"}`);
  } catch (err) {
    record("3 /map/state", false, err instanceof Error ? err.message : String(err));
  }

  // Step 4: seed test user directly in Mongo, brief over HTTP, cleanup.
  const client = new MongoClient(MONGODB_URI);
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await client.connect();
    const db = client.db();
    const now = Date.now();
    let point: [number, number] | null = null;
    const hazards = await db.collection("hazards").find({ validFrom: { $lte: now }, validTo: { $gt: now } }).toArray();
    for (const h of hazards) {
      const p = candidatePoint(h.geometry as Record<string, unknown>);
      if (!p) continue;
      const hits = await db
        .collection("hazards")
        .countDocuments({ geometry: { $geoIntersects: { $geometry: { type: "Point", coordinates: p } } }, validFrom: { $lte: now }, validTo: { $gt: now } });
      if (hits > 0) {
        point = p;
        break;
      }
    }
    if (!point) {
      record("4 brief end-to-end", false, "no replayed hazard geometry yielded an interior point");
      return 1;
    }
    const doc = testUserDoc({ type: "Point", coordinates: point });
    const inserted = await db.collection("users").insertOne({ ...doc });
    const userId = String(inserted.insertedId);
    cleanup = () => db.collection("users").deleteOne({ _id: inserted.insertedId }).then(() => undefined);
    const res = await fetch(`${BASE}/tools/brief/${userId}`, { headers: TOOL_SECRET ? { "X-Skywatch-Tool-Secret": TOOL_SECRET } : {} });
    const body = (await res.json()) as Record<string, unknown>;
    if (res.status !== 200) {
      record("4 brief end-to-end", false, `status=${res.status} body=${JSON.stringify(body).slice(0, 200)}`);
      return 1;
    }
    const shapeErr = briefShapeOk(body);
    const matchedPoint = Array.isArray(body?.hazards) && (body.hazards as unknown[]).length > 0;
    record(
      "4 brief end-to-end",
      shapeErr === null && matchedPoint,
      shapeErr ?? (matchedPoint ? "" : "brief has 0 hazards although the user sat inside one (match layer)"),
    );
    // Privacy spot-check (Global Constraint 7 spirit): the brief must never carry the phone.
    const phone = String(doc["phone"]);
    record(
      "5 privacy: no phone in brief",
      !JSON.stringify(body).includes(phone),
      "the phone number leaked into the brief",
    );
  } catch (err) {
    record("4 brief end-to-end", false, err instanceof Error ? err.message : String(err));
  } finally {
    if (cleanup) await cleanup().catch(() => undefined);
    await client.close();
  }

  return results.every((r) => r.ok) ? 0 : 1;
}

main()
  .then((code) => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(failed === 0 ? "SMOKE PASS (all steps)" : `SMOKE FAIL (${failed} failed step(s))`);
    process.exit(code);
  })
  .catch((err) => {
    console.error("smoke crashed:", err);
    process.exit(1);
  });