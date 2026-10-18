"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { Fix } from "@/lib/location";
import { SEATTLE_HOME } from "@/lib/seattle";

export const REPORT_KINDS = ["ROAD BROKEN", "FIRE", "SAFE PLACE", "FLOOD", "OTHER"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** The only photo labels the backend photo store accepts (MESH_PHOTO_LABELS). */
const PHOTO_LABELS: Record<ReportKind, string> = {
  "ROAD BROKEN": "road-broken",
  FIRE: "fire",
  "SAFE PLACE": "safe-place",
  FLOOD: "flood",
  OTHER: "other",
};

export type MeshMessage = {
  id: string;
  type: "msg" | "report";
  from: string;
  to: string | null;
  text: string;
  ts: number;
  hops: number;
  lat?: number;
  lon?: number;
  accuracy?: number;
  kind?: ReportKind;
  photoRef?: string;
  label?: string;
  shield: boolean;
  local: boolean;
  accepted: boolean;
};

export type Plume = { id: string; polygon: [number, number][] };
export type SatAlert = {
  id: string;
  lat: number;
  lon: number;
  severity: "danger" | "warning" | "safe";
  title: string;
};

export type SatelliteOverlay = {
  plumes: Plume[];
  alerts: SatAlert[];
  aqi: number | null;
  fetchedAt: number;
  live: boolean;
};

type PhotoRecord = { data: string; label: string; uploaded: boolean };

export type GatewayBrief = {
  text: string;
  shelterName: string | null;
  shelterKm: number | null;
  shelterOpen: boolean;
  roads: { name: string; status: string }[];
};

type MeshState = {
  deviceId: string;
  hash: string;
  legacy: boolean;
  messages: MeshMessage[];
  photos: Record<string, PhotoRecord>;
  pending: string[];
  satellite: SatelliteOverlay | null;
  brief: GatewayBrief | null;
  syncing: boolean;
  syncedAt: number | null;
  gateway: "idle" | "ok" | "down";
};

const MSG_KEY = "skywatch-mesh-messages";
const PHOTO_KEY = "skywatch-photos";
const PENDING_KEY = "skywatch-pending-upload";
const SAT_KEY = "skywatch-satellite";
/** Per-session identity cache — the device identity NEVER touches localStorage. */
const IDENTITY_KEY = "skywatch-mesh-identity";

type MeshIdentity = {
  deviceId: string;
  hash: string;
  legacy: boolean;
  priv: CryptoKey | null;
  pubB64: string | null;
};

const listeners = new Set<() => void>();
let state: MeshState | null = null;
let booted = false;
let identity: MeshIdentity | null = null;
/** hashPrefix(SKYWATCH-CORE) — the trusted core never signs, so its hash is the only mark. */
let coreHash = "";

async function rememberCoreHash() {
  if (coreHash) return;
  coreHash = await sha10("SKYWATCH-CORE");
}

function emit() {
  listeners.forEach((listener) => listener());
}

const BLANK: MeshState = {
  deviceId: "",
  hash: "",
  legacy: false,
  messages: [],
  photos: {},
  pending: [],
  satellite: null,
  brief: null,
  syncing: false,
  syncedAt: null,
  gateway: "idle",
};

function empty(): MeshState {
  return BLANK;
}

async function sha10(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as never);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 10);
}

function toB64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function readSessionJson<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeSessionJson(key: string, value: unknown) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* The identity then regenerates on the next load — still per-session. */
  }
}

function persist() {
  if (!state) return;
  window.localStorage.setItem(MSG_KEY, JSON.stringify(state.messages));
  window.localStorage.setItem(PHOTO_KEY, JSON.stringify(state.photos));
  window.localStorage.setItem(PENDING_KEY, JSON.stringify(state.pending));
  if (state.satellite?.live) window.localStorage.setItem(SAT_KEY, JSON.stringify(state.satellite));
}

export function isShield(from: string) {
  return from.toUpperCase().includes("SKYWATCH-CORE") || (!!coreHash && from === coreHash);
}

function kindFromPhoto(value: unknown): ReportKind | undefined {
  if (typeof value !== "string") return;
  const key = value.trim().toUpperCase();
  if (key === "ROAD BROKEN" || key === "ROAD-BROKEN") return "ROAD BROKEN";
  if (key === "FIRE") return "FIRE";
  if (key === "FLOOD" || key === "FLOODED ROAD") return "FLOOD";
  if (key === "SAFE PLACE" || key === "SAFE-PLACE") return "SAFE PLACE";
  if (key === "OTHER") return "OTHER";
  return;
}

