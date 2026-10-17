import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { memoryStore } from "../src/store.ts";
import { memoryMatchStore } from "../src/match/store.ts";
import { emptyPipelineResult } from "../src/pipeline/run.ts";
import { memoryDeliverStore, type DeliverStore, type UserRecord } from "../src/deliver/store.ts";
import { createInboundRuntime, type InboundRuntime } from "../src/deliver/runtime.ts";
import { stubVoiceRuntime } from "../src/deliver/voice_runtime.ts";
import { deliverAlert, isAlertBlocked, ALERT_WINDOW_MS, type SendContext } from "../src/deliver/send.ts";
import { memoryVerifyStore } from "../src/verify/store.ts";
import {
  fromPhoton,
  verifyPhotonSignature,
  toPhoton,
  NotWiredError,
  type PhotonPayload,
} from "../src/deliver/photon.ts";
import { readFixture } from "../src/ingest/fixtureio.ts";
import type { GeocodeResult } from "../src/ingest/geocode.ts";

/** Fixture samples were copied verbatim from the documented Spectrum delivery example. */
const SAMPLES = (await readFixture("photon-inbound-samples.json")) as {
  samples: Array<{ label: string; payload: PhotonPayload }>;
};

const SECRET = "test-webhook-secret";
const NOW = Date.parse("2026-10-18T00:00:00.000Z");

function sign(secret: string, ts: number, raw: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex");
}

interface Harness {
  dstore: DeliverStore;
  app: ReturnType<typeof createApp>;
  inbound: InboundRuntime;
  geocodeCalls: { count: number };
  /** Signed POST against /webhooks/photon/message; drains the queue on a 2xx ack. */
  post(payload: PhotonPayload, opts?: { signature?: string | null; timestamp?: string }): Promise<Response>;
}

function makeHarness(geocode?: (address: string) => Promise<GeocodeResult | null>): Harness {
  const dstore = memoryDeliverStore();
  const config = loadConfig({ REPLAY: "1", PHOTON_WEBHOOK_SIGNING_SECRET: SECRET });
  const geocodeCalls = { count: 0 };
  const ctx = {
    config,
    store: async () => dstore,
    now: () => NOW,
    geocode:
      geocode ??
      (async () => {
        geocodeCalls.count += 1;
        return null;
      }),
  };
  const inbound = createInboundRuntime(ctx);
  const app = createApp(config, {
    store: async () => memoryStore(),
    pipeline: async () => emptyPipelineResult(),
    inbound,
    match: async () => memoryMatchStore(memoryStore()),
    deliver: async () => dstore,
      verify: async () => memoryVerifyStore(),
      voice: stubVoiceRuntime(),
  });
  const post: Harness["post"] = async (payload, opts = {}) => {
    const raw = JSON.stringify(payload);
    const ts = opts.timestamp !== undefined ? Number(opts.timestamp) : Math.floor(Date.now() / 1000);
    const signature = opts.signature === undefined ? sign(SECRET, ts, raw) : opts.signature;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signature !== null) headers["X-Spectrum-Signature"] = signature;
    if (opts.timestamp === undefined) headers["X-Spectrum-Timestamp"] = String(ts);
    const res = await app.request("/webhooks/photon/message", {
      method: "POST",
      body: raw,
      headers,
    });
    if (res.status === 200) await inbound.drain();
    return res;
  };
  return { dstore, app, inbound, geocodeCalls, post };
}

/** Clone the fixture's documented envelope shape for arbitrary text/phone/id. */
function payloadFor(text: string, phone: string, messageId: string, platform = "iMessage"): PhotonPayload {
  const base = structuredClone(SAMPLES.samples[0]!.payload);
  const message = {
    ...base.message,
    id: messageId,
    direction: "inbound",
    timestamp: new Date(NOW).toISOString(),
    sender: { id: phone, platform },
    space: { id: `any;-;${phone}`, platform, type: "dm", phone: "+15551239999" },
    content: { type: "text", text },
  };
  base.message = message;
  base.space = message.space;
  return base;
}

function sampleByLabel(label: string): PhotonPayload {
  const sample = SAMPLES.samples.find((s) => s.label === label);
  if (!sample) throw new Error(`fixture sample '${label}' missing`);
  return sample.payload;
}

async function signedRequest(
  app: Harness["app"],
  rawBody: string,
  headers: Record<string, string>,
): Promise<Response> {
  return app.request("/webhooks/photon/message", { method: "POST", body: rawBody, headers });
}

