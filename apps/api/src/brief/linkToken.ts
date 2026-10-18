import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.ts";

/* Signed share-link tokens for /b/:token. A user id alone is not a capability
 * (Mongo ObjectIds embed a timestamp + counter), so links carry
 * "<userId>_<HMAC-SHA256(userId) first 32 hex>". Stateless: no schema change.
 * Key = TOOL_SECRET; with none configured a per-process random key is used, so
 * links still work but die on restart (fail closed, never a guessable link). */
const processKey = randomBytes(32);

function sig(config: Pick<Config, "toolSecret">, userId: string): string {
  const key = config.toolSecret ?? processKey;
  return createHmac("sha256", key).update(`brief:${userId}`).digest("hex").slice(0, 32);
}

export function briefToken(config: Pick<Config, "toolSecret">, userId: string): string {
  return `${userId}_${sig(config, userId)}`;
}

/** Returns the user id when the token's signature verifies, else null. */
export function verifyBriefToken(config: Pick<Config, "toolSecret">, token: string): string | null {
  const cut = token.lastIndexOf("_");
  if (cut < 1) return null;
  const userId = token.slice(0, cut);
  const given = Buffer.from(token.slice(cut + 1));
  const want = Buffer.from(sig(config, userId));
  return given.length === want.length && timingSafeEqual(given, want) ? userId : null;
}
