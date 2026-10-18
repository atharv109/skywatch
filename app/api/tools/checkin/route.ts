import { postToolUpstream } from "@/lib/upstream";

/**
 * POST /api/tools/checkin {resourceId, status, capacity?, notes?} → POST
 * /tools/checkin with the shared secret injected server-side (manual:true — the
 * dashboard path of the one check-in endpoint).
 */
export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const body = (json ?? {}) as Record<string, unknown>;
  if (typeof body.resourceId !== "string" || body.resourceId.length === 0) {
    return Response.json({ error: "resourceId is required." }, { status: 400 });
  }
  if (typeof body.status !== "string") {
    return Response.json({ error: "status is required." }, { status: 400 });
  }
  const upstream = await postToolUpstream("/tools/checkin", {
    resourceId: body.resourceId,
    status: body.status,
    manual: true,
    ...(typeof body.capacity === "number" ? { capacity: body.capacity } : {}),
    ...(typeof body.notes === "string" && body.notes.length > 0 ? { notes: body.notes } : {}),
  });
  try {
    return Response.json(JSON.parse(upstream.text), { status: upstream.status });
  } catch {
    return Response.json({ error: "The backend did not confirm the check-in." }, { status: upstream.status === 401 ? 503 : 502 });
  }
}