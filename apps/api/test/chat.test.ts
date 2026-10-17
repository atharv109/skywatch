import { describe, expect, it, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { loadConfig, type Config } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { memoryStore, type AppStore } from "../src/store.ts";
import { memoryMatchStore } from "../src/match/store.ts";
import { memoryDeliverStore, type DeliverStore, type UserRecord } from "../src/deliver/store.ts";
import { createInboundRuntime } from "../src/deliver/runtime.ts";
import { memoryVerifyStore } from "../src/verify/store.ts";
import { stubVoiceRuntime } from "../src/deliver/voice_runtime.ts";
import { emptyPipelineResult } from "../src/pipeline/run.ts";
import { chatReply, runChatTool, MAX_TOOL_ROUNDS } from "../src/deliver/chat.ts";
import { fallbackRender } from "../src/brief/fallback.ts";
import type { UserBrief } from "../src/types/brief.ts";
import type { ResourceDoc } from "../src/types/docs.ts";

const NOW = Date.parse("2026-10-18T00:00:00.000Z");

const brief: UserBrief = {
  userId: "mem-1",
  lang: "en",
  actions: [{ id: "close-windows", text: "Close doors and windows." }],
  hazards: [
    {
      type: "smoke",
      severity: 3,
      title: "Smoke plume demo",
      timing: "now through tonight",
      validFrom: NOW - 1000,
      validTo: NOW + 3_600_000,
    },
  ],
  shelter: { id: "seed-shelter-1", name: "Test Shelter", distanceKm: 1.2, status: "open", confidence: 0.8, hours: "24/7", verifiedMinutesAgo: 5 },
  blockedRoads: [{ cameraId: "wsdot-9800", name: "SR 99 demo", status: "flooded", confidence: 0.9 }],
  officialSource: { name: "National Weather Service", url: "https://alerts.weather.gov" },
  emergency: "Call 911 if you are in danger.",
};

const user = (): UserRecord => ({
  id: "mem-1",
  phone: "+15551230001",
  platform: "sms",
  spaceId: "any;-;+15551230001",
  lang: "en",
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

const resource = (): ResourceDoc => ({
  sourceId: "seed-shelter-1",
  kind: "shelter",
  name: "Test Shelter",
  address: "123 Hidden St",
  partner: true,
  status: "open",
  verifiedAt: NOW - 5 * 60_000,
  loc: { type: "Point", coordinates: [-122.1, 47.5] },
});

function stores(): { astore: AppStore; dstore: DeliverStore } {
  const astore = memoryStore();
  const dstore = memoryDeliverStore();
  return { astore, dstore };
}

afterEach(() => vi.unstubAllGlobals());

/** One gemini-style mocked generateContent response (a tool call or a final text). */
function geminiResponse(body: { functionCall?: { name: string; args: Record<string, unknown> }; text?: string }): Response {
  const parts: Array<Record<string, unknown>> = body.functionCall ? [{ functionCall: body.functionCall }] : [{ text: body.text ?? "" }];
  return new Response(JSON.stringify({ candidates: [{ content: { parts } }] }), { status: 200 });
}

type BodyLogger = { bodies: string[] };

/**
 * A fetch mock that scripts Gemini replies and logs every request body, so tests
 * can assert on tool declarations, history and prompt privacy.
 */
function scriptedGemini(script: Array<Parameters<typeof geminiResponse>[0]>, log?: BodyLogger): typeof fetch {
  let call = 0;
  return vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    log?.bodies.push(body);
    const scripted = script[Math.min(call, script.length - 1)]!;
    call += 1;
    return geminiResponse(scripted);
  }) as unknown as typeof fetch;
}

describe("chatReply with a mocked Gemini tool loop", () => {
  it("tools run over DB-only reads, history is sent, and no phone/address ever appears in any prompt", async () => {
    const { astore, dstore } = stores();
    void astore.upsertResource(resource());
    void astore.upsertRoad({
      cameraId: "wsdot-9800",
      name: "SR 99 demo",
      status: "flooded",
      verifiedAt: NOW - 60_000,
      loc: { type: "Point", coordinates: [-122.1005, 47.5005] },
      imageUrl: "x",
    });

    const log: BodyLogger = { bodies: [] };
    vi.stubGlobal(
      "fetch",
      scriptedGemini(
        [{ functionCall: { name: "getBrief", args: {} } }, { text: "Test Shelter is open, about 1.2 km away. SR 99 demo is flooded. Call 911 if you are in danger." }],
        log,
      ),
    );

    const u = user();
    await dstore.appendConversation({ userId: u.id, from: "user", text: "Earlier question from history", at: NOW - 1000 });
    const out = await chatReply({
      config: loadConfig({ GEMINI_API_KEY: "k", REPLAY: "0" }),
      deliver: dstore,
      appStore: astore,
      user: u,
      text: "Is my shelter still open right now?",
      lastBrief: brief,
      now: NOW,
    });
    expect(out.source).toBe("gemini");
    expect(out.toolsUsed).toEqual(["getBrief"]);
    expect(out.reply).toContain("Test Shelter");
    // history (conversation remembered) + the new question reached the model
    expect(log.bodies[0]).toContain("Earlier question from history");
    expect(log.bodies[0]).toContain("Is my shelter still open right now?");
    // the function response was fed back as a tool result
    expect(log.bodies[1]).toContain("getBrief");
    // privacy: no phone, no address field leakage into any prompt
    expect(log.bodies.some((b) => b.includes("15551230001"))).toBe(false);
    expect(log.bodies.some((b) => b.includes("Hidden"))).toBe(false);
  });

  it("capped at MAX_TOOL_ROUNDS: 4 tool rounds max, then one final round WITHOUT tool declarations", async () => {
    const { astore, dstore } = stores();
    void astore.upsertResource(resource());
    const log: BodyLogger = { bodies: [] };
    // 4 tool rounds (every scripted tool round answers with a functionCall), then
    // the final no-tool round gets a real answer.
    const fc = { functionCall: { name: "getResourceStatus", args: { resourceId: "seed-shelter-1" } } as const };
    vi.stubGlobal(
      "fetch",
      scriptedGemini([fc, fc, fc, fc, { text: "Test Shelter is open. Call 911 if you are in danger." }], log),
    );
    const out = await chatReply({
      config: loadConfig({ GEMINI_API_KEY: "k", REPLAY: "0" }),
      deliver: dstore,
      appStore: astore,
      user: user(),
      text: "status?",
      lastBrief: brief,
      now: NOW,
    });
    // 4 tool rounds (each a getBrief-round-trip) + 1 final no-tool round = 5 Gemini calls
    expect(log.bodies).toHaveLength(MAX_TOOL_ROUNDS + 1);
    const toolRounds = log.bodies.slice(0, MAX_TOOL_ROUNDS).filter((b) => b.includes("functionDeclarations"));
    expect(toolRounds).toHaveLength(MAX_TOOL_ROUNDS);
    expect(log.bodies.at(-1)).not.toContain("functionDeclarations");
    expect(out.toolsUsed).toHaveLength(MAX_TOOL_ROUNDS);
    expect(out.reply).toContain("Test Shelter");
  });

  it("an invented shelter (entity violation) falls back deterministically; a Gemini failure too", async () => {
    const { astore, dstore } = stores();
    vi.stubGlobal("fetch", scriptedGemini([{ text: "You can stay at Invented Grand Hotel now." }]));
    const out = await chatReply({
      config: loadConfig({ GEMINI_API_KEY: "k", REPLAY: "0" }),
      deliver: dstore,
      appStore: astore,
      user: user(),
      text: "anything",
      lastBrief: brief,
      now: NOW,
    });
    expect(out.source).toBe("fallback");
    expect(out.reply).toBe(fallbackRender(brief).text);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    );
    const out2 = await chatReply({
      config: loadConfig({ GEMINI_API_KEY: "k", REPLAY: "0" }),
      deliver: dstore,
      appStore: astore,
      user: user(),
      text: "anything",
      lastBrief: brief,
      now: NOW,
    });
    expect(out2.source).toBe("fallback");
    expect(out2.reply).toBe(fallbackRender(brief).text);
  });

  it("Gemini unset or REPLAY=1: zero fetch calls — deterministic brief-fields composition answers", async () => {
    const { astore, dstore } = stores();
    const guard = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", guard);
    for (const config of [loadConfig({ REPLAY: "1", GEMINI_API_KEY: "k" }), loadConfig({ REPLAY: "0" })]) {
      const out = await chatReply({
        config,
        deliver: dstore,
        appStore: astore,
        user: user(),
        text: "question",
        lastBrief: brief,
        now: NOW,
      });
      expect(out.source).toBe("fallback");
      expect(out.reply).toBe(fallbackRender(brief).text);
      expect(out.toolsUsed).toEqual([]);
    }
    expect(guard).not.toHaveBeenCalled();
  });

  it("tool outputs carry only whitelisted fields (no address/contact/phone) and unknown tools error", async () => {
    const { astore, dstore } = stores();
    void astore.upsertResource(resource());
    const view = (await runChatTool("getResourceStatus", { resourceId: "seed-shelter-1" }, { appStore: astore, deliver: dstore, user: user(), lastBrief: brief }, NOW)) as Record<string, unknown>;
    expect(Object.keys(view).sort()).toEqual(["capacity", "kind", "name", "sourceId", "status", "verifiedMinutesAgo"]);
    expect(JSON.stringify(view)).not.toContain("Hidden");
    expect(JSON.stringify(view)).not.toContain("15551230001");
    const unknown = await runChatTool("deleteAll", {}, { appStore: astore, deliver: dstore, user: user(), lastBrief: brief }, NOW);
    expect(unknown).toMatchObject({ error: "unknown tool deleteAll" });
  });
});

