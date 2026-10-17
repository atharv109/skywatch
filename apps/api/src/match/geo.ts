/**
 * Minimal geometry helpers for the in-memory match path (memoryMatchStore, tests).
 * The Mongo store (mongoMatchStore) does the same jobs with server-side spatial
 * queries ($geoIntersects / $geoNear) over the boot 2dsphere indexes, so this only
 * has to cover what the fixtures produce: Polygon / MultiPolygon point-in-polygon
 * and great-circle distance. turf is available per the plan's dependency list but
 * would add a dependency the primary (Mongo) path never runs through — hand-rolled
 * helpers keep both paths dependency-free and testable (Global Constraint 1).
 */

export type Ring = Array<[number, number]>;

/** Haversine distance between [lon, lat] pairs, in kilometers. */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = Math.PI / 180;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Even-odd ray casting against one linear ring. */
function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0];
    const yi = ring[i]![1];
    const xj = ring[j]![0];
    const yj = ring[j]![1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(lon: number, lat: number, rings: Ring[]): boolean {
  const outer = rings[0];
  if (!outer || !inRing(lon, lat, outer)) return false;
  // A hole ring wins: inside outer but inside a hole means outside the polygon.
  for (let i = 1; i < rings.length; i++) {
    if (inRing(lon, lat, rings[i]!)) return false;
  }
  return true;
}

/** Point-in-polygon for the geometries ingest produces (Polygon, MultiPolygon) plus a Point hazard at the exact user coordinate. Other types (LineString etc.) never appear in the fixtures and read as non-intersecting; the Mongo path's $geoIntersects keeps the full generality. */
export function pointInGeometry(
  point: [number, number],
  geometry: { type: string; coordinates: unknown },
): boolean {
  const [lon, lat] = point;
  if (geometry.type === "Polygon") return inPolygon(lon, lat, geometry.coordinates as Ring[]);
  if (geometry.type === "MultiPolygon") return (geometry.coordinates as Ring[][]).some((poly) => inPolygon(lon, lat, poly));
  if (geometry.type === "Point") {
    const coords = geometry.coordinates as [number, number];
    return coords[0] === lon && coords[1] === lat;
  }
  return false;
}