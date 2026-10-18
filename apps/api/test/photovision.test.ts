import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.ts";
import { createApp } from "../src/server.ts";
import { memoryStore } from "../src/store.ts";
import { memoryMatchStore } from "../src/match/store.ts";
import { memoryDeliverStore } from "../src/deliver/store.ts";
import { stubInboundRuntime } from "../src/deliver/runtime.ts";
import { memoryVerifyStore } from "../src/verify/store.ts";
import { stubVoiceRuntime } from "../src/deliver/voice_runtime.ts";
import { emptyPipelineResult } from "../src/pipeline/run.ts";
import { memoryMeshStore } from "../src/mesh/store.ts";
import { extractJsonLoose, PHOTO_CONFIRM_BOOST, PHOTO_PENDING_REASON, PHOTO_REJECTED_REASON, PHOTO_UNSCORED_REASON, PHOTO_UNVERIFIED_REASON, XAI_VISION_MODEL, XAI_VISION_URL, makePhotoVision, photoPrompt, verifyReportedPhoto } from "../src/mesh/photovision.ts";
import { applyPhotoVerdictToDoc, MESH_SCORE_BASE, scoreUplink } from "../src/mesh/score.ts";
import { assembleMeshState } from "../src/mesh/state.ts";
import { sigMessage } from "../src/mesh/sig.ts";
import type { PhotoVerdictInput } from "../src/mesh/photovision.ts";

const NOW = Date.now();

// Tiny real JPEG header — only the CONTENT TYPE matters to the verifier (bytes are base64 to the mock).
const jpeg = (n = 12): Buffer => {
  const b = Buffer.alloc(n);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
};

/** Completion envelope the mock mirrors (the real endpoint's choice.message.content JSON). */
function completion(match: boolean, confidence: number, detail = "flood water visible") {
  return (url: string): Response =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: `Here you go:\n\`\`\`json\n{"match": ${match}, "confidence": ${confidence}, "detail": "${detail}"}\n\`\`\`` } }] }),
      { status: url ? 200 : 400 },
    );
}

const visionInput = (over: Partial<PhotoVerdictInput> = {}): PhotoVerdictInput => ({
  photoRef: "pv-r1",
  label: "flood",
  status: "flood water at the curb",
  contentType: "image/jpeg",
  data: jpeg().toString("base64"),
  ...over,
});

describe("photo prompt + robust JSON extraction", () => {
  it("the prompt carries the claimed status and the STRICT JSON contract", () => {
    for (const w of ['"flood water at the curb"', "STRICT JSON", '"match"']) {
      expect(photoPrompt("flood water at the curb", "flood")).toContain(w);
    }
  });

  it("extractJsonLoose survives code fences + prose, and returns null on garbage", () => {
    expect(extractJsonLoose('```json\n{"match": true, "confidence": 0.9}\n```')).toEqual({ match: true, confidence: 0.9 });
    expect(extractJsonLoose('sure! {"match": false, "confidence": 0.1, "detail": "x"} done')).toMatchObject({ match: false });
    expect(extractJsonLoose("no json here")).toBeNull();
    expect(extractJsonLoose("not { valid")).toBeNull();
  });
});

