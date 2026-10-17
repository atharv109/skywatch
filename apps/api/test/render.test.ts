import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { briefText, callGemini, promptFor, renderAlert } from "../src/brief/render.ts";
import { runPipeline } from "../src/pipeline/run.ts";
import { memoryStore } from "../src/store.ts";
import { memoryDeliverStore } from "../src/deliver/store.ts";
import { memoryMatchStore } from "../src/match/store.ts";
import type { Fetcher } from "../src/brief/render.ts";
import type { UserBrief } from "../src/types/brief.ts";
import type { HazardDoc, ResourceDoc, RoadDoc } from "../src/types/docs.ts";

const NOW = Date.parse("2026-10-18T01:00:00.000Z");
const SEATTLE: [number, number] = [-122.335, 47.605];

function smokeHazardDoc(severity: number, sourceId: string): HazardDoc {
  return {
    sourceId,
    type: "smoke",
    severity,
    title: `Smoke plume (heavy) — ${sourceId}`,
    geometry: {
      type: "Polygon",
      coordinates: [[[-123.5, 46.9], [-121.5, 46.9], [-121.5, 48.5], [-123.5, 48.5], [-123.5, 46.9]]],
    },
    validFrom: NOW - 3_600_000,
    validTo: NOW + 12 * 3_600_000,
    source: "test",
  };
}

const shelterDoc = (): ResourceDoc => ({
  sourceId: "seed-shelter-1",
  kind: "shelter",
  name: "Test Shelter",
  hours: "24/7",
  partner: true,
  status: "open",
  verifiedAt: NOW - 10 * 60_000,
  loc: { type: "Point", coordinates: [-122.34, 47.61] },
});

const roadDoc = (): RoadDoc => ({
  cameraId: "wsdot-9800",
  name: "SR 99 demo",
  loc: { type: "Point", coordinates: [-122.336, 47.6055] },
  status: "flooded",
  verifiedAt: NOW - 5 * 60_000,
  imageUrl: "https://images.example/test.jpg",
});

/** A hand-built brief of the exact locked shape (two instances for the no-leak test). */
export function briefFixture(overrides: Partial<UserBrief> = {}): UserBrief {
  return {
    userId: "u-test-1",
    lang: "en",
    actions: [
      { id: "close-windows", text: "Close windows and doors to keep outside air and smoke out." },
      { id: "mask-if-outside", text: "If you go outside, wear an N95 or better mask." },
    ],
    hazards: [{ type: "smoke", severity: 3, title: "Smoke plume (heavy)", timing: "now through tonight", validFrom: NOW, validTo: NOW + 3_600_000 }],
    shelter: {
      id: "shelter-1",
      name: "Test Shelter",
      distanceKm: 1.2,
      status: "open",
      confidence: 0.8,
      hours: "24/7",
      verifiedMinutesAgo: 10,
    },
    blockedRoads: [{ cameraId: "cam-9800", name: "SR 99 demo", status: "flooded", confidence: 0.9 }],
    officialSource: { name: "NWS / NOAA HMS Fire and Smoke Map", url: "https://fire.airnow.gov" },
    emergency: "Call 911 if you are in danger.",
    ...overrides,
  };
}

/** Wrap a Gemini REST body the way the API actually returns it. */
function geminiHttpResponse(renderObject: unknown, status = 200): Response {
  const inner = typeof renderObject === "string" ? renderObject : JSON.stringify(renderObject);
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: inner }] } }] }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

describe("promptFor (brief shape -> prompt)", () => {
  it("enumerates every brief field family and embeds the brief JSON verbatim", () => {
    const brief = briefFixture();
    const prompt = promptFor(brief);
    for (const marker of ["lang", "hazards", "actions", "shelter", "blockedRoads", "officialSource", '"emergency"']) {
      expect(prompt).toContain(marker);
    }
    expect(prompt).toContain("Smoke plume (heavy)");
    expect(prompt).toContain("Test Shelter");
    expect(prompt).toContain("en|es|zh|tl|vi|ar"); // lang codes enumerated in the prompt contract
  });

  it("never contains a phone number", () => {
    expect(promptFor(briefFixture())).not.toContain("+1555");
  });
});

