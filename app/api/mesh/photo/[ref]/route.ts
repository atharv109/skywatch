import { apiOrigin } from "@/lib/upstream";

export async function GET(request: Request, context: { params: Promise<{ ref: string }> }) {
  const url = new URL(request.url);
  void url;
  const { ref } = await context.params;
  if (!/^[\w-]{8,80}$/.test(ref)) return Response.json({ error: "Unknown photo." }, { status: 404 });
  const upstream = await fetch(`${apiOrigin()}/mesh/photo/${encodeURIComponent(ref)}`, { cache: "no-store" });
  if (!upstream.ok) return Response.json({ error: "Photo is not on the gateway yet." }, { status: upstream.status });
  const type = upstream.headers.get("content-type") || "";
  if (type.includes("json") || type.startsWith("text/")) return imageBody(await upstream.text());
  const bytes = await upstream.arrayBuffer();
  const head = new Uint8Array(bytes.slice(0, 3));
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e;
  const contentType = type.startsWith("image/") ? type : jpeg ? "image/jpeg" : png ? "image/png" : "application/octet-stream";
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": contentType, "cache-control": "private, max-age=300" },
  });
}

function imageBody(text: string) {
  try {
    const parsed = JSON.parse(text) as { data?: string };
    if (typeof parsed.data === "string") {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(parsed.data);
      if (match) {
        const bytes = Buffer.from(match[2], "base64");
        return new Response(bytes, {
          status: 200,
          headers: { "content-type": match[1], "cache-control": "private, max-age=300" },
        });
      }
    }
  } catch {
    /* Fall through when the body is not a data URL. */
  }
  return Response.json({ error: "Photo is not on the gateway yet." }, { status: 502 });
}
