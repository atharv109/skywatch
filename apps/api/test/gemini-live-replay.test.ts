import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.ts";
import { renderAlert, type RenderArgs } from "../src/brief/render.ts";
import { fallbackRender } from "../src/brief/fallback.ts";
import { chatReply, type ChatArgs } from "../src/deliver/chat.ts";
import type { UserRecord } from "../src/deliver/store.ts";
import type { UserBrief } from "../src/types/brief.ts";

const NOW = Date.parse("2026-10-18T01:00:00.000Z");

const brief: UserBrief = {
  userId: "u-knob-1",
  lang: "en",
  actions: [{ id: "close-windows", text: "Close windows and doors to keep outside air and smoke out." }],
  hazards: [{ type: "smoke", severity: 3, title: "Smoke plume (heavy)", timing: "now through tonight", validFrom: NOW, validTo: NOW + 3_600_000 }],
  shelter: { id: "shelter-1", name: "Test Shelter", distanceKm: 1.2, status: "open", confidence: 0.8, hours: "24/7", verifiedMinutesAgo: 10 },
  blockedRoads: [{ cameraId: "cam-9800", name: "SR 99 demo", status: "flooded", confidence: 0.9 }],
  officialSource: { name: "NWS / NOAA HMS Fire and Smoke Map", url: "https://fire.airnow.gov" },
  emergency: "Call 911 if you are in danger.",
};

/** Valid Gemini text: every entity is a brief field (validator passes), ≤300 chars — the render-suite's known-good sentence shape. */
const VALID_GEMINI =
  "Smoke plume (heavy) — now through tonight. Test Shelter is open, 1.2 km away. Call 911 if in danger.";

const user = (): UserRecord => ({
  id: "u-knob-1",
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

// The ALERT path parses the candidate text as a JSON render object ({text, voiceScript});
// the CHAT path reads the candidate text plainly. Two mock shapes, one knob.
const renderFetcher = (payload?: Response): typeof fetch =>
  vi.fn(async () => {
    if (payload) return payload;
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ text: VALID_GEMINI, voiceScript: VALID_GEMINI }) }] } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;

const chatFetcher = (payload?: Response): typeof fetch =>
  vi.fn(async () => payload ?? geminiChatBody(VALID_GEMINI)) as unknown as typeof fetch;

function geminiChatBody(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const renderArgs = (config: Config, fetcher: typeof fetch): RenderArgs => ({ brief, config, fetcher } as RenderArgs);

const chatArgs = (config: Config, fetcher: typeof fetch): ChatArgs => ({
  config,
  deliver: { recentConversation: async () => [] } as unknown as ChatArgs["deliver"],
  appStore: null,
  user: user(),
  text: "what should I do?",
  lastBrief: brief,
  fetcher,
  now: NOW,
});

const callCount = (f: typeof fetch): number => (f as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Task 9: GEMINI_LIVE_IN_REPLAY — one knob, fail-safe chain unchanged", () => {
  it("knob OFF (default): REPLAY=1 + key stays the deterministic fallback with ZERO fetch calls", async () => {
    const render = renderFetcher();
    const chat = chatFetcher();
    const config = loadConfig({ REPLAY: "1", GEMINI_API_KEY: "k" });
    const rendered = await renderAlert(renderArgs(config, render));
    expect(rendered.source).toBe("fallback");
    expect(rendered.text).toBe(fallbackRender(brief).text);
    expect(callCount(render)).toBe(0);

    const chatOut = await chatReply(chatArgs(config, chat));
    expect(chatOut.source).toBe("fallback");
    expect(callCount(chat)).toBe(0);
  });

  it("knob ON + key + REPLAY=1: the LIVE path answers (validated), exactly one Gemini call — same for the chat loop", async () => {
    const render = renderFetcher();
    const chat = chatFetcher();
    const config = loadConfig({ REPLAY: "1", GEMINI_API_KEY: "k", GEMINI_LIVE_IN_REPLAY: "1" });
    const rendered = await renderAlert(renderArgs(config, render));
    expect(rendered.source).toBe("gemini");
    expect(rendered.text).toBe(VALID_GEMINI);
    expect(callCount(render)).toBe(1); // validator passed: no retry

    const chatOut = await chatReply(chatArgs(config, chat));
    expect(chatOut.source).toBe("gemini");
    expect(chatOut.reply).toBe(VALID_GEMINI);
    expect(callCount(chat)).toBe(1);
  });

  it("knob ON but the live call FAILS: the fallback answers (validator→retry→fallback chain intact; never a dead beat)", async () => {
    const failure = new Response("boom", { status: 500 });
    const render = renderFetcher(failure.clone());
    const chat = chatFetcher(failure.clone());
    const config = loadConfig({ REPLAY: "1", GEMINI_API_KEY: "k", GEMINI_LIVE_IN_REPLAY: "1" });
    const rendered = await renderAlert(renderArgs(config, render));
    expect(rendered.source).toBe("fallback");
    expect(rendered.text).toBe(fallbackRender(brief).text);
    expect(callCount(render)).toBeGreaterThan(0); // the live answer WAS attempted, the fail-safe caught it

    const chatOut = await chatReply(chatArgs(config, chat));
    expect(chatOut.source).toBe("fallback");
    expect(chatOut.reply).toBe(fallbackRender(brief).text);
  });

  it("REPLAY=0: the knob changes nothing (live was already the behavior without it) — sanity", async () => {
    const render = renderFetcher();
    const config = loadConfig({ REPLAY: "0", GEMINI_API_KEY: "k", GEMINI_LIVE_IN_REPLAY: "1" });
    const rendered = await renderAlert(renderArgs(config, render));
    expect(rendered.source).toBe("gemini");
    expect(callCount(render)).toBe(1);
  });
});