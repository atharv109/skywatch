/**
 * Web client regression pins for the silent-fail fixes (hermetic, filesystem only —
 * same pattern as sw-precache.test.ts). app.js is a classic-script IIFE, so the tests
 * pin the load-bearing code paths by source: if any of them silently revert, these
 * red.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..");
const appSrc = readFileSync(join(WEB, "app.js"), "utf8");

/** Source of one function body, cut between two stable markers. */
function section(from: string, to: string): string {
  const a = appSrc.indexOf(from);
  if (a < 0) throw new Error(`marker not found: ${from}`);
  const b = appSrc.indexOf(to, a);
  if (b < 0) throw new Error(`end marker not found after ${from}: ${to}`);
  return appSrc.slice(a, b);
}

describe("mesh photo upload — no silent data loss", () => {
  const flush = section("async function flushPhotoUploads()", "hazard detail sheet");

  it("the upload body strips the dataURL prefix (gateway rejects prefixed base64)", () => {
    // Regression: POST /mesh/photo validates /^[A-Za-z0-9+/]+={0,2}$/ — a
    // "data:image/jpeg;base64," prefix would 400 every time.
    expect(flush).toContain("data: b64Only(ph.data)");
  });

  it("a permanent server refusal (400/403) drops the pending photo, strips queued photoRefs, and tells the user", () => {
    const guardIdx = flush.indexOf("r.status === 400 || r.status === 403");
    expect(guardIdx).toBeGreaterThan(-1);
    const branch = flush.slice(guardIdx);
    expect(branch).toContain("delete pending[ref]"); // stop the forever-retry loop
    expect(branch).toContain("delete p.photoRef"); // packets stop advertising bytes that will never exist
    expect(branch).toContain('toast('); // visible to the user — this was the silent fail
    // and the transient path still keeps the entry pending
    expect(/else \{\s*return;/.test(branch) || /else \{\s*\/\//.test(branch)).toBe(true);
  });

  it("over-cap (413) keeps its existing drop-with-notice behavior", () => {
    expect(flush).toContain("r.status === 413");
  });
});

describe("home brief summary card — the #homeHaz timing line is populated", () => {
  it("renderBriefParts writes the worst hazard's timing into #homeHaz", () => {
    const parts = section("function renderBriefParts(", "// actions");
    expect(parts).toContain('$("#homeHaz", el)');
    expect(parts).toContain("homeHaz.textContent");
  });
});

describe("connection modal — save validates the API base through the #cfgErr line", () => {
  it("a garbage API base shows an error and aborts save instead of stranding the demo", () => {
    const modal = section("function openConfigModal(", "function maybeFirstRun(");
    expect(modal).toContain("cfgErr");
    expect(modal).toContain(".test(api)");
    expect(modal).toContain("errEl.textContent =");
  });
});
