import { postUpstream } from "@/lib/upstream";

export async function POST(request: Request) {
  const url = new URL(request.url);
  void url;
  let json: unknown = {};
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (!json || typeof json !== "object") return Response.json({ error: "Body must be JSON." }, { status: 400 });
  const body = json as Record<string, unknown>;
  if (typeof body.deviceId !== "string" || typeof body.photoRef !== "string" || typeof body.data !== "string") {
    return Response.json({ error: "Photo needs a device, a reference, and the image." }, { status: 400 });
  }
  const upstream = await postUpstream("/mesh/photo", {
    deviceId: body.deviceId,
    photoRef: body.photoRef,
    data: body.data,
    label: typeof body.label === "string" ? body.label : "OTHER",
  });
  try {
    return Response.json(JSON.parse(upstream.text), { status: upstream.status });
  } catch {
    return Response.json({ error: "The gateway did not take the photo." }, { status: upstream.status || 502 });
  }
}
