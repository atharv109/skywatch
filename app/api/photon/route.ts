export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("fail") === "1") {
    return Response.json({ error: "Number unavailable" }, { status: 503 });
  }
  return Response.json({
    display: "510-555-0142",
    e164: "+15105550142",
  });
}
