import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashPrefix } from "../../api/src/mesh/state.ts";
import { SKYWATCH_CORE_ID } from "../../api/src/mesh/types.ts";

/* The server hashes every sender (messageView), the core included. The app's
 * CORE_RE must therefore match hash(SKYWATCH-CORE), or Ask Skywatch replies are
 * treated as an unknown neighbor's DM and never reach the Skywatch thread. */
describe("app recognizes the Skywatch core sender", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const m = src.match(/const CORE_RE = \/(.+)\/i;/);

  it("CORE_RE matches the hashed core id the server actually sends", () => {
    expect(m).not.toBeNull();
    const re = new RegExp(m![1]!, "i");
    expect(re.test(hashPrefix(SKYWATCH_CORE_ID))).toBe(true);
  });

  it("CORE_RE does not match an ordinary neighbor hash", () => {
    const re = new RegExp(m![1]!, "i");
    expect(re.test(hashPrefix("some-neighbor-device"))).toBe(false);
  });
});
