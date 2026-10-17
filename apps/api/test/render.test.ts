import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { callGemini, promptFor, renderAlert } from "../src/brief/render.ts";
import { fallbackRender } from "../src/brief/fallback.ts";
import { MAX_ALERT_CHARS, validateRendered, hasEntityViolation } from "../src/brief/validator.ts";
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
function briefFixture(overrides: Partial<UserBrief> = {}): UserBrief {
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
    expect(prompt).toContain("never mention a shelter, road"); // commit-B safety rules present
  });

  it("never contains a phone number", () => {
    expect(promptFor(briefFixture())).not.toContain("+1555");
  });
});

describe("validateRendered (every mention must be in the brief)", () => {
  it("accepts an on-brief render: names, road names and brief numbers all pass", () => {
    const brief = briefFixture();
    const candidate = {
      text: "Smoke affects your area now. Open shelter: Test Shelter, about 1.2 km away. Flooded or blocked roads: SR 99. Call 911 if you are in danger. Verified 10 minutes ago.",
      voiceScript: "Smoke affects your area. Test Shelter about 1.2 km away. Call 911 if you are in danger.",
    };
    expect(validateRendered(candidate, brief)).toMatchObject({ ok: true, violations: [] });
  });

  it("rejects an invented shelter name (entity -> no retry path)", () => {
    const brief = briefFixture();
    const candidate = { text: "Evacuate to Garfield High School immediately, it is open.", voiceScript: "same" };
    const verdict = validateRendered(candidate, brief);
    expect(verdict.ok).toBe(false);
    expect(hasEntityViolation(verdict)).toBe(true);
    expect(verdict.violations.some((v) => v.detail.includes("Garfield High School"))).toBe(true);
  });

  it("rejects an invented road and an invented number (capacity claim never in a brief)", () => {
    const brief = briefFixture({ blockedRoads: [], shelter: null });
    const badRoad = { text: "Martin Luther King Jr Way is flooded; drive carefully.", voiceScript: "same" };
    expect(hasEntityViolation(validateRendered(badRoad, brief))).toBe(true);

    const badNumber = { text: "Smoke affects your area. Call 911. The shelter capacity is 200 people and air quality is 90.", voiceScript: "same" };
    const verdict = validateRendered(badNumber, brief);
    expect(verdict.ok).toBe(false);
    expect(hasEntityViolation(verdict)).toBe(true);
    expect(verdict.violations.filter((v) => v.kind === "entity").length).toBeGreaterThanOrEqual(2);
  });

  it("rejects modified brief numbers (distance 25 km instead of 1.2) but accepts the exact value", () => {
    const brief = briefFixture();
    const wrongDistance = { text: "Open shelter: Test Shelter, about 25 km away. Call 911 if you are in danger.", voiceScript: "x" };
    expect(hasEntityViolation(validateRendered(wrongDistance, brief))).toBe(true);
    const rightDistance = { text: "Test Shelter about 1.2 km away. Call 911.", voiceScript: "x" };
    expect(validateRendered(rightDistance, brief).ok).toBe(true);
  });

  it("enforces the 300-char bound as a format violation and empty text outright", () => {
    const brief = briefFixture();
    const long = { text: `Smoke affects your area ${"a".repeat(MAX_ALERT_CHARS)}.`, voiceScript: "x" };
    const verdict = validateRendered(long, brief);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.at(0)).toMatchObject({ kind: "format" });
    expect(hasEntityViolation(verdict)).toBe(false); // format only -> retry allowed
    expect(validateRendered({ text: "   ", voiceScript: "x" }, brief).violations.at(0)).toMatchObject({ kind: "format" });
  });

  it("validates the voiceScript for entities too", () => {
    const brief = briefFixture({ shelter: null });
    const candidate = { text: "Smoke affects your area. Call 911.", voiceScript: "Go to West Seattle High School for shelter." };
    const verdict = validateRendered(candidate, brief);
    expect(verdict.ok).toBe(false);
    expect(hasEntityViolation(verdict)).toBe(true);
    expect(verdict.violations.at(0)!.detail).toContain("West Seattle High School");
  });
});

