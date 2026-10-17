import type { Confidence, Hazard, Resource, ResourceStatus, RoadStatus } from "@/lib/types";

export function confidenceLabel(confidence: Confidence): string {
  if (confidence === "high") return "High confidence";
  if (confidence === "medium") return "Medium confidence";
  return "Low confidence";
}

export function resourceSentence(resource: Pick<Resource, "kind" | "status">): string {
  const status = resource.status;
  if (resource.kind === "shelter") {
    if (status === "open") return "Shelter is open";
    if (status === "full") return "Shelter is full";
    if (status === "closed") return "Shelter is closed";
    return "Shelter status is unknown";
  }
  if (resource.kind === "medical") {
    if (status === "open") return "Clinic is open";
    if (status === "closed") return "Clinic is closed";
    if (status === "full") return "Clinic is full";
    return "Clinic status is unknown";
  }
  if (status === "open") return "Supplies are available";
  if (status === "closed") return "Supplies are not available";
  if (status === "full") return "Supplies are gone";
  return "Supply status is unknown";
}

export function roadSentence(status: RoadStatus): string {
  if (status === "closed") return "Road is closed";
  if (status === "blocked") return "Road is blocked";
  if (status === "slow") return "Road is slow";
  return "Road is open";
}

export function hazardSentence(hazard: Pick<Hazard, "severity">): string {
  return hazard.severity === "danger" ? "This is a danger" : "This is a warning";
}

export function resourceTone(status: ResourceStatus): "danger" | "warning" | "safe" {
  if (status === "open") return "safe";
  if (status === "closed") return "danger";
  return "warning";
}

export function roadTone(status: RoadStatus): "danger" | "warning" | "safe" {
  if (status === "open") return "safe";
  if (status === "slow") return "warning";
  return "danger";
}

export function statusWord(status: ResourceStatus | RoadStatus): string {
  if (status === "open") return "Open";
  if (status === "full") return "Full";
  if (status === "closed") return "Closed";
  if (status === "blocked") return "Blocked";
  if (status === "slow") return "Slow";
  return "Unknown";
}

export function resourceListLine(resource: Resource): string {
  if (resource.kind === "shelter" && resource.status === "open" && resource.available != null) {
    return `Open · ${resource.available} spaces left`;
  }
  return `${resourceSentence(resource)}`;
}
