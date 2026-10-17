/**
 * The shared-secret scheme for tool endpoints (Task 4 brief endpoints + Task 6
 * /tools/checkin, GET /tools/checkin/next, /verify/run, /roads/check) — one
 * implementation so the scheme stays single-source.
 *
 * Exact scheme (documented for Delivery): when TOOL_SECRET is set, callers pass
 * EITHER `X-Skywatch-Tool-Secret: <TOOL_SECRET>` (the ElevenLabs webhook-tool /
 * custom-header form) OR `Authorization: Bearer <TOOL_SECRET>`. When TOOL_SECRET
 * is unset the endpoints answer unauthenticated (demo-grade, matching the Task 4
 * decision); a production pass would make the secret mandatory.
 */
import type { Config } from "../config.ts";

const TOOL_SECRET_HEADER = "X-Skywatch-Tool-Secret";

/** null = allow, otherwise the request is missing/wrong the secret → 401. */
export function toolSecretDenied(
  config: Pick<Config, "toolSecret">,
  headers: { get(name: string): string | undefined } | Record<string, string | undefined>,
): null | true {
  if (!config.toolSecret) return null;
  // c.req.header() (no-arg record form) lowercases header names — look up
  // case-insensitively so both Hono shapes + direct Headers objects work.
  let get: (name: string) => string | undefined;
  const shape = headers as { get?: (name: string) => string | undefined };
  if (typeof shape.get === "function") {
    get = (name) => (shape.get as (name: string) => string | undefined)(name);
  } else {
    const record = headers as Record<string, string | undefined>;
    get = (name) => record[name] ?? record[name.toLowerCase()];
  }
  if (get(TOOL_SECRET_HEADER) === config.toolSecret) return null;
  const authorization = get("Authorization")?.trim() ?? "";
  if (authorization === `Bearer ${config.toolSecret}`) return null;
  return true;
}

export const TOOL_SECRET_HEADER_NAME = TOOL_SECRET_HEADER;