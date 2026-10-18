import { afterAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { loadConfig, type Config } from "../src/config.ts";
import { COLLECTIONS, closeDb, getDb } from "../src/db/client.ts";
import { createApp } from "../src/server.ts";
import { memoryStore } from "../src/store.ts";
import { memoryMatchStore } from "../src/match/store.ts";
import { memoryDeliverStore } from "../src/deliver/store.ts";
import type { DeliverStore, OutboxRecord, UserRecord } from "../src/deliver/store.ts";
import { memoryVerifyStore } from "../src/verify/store.ts";
import { stubInboundRuntime } from "../src/deliver/runtime.ts";
import { grokLanguage, memoryTtsCache, mongoTtsCache, synthesize } from "../src/deliver/grok-tts.ts";
import { stubVoiceRuntime } from "../src/deliver/voice_runtime.ts";
import { emptyPipelineResult } from "../src/pipeline/run.ts";
import { processVoiceOutcome, POST_CALL_SUMMARY_RATE_KEY } from "../src/deliver/voice.ts";
import type { UserBrief } from "../src/types/brief.ts";

const NOW = Date.parse("2026-10-18T00:00:00.000Z");
const MP3_BASE64 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x01, 0x02]).toString("base64"); // "ID3" tag bytes

const brief: UserBrief = {
  userId: "mem-1",
  lang: "es",
  actions: [{ id: "check-on-people", text: "Comuníquese con las personas que atiende." }],
  hazards: [{ type: "flood", severity: 3, title: "flood demo", timing: "now through tonight", validFrom: NOW - 1000, validTo: NOW + 3_600_000 }],
  shelter: null,
  blockedRoads: [],
  officialSource: { name: "Your local county emergency management office", url: "https://www.ready.gov/floods" },
  emergency: "Llame al 911 si está en peligro.",
};

const user = (lang: UserRecord["lang"] = "es"): UserRecord => ({
  id: "mem-1",
  phone: "+15551230001",
  platform: "sms",
  spaceId: "any;-;+15551230001",
  lang,
  state: "active",
  loc: { type: "Point", coordinates: [-122.1, 47.5] },
  zip: "98104",
  consentText: true,
  consentVoice: true,
  addressAttempts: 0,
  askedZip: false,
  langConfirmPending: false,
  createdAt: NOW,
  updatedAt: NOW,
});

/** Grok-shaped mocked response: JSON envelope with base64 audio (the batch contract). */
const grokResponse = (): Response =>
  new Response(JSON.stringify({ audio: MP3_BASE64 }), { status: 200, headers: { "Content-Type": "application/json" } });

const mockFetch = (impl: () => Response | Promise<Response>): ReturnType<typeof vi.fn> =>
  vi.fn(async () => impl());

describe("Task 8f: lang mapping (exact xAI codes)", () => {
  it("es->es-MX, ar->ar-SA, en/zh/vi pass through, tl (Tagalog) UNSUPPORTED -> null", () => {
    expect(grokLanguage("es")).toBe("es-MX");
    expect(grokLanguage("ar")).toBe("ar-SA");
    expect(grokLanguage("en")).toBe("en");
    expect(grokLanguage("zh")).toBe("zh");
    expect(grokLanguage("vi")).toBe("vi");
    expect(grokLanguage("tl")).toBeNull();
  });
});

describe("Task 8f: synthesize (injected fetcher; the live path is env-gated off without XAI_API_KEY)", () => {
  it("no key / empty text / tl: null, ZERO fetch calls (feature silently absent)", async () => {
    const fetcher = mockFetch(grokResponse);
    expect(
      await synthesize({ config: loadConfig({}), cache: memoryTtsCache(), fetcher: fetcher as unknown as typeof fetch }, "recap", "en"),
    ).toBeNull(); // no XAI_API_KEY
    expect(
      await synthesize({ config: loadConfig({ XAI_API_KEY: "k" }), cache: memoryTtsCache(), fetcher: fetcher as unknown as typeof fetch }, "recap", "tl"),
    ).toBeNull(); // Tagalog unsupported
    expect(
      await synthesize({ config: loadConfig({ XAI_API_KEY: "k" }), fetcher: fetcher as unknown as typeof fetch }, "  ", "en"),
    ).toBeNull(); // empty text
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cache reads BEFORE network: same text+lang twice -> ONE fetch total, second call is a cache hit; key = sha256(text+lang)", async () => {
    const cache = memoryTtsCache();
    const fetcher = mockFetch(grokResponse);
    const config = loadConfig({ XAI_API_KEY: "k" });
    const first = await synthesize({ config, cache, fetcher: fetcher as unknown as typeof fetch }, "recap text", "es");
    expect(first).not.toBeNull();
    expect(first!.cached).toBe(false);
    expect(first!.lang).toBe("es-MX");
    expect(first!.contentType).toBe("audio/mpeg");
    expect(first!.sha).toBe(createHash("sha256").update(`recap text${"es"}`).digest("hex"));
    expect(fetcher).toHaveBeenCalledTimes(1);

    // the call itself is the locked contract: voice eve, es-MX, Bearer key
    const init = ((fetcher.mock.calls[0]?.[1] ?? {}) as RequestInit);
    expect(String(init.body)).toContain("es-MX");
    expect(String(init.body)).toContain('"voice_id":"eve"');
    expect(((init.headers as Record<string, string>) ?? {})["Authorization"]).toBe("Bearer k");

    const second = await synthesize({ config, cache, fetcher: fetcher as unknown as typeof fetch }, "recap text", "es");
    expect(second!.cached).toBe(true);
    expect(second!.bytes).toBe(MP3_BASE64);
    expect(fetcher).toHaveBeenCalledTimes(1); // still ONE fetch total
  });

  it("failure -> null (HTTP 500, missing-audio payload, network error); never throws, never caches", async () => {
    const config = loadConfig({ XAI_API_KEY: "k" });
    const cache = memoryTtsCache();
    expect(
      await synthesize({ config, cache, fetcher: mockFetch(() => new Response("boom", { status: 500 })) as unknown as typeof fetch }, "recap", "en"),
    ).toBeNull();
    expect(
      await synthesize({ config, cache, fetcher: mockFetch(() => new Response(JSON.stringify({ nope: true }), { status: 200 })) as unknown as typeof fetch }, "recap", "en"),
    ).toBeNull();
    expect(
      await synthesize({ config, cache, fetcher: vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch }, "recap", "en"),
    ).toBeNull();
    expect(cache && (await cache.get(createHash("sha256").update(`recap${"en"}`).digest("hex")))).toBeNull();
  });
});

