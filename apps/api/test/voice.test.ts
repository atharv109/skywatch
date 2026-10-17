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