describe("fromPhoton (fixture samples)", () => {
  it("normalizes all six inbound text samples: spaceId/platform/text/senderId round-trip", () => {
    const hi = fromPhoton(sampleByLabel("hi"));
    expect(hi).not.toBeNull();
    expect(hi?.messageId).toBe("spc-msg-00000000-0000-4000-8000-000000000001");
    expect(hi?.spaceId).toBe("any;-;+15551230001");
    expect(hi?.platform).toBe("imessage");
    expect(hi?.text).toBe("hi");
    expect(hi?.senderId).toBe("+15551230001");

    expect(fromPhoton(sampleByLabel("address"))?.text).toBe("101 Yesler Way, Seattle, WA 98104");
    expect(fromPhoton(sampleByLabel("language"))?.text).toBe("espanol por favor");
    expect(fromPhoton(sampleByLabel("stop"))?.text).toBe("STOP");
    expect(fromPhoton(sampleByLabel("question"))?.text).toBe("Is there smoke near me right now?");
    expect(fromPhoton(sampleByLabel("opt-in-voice"))?.text).toContain("you can call me");
  });

  it("ignores everything that is not an inbound text message (default-branch rule)", () => {
    expect(fromPhoton({ event: "other" })).toBeNull();
    const out = structuredClone(sampleByLabel("hi"));
    out.message!.direction = "outbound";
    expect(fromPhoton(out)).toBeNull();
    const attach = structuredClone(sampleByLabel("hi"));
    attach.message!.content = { type: "attachment" };
    expect(fromPhoton(attach)).toBeNull();
    expect(fromPhoton(null)).toBeNull();
    expect(fromPhoton("not an object")).toBeNull();
  });
});

describe("webhook signature verification", () => {
  it("401 on a bad signature, and the message is not processed", async () => {
    const { post, dstore } = makeHarness();
    const res = await post(payloadFor("hi", "+15551230101", "msg-badsig"), {
      signature: "v0=" + "0".repeat(64),
    });
    expect(res.status).toBe(401);
    expect(await dstore.getUserByPhone("+15551230101")).toBeNull();
  });

  it("400 when signature or timestamp headers are missing; 401 on stale timestamp; 401 fail-closed with no secret", async () => {
    const { app, dstore } = makeHarness();
    const raw = JSON.stringify(sampleByLabel("hi"));
    const resMissing = await signedRequest(app, raw, { "content-type": "application/json" });
    expect(resMissing.status).toBe(400);

    const ts = Math.floor(Date.now() / 1000);
    const staleTs = ts - 6 * 60;
    const resStale = await signedRequest(app, raw, {
      "X-Spectrum-Signature": sign(SECRET, staleTs, raw),
      "X-Spectrum-Timestamp": String(staleTs),
    });
    expect(resStale.status).toBe(401);

    const noSecretResult = verifyPhotonSignature({ rawBody: raw, signature: "v0=ab", timestamp: "1", secret: null, now: NOW });
    expect(noSecretResult).toBe("no-signing-secret");
    expect(await dstore.listConversations()).toHaveLength(0);
  });
});

