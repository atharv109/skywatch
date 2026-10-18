import type { Config } from "./config.ts";
import { runPipeline, type PipelineCtx, type PipelineResult } from "./pipeline/run.ts";
import { defaultStore } from "./ingest/scenario.ts";
import type { AppStore } from "./store.ts";
import type { DeliverStore } from "./deliver/store.ts";
import { mongoDeliverStore } from "./deliver/store.ts";
import { mongoMatchStore, type MatchStore } from "./match/store.ts";
import { getDb } from "./db/client.ts";
import { createInboundContext, createInboundRuntime, type InboundRuntime } from "./deliver/runtime.ts";
import { createVoiceRuntime, type VoiceRuntime } from "./deliver/voice_runtime.ts";
import { pgStatusHistoryReader, type TigerStatusRow } from "./verify/tiger.ts";
import { mongoVerifyStore, type VerifyStore } from "./verify/store.ts";
import { mongoMeshStore, type MeshStore } from "./mesh/store.ts";
import { mongoTtsCache, type TtsCache } from "./deliver/grok-tts.ts";
import { makePhotoVision, type PhotoVision, type PhotoVerdict } from "./mesh/photovision.ts";

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
  /** Task 6 voice check-in queue records (verify_requests). */
  verify: () => Promise<VerifyStore>;
  /** Task 6 ElevenLabs post-call webhook runtime (signature verify + queue). */
  voice: VoiceRuntime;
  /**
   * Task 8 mesh store (mesh_packets / beacons / mesh_devices). OPTIONAL on the
   * interface so every landed hermetic harness stays untouched — routes read a
   * missing mesh dep as "mesh not configured" (503); the production defaultDeps
   * always wires it.
   */
  mesh?: () => Promise<MeshStore>;
  /**
   * Task 8f Grok Voice TTS cache (tts_cache). OPTIONAL on the interface so every
   * landed hermetic harness stays untouched — deliver reads a missing cache as
   * "no audio" (synthesize still runs without cache persistence); the production
   * defaultDeps always wires it.
   */
  ttsCache?: () => Promise<TtsCache>;
  /**
   * Task 8h Tiger Data READ (status_events history for one resource). OPTIONAL:
   * wired only when TIGER_DATABASE_URL is set — /tools/status-history reads the
   * absent dep as {configured:false} (nothing is ever faked from Mongo).
   */
  tigerStatus?: (entity: string, hours: number, now: number) => Promise<TigerStatusRow[]>;
  /**
   * Photo pipeline (POST /mesh/photo + sync-time scoring): the xAI vision verifier.
   * OPTIONAL on the interface so every landed hermetic harness stays untouched —
   * wired in defaultDeps ONLY when XAI_API_KEY is set (absent dep = photo-unscored,
   * exactly the previous never-blocks posture).
   */
  photoVision?: PhotoVision;
}

export function defaultDeps(config: Config): AppDeps {
  return {
    store: (cfg) => defaultStore(cfg),
    pipeline: runPipeline,
    inbound: createInboundRuntime(createInboundContext(config)),
    match: () => getDb(config).then(mongoMatchStore),
    deliver: () => getDb(config).then(mongoDeliverStore),
    verify: () => getDb(config).then(mongoVerifyStore),
    voice: createVoiceRuntime(config, { ttsCache: () => getDb(config).then(mongoTtsCache) }),
    mesh: () => getDb(config).then(mongoMeshStore),
    // Photo pipeline: the vision verifier, wired ONLY when an XAI key is set.
    ...(config.xaiApiKey ? { photoVision: makePhotoVision(config) } : {}),
    // Task 8h Tiger READ: wired ONLY when the mirror layer is configured.
    ...(config.tigerDatabaseUrl ? { tigerStatus: pgStatusHistoryReader(config.tigerDatabaseUrl) } : {}),
  };
}

export type { PipelineCtx, PipelineResult, VerifyStore };