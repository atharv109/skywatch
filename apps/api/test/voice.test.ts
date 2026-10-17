import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { memoryStore } from "../src/store.ts";
import { memoryMatchStore } from "../src/match/store.ts";
import { memoryDeliverStore } from "../src/deliver/store.ts";
import { stubInboundRuntime } from "../src/deliver/runtime.ts";
import { memoryVerifyStore, type VerifyStore } from "../src/verify/store.ts";
import { createVoiceRuntime, type VoiceRuntime } from "../src/deliver/voice_runtime.ts";
import { emptyPipelineResult } from "../src/pipeline/run.ts";
import { outcomeFor } from "../src/deliver/voice.ts";

const SECRET = "test-voice-webhook-secret";

function configWith(over: Record<string, string> = {}): Config {
  return loadConfig({ REPLAY: "1", ELEVENLABS_VOICE_WEBHOOK_SECRET: SECRET, ELEVENLABS_AGENT_ID_CHECKIN: "agent-checkin-1", ...over });
}

function sign(secret: string, ts: number, raw: string): string {
  return `t=${ts},v1=` + createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
}

const OUTCOME_PAYLOAD: import("../src/deliver/voice.ts").VoicePostCallPayload = {
  type: "post_call_transcription",
  data: {
    agent_id: "agent-brief-1",
    conversation_id: "conv-xyz",
    status: "done",
    user_id: "mem-1",
    transcript: [
      { role: "agent", message: "Hi, this is Skywatch." },
      { role: "user", message: "We're okay, power is out." },
    ],
    analysis: { summary: "User reports power outage; household safe." },
  },
};

function harness(opts: { configEnv?: Record<string, string>; secret?: string | null } = {}) {
  const config = loadConfig({
    REPLAY: "1",
    ...(opts.secret === undefined ? { ELEVENLABS_VOICE_WEBHOOK_SECRET: SECRET } : secretEnv(opts.secret)),
    ...opts.configEnv,
    ELEVENLABS_AGENT_ID_CHECKIN: "agent-checkin-1",
  });
  const dstore = memoryDeliverStore();
  const verifyStore = memoryVerifyStore();
  const voice: VoiceRuntime = createVoiceRuntime(config, {
    deliver: async () => dstore,
    verify: async () => verifyStore,
  });
  const app = createApp(config, {
    store: async () => memoryStore(),
    pipeline: async () => emptyPipelineResult(),
    inbound: stubInboundRuntime(),
    match: async () => memoryMatchStore(memoryStore()),
    deliver: async () => dstore,
    verify: async () => verifyStore,
    voice,
  });
  return { config, dstore, verifyStore, voice, app };
}

function secretEnv(secret: string | null): Record<string, string> {
  return secret === null ? {} : { ELEVENLABS_VOICE_WEBHOOK_SECRET: secret };
}

async function postCall(app: ReturnType<typeof createApp>, payload: unknown, sig?: string | null): Promise<Response> {
  const raw = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sig !== null) headers["elevenlabs-signature"] = sig ?? sign(SECRET, ts, raw);
  return app.request("/webhooks/voice/post-call", { method: "POST", body: raw, headers });
}

