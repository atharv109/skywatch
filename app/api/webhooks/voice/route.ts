import { createHmac } from "node:crypto";

/**
 * POST /api/webhooks/voice — post-call sim parity with the real post-call flow.
 * The caller posts the raw post-call webhook payload; the handler signs it
 * server-side the way ElevenLabs does (`elevenlabs-signature: t=<sec>,v1=<hex>`
 * HMAC-SHA256 over "<t>.<rawBody>" keyed by ELEVENLABS_VOICE_WEBHOOK_SECRET) and
 * forwards it to /webhooks/voice/post-call. The secret never leaves the server.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const secret = process.env.ELEVENLABS_VOICE_WEBHOOK_SECRET || process.env.PHOTON_SIGNING_SECRET || "";
  if (!secret) {
    return Response.json({ ok: false, error: "No ELEVENLABS_VOICE_WEBHOOK_SECRET configured." }, { status: 503 });
  }
  const t = String(Math.floor(Date.now() / 1000));
  const signature = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
  const origin = (process.env.SKYWATCH_API || "https://skywatch-9kvd.onrender.com").replace(/\/$/, "");
  try {
    const upstream = await fetch(`${origin}/webhooks/voice/post-call`, {
      method: "POST",
      headers: { "content-type": "application/json", "elevenlabs-signature": signature },
      body: raw,
      cache: "no-store",
    });
    try {
      return Response.json(JSON.parse(await upstream.text()), { status: upstream.status });
    } catch {
      return Response.json({ ok: upstream.ok, gateway: upstream.status }, { status: upstream.status });
    }
  } catch {
    return Response.json({ ok: false, error: "The backend is unreachable." }, { status: 503 });
  }
}