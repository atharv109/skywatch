import type { Config } from "./config.ts";
import { runPipeline, type PipelineCtx, type PipelineResult } from "./pipeline/run.ts";
import { defaultStore } from "./ingest/scenario.ts";
import type { AppStore } from "./store.ts";
import type { DeliverStore } from "./deliver/store.ts";
import { mongoDeliverStore } from "./deliver/store.ts";
import { mongoMatchStore, type MatchStore } from "./match/store.ts";
import { getDb } from "./db/client.ts";
import { createInboundContext, createInboundRuntime, type InboundRuntime } from "./deliver/runtime.ts";

/**
 * Injectable dependencies for the route groups. The defaults go to Mongo via the
 * shared lazy connection; tests replace them with in-memory stores.
 */
export interface AppDeps {
  /** Resolve the app store for a config (real: Mongo collections via db/client.ts). */
  store: (config: Config) => Promise<AppStore>;
  /** Post-replay pipeline trigger (Task 4: match -> brief -> deliver, run.ts). */
  pipeline: (ctx: PipelineCtx) => Promise<PipelineResult>;
  /** Photon inbound webhook runtime (Task 3): signature verify + id-guarded queue. */
  inbound: InboundRuntime;
  /** Geo matching (Task 4): the $geoIntersects/$geoNear Mongo store by default. */
  match: () => Promise<MatchStore>;
  /** Deliver-side users/conversations/outbox store (rate gates + consent re-read). */
  deliver: () => Promise<DeliverStore>;
}

export function defaultDeps(config: Config): AppDeps {
  return {
    store: (cfg) => defaultStore(cfg),
    pipeline: runPipeline,
    inbound: createInboundRuntime(createInboundContext(config)),
    match: () => getDb(config).then(mongoMatchStore),
    deliver: () => getDb(config).then(mongoDeliverStore),
  };
}

export type { PipelineCtx, PipelineResult };