import { ObjectId } from "mongodb";
import { getDb, closeDb, COLLECTIONS } from "../../apps/api/src/db/client.ts";
import { mongoStore } from "../../apps/api/src/store.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { createApp } from "../../apps/api/src/server.ts";
import { mongoDeliverStore } from "../../apps/api/src/deliver/store.ts";
import { mongoMatchStore } from "../../apps/api/src/match/store.ts";
import { mongoVerifyStore as mv } from "../../apps/api/src/verify/store.ts";
import { createVoiceRuntime } from "../../apps/api/src/deliver/voice_runtime.ts";
import { emptyPipelineResult } from "../../apps/api/src/pipeline/run.ts";

const db = await getDb(loadConfig({
  MONGODB_URI: "mongodb://abm7096_db_user:vy6ZJVeAIurxZLmU@ac-75ychkz-shard-00-00.snhsbxv.mongodb.net:27017,ac-75ychkz-shard-00-01.snhsbxv.mongodb.net:27017,ac-75ychkz-shard-00-02.snhsbxv.mongodb.net:27017/skywatch-debug-2?ssl=true&authSource=admin&retryWrites=true&w=majority&replicaSet=atlas-5x8vzl-shard-0",
  REPLAY: "1",
  TOOL_SECRET: "tool-secret",
  ELEVENLABS_AGENT_ID_CHECKIN: "agent-checkin-1",
  ELEVENLABS_VOICE_WEBHOOK_SECRET: "voice-test",
}));
const verifyStore = mv(db);
const doc = {
  sourceId: "dbg-task6-1", kind: "shelter" as const, name: "Debug Shelter", hours: "24/7",
  partner: true, status: "unknown" as const, verifiedAt: null,
  loc: { type: "Point" as const, coordinates: [-122.1, 47.5] },
};
await Promise.all([
  db.collection(COLLECTIONS.resources).deleteMany({ sourceId: doc.sourceId }),
  db.collection(COLLECTIONS.roads).deleteMany({ cameraId: "wsdot-mongo-1" }),
  db.collection(COLLECTIONS.verifyRequests).deleteMany({}),
  db.collection(COLLECTIONS.hazards).deleteMany({ sourceId: "hms-smoke:demo" }),
]);
await db.collection(COLLECTIONS.resources).insertOne({ ...doc, _id: new ObjectId() } as any);
const hazard = {
  sourceId: "hms-smoke:demo", type: "smoke", severity: 3, title: "Smoke plume demo",
  geometry: { type: "Polygon", coordinates: [[[-123.0, 47.0], [-121.0, 47.0], [-121.0, 48.0], [-123.0, 48.0], [-123.0, 47.0]]] },
  validFrom: Date.now() - 3_600_000, validTo: Date.now() + 6 * 3_600_000, source: "test",
};
await db.collection(COLLECTIONS.hazards).replaceOne({ sourceId: hazard.sourceId }, hazard, { upsert: true });

const voiceRuntime = createVoiceRuntime(loadConfig({ ELEVENLABS_VOICE_WEBHOOK_SECRET: "voice-test", ELEVENLABS_AGENT_ID_CHECKIN: "agent-checkin-1" }), {
  deliver: async () => mongoDeliverStore(db),
  verify: async () => verifyStore,
});
const app = createApp(loadConfig({
  REPLAY: "1", TOOL_SECRET: "tool-secret", ELEVENLABS_AGENT_ID_CHECKIN: "agent-checkin-1", ELEVENLABS_VOICE_WEBHOOK_SECRET: "voice-test",
}), {
  store: async () => mongoStore(db),
  pipeline: async () => emptyPipelineResult(),
  match: async () => mongoMatchStore(db),
  deliver: async () => mongoDeliverStore(db),
  verify: async () => verifyStore,
  voice: voiceRuntime,
});
const headers = { "content-type": "application/json", Authorization: "Bearer tool-secret" };
const checkin = await app.request("/tools/checkin", { method: "POST", body: JSON.stringify({ resourceId: "dbg-task6-1", status: "open", capacity: 9, manual: true }), headers });
console.log("checkin:", checkin.status);

const run = await app.request("/verify/run", { method: "POST", body: "{}", headers });
const runBody = await run.json();
console.log("verify/run:", run.status, "created:", JSON.stringify(runBody.created?.map((r: any) => ({ id: r.requestId, agent: r.agentId, dev: r.deviceId }))));

const poll = await app.request("/tools/checkin/next?deviceId=dev-1", { headers: { Authorization: "Bearer tool-secret" } });
const pollBody = await poll.json();
console.log("poll:", poll.status, "requests:", JSON.stringify(pollBody.requests?.map((r: any) => ({ id: r.requestId, agent: r.agentId, status: r.status }))));

const { createHmac } = await import("node:crypto");
const raw = JSON.stringify({ type: "call_initiation_failure", data: { agent_id: "agent-checkin-1", conversation_id: "conv-fail-1", failure_reason: "busy" } });
const ts = Math.floor(Date.now() / 1000);
const failure = await app.request("/webhooks/voice/post-call", { method: "POST", body: raw, headers: { "elevenlabs-signature": `t=${ts},v1=` + createHmac("sha256", "voice-test").update(`${ts}.${raw}`).digest("hex") } });
console.log("webhook:", failure.status);
await voiceRuntime.drain();
const released = await db.collection(COLLECTIONS.verifyRequests).find().toArray();
console.log("FINAL verify_requests:", JSON.stringify(released.map((r) => ({ id: r.requestId, status: r.status, outcome: r.outcome, agent: r.agentId }))));
await closeDb();
process.exit(0);