function asMessage(value: unknown, local: boolean): MeshMessage | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<MeshMessage> & { photoKind?: string };
  if (typeof item.id !== "string" || typeof item.text !== "string") return null;
  const from = typeof item.from === "string" ? item.from : "neighbor";
  const kind = REPORT_KINDS.find((entry) => entry === item.kind) || kindFromPhoto(item.kind || item.photoKind || item.label);
  return {
    id: item.id,
    type: item.type === "report" || kind ? "report" : "msg",
    from,
    to: typeof item.to === "string" ? item.to : null,
    text: item.text.slice(0, 280),
    ts: typeof item.ts === "number" ? item.ts : Date.now(),
    hops: typeof item.hops === "number" ? item.hops : 0,
    lat: typeof item.lat === "number" ? item.lat : undefined,
    lon: typeof item.lon === "number" ? item.lon : undefined,
    accuracy: typeof item.accuracy === "number" ? item.accuracy : undefined,
    kind,
    photoRef: typeof item.photoRef === "string" ? item.photoRef : undefined,
    label: typeof item.label === "string" ? item.label : kind,
    shield: isShield(from),
    local,
    accepted: !local,
  };
}

/**
 * The session-scoped device identity (TOFU): an Ed25519 WebCrypto keypair
 * generated at boot when the context supports it; deviceId = the first 10 hex
 * of sha256(raw pubkey), exactly what the backend derives for coverage dots and
 * DM routing. Without WebCrypto Ed25519 the packet path goes legacy:true and
 * the deviceId is a random seed's hash. Session storage only — a fresh session
 * is a fresh device; localStorage is never written.
 */
async function ensureIdentity(): Promise<MeshIdentity> {
  if (identity) return identity;
  void rememberCoreHash();
  const cached = readSessionJson<{
    deviceId: string;
    hash: string;
    legacy: boolean;
    pubB64?: string;
    privJwk?: JsonWebKey;
    seed?: string;
  }>(IDENTITY_KEY);
  if (cached?.legacy && cached.deviceId) {
    identity = { deviceId: cached.deviceId, hash: cached.hash || (await sha10(cached.deviceId)), legacy: true, priv: null, pubB64: null };
    return identity;
  }
  if (cached?.privJwk && cached.deviceId && cached.pubB64) {
    try {
      const priv = await crypto.subtle.importKey("jwk", cached.privJwk, { name: "Ed25519" }, true, ["sign"]);
      identity = { deviceId: cached.deviceId, hash: cached.hash || (await sha10(cached.deviceId)), legacy: false, priv, pubB64: cached.pubB64 };
      return identity;
    } catch {
      /* Fall through and regenerate. */
    }
  }
  let next: MeshIdentity;
  try {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const deviceId = await sha10(rawPub);
    const privJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    next = {
      deviceId,
      hash: "",
      legacy: false,
      priv: pair.privateKey,
      pubB64: toB64(rawPub),
    };
    next.hash = await sha10(deviceId);
    writeSessionJson(IDENTITY_KEY, { deviceId, hash: next.hash, legacy: false, pubB64: next.pubB64, privJwk });
  } catch {
    const seed = crypto.getRandomValues(new Uint8Array(16));
    const deviceId = await sha10(seed);
    next = { deviceId, hash: await sha10(deviceId), legacy: true, priv: null, pubB64: null };
    writeSessionJson(IDENTITY_KEY, { deviceId, hash: next.hash, legacy: true, seed: toB64(seed) });
  }
  identity = next;
  return next;
}

function ensure(): MeshState {
  if (state) return state;
  state = {
    ...empty(),
    messages: readJson<MeshMessage[]>(MSG_KEY, []),
    photos: readJson<Record<string, PhotoRecord>>(PHOTO_KEY, {}),
    pending: readJson<string[]>(PENDING_KEY, []),
    satellite: (() => {
      const stored = readJson<SatelliteOverlay | null>(SAT_KEY, null);
      if (stored?.live) return stored;
      window.localStorage.removeItem(SAT_KEY);
      return null;
    })(),
  };
  return state;
}

