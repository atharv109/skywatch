import { createHmac } from "node:crypto";

const FALLBACK_PHONE = "+15551110000";
const DEMO_LINE = "+15551239999";

/**
 * POST /api/webhooks/photon {phone?, text?} — the alert-page demo signup. The
 * handler constructs the REAL Stable Spectrum inbound payload ({event, space,
 * message} per photon-interface.md) and signs it server-side with the v0 scheme
 * (`X-Spectrum-Signature: v0=<hmac("v0:<ts>:<rawBody>")>`), then forwards to
 * /webhooks/photon/message. PHOTON_SIGNING_SECRET never ships to the browser and
 * the phone is never logged or echoed back.
 */
export async function POST(request: Request) {
  const enabled = process.env.NEXT_PUBLIC_DEMO_SIGNUP !== "0";
  if (!enabled) {
    return Response.json({ error: "Demo signup is off." }, { status: 404 });
  }
  let phone = "";
  let text = "hi";
  try {
    const body = (await request.json()) as { phone?: unknown; text?: unknown };
    if (typeof body?.phone === "string" && /^\+?[0-9 ()-]{4,20}$/.test(body.phone)) phone = body.phone;
    if (typeof body?.text === "string" && body.text.length > 0 && body.text.length <= 200) text = body.text;
  } catch {
    /* No body is fine — the handler still fills the envelope. */
  }
  if (!phone) phone = process.env.PHOTON_DISPLAY_NUMBER || FALLBACK_PHONE;

  const payload = {
    event: "messages",
    space: { id: `any;-;${phone}`, platform: "SMS", type: "dm", phone: DEMO_LINE },
    message: {
      id: `spc-msg-client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
      platform: "SMS",
      direction: "inbound",
      timestamp: new Date().toISOString(),
      sender: { id: phone, platform: "SMS" },
      content: { type: "text", text },
    },
  };
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const secret = process.env.PHOTON_SIGNING_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: "No PHOTON_SIGNING_SECRET configured." }, { status: 503 });
  }
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