/**
 * The full post-call path: processVoiceOutcome with a TTS'd summary + outbox meta +
 * the /tools/summary-audio route (memory stores; the global-fetch stub is the
 * synthesize seam — the production default fetcher IS global fetch).
 */
function harnessWithTts(opts: { xaiKey?: string | null; toolSecret?: string | null } = {}) {
  const astore = memoryStore();
  const dstore = memoryDeliverStore();
  const cache = memoryTtsCache();
  const config = loadConfig({
    ...(opts.xaiKey ? { XAI_API_KEY: opts.xaiKey } : {}),
    ...(opts.toolSecret ? { TOOL_SECRET: opts.toolSecret } : {}),
    ELEVENLABS_AGENT_ID_BRIEF: "agent-brief-1",
  });
  const app = createApp(config, {
    store: async () => astore,
    pipeline: async () => emptyPipelineResult(),
    inbound: stubInboundRuntime(),
    match: async () => memoryMatchStore(astore),
    deliver: async () => dstore,
    verify: async () => memoryVerifyStore(),
    voice: stubVoiceRuntime(),
    ttsCache: async () => cache,
  });
  const deps = {
    config,
    deliver: dstore,
    verify: memoryVerifyStore(),
    ttsCache: async () => cache,
    now: NOW,
  };
  // One user with a lastBrief (an earlier delivered alert carrying meta.brief).
  const seedUser = async (u: UserRecord): Promise<void> => {
    await dstore.createUser(u);
    await dstore.appendOutbox({
      userId: u.id,
      kind: "alert",
      rateKey: "hms-smoke:8f-demo",
      spaceId: u.spaceId,
      platform: u.platform,
      text: "Alert.",
      status: "not_wired",
      error: null,
      meta: { lang: "es", source: "fallback", brief: { ...brief, userId: u.id } },
      createdAt: NOW - 1,
      sentAt: null,
    });
  };
  const postCall = async (userId: string): Promise<OutboxRecord | null> => {
    const { matched } = await processVoiceOutcome(
      { type: "post_call_transcription", data: { user_id: userId, agent_id: "agent-brief-1", conversation_id: `conv-${userId}`, status: "done", analysis: { summary: "user is safe" } } },
      deps,
    );
    expect(matched).toBe("user");
    return (await dstore.listOutbox()).filter((r) => r.rateKey === POST_CALL_SUMMARY_RATE_KEY).at(-1) ?? null;
  };
  return { app, cache, dstore, seedUser, postCall };
}

