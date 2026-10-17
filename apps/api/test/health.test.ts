import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/server.ts";

const app = createApp(loadConfig({}));

describe("GET /health", () => {
  it("returns ok without touching Mongo", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});