describe("fallbackRender (pre-translated safety floor)", () => {
  const EXPECTED_EN =
    "Smoke plume (heavy) — now through tonight. " +
    "Close windows and doors to keep outside air and smoke out. " +
    "If you go outside, wear an N95 or better mask. " +
    "Open shelter: Test Shelter, about 1.2 km away. " +
    "Flooded or blocked roads: SR 99 demo. " +
    "Call 911 if you are in danger.";

  it("en fallback follows the fixed skeleton with only brief fields interpolated", () => {
    expect(fallbackRender(briefFixture()).text).toBe(EXPECTED_EN);
  });

  it("each of the 6 languages produces in-language text with a language token", () => {
    const tokens: Record<UserBrief["lang"], RegExp | string> = {
      en: "Call 911",
      es: "ventanas",
      zh: /[一-鿿]/u,
      tl: /Bukas|Tumawag/,
      vi: /[ƠƯẠ-ỿ]/u, // Ơ Ư + tone-marked Latin
      ar: /[؀-ۿ]/u,
    };
    for (const lang of ["en", "es", "zh", "tl", "vi", "ar"] as const) {
      const out = fallbackRender(briefFixture({ lang }));
      expect(out.text.length).toBeGreaterThan(40);
      const token = tokens[lang];
      expect(out.text, lang).toMatch(token as RegExp);
      expect(out.voiceScript).toBe(out.text);
    }
    const es = fallbackRender(briefFixture({ lang: "es" }));
    expect(es.text).toContain("Refugio abierto: Test Shelter");
    expect(es.text).toContain("Llame al 911");
  });

  it("worst-case brief (5 long actions, long names, 2 roads) stays within 300 chars in every language", () => {
    const worst = briefFixture({
      actions: [
        { id: "close-windows", text: "Close windows and doors to keep outside air and smoke out." },
        { id: "mask-if-outside", text: "If you go outside, wear an N95 or better mask." },
        { id: "check-on-neighbors", text: "Check on neighbors by phone if they are at risk." },
        { id: "run-air-filter", text: "Run an air filter or fan-filter setup if you have one." },
        { id: "monitor-news", text: "Stay tuned to local news and official alerts." },
      ],
      shelter: { id: "s", name: "A Very Long Community Center And Emergency Shelter Name Here", distanceKm: 987.6, status: "open", confidence: 0.9, hours: "24/7", verifiedMinutesAgo: 4 },
      blockedRoads: [
        { cameraId: "c1", name: "Interstate Ninety Northwest Corridor", status: "flooded", confidence: 0.9 },
        { cameraId: "c2", name: "State Route Five Hundred Twelve", status: "blocked", confidence: 0.9 },
      ],
    });
    for (const lang of ["en", "es", "zh", "tl", "vi", "ar"] as const) {
      expect(fallbackRender({ ...worst, lang }).text.length, lang).toBeLessThanOrEqual(MAX_ALERT_CHARS);
      // the emergency line is never dropped
      expect(fallbackRender({ ...worst, lang }).text).toMatch(/911/);
    }
  });

  it("interpolates ONLY brief fields — a different brief of the same shape leaks nothing across instances", () => {
    const briefA = briefFixture();
    const briefB = briefFixture({
      lang: "es",
      shelter: { id: "sh-2", name: "Centro Comunitario del Valle", distanceKm: 4.5, status: "open", confidence: 0.9, hours: "9-5", verifiedMinutesAgo: 3 },
      blockedRoads: [{ cameraId: "cam-1", name: "Avenida Central", status: "blocked", confidence: 0.7 }],
      hazards: [{ type: "flood", severity: 4, title: "Flood Warning Delta", timing: "now through tonight", validFrom: NOW, validTo: NOW + 3_600_000 }],
      actions: [{ id: "avoid-floodwater", text: "Never walk or drive through floodwater — turn around, do not drown." }],
    });
    const outA = fallbackRender(briefA);
    const outB = fallbackRender(briefB);
    // instance A's entities never appear in instance B's render and vice versa
    expect(outB.text).not.toContain("Test Shelter");
    expect(outB.text).not.toContain("SR 99");
    expect(outB.text).not.toContain("Smoke plume");
    expect(outB.text).not.toContain("Close windows and doors"); // en action text never leaks into es
    expect(outA.text).not.toContain("Centro Comunitario");
    expect(outA.text).not.toContain("Avenida Central");
    expect(outB.text).toContain("Centro Comunitario del Valle");
    expect(outB.text).toContain("Avenida Central");
    // same skeleton across instances: both outputs end with their own language's emergency line
    expect(outA.text.endsWith("Call 911 if you are in danger.")).toBe(true);
    expect(outB.text.endsWith("Llame al 911 si está en peligro.")).toBe(true);
  });

  it("the safety floor always passes its own validator, in all 6 languages", () => {
    for (const lang of ["en", "es", "zh", "tl", "vi", "ar"] as const) {
      const brief = briefFixture({ lang });
      const out = fallbackRender(brief);
      expect(validateRendered(out, brief), lang).toMatchObject({ ok: true, violations: [] });
    }
  });
});

