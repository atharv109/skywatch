/**
 * Task 10 PREPARED PACK (Wi-Fi-death fallback): pre-fetch OSRM routes for the
 * seed shelters so /mesh/sync can serve an honestly-badged "fixture" route when
 * the live fetch fails during the demo. Run locally/CI (needs network ONCE):
 *
 *     cd apps/api && node scripts/fetch-demo-routes.mjs
 *
 * Writes fixtures/demo-routes.json (committed). Origins: Seattle center + the
 * waterfront (the two demo gateway spots). Uses the REAL public OSRM demo server —
 * the same normalization shape /mesh/routes.ts serves (MeshRouteView).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url)); // apps/api/scripts/
const FIXTURES = join(HERE, "..", "fixtures");
const OSRM = "https://router.project-osrm.org/route/v1";

const ORIGINS = {
  "seattle-center": { lat: 47.605, lon: -122.335 },
  waterfront: { lat: 47.6065, lon: -122.3447 },
};

function haversineKm(a, b) {
  const p = Math.PI / 180;
  const R = 6371;
  const dLat = (b.lat - a.lat) * p;
  const dLon = (b.lon - a.lon) * p;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function instruction(step) {
  const type = typeof step.manoeuvre?.type === "string" ? step.manoeuvre.type : typeof step.maneuver?.type === "string" ? step.maneuver.type : "continue";
  const mod = typeof step.maneuver?.modifier === "string" ? step.maneuver.modifier : typeof step.manoeuvre?.modifier === "string" ? step.manoeuvre.modifier : "";
  const road = typeof step.name === "string" && step.name.length > 0 ? ` on ${step.name}` : "";
  return `${type}${mod ? ` ${mod}` : ""}${road}`.trim();
}

function normalize(route) {
  let coords = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  if (coords.length > 120) {
    const stride = coords.length / 120;
    coords = Array.from({ length: 120 }, (_, i) => coords[Math.floor(i * stride)]);
  }
  const steps = (route.legs?.[0]?.steps ?? []).slice(0, 12).map((s) => ({
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
}

mkdirSync(FIXTURES, { recursive: true });
const shelters = JSON.parse(readFileSync(join(FIXTURES, "shelters-seed.geojson"), "utf8")).features.filter(
  (f) => f.properties?.kind === "shelter",
);

const routes = [];
for (const [name, from] of Object.entries(ORIGINS)) {
  for (const f of shelters) {
    const [lon, lat] = f.geometry.coordinates;
    const to = { shelterId: f.properties.sourceId, name: f.properties.name, lat, lon };
    const profile = haversineKm(from, { lat, lon }) > 3 ? "driving" : "foot";
    const url = `${OSRM}/${profile}/${from.lon},${from.lat};${lon},${lat}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`fetch failed (${res.status}) for ${name} -> ${f.properties.sourceId}; aborting so no half-pack is committed`);
      process.exit(1);
    }
    const body = await res.json();
    const route = body.routes?.[0];
    if (!route?.geometry?.coordinates) {
      console.error(`no route geometry for ${name} -> ${f.properties.sourceId}; aborting`);
      process.exit(1);
    }
    routes.push({
      from,
      to,
      profile,
      ...normalize(route),
      fetchedAt: Date.now(),
      source: "fixture",
    });
    console.log(`ok: ${name} -> ${f.properties.sourceId} (${profile}, ${Math.round(route.distance)} m)`);
  }
}

const pack = {
  comment: "Task 10 PREPARED PACK: pre-fetched OSRM routes (Seattle-center + waterfront -> seed shelters). Served by /mesh/sync ONLY under DEMO_SIGNUP=1 when the live OSRM fetch fails, badged source:'fixture' — never presented as live. Regenerate: node scripts/fetch-demo-routes.mjs (inside apps/api).",
  generatedAt: Date.now(),
  routes,
};
writeFileSync(join(FIXTURES, "demo-routes.json"), `${JSON.stringify(pack, null, 1)}\n`);
console.log(`wrote fixtures/demo-routes.json (${routes.length} routes)`);