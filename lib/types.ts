export type Severity = "danger" | "warning" | "safe" | "neutral";

export type Confidence = "high" | "medium" | "low";

export type ResourceStatus = "open" | "full" | "closed" | "unknown";

export type RoadStatus = "closed" | "blocked" | "slow" | "open";

export type ScenarioId = "flood" | "smoke";

export type Hazard = {
  id: string;
  name: string;
  severity: Exclude<Severity, "neutral">;
  confidence: Confidence;
  summary: string;
  timing: string;
  polygon?: [number, number][];
  point?: [number, number];
  radiusM?: number;
  verifiedAgoSec: number;
};

export type ResourceKind = "shelter" | "medical" | "supply";

export type Resource = {
  id: string;
  name: string;
  kind: ResourceKind;
  status: ResourceStatus;
  confidence: Confidence;
  point: [number, number];
  address: string;
  capacity?: number;
  available?: number;
  verifiedAgoSec: number;
  note?: string;
};

export type Road = {
  id: string;
  name: string;
  status: RoadStatus;
  confidence: Confidence;
  point: [number, number];
  detail: string;
  verifiedAgoSec: number;
};

export type Person = {
  id: string;
  point: [number, number];
};

export type CheckIn = {
  status: ResourceStatus;
  confidence: Confidence;
  note: string;
  at: number;
};

export type Snapshot = {
  scenario: ScenarioId;
  at: number;
  shelterAvailable: number | null;
  fieldReport: boolean;
  aqi: number | null;
};
