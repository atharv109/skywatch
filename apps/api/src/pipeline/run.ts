import type { Config } from "../config.ts";
import type { AppStore } from "../store.ts";

/**
 * Task 4 seam: after a scenario replay loads hazards into Mongo, the pipeline
 * (match -> brief -> render -> deliver) runs per active user. Task 2 only needs a
 * stable call site and signature; the body stays a stub until Task 4 lands.
 */
export async function runPipeline(_ctx: { config: Config; store: AppStore }): Promise<void> {
  console.log("pipeline: not implemented (Task 4)");
}