describe("signed webhook round-trip + signup state machine", () => {
  it("first 'hi' (verbatim fixture payload): creates user, grants text+voice consent, asks for address/ZIP, outbox NOT_WIRED", async () => {
    const { dstore, post } = makeHarness();
    const res = await post(sampleByLabel("hi"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean; enqueued: boolean })).toEqual({ ok: true, enqueued: true });

    const user = await dstore.getUserByPhone("+15551230001");
    expect(user?.state).toBe("asked-address");
    expect(user?.lang).toBe("en");
    expect(user?.consentText).toBe(true);
    expect(user?.consentVoice).toBe(true);
    expect(user?.loc).toBeNull();

    const outbox = (await dstore.listOutbox()).filter((r) => r.userId === user?.id);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ kind: "reply", status: "not_wired", sentAt: null, rateKey: null });
    expect(outbox[0]?.error).toMatch(/not wired/);

    const convo = (await dstore.listConversations()).filter((e) => e.userId === user?.id);
    expect(convo).toHaveLength(2); // user "hi" + bot prompt
    expect(convo[0]?.from).toBe("user");
    expect(convo[1]?.from).toBe("bot");
  });

  it("full chain: hi → geocoded address → 'espanol por favor' → active user with lang es", async () => {
    const phone = "+15551231010";
    // Address text with no 5-digit ZIP token (a ZIP-bearing address takes the
    // hybrid path off zips-wa.tsv, covered in the hybrid test) → Census Geocoder.
    const geocode: GeocodeResult = { lat: 47.609, lon: -122.3292, matchedAddress: "101 Yesler Way", zip: "98104" };
    const { dstore, post } = makeHarness(async (address) =>
      address.includes("Yesler") ? geocode : null,
    );
    let seq = 0;
    const step = async (text: string) => {
      const res = await post(payloadFor(text, phone, `spc-msg-chain-${seq++}`));
      expect(res.status).toBe(200);
    };

    await step("hi");
    expect((await dstore.getUserByPhone(phone))?.state).toBe("asked-address");

    await step("101 Yesler Way, Seattle, Washington");
    const afterAddress = await dstore.getUserByPhone(phone);
    expect(afterAddress?.state).toBe("asked-lang");
    expect(afterAddress?.loc).toEqual({ type: "Point", coordinates: [-122.3292, 47.609] });
    expect(afterAddress?.zip).toBe("98104");

    await step("espanol por favor");
    const active = await dstore.getUserByPhone(phone);
    expect(active?.state).toBe("active");
    expect(active?.lang).toBe("es");

    const outbox = (await dstore.listOutbox()).filter((r) => r.userId === active?.id);
    expect(outbox).toHaveLength(3);
    // every reply attempted (NOT_WIRED without Photon creds) and nothing crashed
    expect(outbox.every((r) => r.status === "not_wired")).toBe(true);
  });

  it("bare ZIP and hybrid '98104 seattle' both resolve off zips-wa.tsv without the geocoder", async () => {
    for (const text of ["98104", "98104 seattle"]) {
      const phone = text === "98104" ? "+15551231020" : "+15551231021";
      const { dstore, geocodeCalls, post } = makeHarness();
      await post(payloadFor("hi", phone, `zip-id-hi-${phone}`));
      await post(payloadFor(text, phone, `zip-id-${phone}`));
      const user = await dstore.getUserByPhone(phone);
      expect(user?.state).toBe("asked-lang");
      expect(user?.loc).toEqual({ type: "Point", coordinates: [-122.3256, 47.6036] });
      expect(user?.zip).toBe("98104");
      expect(geocodeCalls.count).toBe(0);
    }
  });

  it("invalid address: friendly retry once, then the ZIP-only prompt; a WA ZIP recovers", async () => {
    const phone = "+15551231030";
    const { dstore, post } = makeHarness();
    await post(payloadFor("hi", phone, "addr-hi"));
    await post(payloadFor("a place that does not exist", phone, "addr-1"));
    expect((await dstore.getUserByPhone(phone))?.addressAttempts).toBe(1);
    expect((await dstore.getUserByPhone(phone))?.askedZip).toBe(false);

    await post(payloadFor("still nothing real anywhere", phone, "addr-2"));
    const user = await dstore.getUserByPhone(phone);
    expect(user?.addressAttempts).toBe(2);
    expect(user?.askedZip).toBe(true);
    expect(user?.state).toBe("asked-address");
    const outbox = (await dstore.listOutbox()).filter((r) => r.userId === user?.id);
    expect(outbox.at(-1)?.text).toMatch(/5-digit ZIP code/);

    await post(payloadFor("98105", phone, "addr-3"));
    const recovered = await dstore.getUserByPhone(phone);
    expect(recovered?.state).toBe("asked-lang");
    expect(recovered?.zip).toBe("98105");
  });

  it("ambiguous language reply defaults to English but asks for a confirm step", async () => {
    const phone = "+15551231040";
    const { dstore, post } = makeHarness();
    await post(payloadFor("hi", phone, "lang-hi"));
    await post(payloadFor("98104", phone, "lang-zip"));
    await post(payloadFor("je voudrais les alerts", phone, "lang-amb"));
    let user = await dstore.getUserByPhone(phone);
    expect(user?.state).toBe("asked-lang");
    expect(user?.lang).toBe("en");
    expect(user?.langConfirmPending).toBe(true);
    const outbox = (await dstore.listOutbox()).filter((r) => r.userId === user?.id);
    expect(outbox.at(-1)?.text).toMatch(/reply with a language/i);

    await post(payloadFor("ok", phone, "lang-confirm"));
    user = await dstore.getUserByPhone(phone);
    expect(user?.state).toBe("active");
    expect(user?.lang).toBe("en");
  });

  it("native-language replies map: 中文→zh, việt→vi, tagalog→tl, عربي→ar", async () => {
    const cases: Array<[string, string]> = [
      ["中文", "zh"],
      ["việt", "vi"],
      ["tagalog", "tl"],
      ["عربي", "ar"],
    ];
    let seq = 0;
    for (const [text, lang] of cases) {
      const phone = `+155512320${seq++}`;
      const { dstore, post } = makeHarness();
      await post(payloadFor("hi", phone, `langmap-${phone}-1`));
      await post(payloadFor("98104", phone, `langmap-${phone}-2`));
      await post(payloadFor(text, phone, `langmap-${phone}-3`));
      const user = await dstore.getUserByPhone(phone);
      expect(user?.lang).toBe(lang);
      expect(user?.state).toBe("active");
    }
  });

  it("active user asking a question (fixture 'question' sample text) gets a held reply via outbox", async () => {
    const phone = "+15551231050";
    const { dstore, post } = makeHarness();
    await post(payloadFor("hi", phone, "q-1"));
    await post(payloadFor("98104", phone, "q-2"));
    await post(payloadFor("english", phone, "q-3"));
    await post(payloadFor("Is there smoke near me right now?", phone, "q-4"));
    const userId = (await dstore.getUserByPhone(phone))?.id;
    const outbox = (await dstore.listOutbox()).filter((r) => r.userId === userId);
    expect(outbox).toHaveLength(4);
    expect(outbox.at(-1)?.text).toMatch(/urgent hazard/i);
  });
});

