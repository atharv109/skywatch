/**
 * Task 7: hermetic tests for the optional Tiger Data status_events layer.
 * Only the pure event builder + the inert-when-unset guard are exercised —
 * no Postgres in the hermetic suite (the ruling: Mongo verifiedAt is the
 * demo path; tiger.ts must stay a non-blocking optional mirror).
 */
import { describe, expect, it } from "vitest";
import { buildStatusEvent, forwardStatusEvents, tigerClientConfig, tigerSsl, type TigerStatusEvent, type TigerStatusRow } from "../src/verify/tiger.ts";
import type { ResourceDoc } from "../src/types/docs.ts";
import type { Config } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { memoryStore } from "../src/store.ts";
import { memoryMatchStore } from "../src/match/store.ts";
import { memoryDeliverStore } from "../src/deliver/store.ts";
import { stubInboundRuntime } from "../src/deliver/runtime.ts";
import { memoryVerifyStore } from "../src/verify/store.ts";
import { stubVoiceRuntime } from "../src/deliver/voice_runtime.ts";
import { emptyPipelineResult } from "../src/pipeline/run.ts";

function checkedInResource(overrides: Partial<ResourceDoc> = {}): ResourceDoc {
  return {
    sourceId: "seed-shelter-1",
    kind: "shelter",
    name: "Demo Shelter",
    partner: true,
    status: "open",
    verifiedAt: 1_700_000_000_000,
    capacity: 40,
    lastCheckin: { status: "open", manual: false, notes: "staff confirmed", at: 1_700_000_000_000 },
    loc: { type: "Point", coordinates: [-122.3185, 47.584] },
    ...overrides,
  };
}

