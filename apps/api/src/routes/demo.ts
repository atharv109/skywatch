import { Hono } from "hono";
import { createHmac, randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import { briefToken } from "../brief/linkToken.ts";
import type { AppDeps } from "../deps.ts";
import { buildUserBrief } from "../brief/build.ts";
import type { PhotonPlatform } from "../deliver/photon.ts";
import type { UserRecord } from "../deliver/store.ts";

/**
 * Task 8g — phone-native DEMO onboarding (backend side). The phone app cannot hold
 * the Photon webhook signing secret (a browser never keeps a shared secret), so the
 * demo backend signs the FULL Stable Spectrum inbound envelope SERVER-SIDE and
 * drives the EXACT real path for every signup text: same envelope constructor the
 * Photon adapter documents, same HMAC verification, same id-guarded queue, same
 * signup state machine. Nothing about the signup/brief semantics changes — this is
 * a demo-only driver, GATED OFF unless DEMO_SIGNUP=1 (the lead turns it on; a boot
 * warning fires when on; both routes 403 otherwise) and the phone number is never
 * echoed anywhere beyond the request body (no logs).
 *
 *   POST /demo/signup      { phone (E.164), platform: sms|imessage, texts[] (≤5 × ≤140 chars) }
 *                          → { ok, userId, state, lang, brief, mapLink }
 *   POST /demo/area-brief  { lat, lon } — the AREA brief for a point (no signup
 *                          needed: the phone app's Home fallback), assembled with
 *                          the SAME brief builder / validator semantics as Task 8d's
 *                          Ask-Skywatch context (hazards + rule-table actions +
 *                          verified-open-or-null shelter + officialSource + 911).
 */

const PHONE_RE = /^\+[1-9]\d{7,14}$/;
const MAX_TEXTS = 5;
const MAX_TEXT_CHARS = 140;

/** The FULL Stable Spectrum inbound envelope, exactly the shape the Photon webhook delivers (photon-interface.md). */
function photonEnvelope(phone: string, platform: PhotonPlatform, text: string): Record<string, unknown> {
  const platformHeader = platform === "sms" ? "SMS" : "iMessage";
  const space = { id: `any;-;${phone}`, platform: platformHeader, type: "dm" };
  return {
    event: "messages",
    space,
    message: {
      id: `demo-msg-${randomUUID()}`,
      platform: platformHeader,
      direction: "inbound",
      sender: { id: phone, platform: platformHeader },
      space,
      content: { type: "text", text },
    },
  };
}

export function demoRoutes(config: Config, deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/signup", async (c) => {
    if (!config.demoSignup) return c.json({ error: "demo mode is off (DEMO_SIGNUP is unset)" }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return c.json({ error: "body must be a JSON object" }, 400);
    const reasons: string[] = [];
    const phone = typeof body["phone"] === "string" ? body["phone"] : null;
    const platformRaw = body["platform"];
    const platform: PhotonPlatform | null =
      platformRaw === "sms" ? "sms" : platformRaw === "imessage" ? "imessage" : null;
    const texts = Array.isArray(body["texts"]) ? body["texts"] : null;
    if (phone === null || !PHONE_RE.test(phone)) reasons.push("phone must be an E.164 string (e.g. +15557770001)");
    if (platform === null) reasons.push("platform must be sms or imessage");
    if (texts === null || texts.length === 0 || texts.length > MAX_TEXTS || texts.some((t) => typeof t !== "string" || t.trim().length === 0 || t.length > MAX_TEXT_CHARS)) {
      reasons.push(`texts must be 1..${MAX_TEXTS} signup texts of ${MAX_TEXT_CHARS} chars or fewer`);
    }
    if (reasons.length > 0) return c.json({ error: reasons[0], reasons }, 400);

    const secret = config.photonWebhookSigningSecret;
    const runtime = deps.inbound;
    const now = Date.now();
    try {
      // Drive the EXACT real webhook path per text: envelope -> server-side HMAC ->
      // the runtime's own verify (the same verifyPhotonSignature a forged request
      // must pass) -> accept (id-guarded queue) -> drain (state HAS advanced).
      for (const text of texts as string[]) {
        const ts = Math.floor(now / 1000);
        const raw = JSON.stringify(photonEnvelope(phone!, platform!, text));
        const signature = secret
          ? "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")
          : null;
        if (runtime.verify(raw, { signature: signature ?? undefined, timestamp: String(ts) }, now) !== "ok") {
          // Honest failure: without PHOTON_WEBHOOK_SIGNING_SECRET the demo cannot sign.
          return c.json({ error: "demo signup requires PHOTON_WEBHOOK_SIGNING_SECRET to sign the envelope" }, 503);
        }
        const { enqueued } = runtime.accept(raw);
        if (!enqueued) return c.json({ error: "envelope was not processable (malformed demo text)" }, 503);
      }
      await runtime.drain();

      const user = await (await deps.deliver()).getUserByPhone(phone!);
      if (!user) return c.json({ error: "the signup texts did not create a user" }, 503);
      // byPhone-equivalent: the same brief builder /tools/brief/byPhone serves.
      const brief = user.loc ? await buildUserBrief(await deps.match(), { id: user.id, lang: user.lang, loc: user.loc }, Date.now()) : null;
      // Privacy: the phone is NEVER echoed or logged — the reply keys on userId only.
      return c.json({
        ok: true,
        userId: user.id,
        state: user.state,
        lang: user.lang,
        brief,
        mapLink: `${config.publicBaseUrl}/b/${briefToken(config, user.id)}`,
      });
    } catch (err) {
      // NoMongoError / a store outage must never crash the handler (Hono would 500):
      // degraded demo surface = an honest 503, never a faked signup.
      console.error("demo/signup failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "demo signup unavailable (backend store is down)" }, 503);
    }
  });

  app.post("/area-brief", async (c) => {
    if (!config.demoSignup) return c.json({ error: "demo mode is off (DEMO_SIGNUP is unset)" }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object")
      return c.json({ error: "body must be a JSON object" }, 400);
    const lat = body["lat"];
    const lon = body["lon"];
    if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90 || typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      return c.json({ error: "lat/lon must be finite numbers in range" }, 400);
    }
    // The area brief for a NO-signup phone (Home fallback): the point-based brief —
    // the same builder + validator semantics the per-user pipeline uses; an
    // unvalidated shelter is simply absent (shelter null = the honest "unknown").
    try {
      const brief = await buildUserBrief(
        await deps.match(),
        { id: "demo-area", lang: "en", loc: { type: "Point", coordinates: [lon, lat] } },
        Date.now(),
      );
      // The phone (may be non-English) re-renders i18n client-side; the backend's own
      // validator applies per-brief-language rules when this feeds chat.
      return c.json({ ok: true, lang: "en", brief });
    } catch (err) {
      console.error("demo/area-brief failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "area brief unavailable (backend store is down)" }, 503);
    }
  });

  /**
   * Task 8h: "I already signed up via SMS — the app should continue with THAT
   * account." Same gate, same never-log-the-phone posture; the brief is the
   * byPhone-equivalent (no signup, no writes: a pure read).
   */
  app.post("/brief", async (c) => {
    if (!config.demoSignup) return c.json({ error: "demo mode is off (DEMO_SIGNUP is unset)" }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return c.json({ error: "body must be a JSON object" }, 400);
    const phone = typeof body["phone"] === "string" ? body["phone"] : null;
    const platformRaw = body["platform"];
    if (!phone || !PHONE_RE.test(phone)) return c.json({ error: "phone must be an E.164 string (e.g. +15557770001)" }, 400);
    if (platformRaw !== undefined && platformRaw !== "sms" && platformRaw !== "imessage") {
      return c.json({ error: "platform must be sms or imessage" }, 400);
    }
    try {
      const user = (await (await deps.deliver()).getUserByPhone(phone)) as Pick<UserRecord, "id" | "state" | "lang" | "loc" | "platform"> | null;
      if (!user || (platformRaw !== undefined && user.platform !== platformRaw)) {
        // No user id/phone in the body — an honest fixed sentence (no signups happened / wrong platform).
        return c.json({ error: "no Skywatch account for this phone (text the Skywatch number from that phone first; signup is SMS-verified)" }, 404);
      }
      const brief = user.loc ? await buildUserBrief(await deps.match(), { id: user.id, lang: user.lang, loc: user.loc }, Date.now()) : null;
      return c.json({ ok: true, userId: user.id, state: user.state, lang: user.lang, brief });
    } catch (err) {
      console.error("demo/brief failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "demo brief unavailable (backend store is down)" }, 503);
    }
  });

  return app;
}