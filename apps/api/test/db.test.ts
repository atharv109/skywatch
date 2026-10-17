import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { COLLECTIONS, NoMongoError, closeDb, getDb } from "../src/db/client.ts";

function indexInfo(indexes: { key: Record<string, string | number>; unique?: boolean }[]) {
  return indexes.map((i) => ({ key: i.key, unique: i.unique === true }));
}

describe("db client", () => {
  it("rejects with NoMongoError when MONGODB_URI is unset", async () => {
    await expect(getDb(loadConfig({}))).rejects.toBeInstanceOf(NoMongoError);
  });
});

// DB-touching smoke: runs only against a real Mongo when MONGODB_URI is set.
describe.skipIf(!process.env.MONGODB_URI)("getDb wiring + ensureIndexes", () => {
  // getDb itself is under test here: it must create the boot indexes on first
  // connection, without any explicit ensureIndexes call from callers.
  it("creates the geospatial/unique indices on first getDb()", async () => {
    const db = await getDb(loadConfig());

    const users = indexInfo(await db.collection(COLLECTIONS.users).indexes());
    expect(users).toContainEqual({ key: { loc: "2dsphere" }, unique: false });
    expect(users).toContainEqual({ key: { phone: 1 }, unique: true });

    const hazards = indexInfo(await db.collection(COLLECTIONS.hazards).indexes());
    expect(hazards).toContainEqual({ key: { geometry: "2dsphere" }, unique: false });

    const resources = indexInfo(await db.collection(COLLECTIONS.resources).indexes());
    expect(resources).toContainEqual({ key: { loc: "2dsphere" }, unique: false });

    const roads = indexInfo(await db.collection(COLLECTIONS.roads).indexes());
    expect(roads).toContainEqual({ key: { loc: "2dsphere" }, unique: false });

    const conversations = indexInfo(await db.collection(COLLECTIONS.conversations).indexes());
    expect(conversations).toContainEqual({ key: { userId: 1 }, unique: false });

    const outbox = indexInfo(await db.collection(COLLECTIONS.outbox).indexes());
    expect(outbox).toContainEqual({ key: { sentAt: 1 }, unique: false });
  });

  afterAll(async () => {
    await closeDb();
  });
});