describe("POST /webhooks/voice/post-call", () => {
  it("HMAC: 400 when the header is missing, 401 on a bad signature, 401 fail-closed with no server secret", async () => {
    const h = harness();
    expect((await postCall(h.app, OUTCOME_PAYLOAD, "t=1,v1=deadbeef")).status).toBe(401);
    expect((await postCall(h.app, OUTCOME_PAYLOAD, null)).status).toBe(400);

    const noSecret = harness({ secret: null });
    const raw = JSON.stringify(OUTCOME_PAYLOAD);
    expect(
      (await noSecret.app.request("/webhooks/voice/post-call", {
        method: "POST",
        body: raw,
        headers: { "content-type": "application/json", "elevenlabs-signature": "t=1,v1=abc" },
      })).status,
    ).toBe(401);
  });

  it("accepts a valid signature: outcome appended to the conversation keyed on data.user_id", async () => {
    const h = harness();
    const user = await h.dstore.createUser({
      phone: "+15551230001",
      platform: "imessage",
      spaceId: "any;-;+15551230001",
      lang: "en",
      state: "active",
      loc: null,
      zip: null,
      consentText: true,
      consentVoice: true,
      addressAttempts: 0,
      askedZip: false,
      langConfirmPending: false,
      createdAt: 0,
      updatedAt: 0,
    });
    const payload = structuredClone(OUTCOME_PAYLOAD);
    (payload.data as { user_id: string }).user_id = user.id;
    const res = await postCall(h.app, payload);
    expect(res.status).toBe(200);
    await h.voice.drain();
    const convos = (await h.dstore.listConversations()).filter((e) => e.userId === user.id);
    expect(convos).toHaveLength(1);
    expect(convos[0]).toMatchObject({ from: "bot", text: "Voice check-in call (User reports power outage; household safe.)" });
  });

  it("agent_id fallback: a check-in call (no user_id) answers the dispatched verify request, not a conversation", async () => {
    const h = harness();
    await h.verifyStore.createRequest({
      requestId: "vr:seed-shelter-1:hms-smoke:demo",
      resourceId: "seed-shelter-1",
      resourceName: "Test Shelter",
      hazardSourceId: "hms-smoke:demo",
      agentId: "agent-checkin-1",
      deviceId: null,
      status: "pending",
      outcome: null,
      conversationId: null,
      manual: false,
      createdAt: 0,
      dispatchedAt: null,
      answeredAt: null,
    });
    await h.verifyStore.checkoutPending(null, 1); // agent-checkin poll -> dispatched

    const payload = structuredClone(OUTCOME_PAYLOAD);
    payload.data!.agent_id = "agent-checkin-1";
    payload.data!.user_id = null;
    payload.data!.analysis = { summary: "Partner confirms shelter open at capacity 20." };
    expect((await postCall(h.app, payload)).status).toBe(200);
    await h.voice.drain();
    const requests = await h.verifyStore.listRequests();
    expect(requests[0]).toMatchObject({ status: "answered", outcome: "Partner confirms shelter open at capacity 20.", conversationId: "conv-xyz" });
    // no user conversation was created for a partner-resource call
    expect(await h.dstore.listConversations()).toHaveLength(0);

    // webhook retry (same conversation_id): deduped, one outcome write
    const res2 = await postCall(h.app, structuredClone(payload));
    expect(res2.status).toBe(200);
    await h.voice.drain();
    expect(await h.verifyStore.listRequests()).toHaveLength(1);
  });

  it("unknown event types (post_call_audio / call_initiation_failure) and no-data payloads ack 200 and enqueue nothing", async () => {
    const h = harness();
    expect((await postCall(h.app, { type: "post_call_audio", data: { agent_id: "a", conversation_id: "c", full_audio: "..." } })).status).toBe(200);
    expect((await postCall(h.app, { type: "call_initiation_failure", data: { failure_reason: "busy" } })).status).toBe(200);
    expect((await postCall(h.app, "not json")).status).toBe(200);
    await h.voice.drain();
    expect(await h.dstore.listConversations()).toHaveLength(0);
    expect(await h.verifyStore.listRequests()).toHaveLength(0);
  });

  it("outcome extraction: analysis.summary wins, last user turn is the fallback; un-routable payload records nothing", async () => {
    expect(outcomeFor(OUTCOME_PAYLOAD)).toBe("User reports power outage; household safe.");
    expect(outcomeFor({ type: "post_call_transcription", data: { transcript: [{ role: "user", message: "all clear" }] } })).toBe("all clear");
    expect(outcomeFor({ type: "post_call_transcription", data: {} })).toBeNull();
  });
});
// ---------------------------------------------------------------------------
// Fix round 2 (Task 7 final-review wave): the post-call summary text (demo
// beat 6) — deterministic, lastBrief-composed, rate-limit exempt, consent-fenced.
import { POST_CALL_SUMMARY_RATE_KEY, type VoicePostCallPayload } from "../src/deliver/voice.ts";
import { postCallSummary } from "../src/deliver/post_call_summary.ts";
import type { UserBrief } from "../src/types/brief.ts";

