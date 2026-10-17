/**
 * Task 7: hermetic tests for the optional Tiger Data status_events layer.
 * Only the pure event builder + the inert-when-unset guard are exercised —
 * no Postgres in the hermetic suite (the ruling: Mongo verifiedAt is the
 * demo path; tiger.ts must stay a non-blocking optional mirror).
 */
import { describe, expect, it } from "vitest";
import { buildStatusEvent, forwardStatusEvents, type TigerStatusEvent } from "../src/verify/tiger.ts";
import type { ResourceDoc } from "../src/types/docs.ts";

function checkedInResource(overrides: Partial<ResourceDoc> = {}): ResourceDoc {
  return {
    sourceId: "seed-shelter-1",
    kind: "shelter",
    name: "Demo Shelter",
    partner: true,
    status: "open",
    verifiedAt: 1_700_000_000_000,
    capacity: 40,
    lastCheckin: { status: "open", manual: false, notes: "staff confirmed", at: 1_700_000_000_000 },
    loc: { type: "Point", coordinates: [-122.3185, 47.584] },
    ...overrides,
  };
}

describe("tiger.ts event builder", () => {
  it("maps a checked-in resource into the status_events row shape (lon before lat)", () => {
    const event: TigerStatusEvent | null = buildStatusEvent(checkedInResource());
    expect(event).not.toBeNull();
    expect(event!.resourceId).toBe("seed-shelter-1");
    expect(event!.resourceName).toBe("Demo Shelter");
    expect(event!.status).toBe("open");
    expect(event!.capacity).toBe(40);
    expect(event!.manual).toBe(false);
    expect(event!.notes).toBe("staff confirmed");
    expect(event!.lon).toBe(-122.3185);
    expect(event!.lat).toBe(47.584);
    expect(event!.at).toBe(1_700_000_000_000);
  });

  it("returns null when the resource was never verified (verifiedAt null)", () => {
    expect(buildStatusEvent(checkedInResource({ verifiedAt: null, lastCheckin: undefined }))).toBeNull();
  });

  it("forwardStatusEvents is a no-op (no throw, no writes) when TIGER_DATABASE_URL is unset", () => {
    // With the URL absent the call must return without touching pg at all.
    const event = buildStatusEvent(checkedInResource());
    expect(event).not.toBeNull();
    expect(() => forwardStatusEvents({ tigerDatabaseUrl: null }, [event!])).not.toThrow();
    // Empty event list is also inert even with a URL set.
    expect(() => forwardStatusEvents({ tigerDatabaseUrl: "postgres://user@localhost/nothing" }, [])).not.toThrow();
  });
});