describe("verifyReportedPhoto (mocked xAI endpoint — every failure is unscored, never thrown)", () => {
  const config = (over: Partial<Pick<Config, "xaiApiKey" | "xaiVisionModel">> = {}): Pick<Config, "xaiApiKey" | "xaiVisionModel"> => ({
    xaiApiKey: "test-key",
    xaiVisionModel: null,
    ...over,
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("confirmed: parses the fenced JSON inside the completion envelope -> verdict + boost + explainable reason", async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    vi.stubGlobal("fetch", (async (url: string, init: { body: string }) => {
      seen = { url, body: JSON.parse(init.body) };
      return completion(true, 0.94)(XAI_VISION_URL);
    }) as unknown as typeof fetch);
    const v = await verifyReportedPhoto({ config: config() }, visionInput());
    expect(v.verdict).toBe("confirmed");
    expect(v.boost).toBe(PHOTO_CONFIRM_BOOST);
    expect(v.reason).toBe(`+0.2 photo confirms the report (vision: flood, confidence 0.94)`);
    expect(v.confidence).toBe(0.94);
    expect(seen!.url).toBe(XAI_VISION_URL);
    const body = seen!.body as { model: string; messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    expect(body.model).toBe(XAI_VISION_MODEL);
    expect(body.messages[0]!.content[0]!["type"]).toBe("image_url");
    expect(String((body.messages[0]!.content[0]!["image_url"] as { url: string }).url)).toContain("data:image/jpeg;base64,");
    expect(photoPrompt(visionInput().status, null)).toContain("STRICT JSON");
  });

  it("model-config override rides the request (SKYWATCH_XAI_VISION_MODEL)", async () => {
    let model = "";
    vi.stubGlobal("fetch", (async (_url: string, init: { body: string }) => {
      model = JSON.parse(init.body).model;
      return completion(true, 0.9)(XAI_VISION_URL);
    }) as unknown as typeof fetch);
    await verifyReportedPhoto({ config: config({ xaiVisionModel: "grok-9-vision-test" }) }, visionInput());
    expect(model).toBe("grok-9-vision-test");
  });

  it("rejected: a confident non-match is a NEUTRAL note (boost 0), not a penalty", async () => {
    vi.stubGlobal("fetch", (async () => completion(false, 0.91)(XAI_VISION_URL)) as unknown as typeof fetch);
    const v = await verifyReportedPhoto({ config: config() }, visionInput());
    expect(v.verdict).toBe("rejected");
    expect(v.boost).toBe(0);
    expect(v.reason).toBe(PHOTO_REJECTED_REASON);
  });

  it("low confidence either way reads as unscored", async () => {
    vi.stubGlobal("fetch", (async () => completion(true, 0.3)(XAI_VISION_URL)) as unknown as typeof fetch);
    const v = await verifyReportedPhoto({ config: config() }, visionInput());
    expect(v.verdict).toBe("unverified");
    expect(v.boost).toBe(0);
    expect(v.reason).toBe(PHOTO_UNVERIFIED_REASON);
    expect(v.detail).toContain("low vision confidence");
  });

  it("no key -> the legacy not-wired reason (never the network)", async () => {
    const fetchSpy = vi.fn();
    const v = await verifyReportedPhoto({ config: config({ xaiApiKey: null }), fetcher: fetchSpy as unknown as typeof fetch }, visionInput());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(v.reason).toBe(PHOTO_UNSCORED_REASON);
    expect(v.verdict).toBe("unverified");
  });

  it("unsupported content type is unscored without a network call", async () => {
    const fetchSpy = vi.fn(async () => completion(true, 0.9)(XAI_VISION_URL));
    const v = await verifyReportedPhoto({ config: config(), fetcher: fetchSpy as unknown as typeof fetch }, visionInput({ contentType: "image/webp" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(v.verdict).toBe("unverified");
  });

  it("HTTP 500 / thrown fetch / timeout-aborted response all read as unscored (not verified)", async () => {
    vi.stubGlobal("fetch", (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch);
    expect((await verifyReportedPhoto({ config: config() }, visionInput())).reason).toBe(PHOTO_UNVERIFIED_REASON);

    vi.stubGlobal("fetch", (async () => { throw new Error("econnrefused"); }) as unknown as typeof fetch);
    expect((await verifyReportedPhoto({ config: config() }, visionInput())).reason).toBe(PHOTO_UNVERIFIED_REASON);

    vi.stubGlobal("fetch", (async () => new Response("plain prose, no json")) as unknown as typeof fetch);
    expect((await verifyReportedPhoto({ config: config() }, visionInput())).reason).toBe(PHOTO_UNVERIFIED_REASON);
  });

  it("makePhotoVision is the dep-shaped function with the same fail-safe behavior", async () => {
    const v = await makePhotoVision(config(), (async () => completion(true, 0.88)(XAI_VISION_URL)) as unknown as typeof fetch)(
      visionInput(),
    );
    expect(v.verdict).toBe("confirmed");
    expect(v.boost).toBe(PHOTO_CONFIRM_BOOST);
    // fail-safe: an unscored reason never throws into the pipeline
    const bad = await makePhotoVision(config(), (async () => { throw new Error("x"); }) as unknown as typeof fetch)(visionInput());
    expect(bad.verdict).toBe("unverified");
    expect(bad.reason).toBe(PHOTO_UNVERIFIED_REASON);
  });

  it("scoreUplink composes the photo verdict into the stored score/reasons", () => {
    const base = { hazards: [], corroborators: 0, photo: true, unsigned: false };
    expect(scoreUplink({ ...base, photoVerdict: { verdict: "confirmed", boost: 0.2, reason: "+0.2 photo confirms the report (vision: flood, confidence 0.90)", detail: "", confidence: 0.9 } })).toEqual({
      score: 0.7,
      reasons: [`base ${MESH_SCORE_BASE}`, "+0.2 photo confirms the report (vision: flood, confidence 0.90)"],
    });
    // rejected = the neutral note, score untouched beyond base
    const rej = scoreUplink({ ...base, photoVerdict: { verdict: "rejected", boost: 0, reason: PHOTO_REJECTED_REASON, detail: "", confidence: 0.9 } });
    expect(rej.score).toBe(MESH_SCORE_BASE);
    expect(rej.reasons).toContain(PHOTO_REJECTED_REASON);
    // no verdict + photo flag = the legacy unscored reason
    expect(scoreUplink({ ...base, photoVerdict: null }).reasons).toContain("photo-unscored (vision not wired)");
  });

  it("applyPhotoVerdictToDoc: confirmed bumps once (idempotent), rejected/unverified only note", () => {
    const doc = (score: number | null): Parameters<typeof applyPhotoVerdictToDoc>[0] => ({
      id: "p1", type: "hazard", rescueKind: null, status: "flood", lat: 1, lon: 2, ts: NOW, hops: 0, ttl: 7,
      photo: false, deviceId: "d1", verify: "ok", verifyReason: null, score, scoredAt: NOW, reasons: [`base ${MESH_SCORE_BASE}`],
      receivedAt: NOW, to: null, photoRef: "pv-r1",
    });
    const confirmed = { verdict: "confirmed" as const, boost: 0.2, reason: "+0.2 photo confirms the report (vision: flood, confidence 0.90)", detail: "", confidence: 0.9 };
    const bumped = applyPhotoVerdictToDoc(doc(0.7), confirmed)!;
    expect(bumped.score).toBe(0.9);
    expect(bumped.photoVision?.verdict).toBe("confirmed");
    // idempotent second application (gateway retry of the same photoRef)
    expect(applyPhotoVerdictToDoc(bumped, confirmed)).toBe(bumped);
    // rejected only notes
    const noted = applyPhotoVerdictToDoc(doc(0.7), { verdict: "rejected", boost: 0, reason: PHOTO_REJECTED_REASON, detail: "", confidence: 0.9 })!;
    expect(noted.score).toBe(0.7);
    expect(noted.reasons).toContain(PHOTO_REJECTED_REASON);
    // unscored packet -> nothing to apply
    expect(applyPhotoVerdictToDoc(doc(null), confirmed)).toBeNull();
  });
});

/* =========================================================================
 * E2E: the mesh pipeline with the photo verify wired in (hermetic: the LLM
 * endpoint is mocked; the store/queue/packet machinery is the real one).
 * =======================================================================*/
import { createHash, generateKeyPairSync as gen2, sign as sign2 } from "node:crypto";

const deviceHash = (deviceId: string): string =>
  createHash("sha256").update(deviceId).digest("hex").slice(0, 10);

interface Signer {
  deviceId: string;
  pubkey: string;
  sign(fields: { id: string; type: string; ts: number; lat: number; lon: number }): string;
}

function makeSigner(deviceId: string): Signer {
  const { publicKey, privateKey } = gen2("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return {
    deviceId,
    pubkey: Buffer.from(der.subarray(der.length - 32)).toString("base64"),
    sign(fields) {
      return sign2(null, Buffer.from(sigMessage({ ...fields, deviceId })), privateKey).toString("base64");
    },
  };
}

let seq = 0;
function packet(signer: Signer, over: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  const base = { id: `pv-test-p-${seq}`, type: "hazard", status: "flood water at the curb", lat: 47.6, lon: -122.33, ts: NOW - 60_000, hops: 0, ttl: 7 };
  const merged: Record<string, unknown> = { ...base, ...over, deviceId: signer.deviceId, pubkey: signer.pubkey, legacy: false };
  const fields = { id: merged.id as string, type: merged.type as string, ts: merged.ts as number, lat: merged.lat as number, lon: merged.lon as number };
  merged.sig = signer.sign(fields);
  return merged;
}

// The same hermetic harness mesh.test.ts uses, plus the photoVision dep bound to a mock fetcher.
function harness(vision: { respondWith: (url: string) => Response } | null) {
  const astore = memoryStore();
  const meshStore = memoryMeshStore();
  const config = loadConfig({ REPLAY: "1", XAI_API_KEY: "pv-test-key", ...(!vision ? { XAI_API_KEY: "" } : {}) });
  const deps = {
    store: async () => astore,
    pipeline: async () => emptyPipelineResult(),
    inbound: stubInboundRuntime(),
    match: async () => memoryMatchStore(astore),
    deliver: async () => memoryDeliverStore(),
    verify: async () => memoryVerifyStore(),
    voice: stubVoiceRuntime(),
    mesh: async () => meshStore,
    ...(vision ? { photoVision: makePhotoVision(config, (async (url: string) => vision.respondWith(url)) as unknown as typeof fetch) } : {}),
  };
  return { app: createApp(config, deps), meshStore };
}

const GW = "pv-test-gateway";

async function postPhoto(h: ReturnType<typeof harness>, body: Record<string, unknown>): Promise<Response> {
  return h.app.request("/mesh/photo", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

describe("photo pipeline e2e (sync + upload + bundle)", () => {
  it("upload-then-verify: a confirmed verdict bumps the stored packet score exactly once (retry-safe), cluster keeps max", async () => {
    const h = harness({ respondWith: () => completion(true, 0.92)(XAI_VISION_URL) });
    const signer = makeSigner("pv-dev-1");
    // 1. packets sync FIRST (photo bytes not uploaded yet)
    const sync = (await (await h.app.request("/mesh/sync", {
      method: "POST",
      body: JSON.stringify({ deviceId: GW, lat: 47.6, lon: -122.33, packets: [packet(signer, { photoRef: "pv-r-e2e" })] }),
      headers: { "content-type": "application/json" },
    })).json()) as { inserted: number; bundle: { photoReports?: unknown[] } };
    expect(sync.inserted).toBe(1);
    let stored = (await h.meshStore.listPackets())[0]!;
    expect(stored.score).toBe(0.5);
    expect(stored.reasons).toContain(PHOTO_PENDING_REASON);
    expect(sync.bundle.photoReports).toBeUndefined(); // unscored-without-boost rows don't ride the brief panel? (score exists, photo unresolved) -> absent pre-upload

    // 2. the gateway uploads the photo AFTER the sync -> AI-verified boost
    const up = (await (await postPhoto(h, { deviceId: "pv-dev-1", photoRef: "pv-r-e2e", data: jpeg(24).toString("base64"), label: "flood" })).json()) as {
      ok: boolean;
      vision?: { verdict: string; boost: number; reason: string };
    };
    expect(up.ok).toBe(true);
    expect(up.vision).toMatchObject({ verdict: "confirmed", boost: 0.2 });
    stored = (await h.meshStore.listPackets())[0]!;
    expect(stored.score).toBe(0.7);
    expect(stored.reasons).toContain("+0.2 photo confirms the report (vision: flood, confidence 0.92)");
    expect(stored.photoVision?.verdict).toBe("confirmed");

    // 3. idempotent gateway retry of the same photoRef: no double boost
    await postPhoto(h, { deviceId: "pv-dev-1", photoRef: "pv-r-e2e", data: jpeg(24).toString("base64"), label: "flood" });
    stored = (await h.meshStore.listPackets())[0]!;
    expect(stored.score).toBe(0.7);
    expect(stored.reasons.filter((r) => r.startsWith("+0.2 photo confirms"))).toHaveLength(1);

    // 4. the boosted row renders in /mesh/state with the verdict
    const state = (await (await h.app.request("/mesh/state")).json()) as { hazardReports: Array<{ score: number; photoVision: { verdict: string } | null; photoUrl: string | null }> };
    expect(state.hazardReports[0]).toMatchObject({ score: 0.7, photoVision: { verdict: "confirmed" }, photoUrl: "/mesh/photo/pv-r-e2e" });
  });

  it("sync-time verify: bytes already uploaded when the packet arrives -> the boost composes into the ONE sync score", async () => {
    const h = harness({ respondWith: () => completion(true, 0.95)(XAI_VISION_URL) });
    const signer = makeSigner("pv-dev-2");
    // a first, photo-less packet TOFU-pins the device (photos upload only from pinned devices),
    // THEN the bytes upload, THEN the scored packet arrives carrying the pointer.
    const pin = (await (await h.app.request("/mesh/sync", {
      method: "POST",
      body: JSON.stringify({ deviceId: GW, lat: 47.6, lon: -122.33, packets: [packet(signer, { status: "ambient ping" })] }),
      headers: { "content-type": "application/json" },
    })).json()) as { inserted: number };
    expect(pin.inserted).toBe(1);
    const up = (await (await postPhoto(h, { deviceId: signer.deviceId, photoRef: "pv-r-sync", data: jpeg(20).toString("base64"), label: "flood" })).json()) as { ok: boolean };
    expect(up.ok).toBe(true);
    const sync = (await (await h.app.request("/mesh/sync", {
      method: "POST",
      body: JSON.stringify({ deviceId: GW, lat: 47.6, lon: -122.33, packets: [packet(signer, { photoRef: "pv-r-sync" })] }),
      headers: { "content-type": "application/json" },
    })).json()) as { scored: number; bundle: { photoReports?: Array<Record<string, unknown>> } };
    const stored = (await h.meshStore.listPackets()).find((p) => p.photoRef === "pv-r-sync")!;
    expect(stored.photo).toBe(false); // the pointer rides, the legacy flag does not
    expect(stored.score).toBe(0.7); // base + photo confirm
    expect(stored.reasons).toContain("+0.2 photo confirms the report (vision: flood, confidence 0.95)");
    // the downlink bundle's brief-panel news row carries score + reason + the photo link
    expect(sync.bundle.photoReports).toHaveLength(1);
    expect(sync.bundle.photoReports![0]).toMatchObject({
      score: 0.7,
      photoKind: "flood",
      photoUrl: "/mesh/photo/pv-r-sync",
      photoVision: { verdict: "confirmed" },
    });
    expect(JSON.stringify(sync.bundle.photoReports![0]!.reasons)).toContain("photo confirms");
  });

  it("vision failure at upload: the photo upload is NEVER blocked or errored; the packet records the neutral unscored reason", async () => {
    const h = harness({ respondWith: () => new Response("upstream down", { status: 500 }) });
    const signer = makeSigner("pv-dev-3");
    await h.app.request("/mesh/sync", {
      method: "POST",
      body: JSON.stringify({ deviceId: GW, lat: 47.6, lon: -122.33, packets: [packet(signer, { photoRef: "pv-r-fail" })] }),
      headers: { "content-type": "application/json" },
    });
    const res = await postPhoto(h, { deviceId: "pv-dev-3", photoRef: "pv-r-fail", data: jpeg(18).toString("base64"), label: "flood" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; vision?: { verdict: string; reason: string } };
    expect(body.ok).toBe(true);
    expect(body.vision).toMatchObject({ verdict: "unverified", reason: PHOTO_UNVERIFIED_REASON });
    const stored = (await h.meshStore.listPackets())[0]!;
    expect(stored.score).toBe(0.5);
    expect(stored.reasons).toContain(PHOTO_UNVERIFIED_REASON);

    // a LATER retry that succeeds upgrades the verdict and applies the boost exactly once
  });

  it("no XAI key: the pipeline is unchanged — upload ok, no verdict leg, packet keeps its own reasons", async () => {
    const h = harness(null);
    const signer = makeSigner("pv-dev-4");
    await h.app.request("/mesh/sync", {
      method: "POST",
      body: JSON.stringify({ deviceId: GW, lat: 47.6, lon: -122.33, packets: [packet(signer, { photoRef: "pv-r-nokey" })] }),
      headers: { "content-type": "application/json" },
    });
    const res = await postPhoto(h, { deviceId: "pv-dev-4", photoRef: "pv-r-nokey", data: jpeg(16).toString("base64"), label: "fire" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; vision?: unknown };
    expect(body.ok).toBe(true);
    expect(body.vision).toBeUndefined(); // the seam is not wired — nothing composed
    const stored = (await h.meshStore.listPackets())[0]!;
    expect(stored.score).toBe(0.5);
    expect(stored.photoVision).toBeFalsy();
  });

  it("an expired-boost beacon packet: confirm bumps the packet AND its rescue cluster (best score), never decays later", async () => {
    const h = harness({ respondWith: () => completion(true, 0.9)(XAI_VISION_URL) });
    const signer = makeSigner("pv-dev-5");
    await h.app.request("/mesh/sync", {
      method: "POST",
      body: JSON.stringify({ deviceId: GW, lat: 47.6, lon: -122.33, packets: [packet(signer, { type: "beacon", status: "Trapped", photoRef: "pv-r-beacon" })] }),
      headers: { "content-type": "application/json" },
    });
    await postPhoto(h, { deviceId: "pv-dev-5", photoRef: "pv-r-beacon", data: jpeg(22).toString("base64"), label: "fire" });
    const cluster = (await h.meshStore.listBeacons())[0]!;
    expect(cluster.score).toBe(0.7); // the beacon's rescue cluster kept the boosted max
    const later = await assembleMeshState(h.meshStore, NOW + 90 * 60_000);
    expect(later.beacons[0]!.score).toBe(0.7); // rescue kinds are NEVER decayed/downgraded
  });

  it("a rejected verdict leaves the score but records the note in state + the bundle news row", async () => {
    const h = harness({ respondWith: () => completion(false, 0.88)(XAI_VISION_URL) });
    const signer = makeSigner("pv-dev-6");
    await h.app.request("/mesh/sync", {
      method: "POST",
      body: JSON.stringify({ deviceId: GW, lat: 47.6, lon: -122.33, packets: [packet(signer, { photoRef: "pv-r-rej" })] }),
      headers: { "content-type": "application/json" },
    });
    await postPhoto(h, { deviceId: "pv-dev-6", photoRef: "pv-r-rej", data: jpeg(14).toString("base64"), label: "fire" });
    const state = (await (await h.app.request("/mesh/state")).json()) as { hazardReports: Array<{ score: number; photoVision: { verdict: string } | null }> };
    expect(state.hazardReports[0]!.score).toBe(0.5);
    expect(state.hazardReports[0]!.photoVision).toMatchObject({ verdict: "rejected" });
    const sync = (await (await h.app.request("/mesh/sync", {
      method: "POST",
      body: JSON.stringify({ deviceId: GW, lat: 47.6, lon: -122.33, packets: [] }),
      headers: { "content-type": "application/json" },
    })).json()) as { bundle: { photoReports?: Array<{ photoVision: { verdict: string }; reasons: string[] }> } };
    expect(sync.bundle.photoReports![0]!.photoVision).toMatchObject({ verdict: "rejected" });
    expect(JSON.stringify(sync.bundle.photoReports![0]!.reasons)).toContain("does not match");
  });
});