export function subscribeMesh(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readMesh() {
  return state ?? BLANK;
}

export function useMesh() {
  const value = useSyncExternalStore(subscribeMesh, readMesh, empty);
  useEffect(() => {
    if (booted) return;
    booted = true;
    emit();
    void (async () => {
      const id = await ensureIdentity();
      if (!state) return;
      state = { ...ensure(), deviceId: id.deviceId, hash: id.hash, legacy: id.legacy };
      emit();
    })();
  }, []);
  return value;
}

export function myHash() {
  return ensure().hash;
}

/** Neighbors queued locally but not yet accepted by the gateway (the drain signal). */
export function pendingQueueCount() {
  return ensure().messages.filter((message) => message.local && !message.accepted).length;
}

function upsert(message: MeshMessage) {
  const current = ensure();
  const index = current.messages.findIndex((item) => item.id === message.id);
  const messages = current.messages.slice();
  if (index >= 0) messages[index] = { ...messages[index], ...message, local: messages[index].local && message.local };
  else messages.push(message);
  messages.sort((a, b) => a.ts - b.ts);
  state = { ...current, messages };
  persist();
  emit();
}

export async function sendMesh(input: {
  text: string;
  to?: string | null;
  kind?: ReportKind;
  photo?: { data: string; label: string };
  fix: Fix | null;
}) {
  const current = ensure();
  const id = await ensureIdentity();
  const hash = id.hash || (await sha10(id.deviceId));
  const photoRef = input.photo ? crypto.randomUUID() : undefined;
  const message: MeshMessage = {
    id: `mp-${crypto.randomUUID().slice(0, 12)}`,
    type: input.photo || input.kind ? "report" : "msg",
    from: hash,
    to: input.to ?? null,
    text: input.text.trim().slice(0, 280),
    ts: Date.now(),
    hops: 0,
    lat: input.fix?.lat,
    lon: input.fix?.lon,
    accuracy: input.fix?.accuracy,
    kind: input.kind,
    photoRef,
    label: input.photo?.label || input.kind,
    shield: false,
    local: true,
    accepted: false,
  };
  if (photoRef && input.photo) {
    const photos = { ...current.photos, [photoRef]: { data: input.photo.data, label: input.photo.label, uploaded: false } };
    const pending = current.pending.concat(photoRef);
    state = { ...ensure(), hash, photos, pending };
  } else {
    state = { ...ensure(), hash };
  }
  upsert(message);
  return message;
}

function readSatellite(value: unknown, live: boolean): SatelliteOverlay | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SatelliteOverlay>;
  const plumes = Array.isArray(raw.plumes)
    ? raw.plumes.flatMap((plume) => {
        if (!plume || typeof plume !== "object") return [];
        const polygon = (plume as Plume).polygon;
        if (!Array.isArray(polygon) || polygon.length < 3) return [];
        return [{ id: String((plume as Plume).id || crypto.randomUUID()), polygon }];
      })
    : [];
  const alerts = Array.isArray(raw.alerts)
    ? raw.alerts.flatMap((alert) => {
        if (!alert || typeof alert !== "object") return [];
        const item = alert as SatAlert;
        if (typeof item.lat !== "number" || typeof item.lon !== "number") return [];
        const severity: SatAlert["severity"] =
          item.severity === "danger" || item.severity === "safe" || item.severity === "warning" ? item.severity : "warning";
        return [{ id: String(item.id || crypto.randomUUID()), lat: item.lat, lon: item.lon, severity, title: String(item.title || "Satellite alert") }];
      })
    : [];
  if (!plumes.length && !alerts.length && typeof raw.aqi !== "number") return null;
  return {
    plumes,
    alerts,
    aqi: typeof raw.aqi === "number" ? raw.aqi : null,
    fetchedAt: typeof raw.fetchedAt === "number" ? raw.fetchedAt : Date.now(),
    live,
  };
}

export function rememberSatellite(overlay: SatelliteOverlay) {
  state = { ...ensure(), satellite: overlay };
  persist();
  emit();
}

function round5(value: number | undefined, fallback: number) {
  return Number((Number.isFinite(value) ? (value as number) : fallback).toFixed(5));
}

/** One transport packet exactly as src/mesh/sync.ts parsePacket accepts, signed per src/mesh/sig.ts. */
async function packetFor(message: MeshMessage, id: MeshIdentity): Promise<Record<string, unknown>> {
  const lat = round5(message.lat, SEATTLE_HOME[0]);
  const lon = round5(message.lon, SEATTLE_HOME[1]);
  const type = message.type === "report" ? "hazard" : "msg";
  const status = message.text || message.kind || "report";
  const packet: Record<string, unknown> = {
    id: message.id,
    type,
    status,
    lat,
    lon,
    ts: message.ts,
    hops: 0,
    ttl: 7,
    deviceId: id.deviceId,
    to: type === "msg" ? message.to ?? null : null,
    ...(message.photoRef ? { photoRef: message.photoRef } : {}),
  };
  if (!id.legacy && id.priv && id.pubB64) {
    packet.pubkey = id.pubB64;
    // The signed string is String() of the PARSED values joined by "|" — sign before
    // anything mutates the packet (the `to` field is already carried verbatim).
    const msg = [message.id, type, message.ts, lat, lon, id.deviceId].map(String).join("|");
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, id.priv, new TextEncoder().encode(msg));
    packet.sig = toB64(new Uint8Array(sig));
  } else {
    packet.legacy = true;
  }
  return packet;
}

