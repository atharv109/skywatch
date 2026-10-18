import { postUpstream } from "@/lib/upstream";

/**
 * POST /api/situation/replay {scenario: "flood"|"smoke"} → POST /scenario/:id/replay
 * on the backend (empty body — the scenario id is the path). Idempotent: the
 * backend upserts fixtures by doc key, so re-running never duplicates.
 */
export async function POST(request: Request) {
  let scenario = "flood";
  try {
    const body = (await request.json()) as { scenario?: unknown };
    if (body?.scenario === "smoke" || body?.scenario === "flood") scenario = body.scenario;
  } catch {
    /* An empty body replays the default scenario. */
  }
  try {
    const upstream = await postUpstream(`/scenario/${scenario}/replay`, {});
    try {
      return Response.json(JSON.parse(upstream.text), { status: upstream.status });
    } catch {
      return Response.json({ error: "The backend sent a bad reply." }, { status: upstream.status === 404 ? 404 : 502 });
    }
  } catch {
    return Response.json({ error: "The backend is unreachable." }, { status: 503 });
  }
}