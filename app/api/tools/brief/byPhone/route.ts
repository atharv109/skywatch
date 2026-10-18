import { getToolUpstream } from "@/lib/upstream";

/**
 * GET /api/tools/brief/byPhone?platform=sms|imessage&phone=<e164> → GET
 * /tools/brief/byPhone/:platform/:phone with the shared secret injected
 * server-side. Privacy: the phone is never logged or echoed — the handler only
 * interpolates it into the upstream path and returns the upstream brief verbatim
 * (the brief carries no identifiers, per the locked contract).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const platform = url.searchParams.get("platform") === "imessage" ? "imessage" : "sms";
  const phone = url.searchParams.get("phone");
  if (!phone || !/^\+?[0-9 ()-]{4,20}$/.test(phone)) {
    return Response.json({ error: "A phone parameter is required." }, { status: 400 });
  }
  try {
    const upstream = await getToolUpstream(`/tools/brief/byPhone/${platform}/${encodeURIComponent(phone)}`);
    if (upstream.status === 200) {
      try {
        return Response.json(JSON.parse(upstream.text), {
          headers: { "cache-control": "no-store" },
        });
      } catch {
        return Response.json({ error: "The backend sent a bad reply." }, { status: 502 });
      }
    }
    return Response.json({ error: "No brief for that phone yet." }, { status: upstream.status === 401 ? 503 : 404 });
  } catch {
    return Response.json({ error: "The backend is unreachable." }, { status: 503 });
  }
}