describe("Task 8f: post-call summary audio end-to-end (memory stores, injected fetch)", () => {
  it("summary is synthesized + stamped {sha, lang, summaryText} on the outbox meta + served by /tools/summary-audio (TOOL_SECRET-gated)", async () => {
    const fetcher = mockFetch(grokResponse);
    vi.stubGlobal("fetch", fetcher as unknown as typeof fetch);
    const h = harnessWithTts({ xaiKey: "k", toolSecret: "s3cret" });
    const esUser = user();
    await h.seedUser(esUser);

    const row = await h.postCall(esUser.id);
    expect(row).not.toBeNull();
    expect(row!.meta?.audio?.sha).toBe(createHash("sha256").update(`${row!.text}${"es"}`).digest("hex"));
    expect(row!.meta?.audio?.summaryText).toBe(row!.text);
    expect(row!.text.length).toBeGreaterThan(0);
    // the cached mp3 serves through the route
    const res = await h.app.request(`/tools/summary-audio/${row!.id}`, { headers: { "X-Skywatch-Tool-Secret": "s3cret" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await res.arrayBuffer()).toString("base64")).toBe(MP3_BASE64);
    expect(res.headers.get("cache-control")).toContain("immutable");

    // a second identical post-call: pure cache-hit (still exactly one fetch)
    const second = await h.postCall(esUser.id);
    expect(second!.meta?.audio?.summaryText).toBe(second!.text);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("route gating: missing/wrong tool secret 401; unknown row 404 (with a valid secret)", async () => {
    const h = harnessWithTts({ xaiKey: "k", toolSecret: "s3cret" });
    expect((await h.app.request("/tools/summary-audio/whatever")).status).toBe(401);
    expect((await h.app.request("/tools/summary-audio/whatever", { headers: { "X-Skywatch-Tool-Secret": "nope" } })).status).toBe(401);
    expect((await h.app.request("/tools/summary-audio/mem-outbox-999", { headers: { "X-Skywatch-Tool-Secret": "s3cret" } })).status).toBe(404);
  });

  it("no XAI key or a Grok failure: NO meta.audio, deliver completes end-to-end (never blocks; text path unchanged)", async () => {
    const cases: Array<{ xaiKey?: string | null; status?: number }> = [{}, { xaiKey: "k", status: 500 }];
    for (const c of cases) {
      const fetcher = mockFetch(() => new Response("boom", { status: c.status ?? 200 }));
      vi.stubGlobal("fetch", fetcher as unknown as typeof fetch);
      const h = harnessWithTts({ xaiKey: c.xaiKey });
      const u = user();
      await h.seedUser(u);
      const row = await h.postCall(u.id);
      expect(row).not.toBeNull();
      expect(row!.meta?.audio).toBeUndefined(); // silence, not failure — no audio meta at all
      expect(row!.text.length).toBeGreaterThan(0); // the text recap shipped as before
      expect(row!.status).toBe("not_wired"); // Photon NOT_WIRED semantics unchanged
      expect((await h.dstore.listConversations()).some((e) => e.userId === u.id)).toBe(true);
      if (c.status) expect(fetcher).toHaveBeenCalledTimes(1); // with TTS configured the failure was ATTEMPTED once
            if (c.status === undefined) expect(fetcher).not.toHaveBeenCalled(); // no key: zero calls
    }
  });

  it("tl (Tagalog) user: no TTS call, no meta.audio — the existing ElevenLabs/text path is the only audio", async () => {
    const fetcher = mockFetch(grokResponse);
    vi.stubGlobal("fetch", fetcher as unknown as typeof fetch);
    const h = harnessWithTts({ xaiKey: "k" });
    const tlUser = user("tl");
    await h.seedUser(tlUser);
    const row = await h.postCall(tlUser.id);
    expect(row).not.toBeNull();
    expect(row!.meta?.audio).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect((await h.app.request(`/tools/summary-audio/${row!.id}`)).status).toBe(404); // no audio exists to play (tool secret unset = open-read posture)
  });
});

// Real-Mongo block: the tts_cache collection + unique index + mongoTtsCache round-trip
// (runs only when MONGODB_URI is set, --no-file-parallelism; cleans ONLY its own keys).
describe.skipIf(!process.env.MONGODB_URI)("real Mongo: tts_cache (8f)", () => {
  function indexInfo(indexes: Array<{ key: Record<string, string | number>; unique?: boolean }>) {
    return indexes.map((i) => ({ key: i.key, unique: i.unique === true }));
  }

  it("mongoTtsCache upsert/get round-trip over the unique sha key; a re-put overwrites (idempotent); the index surface is registered", async () => {
    const config = loadConfig();
    const deps = await import("../src/deps.ts");
    const app = createApp(config, deps.defaultDeps(config));
    void app;
    const db = await getDb(config);
    const idx = indexInfo((await db.collection(COLLECTIONS.ttsCache).indexes()) as never);
    expect(idx).toContainEqual({ key: { key: 1 }, unique: true });

    const cache = mongoTtsCache(db);
    const key = `8f-test:${createHash("sha256").update("t8").digest("hex").slice(0, 16)}`;
    try {
      await cache.put({ key, contentType: "audio/mpeg", bytes: "QUJD", ts: NOW });
      expect(await cache.get(key)).toMatchObject({ contentType: "audio/mpeg", bytes: "QUJD" });
      await cache.put({ key, contentType: "audio/mpeg", bytes: "WFla", ts: NOW }); // overwrite
      expect((await cache.get(key))!.bytes).toBe("WFla");
      expect(await cache.get("8f-test:missing")).toBeNull();
    } finally {
      // Clean ONLY this test's key before/after (shared throwaway db courtesy).
      await db.collection(COLLECTIONS.ttsCache).deleteMany({ key: { $regex: /^8f-test:/ } });
    }
    await closeDb();
  }, 60_000);

  afterAll(async () => {
    const db = await getDb(loadConfig());
    await db.collection(COLLECTIONS.ttsCache).deleteMany({ key: { $regex: /^8f-test:/ } });
    await closeDb();
  });
});