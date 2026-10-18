import { getUpstream } from "@/lib/upstream";

/** Liveness probe for the offline auto-detector — passes the upstream status through. */
export async function GET() {
  try {
    const upstream = await getUpstream("/health");
    return Response.json({ ok: upstream.status === 200 }, { status: upstream.status === 200 ? 200 : 503 });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}