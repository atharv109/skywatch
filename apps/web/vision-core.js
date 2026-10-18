/**
 * Skywatch on-device infrastructure-damage vision - PURE logic (no DOM, no model).
 * ES module: loaded in the browser by vision.js via dynamic import(), and imported
 * directly by vitest (apps/web/test/vision-core.test.ts). Keep it dependency-free.
 *
 * Model (see vision.js): Xenova/mobileclip_s1 vision tower (fp32, ~86 MB; int8 collapses accuracy) +
 * PRECOMPUTED label text embeddings (vision-labels.json) - zero-shot, so the text
 * tower never ships to the phone. Accuracy is UNVALIDATED on disaster photos.
 */

/** Zero-shot label set. kind=null => not a hazard (never reported). prompts feed the embedding build script. */
export const LABELS = [
  { id: "road-intact", kind: null, label: "Road intact", prompts: ["a photo of a normal intact paved road", "a clear drivable street with no damage"] },
  { id: "road-flooded", kind: "flood", label: "Flooded road", prompts: ["a photo of a flooded road with standing water", "a street covered by floodwater", "a car driving through deep flood water on a road"] },
  { id: "road-blocked", kind: "blocked", label: "Road blocked by debris", prompts: ["a photo of a road blocked by debris", "a road blocked by a fallen tree", "a street covered in rubble and wreckage"] },
  { id: "road-damaged", kind: "road-damage", label: "Cracked or collapsed road", prompts: ["a photo of a cracked and broken road after an earthquake", "a road with a large sinkhole or collapsed pavement", "damaged asphalt road with deep cracks"] },
  { id: "bridge-intact", kind: null, label: "Bridge intact", prompts: ["a photo of an intact bridge", "an undamaged highway bridge"] },
  { id: "bridge-damaged", kind: "bridge", label: "Bridge damaged", prompts: ["a photo of a collapsed bridge", "a damaged bridge with a broken span", "a bridge destroyed by a disaster"] },
  { id: "landslide", kind: "landslide", label: "Landslide", prompts: ["a photo of a landslide covering a road with mud and rocks", "a mudslide burying a road", "a rockslide on a hillside road"] },
  { id: "power-line-down", kind: "power-line", label: "Downed power line", prompts: ["a photo of a downed power line lying on the ground", "a fallen utility pole with tangled wires", "power lines hanging across a road"] },
  { id: "wildfire", kind: "fire", label: "Wildfire or smoke", prompts: ["a photo of a wildfire burning", "thick smoke rising from a fire near a road", "flames and a burning building"] },
  { id: "none", kind: null, label: "Nothing notable", prompts: ["a photo of a person indoors", "a photo of a room or an everyday object", "an ordinary photo with no disaster"] },
];

/** hazard kinds the confirm sheet / map / chat card understand */
export const HAZARD_KINDS = ["flood", "blocked", "road-damage", "bridge", "landslide", "power-line", "fire"];

/** reports below this top-1 softmax confidence are not offered (manual chooser instead) */
export const CONFIDENCE_THRESHOLD = 0.7;
/** CLIP-style logit scale applied to cosine similarity before softmax */
export const LOGIT_SCALE = 100;
/** marker dedupe: same kind within this distance AND window merges into one marker */
export const MERGE_RADIUS_M = 40;
export const MERGE_WINDOW_MS = 30 * 60 * 1000;
export const MAX_MARKERS = 60;
/** directions-agent contract: warn when a route passes within this many metres */
export const WARN_RADIUS_M = 60;

/** server photo-label enum (app.js PHOTO_LABELS) a kind maps to - keeps the existing photo store contract */
const SERVER_LABEL = { flood: "flood", fire: "fire", blocked: "road-broken", "road-damage": "road-broken", bridge: "road-broken", landslide: "road-broken", "power-line": "other" };

export function labelById(id) { return LABELS.find((l) => l.id === id) || null; }
export function labelToKind(id) { const l = labelById(id); return l ? l.kind : null; }
export function serverPhotoLabel(kind) { return SERVER_LABEL[kind] || "other"; }

/** vocabulary the directions code filters on (app.js hazardMarkersAll): road_blocked | bridge_out | undefined (not a route hazard) */
export function routeKind(kind) {
  if (kind === "bridge") return "bridge_out";
  return kind === "flood" || kind === "blocked" || kind === "road-damage" || kind === "landslide" ? "road_blocked" : undefined;
}

