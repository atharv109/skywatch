import { createHmac } from "node:crypto";
import { normalizePhoneE164 } from "@/lib/format";

/**
 * POST /api/webhooks/photon {phone, text} — the demo signup round-trip. The
 * handler constructs the REAL Stable Spectrum inbound payload ({event, space,
 * message} per photon-interface.md) and signs it server-side with the v0 scheme
 * (`X-Spectrum-Signature: v0=<hmac("v0:<ts>:<rawBody>")>`, `X-Spectrum-Timestamp`),
 * then forwards to /webhooks/photon/message. Nothing is faked: the household
 * phone must come from the request (it keys the backend user), the demo line
 * comes from PHOTON_DISPLAY_E164, and PHOTON_SIGNING_SECRET must be set —
 * otherwise the handler refuses honestly. No number is logged or echoed.
 */
const PHONE_RE = /^\+[1-9]\d{7,14}$/;

export async function POST(request: Request) {
  const enabled = process.env.NEXT_PUBLIC_DEMO_SIGNUP !== "0";
  if (!enabled) {
    return Response.json({ ok: false, configured: false, error: "Demo signup is off." }, { status: 404 });
  }
  let phone = "";
  let text = "hi";
  try {
    const body = (await request.json()) as { phone?: unknown; text?: unknown };
    if (typeof body?.phone === "string" && /^\+?[0-9 ()-]{4,20}$/.test(body.phone)) phone = body.phone;
    if (typeof body?.text === "string" && body.text.length > 0 && body.text.length <= 200) text = body.text;
  } catch {
    /* No body is fine — the handler still validates the pieces it has. */
  }
  const e164 = normalizePhoneE164(phone) || "";
  if (!PHONE_RE.test(e164)) {
    return Response.json({ ok: false, error: "A household phone number in E.164 form is required." }, { status: 400 });
  }
  const demoLine = (process.env.PHOTON_DISPLAY_E164 || "").trim();
  const secret = process.env.PHOTON_SIGNING_SECRET;
  if (!/^\+[1-9]\d{7,14}$/.test(demoLine) || !secret) {
    return Response.json(
      { ok: false, configured: false, error: "Demo signup needs PHOTON_DISPLAY_E164 and PHOTON_SIGNING_SECRET configured." },
      { status: 503 },
    );
  }

  const payload = {
    event: "messages",
    space: { id: `any;-;${demoLine}`, platform: "SMS", type: "dm", phone: demoLine },
    message: {
      id: `spc-msg-client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
      platform: "SMS",
      direction: "inbound",
      timestamp: new Date().toISOString(),
      sender: { id: e164, platform: "SMS" },
      content: { type: "text", text },
    },
  };
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex");

  const origin = (process.env.SKYWATCH_API || "https://skywatch-9kvd.onrender.com").replace(/\/$/, "");
  try {
    const upstream = await fetch(`${origin}/webhooks/photon/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-spectrum-timestamp": ts,
        "x-spectrum-signature": signature,
      },
      body: raw,
      cache: "no-store",
    });
    let enqueued = false;
    try {
      const body = JSON.parse(await upstream.text()) as { enqueued?: boolean };
      enqueued = body.enqueued === true;
    } catch {
      /* Keep the gateway verdict even for a non-JSON reply. */
    }
    return Response.json({ ok: upstream.ok, enqueued, gateway: upstream.status });
  } catch {
    return Response.json({ ok: false, gateway: 503 });
  }
}