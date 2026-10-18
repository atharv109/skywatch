import { getToolUpstream } from "@/lib/upstream";

/** GET /api/mesh/state — passthrough of the backend's dark-zone state
 * (messages newest-50 with hashed ids, beacons w/ score+reasons, resources).
 * Tool headers injected server-side: the browser never carries the secret. */
export async function GET() {
  const upstream = await getToolUpstream("/mesh/state");
  try {
    return Response.json(JSON.parse(upstream.text), { status: upstream.status });
  } catch {
    return Response.json({ error: "The mesh state reply was not JSON." }, { status: 502 });
  }
}