describe("tiger.ts event builder", () => {
  it("maps a checked-in resource into the status_events row shape (lon before lat)", () => {
    const event: TigerStatusEvent | null = buildStatusEvent(checkedInResource());
    expect(event).not.toBeNull();
    expect(event!.resourceId).toBe("seed-shelter-1");
    expect(event!.resourceName).toBe("Demo Shelter");
    expect(event!.status).toBe("open");
    expect(event!.capacity).toBe(40);
    expect(event!.manual).toBe(false);
    expect(event!.notes).toBe("staff confirmed");
    expect(event!.lon).toBe(-122.3185);
    expect(event!.lat).toBe(47.584);
    expect(event!.at).toBe(1_700_000_000_000);
  });

  it("returns null when the resource was never verified (verifiedAt null)", () => {
    expect(buildStatusEvent(checkedInResource({ verifiedAt: null, lastCheckin: undefined }))).toBeNull();
  });

  it("Tiger TLS posture (8-urgent fix): the client config forces the explicit ssl object — Timescale's self-signed root accepted, the URI's sslmode cannot override", () => {
    // pg-connection-string turns the URI's `sslmode=require` into `ssl: {}`, and
    // node-pg's ConnectionParameters Object-assigns the parsed URI OVER the explicit
    // config — so the fix must STRIP the ssl query params, not just set an ssl object.
    expect(tigerClientConfig("postgres://u:p@host/db?sslmode=require")).toEqual({
      connectionString: "postgres://u:p@host/db",
      ssl: { rejectUnauthorized: false },
    });
    // a URL without ssl params round-trips unchanged
    expect(tigerClientConfig("postgres://u:p@host/db")).toEqual({
      connectionString: "postgres://u:p@host/db",
      ssl: { rejectUnauthorized: false },
    });
    // the Tiger-style connection string carries several ssl keys — all stripped, host/creds/query kept
    const stripped = tigerClientConfig("postgres://u:p@h.tsdb.cloud.timescale.com:33284/tsdb?sslmode=require&uselibpqcompat=true&application_name=skywatch");
    expect(stripped.connectionString).not.toContain("sslmode");
    expect(stripped.connectionString).not.toContain("uselibpqcompat");
    expect(stripped.connectionString).toContain("application_name=skywatch");
    expect(stripped.connectionString).toContain("h.tsdb.cloud.timescale.com:33284/tsdb");
    // a non-URL string passes through untouched (pg surfaces its own error)
    expect(tigerClientConfig("not-a-url")).toEqual({ connectionString: "not-a-url", ssl: { rejectUnauthorized: false } });
    expect(tigerSsl()).toEqual({ rejectUnauthorized: false });
  });

  it("regression (deployed 503): node-pg's REAL ConnectionParameters resolves the Tiger URL to rejectUnauthorized=false", async () => {
    // No stubbing: this pins the actual installed pg behavior so a pg upgrade that
    // changes connection-string merging fails LOUDLY here instead of in production.
    // @ts-expect-error no published typings for the pg internals subpath (exports-map gap)
    const { default: ConnectionParameters } = (await import("pg/lib/connection-parameters.js")) as unknown as {
      default: new (config: unknown) => { ssl: unknown };
    };
    const params = new ConnectionParameters(tigerClientConfig("postgres://u:p@host/db?sslmode=require"));
    expect(params.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("forwardStatusEvents is a no-op (no throw, no writes) when TIGER_DATABASE_URL is unset", () => {
    // With the URL absent the call must return without touching pg at all.
    const event = buildStatusEvent(checkedInResource());
    expect(event).not.toBeNull();
    expect(() => forwardStatusEvents({ tigerDatabaseUrl: null }, [event!])).not.toThrow();
    // Empty event list is also inert even with a URL set.
    expect(() => forwardStatusEvents({ tigerDatabaseUrl: "postgres://user@localhost/nothing" }, [])).not.toThrow();
  });
});

/**
 * Task 8h READ side: GET /tools/status-history — hermetic with the INJECTED
 * tigerStatus dep (fake rows -> the route must apply the EXACT confidence.ts
 * decay); the unconfigured posture is 503 {configured:false} (never fake Mongo data).
 */
describe("GET /tools/status-history (Tiger READ, injected rows)", () => {
  interface HistoryJson {
    configured: boolean;
    source: string;
    entity: string;
    hours: number;
    generatedAt: number;
    error?: string;
    rows?: Array<{ time: number; status: string; sourceType: string; notes: string | null; capacity: number | null; confidence: number }>;
    confidenceSeries?: Array<{ time: number; confidence: number }>;
  }

  const statusOf = (r: Response | Promise<Response>): number => (r instanceof Promise ? NaN : r.status);

  function appWithHistory(reader?: (entity: string, hours: number, now: number) => Promise<TigerStatusRow[]>, configEnv: Record<string, string> = {}): ReturnType<typeof createApp> {
    const astore = memoryStore();
    return createApp(loadConfig({ REPLAY: "1", ...configEnv }), {
      store: async () => astore,
      pipeline: async () => emptyPipelineResult(),
      inbound: stubInboundRuntime(),
      match: async () => memoryMatchStore(astore),
      deliver: async () => memoryDeliverStore(),
      verify: async () => memoryVerifyStore(),
      voice: stubVoiceRuntime(),
      ...(reader ? { tigerStatus: reader } : {}),
    });
  }

  const NOW = Date.parse("2026-10-18T02:00:00.000Z");

  /** three events: fresh, exactly one half-life old, exactly four half-lives old */
  const fakeRows = (entity: string, hours: number, now: number): Promise<TigerStatusRow[]> => {
    expect(entity).toBe("8h-shelter");
    expect(hours).toBe(6);
    return Promise.resolve([
      { at: now - 5 * 60_000, status: "open", manual: true, notes: "walked past", capacity: 40 },
      { at: now - 30 * 60_000, status: "open", manual: false, notes: null, capacity: null },
      { at: now - 120 * 60_000, status: "full", manual: false, notes: null, capacity: 12 },
    ]);
  };

  const get = async (app: ReturnType<typeof createApp>, url: string): Promise<{ res: Response; j: HistoryJson }> => {
    const res = await app.request(url);
    return { res, j: (await res.json()) as HistoryJson };
  };

  it("rows + the decay math EXACTLY as src/confidence.ts (shelter 30-min half-life); manual -> 'manual'/'call' badges", async () => {
    const { res, j } = await get(appWithHistory(fakeRows), "/tools/status-history?entity=8h-shelter&hours=6");
    expect(res.status).toBe(200);
    expect(j.configured).toBe(true);
    expect(j.source).toBe("tiger");
    expect(j.rows).toHaveLength(3);
    expect(j.rows![0]).toMatchObject({ status: "open", sourceType: "manual", notes: "walked past", capacity: 40 });
    expect(j.rows![1]!.sourceType).toBe("call");
    // the EXACT dashboard formula: 0.5^(minutes/30), rounded to 2 decimals
    const expectConf = (ageMin: number): number => Math.round(Math.pow(0.5, ageMin / 30) * 100) / 100;
    expect(j.rows![0]!.confidence).toBe(expectConf(5)); // 0.89
    expect(j.rows![1]!.confidence).toBe(0.5); // one half-life exactly
    expect(j.rows![2]!.confidence).toBe(0.06); // four half-lives: 0.5^4 = 0.0625
    expect(j.confidenceSeries!.map((p) => p.confidence)).toEqual(j.rows!.map((r) => r.confidence));
  });

  it("unconfigured: 503 {configured:false} and NOTHING faked; tool secret gates like other /tools reads; the read still never fakes Mongo", async () => {
    const { res, j } = await get(appWithHistory(), "/tools/status-history?entity=x");
    expect(res.status).toBe(503);
    expect(j.configured).toBe(false);
    expect(j.error).toContain("TIGER_DATABASE_URL");
    expect(j.error).toContain("source of truth");
    expect(j.rows).toBeUndefined();

    const gated = appWithHistory(fakeRows, { TOOL_SECRET: "s3cret" });
    expect((await gated.request("/tools/status-history?entity=8h-shelter")).status).toBe(401);
    expect((await gated.request("/tools/status-history?entity=8h-shelter", { headers: { "X-Skywatch-Tool-Secret": "s3cret" } })).status).toBe(200);
  });

  it("a read failure returns 503 with the UNDERLYING pg reason (no blanket 503 hiding TLS/timeout bugs)", async () => {
    const failing = appWithHistory(() => Promise.reject(new Error("self-signed certificate in certificate chain")));
    const { res, j } = await get(failing, "/tools/status-history?entity=8h-shelter&hours=6");
    expect(res.status).toBe(503);
    expect(j.configured).toBe(true);
    expect(j.error).toContain("Tiger Data read failed");
    expect((j as { reason?: string }).reason).toContain("self-signed certificate");
  });

  it("validation: entity required; hours in (0,168] with default 6; the reader receives the parsed hours", async () => {
    const seen: Array<[string, number]> = [];
    const app = appWithHistory((entity, hours, now) => {
      seen.push([entity, hours]);
      return Promise.resolve([]);
    });
    expect((await app.request("/tools/status-history")).status).toBe(400);
    expect((await app.request("/tools/status-history?entity=x&hours=0")).status).toBe(400);
    expect((await app.request("/tools/status-history?entity=x&hours=200")).status).toBe(400);
    expect((await app.request("/tools/status-history?entity=x&hours=168")).status).toBe(200);
    expect((await app.request("/tools/status-history?entity=default-check")).status).toBe(200);
    expect(seen).toContainEqual(["x", 168]);
    expect(seen).toContainEqual(["default-check", 6]);
  });
});