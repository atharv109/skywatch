import { Hono } from "hono";
import type { Config } from "../config.ts";

/**
 * Route groups for later tasks (ingest/replay, map, webhooks, tools).
 * Registered by server.ts; empty until those tasks land.
 */
export function routes(_config: Config): Hono {
  return new Hono();
}