/** L2-normalize a numeric array */
export function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  return Array.from(v, (x) => x / n);
}

export function softmax(xs) {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0) || 1;
  return e.map((x) => x / s);
}

/**
 * Zero-shot rank: cosine(image, labelEmbedding) * LOGIT_SCALE -> softmax.
 * @param {ArrayLike<number>} imageEmb  raw (un-normalized ok) image embedding
 * @param {Record<string, ArrayLike<number>>} labelEmbs  id -> unit text embedding
 * @returns {{id:string, kind:string|null, label:string, score:number}[]} sorted desc
 */
export function rankLabels(imageEmb, labelEmbs) {
  const img = normalize(imageEmb);
  const ids = LABELS.map((l) => l.id).filter((id) => labelEmbs[id]);
  const logits = ids.map((id) => {
    const t = labelEmbs[id];
    let d = 0;
    for (let i = 0; i < img.length; i++) d += img[i] * t[i];
    return d * LOGIT_SCALE;
  });
  const p = softmax(logits);
  return ids
    .map((id, i) => ({ id, kind: labelToKind(id), label: labelById(id).label, score: p[i] }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Turn a ranking into a reportable result, or null when nothing hazardous is confident enough.
 * @returns {{kind:string,label:string,confidence:number,lat:number,lon:number,ts:number}|null}
 */
export function decide(ranked, loc, ts, threshold = CONFIDENCE_THRESHOLD) {
  const top = ranked && ranked[0];
  if (!top || !top.kind || top.score < threshold) return null;
  return { kind: top.kind, label: top.label, confidence: +top.score.toFixed(3), lat: +loc.lat, lon: +loc.lon, ts: ts || Date.now() };
}

/** Hazard packet fields queued to the mesh (text is the human fact - the API only stores text/photoRef/label; hazard rides the signed packet + local feed). */
export function buildHazardPayload(result, photoRef) {
  const pct = Math.round(result.confidence * 100);
  return {
    text: `Hazard: ${result.label} (${pct}%) near ${result.lat.toFixed(4)}, ${result.lon.toFixed(4)} - on-device AI`,
    photoRef: photoRef || null,
    label: serverPhotoLabel(result.kind),
    hazard: { kind: result.kind, lat: result.lat, lon: result.lon, confidence: result.confidence, label: result.label },
  };
}

export function distanceM(aLat, aLon, bLat, bLon) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Add a result to a marker list: same kind within MERGE_RADIUS_M and MERGE_WINDOW_MS merges
 * (max confidence, newest ts, count+1, position kept from the higher-confidence report).
 * Returns a NEW array, newest first, capped at MAX_MARKERS.
 */
export function mergeMarker(markers, r) {
  const list = (markers || []).map((m) => ({ ...m }));
  const hit = list.find((m) => m.kind === r.kind && Math.abs(r.ts - m.ts) <= MERGE_WINDOW_MS && distanceM(m.lat, m.lon, r.lat, r.lon) <= MERGE_RADIUS_M);
  if (hit) {
    if (r.confidence > hit.confidence) { hit.confidence = r.confidence; hit.lat = r.lat; hit.lon = r.lon; hit.label = r.label; hit.source = r.source || "on-device"; }
    hit.ts = Math.max(hit.ts, r.ts);
    hit.count = (hit.count || 1) + 1;
  } else {
    list.push({ id: `hz-${r.kind}-${r.ts.toString(36)}`, kind: r.kind, label: r.label, confidence: r.confidence, lat: r.lat, lon: r.lon, ts: r.ts, count: 1, source: r.source || "on-device", routeKind: routeKind(r.kind) });
  }
  return list.sort((a, b) => b.ts - a.ts).slice(0, MAX_MARKERS);
}

/** Markers within radiusM of any point of a route polyline [[lat,lon],...] (also checks segment midpoints). For the directions agent. */
export function hazardsNearPath(markers, path, radiusM = WARN_RADIUS_M) {
  const pts = [];
  (path || []).forEach((p, i) => {
    pts.push(p);
    if (i > 0) pts.push([(p[0] + path[i - 1][0]) / 2, (p[1] + path[i - 1][1]) / 2]);
  });
  return (markers || []).filter((m) => pts.some((p) => distanceM(p[0], p[1], m.lat, m.lon) <= radiusM));
}

/** "Looks like: Bridge damaged 87%" */
export function confirmText(r) { return `Looks like: ${r.label} ${Math.round(r.confidence * 100)}%`; }