describe("renderAlert (after-commit gates)", () => {
  it("REPLAY=1 and unset key both use the fallback template with zero network calls", async () => {
    const spy = vi.fn();
    for (const config of [
      loadConfig({ REPLAY: "1", GEMINI_API_KEY: "test-key" }),
      loadConfig({ REPLAY: "0" }),
    ]) {
      const out = await renderAlert({ brief: briefFixture(), config, fetcher: spy as unknown as Fetcher });
      expect(out.source).toBe("fallback");
      expect(out.text).toContain("Call 911 if you are in danger.");
      expect(out.text).toContain("Open shelter: Test Shelter, about 1.2 km away.");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("live: a valid Gemini render is delivered (source gemini)", async () => {
    const fetcher = vi.fn(async () =>
      geminiHttpResponse({ text: "Test Shelter is open, 1.2 km away. Call 911 if in danger.", voiceScript: "Shelter open." }),
    ) as unknown as Fetcher;
    const config = loadConfig({ REPLAY: "0", GEMINI_API_KEY: "test-key" });
    const out = await renderAlert({ brief: briefFixture(), config, fetcher });
    expect(out.source).toBe("gemini");
    expect(out.text).toContain("Test Shelter is open, 1.2 km away.");
    expect(out.voiceScript).toBe("Shelter open.");
  });

  it("live: invented entity in Gemini output -> no retry (1 call) -> fallback", async () => {
    const fetcher = vi.fn(async () =>
      geminiHttpResponse({ text: "Evacuate to Garfield High School now. Call 911.", voiceScript: "x" }),
    ) as unknown as Fetcher;
    const config = loadConfig({ REPLAY: "0", GEMINI_API_KEY: "test-key" });
    const out = await renderAlert({ brief: briefFixture(), config, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(out.source).toBe("fallback");
    expect(out.text).toContain("Open shelter: Test Shelter");
  });

  it("live: persistent invalid output -> exactly one retry -> fallback (2 calls)", async () => {
    const fetcher = vi.fn(async () =>
      geminiHttpResponse({ text: `Too long ${"b".repeat(MAX_ALERT_CHARS)}`, voiceScript: "x" }),
    ) as unknown as Fetcher;
    const config = loadConfig({ REPLAY: "0", GEMINI_API_KEY: "test-key" });
    const out = await renderAlert({ brief: briefFixture(), config, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(out.source).toBe("fallback");
    expect(out.text).toContain("Call 911 if you are in danger.");
  });

  it("live: first attempt bad, retry good -> the retry's render is used (2 calls)", async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => geminiHttpResponse({ text: `Overflow ${"c".repeat(MAX_ALERT_CHARS)}`, voiceScript: "x" }))
      .mockImplementation(async () => geminiHttpResponse({ text: "Test Shelter open 1.2 km away. Call 911.", voiceScript: "x" })) as unknown as Fetcher;
    const config = loadConfig({ REPLAY: "0", GEMINI_API_KEY: "test-key" });
    const out = await renderAlert({ brief: briefFixture(), config, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(out.source).toBe("gemini");
    expect(out.text).toContain("Test Shelter open 1.2 km away.");
  });

  it("live: Gemini HTTP failure / non-JSON -> retry once -> fallback", async () => {
    const fetcher = vi.fn(async () => new Response("waf error", { status: 503 })) as unknown as Fetcher;
    const config = loadConfig({ REPLAY: "0", GEMINI_API_KEY: "test-key" });
    const out = await renderAlert({ brief: briefFixture(), config, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(out.source).toBe("fallback");
  });

  it("callGemini surfaces the exact {text, voiceScript} object", async () => {
    const fetcher = (async () => geminiHttpResponse({ text: "hi", voiceScript: "hello" })) as unknown as Fetcher;
    const out = await callGemini("prompt", "k", { fetcher });
    expect(out).toEqual({ text: "hi", voiceScript: "hello" });
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
    expect(row?.meta!.source).toBe("fallback");
    expect(row?.meta!.brief.userId).toBe(created.id);
    expect(row?.meta!.brief.lang).toBe("es");
    expect(row?.text).toContain("Refugio abierto: Test Shelter");
    expect(row?.text).toContain("Llame al 911");
  });
});