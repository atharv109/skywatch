import type { Hazard, Person, Resource, Road, ScenarioId } from "@/lib/types";

export const HOUSEHOLD: [number, number] = [37.8135, -122.2991];

export const GREEN_SHELTER = {
  name: "Green Community Center",
  address: "1247 Peralta St",
  point: [37.8063, -122.2889] as [number, number],
};

export const VIEWS: Record<ScenarioId, { center: [number, number]; zoom: number }> = {
  flood: { center: [37.8074, -122.2942], zoom: 15 },
  smoke: { center: [37.8086, -122.2948], zoom: 14 },
};

const people: Person[] = [
  { id: "p1", point: [37.8068, -122.2962] },
  { id: "p2", point: [37.8092, -122.2944] },
  { id: "p3", point: [37.811, -122.289] },
  { id: "p4", point: [37.8042, -122.2876] },
  { id: "p5", point: [37.8076, -122.2856] },
  { id: "p6", point: [37.8126, -122.2932] },
  { id: "p7", point: [37.8034, -122.2914] },
  { id: "p8", point: [37.8096, -122.2816] },
];

const floodHazards: Hazard[] = [
  {
    id: "flood-creek",
    name: "Mandela Parkway creek",
    severity: "danger",
    confidence: "high",
    summary: "The creek is over its banks along Mandela Parkway.",
    timing: "Until 6:00 PM",
    verifiedAgoSec: 180,
    polygon: [
      [37.8032, -122.2968],
      [37.8048, -122.2942],
      [37.8074, -122.2928],
      [37.8106, -122.2912],
      [37.8124, -122.2904],
      [37.8128, -122.2916],
      [37.8108, -122.2926],
      [37.8076, -122.2944],
      [37.805, -122.2958],
      [37.8036, -122.2976],
    ],
  },
  {
    id: "flood-ponding",
    name: "Standing water near 3rd",
    severity: "warning",
    confidence: "medium",
    summary: "Ponds on side streets near 3rd Street.",
    timing: "Until the water drains",
    verifiedAgoSec: 540,
    polygon: [
      [37.8018, -122.2935],
      [37.8026, -122.2904],
      [37.8034, -122.2908],
      [37.8028, -122.294],
    ],
  },
];

export const FIELD_REPORT: Hazard = {
  id: "flood-debris",
  name: "Debris in the street",
  severity: "warning",
  confidence: "low",
  summary: "A passing report near 5th Street. Not verified yet.",
  timing: "Low confidence",
  verifiedAgoSec: 20,
  point: [37.8054, -122.2915],
  radiusM: 70,
};

const floodResources: Resource[] = [
  {
    id: "flood-green",
    name: GREEN_SHELTER.name,
    kind: "shelter",
    status: "open",
    confidence: "high",
    point: GREEN_SHELTER.point,
    address: GREEN_SHELTER.address,
    capacity: 80,
    available: 22,
    verifiedAgoSec: 240,
  },
  {
    id: "flood-prescott",
    name: "Prescott Hall",
    kind: "shelter",
    status: "full",
    confidence: "medium",
    point: [37.8114, -122.2916],
    address: "1801 Adeline St",
    capacity: 40,
    available: 0,
    verifiedAgoSec: 900,
  },
  {
    id: "flood-cache",
    name: "Port supply cache",
    kind: "supply",
    status: "unknown",
    confidence: "low",
    point: [37.8044, -122.3022],
    address: "7th St at Maritime",
    verifiedAgoSec: 2400,
  },
];

const floodRoads: Road[] = [
  {
    id: "flood-mandela",
    name: "Mandela Pkwy at 7th",
    status: "closed",
    confidence: "high",
    point: [37.8047, -122.2946],
    detail: "Do not drive this way. Water is over the road.",
    verifiedAgoSec: 300,
  },
  {
    id: "flood-ramp",
    name: "I-880 ramp at 7th",
    status: "closed",
    confidence: "high",
    point: [37.8034, -122.3002],
    detail: "The ramp is closed. Use another way out.",
    verifiedAgoSec: 360,
  },
  {
    id: "flood-market",
    name: "Market St at 14th",
    status: "slow",
    confidence: "medium",
    point: [37.8104, -122.2808],
    detail: "Traffic is slow. The road is still open.",
    verifiedAgoSec: 720,
  },
];

const smokeHazards: Hazard[] = [
  {
    id: "smoke-air",
    name: "Wildfire smoke",
    severity: "danger",
    confidence: "high",
    summary: "Wildfire smoke is over West Oakland.",
    timing: "Through tonight",
    verifiedAgoSec: 120,
    polygon: [
      [37.801, -122.305],
      [37.8012, -122.278],
      [37.8165, -122.2765],
      [37.8172, -122.3025],
      [37.808, -122.308],
    ],
  },
  {
    id: "smoke-ash",
    name: "Ash in the air",
    severity: "warning",
    confidence: "low",
    summary: "Reports near the port. Not verified yet.",
    timing: "Low confidence",
    verifiedAgoSec: 1500,
    polygon: [
      [37.8055, -122.3045],
      [37.8088, -122.3018],
      [37.8072, -122.2988],
      [37.8038, -122.301],
    ],
  },
];

const smokeResources: Resource[] = [
  {
    id: "smoke-green",
    name: GREEN_SHELTER.name,
    kind: "shelter",
    status: "unknown",
    confidence: "low",
    point: GREEN_SHELTER.point,
    address: GREEN_SHELTER.address,
    verifiedAgoSec: 3600,
    note: "Air filters are not verified.",
  },
  {
    id: "smoke-clinic",
    name: "Harbor Clinic",
    kind: "medical",
    status: "open",
    confidence: "high",
    point: [37.8096, -122.2924],
    address: "2730 Mandela Pkwy",
    verifiedAgoSec: 480,
  },
  {
    id: "smoke-prescott",
    name: "Prescott Hall",
    kind: "shelter",
    status: "closed",
    confidence: "medium",
    point: [37.8114, -122.2916],
    address: "1801 Adeline St",
    verifiedAgoSec: 1200,
  },
];

const smokeRoads: Road[] = [
  {
    id: "smoke-wood",
    name: "7th St at Wood",
    status: "slow",
    confidence: "medium",
    point: [37.8058, -122.2978],
    detail: "Low visibility. Drive slowly or stay in.",
    verifiedAgoSec: 600,
  },
  {
    id: "smoke-maritime",
    name: "Maritime St",
    status: "closed",
    confidence: "high",
    point: [37.8072, -122.3086],
    detail: "Closed to through traffic.",
    verifiedAgoSec: 420,
  },
];

export const SCENARIOS: Record<
  ScenarioId,
  { title: string; hazards: Hazard[]; resources: Resource[]; roads: Road[]; people: Person[] }
> = {
  flood: {
    title: "Flood watch · West Oakland",
    hazards: floodHazards,
    resources: floodResources,
    roads: floodRoads,
    people,
  },
  smoke: {
    title: "Smoke advisory · West Oakland",
    hazards: smokeHazards,
    resources: smokeResources,
    roads: smokeRoads,
    people,
  },
};

export function hazardCentroid(hazard: Hazard): [number, number] {
  if (hazard.point) return hazard.point;
  const ring = hazard.polygon ?? [];
  const lat = ring.reduce((sum, point) => sum + point[0], 0) / ring.length;
  const lng = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
  return [lat, lng];
}
