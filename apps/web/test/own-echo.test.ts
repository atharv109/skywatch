import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashPrefix } from "../../api/src/mesh/state.ts";

/* The server serves every sender as sha256(deviceId)[:10], so the client must map that hash back to its own
 * device id or its own synced messages come back as a stranger's grey bubble (thread jumps after every send). */
describe("own message echo", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");

  it("client hash scheme equals the server's hashPrefix(deviceId)", () => {
    const id = "5b7d857b2a";
    expect(createHash("sha256").update(new TextEncoder().encode(id)).digest("hex").slice(0, 10)).toBe(hashPrefix(id));
  });

  it("identity keeps the hash and meshFeed maps it back for from and to", () => {
    expect(src).toContain("identity.hash = await sha256HexPrefix(new TextEncoder().encode(identity.deviceId), 10)");
    expect(src).toContain("if (meHash && from === meHash) from = meRaw;");
    expect(src).toContain("if (meHash && to === meHash) to = meRaw;");
  });

  it("bubble animation key ignores ts so the server echo does not re-spring", () => {
    expect(src).toContain('const key = [m.from, m.to || "", m.text].join("|");');
  });
});