const SUMMARY_BRIEF: UserBrief = {
  userId: "mem-1",
  lang: "es",
  actions: [{ id: "keep-windows-closed", text: "Close windows and stay indoors." }],
  hazards: [{ type: "smoke", severity: 3, title: "Smoke plume near Snoqualmie", timing: "now", validFrom: 0, validTo: 9 }],
  shelter: {
    id: "seed-shelter-1",
    name: "Centro de la Raza",
    distanceKm: 2.1,
    status: "open",
    confidence: 0.8,
    hours: "24h",
    verifiedMinutesAgo: 3,
  },
  blockedRoads: [],
  officialSource: { name: "NWS Seattle", url: "https://weather.gov" },
  emergency: "Call 911 if you are in danger.",
};

describe("post-call summary (demo beat 6)", () => {
  it("postCallSummary: composed only from brief fields; shelter when confident, else official-source nudge; link only when PUBLIC_BASE_URL set", () => {
    const withLink = postCallSummary({ ...SUMMARY_BRIEF, lang: "en" }, "mem-1", true, "https://skywatch.onrender.com");
    expect(withLink).toContain("Smoke plume near Snoqualmie");
    expect(withLink).toContain("Close windows and stay indoors.");
    expect(withLink).toContain("Centro de la Raza is verified open");
    expect(withLink).toContain("https://skywatch.onrender.com/b/mem-1");
    expect(withLink).toContain("Call 911 if you are in danger.");

    const noLink = postCallSummary({ ...SUMMARY_BRIEF, lang: "en" }, "mem-1", false, "http://localhost:3000");
    expect(noLink).not.toContain("/b/");
    expect(postCallSummary({ ...SUMMARY_BRIEF, lang: "en" }, "mem-1", true, "https://skywatch.onrender.com/")).toContain(
      "https://skywatch.onrender.com/b/mem-1",
    );

    const unsure = postCallSummary(
      { ...SUMMARY_BRIEF, lang: "en", shelter: { ...SUMMARY_BRIEF.shelter!, confidence: 0.4, status: "unknown" } },
      "mem-1",
      false,
      "http://localhost:3000",
    );
    expect(unsure).toContain("check official source for shelter status");
    expect(unsure).not.toContain("Centro de la Raza is verified open");
  });

  it("brief-call outcome: conversation note AND summary send (outbox row, not_wired attempt, map link); no phone leak", async () => {
    const prev = process.env["PUBLIC_BASE_URL"];
    process.env["PUBLIC_BASE_URL"] = "https://skywatch.onrender.com";
    try {
      const h = harness({ configEnv: { PUBLIC_BASE_URL: "https://skywatch.onrender.com" } });
      const user = await h.dstore.createUser({
        phone: "+15551230001",
        platform: "imessage",
        spaceId: "any;-;+15551230001",
        lang: "es",
        state: "active",
        loc: null,
        zip: null,
        consentText: true,
        consentVoice: true,
        addressAttempts: 0,
        askedZip: false,
        langConfirmPending: false,
        createdAt: 0,
        updatedAt: 0,
      });
      // The user's delivered alert (meta.brief) is what the summary summarizes.
      await h.dstore.appendOutbox({
        userId: user.id,
        kind: "alert",
        rateKey: "hms-smoke:demo",
        spaceId: user.spaceId,
        platform: user.platform,
        text: "alert text placeholder",
        status: "sent",
        error: null,
        meta: { lang: "es", source: "fallback", brief: { ...SUMMARY_BRIEF, userId: user.id } },
        createdAt: 1,
        sentAt: 1,
      });

      const payload: VoicePostCallPayload = structuredClone(OUTCOME_PAYLOAD);
      payload.data!.user_id = user.id;
      expect((await postCall(h.app, payload)).status).toBe(200);
      await h.voice.drain();

      // existing behavior: the outcome note is on the conversation
      const convos = (await h.dstore.listConversations()).filter((e) => e.userId === user.id);
      expect(convos.some((e) => e.text.startsWith("Voice check-in call"))).toBe(true);
      // new: the summary was composed + sent through the deliver path
      const summaryRows = (await h.dstore.listOutbox()).filter((r) => r.rateKey === POST_CALL_SUMMARY_RATE_KEY);
      expect(summaryRows).toHaveLength(1);
      expect(summaryRows[0]).toMatchObject({ userId: user.id, kind: "alert", status: "not_wired" });
      const summaryText = summaryRows[0]!.text;
      // the user lang is "es": the summary renders the es skeleton (no English-only lines)
      expect(summaryText).toContain("Seguimiento de Skywatch");
      expect(summaryText).toContain("Smoke plume near Snoqualmie");
      expect(summaryText).toContain(`https://skywatch.onrender.com/b/${user.id}`);
      expect(summaryText).toContain("Llame al 911");
      expect(summaryText).not.toContain("Skywatch follow-up");
      expect(summaryText).not.toContain("Call 911 if you are in danger.");
      // privacy: never the phone number
      expect(summaryText).not.toContain(user.phone);
      expect((await h.dstore.listOutbox()).every((r) => !r.text.includes(user.phone))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["PUBLIC_BASE_URL"];
      else process.env["PUBLIC_BASE_URL"] = prev;
    }
  });

  it("STOPped or revoked consent: real behavior — revoked user still gets the conversation note but no summary send; STOPped user gets neither", async () => {
    const h = harness();
    const stopped = await h.dstore.createUser({
      phone: "+15551230002",
      platform: "sms",
      spaceId: "any;-;+15551230002",
      lang: "en",
      state: "active",
      loc: null,
      zip: null,
      consentText: true,
      consentVoice: true,
      addressAttempts: 0,
      askedZip: false,
      langConfirmPending: false,
      createdAt: 0,
      updatedAt: 0,
    });
    await h.dstore.deleteUserByPhone(stopped.phone); // STOP removes the record
    const revoked = await h.dstore.createUser({
      phone: "+15551230003",
      platform: "sms",
      spaceId: "any;-;+15551230003",
      lang: "en",
      state: "active",
      loc: null,
      zip: null,
      consentText: false,
      consentVoice: false,
      addressAttempts: 0,
      askedZip: false,
      langConfirmPending: false,
      createdAt: 0,
      updatedAt: 0,
    });

    // DISTINCT conversation_id per iteration — same id would be queue-deduped
    // before processing (the vacuous-test bug this fixes).
    const stoppedPayload: VoicePostCallPayload = structuredClone(OUTCOME_PAYLOAD);
    stoppedPayload.data!.user_id = stopped.id;
    stoppedPayload.data!.conversation_id = "conv-stopped";
    expect((await postCall(h.app, stoppedPayload)).status).toBe(200);
    await h.voice.drain();
    const revokedPayload: VoicePostCallPayload = structuredClone(OUTCOME_PAYLOAD);
    revokedPayload.data!.user_id = revoked.id;
    revokedPayload.data!.conversation_id = "conv-revoked";
    expect((await postCall(h.app, revokedPayload)).status).toBe(200);
    await h.voice.drain();

    // STOPped: record deleted -> no routing, no note, no summary.
    expect((await h.dstore.listConversations()).filter((e) => e.userId === stopped.id)).toHaveLength(0);
    // revoked: consent fences ONLY the send — the outcome note still lands.
    const revokedConvos = (await h.dstore.listConversations()).filter((e) => e.userId === revoked.id);
    expect(revokedConvos).toHaveLength(1);
    expect(revokedConvos[0]).toMatchObject({ from: "bot", text: "Voice check-in call (User reports power outage; household safe.)" });
    // and neither has a summary outbox row (no post-call-summary send attempt)
    const summaries = (await h.dstore.listOutbox()).filter((r) => r.rateKey === POST_CALL_SUMMARY_RATE_KEY);
    expect(summaries).toHaveLength(0);
    expect(
      (await h.dstore.listOutbox()).filter((r) => r.userId === stopped.id || r.userId === revoked.id),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix wave 3: the post-call summary is language-aware (per-language skeletons).
import type { Lang } from "../src/types/brief.ts";

const LANG_MARKERS: Array<[Lang, { present: RegExp[]; absent: RegExp[] }]> = [
  ["en", { present: [/Skywatch follow-up: /, /is verified open/, /Call 911 if you are in danger\./], absent: [] }],
  ["es",
    {
      present: [/Seguimiento de Skywatch: /, /Refugio .* verificado como abierto/, /Llame al 911/],
      absent: [/is verified open/, /check official source/, /Skywatch follow-up/],
    },
  ],
  [
    "zh",
    { present: [/Skywatch 跟进：/, /已核实为开放/, /如有危险，请拨打911。/], absent: [/is verified open/, /check official source/, /Skywatch follow-up/] },
  ],
  [
    "tl",
    { present: [/Update mula sa Skywatch: /, /Napatunayang bukas ang tuluyan/, /Tumawag sa 911/], absent: [/is verified open/, /check official source/] },
  ],
  [
    "vi",
    { present: [/Cập nhật từ Skywatch: /, /đã được xác nhận còn mở/, /Gọi 911/], absent: [/is verified open/, /check official source/] },
  ],
  [
    "ar",
    { present: [/تحديث من Skywatch/, /تم التأكد أن المأوى/, /اتصل بالرقم 911/], absent: [/is verified open/, /check official source/] },
  ],
];

describe("post-call summary language awareness (fix wave 3)", () => {
  it("table-driven: each brief.lang renders its skeleton markers; non-en never shows the English-only skeleton sentences", () => {
    for (const [lang, { present, absent }] of LANG_MARKERS) {
      const text = postCallSummary({ ...SUMMARY_BRIEF, lang }, "mem-1", false, "http://localhost:3000");
      for (const re of present) expect(re.test(text)).toBe(true);
      for (const re of absent) expect(re.test(text)).toBe(false);
    }
  });

  it("non-en interpolates title and action verbatim (source-facts, not translations), link shape unchanged", () => {
    const text = postCallSummary({ ...SUMMARY_BRIEF, lang: "es" }, "mem-1", true, "https://skywatch.onrender.com");
    expect(text).toContain("Smoke plume near Snoqualmie");
    expect(text).toContain("Close windows and stay indoors.");
    expect(text).toContain("https://skywatch.onrender.com/b/mem-1");
    // the brief's English EMERGENCY_LINE is NOT used outside en (translated row instead)
    expect(text).not.toContain("Call 911 if you are in danger.");
  });

  it("es unsure shelter: the per-language check-official-source line, never the English one", () => {
    const text = postCallSummary(
      { ...SUMMARY_BRIEF, lang: "es", shelter: { ...SUMMARY_BRIEF.shelter!, confidence: 0.4, status: "unknown" } },
      "mem-1",
      false,
      "http://localhost:3000",
    );
    expect(text).toContain("Consulte la fuente oficial para conocer el estado del refugio");
    expect(text).not.toContain("check official source for shelter status");
    expect(text).not.toContain("Refugio");
  });

  it("en summary is byte-identical to the pre-fix-wave output", () => {
    expect(postCallSummary({ ...SUMMARY_BRIEF, lang: "en" }, "mem-1", true, "https://skywatch.onrender.com")).toBe(
      "Skywatch follow-up: Smoke plume near Snoqualmie Close windows and stay indoors. Centro de la Raza is verified open https://skywatch.onrender.com/b/mem-1\nCall 911 if you are in danger.",
    );
  });
});
