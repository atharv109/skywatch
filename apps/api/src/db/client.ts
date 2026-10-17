import { Db, MongoClient } from "mongodb";
import type { Config } from "../config.ts";

export class NoMongoError extends Error {
  constructor() {
    super("MONGODB_URI is not configured");
  }
}

export const COLLECTIONS = {
  users: "users",
  hazards: "hazards",
  resources: "resources",
  roads: "roads",
  conversations: "conversations",
  outbox: "outbox",
  /** Task 6 voice check-in queue records (Delivery consumes them). */
  verifyRequests: "verify_requests",
} as const;

let client: MongoClient | null = null;
let dbPromise: Promise<Db> | null = null;
let ensured = false;

function connectDb(config: Pick<Config, "mongodbUri">): Promise<Db> {
  if (!client) {
    if (!config.mongodbUri) {
      dbPromise = null;
      return Promise.reject(new NoMongoError());
    }
    client = new MongoClient(config.mongodbUri);
    dbPromise = client.connect().then(() => client!.db());
  }
  if (!dbPromise) {
    return Promise.reject(new NoMongoError());
  }
  return dbPromise;
}

/**
 * Cached Mongo connection. Lazy: nothing calls this until a DB-backed route runs,
 * so boot never requires Mongo. Creates the indexes on the first successful
 * connection: awaited by that first call, logged (not thrown) on failure, and
 * retried by the next getDb() until it succeeds.
 */
export async function getDb(config: Pick<Config, "mongodbUri">): Promise<Db> {
  const db = await connectDb(config);
  if (!ensured) {
    ensured = true;
    try {
      await ensureIndexes(db);
    } catch (err) {
      ensured = false;
      console.error("ensureIndexes failed:", err);
    }
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    dbPromise = null;
    ensured = false;
  }
}

export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection(COLLECTIONS.users).createIndexes([
    { key: { loc: "2dsphere" }, name: "loc_2dsphere" },
    { key: { phone: 1 }, name: "phone_1", unique: true },
  ]);
  await db.collection(COLLECTIONS.hazards).createIndexes([
    { key: { geometry: "2dsphere" }, name: "geometry_2dsphere" },
    // sourceId is the deterministic upsert key (idempotent replay). UNIQUE is the
    // race guard: two concurrent upsert streams (seed-on-boot + a first replay, or
    // two replays) with no unique index can both insert the same key on a slow
    // round-trip; with it the upserts converge to one document.
    { key: { sourceId: 1 }, name: "sourceId_1", unique: true },
  ]);
  await db.collection(COLLECTIONS.resources).createIndexes([
    { key: { loc: "2dsphere" }, name: "loc_2dsphere" },
    { key: { sourceId: 1 }, name: "sourceId_1", unique: true },
  ]);
  await db.collection(COLLECTIONS.roads).createIndexes([
    { key: { loc: "2dsphere" }, name: "loc_2dsphere" },
    { key: { cameraId: 1 }, name: "cameraId_1", unique: true },
  ]);
  await db.collection(COLLECTIONS.conversations).createIndexes([
    { key: { userId: 1 }, name: "userId_1" },
  ]);
  await db.collection(COLLECTIONS.outbox).createIndexes([
    { key: { sentAt: 1 }, name: "sentAt_1" },
  ]);
  // Task 6: requestId is the deterministic upsert key (vr:<resourceId>:<hazard>),
  // so a re-run of /verify/run never duplicates a pending request.
  await db.collection(COLLECTIONS.verifyRequests).createIndexes([
    { key: { requestId: 1 }, name: "requestId_1", unique: true },
  ]);
}