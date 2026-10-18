import { tick } from "@/lib/simulator";
import { SEATTLE_HOME, seattleShelter, seattleSmoke } from "@/lib/seattle";
import type { Confidence, Hazard, Person, Resource, ResourceKind, ResourceStatus, Road, RoadStatus } from "@/lib/types";
import { getUpstream, postUpstream } from "@/lib/upstream";

function resourceStatus(value: unknown): ResourceStatus {
  if (value === "open" || value === "full" || value === "closed" || value === "unknown") return value;
  return "unknown";
}

/** Backend road verdicts (flooded|blocked|slow|clear|unknown) → the board's four labels, per the amber-means-unknown rule. */
function roadStatus(value: unknown): RoadStatus {
  if (value === "flooded" || value === "blocked") return "blocked";
  if (value === "slow") return "slow";
  if (value === "clear") return "open";
  return "slow";
}

/** Confidence decays 0..1 on the backend; a 0.5 floor is medium there, so the board reads it the same way. */
function confidenceLabel(value: unknown): Confidence {
  const number = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
  if (Number.isFinite(number)) {
    if (number >= 0.8) return "high";
    if (number >= 0.5) return "medium";
  }
  return "low";
}

function finite(value: string | null, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** [lon, lat] GeoJSON ring → [lat, lon][] for Leaflet. */
function ringToPolygon(coordinates: unknown): [number, number][] | null {
  if (!Array.isArray(coordinates) || !Array.isArray(coordinates[0])) return null;
  const polygon = (coordinates[0] as unknown[]).flatMap((pair) => {
    if (!Array.isArray(pair) || pair.length < 2) return [];
    const lon = Number(pair[0]);
    const lat = Number(pair[1]);
    return [lat, lon].every(Number.isFinite) ? [[lat, lon] as [number, number]] : [];
  });
  return polygon.length >= 3 ? polygon : null;
}

function secondsAgo(at: unknown, generatedAt: number): number {
  const ms = typeof at === "number" ? generatedAt - at : NaN;
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
}

type BackendMesh = {
  beacons: Array<Record<string, unknown>>;
  hazardReports: Array<Record<string, unknown>>;
  counts?: Record<string, unknown>;
} | null;

/**
 * The backend MapState (GET /map/state) → the board picture. Mesh beacons and
 * neighbor hazard reports ride in as extra markers with their score + reasons,
 * so the dark-zone layer is visible on the operator map.
 */
function normalize(value: unknown) {
  const record = asRecord(value);
  if (!record) return null;
  const generatedAt = typeof record.generatedAt === "number" ? record.generatedAt : Date.now();
  const hazards: Hazard[] = [];
  const resources: Resource[] = [];
  const roads: Road[] = [];

  (Array.isArray(record.hazards) ? record.hazards : []).forEach((entry) => {
    const item = asRecord(entry);
    if (!item) return;
    const geometry = asRecord(item.geometry);
    const polygon = geometry?.type === "Polygon" ? ringToPolygon(geometry.coordinates) : null;
    const coordinates = asRecord(geometry?.type === "Point" ? geometry.coordinates : null);
    const severity = typeof item.severity === "number" ? item.severity : 1;
    hazards.push({
      id: String(item.sourceId || item.id || `haz-${hazards.length}`),
      name: String(item.title || "Hazard"),
      severity: severity >= 2 ? "danger" : "warning",
      confidence: "high",
      summary: `${String(item.source || "Reported hazard")}. Severity ${severity} of 4.`,
      timing: `Valid from ${new Date(Number(item.validFrom) || generatedAt).toISOString().slice(11, 16)} UTC`,
      polygon: polygon ?? undefined,
      point: coordinates
        ? [Number(coordinates[1]), Number(coordinates[0])]
        : (polygon ? polygon[0] : undefined),
      verifiedAgoSec: secondsAgo(item.validFrom, generatedAt),
    });
  });

  (Array.isArray(record.resources) ? record.resources : []).forEach((entry) => {
    const item = asRecord(entry);
    if (!item) return;
    const kind = String(item.kind || "shelter");
    const boardKind: ResourceKind = kind === "pharmacy" || kind === "medical" ? "medical" : kind === "supply" ? "supply" : "shelter";
    resources.push({
      id: String(item.sourceId || item.id || `res-${resources.length}`),
      name: String(item.name || "Shelter"),
      kind: boardKind,
      status: resourceStatus(item.status),
      confidence: confidenceLabel(item.confidence),
      point: [Number(item.lon), Number(item.lat)].every(Number.isFinite)
        ? [Number(item.lat), Number(item.lon)]
        : SEATTLE_HOME,
      address: item.partner ? "Partner-managed site" : "Public site",
      verifiedAgoSec: 0,
    });
  });

  (Array.isArray(record.roads) ? record.roads : []).forEach((entry) => {
    const item = asRecord(entry);
    if (!item) return;
    roads.push({
      id: String(item.cameraId || item.id || `road-${roads.length}`),
      name: String(item.name || "Road"),
      status: roadStatus(item.status),
      confidence: confidenceLabel(item.confidence),
      point: [Number(item.lon), Number(item.lat)].every(Number.isFinite)
        ? [Number(item.lat), Number(item.lon)]
        : SEATTLE_HOME,
      detail: String(item.status || ""),
      verifiedAgoSec: 0,
    });
  });

  const people: Person[] = Array.isArray(record.userDots)
    ? (record.userDots as unknown[]).flatMap((entry, index) => {
        const item = asRecord(entry);
        const lat = Number(item?.lat);
        const lon = Number(item?.lon);
        return Number.isFinite(lat) && Number.isFinite(lon) ? [{ id: `dot-${index}`, point: [lat, lon] }] : [];
      })
    : [];

  const mesh: BackendMesh = asRecord(record.mesh)
    ? (() => {
        const section = asRecord(record.mesh)!;
        return {
          beacons: (Array.isArray(section.beacons) ? section.beacons : []).flatMap((b) => {
            const item = asRecord(b);
            return item ? [item] : [];
          }),
          hazardReports: (Array.isArray(section.hazardReports) ? section.hazardReports : []).flatMap((r) => {
            const item = asRecord(r);
            return item ? [item] : [];
          }),
        };
      })()
    : null;

  mesh?.beacons.forEach((beacon, index) => {
    const lat = typeof beacon.lat === "number" ? beacon.lat : NaN;
    const lon = typeof beacon.lon === "number" ? beacon.lon : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const reports = typeof beacon.reports === "number" ? beacon.reports : 1;
    const score = typeof beacon.score === "number" ? beacon.score : null;
    hazards.push({
      id: String(beacon.clusterId || `beacon-${index}`),
      name: `Rescue · ${String(beacon.kind || "need rescue")}`,
      severity: "danger",
      confidence: score != null && score >= 0.7 ? "high" : "medium",
      summary: `Rescue beacon cluster. Score ${score ?? "—"}. ${reports} ${reports === 1 ? "report" : "reports"}.`,
      timing: `Last seen ${secondsAgo(beacon.lastSeen, generatedAt)}s ago`,
      point: [lat, lon],
      radiusM: 150,
      verifiedAgoSec: secondsAgo(beacon.lastSeen, generatedAt),
    });
  });

  mesh?.hazardReports.forEach((report, index) => {
    const lat = typeof report.lat === "number" ? report.lat : NaN;
    const lon = typeof report.lon === "number" ? report.lon : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const reasons = Array.isArray(report.reasons) ? (report.reasons as unknown[]).map(String).slice(0, 3) : [];
    const score = typeof report.score === "number" ? report.score : null;
    hazards.push({
      id: String(report.id || `report-${index}`),
      name: String(report.status || "neighbor report").slice(0, 60),
      severity: "warning",
      confidence: score != null && score >= 0.7 ? "high" : score != null ? "medium" : "low",
      summary: `Neighbor report over the mesh. Score ${score ?? "—"}. ${reasons.join(" · ") || "no explanation stored"}.`,
      timing: `Synced ${secondsAgo(report.ts, generatedAt)}s ago`,
      point: [lat, lon],
      radiusM: 150,
      verifiedAgoSec: secondsAgo(report.ts, generatedAt),
    });
  });

  if (!hazards.length && !resources.length && !roads.length) return null;
  return {
    title: String(record.title || "Seattle"),
    source: "backend" as const,
    lang: typeof record.lang === "string" ? record.lang : null,
    hazards,
    resources,
    roads,
    people,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("sim") === "1") {
    const scenario = url.searchParams.get("scenario") === "smoke" ? "smoke" : "flood";
    return Response.json(tick(scenario));
  }

  const lat = finite(url.searchParams.get("lat"), SEATTLE_HOME[0]);
  const lon = finite(url.searchParams.get("lon"), SEATTLE_HOME[1]);
  const query = `?lat=${lat}&lon=${lon}`;
  for (const path of ["/map/state", "/situation", "/api/situation", "/fixtures/situation", "/geojson"]) {
    try {
      const upstream = await getUpstream(`${path}${query}`);
      if (upstream.status !== 200) continue;
      const parsed = normalize(JSON.parse(upstream.text) as unknown);
      if (parsed) return Response.json(parsed);
    } catch {
      /* Try the next path. The map still has the Seattle fixtures. */
    }
  }

  let shelterName = "El Centro de la Raza (Centro de la Raza Community Shelter)";
  let lang: string | null = null;
  try {
    const upstream = await postUpstream("/mesh/sync", {
      deviceId: "skywatch-map",
      lat,
      lon,
      packets: [],
    });
    if (upstream.status === 200) {
      const body = JSON.parse(upstream.text) as {
        lang?: string;
        bundle?: { lang?: string; byPhone?: { lang?: string }; nearestVerifiedShelter?: { name?: string } };
      };
      if (body.bundle?.nearestVerifiedShelter?.name) shelterName = body.bundle.nearestVerifiedShelter.name;
      lang = body.lang || body.bundle?.lang || body.bundle?.byPhone?.lang || null;
    }
  } catch {
    /* Shelter name stays the Seattle fixture. */
  }

  return Response.json({
    title: "Seattle",
    source: "seattle",
    lang,
    hazards: [seattleSmoke],
    resources: [seattleShelter(shelterName)],
    roads: [],
    people: [],
  });
}