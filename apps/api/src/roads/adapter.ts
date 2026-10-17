/**
 * Task 6: adapter seam for the vision service. NOT WIRED by default in the
 * classic sense: the API itself NEVER makes live vision calls (no fetch to any
 * vision endpoint, key set or not). When `PERCEPTRON_API_KEY` is set the seam
 * reports "wired" — meaning the vision teammate's service is expected to POST
 * verdicts to POST /roads/check; the API consumes those, it does not pull.
 */
import type { Config } from "../config.ts";

export interface VisionAdapter {
  wired: boolean;
  /** Always "not_wired": no live vision calls originate from this backend. */
  mode: "not_wired";
  reason: string;
}

export function visionAdapter(config: Pick<Config, "perceptronApiKey">): VisionAdapter {
  if (config.perceptronApiKey) {
    return {
      wired: true,
      mode: "not_wired",
      reason:
        "PERCEPTRON_API_KEY is set: the vision service POSTs camera verdicts to POST /roads/check (no live calls from the API).",
    };
  }
  return {
    wired: false,
    mode: "not_wired",
    reason: "PERCEPTRON_API_KEY is unset: no camera verdicts are expected; /roads/check accepts manual/teamed verdicts only.",
  };
}