import { createHmac } from "node:crypto";

export async function POST(request: Request) {
  const url = new URL(request.url);
  void url;
  if (process.env.NEXT_PUBLIC_DEMO_SIGNUP !== "1") {
    return Response.json({ error: "Demo signup is off." }, { status: 404 });
  }
  const at = Date.now();
  const payload = JSON.stringify({ event: "demo.signup", source: "web", at });
  const secret = process.env.SKYWATCH_WEBHOOK_SECRET || "skywatch-demo-sign";
  const signature = createHmac("sha256", secret).update(`${at}.${payload}`).digest("hex");
  const paths = ["/webhooks/photon", "/api/webhooks/photon"];
  let last = 404;
  for (const path of paths) {
    try {
      const response = await fetch(`${process.env.SKYWATCH_API || "https://skywatch-9kvd.onrender.com"}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-skywatch-timestamp": String(at),
          "x-skywatch-signature": signature,
        },
        body: payload,
        cache: "no-store",
      });
      last = response.status;
      if (response.status !== 404) {
        return Response.json({ ok: response.ok, gateway: response.status });
      }
    } catch {
      last = 502;
    }
  }
  return Response.json({ ok: false, gateway: last });
}