describe("idempotence + STOP", () => {
  it("replayed message.id (webhook retry redelivery) is acked 200 but processed once", async () => {
    const phone = "+15551231060";
    const { dstore, post } = makeHarness();
    const payload = payloadFor("hi", phone, "spc-msg-dup-1");
    await post(payload);
    const afterFirst = {
      users: (await dstore.listConversations()).length,
      outbox: (await dstore.listOutbox()).length,
    };
    const res2 = await post(structuredClone(payload)); // same message.id, fresh HMAC
    expect(res2.status).toBe(200);
    expect(await dstore.listConversations()).toHaveLength(afterFirst.users);
    expect(await dstore.listOutbox()).toHaveLength(afterFirst.outbox);
    expect(((await res2.json()) as { enqueued: boolean }).enqueued).toBe(true);
  });

  it("STOP removes the user and never replies; a later message starts a fresh consent", async () => {
    const phone = "+15551231070";
    const { dstore, post } = makeHarness();
    await post(payloadFor("hi", phone, "stop-1"));
    await post(payloadFor("98104", phone, "stop-2"));
    await post(payloadFor("english", phone, "stop-3"));
    const userId = (await dstore.getUserByPhone(phone))?.id;
    const outboxBefore = (await dstore.listOutbox()).filter((r) => r.userId === userId).length;

    expect((await post(payloadFor("STOP", phone, "stop-4"))).status).toBe(200);
    expect(await dstore.getUserByPhone(phone)).toBeNull();
    const outboxAfter = (await dstore.listOutbox()).filter((r) => r.userId === userId);
    expect(outboxAfter).toHaveLength(outboxBefore); // silent: no bot reply for STOP

    // fresh contact = the old consent is gone; a new signup flow begins
    await post(payloadFor("hi", phone, "stop-5"));
    const fresh = await dstore.getUserByPhone(phone);
    expect(fresh?.state).toBe("asked-address");
    expect(fresh?.id).not.toBe(userId);
  });
});

describe("webhook envelope handling (default branches)", () => {
  it("acks non-text content arms and unknown events with 200 and enqueues nothing", async () => {
    const { dstore, post } = makeHarness();
    const attach = sampleByLabel("opt-in-voice");
    attach.message = { ...attach.message, content: { type: "attachment" } };
    expect(((await post(attach)) as Response).status).toBe(200);
    const otherEvent = structuredClone(sampleByLabel("hi"));
    otherEvent.event = "unknown-future-event";
    const res = await post(otherEvent);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { enqueued: boolean }).enqueued).toBe(false);
    expect(await dstore.listConversations()).toHaveLength(0);
    expect(await dstore.listOutbox()).toHaveLength(0);
  });
});

describe("NOT_WIRED toPhoton", () => {
  it("unset creds → NotWiredError mentioning the outbox; nothing thrown through the pipeline", async () => {
    await expect(toPhoton("any;-;+15551239999", "hello", { photonProjectId: null, photonProjectSecret: null })).rejects.toBeInstanceOf(
      NotWiredError,
    );
    await expect(
      toPhoton("any;-;+15551239999", "hello", { photonProjectId: "proj", photonProjectSecret: "sec" }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/not wired/) });
  });
});

