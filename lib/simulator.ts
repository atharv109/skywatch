import type { ScenarioId, Snapshot } from "@/lib/types";

type State = {
  spaces: number;
  aqi: number;
  field: boolean;
  ticks: number;
};

const state: State = {
  spaces: 22,
  aqi: 164,
  field: false,
  ticks: 0,
};

let dropArmed = true;

export function takeDropTicket(): boolean {
  if (!dropArmed) return false;
  dropArmed = false;
  return true;
}

export function peek(scenario: ScenarioId): Snapshot {
  return {
    scenario,
    at: Date.now(),
    shelterAvailable: scenario === "flood" ? state.spaces : null,
    fieldReport: scenario === "flood" ? state.field : false,
    aqi: scenario === "smoke" ? state.aqi : null,
  };
}

export function tick(scenario: ScenarioId): Snapshot {
  state.ticks += 1;
  if (scenario === "flood") {
    if (state.spaces > 8) state.spaces -= 1;
    if (state.ticks >= 2) state.field = true;
  } else if (state.aqi < 190) {
    state.aqi += 2;
  }
  return peek(scenario);
}
