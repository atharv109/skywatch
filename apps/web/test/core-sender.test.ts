import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { messageView } from "../../api/src/mesh/state.ts";
import { SKYWATCH_CORE_ID } from "../../api/src/mesh/types.ts";
import type { MeshPacketDoc } from "../../api/src/mesh/types.ts";

const doc = (deviceId: string): MeshPacketDoc =>
  ({ id: "x", type: "msg", status: "hi", ts: 1, hops: 0, deviceId, to: null, photoRef: null }) as unknown as MeshPacketDoc;

/* The server hashes every sender id, so clients cannot recognize the core by name.
 * Core replies are flagged server-side (m.core) from the stored deviceId; the app routes on that flag only. */
describe("Skywatch core sender is flagged by the server, not inferred by the client", () => {
  it("messageView sets core only for the trusted core's own packets", () => {
    expect(messageView(doc(SKYWATCH_CORE_ID), new Map()).core).toBe(true);
    expect(messageView(doc("5b7d857b2a"), new Map()).core).toBe(false);
  });

  it("the sender stays hashed even for the core (no raw core id on the wire)", () => {
    expect(messageView(doc(SKYWATCH_CORE_ID), new Map()).from).not.toContain("SKYWATCH");
  });

  it("app.js routes on m.core and has no name/hash sniffing left", () => {
    const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    expect(src).not.toMatch(/CORE_RE/);
    expect(src).not.toContain("1b20876ad5");
    expect(src).toMatch(/m\.core, *\)|m\.hazard, m\.core\)/);
    expect(src).toContain('.filter((m) => m.core === true || m.to === "SKYWATCH")');
  });
});