describe("rate limit gate (1 alert / user / hazard / 2h, deliver-time outbox lookup)", () => {
  function alertCtx(store: DeliverStore): SendContext {
    return {
      config: { photonProjectId: null, photonProjectSecret: null },
      store: async () => store,
      now: () => NOW,
    };
  }

  it("gate blocks within 2h of a sent alert for the same user+rateKey; frees after; other users/keys unaffected", async () => {
    const store = memoryDeliverStore();
    const base = {
      kind: "alert" as const,
      rateKey: "hazard-1",
      spaceId: "any;-;+15551239999",
      platform: "imessage",
      text: "alert text",
      status: "sent" as const,
      error: null,
      sentAt: NOW,
    };
    await store.appendOutbox({ ...base, userId: "u1", createdAt: NOW });
    expect(await isAlertBlocked(store, "u1", "hazard-1", NOW + 60 * 60 * 1000)).toBe(true);
    expect(await isAlertBlocked(store, "u1", "hazard-1", NOW + ALERT_WINDOW_MS)).toBe(true); // exactly 2h still blocked
    expect(await isAlertBlocked(store, "u1", "hazard-1", NOW + ALERT_WINDOW_MS + 1)).toBe(false);
    expect(await isAlertBlocked(store, "u1", "hazard-2", NOW)).toBe(false); // different hazard
    expect(await isAlertBlocked(store, "u2", "hazard-1", NOW)).toBe(false); // different user
  });

  it("deliverAlert sends → rate_limited on the second → sends again for a different rateKey; suppressed attempts are recorded", async () => {
    const store = memoryDeliverStore();
    const ctx = alertCtx(store);
    const owner = await store.createUser({
      phone: "+15551230999",
      platform: "imessage",
      spaceId: "any;-;+15551239999",
      lang: "en",
      state: "active",
      loc: null,
      zip: null,
      consentText: true,
      consentVoice: true,
      addressAttempts: 0,
      askedZip: false,
      langConfirmPending: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const user = { id: owner.id, spaceId: owner.spaceId, platform: owner.platform };
    expect(await deliverAlert(ctx, user, "smoke:medium:a", "evac text")).toBe("not_wired"); // creds unset
    expect(await deliverAlert(ctx, user, "smoke:medium:a", "evac text again")).toBe("rate_limited");
    expect(await deliverAlert(ctx, user, "smoke:medium:b", "different hazard")).toBe("not_wired");

    const records = await store.listOutbox();
    expect(records.filter((r) => r.status === "not_wired")).toHaveLength(2);
    const suppressed = records.find((r) => r.status === "rate_limited");
    expect(suppressed?.rateKey).toBe("smoke:medium:a");

    // a rate_limited row must NOT extend the block: past the window of the sent one, gate opens
    expect(await isAlertBlocked(store, user.id, "smoke:medium:a", NOW + ALERT_WINDOW_MS + 1)).toBe(false);
  });

  it("consent gate: text/voice=false or absent flags block the alert, record consent_hold, and never count toward the 2h gate", async () => {
    const store = memoryDeliverStore();
    const ctx = alertCtx(store);
    const defaults = (phone: string) => ({
      phone,
      platform: "imessage" as const,
      spaceId: `any;-;${phone}`,
      lang: "en" as const,
      state: "active" as const,
      loc: null,
      zip: null,
      consentText: true,
      consentVoice: true,
      addressAttempts: 0,
      askedZip: false,
      langConfirmPending: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const textFalse = await store.createUser(defaults("+15551236001"));
    await store.updateUser({ ...textFalse, consentText: false });
    const voiceFalse = await store.createUser(defaults("+15551236002"));
    await store.updateUser({ ...voiceFalse, consentVoice: false });
    const absent = await store.createUser(defaults("+15551236003"));
    const residue: Record<string, unknown> = { ...absent };
    delete residue["consentText"]; // flags absent entirely (stale/schema-drift residue)
    delete residue["consentVoice"];
    await store.updateUser(residue as unknown as UserRecord);

    for (const flagged of [textFalse, voiceFalse, absent]) {
      expect(await deliverAlert(ctx, flagged, "hazard-c", "should never go out")).toBe("consent_hold");
      // the consent_hold rows must not register as a sent alert in the 2h gate
      expect(await isAlertBlocked(store, flagged.id, "hazard-c", NOW + 60 * 60 * 1000)).toBe(false);
    }
    const rows = (await store.listOutbox()).filter((r) => r.rateKey === "hazard-c");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "consent_hold")).toBe(true);

    // restoring consent on the first user: the earlier consent_hold did not count, so the alert goes out
    await store.updateUser({ ...textFalse, consentText: true, consentVoice: true });
    expect(await deliverAlert(ctx, textFalse, "hazard-c", "now goes out")).toBe("not_wired");
  });
});