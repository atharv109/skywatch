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
import { POST_CALL_SUMMARY_RATE_KEY, postCallSummary, type VoicePostCallPayload } from "../src/deliver/voice.ts";
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
    const withLink = postCallSummary(SUMMARY_BRIEF, "mem-1", true, "https://skywatch.onrender.com");
    expect(withLink).toContain("Smoke plume near Snoqualmie");
    expect(withLink).toContain("Close windows and stay indoors.");
    expect(withLink).toContain("Centro de la Raza is verified open");
    expect(withLink).toContain("https://skywatch.onrender.com/b/mem-1");
    expect(withLink).toContain("Call 911 if you are in danger.");

    const noLink = postCallSummary(SUMMARY_BRIEF, "mem-1", false, "http://localhost:3000");
    expect(noLink).not.toContain("/b/");
    expect(postCallSummary(SUMMARY_BRIEF, "mem-1", true, "https://skywatch.onrender.com/")).toContain(
      "https://skywatch.onrender.com/b/mem-1",
    );

    const unsure = postCallSummary(
      { ...SUMMARY_BRIEF, shelter: { ...SUMMARY_BRIEF.shelter!, confidence: 0.4, status: "unknown" } },
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
      expect(summaryText).toContain("Smoke plume near Snoqualmie");
      expect(summaryText).toContain(`https://skywatch.onrender.com/b/${user.id}`);
      expect(summaryText).toContain("Call 911 if you are in danger.");
      // privacy: never the phone number
      expect(summaryText).not.toContain(user.phone);
      expect((await h.dstore.listOutbox()).every((r) => !r.text.includes(user.phone))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["PUBLIC_BASE_URL"];
      else process.env["PUBLIC_BASE_URL"] = prev;
    }
  });

  it("STOPped user or revoked consent: no conversation note, no summary row", async () => {
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

    for (const target of [stopped, revoked]) {
      const payload: VoicePostCallPayload = structuredClone(OUTCOME_PAYLOAD);
      payload.data!.user_id = target.id;
      expect((await postCall(h.app, payload)).status).toBe(200);
      await h.voice.drain();
    }
    const convos = await h.dstore.listConversations();
    expect(convos.filter((e) => e.userId === stopped.id)).toHaveLength(0);
    expect(convos.filter((e) => e.userId === revoked.id)).toHaveLength(0);
    const summaries = (await h.dstore.listOutbox()).filter((r) => r.rateKey === POST_CALL_SUMMARY_RATE_KEY);
    expect(summaries).toHaveLength(0);
  });
});
