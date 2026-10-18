import { apiOrigin, getUpstream } from "@/lib/upstream";

/** Liveness probe for the offline auto-detector — passes the upstream status
 * through, plus the configured backend origin so the LIVE chip can name it. */
export async function GET() {
  try {
    const upstream = await getUpstream("/health");
    const ok = upstream.status === 200;
    return Response.json({ ok, origin: apiOrigin() }, { status: ok ? 200 : 503 });
  } catch {
    return Response.json({ ok: false, origin: apiOrigin() }, { status: 503 });
  }
}