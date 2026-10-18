import { postUpstream } from "@/lib/upstream";

function clean(value: unknown) {
  if (!value || typeof value !== "object") return {};
  const body = { ...(value as Record<string, unknown>) };
  delete body.phone;
  delete body.e164;
  delete body.msisdn;
  return body;
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  void url;
  let json: unknown = {};
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const upstream = await postUpstream("/mesh/sync", clean(json));
  try {
    return Response.json(JSON.parse(upstream.text), { status: upstream.status });
  } catch {
    return Response.json({ error: "The gateway sent a bad reply." }, { status: 502 });
  }
}