describe("renderAlert (commit A: write freely, brief-fields join fallback)", () => {
  it("REPLAY=1 and unset key both skip the network and use the brief-fields join", async () => {
    const spy = vi.fn();
    for (const config of [
      loadConfig({ REPLAY: "1", GEMINI_API_KEY: "test-key" }),
      loadConfig({ REPLAY: "0" }),
    ]) {
      const out = await renderAlert({ brief: briefFixture(), config, fetcher: spy as unknown as Fetcher });
      expect(out.source).toBe("brief-fallback");
      expect(out.text).toContain("Call 911 if you are in danger.");
      expect(out.text).toContain("Open shelter: Test Shelter, about 1.2 km away.");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("live: sends the prompt to Gemini and delivers whatever comes back (no validator yet)", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: unknown) =>
      geminiHttpResponse({ text: "Fire smog advisory: stay indoors friends! Air quality index around 190 and rising fast near you.", voiceScript: "Stay indoors." }),
    ) as unknown as Fetcher;
    const config = loadConfig({ REPLAY: "0", GEMINI_API_KEY: "test-key" });
    const out = await renderAlert({ brief: briefFixture(), config, fetcher });
    expect(out.source).toBe("gemini");
    expect(out.text).toContain("190 and rising fast"); // invented number NOT checked in commit A
    const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("key=test-key");
    expect(String((init as { body: string }).body)).toContain("English");
  });

  it("live: any Gemini failure (HTTP 500, non-JSON, empty) falls back to the join on a single attempt", async () => {
    const cases: Fetcher[] = [
      (async () => geminiHttpResponse("unused", 500)) as unknown as Fetcher,
      (async () => new Response("not json at all", { status: 200 })) as unknown as Fetcher,
      (async () => geminiHttpResponse({ nope: 1 })) as unknown as Fetcher,
    ];
    const config = loadConfig({ REPLAY: "0", GEMINI_API_KEY: "test-key" });
    for (const fetcher of cases) {
      const out = await renderAlert({ brief: briefFixture(), config, fetcher });
      expect(out.source).toBe("brief-fallback");
      expect(out.text).toContain("Call 911 if you are in danger.");
    }
  });

  it("callGemini surfaces the exact {text, voiceScript} object", async () => {
    const fetcher = (async () => geminiHttpResponse({ text: "hi", voiceScript: "hello" })) as unknown as Fetcher;
    const out = await callGemini("prompt", "k", { fetcher });
    expect(out).toEqual({ text: "hi", voiceScript: "hello" });
  });

  it("briefText is exactly the deterministic join over brief fields", () => {
    expect(briefText(briefFixture())).toBe(
      "Smoke plume (heavy) — now through tonight. " +
      "Close windows and doors to keep outside air and smoke out. " +
      "If you go outside, wear an N95 or better mask. " +
      "Open shelter: Test Shelter, about 1.2 km away. " +
      "Call 911 if you are in danger.",
    );
  });
});

describe("pipeline wiring (render -> deliver -> outbox)", () => {
  it("outbox alert row stores rendered text + brief + lang + source", async () => {
    const astore = memoryStore();
    const dstore = memoryDeliverStore();
    await astore.upsertHazard(smokeHazardDoc(3, "hms-smoke:demo"));
    await astore.upsertResource(shelterDoc());
    await astore.upsertRoad(roadDoc());
    const created = await dstore.createUser({
      phone: "+15551230000",
      platform: "sms",
      spaceId: "any;-;+15551230000",
      lang: "es",
      state: "active",
      loc: { type: "Point", coordinates: SEATTLE },
      zip: "98104",
      consentText: true,
      consentVoice: true,
      addressAttempts: 0,
      askedZip: false,
      langConfirmPending: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const result = await runPipeline({
      config: loadConfig({ REPLAY: "1" }),
      store: astore,
      match: () => Promise.resolve(memoryMatchStore(astore)),
      deliver: () => Promise.resolve(dstore),
      now: () => NOW,
    });
    expect(result).toMatchObject({ briefedUsers: 1, alerts: { not_wired: 1 } });
    const [row] = await dstore.listOutbox();
    expect(row?.kind).toBe("alert");
    expect(row?.meta).toBeDefined();
    expect(row?.meta!.lang).toBe("es");
    expect(row?.meta!.source).toBe("brief-fallback");
    expect(row?.meta!.brief.userId).toBe(created.id);
    expect(row?.meta!.brief.lang).toBe("es");
  });
});