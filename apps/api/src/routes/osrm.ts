/**
 * Task 10 — offline walking/driving directions via the public OSRM demo server,
 * fetched at gateway sync (the "when one node gets signal" window) when the
 * gateway's area has a VERIFIED-OPEN shelter. The route is a FACT — no validator —
 * but the honesty badges ride along: fetchedAt + the `source` ("live" = OSRM) / "fixture"
 * = the committed prepared pack, served ONLY under the DEMO_SIGNUP gate, never
 * presented as live). Failure ⇒ null/omitted key — the same all-or-nothing posture
 * as the satellite section (the app falls back to its glow line; nothing blocks and
 * nothing half-arrives).
 */
import { readFixture } from "../ingest/fixtureio.ts";
import type { MeshRouteView, OsrmProfile } from "../mesh/types.ts";

export const OSRM_BASE_URL = "https://router.project-osrm.org/route/v1";
export const OSRM_TIMEOUT_MS = 5_000;
export const OSRM_STEPS_CAP = 12;
/** Profile by straight-line distance: the evacuation default is WALKING; over 3 km that is unrealistic. */
export const OSRM_DRIVING_THRESHOLD_KM = 3;

/** Straight-line distance (haversine) — [lon, lat] order. */
export function osrmDistanceKm(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const R = 6371;
  const p = Math.PI / 180;
  const dLat = (to.lat - from.lat) * p;
  const dLon = (to.lon - from.lon) * p;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(from.lat * p) * Math.cos(to.lat * p) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 100) / 100;
}

export function profileFor(distanceKm: number): OsrmProfile {
  return distanceKm > OSRM_DRIVING_THRESHOLD_KM ? "driving" : "foot";
}

/** One phrase-ified maneuver step ("turn left", "depart", "arrive"). */
interface OsrmStepRaw {
  name?: string;
  distance?: number;
  maneuver?: { type?: string; modifier?: string };
}

function instruction(step: OsrmStepRaw): string {
  const type = typeof step.maneuver?.type === "string" ? step.maneuver.type : "continue";
  const modifier = typeof step.maneuver?.modifier === "string" ? step.maneuver.modifier : "";
  const road = typeof step.name === "string" && step.name.length > 0 ? ` on ${step.name}` : "";
  return `${type}${modifier ? ` ${modifier}` : ""}${road}`.trim();
}

export interface RouteFromTo {
  lat: number;
  lon: number;
}

/**
 * fetchRoute — the OSRM seam: GET /route/v1/{profile}/{from;to}?overview=full&
 * geometries=geojson&steps=true → the normalized MeshRouteView (coords [lat,lon] —
 * capped/sampled, ≤12 steps); 5 s timeout; ANY failure ⇒ null.
 */
export async function fetchRoute(
  from: RouteFromTo,
  to: RouteFromTo,
  profile: OsrmProfile,
  injFetcher?: typeof fetch,
): Promise<Omit<MeshRouteView, "from" | "to" | "fetchedAt" | "source" | "profile"> | null> {
  const url = `${OSRM_BASE_URL}/${profile}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=true`;
  try {
    const doFetch = injFetcher ?? fetch;
    const res = await doFetch(url, { signal: AbortSignal.timeout(OSRM_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`OSRM failed: HTTP ${res.status}`);
    const body = (await res.json()) as { routes?: Array<{ distance?: number; duration?: number; geometry?: { coordinates?: Array<[number, number]> }; legs?: Array<{ steps?: OsrmStepRaw[] }> }> };
    const route = body.routes?.[0] ?? null;
    const coordsLonLat = route?.geometry?.coordinates ?? null;
    if (!route || !Array.isArray(coordsLonLat) || coordsLonLat.length < 2) throw new Error("OSRM response carries no route geometry");
    // Keep the bundle small: sample evenly down to ~120 vertices (shape preserved).
    let coords = coordsLonLat.map(([lon, lat]) => [lat, lon] as [number, number]);
    if (coords.length > 120) {
      const stride = coords.length / 120;
      coords = Array.from({ length: 120 }, (_, i) => coords[Math.floor(i * stride)]!);
    }
    const steps = (route.legs?.[0]?.steps ?? []).slice(0, OSRM_STEPS_CAP).map((s) => ({
      distanceM: Math.round(s.distance ?? 0),
      name: typeof s.name === "string" ? s.name : "",
      instruction: instruction(s),
    }));
    return {
      coords,
      distanceKm: Math.round(((route.distance ?? 0) / 1000) * 100) / 100,
      durationMin: Math.round((route.duration ?? 0) / 60),
      steps,
    };
  } catch (err) {
    console.error("osrm route fetch failed (route omitted):", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * The PREPARED PACK lookup (Wi-Fi-death fallback): demo-routes.json holds
 * pre-fetched MeshRouteViews for the seed shelters; the candidate nearest the
 * CURRENT gateway position wins (the pack contains both the Seattle-center and
 * waterfront origins). Missing fixture / no matching shelter ⇒ null.
 */
export async function preparedRoute(
  from: RouteFromTo,
  shelterId: string,
): Promise<{ route: Omit<MeshRouteView, "from" | "to" | "fetchedAt" | "source" | "profile">; profile: OsrmProfile } | null> {
  try {
    const pack = (await readFixture("demo-routes.json")) as { routes?: Array<MeshRouteView> } | null;
    const hits = (pack?.routes ?? []).filter((r) => r.to.shelterId === shelterId);
    if (hits.length === 0) return null;
    let best = hits[0]!;
    let bestD = Infinity;
    for (const hit of hits) {
      const d = osrmDistanceKm(from, hit.from);
      if (d < bestD) {
        best = hit;
        bestD = d;
      }
    }
    return { route: best, profile: (best.profile ?? "foot") as OsrmProfile };
  } catch {
    return null;
  }
}