export async function syncMesh(
  fix: Fix | null,
): Promise<{ ok: boolean; lang: string | null } | null> {
  const id = await ensureIdentity();
  const current = ensure();
  if (current.syncing) return null;
  const hash = id.hash || (await sha10(id.deviceId));
  state = { ...ensure(), hash, syncing: true };
  emit();
  // Only messages the gateway has not accepted yet — server dedup makes a retry safe.
  const outgoing = ensure().messages.filter((message) => message.local && !message.accepted);
  try {
    const packets = await Promise.all(outgoing.map((message) => packetFor(message, id)));
    const response = await fetch("/api/mesh/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: id.deviceId,
        lat: fix?.lat ?? SEATTLE_HOME[0],
        lon: fix?.lon ?? SEATTLE_HOME[1],
        accuracy: fix?.accuracy,
        packets,
      }),
    });
    const data = (await response.json()) as {
      rejectedIds?: string[];
      bundle?: {
        messages?: unknown[];
        lang?: string;
        byPhone?: { lang?: string };
        brief?: { lang?: string; text?: string };
        nearestVerifiedShelter?: { name?: string; distanceKm?: number; status?: string };
        blockedRoads?: unknown[];
      };
      satellite?: unknown;
      lang?: string;
    };
    if (!response.ok) throw new Error("sync");
    const rejectedSet = new Set(data.rejectedIds || []);
    const messages = ensure().messages.map((message) => {
      if (!message.local) return message;
      if (rejectedSet.has(message.id)) return { ...message, accepted: false };
      // Delivered (or deduped) packets stay delivered, never re-sent.
      return outgoing.some((sent) => sent.id === message.id) ? { ...message, accepted: true } : message;
    });
    (data.bundle?.messages || []).forEach((item) => {
      const message = asMessage(item, false);
      if (!message) return;
      const index = messages.findIndex((entry) => entry.id === message.id);
      if (index >= 0) messages[index] = { ...messages[index], ...message, local: false, accepted: true };
      else messages.push(message);
    });
    messages.sort((a, b) => a.ts - b.ts);
    const satellite = readSatellite(data.satellite, true);
    const lang = data.lang || data.bundle?.lang || data.bundle?.byPhone?.lang || data.bundle?.brief?.lang || null;
    const shelter = data.bundle?.nearestVerifiedShelter;
    const brief: GatewayBrief | null = data.bundle
      ? {
          text: data.bundle.brief?.text || "",
          shelterName: shelter?.name || null,
          shelterKm: typeof shelter?.distanceKm === "number" ? shelter.distanceKm : null,
          shelterOpen: shelter?.status === "open",
          roads: Array.isArray(data.bundle.blockedRoads)
            ? data.bundle.blockedRoads.flatMap((road) => {
                if (!road || typeof road !== "object") return [];
                const item = road as { name?: string; status?: string };
                return typeof item.name === "string" ? [{ name: item.name, status: item.status || "closed" }] : [];
              }).slice(0, 2)
            : [],
        }
      : ensure().brief;
    state = {
      ...ensure(),
      messages,
      satellite: satellite || ensure().satellite,
      brief,
      syncing: false,
      syncedAt: Date.now(),
      gateway: "ok",
    };
    persist();
    emit();
    await flushPhotos();
    return { ok: true, lang: typeof lang === "string" ? lang : null };
  } catch {
    state = { ...ensure(), syncing: false, gateway: "down" };
    emit();
    return { ok: false, lang: null };
  }
}

async function flushPhotos() {
  const current = ensure();
  for (const photoRef of current.pending) {
    const photo = current.photos[photoRef];
    if (!photo || photo.uploaded) continue;
    const kind = kindFromPhoto(photo.label);
    try {
      const response = await fetch("/api/mesh/photo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: ensure().deviceId,
          photoRef,
          data: photo.data,
          label: kind ? PHOTO_LABELS[kind] : "other",
        }),
      });
      if (!response.ok) continue;
      const photos = { ...ensure().photos, [photoRef]: { ...photo, uploaded: true } };
      const pending = ensure().pending.filter((item) => item !== photoRef);
      state = { ...ensure(), photos, pending };
      persist();
      emit();
    } catch {
      /* Keep the bytes queued until a gateway accepts them. */
    }
  }
}

export function sampleSatellite(center: [number, number]): SatelliteOverlay {
  const [lat, lon] = center;
  return {
    plumes: [
      {
        id: "sample-plume",
        polygon: [
          [lat + 0.04, lon - 0.05],
          [lat + 0.05, lon + 0.04],
          [lat - 0.02, lon + 0.06],
          [lat - 0.05, lon - 0.02],
        ],
      },
    ],
    alerts: [{ id: "sample-alert", lat: lat + 0.01, lon: lon + 0.01, severity: "warning", title: "Smoke" }],
    aqi: 164,
    fetchedAt: Date.now(),
    live: false,
  };
}