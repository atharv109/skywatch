/**
 * Signup state machine (backend-build-plan.md Task 3): none → asked-address →
 * asked-lang → active. Address via Census Geocoder (src/ingest/geocode.ts) or a
 * bare/hybrid ZIP via fixtures/zips-wa.tsv; ≥2 invalid addresses fall back to a
 * ZIP-only prompt. Consent (text + voice) is granted on the FIRST message
 * (Global Constraint 4); STOP removes the user and never replies (same constraint).
 */
import { readFile } from "node:fs/promises";
import type { Config } from "../config.ts";
import type { Lang } from "../types/brief.ts";
import type { Point } from "../types/docs.ts";
import { geocodeAddress, type GeocodeResult } from "../ingest/geocode.ts";
import { FIXTURES_DIR } from "../ingest/fixtureio.ts";
import type { InboundMessage } from "./photon.ts";
import { chatReply } from "./chat.ts";
import { sendOutbound, type SendContext } from "./send.ts";
import type { UserRecord } from "./store.ts";

export interface InboundContext extends SendContext {
  /** Full config (the send path picks the Photon creds; the webhook needs the signing secret). */
  config: Config;
  geocode: (address: string) => Promise<GeocodeResult | null>;
  /**
   * Task 6 conversational tool loop: where DB-only resource/road reads come from.
   * Optional (absent in older harnesses) — when missing, getBrief still works and
   * the resource/road tools answer "unavailable".
   */
  appStore?: () => Promise<import("../store.ts").AppStore>;
}

/** Friendly-invalid-address retries before the prompt switches to ZIP-only. */
export const MAX_ADDRESS_ATTEMPTS = 2;

/** Global Constraint 4: STOP kills both consents — handled before any state work, silently. */
export function isStop(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === "stop" || t === "stop all" || t === "stop now" || t === "unsubscribe";
}

const LANGUAGE_NAMES: Record<Lang, string> = {
  en: "English",
  es: "Español",
  zh: "中文 (Mandarin)",
  tl: "Tagalog / Filipino",
  vi: "Tiếng Việt",
  ar: "العربية (Arabic)",
};

/**
 * Language = name or native-language reply (photon brief: match common phrases
 * like "español", "中文", "việt", "tagalog", "عربي"). Longer names first so
 * "espanol por favor" hits es before any short token; null → ambiguous → the
 * caller defaults to en and asks for confirmation.
 */
const LANGUAGE_MATCHERS: Array<[Lang, RegExp[]]> = [
  ["es", [/español/, /espanol/, /spanish/, /castellano/]],
  ["zh", [/中文/, /汉语/, /漢語/, /chinese/, /mandarin/]],
  ["tl", [/tagalog/, /filipino/]],
  ["vi", [/việt/, /tiếng việt/, /vietnamese/, /\bviet\b/]],
  ["ar", [/عربي/, /العربية/, /arabic/]],
  ["en", [/english/, /inglés/, /ingles/]],
];

export function matchLanguage(text: string): Lang | null {
  const t = text.toLowerCase();
  for (const [lang, patterns] of LANGUAGE_MATCHERS) {
    if (patterns.some((p) => p.test(t))) return lang;
  }
  return null;
}

const BARE_ZIP = /^(\d{5})(?:\s*-\s*\d{4})?$/;
/** A standalone 5-digit group inside longer text ("98104 seattle" hybrid). */
const ZIP_TOKEN = /(?:^|\D)(\d{5})(?=\D|$)/;

interface ZipIndex {
  get(zip: string): Point | undefined;
}

let zipIndexCache: ZipIndex | null = null;

/** fixtures/zips-wa.tsv (Task 2 fixture): "zip\tlat\tlon" — [lon, lat] GeoJSON order. */
async function getZipIndex(): Promise<ZipIndex> {
  if (zipIndexCache) return zipIndexCache;
  const raw = await readFile(`${FIXTURES_DIR}zips-wa.tsv`, "utf8");
  const map = new Map<string, Point>();
  for (const line of raw.split(/\r?\n/)) {
    const columns = line.split("\t");
    const [zip, lat, lon] = columns;
    if (!zip || !lat || !lon || zip === "zip") continue;
    const latNum = Number(lat);
    const lonNum = Number(lon);
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) continue;
    map.set(zip, { type: "Point", coordinates: [lonNum, latNum] });
  }
  zipIndexCache = { get: (zip) => map.get(zip) };
  return zipIndexCache;
}

export interface LocatedPoint {
  loc: Point;
  zip: string | null;
}

/**
 * Bare ZIP / hybrid ("98104 seattle") resolve straight off zips-wa.tsv (no
 * network); anything else (or a hybrid ZIP missing from the WA table) goes to
 * Census Geocoder. null = could not locate (caller counts an invalid attempt).
 */
export async function resolveLocation(ctx: InboundContext, text: string): Promise<LocatedPoint | null> {
  const t = text.trim();
  const bare = t.match(BARE_ZIP);
  if (bare) {
    const zip = bare[1]!;
    const hit = (await getZipIndex()).get(zip);
    return hit ? { loc: hit, zip } : null;
  }
  const token = t.match(ZIP_TOKEN);
  if (token) {
    const hit = (await getZipIndex()).get(token[1]!);
    if (hit) return { loc: hit, zip: token[1]! };
  }
  const geo = await ctx.geocode(t);
  if (!geo) return null;
  return { loc: { type: "Point", coordinates: [geo.lon, geo.lat] }, zip: geo.zip };
}

