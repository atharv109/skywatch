export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("fail") === "1") {
    return Response.json({ error: "Unavailable" }, { status: 503 });
  }
  return Response.json({
    join: "Text hi to Skywatch from your own phone.",
  });
}
