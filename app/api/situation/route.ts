import { tick } from "@/lib/simulator";
import { SEATTLE_HOME, seattleShelter, seattleSmoke } from "@/lib/seattle";
import type { Confidence, Hazard, Resource, ResourceStatus, Road, RoadStatus } from "@/lib/types";
import { getUpstream, postUpstream } from "@/lib/upstream";

function resourceStatus(value: unknown): ResourceStatus {
  if (value === "open" || value === "full" || value === "closed" || value === "unknown") return value;
  return "open";
}

function roadStatus(value: unknown): RoadStatus {
  if (value === "closed" || value === "blocked" || value === "slow" || value === "open") return value;
  return "closed";
}

function confidenceOf(value: unknown): Confidence {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "medium";
}

function finite(value: string | null, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function normalize(value: unknown) {
  const record = asRecord(value);
  if (!record) return null;
  const hazards = Array.isArray(record.hazards) ? (record.hazards as Hazard[]) : [];
  const resources = Array.isArray(record.resources) ? (record.resources as Resource[]) : [];
  const roads = Array.isArray(record.roads) ? (record.roads as Road[]) : [];
  const features = Array.isArray(record.features) ? record.features : [];
  features.forEach((feature) => {
    const item = asRecord(feature);
    const geometry = asRecord(item?.geometry);
    const properties = asRecord(item?.properties) || {};
    const coordinates = geometry?.coordinates;
    if (geometry?.type === "Point" && Array.isArray(coordinates) && coordinates.length >= 2) {
      const point: [number, number] = [Number(coordinates[1]), Number(coordinates[0])];
      const kind = String(properties.kind || properties.layer || "hazard");
      if (kind === "resource" || kind === "shelter") {
        resources.push({
          id: String(properties.id || item?.id || `res-${resources.length}`),
          name: String(properties.name || "Shelter"),
          kind: "shelter",
          status: resourceStatus(properties.status),
          confidence: confidenceOf(properties.confidence),
          point,
          address: String(properties.address || ""),
          verifiedAgoSec: 60,
        });
      } else if (kind === "road") {
        roads.push({
          id: String(properties.id || `road-${roads.length}`),
          name: String(properties.name || "Road"),
          status: roadStatus(properties.status),
          confidence: confidenceOf(properties.confidence),
          point,
          detail: String(properties.detail || ""),
          verifiedAgoSec: 60,
        });
      }
    }
    if (geometry?.type === "Polygon" && Array.isArray(coordinates)) {
      const ring = Array.isArray(coordinates[0]) ? coordinates[0] : [];
      const polygon = ring
        .map((pair) => (Array.isArray(pair) ? ([Number(pair[1]), Number(pair[0])] as [number, number]) : null))
        .filter((pair): pair is [number, number] => !!pair && Number.isFinite(pair[0]));
      if (polygon.length >= 3) {
        hazards.push({
          id: String(properties.id || `haz-${hazards.length}`),
          name: String(properties.name || "Hazard"),
          severity: properties.severity === "warning" ? "warning" : "danger",
          confidence: "medium",
          summary: String(properties.summary || properties.name || "Hazard"),
          timing: String(properties.timing || ""),
          polygon,
          verifiedAgoSec: 60,
        });
      }
    }
  });
  if (!hazards.length && !resources.length && !roads.length) return null;
  return {
    title: String(record.title || "Seattle"),
    source: "backend" as const,
    lang: typeof record.lang === "string" ? record.lang : null,
    hazards,
    resources,
    roads,
    people: [],
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
  for (const path of ["/situation", "/api/situation", "/fixtures/situation", "/geojson"]) {
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