/**
 * Full inbound round-trip over the deliver path (signed Photon webhook, memory
 * runtime): the chat reply goes through sendOutbound (outbox row with the
 * NOT_WIRED status + conversation turns), and the hold-the-line/SMS-gate
 * interplay for briefed-less users is unchanged.
 */
describe("active-user inbound with lastBrief (deliver round-trip)", () => {
  const SECRET = "test-webhook-secret";
  const NOWR = Date.parse("2026-10-18T00:00:00.000Z");

  function makeHarness() {
    const astore = memoryStore();
    void astore.upsertResource(resource());
    const dstore = memoryDeliverStore();
    const config = loadConfig({ REPLAY: "1", PHOTON_WEBHOOK_SIGNING_SECRET: SECRET, GEMINI_API_KEY: "k" });
    // REPLAY=1 keeps the chat deterministic (fallback composition) while the full
    // gate -> loop -> validate -> send path is exercised.
    const ctx = {
      config,
      store: async () => dstore,
      now: () => NOWR,
      geocode: async () => null,
      appStore: async () => astore,
    };
    const inbound = createInboundRuntime(ctx);
    const app = createApp(config, {
      store: async () => astore,
      pipeline: async () => emptyPipelineResult(),
      inbound,
      match: async () => memoryMatchStore(astore),
      deliver: async () => dstore,
      verify: async () => memoryVerifyStore(),
      voice: stubVoiceRuntime(),
    });
    let seq = 0;
    const send = async (text: string, phone = "+15551230001"): Promise<Response> => {
      const payload = {
        event: "messages",
        space: { id: `any;-;${phone}`, platform: "SMS", type: "dm" },
        message: {
          id: `spc-msg-chat-${seq++}`,
          platform: "SMS",
          direction: "inbound",
          sender: { id: phone, platform: "SMS" },
          space: { id: `any;-;${phone}`, platform: "SMS", type: "dm" },
          content: { type: "text", text },
        },
      };
      const raw = JSON.stringify(payload);
      const ts = Math.floor(Date.now() / 1000); // signature freshness window is near-real-time
      const res = await app.request("/webhooks/photon/message", {
        method: "POST",
        body: raw,
        headers: {
          "content-type": "application/json",
          "X-Spectrum-Signature": "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${raw}`).digest("hex"),
          "X-Spectrum-Timestamp": String(ts),
        },
      });
      expect(res.status).toBe(200);
      await inbound.drain();
      return res;
    };
    return { dstore, send };
  }

  it("active user with a lastBrief: composed answer via the deliver path; turns recorded both directions", async () => {
    const h = makeHarness();
    const u = await h.dstore.createUser({
      phone: "+15551230001",
      platform: "sms",
      spaceId: "any;-;+15551230001",
      lang: "en",
      state: "active",
      loc: { type: "Point", coordinates: [-122.1, 47.5] },
      zip: "98104",
      consentText: true,
      consentVoice: true,
      addressAttempts: 0,
      askedZip: false,
      langConfirmPending: false,
      createdAt: NOWR,
      updatedAt: NOWR,
    });
    // an earlier alert delivered with its brief (the pipeline's outbox meta shape)
    await h.dstore.appendOutbox({
      userId: u.id,
      kind: "alert",
      rateKey: "hms-smoke:demo",
      spaceId: u.spaceId,
      platform: u.platform,
      text: "Alert text.",
      status: "not_wired",
      error: null,
      meta: { lang: "en", source: "fallback", brief: { ...brief, userId: u.id } },
      createdAt: NOWR,
      sentAt: null,
    });
    await h.send("What is your situation near me?");
    const outbox = (await h.dstore.listOutbox()).filter((r) => r.userId === u.id);
    expect(outbox.at(-1)).toMatchObject({ kind: "reply", status: "not_wired", sentAt: null }); // Photon NOT_WIRED semantics unchanged
    expect(outbox.at(-1)?.text).toBe(fallbackRender({ ...brief, userId: u.id }).text); // validator-safe deterministic answer
    const convos = (await h.dstore.listConversations()).filter((e) => e.userId === u.id);
    expect(convos).toHaveLength(2); // user turn + bot turn
    expect(convos[0]).toMatchObject({ from: "user", text: "What is your situation near me?" });
    expect(convos[1]!.from).toBe("bot");
  });

  it("active user WITHOUT a lastBrief keeps the hold-the-line reply (SMS-gate interplay unchanged)", async () => {
    const h = makeHarness();
    await h.dstore.createUser({
      phone: "+15551230001",
      platform: "sms",
      spaceId: "any;-;+15551230001",
      lang: "en",
      state: "active",
      loc: { type: "Point", coordinates: [-122.1, 47.5] },
      zip: "98104",
      consentText: true,
      consentVoice: true,
      addressAttempts: 0,
      askedZip: false,
      langConfirmPending: false,
      createdAt: NOWR,
      updatedAt: NOWR,
    });
    await h.send("What is your situation near me?");
    const outbox = (await h.dstore.listOutbox()).filter((r) => r.kind === "reply");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.text).toMatch(/We'll message you here only when there's an urgent hazard nearby/);
  });
});