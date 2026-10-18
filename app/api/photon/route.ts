/**
 * GET /api/photon — the Photon demo line, sourced from the env (never faked).
 * PHOTON_DISPLAY_NUMBER (the human display) + PHOTON_DISPLAY_E164 (the line's
 * E.164) must both be set server-side for a configured answer; otherwise the
 * honest `{configured:false}` reaches the join screen.
 */
// Env-sourced: reading the request (req.url) stops prerendering, so the verdict
// is per-request, never a build-time bake (cacheComponents has no `dynamic` config).
export async function GET(request: Request) {
  void request.url;
  const display = (process.env.PHOTON_DISPLAY_NUMBER || "").trim();
  const e164 = (process.env.PHOTON_DISPLAY_E164 || "").trim();
  const valid = /^\+[1-9]\d{7,14}$/.test(e164);
  if (display && valid) {
    return Response.json({ configured: true, display, e164, join: `Text hi to ${display}.` });
  }
  return Response.json({ configured: false, join: "Photon number connects in the demo session." });
}