/** Bot reply texts (English constants; per-language templates land with Task 5's renderer). */
export const REPLY = {
  welcome:
    "Hi! Skywatch sends emergency smoke + flood alerts near you, with text updates and optional voice check-in calls. What's your home address or WA ZIP code? Reply STOP at any time to opt out.",
  askLang:
    "Got it — you're signed up. Which language should alerts use? Reply with one of: English / Español / 中文 / Tiếng Việt / Tagalog / العربية.",
  langOk: (lang: Lang) =>
    `Skywatch alerts will be sent in ${LANGUAGE_NAMES[lang]}. You're all set — we'll message you only when something urgent is inside your area.`,
  askEnglishConfirm:
    "Not sure which language that is — we'll use English for now. Reply 'ok' to keep English, or reply with a language: English / Español / 中文 / Tiếng Việt / Tagalog / العربية.",
  retriedAddress:
    "Sorry, I couldn't find that address. Please reply with your full street address (house, street, city), or a 5-digit WA ZIP code.",
  askZip: "Still no match — let's simplify. Please reply with just a 5-digit ZIP code (for example 98104).",
  zipUnknown:
    "That ZIP isn't in our Washington coverage area. Please reply with a WA ZIP code or your full street address.",
  active:
    "You're on Skywatch for your area. We'll message you here only when there's an urgent hazard nearby; reply STOP to opt out anytime.",
};

// The confirm step's accepted words, lowercased/trimmed ("es"/"sí" included).
const CONFIRM_WORDS = /^(ok|okay|yes|yep|yeah|sure|si|sí|correct|please)[\W_]*$/;

/**
 * The in-process queue's processing target: one inbound message = one state-machine
 * transition. Errors are statuses/outbox rows — never propagate to the webhook.
 */
export async function processInbound(msg: InboundMessage, ctx: InboundContext): Promise<void> {
  if (isStop(msg.text)) {
    await (await ctx.store()).deleteUserByPhone(msg.senderId);
    return; // no reply to STOP, after or before
  }
  const store = await ctx.store();
  const now = ctx.now();
  let user = await store.getUserByPhone(msg.senderId);
  if (!user) {
    // First message = consent for text AND voice (Global Constraint 4), in one write.
    user = await store.createUser({
      phone: msg.senderId,
      platform: msg.platform,
      spaceId: msg.spaceId,
      lang: "en",
      state: "asked-address",
      loc: null,
      zip: null,
      consentText: true,
      consentVoice: true,
      addressAttempts: 0,
      askedZip: false,
      langConfirmPending: false,
      createdAt: now,
      updatedAt: now,
    });
    await store.appendConversation({ userId: user.id, from: "user", text: msg.text, at: now });
    await sendOutbound(ctx, user, REPLY.welcome);
    return;
  }
  await store.appendConversation({ userId: user.id, from: "user", text: msg.text, at: now });
  switch (user.state) {
    case "asked-address":
      await onAddress(user, ctx, msg.text);
      return;
    case "asked-lang":
      await onLanguage(user, ctx, msg.text);
      return;
    case "active": {
      // Conversational tool loop (Task 6): only when the conversation has a
      // lastBrief (an alert already delivered to this user). Without one the
      // hold-the-line reply stands — the SMS-gate interplay is unchanged.
      const lastBrief = await store.lastBrief(user.id);
      if (lastBrief) {
        const chat = await chatReply({
          config: ctx.config,
          deliver: store,
          appStore: (await ctx.appStore?.()) ?? null,
          user,
          text: msg.text,
          lastBrief,
        });
        await sendOutbound(ctx, user, chat.reply);
      } else {
        await sendOutbound(ctx, user, REPLY.active);
      }
      return;
    }
  }
}

interface MutableUser extends UserRecord {}

async function onAddress(user: MutableUser, ctx: InboundContext, text: string): Promise<void> {
  const store = await ctx.store();
  const resolved = await resolveLocation(ctx, text);
  if (resolved) {
    user.loc = resolved.loc;
    user.zip = resolved.zip;
    user.state = "asked-lang";
    user.addressAttempts = 0;
    user.updatedAt = ctx.now();
    await store.updateUser(user);
    await sendOutbound(ctx, user, REPLY.askLang);
    return;
  }
  user.addressAttempts += 1;
  user.askedZip = user.askedZip || user.addressAttempts >= MAX_ADDRESS_ATTEMPTS;
  user.updatedAt = ctx.now();
  await store.updateUser(user);
  await sendOutbound(ctx, user, user.askedZip ? REPLY.askZip : REPLY.retriedAddress);
}

async function onLanguage(user: MutableUser, ctx: InboundContext, text: string): Promise<void> {
  const store = await ctx.store();
  const t = text.trim().toLowerCase();
  // The confirm step: an ambiguous reply defaulted to en; "ok"/"yes"/... locks it in.
  if (user.langConfirmPending && CONFIRM_WORDS.test(t)) {
    user.langConfirmPending = false;
    user.state = "active";
    user.updatedAt = ctx.now();
    await store.updateUser(user);
    await sendOutbound(ctx, user, REPLY.langOk(user.lang));
    return;
  }
  const lang = matchLanguage(text);
  if (lang) {
    user.lang = lang;
    user.langConfirmPending = false;
    user.state = "active";
    user.updatedAt = ctx.now();
    await store.updateUser(user);
    await sendOutbound(ctx, user, REPLY.langOk(lang));
    return;
  }
  // Ambiguous: default en (brief) but confirm before locking it in.
  user.lang = "en";
  user.langConfirmPending = true;
  user.updatedAt = ctx.now();
  await store.updateUser(user);
  await sendOutbound(ctx, user, REPLY.askEnglishConfirm);
}