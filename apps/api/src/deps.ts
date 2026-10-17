import type { Config } from "./config.ts";
import { runPipeline } from "./pipeline/run.ts";
import { defaultStore } from "./ingest/scenario.ts";
import type { AppStore } from "./store.ts";

/**
 * Injectable dependencies for the route groups. The defaults go to Mongo via the
 * shared lazy connection; tests replace them with an in-memory store.
 */
export interface AppDeps {
  /** Resolve the app store for a config (real: Mongo collections via db/client.ts). */
  store: (config: Config) => Promise<AppStore>;
  /** Post-replay pipeline trigger (Task 4 seam; stub until then). */
  pipeline: (ctx: { config: Config; store: AppStore }) => Promise<void>;
}

export function defaultDeps(config: Config): AppDeps {
  void config;
  return {
    store: (cfg) => defaultStore(cfg),
    pipeline: runPipeline,
  };
}