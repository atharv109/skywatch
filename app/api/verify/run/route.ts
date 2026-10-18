import { postToolUpstream } from "@/lib/upstream";

/**
 * POST /api/verify/run → POST /verify/run on the backend (shared secret injected
 * server-side). Creates check-in requests for partner resources inside active
 * hazards and returns the list.
 */
export async function POST(request: Request) {
  let deviceId: string | null = null;
  try {
    const body = (await request.json()) as { deviceId?: unknown };
    if (typeof body?.deviceId === "string" && body.deviceId.length > 0) deviceId = body.deviceId;
  } catch {
    /* An empty body is fine — the backend scopes to all partner resources. */
  }
  try {
    const upstream = await postToolUpstream("/verify/run", deviceId ? { deviceId } : {});
    try {
      return Response.json(JSON.parse(upstream.text), { status: upstream.status });
    } catch {
      return Response.json({ error: "The backend sent a bad reply." }, { status: 502 });
    }
  } catch {
    return Response.json({ error: "The backend is unreachable." }, { status: 503 });
  }
}