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
} as const;

let client: MongoClient | null = null;
let dbPromise: Promise<Db> | null = null;

/** Cached Mongo connection. Lazy: nothing calls this until a DB-backed route runs. */
export function getDb(config: Pick<Config, "mongodbUri">): Promise<Db> {
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

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    dbPromise = null;
  }
}

export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection(COLLECTIONS.users).createIndexes([
    { key: { loc: "2dsphere" }, name: "loc_2dsphere" },
    { key: { phone: 1 }, name: "phone_1", unique: true },
  ]);
  await db.collection(COLLECTIONS.hazards).createIndexes([
    { key: { geometry: "2dsphere" }, name: "geometry_2dsphere" },
  ]);
  await db.collection(COLLECTIONS.resources).createIndexes([
    { key: { loc: "2dsphere" }, name: "loc_2dsphere" },
  ]);
  await db.collection(COLLECTIONS.roads).createIndexes([
    { key: { loc: "2dsphere" }, name: "loc_2dsphere" },
  ]);
  await db.collection(COLLECTIONS.conversations).createIndexes([
    { key: { userId: 1 }, name: "userId_1" },
  ]);
  await db.collection(COLLECTIONS.outbox).createIndexes([
    { key: { sentAt: 1 }, name: "sentAt_1" },
  ]);
}